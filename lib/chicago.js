var hrtime = require('browser-process-hrtime')
var nacl = require('tweetnacl')
var debug = require('debug')('curvecp:chicago')
var NanoTimer = require('nanotimer')

var MILLISECOND = 1000000
var SECOND = MILLISECOND * 1000

var Chicago = function () {
  this.clock = null
  this.refresh_clock()
  /* Smoothed Round Trip Time (SRTT) */
  this.rtt_average = 0
  /* RTTVAR */
  this.rtt_deviation = 0
  this.rtt_highwater = 0
  this.rtt_lowwater = 0
  /* RTO */
  this.rtt_timeout = SECOND
  this.seen_recent_high = false
  this.seen_recent_low = false
  this.seen_older_high = false
  this.seen_older_low = false
  this.rtt_phase = 0
  /* Sending rate (nanosecond interval between blocks) */
  this.nsecperblock = SECOND
  this.lastblocktime = 0
  this.lastspeedadjustment = this.clock
  this.lastedge = 0
  this.lastdoubling = 0
  this.lastpanic = 0
  this.timer = new NanoTimer()
  this._setTimeout()
  this.timerDisabled = false
}

Chicago.prototype.setTimeout = function (func) {
  this.timeoutCallback = func
}

Chicago.prototype.disableTimer = function () {
  this.timerDisabled = true
}

Chicago.prototype.enableTimer = function () {
  this.timerDisabled = false
  this._setTimeout()
}

Chicago.prototype._timeoutCallback = function () {
  if (this.timeoutCallback) {
    this.timeoutCallback()
  }
  if (!this.timerDisabled) {
    this._setTimeout()
  }
}

Chicago.prototype._setTimeout = function () {
  this.timer.setTimeout(this._timeoutCallback.bind(this), [], this.nsecperblock.toString() + 'n')
}

Chicago.prototype.refresh_clock = function () {
  var clock = hrtime()
  this.clock = clock[0] * 1000000 + clock[1]
}

Chicago.prototype.getClock = function () {
  this.refresh_clock()
  return this.clock
}

Chicago.prototype.send_block = function (time) {
  this.lastblocktime = time
}

Chicago.prototype.retransmission = function () {
  this.refresh_clock()
  if (this.clock > this.lastpanic + 4 * this.rtt_timeout) {
    this.nsecperblock = this.nsecperblock * 2
    this.lastpanic = this.clock
    this.lastedge = this.clock
  }
}

Chicago.prototype.isBlockTimedOut = function (transmission_time) {
  this.refresh_clock()
  return transmission_time + this.rtt_timeout < this.clock
}

Chicago.prototype.randommod = function (n) {
  var result = 0
  if (n <= 1) {
    return 0
  }
  var randomBytes = nacl.randomBytes(32)
  for (var j = 0; j < 32; j++) {
    result = (result * 256 + Number(randomBytes[j]) % n)
  }
  return result
}

Chicago.prototype.acknowledgement = function (original_blocktime) {
  debug('acknowledgement')
  this.refresh_clock()
  var rtt = this.clock - original_blocktime
  var rtt_delta
  if (!this.rtt_average) {
    this.nsecperblock = rtt
    this.rtt_average = rtt
    this.rtt_deviation = rtt / 2
    this.rtt_highwater = rtt
    this.rtt_lowwater = rtt
  }
  /* Jacobon's retransmission timeout calculation */
  rtt_delta = rtt - this.rtt_average
  this.rtt_average += rtt_delta / 8
  if (rtt_delta < 0) {
    rtt_delta = -rtt_delta
  }
  this.rtt_deviation += rtt_delta / 4
  this.rtt_timeout = this.rtt_average + 4 * this.rtt_deviation
  /* adjust for delayed acks with anti-spiking */
  this.rtt_timeout += 8 * this.nsecperblock
  /* recognizing top and bottom of congestion cycle */
  rtt_delta = rtt - this.rtt_highwater
  this.rtt_highwater += rtt_delta / 1024
  rtt_delta = rtt - this.rtt_lowwater
  if (rtt_delta > 0) {
    this.rtt_lowwater += rtt_delta / 8192
  } else {
    this.rtt_lowwater += rtt_delta / 256
  }
  if (this.rtt_average > this.rtt_highwater + 5 * MILLISECOND) {
    this.rtt_seenrecenthigh = true
  } else if (this.rtt_average < this.rtt_lowwater) {
    this.rtt_seenrecentlow = true
  }
  if (this.clock >= this.lastspeedadjustment + 16 * this.nsecperblock) {
    if (this.clock - this.lastspeedadjustment > 10 * SECOND) {
      this.nsecperblock = SECOND /* slow restart */
      this.nsecperblock += this.randommod(this.nsecperblock / 8)
    }
    this.lastspeedadjustment = this.clock
    if (this.nsecperblock >= 131072) {
      /* additive increase: adjust 1/N by a constant c */
      /* rtt-fair additive increase: adjust 1/N by a constant c every nanosecond */
      /* approximation: adjust 1/N by cN every N nanoseconds */
      /* i.e., N <- 1/(1/N + cN) = N/(1 + cN^2) every N nanoseconds */
      if (this.nsecperblock < 16777216) {
        /* N/(1+cN^2) approx N - cN^3 */
        var u = this.nsecperblock / 131072
        this.nsecperblock -= u * u * u
      } else {
        var d = this.nsecperblock
        this.nsecperblock = d / (1 + d * d / 2251799813685248.0)
      }
    }
    if (this.rtt_phase === 0) {
      if (this.rtt_seenolderhigh) {
        this.rtt_phase = 1
        this.lastedge = this.clock
        this.nsecperblock += this.randommod(this.nsecperblock / 4)
      } else {
        if (this.rtt_seenolderlow) {
          this.rtt_phase = 0
        }
      }
      this.rtt_seenolderhigh = this.rtt_seenrecenthigh
      this.rtt_seenolderlow = this.rtt_seenrecentlow
      this.rtt_seenrecenthigh = false
      this.rtt_seenrecentlow = false
    }
  }
  while (true) {
    if (this.clock - this.lastedge < 60 * SECOND) {
      if (this.clock < this.lastdoubling + 4 * this.nsecperblock + 64 * this.rtt_timeout + 5 * SECOND) {
        break
      }
    } else {
      if (this.clock < this.lastdoubling + 4 * this.nsecperblock + 2 * this.rtt_timeout) {
        break
      }
    }
    if (this.nsecperblock <= 65535) {
      break
    }
    this.nsecperblock /= 2
    this.lastdoubling = this.clock
    if (this.lastedge) {
      this.lastedge = this.clock
    }
  }
}

module.exports = Chicago
