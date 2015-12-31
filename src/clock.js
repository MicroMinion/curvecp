var constants = require('./constants.js')

var Clock = function (input) {
  this.seconds = input[0]
  /* always less than 10^9 */
  this.nanoseconds = input[1]
}

Clock.prototype.clone = function () {
  return new Clock([this.seconds, this.nanoseconds])
}

Clock.prototype.add = function (nanoseconds) {
  var seconds_to_add = Number(Number(nanoseconds / constants.SECOND).toString().split('.')[0])
  var nanoseconds_to_add = nanoseconds % constants.SECOND
  if (nanoseconds_to_add > constants.SECOND) {
    seconds_to_add += 1
    nanoseconds_to_add -= constants.SECOND
  }
  this.seconds += seconds_to_add
  this.nanoseconds += nanoseconds_to_add
}

Clock.prototype.subtract = function (clock) {
  var seconds = this.seconds - clock.seconds
  if (seconds > constants.MAX_SECONDS_IN_DURATION) {
    seconds = constants.MAX_SECONDS_IN_DURATION
  }
  var nanoseconds = this.nanoseconds - clock.nanoseconds
  var result = (seconds * constants.SECOND) + nanoseconds
  if (result < 0) {
    throw new Error('Clock subtraction should not be negative')
  }
  return result
}

/*
 * @return Number 1 if we are larger than clock, -1 if smaller, 0 if equal
 */
Clock.prototype.compare = function (clock) {
  if (this.seconds > clock.seconds) {
    return 1
  } else if (this.seconds === clock.seconds) {
    if (this.nanoseconds > clock.nanoseconds) {
      return 1
    } else if (this.nanoseconds === clock.nanoseconds) {
      return 0
    } else {
      return -1
    }
  } else {
    return -1
  }
}

module.exports = Clock
