var hrtime = require('browser-process-hrtime')
var winston = require('winston')
var winstonWrapper = require('winston-meta-wrapper')
var NanoTimer = require('nanotimer')
var Clock = require('./clock.js')
var constants = require('./constants.js')
var utils = require('./utils.js')

var Chicago = function (options) {
  if (!options) {
    options = {}
  }
  if (!options.logger) {
    options.logger = winston
  }
  this._log = winstonWrapper(options.logger)
  this._log.addMeta({
    module: 'curvecp-chicago'
  })
  /* Clock instance */
  this.clock = new Clock([0, 0])
  this._refresh_clock()
  /* Smoothed Round Trip Time (SRTT) in nanoseconds */
  this.rtt_average = 0
  /* RTTVAR  in nanoseconds */
  this.rtt_deviation = 0
  this.rtt_highwater = 0
  this.rtt_lowwater = 0
  /* RTO in nanoseconds */
  this.rtt_timeout = constants.SECOND
  this.seen_recent_high = false
  this.seen_recent_low = false
  this.seen_older_high = false
  this.seen_older_low = false
  this.rtt_phase = 0
  /* Sending rate (nanosecond interval between blocks) */
  this.nsecperblock = constants.SECOND
  /* Clock instance */
  this.lastblocktime
  /* Clock instance */
  this.lastspeedadjustment = this.clock
  /* Clock instance */
  this.lastedge = new Clock([0, 0])
  /* Clock instance */
  this.lastdoubling = new Clock([0, 0])
  /* Clock instance */
  this.lastpanic = new Clock([0, 0])
  this.timer = new NanoTimer()
  this._set_timeout()
  this.timer_disabled = false
}

/* TIMER */

Chicago.prototype.set_timeout = function (func) {
  this.timeout_callback = func
}

Chicago.prototype.disable_timer = function () {
  this.timer_disabled = true
}

Chicago.prototype.enable_timer = function () {
  if (this.timer_disabled) {
    this.timer_disabled = false
    this._set_timeout()
  }
}

Chicago.prototype._timeout_callback = function () {
  if (this.timeout_callback) {
    this.timeout_callback()
  }
  if (!this.timer_disabled) {
    this._set_timeout()
  }
}

Chicago.prototype._set_timeout = function () {
  this._log.debug('_set_timeout ' + this.nsecperblock)
  this.timer.setTimeout(this._timeout_callback.bind(this), [], this.nsecperblock.toString() + 'n')
}

/* CLOCK */

Chicago.prototype._refresh_clock = function () {
  this.clock = new Clock(hrtime())
}

Chicago.prototype.get_clock = function () {
  this._refresh_clock()
  return this.clock.clone()
}

/* SEND BLOCK */

Chicago.prototype.send_block = function () {
  this._refresh_clock()
  this.lastblocktime = this.clock.clone()
}

/* RETRANSMISSION */

Chicago.prototype.block_is_timed_out = function (transmissionTime) {
  this._refresh_clock()
  var clock = transmissionTime.clone()
  clock.add(this.rtt_timeout)
  var compareResult = clock.compare(this.clock)
  if (compareResult === -1) {
    return true
  } else {
    return false
  }
}

Chicago.prototype.retransmission = function () {
  this._refresh_clock()
  var clock = this.lastpanic.clone()
  clock.add(4 * this.rtt_timeout)
  var compareResult = this.clock.compare(clock)
  if (compareResult === 1) {
    this._halve_transmission_rate()
  }
}

Chicago.prototype._halve_transmission_rate = function () {
  this.nsecperblock = utils.safeIntegerMultiplication(this.nsecperblock, 2)
  this.lastpanic = this.clock.clone()
  this.lastedge = this.clock.clone()
}

/* MESSAGE ACKNOWLEDGEMENT */

Chicago.prototype.acknowledgement = function (originalBlocktime) {
  this._refresh_clock()
  var rtt = this._initialize_rtt(originalBlocktime)
  this._jacobson_retransmission_timeout(rtt)
  this._compensate_delayed_acks()
  this._track_watermarks(rtt)
  this._check_for_watermarks()
  if (this._adjustment_cycle_has_completed()) {
    this._reinitialize_lastspeedadjustment()
    this._apply_additive_increase()
    this._phase_events()
    this._update_seen_watermarks()
  }
  this._apply_rate_doubling()
}

Chicago.prototype._initialize_rtt = function (originalBlocktime) {
  var rtt = this.clock.subtract(originalBlocktime)
  if (!this.rtt_average) {
    this.nsecperblock = rtt
    this.rtt_average = rtt
    this.rtt_deviation = rtt / 2
    this.rtt_highwater = rtt
    this.rtt_lowwater = rtt
  }
  return rtt
}

Chicago.prototype._jacobson_retransmission_timeout = function (rtt) {
  /* Jacobon's retransmission timeout calculation */
  var rttDelta = rtt - this.rtt_average
  this.rtt_average = utils.safeIntegerAddition(this.rtt_average, rttDelta / 8)
  if (rttDelta < 0) {
    rttDelta = -rttDelta
  }
  rttDelta -= this.rtt_deviation
  this.rtt_deviation = utils.safeIntegerAddition(this.rtt_deviation, rttDelta / 4)
  this.rtt_timeout = utils.safeIntegerAddition(this.rtt_average, utils.safeIntegerMultiplication(this.rtt_deviation, 4))
}

Chicago.prototype._compensate_delayed_acks = function () {
  /* adjust for delayed acks with anti-spiking */
  this.rtt_timeout = utils.safeIntegerAddition(this.rtt_timeout, 8 * this.nsecperblock)
}

Chicago.prototype._track_watermarks = function (rtt) {
  /* Adjust high watermark of congestion cycle */
  var rttDelta = rtt - this.rtt_highwater
  this.rtt_highwater = utils.safeIntegerAddition(this.rtt_highwater, rttDelta / 1024)
  /* Adjust low watermark of congestion cycle */
  rttDelta = rtt - this.rtt_lowwater
  if (rttDelta > 0) {
    this.rtt_lowwater = utils.safeIntegerAddition(this.rtt_lowwater, rttDelta / 8192)
  } else {
    this.rtt_lowwater = utils.safeIntegerAddition(this.rtt_lowwater, rttDelta / 256)
  }
}

Chicago.prototype._check_for_watermarks = function () {
  if (this.rtt_average > utils.safeIntegerAddition(this.rtt_highwater, 5 * constants.MILLISECOND)) {
    this.rtt_seenrecenthigh = true
  } else if (this.rtt_average < this.rtt_lowwater) {
    this.rtt_seenrecentlow = true
  }
}

// Start new adjustment cycle (at least 16 tranmsission periods have elapsed)
Chicago.prototype._adjustment_cycle_has_completed = function () {
  var cycle = utils.safeIntegerMultiplication(this.nsecperblock, 16)
  var endOfCycle = new Clock([this.lastspeedadjustment.seconds, this.lastspeedadjustment.nanoseconds])
  endOfCycle.add(cycle)
  var result = this.clock.compare(endOfCycle)
  return result >= 0
}

Chicago.prototype._reinitialize_lastspeedadjustment = function () {
  this._log.debug('_reinitialize_lastspeedadjustment ' + this.nsecperblock)
  if (this.clock.subtract(this.lastspeedadjustment) > 10 * constants.SECOND) {
    this.nsecperblock = constants.SECOND /* slow restart */
    this.nsecperblock = utils.safeIntegerAddition(this.nsecperblock, utils.randommod(this.nsecperblock / 8))
  }
  this.lastspeedadjustment = this.clock.clone()
}

Chicago.prototype._apply_additive_increase = function () {
  this._log.debug('_apply_additive_increase ' + this.nsecperblock)
  if (this.nsecperblock >= 131072) {
    /* additive increase: adjust 1/N by a constant c */
    /* rtt-fair additive increase: adjust 1/N by a constant c every nanosecond */
    /* approximation: adjust 1/N by cN every N nanoseconds */
    /* i.e., N <- 1/(1/N + cN) = N/(1 + cN^2) every N nanoseconds */
    if (this.nsecperblock < 16777216) {
      /* N/(1+cN^2) approx N - cN^3 */
      var u = this.nsecperblock / 131072
      var u3 = utils.safeIntegerMultiplication(utils.safeIntegerMultiplication(u, u), u)
      this.nsecperblock = this.nsecperblock - u3
    } else {
      var d = this.nsecperblock
      this.nsecperblock = d / (1 + ((d * d) / 2251799813685248.0))
    }
  }
}

Chicago.prototype._phase_events = function () {
  this._log.debug('_phase_events ' + this.nsecperblock)
  if (this.rtt_phase === 0) {
    if (this.rtt_seenolderhigh) {
      this.rtt_phase = 1
      this.lastedge = this.clock
      this.nsecperblock = utils.safeIntegerAddition(this.nsecperblock, utils.randommod(this.nsecperblock / 4))
    }
  } else {
    if (this.rtt_seenolderlow) {
      this.rtt_phase = 0
    }
  }
}

Chicago.prototype._update_seen_watermarks = function () {
  this.rtt_seenolderhigh = this.rtt_seenrecenthigh
  this.rtt_seenolderlow = this.rtt_seenrecentlow
  this.rtt_seenrecenthigh = false
  this.rtt_seenrecentlow = false
}

Chicago.prototype._apply_rate_doubling = function () {
  this._log.debug('_apply_rate_doubling ' + this.nsecperblock)
  var compareClock
  var result
  while (true) {
    var n4 = utils.safeIntegerMultiplication(this.nsecperblock, 4)
    if (this.clock.subtract(this.lastedge) < 60 * constants.SECOND) {
      var rto64 = utils.safeIntegerMultiplication(this.rtt_timeout, 64)
      compareClock = this.lastdoubling.clone()
      compareClock.add(n4)
      compareClock.add(rto64)
      compareClock.add(5 * constants.SECOND)
      result = this.clock.compare(compareClock)
      if (result === -1) {
        break
      }
    } else {
      var rto2 = utils.safeIntegerMultiplication(this.rtt_timeout, 2)
      compareClock = this.lastdoubling.clone()
      compareClock.add(n4)
      compareClock.add(rto2)
      result = this.clock.compare(compareClock)
      if (result === -1) {
        break
      }
    }
    if (this.nsecperblock <= 65535) {
      break
    }
    this.nsecperblock = this.nsecperblock / 2
    this.lastdoubling = this.clock.clone()
    if (this.lastedge) {
      this.lastedge = this.clock.clone()
    }
  }
}

module.exports = Chicago
