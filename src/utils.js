var nacl = require('tweetnacl')

var safe_integer_addition = function (original, addition) {
  if (Number.MAX_SAFE_INTEGER - addition < original) {
    return Number.MAX_SAFE_INTEGER
  } else {
    return original + addition
  }
}

var safe_integer_multiplication = function (original, multiplier) {
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
    result = safe_integer_addition(safe_integer_multiplication(result, 256), Number(randomBytes[j]))
    result = result % n
  }
  return result
}

module.exports = {
  safe_integer_addition: safe_integer_addition,
  safe_integer_multiplication: safe_integer_multiplication,
  randommod: randommod
}
