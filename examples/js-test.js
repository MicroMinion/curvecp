var net = require('net-udp')
var nacl = require('tweetnacl')
var PacketStream = require('../src/packet-stream.js')
var MessageStream = require('../src/message-stream.js')
nacl.util = require('tweetnacl-util')

var NB_BLOCKS = 100
var BLOCK_LENGTH = 1024

var server = net.createServer()
var client = new net.Socket()

var serverKeyPair = nacl.box.keyPair()
var clientKeyPair = nacl.box.keyPair()

var source = Buffer(NB_BLOCKS * BLOCK_LENGTH)
var sourceServer = Buffer(NB_BLOCKS * BLOCK_LENGTH)

for (var i = 0; i < NB_BLOCKS; i++) {
  var buffer = new Buffer(nacl.randomBytes(BLOCK_LENGTH))
  buffer.copy(source, i * BLOCK_LENGTH)
}

for (i = 0; i < NB_BLOCKS; i++) {
  buffer = new Buffer(nacl.randomBytes(BLOCK_LENGTH))
  buffer.copy(sourceServer, i * BLOCK_LENGTH)
}

var currentBlock = 0
var currentBlockServer = 0
var messageStream
var messageStreamServer

var destination = Buffer(0)
var destinationClient = Buffer(0)

server.on('connection', function (socket) {
  console.log('new connection to server')
  var packetStream = new PacketStream({
    stream: socket,
    isServer: true,
    serverPublicKey: serverKeyPair.publicKey,
    serverPrivateKey: serverKeyPair.secretKey
  })
  messageStreamServer = new MessageStream({
    stream: packetStream
  })
  messageStreamServer.on('data', function (data) {
    console.log('DATA RECEIVED ON SERVER')
    destination = Buffer.concat([destination, data])
  })
  messageStreamServer.on('end', function () {
    console.log('END RECEIVED ON SERVER')
    // console.log(nacl.util.encodeBase64(source))
    // console.log(nacl.util.encodeBase64(destination))
    if (!Buffer.compare(source, destination)) {
      console.log('IDENTICAL BUFFER MATCH FOUND')
    } else {
      console.log('BUFFERS DO NOT MATCH')
    }
  })
  messageStreamServer.on('finish', function () {
    console.log('FINISH RECEIVED ON SERVER')
    process.exit(0)
  })
  writeServer()
})

var write = function () {
  var canContinue = currentBlock < NB_BLOCKS
  while (canContinue) {
    // console.log(currentBlock)
    var buffer = new Buffer(BLOCK_LENGTH)
    source.copy(buffer, 0, currentBlock * BLOCK_LENGTH, (currentBlock + 1) * BLOCK_LENGTH)
    var result = messageStream.write(buffer, 'buffer', function (err) {
      if (err) {
        console.log('ERROR SENDING BLOCK: ' + err)
      } else {
        // console.log('SUCCESS SENDING BLOCK')
      }
    })
    currentBlock += 1
    canContinue = result && currentBlock < NB_BLOCKS
    if (currentBlock === NB_BLOCKS) {
      messageStream.end()
    }
  }
}

var writeServer = function () {
  var canContinue = currentBlockServer < NB_BLOCKS
  while (canContinue) {
    // console.log(currentBlock)
    var buffer = new Buffer(BLOCK_LENGTH)
    sourceServer.copy(buffer, 0, currentBlockServer * BLOCK_LENGTH, (currentBlockServer + 1) * BLOCK_LENGTH)
    var result = messageStreamServer.write(buffer, 'buffer', function (err) {
      if (err) {
        console.log('ERROR SENDING BLOCK: ' + err)
      } else {
        // console.log('SUCCESS SENDING BLOCK')
      }
    })
    currentBlockServer += 1
    canContinue = result && currentBlockServer < NB_BLOCKS
    if (currentBlockServer === NB_BLOCKS) {
      messageStreamServer.end()
    }
  }
}

server.on('listening', function () {
  console.log('server listening')
  var packetStream = new PacketStream({
    stream: client,
    isServer: false,
    serverPublicKey: serverKeyPair.publicKey,
    clientPublicKey: clientKeyPair.publicKey,
    clientPrivateKey: clientKeyPair.secretKey
  })
  messageStream = new MessageStream({
    stream: packetStream
  })
  client.on('data', function (msg) {
    console.log('message received on client')
    console.log('length ' + msg.length)
  })
  messageStream.on('drain', function () {
    console.log('drain event')
    write()
  })
  messageStream.on('connect', function () {
    console.log('connect event')
    // messageStream.write(new Buffer('test'))
    write()
  })
  messageStream.on('finish', function () {
    console.log('FINISH RECEIVED ON CLIENT')
  })
  messageStream.on('data', function (data) {
    console.log('DATA RECEIVED ON CLIENT')
    destinationClient = Buffer.concat([destinationClient, data])
  })
  messageStream.on('end', function () {
    console.log('END RECEIVED ON CLIENT')
    console.log('sourceServer length' + sourceServer.length)
    console.log('destinationClient length' + destinationClient.length)
    // console.log(nacl.util.encodeBase64(sourceServer))
    // console.log(nacl.util.encodeBase64(destinationClient))
    if (!Buffer.compare(sourceServer, destinationClient)) {
      console.log('IDENTICAL BUFFER MATCH FOUND ON CLIENT')
    } else {
      console.log('BUFFERS DO NOT MATCH ON CLIENT')
    }
  })
  messageStream.connect(
    nacl.util.encodeBase64(serverKeyPair.publicKey), {
      udp: {
        addresses: ['127.0.0.1'],
        port: server.address().port
      }
    })
  setTimeout(function () {
    console.log('remotePort ' + client.remotePort)
  }, 500)
})

server.listen()
