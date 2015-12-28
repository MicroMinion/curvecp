'use strict'
var Duplex = require('stream').Duplex
var inherits = require('inherits')
var extend = require('extend.js')
var debug = require('debug')('curvecp:PacketStream')
var Uint64BE = require('int64-buffer').Uint64BE

var nacl = require('tweetnacl')

var crypto = require('crypto')

var HELLO_MSG = nacl.util.decodeUTF8('QvnQ5XlH')
var COOKIE_MSG = nacl.util.decodeUTF8('RL3aNMXK')
var INITIATE_MSG = nacl.util.decodeUTF8('QvnQ5XlI')
var SERVER_MSG = nacl.util.decodeUTF8('RL3aNMXM')
var CLIENT_MSG = nacl.util.decodeUTF8('QvnQ5XlM')

nacl.setPRNG(function (x, n) {
  var i
  var v = crypto.randomBytes(n)
  for (i = 0; i < n; i++) x[i] = v[i]
  for (i = 0; i < v.length; i++) v[i] = 0
})

var PacketStream = function (opts) {
  debug('initialize')
  if (!opts) opts = {}
  opts.objectMode = false
  opts.decodeStrings = true
  this.ourNonceCounter = 0
  this.remoteNonceCounter = 0
  Duplex.call(this, opts)
  extend(this, {
    canSend: false,
    initiateSend: false,
    stream: null,
    is_server: false,
    serverName: new Uint8Array(256),
    clientExtension: new Uint8Array(16),
    serverExtension: new Uint8Array(16),
    serverPublicKey: null,
    serverPrivateKey: null,
    serverConnectionPublicKey: null,
    serverConnectionPrivateKey: null,
    clientPublicKey: null,
    clientPrivateKey: null,
    clientConnectionPublicKey: null,
    clientConnectionPrivateKey: null,
    serverCookie: null
  }, opts)
  if (this.serverName.length !== 256) {
    var buffer = new Buffer(256)
    buffer.fill(0)
    buffer.write(this.serverName)
    this.serverName = buffer
  // this.serverName = new Uint8Array(buffer)
  }
  this._connectStream(this.stream)
}

inherits(PacketStream, Duplex)

PacketStream.prototype._connectStream = function (stream) {
  var curveStream = this
  var functions = {
    data: function (data) {
      if (data.length < 30) {
        return
      }
      curveStream._onMessage(new Uint8Array(data))
    },
    error: function (err) {
      curveStream.emit('error', err)
    },
    connect: function () {},
    close: function () {
      stream.removeListener('data', functions.data)
      stream.removeListener('error', functions.error)
      stream.removeListener('close', functions.close)
      curveStream.emit('close')
    }
  }
  stream.on('data', functions.data)
  stream.on('error', functions.error)
  stream.on('close', functions.close)
}

PacketStream.prototype._onMessage = function (message) {
  debug('_onMessage')
  if (this.is_server) {
    this._onMessageServer(message)
  } else {
    this._onMessageClient(message)
  }
}

PacketStream.prototype._onMessageClient = function (message) {
  debug('_onMessage@Client')
  if (message.length < 64 || message.length > 1152) {
    return
  }
  if (!this.isEqual(this.clientExtension, message.subarray(8, 24))) {
    debug('invalid clientExtension')
    return
  }
  if (!this.isEqual(this.serverExtension, message.subarray(24, 40))) {
    debug('invalid serverExtension')
    return
  }
  var messageType = message.subarray(0, 8)
  if (this.isEqual(messageType, COOKIE_MSG)) {
    this.onCookie(message)
  } else if (this.isEqual(messageType, SERVER_MSG)) {
    this.onServerMessage(message)
  }
}

PacketStream.prototype._onMessageServer = function (message) {
  debug('_onMessage@Server')
  if (message.length < 96 || message.length > 1184) {
    return
  }
  if (!this.isEqual(this.clientExtension, message.subarray(24, 40))) {
    debug('invalid clientExtension')
    return
  }
  if (!this.isEqual(this.serverExtension, message.subarray(8, 24))) {
    debug('invalid serverExtension')
    return
  }
  var messageType = message.subarray(0, 8)
  debug(messageType.toString())
  if (this.isEqual(messageType, HELLO_MSG)) {
    this.onHello(message)
  } else if (this.isEqual(messageType, INITIATE_MSG)) {
    this.onInitiate(message)
  } else if (this.isEqual(messageType, CLIENT_MSG)) {
    this.onClientMessage(message)
  }
}

PacketStream.prototype.connect = function () {
  debug('connect')
  if (!this.is_server) {
    this.sendHello()
  }
}

PacketStream.prototype.destroy = function () {
  this.stream.destroy()
}

PacketStream.prototype._read = function (size) {
  debug('_read')
}

PacketStream.prototype._write = function (chunk, encoding, done) {
  debug('_write')
  if (this.canSend) {
    if (this.is_server) {
      this.sendServerMessage(chunk, done)
    } else {
      if (this.initiateSend) {
        this.sendClientMessage(chunk, done)
      } else {
        this.sendInitiate(chunk, done)
      }
    }
  } else {
    done(new Error('Stream not ready for writing'))
  }
}

// utility functions

PacketStream.prototype.isEqual = function (a, b) {
  // debug('isEqual')
  if (a.length !== b.length) {
    return false
  }
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}

PacketStream.prototype.decrypt = function (source, prefix, from, to) {
  // debug('decrypt')
  try {
    prefix = nacl.util.decodeUTF8(prefix)
    var nonce_length = 24 - prefix.length
    var short_nonce = source.subarray(0, nonce_length)
    var nonce = new Uint8Array(24)
    nonce.set(prefix)
    nonce.set(short_nonce, prefix.length)
    var result = nacl.box.open(source.subarray(nonce_length), nonce, from, to)
  } catch (err) {
    this.connectionFail('Decrypt failed with error ' + err)
  }
  return result
}

PacketStream.prototype.encrypt = function (data, nonce, prefixLength, from, to) {
  // debug('encrypt')
  var box = nacl.box(data, nonce, to, from)
  var result = new Uint8Array(24 - prefixLength + box.length)
  var short_nonce = nonce.subarray(prefixLength)
  result.set(short_nonce)
  result.set(box, 24 - prefixLength)
  return result
}

PacketStream.prototype.encrypt_symmetric = function (data, prefix, key) {
  // debug('encrypt_symmetric')
  prefix = nacl.util.decodeUTF8(prefix)
  var nonce_length = 24 - prefix.length
  var random_nonce = new Uint8Array(nacl.randomBytes(nacl.secretbox.nonceLength))
  var short_nonce = random_nonce.subarray(0, nonce_length)
  var nonce = new Uint8Array(24)
  nonce.set(prefix)
  nonce.set(short_nonce, prefix.length)
  var box = nacl.secretbox(data, nonce, key)
  var result = new Uint8Array(nonce_length + box.length)
  result.set(nonce)
  result.set(box, nonce_length)
  return result
}

PacketStream.prototype.setExtensions = function (array) {
  if (this.is_server) {
    array.set(this.clientExtension, 8)
    array.set(this.serverExtension, 24)
  } else {
    array.set(this.serverExtension, 8)
    array.set(this.clientExtension, 24)
  }
  return array
}

PacketStream.prototype.createNonceFromCounter = function (prefix) {
  this.increaseCounter()
  var nonce = new Uint8Array(24)
  nonce.set(nacl.util.decodeUTF8(prefix))
  var counter = new Uint8Array(new Uint64BE(this.ourNonceCounter).toBuffer()).reverse()
  nonce.set(counter, 16)
  return nonce
}

PacketStream.prototype.createRandomNonce = function (prefix) {
  var nonce = new Uint8Array(24)
  nonce.set(nacl.util.decodeUTF8(prefix))
  nonce.set(nacl.randomBytes(16), 8)
  return nonce
}

PacketStream.prototype.increaseCounter = function () {
  this.ourNonceCounter += 1
}

// Hello command

PacketStream.prototype.sendHello = function () {
  debug('sendHello')
  this.canSend = false
  this.initiateSend = false
  var keypair = nacl.box.keyPair()
  this.clientConnectionPublicKey = keypair.publicKey
  this.clientConnectionPrivateKey = keypair.secretKey
  var result = new Uint8Array(224)
  result.set(HELLO_MSG, 0)
  result.set(this.clientConnectionPublicKey, 40)
  var nonce = this.createNonceFromCounter('CurveCP-client-H')
  var box = this.encrypt(new Uint8Array(64), nonce, 16, this.clientConnectionPrivateKey, this.serverPublicKey)
  result.set(box, 136)
  result = this.setExtensions(result)
  this.stream.write(new Buffer(result))
}

PacketStream.prototype.onHello = function (hello_message) {
  debug('onHello')
  this.canSend = false
  if (hello_message.length !== 224) {
    debug('Hello message has incorrect length')
    return
  }
  this.clientConnectionPublicKey = hello_message.subarray(40, 40 + 32)
  var box_data = this.decrypt(hello_message.subarray(40 + 32 + 64, 224), 'CurveCP-client-H', this.clientConnectionPublicKey, this.serverPrivateKey)
  if (box_data === undefined) {
    debug('Hello: not able to decrypt box data')
    return
  }
  if (!this.isEqual(box_data, new Uint8Array(64))) {
    debug('Hello: invalid data in signature box')
    return
  }
  this.sendCookie()
}

// Cookie command

PacketStream.prototype.sendCookie = function () {
  debug('sendCookie')
  this.canSend = false
  var keypair = nacl.box.keyPair()
  this.serverConnectionPublicKey = keypair.publicKey
  this.serverConnectionPrivateKey = keypair.secretKey
  var result = new Uint8Array(200)
  result.set(COOKIE_MSG)
  var box_data = new Uint8Array(128)
  box_data.set(this.serverConnectionPublicKey)
  var cookie_data = new Uint8Array(64)
  cookie_data.set(this.clientConnectionPublicKey)
  cookie_data.set(this.serverConnectionPrivateKey, 32)
  var cookie_key = nacl.randomBytes(nacl.box.publicKeyLength)
  var server_cookie = this.encrypt_symmetric(cookie_data, 'minute-k', cookie_key)
  this.serverCookie = server_cookie
  box_data.set(server_cookie, 32)
  var nonce = this.createRandomNonce('CurveCPK')
  var encrypted_box_data = this.encrypt(box_data, nonce, 8, this.serverPrivateKey, this.clientConnectionPublicKey)
  result.set(encrypted_box_data, 40)
  result = this.setExtensions(result)
  this.stream.write(new Buffer(result))
}

PacketStream.prototype.onCookie = function (cookie_message) {
  debug('onCookie')
  this.canSend = false
  if (cookie_message.length !== 200) {
    debug('Cookie message has incorrect length')
    return
  }
  var box_data = this.decrypt(cookie_message.subarray(40, 200), 'CurveCPK', this.serverPublicKey, this.clientConnectionPrivateKey)
  if (box_data === undefined) {
    debug('Not able to decrypt welcome box data')
    return
  }
  this.serverConnectionPublicKey = box_data.subarray(0, 32)
  this.serverCookie = box_data.subarray(32)
  if (this.serverCookie.length !== 96) {
    debug('Welcome command server cookie invalid')
    return
  }
  this.canSend = true
  this.emit('connect')
}

// Initiate command

PacketStream.prototype.sendInitiate = function (message, done) {
  debug('sendInitiate ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  if (message.length & 15) {
    debug('message is of incorrect length, needs to be multiple of 16')
    return
  }
  var result = new Uint8Array(544 + message.length)
  result.set(INITIATE_MSG)
  result.set(this.clientConnectionPublicKey, 40)
  result.set(this.serverCookie, 72)
  var initiate_box_data = new Uint8Array(352 + message.length)
  initiate_box_data.set(this.clientPublicKey)
  initiate_box_data.set(this.create_vouch(), 32)
  initiate_box_data.set(this.serverName, 96)
  initiate_box_data.set(message, 352)
  var nonce = this.createNonceFromCounter('CurveCP-client-I')
  result.set(this.encrypt(initiate_box_data, nonce, 16, this.clientConnectionPrivateKey, this.serverConnectionPublicKey), 168)
  result = this.setExtensions(result)
  this.stream.write(new Buffer(result), done)
  this.initiateSend = true
  this.canSend = false
}

PacketStream.prototype.create_vouch = function () {
  // debug('create_vouch')
  var nonce = this.createRandomNonce('CurveCPV')
  return this.encrypt(this.clientConnectionPublicKey, nonce, 8, this.clientPrivateKey, this.serverPublicKey)
}

PacketStream.prototype.onInitiate = function (initiate_message) {
  debug('onInitiate')
  this.canSend = false
  if (initiate_message.length < 544) {
    debug('Initiate command has incorrect length')
    return
  }
  if (!this.isEqual(initiate_message.subarray(72, 72 + 96), this.serverCookie)) {
    debug('Initiate command server cookie not recognized')
    return
  }
  var initiate_box_data = this.decrypt(initiate_message.subarray(72 + 96), 'CurveCP-client-I', this.clientConnectionPublicKey, this.serverConnectionPrivateKey)
  if (initiate_box_data === undefined) {
    debug('Not able to decrypt initiate box data')
    return
  }
  this.clientPublicKey = initiate_box_data.subarray(0, 32)
  var vouch = this.decrypt(initiate_box_data.subarray(32, 96), 'CurveCPV', this.clientPublicKey, this.serverPrivateKey)
  if (vouch === undefined) {
    debug('not able to decrypt vouch data')
    return
  }
  if (!this.isEqual(vouch, this.clientConnectionPublicKey)) {
    debug('Initiate command vouch contains different client connection public key than previously received')
    return
  }
  this.emit('connect')
  this.canSend = true
  this.emit('data', new Buffer(initiate_box_data.subarray(32 + 16 + 48 + 256)))
}

// Message command - Server

PacketStream.prototype.sendServerMessage = function (message, done) {
  debug('sendServerMessage')
  var result = new Uint8Array(64 + message.length)
  result.set(SERVER_MSG)
  var nonce = this.createNonceFromCounter('CurveCP-server-M')
  var message_box = this.encrypt(message, nonce, 16, this.serverConnectionPrivateKey, this.clientConnectionPublicKey)
  result.set(message_box, 8 + 16 + 16)
  result = this.setExtensions(result)
  this.stream.write(new Buffer(result), done)
}

PacketStream.prototype.onServerMessage = function (message) {
  debug('onServerMessage@Client')
  if (message.length < 64 || message.length > 1152) {
    debug('Message command has incorrect length')
    return
  }
  var box_data = this.decrypt(message.subarray(40), 'CurveCP-server-M', this.serverConnectionPublicKey, this.clientConnectionPrivateKey)
  if (box_data === undefined || !box_data) {
    debug('not able to decrypt box data')
    return
  }
  this.canSend = true
  var buffer = new Buffer(box_data)
  this.emit('data', buffer)
}

// Message command - Client

PacketStream.prototype.sendClientMessage = function (message, done) {
  debug('sendClientMessage ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  var result = new Uint8Array(96 + message.length)
  result.set(CLIENT_MSG)
  var nonce = this.createNonceFromCounter('CurveCP-client-M')
  var message_box = this.encrypt(message, nonce, 16, this.clientConnectionPrivateKey, this.serverConnectionPublicKey)
  result.set(message_box, 8 + 16 + 16 + 32)
  result = this.setExtensions(result)
  this.stream.write(new Buffer(result), done)
}

PacketStream.prototype.onClientMessage = function (message) {
  debug('onClientMessage@Server ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  if (message.length < 96 || message.length > 1184) {
    debug('Message command has incorrect length')
    return
  }
  var box_data = this.decrypt(message.subarray(40 + 32), 'CurveCP-client-M', this.clientConnectionPublicKey, this.serverConnectionPrivateKey)
  if (box_data === undefined || !box_data) {
    debug('not able to decrypt box data')
    return
  }
  var buffer = new Buffer(box_data)
  this.emit('data', buffer)
}

module.exports = PacketStream
