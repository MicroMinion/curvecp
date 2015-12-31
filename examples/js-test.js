var UDPServer = require('./udp.js')
var nacl = require('tweetnacl')

var NB_BLOCKS = 2
var BLOCK_LENGTH = 1024

var server = new UDPServer()
var client = new UDPServer()

var source = Buffer(NB_BLOCKS * BLOCK_LENGTH)

for (var i = 0; i < NB_BLOCKS; i++) {
  var buffer = new Buffer(nacl.randomBytes(BLOCK_LENGTH))
  buffer.copy(source, i * BLOCK_LENGTH)
}

var destination = Buffer(0)

server.on('connect', function (rinfo, messageStream) {
  console.log('new connection to server')
  console.log(rinfo)
  messageStream.on('data', function (data) {
    console.log('new data: ' + data.length)
    console.log('data retrieved: ' + destination.length)
    destination = Buffer.concat([destination, data])
    if (!Buffer.compare(source, destination)) {
      console.log('IDENTICAL BUFFER MATCH FOUND')
      process.exit(0)
    }
  })
})

setTimeout(function () {
  var messageStream = client.connect({address: '127.0.0.1', port: server.getPort()}, server.keypair.publicKey)
  messageStream.on('connect', function () {
    for (var i = 0; i < NB_BLOCKS; i++) {
      var buffer = new Buffer(nacl.randomBytes(BLOCK_LENGTH))
      buffer.copy(source, i * BLOCK_LENGTH)
      messageStream.write(source, 'buffer', function (err) {
        console.log('BLOCK ' + i)
        if (err) {
          console.log('ERROR: ' + err)
        } else {
          console.log('  SUCCESS')
        }
      })
    }
  })
}, 1000)
