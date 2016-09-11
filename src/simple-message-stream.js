var Chicago = require('./chicago.js')
var Message = require('./message.js')
var assert = require('assert')
var EventEmitter = require('events').EventEmitter
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
  EventEmitter.call(this)
  this._maxBlockLength = constants.MESSAGE_BODY
  this._stream = options.stream
  var self = this
  this._stream.on('data', this._receiveData.bind(this))
  this._stream.on('error', function (error) {
    self.emit('error', error)
  })
  this._stream.on('close', function () {
    self._cleanup()
    self.emit('close')
  })
  this.__streamReady = true
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

inherits(MessageStream, EventEmitter)

MessageStream.prototype._cleanup = function () {
  var writeRequests = this._writeRequests
  this._writeRequests = []
  this._sendBytes = new Buffer(0)
  _.forEach(writeRequests, function (request) {
    request.callback(new Error('Underlying stream does not respond anymore'))
  })
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
    try {
      message.fromBuffer(data)
    } catch (e) {
      this._log.warn('Invalid message received')
      return
    }
    this._incoming.push(message)
  }
  var self = this
  process.nextTick(function () {
    if (self.canProcessMessage()) {
      self.processMessage()
    }
  })
}

MessageStream.prototype.destroy = function () {
  this._stream.destroy()
}

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

MessageStream.prototype.write = function (chunk, done) {
  this._log.debug('write')
  assert(isBuffer(chunk))
  assert(_.isFunction(done))
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

MessageStream.prototype.canResend = function () {
  var self = this
  if (this.__streamReady && !_.isEmpty(this._outgoing)) {
    var some = _.some(this._outgoing, function (block) {
      return self._chicago.block_is_timed_out(block.transmissionTime)
    })
    return some
  }
  return false
}

MessageStream.prototype.resendBlock = function () {
  this._log.debug('resendBlock')
  var block = this._outgoing[0]
  _.forEach(this._outgoing, function (compareBlock) {
    if (block.transmissionTime.compare(compareBlock) > 0) {
      block = compareBlock
    }
  })
  block.transmissionTime = this._chicago.get_clock()
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
  block.startByte = this._sendProcessed
  block.transmissionTime = this._chicago.get_clock()
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
  this._log.debug('_sendBlock ' + block.startByte + ' - ' + block.data.length)
  var message = new Message()
  message.id = block.id
  message.acknowledging_range_1_size = this._receivedBytes
  message.data = block.data
  message.success = block.stop_success
  message.failure = block.stop_failure
  message.offset = block.startByte
  this._chicago.send_block()
  this._writeToStream(message)
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
    return message.isAcknowledged(block.startByte, block.data.length)
  })
  _.forEach(removedList, function (block) {
    self._log.debug('block acknowledged: ' + block.startByte + ' - ' + block.data.length)
    self._chicago.acknowledgement(block.transmissionTime)
  })
  removedList = _.remove(this._writeRequests, function (writeRequest) {
    return message.isAcknowledged(writeRequest.startByte, writeRequest.length)
  })
  _.forEach(removedList, function (writeRequest) {
    self._log.debug('write request acknowledged: ' + writeRequest.startByte + ' - ' + writeRequest.length)
    writeRequest.callback()
  })
  if ((this._stopSuccess || this._stopFailure) && this._sendBytes.length === 0 && this._outgoing.length === 0) {
    this.emit('close')
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
      this.emit('data', data)
      if (message.success || message.failure) {
        this.emit('close')
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
    this.emit('error', err)
  }
}

Object.defineProperty(MessageStream.prototype, 'remoteAddress', {
  get: function () {
    return this._stream.remoteAddress
  }
})

module.exports = MessageStream
