var net = require('net-udp')
var PacketStream = require('../src/packet-stream.js')
var MessageStream = require('../src/message-stream.js')
var nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')
var winston = require('winston')
var winstonWrapper = require('winston-meta-wrapper')

var logger = new winston.Logger({
  transports: [
    new winston.transports.Console({
      level: 'debug',
      timestamp: true,
      logstash: false
    })
  ]
})
logger = winstonWrapper(logger)

var keypair = nacl.box.keyPair()
var connection = new net.Socket()

var packetStream = new PacketStream({
  stream: connection,
  logger: logger,
  is_server: false,
  serverName: process.env.SERVER_HOSTNAME,
  clientPublicKey: keypair.publicKey,
  clientPrivateKey: keypair.secretKey
})

var messageStream = new MessageStream({
  stream: packetStream,
  logger: logger
})

messageStream.on('connect', function () {
  console.log('messagestream connected')
})
messageStream.on('data', function (data) {
  console.log('data')
  console.log(data.toString())
})

messageStream.on('error', function (error) {
  console.log('error')
  console.log(error)
})

messageStream.on('close', function () {
  console.log('close')
})

var boxId = nacl.util.encodeBase64(new Uint8Array(new Buffer(process.env.SERVER_KEY, 'hex')))
messageStream.connect(boxId, {
  addresses: [process.env.SERVER_IP],
  port: parseInt(process.env.SERVER_PORT, 10)
})
