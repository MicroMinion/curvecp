var UDPServer = require('./udp.js')

var server = new UDPServer()

var client = new UDPServer()

setTimeout(function () {
  client.connect({address: '127.0.0.1', port: server.getPort()}, server.keypair.publicKey)
}, 1000)
