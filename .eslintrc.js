module.exports = {
  env: {
    node: true,
    browser: true,
    es2020: true,
  },
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  rules: {
    // Catch real bugs
    'no-undef': 'warn',
    'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    'no-unreachable': 'error',
    'no-constant-condition': 'warn',

    // Off — this codebase uses atom/pulsar globals and lots of intentional patterns
    'no-console': 'off',
  },
  globals: {
    // Pulsar / Atom globals
    atom: 'readonly',
  },
};
