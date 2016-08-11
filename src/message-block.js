var Block = function () {
  /* Start byte in stream */
  this.startByte = null
  /* Last transmission time of block */
  this.transmissionTime = 0
  /* Number of transmission attempts of this block */
  this.transmissions = 0
  /* ID of last message sending this block */
  this.id = null
  /* Actual block data (buffer) */
  this.data = null
  /* Flags */
  this.stop_success = false
  this.stop_failure = false
}

Block.prototype.includedIn = function (size) {
  return this.startByte + this.data.length <= size
}

module.exports = Block
