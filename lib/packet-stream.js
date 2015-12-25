'use strict'
var Duplex = require('stream').Duplex
var inherits = require('inherits')
var extend = require('extend.js')
var debug = require('debug')('curvecp:PacketStream')

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

var CurveCPStream = function (opts) {
  debug('initialize')
  if (!opts) opts = {}
  opts.objectMode = false
  opts.decodeStrings = true
  this.nonceCounter = 0
  Duplex.call(this, opts)
  extend(this, {
    canSend: false,
    initiateSend: false,
    stream: null,
    is_server: false,
    serverName: new Buffer('sting.m15.net'),
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
  this._connectStream(this.stream)
}

inherits(CurveCPStream, Duplex)

CurveCPStream.prototype._connectStream = function (stream) {
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

CurveCPStream.prototype._onMessage = function (message) {
  debug('_onMessage')
  if (this.is_server) {
    this._onMessageServer(message)
  } else {
    this._onMessageClient(message)
  }
}

CurveCPStream.prototype._onMessageClient = function (message) {
  debug('_onMessageClient')
  if (message.length < 64 || message.length > 1152) {
    return
  }
  var messageType = message.subarray(0, 8)
  if (this.isEqual(messageType, COOKIE_MSG)) {
    this.onCookie(message)
  } else if (this.isEqual(messageType, SERVER_MSG)) {
    this.onServerMessage(message)
  }
}

CurveCPStream.prototype._onMessageServer = function (message) {
  debug('_onMessageServer')
  if (message.length < 96 || message.length > 1184) {
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

CurveCPStream.prototype.connect = function () {
  debug('connect')
  if (!this.is_server) {
    this.sendHello()
  }
}

CurveCPStream.prototype.destroy = function () {
  this.stream.destroy()
}

CurveCPStream.prototype._read = function (size) {
  debug('_read')
}

CurveCPStream.prototype._write = function (chunk, encoding, done) {
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

CurveCPStream.prototype.isEqual = function (a, b) {
  debug('isEqual')
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

CurveCPStream.prototype.decrypt = function (source, prefix, from, to) {
  debug('decrypt')
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

CurveCPStream.prototype.encrypt = function (data, prefix, from, to) {
  debug('encrypt')
  prefix = nacl.util.decodeUTF8(prefix)
  var nonce_length = 24 - prefix.length
  var random_nonce = new Uint8Array(nacl.randomBytes(nacl.box.nonceLength))
  var short_nonce = random_nonce.subarray(0, nonce_length)
  var nonce = new Uint8Array(24)
  nonce.set(prefix)
  nonce.set(short_nonce, prefix.length)
  var box = nacl.box(data, nonce, to, from)
  var result = new Uint8Array(nonce_length + box.length)
  result.set(short_nonce)
  result.set(box, nonce_length)
  return result
}

CurveCPStream.prototype.encrypt_symmetric = function (data, prefix, key) {
  debug('encrypt_symmetric')
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

// Hello command

CurveCPStream.prototype.sendHello = function () {
  debug('sendHello')
  this.canSend = false
  this.initiateSend = false
  var keypair = nacl.box.keyPair()
  this.clientConnectionPublicKey = keypair.publicKey
  this.clientConnectionPrivateKey = keypair.secretKey
  var result = new Uint8Array(224)
  result.set(HELLO_MSG, 0)
  result.set(this.clientConnectionPublicKey, 40)
  var box = this.encrypt(new Uint8Array(64), 'CurveCP-client-H', this.clientConnectionPrivateKey, this.serverPublicKey)
  result.set(box, 136)
  this.stream.write(new Buffer(result))
}

CurveCPStream.prototype.onHello = function (hello_message) {
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

CurveCPStream.prototype.sendCookie = function () {
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
  var encrypted_box_data = this.encrypt(box_data, 'CurveCPK', this.serverPrivateKey, this.clientConnectionPublicKey)
  result.set(encrypted_box_data, 40)
  this.stream.write(new Buffer(result))
}

CurveCPStream.prototype.onCookie = function (cookie_message) {
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

CurveCPStream.prototype.sendInitiate = function (message, done) {
  debug('sendInitiate ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  var result = new Uint8Array(544 + message.length)
  result.set(INITIATE_MSG)
  result.set(this.clientConnectionPublicKey, 40)
  result.set(this.serverCookie, 72)
  var initiate_box_data = new Uint8Array(352 + message.length)
  initiate_box_data.set(this.clientPublicKey)
  initiate_box_data.set(this.create_vouch(), 32)
  initiate_box_data.set(this.serverName, 96)
  initiate_box_data.set(message, 352)
  result.set(this.encrypt(initiate_box_data, 'CurveCP-client-I', this.clientConnectionPrivateKey, this.serverConnectionPublicKey), 168)
  this.stream.write(new Buffer(result), done)
  this.initiateSend = true
  this.canSend = false
}

CurveCPStream.prototype.create_vouch = function () {
  debug('create_vouch')
  return this.encrypt(this.clientConnectionPublicKey, 'CurveCPV', this.clientPrivateKey, this.serverPublicKey)
}

CurveCPStream.prototype.onInitiate = function (initiate_message) {
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

CurveCPStream.prototype.sendServerMessage = function (message, done) {
  debug('sendServerMessage')
  var result = new Uint8Array(64 + message.length)
  result.set(SERVER_MSG)
  var message_box = this.encrypt(message, 'CurveCP-server-M', this.serverConnectionPrivateKey, this.clientConnectionPublicKey)
  result.set(message_box, 8 + 16 + 16)
  this.stream.write(new Buffer(result), done)
}

CurveCPStream.prototype.onServerMessage = function (message) {
  debug('onServerMessage')
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

CurveCPStream.prototype.sendClientMessage = function (message, done) {
  debug('sendClientMessage ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  var result = new Uint8Array(96 + message.length)
  result.set(CLIENT_MSG)
  var message_box = this.encrypt(message, 'CurveCP-client-M', this.clientConnectionPrivateKey, this.serverConnectionPublicKey)
  result.set(message_box, 8 + 16 + 16 + 32)
  this.stream.write(new Buffer(result), done)
}

CurveCPStream.prototype.onClientMessage = function (message) {
  debug('onClientMessage ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
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

module.exports = CurveCPStream
