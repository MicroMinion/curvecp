'use strict'
var Duplex = require('stream').Duplex
var inherits = require('inherits')
var extend = require('extend.js')
var Uint64BE = require('int64-buffer').Uint64BE
var nacl = require('tweetnacl')
var crypto = require('crypto')
var _ = require('lodash')
nacl.util = require('tweetnacl-util')
var utils = require('./utils.js')
var winston = require('winston')
var winstonWrapper = require('winston-meta-wrapper')

var HELLO_MSG = nacl.util.decodeUTF8('QvnQ5XlH')
var COOKIE_MSG = nacl.util.decodeUTF8('RL3aNMXK')
var INITIATE_MSG = nacl.util.decodeUTF8('QvnQ5XlI')
var SERVER_MSG = nacl.util.decodeUTF8('RL3aNMXM')
var CLIENT_MSG = nacl.util.decodeUTF8('QvnQ5XlM')

var HELLO_WAIT = [1000000000, 1500000000, 2250000000, 3375000000, 5062500000, 7593750000, 11390625000, 17085937500]

var MINUTE_KEY_TIMEOUT = 1000 * 60 * 2

nacl.setPRNG(function (x, n) {
  var i
  var v = crypto.randomBytes(n)
  for (i = 0; i < n; i++) x[i] = v[i]
  for (i = 0; i < v.length; i++) v[i] = 0
})

var PacketStream = function (opts) {
  if (!opts) opts = {}
  if (!opts.logger) {
    opts.logger = winston
  }
  this._log = winstonWrapper(opts.logger)
  this._log.addMeta({
    module: 'curvecp-packetstream'
  })
  opts.objectMode = false
  opts.decodeStrings = true
  opts.allowHalfOpen = false
  this.__ourNonceCounter = 0
  this.__remoteNonceCounter = 0
  this.__helloCounter = 0
  this.__state = null
  this.__sharedKey = null
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
    buffer.write('0A', 'hex')
    buffer.write(this.serverName, 1)
    this.serverName = new Uint8Array(buffer)
  }
  if (!this.isServer) {
    var keyPair = nacl.box.keyPair()
    this.clientConnectionPublicKey = keyPair.publicKey
    this.clientConnectionPrivateKey = keyPair.secretKey
  }
  this._connectStream(this.stream)
}

inherits(PacketStream, Duplex)

PacketStream.prototype._startCookieKeyTimeout = function () {
  var self = this
  this.__cookieKey = nacl.randomBytes(nacl.secretbox.keyLength)
  setTimeout(function () {
    delete self.__cookieKey
  }, MINUTE_KEY_TIMEOUT)
}

PacketStream.prototype.toMetadata = function () {
  return {
    isServer: this.isServer,
    serverPublicKey: this._encode(this.serverPublicKey),
    clientPublicKey: this._encode(this.clientPublicKey),
    serverConnectionPublicKey: this._encode(this.serverConnectionPublicKey),
    clientConnectionPublicKey: this._encode(this.clientConnectionPublicKey)
  }
}

PacketStream.prototype._encode = function (array) {
  if (array !== undefined && array !== null) {
    return nacl.util.encodeBase64(array)
  } else {
    return
  }
}

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
        curveStream.emit('error', new Error('Timeout expired to establish connection'))
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
  this._log.debug('_onMessage')
  if (this.isServer) {
    this._onMessageServer(message)
  } else {
    this._onMessageClient(message)
  }
}

PacketStream.prototype._onMessageClient = function (message) {
  this._log.debug('_onMessage@Client')
  if (message.length < 64 || message.length > 1152) {
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
    this._log.warn('invalid packet received')
  }
}

PacketStream.prototype._onMessageServer = function (message) {
  this._log.debug('_onMessage@Server')
  if (message.length < 96 || message.length > 1184) {
    return
  }
  var messageType = message.subarray(0, 8)
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
    this._log.warn('invalid packet received')
  }
}

PacketStream.prototype.connect = function (boxId, connectionInfo) {
  this._log.debug('connect', {
    connectionInfo: connectionInfo,
    boxId: boxId
  })
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
      self._log.debug('underlying stream connected')
      self.connect(boxId, connectionInfo)
    })
    this.stream.connect(connectionInfo)
  }
}

PacketStream.prototype.setDestination = function (destination) {
  this.serverPublicKey = nacl.util.decodeBase64(destination)
}

PacketStream.prototype.isConnected = function () {
  return this.stream.isConnected() && this.__sharedKey
}

PacketStream.prototype.destroy = function () {
  this.stream.destroy()
}

PacketStream.prototype._read = function (size) {
  this._log.debug('_read')
}

PacketStream.prototype._write = function (chunk, encoding, done) {
  this._log.debug('_write')
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
    var nonceLength = 24 - prefix.length
    var shortNonce = source.subarray(0, nonceLength)
    var nonce = new Uint8Array(24)
    nonce.set(prefix)
    nonce.set(shortNonce, prefix.length)
    var result = nacl.box.open(source.subarray(nonceLength), nonce, from, to)
  } catch (err) {
    this._log.warn('Decrypt failed with error ' + err)
  }
  return result
}

PacketStream.prototype._decryptShared = function (source, prefix) {
  try {
    prefix = nacl.util.decodeUTF8(prefix)
    var nonceLength = 24 - prefix.length
    var shortNonce = source.subarray(0, nonceLength)
    var nonce = new Uint8Array(24)
    nonce.set(prefix)
    nonce.set(shortNonce, prefix.length)
    var result = nacl.box.open.after(source.subarray(nonceLength), nonce, this.__sharedKey)
  } catch (err) {
    this._log.warn('Decrypt failed with error ' + err)
  }
  return result
}

PacketStream.prototype._encrypt = function (data, nonce, prefixLength, from, to) {
  // debug('encrypt')
  var box = nacl.box(data, nonce, to, from)
  var result = new Uint8Array(24 - prefixLength + box.length)
  var shortNonce = nonce.subarray(prefixLength)
  result.set(shortNonce)
  result.set(box, 24 - prefixLength)
  return result
}

PacketStream.prototype._encryptShared = function (data, nonce, prefixLength) {
  var box = nacl.box.after(data, nonce, this.__sharedKey)
  var result = new Uint8Array(24 - prefixLength + box.length)
  var shortNonce = nonce.subarray(prefixLength)
  result.set(shortNonce)
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
  result.set(shortNonce)
  result.set(box, nonceLength)
  return result
}

PacketStream.prototype._decryptSymmetric = function (data, prefix, key) {
  try {
    prefix = nacl.util.decodeUTF8(prefix)
    var nonceLength = 24 - prefix.length
    var shortNonce = data.subarray(0, nonceLength)
    var nonce = new Uint8Array(24)
    nonce.set(prefix)
    nonce.set(shortNonce, prefix.length)
    var result = nacl.secretbox.open(data.subarray(nonceLength), nonce, key)
  } catch (err) {
    this._log.warn('Decrypt failed with error ' + err)
  }
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

PacketStream.prototype._validExtensions = function (array) {
  if (this.isServer) {
    return this._validServerExtension(array.subarray(8, 8 + 16)) &&
      this._validClientExtension(array.subarray(8 + 16, 8 + 16 + 16))
  } else {
    return this._validClientExtension(array.subarray(8, 8 + 16)) &&
      this._validServerExtension(array.subarray(8 + 16, 8 + 16 + 16))
  }
}

PacketStream.prototype._validServerExtension = function (extension) {
  return this._isEqual(extension, this.serverExtension)
}

PacketStream.prototype._validClientExtension = function (extension) {
  return this._isEqual(extension, this.clientExtension)
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
  this._log.debug('sendHello')
  var self = this
  this._setCanSend(false)
  this.__initiateSend = false
  var result = new Uint8Array(224)
  result.set(HELLO_MSG, 0)
  result.set(this.clientConnectionPublicKey, 40)
  var nonce = this._createNonceFromCounter('CurveCP-client-H')
  var box = this._encrypt(new Uint8Array(64), nonce, 16, this.clientConnectionPrivateKey, this.serverPublicKey)
  result.set(box, 136)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result))
  var wait = HELLO_WAIT[this.__helloCounter]
  setTimeout(function () {
    if (self.__state === COOKIE_MSG || self.__state === SERVER_MSG) {} else if (self.__helloCounter < HELLO_WAIT.length + 1) {
      self.__helloCounter += 1
      self._sendHello()
    } else {
      self.emit('error', new Error('Maximum resends of HELLO packet reached, aborting'))
    }
  }, (wait + utils.randommod(wait)) / 1000000)
}

PacketStream.prototype._onHello = function (helloMessage) {
  this._log.debug('onHello')
  this._setCanSend(false)
  if (helloMessage.length !== 224) {
    this._log.warn('Hello message has incorrect length')
    return
  }
  this.clientExtension = helloMessage.subarray(8 + 16, 8 + 16 + 16)
  if (!this._validServerExtension(helloMessage.subarray(8, 8 + 16))) {
    this._log.warn('Invalid server extension in hello message')
    return
  }
  this.clientConnectionPublicKey = helloMessage.subarray(40, 40 + 32)
  if (!this.__validNonce(helloMessage, 40 + 32 + 64)) {
    this._log.warn('Invalid nonce received')
    return
  }
  var boxData = this._decrypt(helloMessage.subarray(40 + 32 + 64, 224), 'CurveCP-client-H', this.clientConnectionPublicKey, this.serverPrivateKey)
  if (boxData === undefined) {
    this._log.warn('Hello: not able to decrypt box data')
    return
  }
  if (!this._isEqual(boxData, new Uint8Array(64))) {
    this._log.warn('Hello: invalid data in signature box')
    return
  }
  this._sendCookie()
}

// Cookie command

PacketStream.prototype._sendCookie = function () {
  this._log.debug('sendCookie')
  this._setCanSend(false)
  var keyPair = nacl.box.keyPair()
  this.serverConnectionPublicKey = keyPair.publicKey
  this.serverConnectionPrivateKey = keyPair.secretKey
  this.__sharedKey = nacl.box.before(this.clientConnectionPublicKey, this.serverConnectionPrivateKey)
  var result = new Uint8Array(200)
  result.set(COOKIE_MSG)
  var boxData = new Uint8Array(128)
  boxData.set(this.serverConnectionPublicKey)
  var cookieData = new Uint8Array(64)
  cookieData.set(this.clientConnectionPublicKey)
  cookieData.set(this.serverConnectionPrivateKey, 32)
  this._startCookieKeyTimeout()
  var serverCookie = this._encryptSymmetric(cookieData, 'minute-k', this.__cookieKey)
  boxData.set(serverCookie, 32)
  var nonce = this._createRandomNonce('CurveCPK')
  var encryptedBoxData = this._encrypt(boxData, nonce, 8, this.serverPrivateKey, this.clientConnectionPublicKey)
  result.set(encryptedBoxData, 40)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result))
}

PacketStream.prototype._isValidCookie = function (cookie) {
  var cookieData = this._decryptSymmetric(cookie, 'minute-k', this.__cookieKey)
  if (!cookieData) {
    return false
  }
  return this._isEqual(cookieData.subarray(0, 32), this.clientConnectionPublicKey) &&
    this._isEqual(cookieData.subarray(32), this.serverConnectionPrivateKey)
}

PacketStream.prototype._onCookie = function (cookieMessage) {
  this._log.debug('onCookie')
  this._setCanSend(false)
  if (cookieMessage.length !== 200) {
    this._log.warn('Cookie message has incorrect length')
    return
  }
  if (!this._validExtensions(cookieMessage)) {
    this._log.warn('Invalid extensions')
    return
  }
  var boxData = this._decrypt(cookieMessage.subarray(40, 200), 'CurveCPK', this.serverPublicKey, this.clientConnectionPrivateKey)
  if (boxData === undefined || !boxData) {
    this._log.warn('Not able to decrypt cookie box data')
    return
  }
  this.serverConnectionPublicKey = boxData.subarray(0, 32)
  this.__sharedKey = nacl.box.before(this.serverConnectionPublicKey, this.clientConnectionPrivateKey)
  this.__serverCookie = boxData.subarray(32)
  if (this.__serverCookie.length !== 96) {
    this._log.warn('Server cookie invalid')
    return
  }
  this._setCanSend(true)
  this.emit('connect')
}

// Initiate command

PacketStream.prototype._sendInitiate = function (message, done) {
  this._log.debug('sendInitiate ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  if (message.length & 15) {
    this._log.warn('message is of incorrect length, needs to be multiple of 16')
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
  result.set(this._encryptShared(initiateBoxData, nonce, 16), 168)
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
  this._log.debug('onInitiate')
  this._setCanSend(false)
  if (initiateMessage.length < 544) {
    this._log.warn('Initiate command has incorrect length')
    return
  }
  if (!this._isEqual(initiateMessage.subarray(40, 40 + 32), this.clientConnectionPublicKey)) {
    this._log.warn('Invalid client connection key')
    return
  }
  if (!this._validExtensions(initiateMessage)) {
    this._log.warn('Invalid extensions')
    return
  }
  if (!this.__validNonce(initiateMessage, 72 + 96)) {
    this._log.warn('Invalid nonce received')
    return
  }
  if (!this._isValidCookie(initiateMessage.subarray(72, 72 + 96))) {
    this._log.warn('Initiate command server cookie not recognized')
    return
  }
  var initiateBoxData = this._decryptShared(initiateMessage.subarray(72 + 96), 'CurveCP-client-I')
  if (initiateBoxData === undefined) {
    this._log.warn('Not able to decrypt initiate box data')
    return
  }
  this.clientPublicKey = initiateBoxData.subarray(0, 32)
  var vouch = this._decrypt(initiateBoxData.subarray(32, 96), 'CurveCPV', this.clientPublicKey, this.serverPrivateKey)
  if (vouch === undefined) {
    this._log.warn('not able to decrypt vouch data')
    return
  }
  if (!this._isEqual(vouch, this.clientConnectionPublicKey)) {
    this._log.warn('Initiate command vouch contains different client connection public key than previously received')
    return
  }
  if (!this._isEqual(initiateBoxData.subarray(32 + 16 + 48, 32 + 16 + 48 + 256), this.serverName)) {
    this._log.warn('Invalid server name')
    return
  }
  this._setCanSend(true)
  this.emit('connect')
  this.push(new Buffer(initiateBoxData.subarray(32 + 16 + 48 + 256)))
}

// Message command - Server

PacketStream.prototype._sendServerMessage = function (message, done) {
  this._log.debug('sendServerMessage')
  var result = new Uint8Array(64 + message.length)
  result.set(SERVER_MSG)
  var nonce = this._createNonceFromCounter('CurveCP-server-M')
  var messageBox = this._encryptShared(message, nonce, 16)
  result.set(messageBox, 8 + 16 + 16)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result), done)
}

PacketStream.prototype._onServerMessage = function (message) {
  this._log.debug('onServerMessage@Client')
  if (message.length < 64 || message.length > 1152) {
    this._log.warn('Message command has incorrect length')
    return
  }
  if (!this._validExtensions(message)) {
    this._log.warn('Invalid extensions')
    return
  }
  if (!this.__validNonce(message, 40)) {
    this._log.warn('Invalid nonce received')
    return
  }
  var boxData = this._decryptShared(message.subarray(40), 'CurveCP-server-M')
  if (boxData === undefined || !boxData) {
    this._log.warn('not able to decrypt box data')
    return
  }
  this._setCanSend(true)
  var buffer = new Buffer(boxData)
  this.push(buffer)
}

// Message command - Client

PacketStream.prototype._sendClientMessage = function (message, done) {
  this._log.debug('sendClientMessage ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  var result = new Uint8Array(96 + message.length)
  result.set(CLIENT_MSG)
  result.set(this.clientConnectionPublicKey, 40)
  var nonce = this._createNonceFromCounter('CurveCP-client-M')
  var messageBox = this._encryptShared(message, nonce, 16)
  result.set(messageBox, 8 + 16 + 16 + 32)
  result = this._setExtensions(result)
  this.stream.write(new Buffer(result), done)
}

PacketStream.prototype._onClientMessage = function (message) {
  this._log.debug('onClientMessage@Server ' + nacl.util.encodeBase64(this.clientPublicKey) + ' > ' + nacl.util.encodeBase64(this.serverPublicKey))
  if (message.length < 96 || message.length > 1184) {
    this._log.warn('Message command has incorrect length')
    return
  }
  if (!this._validExtensions(message)) {
    this._log.warn('Invalid extensions')
    return
  }
  if (!this._isEqual(message.subarray(40, 40 + 32), this.clientConnectionPublicKey)) {
    this._log.warn('Invalid client connection key')
    return
  }
  if (!this.__validNonce(message, 40 + 32)) {
    this._log.warn('Invalid nonce received')
    return
  }
  var boxData = this._decryptShared(message.subarray(40 + 32), 'CurveCP-client-M')
  if (boxData === undefined || !boxData) {
    this._log.warn('not able to decrypt box data')
    return
  }
  var buffer = new Buffer(boxData)
  this._setCanSend(true)
  this.push(buffer)
}

Object.defineProperty(PacketStream.prototype, 'remoteAddress', {
  get: function () {
    if (this.isServer) {
      if (!this.clientPublicKey) {
        return
      } else {
        return nacl.util.encodeBase64(this.clientPublicKey)
      }
    } else {
      return nacl.util.encodeBase64(this.serverPublicKey)
    }
  }
})

module.exports = PacketStream
