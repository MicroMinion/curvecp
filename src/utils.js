var nacl = require('tweetnacl')

var safeIntegerAddition = function (original, addition) {
  if (Number.MAX_SAFE_INTEGER - addition < original) {
    return Number.MAX_SAFE_INTEGER
  } else {
    return original + addition
  }
}

var safeIntegerMultiplication = function (original, multiplier) {
  if (Number.MAX_SAFE_INTEGER / 4 < original) {
    return Number.MAX_SAFE_INTEGER
  } else {
    return original * multiplier
  }
}

var randommod = function (n) {
  var result = 0
  if (n <= 1) {
    return 0
  }
  var randomBytes = nacl.randomBytes(32)
  for (var j = 0; j < 32; ++j) {
    result = safeIntegerAddition(safeIntegerMultiplication(result, 256), Number(randomBytes[j]))
    result = result % n
  }
  return result
}

module.exports = {
  safeIntegerAddition: safeIntegerAddition,
  safeIntegerMultiplication: safeIntegerMultiplication,
  randommod: randommod
}
