var UDPServer = require('./udp.js')
var nacl = require('tweetnacl')

var NB_BLOCKS = 10
var BLOCK_LENGTH = 1024

var server = new UDPServer()
var client = new UDPServer()

var source = Buffer(NB_BLOCKS * BLOCK_LENGTH)

for (var i = 0; i < NB_BLOCKS; i++) {
  var buffer = new Buffer(nacl.randomBytes(BLOCK_LENGTH))
  buffer.copy(source, i * BLOCK_LENGTH)
}

var currentBlock = 0
var messageStream

var destination = Buffer(0)

server.on('connect', function (rinfo, messageStream) {
  console.log('new connection to server')
  console.log(rinfo)
  messageStream.on('data', function (data) {
    console.log('DATA RECEIVED ON SERVER')
    destination = Buffer.concat([destination, data])
  })
  messageStream.on('end', function () {
    console.log('END RECEIVED ON SERVER')
    if (!Buffer.compare(source, destination)) {
      console.log('IDENTICAL BUFFER MATCH FOUND')
    } else {
      console.log('BUFFERS DO NOT MATCH')
    }
  })
  messageStream.on('finish', function () {
    console.log('FINISH RECEIVED ON SERVER')
  })
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

setTimeout(function () {
  messageStream = client.connect({address: '127.0.0.1', port: server.getPort()}, server.keypair.publicKey)
  messageStream.on('drain', function () {
    console.log('drain event')
    write()
  })
  messageStream.on('connect', function () {
    console.log('connect event')
    write()
  })
  messageStream.on('end', function () {
    console.log('END RECEIVED ON CLIENT')
  })
  messageStream.on('finish', function () {
    console.log('FINISH RECEIVED ON CLIENT')
  })
}, 1000)
