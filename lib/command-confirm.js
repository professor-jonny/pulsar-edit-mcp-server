'use strict';

// Human approval for destructive run-command calls (2026-11-04).
//
// run-command matches a command against DESTRUCTIVE_RE (rm, del, Remove-Item, format ...) and, before it
// spawns anything, asks the PERSON to approve it. The question is shown in the Command Output panel as a
// red Run button and a Cancel button (CommandTerminalPanel.askConfirm). It is asked only there; the chat
// panel has no confirmation row any more (removed 2026-11-04).
//
// Only a person can approve: this module takes no "confirm" or "force" argument, so a caller (the model)
// cannot pass confirm:true to skip the question. Only the exact outcome 'approved' lets the command run;
// declined, timeout, closed, a missing panel and any odd answer all mean "do not run".
//
// outcome: 'approved' | 'declined' | 'timeout' | 'closed' | 'none'

const DEFAULT_TIMEOUT_MS = 120000;
const COMMAND_PANEL_URI = 'atom://pulsar-edit-mcp-server/command-terminal';

// Which run-command calls need a person's approval (moved here from lib/mcp-registration.js and tightened
// 2026-11-14 so it can be unit-tested: test/command-guard.test.js).
//   - A delete word (rm, rmdir, del, rd, Remove-Item) counts only as a WHOLE word: not glued to a longer name
//     by a letter, digit, underscore, hyphen or dot. So rm-notes.md and del.txt do not trigger, but rm,
//     rm.exe, C:\...\bin\rm, "cmd /c del x" and Remove-Item do. cmd's switch forms rd/s/q and del/f still match.
//   - `ri` (the Remove-Item alias) counts only when followed by whitespace.
//   - `format` is destructive only as the disk command (format D:, format /fs:ntfs, format.com D:) or as
//     Format-Volume. As a plain word it is everywhere (Format-Table, Format-List, --format, format.js) and
//     the old \bformat\b pattern wrongly asked for approval on all of those.
//   - Covered since 2026-11-15: erase, git clean, git reset --hard, Clear-Disk, Remove-Partition, diskpart,
//     Clear-Content, reg delete, robocopy /mir and /purge, [IO.File]::Delete and [IO.Directory]::Delete.
// Deliberately NOT covered: redirection and Set-Content/Out-File that overwrite a file (they would ask on almost every
// file write), and anything that deletes from inside a script it runs (node x.js, python x.py). This is a pattern on the
// command text, a speed bump and not a sandbox.
const DESTRUCTIVE_PARTS = [
  // delete words (whole words only; ".exe" allowed, "/" after the word allowed for cmd's rd/s and del/f)
  String.raw`(?<![\w.-])(?:rm|rmdir|del|erase|rd|Remove-Item)(?![\w-]|\.(?!exe\b))`,
  String.raw`(?<![\w.-])ri(?=\s)`,
  // format: only the disk command or Format-Volume
  String.raw`(?<![\w.-])format(?:\.(?:com|exe))?(?=\s+(?:[a-z]:|\/))`,
  String.raw`(?<![\w.-])Format-Volume(?![\w-])`,
  // disk tools (added 2026-11-15)
  String.raw`(?<![\w.-])(?:Clear-Disk|Remove-Partition|diskpart)(?![\w-]|\.(?!exe\b))`,
  // empties a file (added 2026-11-15)
  String.raw`(?<![\w.-])Clear-Content(?![\w-])`,
  // git commands that throw away local work (added 2026-11-15)
  String.raw`(?<![\w.-])git\s+clean(?![\w-])`,
  String.raw`(?<![\w.-])git\s+reset\b[^|;&\r\n]*\s--hard(?![\w-])`,
  // registry delete (added 2026-11-15)
  String.raw`(?<![\w.-])reg(?:\.exe)?\s+delete(?![\w-])`,
  // robocopy mirror / purge delete files in the destination (added 2026-11-15)
  String.raw`(?<![\w.-])robocopy(?:\.exe)?\b[^|;&\r\n]*\s\/(?:mir|purge)(?![\w-])`,
  // .NET deletes from PowerShell (added 2026-11-15)
  String.raw`\[(?:System\.)?IO\.(?:File|Directory)\]::Delete\b`,
];
const DESTRUCTIVE_RE = new RegExp(DESTRUCTIVE_PARTS.join('|'), 'i');

// Bring the Command Output panel on screen without stealing focus from the editor. Opening a URI that
// already exists focuses the existing item (and re-creates the panel if its tab was closed). Show the dock
// the panel actually lives in (it can be moved to the left or right); fall back to the bottom dock.
async function revealCommandPanel() {
  const ws = atom.workspace;
  const item = await ws.open(COMMAND_PANEL_URI, { activatePane: false, searchAllPanes: true });
  let container = null;
  if (item && typeof ws.paneContainerForItem === 'function') container = ws.paneContainerForItem(item);
  if (container && typeof container.show === 'function') { container.show(); return; }
  const dock = typeof ws.getBottomDock === 'function' ? ws.getBottomDock() : null;
  if (dock && typeof dock.show === 'function') dock.show();
}

// Make the approval prompt hard to miss (added 2026-11-15): a short three-tone chime and, when Pulsar is not the
// focused window, a flashing taskbar button. Best effort only: nothing here ever throws, and it runs after the
// prompt is already on screen so it can never delay or change the question. Turn it off with the package setting
// "Sound and Taskbar Flash for Destructive-Command Approval" (pulsar-edit-mcp-server.approvalAlert).
const CHIME_NOTES = [[880, 0], [660, 0.2], [880, 0.4]]; // [frequency Hz, start offset seconds]
const CHIME_FALLBACK_MS = 800; // if the audio context is not running by then, use the system beep instead

function systemBeep() {
  try { atom.beep(); } catch (_) { /* best effort */ }
}

// Returns true when a chime was scheduled. The Web Audio context can be blocked by Chromium's autoplay policy
// (it then never reaches 'running'); in that case the timer below falls back to the system beep.
function playChime() {
  const AC = typeof AudioContext !== 'undefined' ? AudioContext : null;
  if (!AC) return false;
  const ctx = new AC();
  try { ctx.resume(); } catch (_) { /* the fallback below covers a blocked context */ }
  const t = ctx.currentTime;
  for (const [freq, offset] of CHIME_NOTES) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + offset);
    gain.gain.exponentialRampToValueAtTime(0.25, t + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + offset + 0.17);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t + offset);
    osc.stop(t + offset + 0.18);
  }
  setTimeout(() => {
    let ran = false;
    try { ran = ctx.state === 'running'; } catch (_) { /* treat as not running */ }
    try { ctx.close(); } catch (_) { /* best effort */ }
    if (!ran) systemBeep();
  }, CHIME_FALLBACK_MS);
  return true;
}

function alertApproval() {
  try {
    if (typeof atom === 'undefined' || !atom) return;
    if (atom.config && typeof atom.config.get === 'function' && atom.config.get('pulsar-edit-mcp-server.approvalAlert') === false) return;
    let chimed = false;
    try { chimed = playChime(); } catch (_) { chimed = false; }
    if (!chimed) systemBeep();
    try {
      const win = typeof atom.getCurrentWindow === 'function' ? atom.getCurrentWindow() : null;
      const focused = !!(win && typeof win.isFocused === 'function' && win.isFocused());
      if (win && typeof win.flashFrame === 'function' && !focused) win.flashFrame(true);
    } catch (_) { /* best effort */ }
  } catch (_) { /* best effort */ }
}

function reasonFor(outcome, timeoutMs) {
  switch (outcome) {
    case 'declined': return 'User declined destructive command.';
    case 'timeout': return 'No answer within ' + Math.round(timeoutMs / 1000) + 's; the destructive command was not run.';
    case 'closed': return 'The Command Output panel was closed before an answer; the destructive command was not run.';
    default: return 'Destructive command blocked: no Command Output panel is open to ask you. Open it from the MCP Server menu (Show Command Output Panel) and try again.';
  }
}

// reveal and getTerminalPanel are injected so the logic can be tested without Pulsar.
//   reveal()            async, shows the panel (errors are ignored: the question is still asked)
//   getTerminalPanel()  returns the CommandTerminalPanel (resolved AFTER reveal, so a re-created panel is found)
async function confirmDestructive(args) {
  const { command, cwd, reveal, getTerminalPanel, notify } = args || {};
  const timeoutMs = Number.isFinite(args && args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (typeof reveal === 'function') {
    try { await reveal(); } catch (_) { /* still ask */ }
  }
  const panel = typeof getTerminalPanel === 'function' ? getTerminalPanel() : null;
  if (panel && typeof panel.askConfirm === 'function') {
    const pending = panel.askConfirm(command, { cwd, timeoutMs });
    // The prompt is on screen now: make some noise. notify is injected for tests; an error here never blocks the prompt.
    try { (typeof notify === 'function' ? notify : alertApproval)(); } catch (_) { /* best effort */ }
    const raw = await pending;
    // Anything that is not exactly 'approved' means "do not run"; unknown answers count as declined.
    const outcome = (raw === 'approved' || raw === 'timeout' || raw === 'closed') ? raw : 'declined';
    const approved = outcome === 'approved';
    return { approved, via: 'terminal', outcome, reason: approved ? null : reasonFor(outcome, timeoutMs) };
  }
  return { approved: false, via: 'none', outcome: 'none', reason: reasonFor('none', timeoutMs) };
}

module.exports = { confirmDestructive, revealCommandPanel, reasonFor, alertApproval, DESTRUCTIVE_RE, DEFAULT_TIMEOUT_MS, COMMAND_PANEL_URI, CHIME_FALLBACK_MS };
