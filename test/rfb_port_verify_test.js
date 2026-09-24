// Test fixture for replace-function-body port verification (note [39])

function simpleTarget(x) {
  return x + 1;
}

/**
 * A deliberately large doc comment block, several lines long, to check
 * whether the parked read/inFunction anomaly (note [37]) reproduces via
 * matchFunction's own resolveSymbolPosition-adjacent path.
 *
 * @param {number} y - input value
 * @returns {number} the doubled value
 */
function docCommentTarget(y) {
  return y * 2;
}

function scopeDup(a) {
  return a + 100;
}

function betweenAnchorA() {
  return 'anchorA';
}

function scopeDup(a) {
  return a + 200;
}

function betweenAnchorB() {
  return 'anchorB';
}
