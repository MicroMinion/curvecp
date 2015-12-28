var Uint64BE = require('int64-buffer').Uint64BE
var assert = require('assert')

var MAX_MESSAGE_SIZE = 1088
var MINIMAL_PADDING = 16
var HEADER_SIZE = 48

var STOP_SUCCESS = 2048
var STOP_FAILURE = 4096
var STOP = STOP_SUCCESS + STOP_FAILURE

var Message = function () {
  this.id = 0
  this.acknowledging_id = 0
  this.acknowledging_range_1_size = 0
  this.acknowledging_range_12_gap = 0
  this.acknowledging_range_2_size = 0
  this.acknowledging_range_23_gap = 0
  this.acknowledging_range_3_size = 0
  this.acknowledging_range_34_gap = 0
  this.acknowledging_range_4_size = 0
  this.acknowledging_range_45_gap = 0
  this.acknowledging_range_5_size = 0
  this.acknowledging_range_56_gap = 0
  this.acknowledging_range_6_size = 0
  this.success = false
  this.failure = false
}

Message.prototype.fromBuffer = function (buf) {
  this.id = buf.readUInt32BE()
  this.acknowledging_id = buf.readUInt32BE(4)
  this.acknowledging_range_1_size = new Uint64BE(buf, 8)
  this.acknowledging_range_12_gap = buf.readUInt32BE(16)
  this.acknowledging_range_2_size = buf.readUInt16BE(20)
  this.acknowledging_range_23_gap = buf.readUInt16BE(22)
  this.acknowledging_range_3_size = buf.readUInt16BE(24)
  this.acknowledging_range_34_gap = buf.readUInt16BE(26)
  this.acknowledging_range_4_size = buf.readUInt16BE(28)
  this.acknowledging_range_45_gap = buf.readUInt16BE(30)
  this.acknowledging_range_5_size = buf.readUInt16BE(32)
  this.acknowledging_range_56_gap = buf.readUInt16BE(34)
  this.acknowledging_range_6_size = buf.readUInt16BE(36)
  this.flags = buf.readUInt16BE(38)
  this.offset = new Uint64BE(buf, 40)
  this.data_length = this.flags - (this.flags & STOP)
  this.data = buf.slice(buf.length - this.data_length)
}

Message.prototype.toBuffer = function () {
  var messageSize = HEADER_SIZE + MINIMAL_PADDING
  if (this.data !== undefined && this.data.length > 0) {
    messageSize += this.data.length + (this.data.length % 16)
  }
  assert(messageSize <= MAX_MESSAGE_SIZE)
  var message = new Buffer(messageSize)
  message.fill(0)
  message.writeUInt32BE(this.id)
  message.writeUInt32BE(this.acknowledging_id, 4)
  this.acknowledging_range_1_size.toBuffer().copy(message, 8)
  message.writeUInt32BE(this.acknowledging_range_12_gap, 16)
  message.writeUInt16BE(this.acknowledging_range_2_size, 20)
  message.writeUInt16BE(this.acknowledging_range_23_gap, 22)
  message.writeUInt16BE(this.acknowledging_range_3_size, 24)
  message.writeUInt16BE(this.acknowledging_range_34_gap, 26)
  message.writeUInt16BE(this.acknowledging_range_4_size, 28)
  message.writeUInt16BE(this.acknowledging_range_45_gap, 30)
  message.writeUInt16BE(this.acknowledging_range_5_size, 32)
  message.writeUInt16BE(this.acknowledging_range_56_gap, 34)
  message.writeUInt16BE(this.acknowledging_range_6_size, 36)
  if (this.data !== undefined) {
    this.flags = this.data.length
  } else {
    this.flags = 0
  }
  if (this.success) {
    this.flags += STOP_SUCCESS
  } else if (this.failure) {
    this.flags += STOP_FAILURE
  }
  message.writeUInt16BE(this.flags, 38)
  if (this.data && this.data.length > 0) {
    this.offset.toBuffer().copy(message, 40)
    this.data.copy(message, messageSize - this.data.length)
  }
  return message
}

module.exports = Message
