'use strict';
// Destructive-command approval test (2026-11-04).
// run-command asks a PERSON to approve a destructive command (rm, del, Remove-Item, format ...) with
// Run / Cancel buttons in the Command Output panel. confirm:true from the caller no longer skips it.
// Pure unit tests: a tiny fake DOM drives CommandTerminalPanel.askConfirm, stubs drive
// lib/command-confirm.js, and source-wiring checks read lib/mcp-registration.js.
// No Pulsar, no restart needed.   Run from the package root:   node test/command-confirm.test.js
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (!cond && detail ? '\n       ' + detail : ''));
}

// ---- minimal fake DOM ---------------------------------------------------------------------------
function makeEl(tag) {
  const el = {
    tag, children: [], parent: null, listeners: {}, style: {}, attrs: {}, _cls: new Set(),
    textContent: '', innerHTML: '', value: '', disabled: false, id: '', title: '', placeholder: '', type: '',
    scrollTop: 0, scrollHeight: 0,
    classList: {
      add(...c) { c.forEach(x => el._cls.add(x)); },
      contains(c) { return el._cls.has(c); },
    },
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    remove() { if (el.parent) { el.parent.children = el.parent.children.filter(x => x !== el); el.parent = null; } },
    setAttribute(k, v) { el.attrs[k] = v; },
    addEventListener(t, f) { (el.listeners[t] = el.listeners[t] || []).push(f); },
    click() { (el.listeners.click || []).slice().forEach(f => f({})); },
    focus() {},
  };
  return el;
}
global.document = { createElement: makeEl };

function walk(el, out) { out = out || []; out.push(el); el.children.forEach(c => walk(c, out)); return out; }
function find(el, pred) { return walk(el).filter(pred); }
const PENDING = Symbol('pending');
function settled(p) { return Promise.race([p, new Promise(r => setImmediate(() => r(PENDING)))]); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function btn(panel, label) { return find(panel.element, e => e.tag === 'button' && e.textContent === label)[0]; }
function confirmButtons(panel) { return find(panel.element, e => e.tag === 'button' && (e.textContent === 'Run' || e.textContent === 'Cancel')); }
function infoLines(panel) { return find(panel._output, e => e._cls.has('command-terminal-info')); }

const CommandTerminalPanel = require('../lib/command-terminal-panel');
const { confirmDestructive, revealCommandPanel, DEFAULT_TIMEOUT_MS } = require('../lib/command-confirm');

async function main() {
  // ---- 1. CommandTerminalPanel.askConfirm: Run ----------------------------------------------------
  {
    const p = new CommandTerminalPanel();
    const pr = p.askConfirm('Remove-Item x.txt', { cwd: 'C:/w', timeoutMs: 60000 });
    check('1a the promise stays pending until a button is clicked', (await settled(pr)) === PENDING);
    const runBtn = btn(p, 'Run'), cancelBtn = btn(p, 'Cancel');
    check('1b Run and Cancel buttons are rendered', !!runBtn && !!cancelBtn);
    check('1c Run is the red btn-error button and Cancel is not',
      !!runBtn && !!cancelBtn && runBtn.classList.contains('btn-error') && !cancelBtn.classList.contains('btn-error'));
    const codeEls = find(p.element, e => e.tag === 'code');
    check('1d the exact command is shown in a code element', codeEls.length === 1 && codeEls[0].textContent === 'Remove-Item x.txt');
    check('1e the confirm row lives inside the output area', !!runBtn && find(p._output, e => e === runBtn).length === 1);
    check('1f the status label says it waits for approval and names the command',
      /approval/i.test(p._statusLabel.textContent) && p._statusLabel.textContent.includes('Remove-Item x.txt'), p._statusLabel.textContent);
    runBtn.click();
    check('1g a Run click resolves approved', (await pr) === 'approved');
    check('1h the confirm row is removed after the answer', confirmButtons(p).length === 0);
    check('1i an info line records the answer', infoLines(p).length === 1, String(infoLines(p).length));
    const before = infoLines(p).length;
    cancelBtn.click();
    check('1j a second click after the answer changes nothing', infoLines(p).length === before && (await pr) === 'approved');
  }

  // ---- 2. Cancel, timeout, panel closed -----------------------------------------------------------
  {
    const p = new CommandTerminalPanel();
    const pr = p.askConfirm('del a.txt', { timeoutMs: 60000 });
    btn(p, 'Cancel').click();
    check('2a a Cancel click resolves declined', (await pr) === 'declined');
    check('2b the row is gone after Cancel', confirmButtons(p).length === 0);
  }
  {
    const p = new CommandTerminalPanel();
    const t0 = Date.now();
    const pr = p.askConfirm('rm -rf x', { timeoutMs: 25 });
    check('2c with no answer the prompt resolves timeout', (await pr) === 'timeout');
    check('2d the timeout is not instant (waited about the configured time)', Date.now() - t0 >= 15, String(Date.now() - t0));
    check('2e the row is gone after the timeout', confirmButtons(p).length === 0);
  }
  {
    const p = new CommandTerminalPanel();
    const pr = p.askConfirm('rd /s x', { timeoutMs: 60000 });
    p.destroy();
    check('2f destroying the panel resolves closed (nothing hangs)', (await pr) === 'closed');
  }
  {
    // a zero, negative or missing timeout must fall back to the default, never fire at once
    const p = new CommandTerminalPanel();
    const pr = p.askConfirm('rm x', { timeoutMs: 0 });
    check('2g timeoutMs 0 does not auto-decline immediately', (await settled(pr)) === PENDING);
    await sleep(30);
    check('2h ... and is still pending a moment later', (await settled(pr)) === PENDING);
    btn(p, 'Cancel').click();
    check('2i ... and can still be answered', (await pr) === 'declined');
  }

  // ---- 3. safe rendering and independence -------------------------------------------------------
  {
    const p = new CommandTerminalPanel();
    const evil = '<img src=x onerror=alert(1)>; rm -rf /';
    const pr = p.askConfirm(evil, { timeoutMs: 60000 });
    const codeEls = find(p.element, e => e.tag === 'code');
    check('3a the command is placed with textContent, verbatim', codeEls.length === 1 && codeEls[0].textContent === evil);
    check('3b no element gets the command through innerHTML', walk(p.element).every(e => !/onerror/.test(e.innerHTML)));
    btn(p, 'Cancel').click();
    await pr;
  }
  {
    const p = new CommandTerminalPanel();
    const a = p.askConfirm('del one', { timeoutMs: 60000 });
    const b = p.askConfirm('del two', { timeoutMs: 60000 });
    const rows = find(p.element, e => e._cls.has('command-terminal-confirm'));
    check('3c two prompts make two rows', rows.length === 2, String(rows.length));
    const inRow = (row, label) => find(row, e => e.tag === 'button' && e.textContent === label)[0];
    inRow(rows[0], 'Cancel').click();
    inRow(rows[1], 'Run').click();
    check('3d each prompt is answered on its own', (await a) === 'declined' && (await b) === 'approved');
  }

  // ---- 4. lib/command-confirm.js: confirmDestructive ---------------------------------------------
  {
    const log = [];
    const panel = { askConfirm: async (cmd, opts) => { log.push(['ask', cmd, opts]); return 'approved'; } };
    const r = await confirmDestructive({
      command: 'rm x', cwd: 'C:/w',
      reveal: async () => { log.push(['reveal']); },
      getTerminalPanel: () => { log.push(['get']); return panel; },
    });
    check('4a it reveals the panel, then resolves it, then asks (in that order)', log.map(x => x[0]).join(',') === 'reveal,get,ask', JSON.stringify(log.map(x => x[0])));
    check('4b the command, cwd and the default timeout are passed to the panel',
      log[2] && log[2][1] === 'rm x' && log[2][2].cwd === 'C:/w' && log[2][2].timeoutMs === DEFAULT_TIMEOUT_MS, JSON.stringify(log[2]));
    check('4c an approved answer is approved via the terminal', r.approved === true && r.via === 'terminal' && r.outcome === 'approved', JSON.stringify(r));
    check('4d the default timeout is two minutes', DEFAULT_TIMEOUT_MS === 120000);
  }
  for (const [outcome, re] of [['declined', /declined destructive command/i], ['timeout', /no answer within 5s/i], ['closed', /closed/i]]) {
    const r = await confirmDestructive({
      command: 'rm x', timeoutMs: 5000,
      getTerminalPanel: () => ({ askConfirm: async () => outcome }),
    });
    check('4e outcome ' + outcome + ' is not approved and says why', r.approved === false && r.outcome === outcome && re.test(r.reason), JSON.stringify(r));
  }
  for (const odd of [true, 'yes', 1, undefined, null, 'APPROVED']) {
    const r = await confirmDestructive({ command: 'rm x', getTerminalPanel: () => ({ askConfirm: async () => odd }) });
    check('4f only the exact outcome "approved" approves (got ' + String(odd) + ')', r.approved === false, JSON.stringify(r));
  }
  {
    const r = await confirmDestructive({
      command: 'rm x', confirm: true, approved: true, force: true,
      getTerminalPanel: () => ({ askConfirm: async () => 'declined' }),
    });
    check('4g extra flags such as confirm:true cannot approve (only the person can)', r.approved === false, JSON.stringify(r));
  }
  {
    const r = await confirmDestructive({
      command: 'rm x',
      reveal: async () => { throw new Error('dock exploded'); },
      getTerminalPanel: () => ({ askConfirm: async () => 'approved' }),
    });
    check('4h a failing reveal does not stop the question from being asked', r.approved === true && r.via === 'terminal', JSON.stringify(r));
  }
  {
    let shown = false;
    const panel = { askConfirm: async () => 'approved' };
    const r = await confirmDestructive({
      command: 'rm x',
      reveal: async () => { shown = true; },
      getTerminalPanel: () => (shown ? panel : null),
    });
    check('4i the panel is looked up AFTER the reveal (a closed panel is re-created)', r.approved === true && r.via === 'terminal', JSON.stringify(r));
  }
  {
    const r = await confirmDestructive({ command: 'rm x', getTerminalPanel: () => null, chatAsk: async () => true });
    check('4j a chat-panel answer is ignored: with no Command Output panel nothing approves', r.approved === false && r.via === 'none' && r.outcome === 'none', JSON.stringify(r));
    check('4k ... and the reason names the Command Output panel only', /Command Output panel/.test(r.reason) && !/chat panel/i.test(r.reason), r.reason);
  }
  {
    const r = await confirmDestructive({ command: 'rm x', getTerminalPanel: () => null });
    check('4l with no panel at all it blocks and says where to look', r.approved === false && r.via === 'none' && /Command Output panel/.test(r.reason), JSON.stringify(r));
    const old = await confirmDestructive({ command: 'rm x', getTerminalPanel: () => ({ appendOutput() {} }) });
    check('4m a panel object without askConfirm counts as no panel', old.approved === false && old.via === 'none', JSON.stringify(old));
    const bare = await confirmDestructive({ command: 'rm x' });
    check('4n no arguments at all still blocks, never throws', bare.approved === false && bare.via === 'none', JSON.stringify(bare));
  }

  // ---- 5. lib/command-confirm.js: revealCommandPanel ----------------------------------------------
  {
    const calls = [];
    const item = { id: 'panel' };
    let shown = 0, dockShown = 0;
    global.atom = { workspace: {
      open: async (uri, opts) => { calls.push([uri, opts]); return item; },
      paneContainerForItem: (it) => (it === item ? { show() { shown++; } } : null),
      getBottomDock: () => ({ show() { dockShown++; } }),
    } };
    await revealCommandPanel();
    check('5a it opens the Command Output URI without stealing pane focus',
      calls.length === 1 && calls[0][0] === 'atom://pulsar-edit-mcp-server/command-terminal' && calls[0][1].activatePane === false && calls[0][1].searchAllPanes === true, JSON.stringify(calls));
    check('5b it shows the dock the panel actually lives in', shown === 1 && dockShown === 0, shown + '/' + dockShown);
    global.atom.workspace.paneContainerForItem = () => null;
    await revealCommandPanel();
    check('5c with no container it falls back to the bottom dock', dockShown === 1, String(dockShown));
    global.atom.workspace.open = async () => undefined;
    delete global.atom.workspace.getBottomDock;
    let threw = false;
    try { await revealCommandPanel(); } catch (_) { threw = true; }
    check('5d it never throws when there is nothing to show', threw === false);
    delete global.atom;
  }

  // ---- 6. source wiring in lib/mcp-registration.js -----------------------------------------------
  const reg = fs.readFileSync(path.join(__dirname, '..', 'lib', 'mcp-registration.js'), 'utf8');
  check('6a mcp-registration requires ./command-confirm', /require\('\.\/command-confirm'\)/.test(reg));
  check('6b the guard no longer lets confirm skip the prompt', !/!confirm\s*&&\s*DESTRUCTIVE_RE/.test(reg) && /if \(DESTRUCTIVE_RE\.test\(command\)\)/.test(reg));
  check('6c the old "pass confirm:true to proceed" message is gone', !/pass confirm:true to proceed/.test(reg));
  const iGuard = reg.indexOf('confirmDestructive({');
  const iSpawn = reg.indexOf('_spawn(shell, spawnArgs');
  check('6d the approval is asked BEFORE the process is spawned', iGuard > -1 && iSpawn > -1 && iGuard < iSpawn, iGuard + ' / ' + iSpawn);
  check('6e the destructive pattern is unchanged (rm rmdir del rd format Remove-Item ri rd /s)',
    reg.includes('const DESTRUCTIVE_RE = /\\b(rm|rmdir|del|rd|format|Remove-Item|ri\\s|rd\\s.*\\/s)\\b/i;'));
  check('6f the tool description tells the model that confirm:true does not skip the prompt', /confirm:true does NOT skip/.test(reg));
  check('6g the chat-panel Run/Cancel row is gone: the question is asked only in the Command Output panel', !/chat-command-confirm/.test(reg) && !/chatAsk/.test(reg));
  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'command-terminal-panel.js'), 'utf8');
  check('6h the panel exposes askConfirm and answers every pending prompt when destroyed', /askConfirm\(/.test(panelSrc) && /_pendingConfirms/.test(panelSrc));

  // ---- 7. run-command output goes ONLY to the Command Output panel (2026-11-04) -----------------
  const rcStart = reg.indexOf("name:           'run-command'");
  const rcEnd = reg.indexOf('replace-across-files (migrated');
  const rc = rcStart > -1 && rcEnd > rcStart ? reg.slice(rcStart, rcEnd) : '';
  check('7a the run-command handler text was found', rc.length > 2000, String(rc.length));
  check('7b the run-command handler never touches the chat panel', !/chatPanel/.test(rc), (rc.match(/.*chatPanel.*/g) || []).join(' | ').slice(0, 300));
  check('7c the command echo goes to the Command Output panel', rc.includes("commandTerminalPanel.appendOutput(`$ ${command}`, 'info')"));
  check('7d stdout and stderr lines go to the Command Output panel',
    rc.includes("lines.forEach(l => commandTerminalPanel.appendOutput(l, 'stdout'))") && rc.includes("lines.forEach(l => commandTerminalPanel.appendOutput(l, 'stderr'))"));
  check('7e the exit line goes to the Command Output panel', rc.includes("commandTerminalPanel.appendOutput(`[exit ${exitCode}]`, 'exit')"));
  check('7f the reloaded-files notice goes to the Command Output panel', /commandTerminalPanel\.appendOutput\(\s*`[^`]*Reloaded/.test(rc));
  check('7g a spawn error goes to the Command Output panel', rc.includes("commandTerminalPanel.appendOutput(`[error: ${err.message}]`, 'stderr')"));
  check('7h the pre-flight summary goes to the Command Output panel', /\.appendOutput\(preFlightLines\.join\(/.test(rc));
  check('7i the tool description says output goes only to the Command Output panel', /stream stdout\/stderr live to the Command Output panel/.test(rc) && !/live to the chat panel/.test(rc));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log('FAIL test crashed: ' + (e && e.stack || e)); process.exit(1); });
