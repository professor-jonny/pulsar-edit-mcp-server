'use strict';
// walkDir limits (2026-11-18): walkDir(dir, files, opts) can stop early. Project-wide tools used to walk the WHOLE tree
// before any glob or match limit applied; a deadline or a file cap now stops the walk itself.
//   opts.deadline  absolute time (Date.now() ms) after which the walk stops;  opts.maxFiles  stop after that many files.
//   opts.hit is set to 'deadline' or 'maxFiles' when a limit stopped the walk (so the caller can say the list is partial).
//   Without opts the behaviour is exactly as before.   Run: node test/walkdir.limits.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { walkDir } = require('../lib/buffer-helpers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-walk-'));
for (const d of ['a', 'b', 'c']) {
  fs.mkdirSync(path.join(root, d));
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(root, d, 'f' + i + '.txt'), 'x');
}
fs.writeFileSync(path.join(root, 'top.txt'), 'x');
const TOTAL = 13;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS  ' + name); }
  catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

(async () => {
  await t('no opts: every file, exactly as before', async () => {
    const files = await walkDir(root);
    assert.strictEqual(files.length, TOTAL);
  });
  await t('opts without limits: every file, hit stays unset', async () => {
    const opts = {};
    const files = await walkDir(root, [], opts);
    assert.strictEqual(files.length, TOTAL);
    assert.strictEqual(opts.hit, undefined);
  });
  await t('a deadline in the future is not hit', async () => {
    const opts = { deadline: Date.now() + 60000 };
    const files = await walkDir(root, [], opts);
    assert.strictEqual(files.length, TOTAL);
    assert.strictEqual(opts.hit, undefined);
  });
  await t('a deadline already passed stops the walk and says so', async () => {
    const opts = { deadline: Date.now() - 1 };
    const files = await walkDir(root, [], opts);
    assert.ok(files.length < TOTAL, 'got ' + files.length);
    assert.strictEqual(opts.hit, 'deadline');
  });
  await t('maxFiles stops after that many files, across directories', async () => {
    const opts = { maxFiles: 5 };
    const files = await walkDir(root, [], opts);
    assert.strictEqual(files.length, 5);
    assert.strictEqual(opts.hit, 'maxFiles');
  });
  await t('maxFiles larger than the tree is not hit', async () => {
    const opts = { maxFiles: 100 };
    const files = await walkDir(root, [], opts);
    assert.strictEqual(files.length, TOTAL);
    assert.strictEqual(opts.hit, undefined);
  });
  await t('maxFiles equal to the tree size returns everything', async () => {
    const opts = { maxFiles: TOTAL };
    const files = await walkDir(root, [], opts);
    assert.strictEqual(files.length, TOTAL);
  });
  await t('once a limit is hit, a second walk with the same opts adds nothing (caller loops over roots)', async () => {
    const opts = { maxFiles: 3 };
    const first = await walkDir(root, [], opts);
    const second = await walkDir(root, [], opts);
    assert.strictEqual(first.length, 3);
    assert.strictEqual(second.length, 0);
  });
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exitCode = fail ? 1 : 0;
})();
