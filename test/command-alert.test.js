'use strict';
// Approval alert test (2026-11-15).
// When run-command needs a person's approval for a destructive command, lib/command-confirm.js makes a noise
// (a Web Audio chime, or the system beep when audio is blocked) and flashes the taskbar button when Pulsar is not
// the focused window. This pins: the alert fires once, only after the prompt is raised, never changes or blocks
// the outcome, honours the setting, and uses the beep fallback when the audio context never starts.
// Pure unit test: fake atom, fake AudioContext. No Pulsar, no restart needed.
// Run from the package root:   node test/command-alert.test.js
const fs = require('fs');
const path = require('path');
const { confirmDestructive, alertApproval, CHIME_FALLBACK_MS } = require('../lib/command-confirm');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}
const tick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A fake atom that records what the alert did.
function fakeAtom(opts) {
  const o = Object.assign({ alertSetting: true, focused: false }, opts);
  const log = { beeps: 0, flashes: 0 };
  global.atom = {
    config: { get: key => (key === 'pulsar-edit-mcp-server.approvalAlert' ? o.alertSetting : undefined) },
    beep() { log.beeps++; },
    getCurrentWindow: () => ({ isFocused: () => o.focused, flashFrame() { log.flashes++; } }),
  };
  return log;
}
// A fake Web Audio context: state is whatever the test chooses; counts notes started and closes.
function fakeAudioContext(state) {
  const stats = { created: 0, notes: 0, closed: 0 };
  global.AudioContext = class {
    constructor() { stats.created++; this.state = state; this.currentTime = 0; this.destination = {}; }
    resume() {}
    close() { stats.closed++; }
    createOscillator() { return { type: '', frequency: { value: 0 }, connect() {}, start() { stats.notes++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  };
  return stats;
}
function cleanup() { delete global.atom; delete global.AudioContext; }

(async () => {
  // ---- 1. when the alert fires, and that it never changes the outcome ----------------------------
  {
    const log = []; let answer;
    const panel = { askConfirm: () => { log.push('ask'); return new Promise(r => { answer = r; }); } };
    const pr = confirmDestructive({ command: 'rm x', getTerminalPanel: () => panel, notify: () => log.push('notify') });
    await tick();
    check('1a the prompt is raised first, then the alert fires once, while the call is still waiting', log.join(',') === 'ask,notify', log.join(','));
    answer('approved');
    const r = await pr;
    check('1b an approved answer still comes back as approved', r.approved === true && r.outcome === 'approved');
  }
  {
    const panel = { askConfirm: async () => 'declined' };
    const r = await confirmDestructive({ command: 'rm x', getTerminalPanel: () => panel, notify: () => { throw new Error('speaker exploded'); } });
    check('1c an alert that throws never blocks the prompt or changes a declined answer', r.approved === false && r.outcome === 'declined');
  }
  {
    let notified = 0;
    const r = await confirmDestructive({ command: 'rm x', getTerminalPanel: () => null, notify: () => { notified++; } });
    check('1d with no Command Output panel there is no prompt, so no alert', notified === 0 && r.outcome === 'none');
  }

  // ---- 2. the default alert is safe and honours the setting --------------------------------------
  cleanup();
  let threw = false;
  try { alertApproval(); } catch (_) { threw = true; }
  check('2a with no atom at all the alert is a silent no-op', threw === false);

  {
    const log = fakeAtom({ alertSetting: false });
    const audio = fakeAudioContext('running');
    alertApproval();
    await sleep(CHIME_FALLBACK_MS + 100);
    check('2b with the setting off there is no sound and no flash',
      log.beeps === 0 && log.flashes === 0 && audio.created === 0, JSON.stringify({ log, audio }));
    cleanup();
  }

  // ---- 3. the chime, the beep fallback and the taskbar flash -------------------------------------
  {
    const log = fakeAtom({ focused: false });
    const audio = fakeAudioContext('running');
    alertApproval();
    check('3a the chime plays three notes and the taskbar flashes when Pulsar is not focused',
      audio.created === 1 && audio.notes === 3 && log.flashes === 1, JSON.stringify({ log, audio }));
    await sleep(CHIME_FALLBACK_MS + 100);
    check('3b a running audio context means no beep, and the context is closed afterwards',
      log.beeps === 0 && audio.closed === 1, JSON.stringify({ log, audio }));
    cleanup();
  }
  {
    const log = fakeAtom({ focused: false });
    const audio = fakeAudioContext('suspended');
    alertApproval();
    await sleep(CHIME_FALLBACK_MS + 100);
    check('3c an audio context that never starts (autoplay blocked) falls back to the system beep',
      log.beeps === 1 && audio.closed === 1, JSON.stringify({ log, audio }));
    cleanup();
  }
  {
    const log = fakeAtom({ focused: false });
    alertApproval(); // no AudioContext defined at all
    check('3d with no Web Audio the system beep plays at once and the taskbar flashes', log.beeps === 1 && log.flashes === 1, JSON.stringify(log));
    cleanup();
  }
  {
    const log = fakeAtom({ focused: true });
    fakeAudioContext('running');
    alertApproval();
    check('3e no taskbar flash when Pulsar is already the focused window', log.flashes === 0, JSON.stringify(log));
    await sleep(CHIME_FALLBACK_MS + 100);
    cleanup();
  }
  {
    fakeAtom({ focused: false });
    global.AudioContext = class { constructor() { throw new Error('no audio device'); } };
    let t = false;
    try { alertApproval(); } catch (_) { t = true; }
    check('3f an audio context that cannot even be created never throws', t === false);
    cleanup();
  }

  // ---- 4. the setting exists and the wiring is in place ------------------------------------------
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const cfg = pkg.configSchema && pkg.configSchema.approvalAlert;
  check('4a package.json declares the approvalAlert setting, boolean, on by default',
    !!cfg && cfg.type === 'boolean' && cfg.default === true, JSON.stringify(cfg));
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'command-confirm.js'), 'utf8');
  check('4b the code reads the same setting name the package declares',
    src.includes("'pulsar-edit-mcp-server.approvalAlert'"));
  const iAsk = src.indexOf('panel.askConfirm(command');
  const iAlert = src.indexOf('alertApproval)()');
  const iAwait = src.indexOf('await pending');
  check('4c the alert is called after the prompt is raised and before the answer is awaited', iAsk > -1 && iAlert > iAsk && iAwait > iAlert, [iAsk, iAlert, iAwait].join(' / '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
