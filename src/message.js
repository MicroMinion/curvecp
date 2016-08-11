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
  this.id = buf.readUInt32LE()
  this.acknowledging_id = buf.readUInt32LE(4)
  this.acknowledging_range_1_size = new Buffer(8)
  buf.copy(this.acknowledging_range_1_size, 0, 8)
  this.acknowledging_range_1_size.reverse()
  this.acknowledging_range_1_size = Number(new Uint64BE(this.acknowledging_range_1_size))
  if (this.acknowledging_range_1_size > Number.MAX_SAFE_INTEGER) {
    throw new Error('Acknowledging range exceeds maximum safe integer')
  }
  this.acknowledging_range_12_gap = buf.readUInt32LE(16)
  this.acknowledging_range_2_size = buf.readUInt16LE(20)
  this.acknowledging_range_23_gap = buf.readUInt16LE(22)
  this.acknowledging_range_3_size = buf.readUInt16LE(24)
  this.acknowledging_range_34_gap = buf.readUInt16LE(26)
  this.acknowledging_range_4_size = buf.readUInt16LE(28)
  this.acknowledging_range_45_gap = buf.readUInt16LE(30)
  this.acknowledging_range_5_size = buf.readUInt16LE(32)
  this.acknowledging_range_56_gap = buf.readUInt16LE(34)
  this.acknowledging_range_6_size = buf.readUInt16LE(36)
  this.flags = buf.readUInt16LE(38)
  this.offset = new Buffer(8)
  buf.copy(this.offset, 0, 40)
  this.offset.reverse()
  this.offset = Number(new Uint64BE(this.offset))
  if (this.offset > Number.MAX_SAFE_INTEGER) {
    throw new Error('Offset exceeds maximum safe integer')
  }
  this.data_length = this.flags - (this.flags & STOP)
  this.success = Boolean((this.flags - this.data_length) & STOP_SUCCESS)
  this.failure = Boolean((this.flags - this.data_length) & STOP_FAILURE)
  this.data = buf.slice(buf.length - this.data_length)
}

Message.prototype.isAcknowledged = function (startByte, length) {
  return this._inRange1(startByte, length) ||
    this._inRange2(startByte, length) ||
    this._inRange3(startByte, length) ||
    this._inRange4(startByte, length) ||
    this._inRange5(startByte, length) ||
    this._inRange6(startByte, length)
}

Message.prototype._inRange1 = function (startByte, length) {
  return startByte + length <= this.acknowledging_range_1_size
}

Message.prototype._inRange2 = function (startByte, length) {
  return startByte >= this._range2Start() && length <= this.acknowledging_range_2_size
}

Message.prototype._inRange3 = function (startByte, length) {
  return startByte >= this._range3Start() && length <= this.acknowledging_range_3_size
}

Message.prototype._inRange4 = function (startByte, length) {
  return startByte >= this._range4Start() && length <= this.acknowledging_range_4_size
}

Message.prototype._inRange5 = function (startByte, length) {
  return startByte >= this._range5Start() && length <= this.acknowledging_range_5_size
}

Message.prototype._inRange6 = function (startByte, length) {
  return startByte >= this._range6Start() && length <= this.acknowledging_range_6_size
}

Message.prototype._range2Start = function () {
  return this.acknowledging_range_1_size + this.acknowledging_range_12_gap
}

Message.prototype._range3Start = function () {
  return this._range2Start() + this.acknowledging_range_2_size + this.acknowledging_range_23_gap
}

Message.prototype._range4Start = function () {
  return this._range3Start() + this.acknowledging_range_3_size + this.acknowledging_range_34_gap
}

Message.prototype._range5Start = function () {
  return this._range4Start() + this.acknowledging_range_4_size + this.acknowledging_range_45_gap
}

Message.prototype._range6Start = function () {
  return this._range5Start() + this.acknowledging_range_5_size + this.acknowledging_range_56_gap
}

Message.prototype.toBuffer = function () {
  var messageSize = HEADER_SIZE + MINIMAL_PADDING
  if (this.data !== undefined && this.data.length > 0) {
    if (this.data.length % 16) {
      messageSize += this.data.length + 16 - (this.data.length % 16)
    } else {
      messageSize += this.data.length
    }
  }
  assert(messageSize <= MAX_MESSAGE_SIZE)
  var message = new Buffer(messageSize)
  message.fill(0)
  message.writeUInt32LE(this.id)
  message.writeUInt32LE(this.acknowledging_id, 4)
  new Uint64BE(this.acknowledging_range_1_size).toBuffer().reverse().copy(message, 8)
  message.writeUInt32LE(this.acknowledging_range_12_gap, 16)
  message.writeUInt16LE(this.acknowledging_range_2_size, 20)
  message.writeUInt16LE(this.acknowledging_range_23_gap, 22)
  message.writeUInt16LE(this.acknowledging_range_3_size, 24)
  message.writeUInt16LE(this.acknowledging_range_34_gap, 26)
  message.writeUInt16LE(this.acknowledging_range_4_size, 28)
  message.writeUInt16LE(this.acknowledging_range_45_gap, 30)
  message.writeUInt16LE(this.acknowledging_range_5_size, 32)
  message.writeUInt16LE(this.acknowledging_range_56_gap, 34)
  message.writeUInt16LE(this.acknowledging_range_6_size, 36)
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
  message.writeUInt16LE(this.flags, 38)
  if (this.data && this.data.length > 0) {
    var offset = new Uint64BE(this.offset).toBuffer().reverse()
    offset.copy(message, 40, 0)
    this.data.copy(message, messageSize - this.data.length)
  }
  return message
}

module.exports = Message
