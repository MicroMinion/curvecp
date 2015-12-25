# CurveCP

Pure Javascript CurveCP protocol

The aim of this project is to implement the CurveCP protocol in pure javascript following the specification on [http://www.curvecp.org](http://www.curvecp.org) and interopable with the reference implementation.

This project currently implements the messaging format, encryption layer and congestion control algorithm but still needs to be tested, fine-tuned and improved upon. I don't consider this library to be usable yet.

## Quick start

See examples directory for an example client and server implementation.

You should create a PacketStream to start with (supplying public/private keys and other required info) and then wrap this stream in a MessageStream() object.

Clients should then execute the connect() method on MessageStream object.

## Design

This implementation makes a clean split between:

* The congestion control algorithm (chicago.js)
* The crypto layer (packet-stream.js)
* The messaging layer (message-stream.js)
* The actual networking transport. To follow the reference implementation, you should use UDP as a networking transport (like illustrated in examples section) but in principle, the packet-stream can be connected to any networking transport. I'm also using it with different types of transports in my own projects.

## Inspiration

* The reference implementation/specification at [http://www.curvecp.org](http://www.curvecp.org)
* The description of the Chicago algorithm by Matthew Dempsky at [http://shinobi.dempsky.org/~matthew/curvecp/chicago.html](http://shinobi.dempsky.org/~matthew/curvecp/chicago.html)
* The libcurvecpr project at [https://github.com/impl/libcurvecpr](https://github.com/impl/libcurvecpr) for inspiration on a clean split between the messaging layer and congestion control aglorithm.
