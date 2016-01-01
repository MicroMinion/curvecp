var dgram = require('dgram')
var inherits = require('inherits')
var _ = require('lodash')
var Duplex = require('stream').Duplex
var PacketStream = require('../src/packet-stream.js')
var MessageStream = require('../src/message-stream.js')
var nacl = require('tweetnacl')
var events = require('events')

var UDPServer = function () {
  this.socket = dgram.createSocket('udp4')
  this.streams = {}
  this._connectEvents()
  this.socket.bind(0)
  this.keypair = nacl.box.keyPair()
  events.EventEmitter.call(this)
}

inherits(UDPServer, events.EventEmitter)

UDPServer.prototype._connectEvents = function () {
  var server = this
  this.socket.on('close', function () {})
  this.socket.on('error', function (error) {
    console.log('ERROR')
    console.log(error)
  })
  this.socket.on('listening', function () {
    console.log('listening')
  })
  this.socket.on('message', function (msg, rinfo) {
    server.createStream(rinfo)
    server.streams[server.getKey(rinfo)].emit('data', msg)
  })
}

UDPServer.prototype.getKey = function (rinfo) {
  return rinfo.address + ':' + rinfo.port
}

UDPServer.prototype.connect = function (rinfo, serverKey) {
  this.streams[this.getKey(rinfo)] = new UDPStream(rinfo, this)
  var packetStream = new PacketStream({
    stream: this.streams[this.getKey(rinfo)],
    isServer: false,
    serverPublicKey: serverKey,
    clientPublicKey: this.keypair.publicKey,
    clientPrivateKey: this.keypair.secretKey
  })
  var messageStream = new MessageStream(packetStream)
  messageStream.on('connect', function () {
    console.log('CurveCP connection established')
  })
  messageStream.connect()
  return messageStream
}

UDPServer.prototype.getPort = function () {
  return this.socket.address().port
}

UDPServer.prototype.createStream = function (rinfo) {
  var server = this
  var key = this.getKey(rinfo)
  if (!_.has(this.streams, key)) {
    this.streams[key] = new UDPStream(rinfo, this)
    this.streams[key].on('close', function () {
      delete server.streams[key]
    })
    var packetStream = new PacketStream({
      stream: this.streams[key],
      isServer: true,
      serverPublicKey: this.keypair.publicKey,
      serverPrivateKey: this.keypair.secretKey
    })
    var messageStream = new MessageStream(packetStream)
    this.emit('connect', rinfo, messageStream)
  }
}

var UDPStream = function (rinfo, server) {
  this.address = rinfo.address
  this.port = rinfo.port
  this.server = server
  Duplex.call(this, {})
}

inherits(UDPStream, Duplex)

UDPStream.prototype.destroy = function () {
  this.error('Stream destroyed')
}
UDPStream.prototype._read = function (size) {}

UDPStream.prototype._write = function (chunk, encoding, done) {
  this.server.socket.send(chunk, 0, chunk.length, this.port, this.address, done)
}
UDPStream.prototype.error = function (errorMessage) {
  console.log('ERROR')
  this.emit('error', new Error(errorMessage))
  this.emit('close')
}

module.exports = UDPServer
