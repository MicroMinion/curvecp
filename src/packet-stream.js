'use strict'
var Duplex = require('stream').Duplex
var inherits = require('inherits')
var extend = require('extend.js')
var debug = require('debug')('curvecp:PacketStream')
var Uint64BE = require('int64-buffer').Uint64BE
var nacl = require('tweetnacl')
var crypto = require('crypto')
var _ = require('lodash')
nacl.util = require('tweetnacl-util')

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
  opts.allowHalfOpen = false
  this.__ourNonceCounter = 0
  this.__remoteNonceCounter = 0
  this.__state = null
  Duplex.call(this, opts)
  extend(this, {
    __canSend: false,
    __pendingWrite: null,
    __initiateSend: false,
    stream: null,
    isServer: false,
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
    __serverCookie: null
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

PacketStream.prototype._canSend = function () {
  return this.__canSend
}

PacketStream.prototype._setCanSend = function (canSend) {
  if (canSend === this.__canSend) {
    return
  }
  this.__canSend = canSend
  if (canSend && this.__pendingWrite) {
    this._write(this.__pendingWrite.chunk, this.__pendingWrite.encoding, this.__pendingWrite.done)
    this.__pendingWrite = null
  }
}

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
      if (!_.isError(err)) {
        err = new Error(err)
      }
      curveStream.emit('error', err)
    },
    close: function () {
      stream.removeAllListeners()
      curveStream.emit('close')
    },
    end: function () {
      curveStream.emit('end')
    },
    drain: function () {
      curveStream.emit('drain')
    },
    lookup: function (err, address, family) {
      curveStream.emit('lookup', err, address, family)
    },
    timeout: function () {
      if (curveStream.isConnected()) {
        curveStream.emit('timeout')
      } else {
        // TODO: Trigger resend of hello or initiate packet
      }
    }
  }
  stream.on('data', functions.data)
  stream.on('error', functions.error)
  stream.on('close', functions.close)
  stream.on('end', functions.end)
  stream.on('drain', functions.drain)
  stream.on('lookup', functions.lookup)
  stream.on('timeout', functions.timeout)
}

PacketStream.prototype._onMessage = function (message) {
  debug('_onMessage')
  if (this.isServer) {
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
  if (!this._isEqual(this.clientExtension, message.subarray(8, 24))) {
    debug('invalid clientExtension')
    return
  }
  if (!this._isEqual(this.serverExtension, message.subarray(24, 40))) {
    debug('invalid serverExtension')
    return
  }
  var messageType = message.subarray(0, 8)
  if (this._isEqual(messageType, COOKIE_MSG)) {
    this._onCookie(message)
    this.__state = COOKIE_MSG
  } else if (this._isEqual(messageType, SERVER_MSG) &&
    (this.__state === COOKIE_MSG || this.__state === SERVER_MSG)) {
    this._onServerMessage(message)
    this.__state = SERVER_MSG
  } else {
    debug('invalid packet received')
  }
}

PacketStream.prototype._onMessageServer = function (message) {
  debug('_onMessage@Server')
  if (message.length < 96 || message.length > 1184) {
    return
  }
  if (!this._isEqual(this.clientExtension, message.subarray(24, 40))) {
    debug('invalid clientExtension')
    return
  }
  if (!this._isEqual(this.serverExtension, message.subarray(8, 24))) {
    debug('invalid serverExtension')
    return
  }
  var messageType = message.subarray(0, 8)
  debug(messageType.toString())
  if (this._isEqual(messageType, HELLO_MSG)) {
    this._onHello(message)
    this.__state = HELLO_MSG
  } else if (this._isEqual(messageType, INITIATE_MSG) && this.__state === HELLO_MSG) {
    this._onInitiate(message)
    this.__state = INITIATE_MSG
  } else if (this._isEqual(messageType, CLIENT_MSG) &&
    (this.__state === INITIATE_MSG || this.__state === CLIENT_MSG)) {
    this._onClientMessage(message)
    this.__state = CLIENT_MSG
  } else {
    debug('invalid packet received')
  }
}

PacketStream.prototype.connect = function (boxId, connectionInfo) {
  debug('connect')
  debug(connectionInfo)
  var self = this
  if (!this.isServer) {
    this.serverPublicKey = nacl.util.decodeBase64(boxId)
  }
  if (this.stream.isConnected()) {
    if (!this.isServer) {
      this._sendHello()
    }
  } else {
    this.stream.once('connect', function () {
      debug('underlying stream connected')
      self.connect(boxId, connectionInfo)
    })
    this.stream.connect(connectionInfo)
  }
}

PacketStream.prototype.isConnected = function () {
  return this.__canSend
}

PacketStream.prototype.destroy = function () {
  this.stream.destroy()
}

PacketStream.prototype._read = function (size) {
  debug('_read')
}

PacketStream.prototype._write = function (chunk, encoding, done) {
  debug('_write')
  if (this._canSend()) {
    if (this.isServer) {
      this._sendServerMessage(chunk, done)
    } else {
      if (this.__initiateSend) {
        this._sendClientMessage(chunk, done)
      } else {
        this._sendInitiate(chunk, done)
      }
    }
  } else {
    if (this.__pendingWrite) {
      done(new Error('Error: You can not write to stream while previous write did not yet return'))
      return
    }
    this.__pendingWrite = {
      chunk: chunk,
      encoding: encoding,
      done: done
    }
  }
}

// utility functions

PacketStream.prototype._isEqual = function (a, b) {
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

PacketStream.prototype._decrypt = function (source, prefix, from, to) {
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
    debug('Decrypt failed with error ' + err)
  }
  return result
}

PacketStream.prototype._encrypt = function (data, nonce, prefixLength, from, to) {
  // debug('encrypt')
  var box = nacl.box(data, nonce, to, from)
  var result = new Uint8Array(24 - prefixLength + box.length)
  var short_nonce = nonce.subarray(prefixLength)
  result.set(short_nonce)
  result.set(box, 24 - prefixLength)
  return result
}

PacketStream.prototype._encryptSymmetric = function (data, prefix, key) {
  prefix = nacl.util.decodeUTF8(prefix)
  var nonceLength = 24 - prefix.length
  var randomNonce = new Uint8Array(nacl.randomBytes(nacl.secretbox.nonceLength))
  var shortNonce = randomNonce.subarray(0, nonceLength)
  var nonce = new Uint8Array(24)
  nonce.set(prefix)
  nonce.set(shortNonce, prefix.length)
  var box = nacl.secretbox(data, nonce, key)
  var result = new Uint8Array(nonceLength + box.length)
  result.set(nonce)
  result.set(box, nonceLength)
  return result
}

PacketStream.prototype._setExtensions = function (array) {
  if (this.isServer) {
    array.set(this.clientExtension, 8)
    array.set(this.serverExtension, 24)
  } else {
    array.set(this.serverExtension, 8)
    array.set(this.clientExtension, 24)
  }
  return array
}

PacketStream.prototype._createNonceFromCounter = function (prefix) {
  this._increaseCounter()
  var nonce = new Uint8Array(24)
  nonce.set(nacl.util.decodeUTF8(prefix))
  var counter = new Uint8Array(new Uint64BE(this.__ourNonceCounter).toBuffer()).reverse()
  nonce.set(counter, 16)
  return nonce
}

PacketStream.prototype._createRandomNonce = function (prefix) {
  var nonce = new Uint8Array(24)
  nonce.set(nacl.util.decodeUTF8(prefix))
  nonce.set(nacl.randomBytes(16), 8)
  return nonce
}

PacketStream.prototype._increaseCounter = function () {
  this.__ourNonceCounter += 1
}

PacketStream.prototype.__validNonce = function (message, offset) {
  var remoteNonce = new Uint64BE(new Buffer(message.subarray(offset, 8).reverse())).toNumber()
  if (remoteNonce > this.__remoteNonceCounter || (this.__remoteNonceCounter === 0 && remoteNonce === 0)) {
    this.__remoteNonceCounter = remoteNonce
    return true
  } else {
    return false
  }
}

// Hello command

PacketStream.prototype._sendHello = function () {
  debug('sendHello')
  this._setCanSend(false)
  this.__initiateSend = false
  var keyPair = nacl.box.keyPair()
  this.clientConnectionPublicKey = keyPair.publicKey
  this.clientConnectionPrivateKey = keyPair.secretKey
  var result = new Uint8Array(224)
  result.set(HELLO_MSG, 0)
  result.set(this.clientConnectionPublicKey, 40)
  var nonce = this._createNonceFromCounter('CurveCP-client-H')
  var box = this._encrypt(new Uint8Array(64), nonce, 16, this.clientConnectionPrivateKey, this.serverPublicKey)
  result.set(box, 136)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result))
}

PacketStream.prototype._onHello = function (helloMessage) {
  debug('onHello')
  this._setCanSend(false)
  if (helloMessage.length !== 224) {
    debug('Hello message has incorrect length')
    return
  }
  this.clientConnectionPublicKey = helloMessage.subarray(40, 40 + 32)
  if (!this.__validNonce(helloMessage, 40 + 32 + 64)) {
    debug('Invalid nonce received')
    return
  }
  var boxData = this._decrypt(helloMessage.subarray(40 + 32 + 64, 224), 'CurveCP-client-H', this.clientConnectionPublicKey, this.serverPrivateKey)
  if (boxData === undefined) {
    debug('Hello: not able to decrypt box data')
    return
  }
  if (!this._isEqual(boxData, new Uint8Array(64))) {
    debug('Hello: invalid data in signature box')
    return
  }
  this._sendCookie()
}

// Cookie command

PacketStream.prototype._sendCookie = function () {
  debug('sendCookie')
  this._setCanSend(false)
  var keyPair = nacl.box.keyPair()
  this.serverConnectionPublicKey = keyPair.publicKey
  this.serverConnectionPrivateKey = keyPair.secretKey
  var result = new Uint8Array(200)
  result.set(COOKIE_MSG)
  var boxData = new Uint8Array(128)
  boxData.set(this.serverConnectionPublicKey)
  var cookieData = new Uint8Array(64)
  cookieData.set(this.clientConnectionPublicKey)
  cookieData.set(this.serverConnectionPrivateKey, 32)
  var cookieKey = nacl.randomBytes(nacl.box.publicKeyLength)
  var serverCookie = this._encryptSymmetric(cookieData, 'minute-k', cookieKey)
  this.__serverCookie = serverCookie
  boxData.set(serverCookie, 32)
  var nonce = this._createRandomNonce('CurveCPK')
  var encryptedBoxData = this._encrypt(boxData, nonce, 8, this.serverPrivateKey, this.clientConnectionPublicKey)
  result.set(encryptedBoxData, 40)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result))
}

PacketStream.prototype._onCookie = function (cookieMessage) {
  debug('onCookie')
  this._setCanSend(false)
  if (cookieMessage.length !== 200) {
    debug('Cookie message has incorrect length')
    return
  }
  var boxData = this._decrypt(cookieMessage.subarray(40, 200), 'CurveCPK', this.serverPublicKey, this.clientConnectionPrivateKey)
  if (boxData === undefined) {
    debug('Not able to decrypt welcome box data')
    return
  }
  this.serverConnectionPublicKey = boxData.subarray(0, 32)
  this.__serverCookie = boxData.subarray(32)
  if (this.__serverCookie.length !== 96) {
    debug('Welcome command server cookie invalid')
    return
  }
  this._setCanSend(true)
  this.emit('connect')
}

// Initiate command

PacketStream.prototype._sendInitiate = function (message, done) {
  debug('sendInitiate ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  if (message.length & 15) {
    debug('message is of incorrect length, needs to be multiple of 16')
    return
  }
  var result = new Uint8Array(544 + message.length)
  result.set(INITIATE_MSG)
  result.set(this.clientConnectionPublicKey, 40)
  result.set(this.__serverCookie, 72)
  var initiateBoxData = new Uint8Array(352 + message.length)
  initiateBoxData.set(this.clientPublicKey)
  initiateBoxData.set(this._createVouch(), 32)
  initiateBoxData.set(this.serverName, 96)
  initiateBoxData.set(message, 352)
  var nonce = this._createNonceFromCounter('CurveCP-client-I')
  result.set(this._encrypt(initiateBoxData, nonce, 16, this.clientConnectionPrivateKey, this.serverConnectionPublicKey), 168)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result), done)
  this.__initiateSend = true
  this._setCanSend(false)
}

PacketStream.prototype._createVouch = function () {
  var nonce = this._createRandomNonce('CurveCPV')
  return this._encrypt(this.clientConnectionPublicKey, nonce, 8, this.clientPrivateKey, this.serverPublicKey)
}

PacketStream.prototype._onInitiate = function (initiateMessage) {
  debug('onInitiate')
  this._setCanSend(false)
  if (initiateMessage.length < 544) {
    debug('Initiate command has incorrect length')
    return
  }
  if (!this.__validNonce(initiateMessage, 72 + 96)) {
    debug('Invalid nonce received')
    return
  }
  if (!this._isEqual(initiateMessage.subarray(72, 72 + 96), this.__serverCookie)) {
    debug('Initiate command server cookie not recognized')
    return
  }
  var initiateBoxData = this._decrypt(initiateMessage.subarray(72 + 96), 'CurveCP-client-I', this.clientConnectionPublicKey, this.serverConnectionPrivateKey)
  if (initiateBoxData === undefined) {
    debug('Not able to decrypt initiate box data')
    return
  }
  this.clientPublicKey = initiateBoxData.subarray(0, 32)
  var vouch = this._decrypt(initiateBoxData.subarray(32, 96), 'CurveCPV', this.clientPublicKey, this.serverPrivateKey)
  if (vouch === undefined) {
    debug('not able to decrypt vouch data')
    return
  }
  if (!this._isEqual(vouch, this.clientConnectionPublicKey)) {
    debug('Initiate command vouch contains different client connection public key than previously received')
    return
  }
  this._setCanSend(true)
  this.emit('connect')
  this.push(new Buffer(initiateBoxData.subarray(32 + 16 + 48 + 256)))
}

// Message command - Server

PacketStream.prototype._sendServerMessage = function (message, done) {
  debug('sendServerMessage')
  var result = new Uint8Array(64 + message.length)
  result.set(SERVER_MSG)
  var nonce = this._createNonceFromCounter('CurveCP-server-M')
  var messageBox = this._encrypt(message, nonce, 16, this.serverConnectionPrivateKey, this.clientConnectionPublicKey)
  result.set(messageBox, 8 + 16 + 16)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result), done)
}

PacketStream.prototype._onServerMessage = function (message) {
  debug('onServerMessage@Client')
  if (message.length < 64 || message.length > 1152) {
    debug('Message command has incorrect length')
    return
  }
  if (!this.__validNonce(message, 40)) {
    debug('Invalid nonce received')
    return
  }
  var boxData = this._decrypt(message.subarray(40), 'CurveCP-server-M', this.serverConnectionPublicKey, this.clientConnectionPrivateKey)
  if (boxData === undefined || !boxData) {
    debug('not able to decrypt box data')
    return
  }
  this._setCanSend(true)
  var buffer = new Buffer(boxData)
  this.push(buffer)
}

// Message command - Client

PacketStream.prototype._sendClientMessage = function (message, done) {
  debug('sendClientMessage ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  var result = new Uint8Array(96 + message.length)
  result.set(CLIENT_MSG)
  var nonce = this._createNonceFromCounter('CurveCP-client-M')
  var messageBox = this._encrypt(message, nonce, 16, this.clientConnectionPrivateKey, this.serverConnectionPublicKey)
  result.set(messageBox, 8 + 16 + 16 + 32)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result), done)
}

PacketStream.prototype._onClientMessage = function (message) {
  debug('onClientMessage@Server ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  if (message.length < 96 || message.length > 1184) {
    debug('Message command has incorrect length')
    return
  }
  if (!this.__validNonce(message, 40 + 32)) {
    debug('Invalid nonce received')
    return
  }
  var boxData = this._decrypt(message.subarray(40 + 32), 'CurveCP-client-M', this.clientConnectionPublicKey, this.serverConnectionPrivateKey)
  if (boxData === undefined || !boxData) {
    debug('not able to decrypt box data')
    return
  }
  var buffer = new Buffer(boxData)
  this.push(buffer)
}

Object.defineProperty(PacketStream.prototype, 'remoteAddress', {
  get: function () {
    if (this.isServer) {
      return nacl.util.encodeBase64(this.clientPublicKey)
    } else {
      return nacl.util.encodeBase64(this.serverPublicKey)
    }
  }
})

module.exports = PacketStream
