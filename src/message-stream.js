var Chicago = require('./chicago.js')
var Message = require('./message.js')
var assert = require('assert')
var Duplex = require('readable-stream-no-buffering').Duplex
var inherits = require('inherits')
var Block = require('./message-block.js')
var _ = require('lodash')
var constants = require('./constants.js')
var isBuffer = require('is-buffer')
var winston = require('winston')
var winstonWrapper = require('winston-meta-wrapper')

var MessageStream = function (options) {
  if (!options) {
    options = {}
  }
  if (!options.logger) {
    options.logger = winston
  }
  this._log = winstonWrapper(options.logger)
  this._log.addMeta({
    module: 'curvecp-messagestream'
  })
  var opts = {}
  opts.objectMode = false
  opts.decodeStrings = true
  opts.allowHalfOpen = false
  opts.highWaterMark = 0
  Duplex.call(this, opts)
  this._maxBlockLength = 640 - constants.HEADER_SIZE - constants.MINIMAL_PADDING
  this._stream = options.stream
  this.__streamReady = false
  var self = this
  this._stream.on('data', this._receiveData.bind(this))
  this._stream.on('error', function (error) {
    self.emit('error', error)
  })
  this._stream.on('close', function () {
    self.push(null)
    self._cleanup()
    self.emit('close')
    self._stream.removeAllListeners()
  })
  this._stream.on('end', function () {
    self.push(null)
  })
  this._stream.on('connect', function () {
    self.__streamReady = true
    self.emit('connect')
  })
  this._stream.on('lookup', function (err, address, family) {
    self.emit('lookup', err, address, family)
  })
  this._stream.on('timeout', function () {
    self.emit('timeout')
  })
  if (this._stream.is_server) {
    this._maxBlockLength = constants.MESSAGE_BODY
  }
  /* Bytes that still need to be processed */
  this._sendBytes = new Buffer(0)
  this._stopSuccess = false
  this._stopFailure = false
  this._writeRequests = []
  /* Bytes that have been processed / send to peer */
  this._sendProcessed = 0
  /* Blocks that have been send but not yet acknowledged by other party */
  this._outgoing = []
  /* Messages that have been received but not yet processed */
  this._incoming = []
  /* Number of bytes that have been received and send upstream */
  this._receivedBytes = 0
  /* Chicago congestion control algorithm */
  this._chicago = new Chicago()
  /* nanosecond precision timer */
  this._chicago.set_timeout(this._process.bind(this))
  this.__nextMessageId = 1
}

inherits(MessageStream, Duplex)

MessageStream.prototype._cleanup = function () {
  this._sendBytes = new Buffer(0)
  _.forEach(this._writeRequests, function (request) {
    request.callback(new Error('Underlying stream does not respond anymore'))
  })
  this._writeRequests = []
  this._outgoing = []
}

MessageStream.prototype._nextMessageId = function () {
  var result = this.__nextMessageId
  this.__nextMessageId += 1
  return result
}

MessageStream.prototype._receiveData = function (data) {
  this._log.debug('_receiveData')
  if (_.size(this._incoming) < constants.MAX_INCOMING) {
    var message = new Message()
    message.fromBuffer(data)
    this._incoming.push(message)
  }
  var self = this
  process.nextTick(function () {
    if (self.canProcessMessage()) {
      self.processMessage()
    }
  })
}

MessageStream.prototype.connect = function (boxId, connectionInfo) {
  this._stream.connect(boxId, connectionInfo)
}

MessageStream.prototype.isConnected = function () {
  return this._stream.isConnected()
}

MessageStream.prototype.destroy = function () {
  this._stream.destroy()
}

MessageStream.prototype._read = function (size) {}

MessageStream.prototype._process = function () {
  this._log.debug('_process')
  var maxReached = _.some(this._outgoing, function (block) {
    return block.transmissions > constants.MAX_RETRANSMISSIONS
  })
  if (maxReached) {
    this._log.warn('maximum retransmissions reached')
    this._cleanup()
    this.emit('error', new Error('Maximum retransmissions reached - remote host down'))
  }
  if (this.canResend()) {
    this.resendBlock()
  } else if (this.canSend()) {
    this.sendBlock()
  }
  if (_.isEmpty(this._incoming) && _.isEmpty(this._outgoing) && this._sendBytes.length === 0) {
    this._chicago.disable_timer()
  }
}

MessageStream.prototype._write = function (chunk, encoding, done) {
  this._log.debug('_write')
  assert(isBuffer(chunk))
  if (this._sendBytes.length > constants.MAXIMUM_UNPROCESSED_SEND_BYTES) {
    this._log.warn('Buffer is full')
    done(new Error('Buffer is full'))
    return
  }
  this._writeRequests.push({
    startByte: this._sendProcessed,
    length: chunk.length,
    callback: done
  })
  this._sendBytes = Buffer.concat([this._sendBytes, chunk])
  this._log.debug('_sendBytes length: ' + this._sendBytes.length)
  this._log.debug('_sendProcessed length: ' + this._sendProcessed)
  this._chicago.enable_timer()
  return this._sendBytes.length < constants.MAXIMUM_UNPROCESSED_SEND_BYTES
}

MessageStream.prototype._end = function () {
  this._stopSuccess = true
  this._writableState.ended = true
}

MessageStream.prototype.canResend = function () {
  var self = this
  if (this.__streamReady && !_.isEmpty(this._outgoing)) {
    var some = _.some(this._outgoing, function (block) {
      return self._chicago.block_is_timed_out(block.transmission_time)
    })
    return some
  }
  return false
}

MessageStream.prototype.resendBlock = function () {
  this._log.debug('resendBlock')
  var block = this._outgoing[0]
  _.forEach(this._outgoing, function (compareBlock) {
    if (block.transmission_time.compare(compareBlock) > 0) {
      block = compareBlock
    }
  })
  block.transmission_time = this._chicago.get_clock()
  block.transmissions = block.transmissions + 1
  block.id = this._nextMessageId()
  this._chicago.retransmission()
  this._sendBlock(block)
}

MessageStream.prototype.canSend = function () {
  return this.__streamReady && this._sendBytes.length > 0 && _.size(this._outgoing) < constants.MAX_OUTGOING
}

MessageStream.prototype.sendBlock = function () {
  this._log.debug('sendBlock')
  this._log.debug('sendBytes start: ' + this._sendBytes.length)
  this._log.debug('sendProcessed start: ' + this._sendProcessed)
  var blockSize = this._sendBytes.length
  if (blockSize > this._maxBlockLength) {
    blockSize = this._maxBlockLength
  }
  var block = new Block()
  block.start_byte = this._sendProcessed
  block.transmission_time = this._chicago.get_clock()
  block.id = this._nextMessageId()
  block.data = this._sendBytes.slice(0, blockSize)
  if (this._sendBytes.length === blockSize && (this._stopSuccess || this._stopFailure)) {
    block.stop_success = this._stopSuccess
    block.stop_failure = this._stopFailure
  }
  this._sendBytes = this._sendBytes.slice(blockSize)
  this._sendProcessed = this._sendProcessed + block.data.length
  this._log.debug('sendBytes stop: ' + this._sendBytes.length)
  this._log.debug('sendProcessed stop: ' + this._sendProcessed)
  this._outgoing.push(block)
  this._sendBlock(block)
  if (this._sendBytes.length + block.data.length > constants.MAXIMUM_UNPROCESSED_SEND_BYTES * 0.5 &&
    this._sendBytes.length < constants.MAXIMUM_UNPROCESSED_SEND_BYTES * 0.5) {
    this.emit('drain')
  }
}

MessageStream.prototype._sendBlock = function (block) {
  this._log.debug('_sendBlock ' + block.start_byte + ' - ' + block.data.length)
  var message = new Message()
  message.id = block.id
  message.acknowledging_range_1_size = this._receivedBytes
  message.data = block.data
  message.success = block.stop_success
  message.failure = block.stop_failure
  message.offset = block.start_byte
  this._chicago.send_block()
  this._writeToStream(message)
  this._maxBlockLength = constants.MESSAGE_BODY
}

MessageStream.prototype.canProcessMessage = function () {
  return this._incoming.length > 0
}

MessageStream.prototype.processMessage = function () {
  this._log.debug('processMessage')
  var message = this._incoming.shift()
  this.processAcknowledgments(message)
  this._processMessage(message)
}

MessageStream.prototype.processAcknowledgments = function (message) {
  var self = this
  this._log.debug('processAcknowledgements')
  var removedList
  removedList = _.remove(this._outgoing, function (block) {
    return message.isAcknowledged(block.start_byte, block.data.length)
  })
  _.forEach(removedList, function (block) {
    self._log.debug('block acknowledged: ' + block.start_byte + ' - ' + block.data.length)
    self._chicago.acknowledgement(block.transmission_time)
  })
  removedList = _.remove(this._writeRequests, function (writeRequest) {
    return message.isAcknowledged(writeRequest.startByte, writeRequest.length)
  })
  _.forEach(removedList, function (writeRequest) {
    self._log.debug('write request acknowledged: ' + writeRequest.startByte + ' - ' + writeRequest.length)
    writeRequest.callback()
  })
  if ((this._stopSuccess || this._stopFailure) && this._sendBytes.length === 0 && this._outgoing.length === 0) {
    this.emit('finish')
  }
}

MessageStream.prototype.sendAcknowledgment = function (message) {
  this._log.debug('sendAcknowledgment ' + this._receivedBytes)
  var reply = new Message()
  reply.id = this._nextMessageId()
  reply.acknowledging_id = message.id
  reply.acknowledging_range_1_size = this._receivedBytes
  this._writeToStream(reply)
}

MessageStream.prototype._processMessage = function (message) {
  this._log.debug('_processMessage')
  if (message.offset <= this._receivedBytes) {
    if (message.data_length > 1) {
      var ignoreBytes = this._receivedBytes - message.offset
      var data = message.data.slice(ignoreBytes)
      this._receivedBytes += data.length
      // debug(data.toString())
      this.push(data)
      if (message.success || message.failure) {
        this.push(null)
      }
      this.sendAcknowledgment(message)
    }
  }
}

MessageStream.prototype._writeToStream = function (message) {
  this.__streamReady = false
  this._stream.write(message.toBuffer(), this._processReady.bind(this))
}

MessageStream.prototype._processReady = function (err) {
  if (!err) {
    this.__streamReady = true
  } else {
    this._log.warn('error while sending CurveCP message')
  }
}

Object.defineProperty(MessageStream.prototype, 'remoteAddress', {
  get: function () {
    return this._stream.remoteAddress
  }
})

module.exports = MessageStream
