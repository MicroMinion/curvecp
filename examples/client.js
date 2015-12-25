var dgram = require('dgram')
var PacketStream = require('../lib/packet-stream.js')
var MessageStream = require('../lib/message-stream.js')
var nacl = require('tweetnacl')
var events = require('events')
var inherits = require('inherits')

var keypair = nacl.box.keyPair()

var UDPStream = function () {
  var stream = this
  this.socket = dgram.createSocket('udp4')
  this.socket.bind(0)
  this.socket.on('close', function () {
    stream.emit('close')
  })
  this.socket.on('error', function (error) {
    stream.emit('error', error)
  })
  this.socket.on('listening', function () {
    console.log('listening')
    messageStream.connect()
  })
  this.socket.on('message', function (msg, rinfo) {
    stream.emit('data', msg)
  })
  events.EventEmitter.call(this)
}

inherits(UDPStream, events.EventEmitter)

UDPStream.prototype.destroy = function () {
  this.socket.close()
}

UDPStream.prototype.write = function (buffer) {
  var callback_ = function (err) {
    console.log('callback')
    console.log(err)
  }
  this.socket.send(buffer, 0, buffer.length, process.env.SERVER_PORT, process.env.SERVER_ADDRESS, callback_)
}

var connection = new UDPStream()

var packetStream = new PacketStream({
  stream: connection,
  is_server: false,
  serverName: process.env.SERVER_NAME,
  serverPublicKey: nacl.util.decodeBase64(process.env.SERVER_KEY),
  clientPublicKey: keypair.publicKey,
  clientPrivateKey: keypair.secretKey
})

var messageStream = new MessageStream(packetStream)

messageStream.on('connect', function () {
  console.log('connected')
  messageStream.write('test\n')
})
messageStream.on('data', function (data) {
  console.log('data')
  console.log(data)
})

messageStream.on('error', function (error) {
  console.log('error')
  console.log(error)
})

messageStream.on('close', function () {
  console.log('close')
})
