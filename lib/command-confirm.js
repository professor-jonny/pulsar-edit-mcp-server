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
  const { command, cwd, reveal, getTerminalPanel } = args || {};
  const timeoutMs = Number.isFinite(args && args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (typeof reveal === 'function') {
    try { await reveal(); } catch (_) { /* still ask */ }
  }
  const panel = typeof getTerminalPanel === 'function' ? getTerminalPanel() : null;
  if (panel && typeof panel.askConfirm === 'function') {
    const raw = await panel.askConfirm(command, { cwd, timeoutMs });
    // Anything that is not exactly 'approved' means "do not run"; unknown answers count as declined.
    const outcome = (raw === 'approved' || raw === 'timeout' || raw === 'closed') ? raw : 'declined';
    const approved = outcome === 'approved';
    return { approved, via: 'terminal', outcome, reason: approved ? null : reasonFor(outcome, timeoutMs) };
  }
  return { approved: false, via: 'none', outcome: 'none', reason: reasonFor('none', timeoutMs) };
}

module.exports = { confirmDestructive, revealCommandPanel, reasonFor, DEFAULT_TIMEOUT_MS, COMMAND_PANEL_URI };
