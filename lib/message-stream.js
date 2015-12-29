var Chicago = require('./chicago.js')
var Message = require('./message.js')
var isBuffer = require('isbuffer')
var assert = require('assert')
var Duplex = require('stream').Duplex
var inherits = require('inherits')
var Block = require('./message-block.js')
var Uint64BE = require('int64-buffer').Uint64BE
var _ = require('lodash')
var debug = require('debug')('curvecp:MessageStream')
var constants = require('./constants.js')

var MessageStream = function (curveCPStream) {
  debug('initialize')
  var opts = {
    objectMode: false,
    decodeStrings: true
  }
  Duplex.call(this, opts)
  this.maxBlockLength = 640 - constants.HEADER_SIZE - constants.MINIMAL_PADDING
  this.stream = curveCPStream
  var self = this
  this.stream.on('data', this._receiveData.bind(this))
  this.stream.on('error', function (error) {
    self.emit('error', error)
  })
  this.stream.on('close', function () {
    self.emit('close')
  })
  this.stream.on('connect', function () {
    self.emit('connect')
  })
  if (this.stream.is_server) {
    this.maxBlockLength = constants.MESSAGE_BODY
  }
  /* Bytes that still need to be processed */
  this.sendBytes = new Buffer(0)
  /* Bytes that have been processed / send to peer */
  this.sendProcessed = 0
  /* Blocks that have been send but not yet acknowledged by other party */
  this.outgoing = {}
  /* Messages that have been received but not yet processed */
  this.incoming = []
  /* Number of bytes that have been received and send upstream */
  this.receivedBytes = 0
  /* Chicago congestion control algorithm */
  this.chicago = new Chicago()
  /* nanosecond precision timer */
  this.chicago.set_timeout(this._process.bind(this))
  this._nextMessageId = 1
}

inherits(MessageStream, Duplex)

MessageStream.prototype.nextMessageId = function () {
  var result = this._nextMessageId
  this._nextMessageId += 1
  return result
}

MessageStream.prototype._receiveData = function (data) {
  debug('_receiveData')
  if (_.size(this.incoming) < constants.MAX_INCOMING) {
    var message = new Message()
    message.fromBuffer(data)
    this.incoming.push(message)
    this.chicago.enable_timer()
  }
}

MessageStream.prototype.connect = function () {
  this.stream.connect()
}

MessageStream.prototype.destroy = function () {
  this.stream.destroy()
}

MessageStream.prototype._read = function (size) {}

MessageStream.prototype._process = function () {
  debug('_process')
  if (this.canResend()) {
    this.resendBlock()
  } else if (this.canSend()) {
    this.sendBlock()
  }
  if (this.canProcessMessage()) {
    this.processMessage()
  }
  if (_.isEmpty(this.incoming) && _.isEmpty(this.outgoing) && this.sendBytes.length === 0) {
    this.chicago.disable_timer()
  }
}

MessageStream.prototype._write = function (chunk, encoding, done) {
  debug('_write')
  assert(isBuffer(chunk))
  // FIXME: Re-enable buffer checking
  // if (this.sendBytes.length > MAXIMUM_UNPROCESSED_SEND_BYTES) {
  //  done(new Error('Buffer full'))
  //  return
  // }
  // debug('chunk length: ' + chunk.length)
  this.sendBytes = Buffer.concat([this.sendBytes, chunk])
  // debug('sendBytes lenth: ' + this.sendBytes.length)
  this.chicago.enable_timer()
  done()
}

MessageStream.prototype.canResend = function () {
  return this.stream.canSend && !_.isEmpty(this.outgoing) && _.some(this.outgoing, function (block) {
    return this.chicago.block_is_timed_out(block.transmission_time)
  }, this)
}

MessageStream.prototype.resendBlock = function () {
  var block = _.min(this.outgoing, 'transmission_time')
  block.transmission_time = this.chicago.get_clock()
  block.id = this.nextMessageId()
  this.chicago.retransmission()
  this._sendBlock(block)
}

MessageStream.prototype.canSend = function () {
  return this.stream.canSend && this.sendBytes.length > 0 && _.size(this.outgoing) < constants.MAX_OUTGOING
}

MessageStream.prototype.sendBlock = function () {
  debug('sendBlock')
  debug('sendBytes size: ' + this.sendBytes.length)
  var blockSize = this.sendBytes.length
  if (blockSize > this.maxBlockLength) {
    blockSize = this.maxBlockLength
  }
  debug('blockSize: ' + blockSize)
  var block = new Block()
  block.start_byte = this.sendProcessed
  block.transmission_time = this.chicago.get_clock()
  block.id = this.nextMessageId()
  block.data = this.sendBytes.slice(0, blockSize)
  this.sendBytes = this.sendBytes.slice(blockSize)
  this.sendProcessed = this.sendProcessed + block.data.length
  this.outgoing[block.id] = block
  this._sendBlock(block)
}

MessageStream.prototype._sendBlock = function (block) {
  debug('_sendBlock')
  var message = new Message()
  message.id = block.id
  message.acknowledging_range_1_size = new Uint64BE(this.receivedBytes)
  message.data = block.data
  message.offset = new Uint64BE(block.start_byte)
  this.chicago.send_block()
  this.stream.write(message.toBuffer())
  this.maxBlockLength = constants.MESSAGE_BODY
}

MessageStream.prototype.canProcessMessage = function () {
  return this.incoming.length > 0
}

MessageStream.prototype.processMessage = function () {
  debug('processMessage')
  var message = this.incoming.shift()
  this.processAcknowledgments(message)
  this._processMessage(message)
}

MessageStream.prototype.processAcknowledgments = function (message) {
  debug('processAcknowledgements')
  if (_.has(this.outgoing, message.acknowledging_id)) {
    debug('processing acknowledgement')
    var block = this.outgoing[message.acknowledging_id]
    delete this.outgoing[message.acknowledging_id]
    this.chicago.acknowledgement(block.transmission_time)
  }
}

MessageStream.prototype.sendAcknowledgment = function (message) {
  debug('sendAcknowledgment')
  var reply = new Message()
  reply.id = this.nextMessageId()
  reply.acknowledging_id = message.id
  reply.acknowledging_range_1_size = new Uint64BE(this.receivedBytes)
  this.stream.write(reply.toBuffer())
}

MessageStream.prototype._processMessage = function (message) {
  debug('_processMessage')
  // console.log('message offset in stream: ' + Number(message.offset))
  // console.log('received bytes: ' + this.receivedBytes)
  debug('message data length:' + message.data_length)
  if (Number(message.offset) <= this.receivedBytes) {
    if (message.data_length > 1) {
      var ignoreBytes = this.receivedBytes - Number(message.offset)
      var data = message.data.slice(ignoreBytes)
      this.receivedBytes += data.length
      this.emit('data', data)
      this.sendAcknowledgment(message)
    }
  }
}

module.exports = MessageStream
