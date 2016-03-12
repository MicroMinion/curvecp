var UDPServer = require('./udp.js')
var nacl = require('tweetnacl')

var NB_BLOCKS = 100
var BLOCK_LENGTH = 1024

var server = new UDPServer()
var client = new UDPServer()

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

server.on('connect', function (rinfo, messageStream) {
  console.log('new connection to server')
  console.log(rinfo)
  /* messageStream.on('connect', function () {
    writeServer()
  })
  messageStream.on('drain', function () {
    writeServer()
  })
  */
  messageStream.on('data', function (data) {
    console.log('DATA RECEIVED ON SERVER')
    destination = Buffer.concat([destination, data])
  })
  messageStream.on('end', function () {
    console.log('END RECEIVED ON SERVER')
    console.log(nacl.util.encodeBase64(source))
    console.log(nacl.util.encodeBase64(destination))
    if (!Buffer.compare(source, destination)) {
      console.log('IDENTICAL BUFFER MATCH FOUND')
    } else {
      console.log('BUFFERS DO NOT MATCH')
    }
  })
  messageStream.on('finish', function () {
    console.log('FINISH RECEIVED ON SERVER')
  })
  messageStreamServer = messageStream
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

setTimeout(function () {
  messageStream = client.connect({address: '127.0.0.1', port: server.getPort()}, server.keypair.publicKey)
  messageStream.on('drain', function () {
    console.log('drain event')
  // write()
  })
  messageStream.on('connect', function () {
    console.log('connect event')
    messageStream.write(new Buffer('test'))
  // write()
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
    console.log(sourceServer.length)
    console.log(destinationClient.length)
    console.log(nacl.util.encodeBase64(sourceServer))
    console.log(nacl.util.encodeBase64(destinationClient))
    if (!Buffer.compare(sourceServer, destinationClient)) {
      console.log('IDENTICAL BUFFER MATCH FOUND ON CLIENT')
    } else {
      console.log('BUFFERS DO NOT MATCH ON CLIENT')
    }
  })
}, 1000)
