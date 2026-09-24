'use babel';

function verifyLintRace() {
  const unusedVar1 = 42;
  return 1;
}

module.exports = { verifyLintRace };
