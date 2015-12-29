var hrtime = require('browser-process-hrtime')
var nacl = require('tweetnacl')
var debug = require('debug')('curvecp:chicago')
var NanoTimer = require('nanotimer')
var Clock = require('./clock.js')
var constants = require('./constants.js')

var _safe_integer_addition = function (original, addition) {
  if (Number.MAX_SAFE_INTEGER - addition < original) {
    return Number.MAX_SAFE_INTEGER
  } else {
    return original + addition
  }
}

var _safe_integer_multiplication = function (original, multiplier) {
  if (Number.MAX_SAFE_INTEGER / 4 < original) {
    return Number.MAX_SAFE_INTEGER
  } else {
    return original * multiplier
  }
}

var Chicago = function () {
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
  this.timer_disabled = false
  this._set_timeout()
}

Chicago.prototype._timeout_callback = function () {
  debug('_timeout_callback')
  if (this.timeout_callback) {
    this.timeout_callback()
  }
  if (!this.timer_disabled) {
    this._set_timeout()
  }
}

Chicago.prototype._set_timeout = function () {
  debug('_set_timeout')
  debug(this.nsecperblock)
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

Chicago.prototype.block_is_timed_out = function (transmission_time) {
  this._refresh_clock()
  var clock = new Clock(transmission_time)
  clock.add(this.rtt_timeout)
  var compare_result = clock.compare(this.clock)
  if (compare_result === -1) {
    return true
  } else {
    return false
  }
}

Chicago.prototype.retransmission = function () {
  this._refresh_clock()
  var clock = this.lastpanic.clone()
  clock.add(4 * this.rtt_timeout)
  var compare_result = this.clock.compare(clock)
  if (compare_result === 1) {
    this._halve_transmission_rate()
  }
}

Chicago.prototype._halve_transmission_rate = function () {
  this.nsecperblock = _safe_integer_multiplication(this.nsecperblock, 2)
  this.lastpanic = this.clock.clone()
  this.lastedge = this.clock.clone()
}

/* MESSAGE ACKNOWLEDGEMENT */

Chicago.prototype.acknowledgement = function (original_blocktime) {
  debug('acknowledgement')
  this._refresh_clock()
  var rtt = this._initialize_rtt(original_blocktime)
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

Chicago.prototype._initialize_rtt = function (original_blocktime) {
  var rtt = this.clock.subtract(original_blocktime)
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
  var rtt_delta = rtt - this.rtt_average
  this.rtt_average = _safe_integer_addition(this.rtt_average, rtt_delta / 8)
  if (rtt_delta < 0) {
    rtt_delta = -rtt_delta
  }
  rtt_delta -= this.rtt_deviation
  this.rtt_deviation = _safe_integer_addition(this.rtt_deviation, rtt_delta / 4)
  this.rtt_timeout = _safe_integer_addition(this.rtt_average, _safe_integer_multiplication(this.rtt_deviation, 4))
}

Chicago.prototype._compensate_delayed_acks = function () {
  /* adjust for delayed acks with anti-spiking */
  this.rtt_timeout = _safe_integer_addition(this.rtt_timeout, 8 * this.nsecperblock)
}

Chicago.prototype._track_watermarks = function (rtt) {
  /* Adjust high watermark of congestion cycle */
  var rtt_delta = rtt - this.rtt_highwater
  this.rtt_highwater = _safe_integer_addition(this.rtt_highwater, rtt_delta / 1024)
  /* Adjust low watermark of congestion cycle */
  rtt_delta = rtt - this.rtt_lowwater
  if (rtt_delta > 0) {
    this.rtt_lowwater = _safe_integer_addition(this.rtt_lowwater, rtt_delta / 8192)
  } else {
    this.rtt_lowwater = _safe_integer_addition(this.rtt_lowwater, rtt_delta / 256)
  }
}

Chicago.prototype._check_for_watermarks = function () {
  if (this.rtt_average > _safe_integer_addition(this.rtt_highwater, 5 * constants.MILLISECOND)) {
    this.rtt_seenrecenthigh = true
  } else if (this.rtt_average < this.rtt_lowwater) {
    this.rtt_seenrecentlow = true
  }
}

// Start new adjustment cycle (at least 16 tranmsission periods have elapsed)
Chicago.prototype._adjustment_cycle_has_completed = function () {
  var cycle = _safe_integer_multiplication(this.nsecperblock, 16)
  var endOfCycle = new Clock([this.lastspeedadjustment.seconds, this.lastspeedadjustment.nanoseconds])
  endOfCycle.add(cycle)
  var result = this.clock.compare(endOfCycle)
  return result >= 0
}

Chicago.prototype._reinitialize_lastspeedadjustment = function () {
  if (this.clock.subtract(this.lastspeedadjustment) > 10 * constants.SECOND) {
    this.nsecperblock = constants.SECOND /* slow restart */
    this.nsecperblock = _safe_integer_addition(this.nsecperblock, this._randommod(this.nsecperblock / 8))
  }
  this.lastspeedadjustment = this.clock.clone()
}

Chicago.prototype._apply_additive_increase = function () {
  if (this.nsecperblock >= 131072) {
    /* additive increase: adjust 1/N by a constant c */
    /* rtt-fair additive increase: adjust 1/N by a constant c every nanosecond */
    /* approximation: adjust 1/N by cN every N nanoseconds */
    /* i.e., N <- 1/(1/N + cN) = N/(1 + cN^2) every N nanoseconds */
    if (this.nsecperblock < 16777216) {
      /* N/(1+cN^2) approx N - cN^3 */
      var u = this.nsecperblock / 131072
      var u_3 = _safe_integer_multiplication(_safe_integer_multiplication(u, u), u)
      this.nsecperblock = this.nsecperblock - u_3
    } else {
      var d = this.nsecperblock
      this.nsecperblock = d / (1 + ((d * d) / 2251799813685248.0))
    }
  }
}

Chicago.prototype._phase_events = function () {
  if (this.rtt_phase === 0) {
    if (this.rtt_seenolderhigh) {
      this.rtt_phase = 1
      this.lastedge = this.clock
      this.nsecperblock = _safe_integer_addition(this.nsecperblock, this._randommod(this.nsecperblock / 4))
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
  var compareClock
  var result
  while (true) {
    var n_4 = _safe_integer_multiplication(this.nsecperblock, 4)
    if (this.clock.subtract(this.lastedge) < 60 * constants.SECOND) {
      var rto_64 = _safe_integer_multiplication(this.rtt_timeout, 64)
      compareClock = this.lastdoubling.clone()
      compareClock.add(n_4)
      compareClock.add(rto_64)
      compareClock.add(5 * constants.SECOND)
      result = this.clock.compare(compareClock)
      if (result === -1) {
        break
      }
    } else {
      var rto_2 = _safe_integer_multiplication(this.rtt_timeout, 2)
      compareClock = this.lastdoubling.clone()
      compareClock.add(n_4)
      compareClock.add(rto_2)
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

Chicago.prototype._randommod = function (n) {
  var result = 0
  if (n <= 1) {
    return 0
  }
  var randomBytes = nacl.randomBytes(32)
  for (var j = 0; j < 32; ++j) {
    result = _safe_integer_addition(_safe_integer_multiplication(result, 256), Number(randomBytes[j] % n))
  }
  return result
}

module.exports = Chicago
