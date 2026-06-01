'use babel';

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import PulsarMcpView from './pulsar-edit-mcp-server-view';
import { CompositeDisposable } from 'atom';
import path from "path";
import fs from "fs";
import * as Diff from "diff";
import ChatPanel from './chat-panel';
// mcp-registration.js and ghidra-tools.js are loaded dynamically (not static imports)
// so that a syntax error in those files does not prevent activate() from running.
// This keeps the emergency-revert and show-edit-stats commands always available.
let mcpRegistration = null, TOOL_CATALOGUE = [], TOGGLEABLE_GROUPS = [];
let ghidraToolsRegistration = null;
let mcpModuleError = null;
let mcpDeactivate = null;   // lifetime stats flush — assigned when mcp-registration loads

async function loadMcpModules() {
  // Flush stats from the previous module instance before re-importing.
  // The hot-reload window (save → new module evaluates → loadLifetimeStats reads disk)
  // is shorter than the 5s interval, so the old instance's in-session counts would be
  // lost without an explicit flush here. mcpDeactivate is null on the very first load.
  if (mcpDeactivate) {
    try { mcpDeactivate(); } catch {}
  }
  try {
    const reg = await import('./mcp-registration.js');
    mcpRegistration      = reg.mcpRegistration;
    TOOL_CATALOGUE       = reg.TOOL_CATALOGUE;
    TOGGLEABLE_GROUPS    = reg.TOGGLEABLE_GROUPS;
    mcpDeactivate        = reg.deactivate;       // lifetime stats flush on package unload
    const ghidra         = await import('./ghidra-tools.js');
    ghidraToolsRegistration = ghidra.ghidraToolsRegistration;
    mcpModuleError = null;
    return true;
  } catch (err) {
    mcpModuleError = err;
    console.error('[MCP] Failed to load server modules:', err.message);
    return false;
  }
}


// ---------------------------------------------------------------------------
// Emergency revert — baseline + broken-copy recovery (no git required)
// Uses the 'diff' package already in dependencies for change inspection
// ---------------------------------------------------------------------------
const SERVER_SOURCE_FILES = [
  'mcp-registration.js',
  'pulsar-edit-mcp-server.js',
  'ghidra-tools.js'
];
const PKG_DIR      = path.join(__dirname, '..');
const BASELINE_DIR = path.join(PKG_DIR, '.mcp-baseline');  // known-good, written once
const BROKEN_DIR   = path.join(PKG_DIR, '.mcp-broken');    // broken copy moved here on revert

try { fs.mkdirSync(BASELINE_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(BROKEN_DIR,   { recursive: true }); } catch (e) {}

// Save a manual backup of all server source files to .mcp-baseline/.
// Always overwrites — the user explicitly chose this moment as their known-good state.
// Returns an array of { name, hadPrevious, diffText } for display in the confirmation modal.
async function saveBackupFiles() {
  const results = [];
  for (const name of SERVER_SOURCE_FILES) {
    const src  = path.join(__dirname, name);
    const dest = path.join(BASELINE_DIR, name);
    let hadPrevious = false, diffText = null;
    try {
      const previous = await fs.promises.readFile(dest, 'utf8');
      hadPrevious = true;
      const live = await fs.promises.readFile(src, 'utf8');
      const patch = Diff.createPatch(name, previous, live);
      const changed = patch.split('\n').some(l => l.startsWith('+') || l.startsWith('-'));
      diffText = changed ? patch : null;
    } catch {}
    try {
      await fs.promises.copyFile(src, dest);
    } catch (e) {
      results.push({ name, error: e.message });
      continue;
    }
    results.push({ name, hadPrevious, diffText });
  }
  return results;
}

const { version } = require(path.join(__dirname, '..', 'package.json'));
const mcpServerPort = atom.config.get('pulsar-edit-mcp-server.mcpServerPort');

// Module-level reference so the express handler (which has no `this`) can access it
let linterRegistry = null;
let latestLinterMessages = [];
let chatPanelRef = null;   // set by activate(), read by the /mcp request handler

// Start MCP Server
const app = express();
app.use(express.json());
const transports = {};
app.post('/mcp', async (req, res) => {
  const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
  let transport;
  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => createUUID(),
      onsessioninitialized: (sessionId) => {
        transports[sessionId] = transport;
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
      }
    };
    const ok = await loadMcpModules();
    if (!ok) {
      res.status(503).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `MCP server modules failed to load: ${mcpModuleError?.message || 'unknown error'}. Use Packages > MCP Server > Emergency Revert to restore.`,
        },
        id: null,
      });
      return;
    }
    const mcpServer = new McpServer({
      name: "pulsar-edit-mcp-server-server",
      version: version
    });
    const groups = atom.config.get('pulsar-edit-mcp-server.toolGroups') || {};
    mcpRegistration(mcpServer, linterRegistry, () => latestLinterMessages, groups, chatPanelRef); // Register core editor tools
    if (groups.ghidra !== false) ghidraToolsRegistration(mcpServer); // Register Ghidra analysis tools
    await mcpServer.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

const handleSessionRequest = async (req, res) => {
  const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};
app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

// Start MCP client
const startMcpClient = async (chatPanel) => {
  const baseUrl = new URL('http://localhost:' + mcpServerPort + '/mcp');
  var mcpClient = new Client({
    name: "pulsar-edit-mcp-server-client",
    version: version
  });
  const clientTransport = new StreamableHTTPClientTransport(
    new URL(baseUrl)
  );
  await mcpClient.connect(clientTransport);
  console.log("MCP Client Connected");
  if (chatPanel) {
    chatPanel.setMcpClient(mcpClient);
  }
  return mcpClient;
}

// Start Pulsar Package
export default {
  pulsarMcpView: null,
  modalPanel: null,
  subscriptions: null,
  statusBarTile: null,
  listening: false,
  serverInstance: null,
  mcpClient: null,
  chatPanel: null,
  linterRegistry: null,

  async activate(state) {
    // Intercept console errors into a ring buffer so the emergency revert log
    // can capture what was happening when things broke. Installed once only.
    if (!window.__mcpConsoleErrors) {
      window.__mcpConsoleErrors = [];
      const _origError = console.error.bind(console);
      console.error = (...args) => {
        window.__mcpConsoleErrors.push(`[${new Date().toISOString()}] ${args.join(' ')}`);
        if (window.__mcpConsoleErrors.length > 200) window.__mcpConsoleErrors.shift();
        _origError(...args);
      };
    }
    /*
      Maybe someday add/remove should be different colors
        Add: rgba(80, 200, 120, 0.25);
        Remove: rgba(240, 80, 80, 0.25);
    */
    atom.styles.addStyleSheet(`
      atom-text-editor::shadow .mcp-diff-added,
      .mcp-diff-added-gutter {
        background-color: rgba(0, 117, 162, 0.25);
      }
      atom-text-editor::shadow .mcp-diff-removed,
      .mcp-diff-removed-gutter {
        background-color: rgba(0, 117, 162, 0.25);
      }
      `, { context: "atom-text-editor" });

    this.pulsarMcpView = new PulsarMcpView(state.pulsarMcpViewState);
    this.modalPanel = atom.workspace.addModalPanel({
      item: this.pulsarMcpView.getElement(),
      visible: false
    });
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:listen': () => this.listenToggle()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:restart': () => this.restartServer()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:disable-group': () => this.promptDisableGroup()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:emergency-revert': () => this.showEmergencyRevert()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:save-backup': () => this.saveBackup()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:show-edit-stats': () => this.showEditStats()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:show-chat-panel': () => {
        atom.workspace.open('atom://pulsar-edit-mcp-server/chat');
      }
    }));

    this.subscriptions.add(
      atom.workspace.addOpener(uri => {
        if (uri === 'atom://pulsar-edit-mcp-server/chat') {
          this.chatPanel = new ChatPanel();
          chatPanelRef = this.chatPanel;
          return this.chatPanel;
        }
      })
    );

    const showChat = atom.config.get('pulsar-edit-mcp-server.showChatPanel');
    if (showChat !== false) {
      await atom.workspace.open('atom://pulsar-edit-mcp-server/chat');
    }

    // If the panel was restored from a previous session (Pulsar workspace restore)
    // the opener above never fires, so chatPanelRef stays null. Scan pane items now.
    if (!chatPanelRef) {
      const existing = atom.workspace.getPaneItems().find(i => i instanceof ChatPanel);
      if (existing) chatPanelRef = existing;
    }

    // Auto-start server if configured — deferred until all services (status bar etc) are ready.
    // If initialPackages have already activated (e.g. chat panel open on boot slows activate()
    // enough that the event fires before we register), call restartServer() immediately instead.
    if (atom.config.get('pulsar-edit-mcp-server.autoStart')) {
      if (atom.packages.hasActivatedInitialPackages()) {
        this.restartServer();
      } else {
        atom.packages.onDidActivateInitialPackages(() => this.restartServer());
      }
    }

    // Auto-configure linter-gcc for live on-the-fly linting if it is installed
    // but has not been explicitly configured by the user. This gives new users
    // the same live-squiggle experience for C/C++ as linter-eslint gives for JS,
    // without requiring any manual setup.
    atom.packages.onDidActivateInitialPackages(() => {
      if (!atom.packages.getActivePackage('linter-gcc')) return;
      const defaults = {
        'linter-gcc.gccLintOnTheFly':         true,
        'linter-gcc.gccLintOnTheFlyInterval':  500,
      };
      for (const [key, value] of Object.entries(defaults)) {
        // Only set if the user has not already customised this key.
        // getUserValue() doesn't exist in Pulsar — use get() and compare to
        // the registered schema default as a proxy for "never touched".
        const schema    = atom.config.getSchema(key);
        const defVal    = schema ? schema.default : undefined;
        const curVal    = atom.config.get(key);
        if (curVal === defVal || curVal === undefined) {
          atom.config.set(key, value);
        }
      }
    });
  },

  deactivate() {
    // Flush lifetime stats before tearing down — most reliable save point on reload
    try { if (mcpDeactivate) mcpDeactivate(); } catch {}

    this.stopListening();
    this.modalPanel.destroy();
    this.subscriptions.dispose();
    this.pulsarMcpView.destroy();

    this.statusBarTile?.destroy();
    this.statusBarTile = null;
    this.statusBarElement = null;


  },

  serialize() {
    return {
      pulsarMcpViewState: this.pulsarMcpView.serialize()
    };
  },

  consumeStatusBar(statusBar) {
    this.setStatusbar(statusBar,true);
  },

  consumeLinterMessages(linterService) {
    console.log('Linter message service consumed — get-diagnostics will receive provider messages.');
    linterService.observe((messages) => {
      latestLinterMessages = messages || [];
    });
  },

  consumeLinter(registry) {
    console.log('Linter service consumed — get-diagnostics will be registered.');
    linterRegistry = registry;
    this.linterRegistry = registry;
  },

  listenToggle() {
    console.log('PulsarMcp was toggled!');
    if (this.listening) {
      this.stopListening();
      this.listening = false;
    } else {
      this.serverInstance = app.listen(mcpServerPort);
      this.listening = true;
      startMcpClient(this.chatPanel).then(client => { this.mcpClient = client; });
    }
    this.setStatusbar(this.statusBarTile,this.listening);
  },

  async restartServer() {
    console.log('PulsarMcp restarting...');
    if (this.listening && this.serverInstance) {
      await new Promise(resolve => this.serverInstance.close(resolve));
      for (const sessionId of Object.keys(transports)) {
        try { transports[sessionId].close(); } catch (e) { /* ignore */ }
        delete transports[sessionId];
      }
      this.serverInstance = null;
      this.listening = false;
    }
    this.serverInstance = app.listen(mcpServerPort);
    this.listening = true;
    this.mcpClient = await startMcpClient(this.chatPanel);
    this.setStatusbar(this.statusBarTile, true);
    atom.notifications.addSuccess('MCP Server restarted successfully.');
    console.log('PulsarMcp restarted.');
  },

  stopListening() {
    // Close all active MCP sessions so they don't re-register tools on the next connect
    for (const sessionId of Object.keys(transports)) {
      try { transports[sessionId].close(); } catch (e) { /* ignore */ }
      delete transports[sessionId];
    }
    if (this.serverInstance != null) {
      this.serverInstance.close(() => console.log('Server stopped listening.'));
      this.serverInstance = null;
    }
  },

  setStatusbar(statusBar,status) {
    if (this.statusBarTile === null) {
      this.statusBarElement = document.createElement('span');
      this.statusBarTile = statusBar;
      this.statusBarTile.addLeftTile({item: this.statusBarElement, priority: 100});
      this.statusBarElement.addEventListener('click', () => {
        this.listenToggle();
      });
    }
    this.statusBarElement.textContent = 'MCP:' + (status ? "On" : "Off");
  },

  async showEmergencyRevert() {
    const Diff = require('diff');

    // Build status for each source file — compare live vs baseline
    const fileStatuses = await Promise.all(SERVER_SOURCE_FILES.map(async (name) => {
      const livePath     = path.join(__dirname, name);
      const baselinePath = path.join(BASELINE_DIR, name);
      let hasBaseline = false, diffText = null, liveContent = '', baselineContent = '';
      try { baselineContent = await fs.promises.readFile(baselinePath, 'utf8'); hasBaseline = true; } catch {}
      try { liveContent     = await fs.promises.readFile(livePath,     'utf8'); } catch {}
      if (hasBaseline && liveContent) {
        const patch = Diff.createPatch(name, baselineContent, liveContent);
        diffText = patch.split('\n').slice(4).join('\n').trim() || null; // null = identical
      }
      return { name, hasBaseline, diffText, liveContent, baselineContent };
    }));

    const panel = atom.workspace.addModalPanel({
      item: (() => {
        const el = document.createElement('div');
        el.style.cssText = 'padding:16px;max-height:80vh;overflow-y:auto;min-width:600px;font-family:sans-serif';

        const title = document.createElement('div');
        title.style.cssText = 'font-size:1.1em;font-weight:bold;margin-bottom:4px;color:#e06c75';
        title.textContent = '⚠ MCP Emergency Revert';
        el.appendChild(title);

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:0.82em;margin-bottom:14px;opacity:0.7';
        sub.textContent = 'Broken file is moved to .mcp-broken/ for inspection. Baseline is restored. Server restarts in 2s.';
        el.appendChild(sub);

        for (const { name, hasBaseline, diffText, baselineContent } of fileStatuses) {
          const section = document.createElement('div');
          section.style.cssText = 'margin-bottom:14px;border:1px solid #444;border-radius:4px;overflow:hidden';

          // Header row
          const header = document.createElement('div');
          header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:#2a2a2a';

          const nameEl = document.createElement('span');
          nameEl.style.cssText = 'font-weight:bold;font-family:monospace;flex:1';
          nameEl.textContent = name;
          header.appendChild(nameEl);

          // Status badge
          const badge = document.createElement('span');
          badge.style.cssText = 'font-size:0.75em;padding:2px 7px;border-radius:3px;font-weight:bold';
          if (!hasBaseline)      { badge.textContent = 'NO BASELINE'; badge.style.background = '#555'; }
          else if (!diffText)    { badge.textContent = 'UNCHANGED';   badge.style.background = '#2d6a2d'; }
          else                   { badge.textContent = 'MODIFIED';    badge.style.background = '#7a3a1a'; }
          header.appendChild(badge);

          // Restore button — only if baseline exists and file differs
          if (hasBaseline && diffText) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-error';
            btn.style.cssText = 'font-size:0.78em;padding:2px 10px';
            btn.textContent = 'Restore Baseline';
            btn.addEventListener('click', async () => {
              btn.disabled = true; btn.textContent = 'Restoring...';
              try {
                const ts        = new Date().toISOString().replace(/[:.]/g, '-');
                const livePath  = path.join(__dirname, name);
                const brokenDst = path.join(BROKEN_DIR, `${name}.${ts}.broken`);
                await fs.promises.copyFile(livePath, brokenDst);                    // save broken copy
                await fs.promises.copyFile(path.join(BASELINE_DIR, name), livePath); // restore baseline
                // Write diagnostic log alongside the broken file
                try {
                  const logLines = [
                    `=== MCP Emergency Revert Log ===`,
                    `Timestamp : ${new Date().toISOString()}`,
                    `File      : ${name}`,
                    `Broken    : ${brokenDst}`,
                    `Baseline  : ${path.join(BASELINE_DIR, name)}`,
                    `MCP Port  : ${mcpServerPort}`,
                    ``,
                    `=== Pulsar Console Errors ===`,
                    ...((window.__mcpConsoleErrors || []).length > 0
                      ? (window.__mcpConsoleErrors || [])
                      : ['(none captured — open DevTools console for full log)']),
                    ``,
                    `=== Diff vs Baseline at time of revert ===`,
                    diffText || '(files were identical — revert may have been triggered manually)'
                  ];
                  const logDst = path.join(BROKEN_DIR, `${name}.${ts}.log`);
                  await fs.promises.writeFile(logDst, logLines.join('\n'), 'utf8');
                } catch (logErr) {
                  console.warn('[MCP revert] Could not save log:', logErr.message);
                }
                // Update open buffer if the file is open in Pulsar
                const openEditor = atom.workspace.getTextEditors()
                  .find(e => e.getPath() && path.resolve(e.getPath()) === path.resolve(livePath));
                if (openEditor) openEditor.getBuffer().setText(baselineContent);
                atom.notifications.addSuccess(`Restored ${name} from baseline`, {
                  detail: `Broken copy saved to .mcp-broken/${name}.${ts}.broken\nServer restarting in 2 seconds...`
                });
                panel.destroy();
                setTimeout(() => {
                  try { this.restartServer(); } catch(e) {
                    atom.notifications.addWarning('Server restart failed — use Ctrl+Alt+O to restart manually.');
                  }
                }, 2000);
              } catch (err) {
                btn.disabled = false; btn.textContent = 'Restore Baseline';
                atom.notifications.addError(`Revert failed: ${err.message}`);
              }
            });
            header.appendChild(btn);
          }
          section.appendChild(header);

          // Inline diff — shown when file is modified
          if (diffText) {
            const pre = document.createElement('pre');
            pre.style.cssText = 'margin:0;padding:8px 10px;font-size:0.75em;overflow-x:auto;max-height:200px;background:#1a1a1a;line-height:1.4';
            pre.innerHTML = diffText.split('\n').map(line => {
              const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;');
              if (line.startsWith('+')) return `<span style="color:#98c379">${esc}</span>`;
              if (line.startsWith('-')) return `<span style="color:#e06c75">${esc}</span>`;
              if (line.startsWith('@')) return `<span style="color:#61afef">${esc}</span>`;
              return `<span style="opacity:0.5">${esc}</span>`;
            }).join('\n');
            section.appendChild(pre);
          }
          el.appendChild(section);
        }

        const cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.style.cssText = 'margin-top:4px;width:100%';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => panel.destroy());
        el.appendChild(cancel);
        return el;
      })(),
      visible: true
    });
  },

  async saveBackup() {
    const timestamp = new Date().toLocaleString();
    const results = await saveBackupFiles();

    const panel = atom.workspace.addModalPanel({
      item: (() => {
        const el = document.createElement('div');
        el.style.cssText = 'padding:16px;max-height:80vh;overflow-y:auto;min-width:560px;font-family:sans-serif;font-size:1.1em;background:#21252b;border-radius:6px';

        const title = document.createElement('div');
        title.style.cssText = 'font-size:1.2em;font-weight:bold;margin-bottom:4px;color:#98c379';
        title.textContent = '💾 Backup Saved';
        el.appendChild(title);

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:0.82em;margin-bottom:14px;opacity:0.6';
        sub.textContent = `Saved at ${timestamp}. These files are now the baseline for Emergency Revert.`;
        el.appendChild(sub);

        for (const result of results) {
          const row = document.createElement('div');
          row.style.cssText = 'margin-bottom:10px;border:1px solid #444;border-radius:4px;overflow:hidden';

          const hdr = document.createElement('div');
          hdr.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2a2a2a';

          const name = document.createElement('span');
          name.style.cssText = 'font-weight:bold;font-family:monospace;flex:1';
          name.textContent = result.name;
          hdr.appendChild(name);

          const badge = document.createElement('span');
          badge.style.cssText = 'font-size:0.75em;padding:2px 7px;border-radius:3px;font-weight:bold;';
          if (result.error) {
            badge.textContent = 'FAILED';
            badge.style.background = '#7a2a2a';
          } else if (!result.hadPrevious) {
            badge.textContent = 'NEW';
            badge.style.background = '#2d5a8a';
          } else if (result.diffText) {
            badge.textContent = 'UPDATED';
            badge.style.background = '#2d6a2d';
          } else {
            badge.textContent = 'UNCHANGED';
            badge.style.background = '#444';
          }
          hdr.appendChild(badge);
          row.appendChild(hdr);

          if (result.error) {
            const err = document.createElement('div');
            err.style.cssText = 'padding:5px 10px;font-size:0.85em;font-family:monospace;color:#e06c75;background:#1a1a1a';
            err.textContent = result.error;
            row.appendChild(err);
          } else if (result.diffText) {
            const diff = document.createElement('pre');
            diff.style.cssText = 'margin:0;padding:6px 10px;font-size:0.78em;background:#1a1a1a;max-height:120px;overflow-y:auto;line-height:1.5';
            diff.textContent = result.diffText.split('\n').slice(4, 24).join('\n');
            row.appendChild(diff);
          }

          el.appendChild(row);
        }

        const ok = document.createElement('button');
        ok.className = 'btn btn-primary';
        ok.style.cssText = 'margin-top:8px;width:100%';
        ok.textContent = 'OK';
        ok.addEventListener('click', () => panel.destroy());
        el.appendChild(ok);
        return el;
      })(),
      visible: true
    });
  },

  showEditStats() {
    let mcpReg;
    try {
      mcpReg = require('./mcp-registration.js');
    } catch (err) {
      atom.notifications.addError(
        'MCP Edit Stats unavailable — mcp-registration.js failed to load.',
        { detail: err.message + '\n\nUse Packages > MCP Server > Emergency Revert to restore.' }
      );
      return;
    }
    const stats  = mcpReg.getEditStats();
    const s      = stats.session;
    const l      = stats.lifetime;
    let   paused = stats.paused;

    const panel = atom.workspace.addModalPanel({
      item: (() => {
        const el = document.createElement('div');
        el.style.cssText = 'padding:16px;max-height:80vh;overflow-y:auto;min-width:760px;max-width:900px;font-family:sans-serif;font-size:1.1em;background:#21252b;border-radius:6px';

        // Derive tool list from editStats keys — skip summary/meta strings and non-tool objects.
        // A valid tool entry has a numeric 'hits' property.
        const tools = Object.keys(s)
          .filter(key => s[key] && typeof s[key] === 'object' && typeof s[key].hits === 'number')
          .map(key => ({
            key,
            label: key.replace(/_/g, '-'),
          }));

        function makeSection(title, summary, statsObj, accent) {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'margin-bottom:16px';

          const hdr = document.createElement('div');
          hdr.style.cssText = `font-size:1em;font-weight:bold;margin-bottom:3px;color:${accent}`;
          hdr.textContent = title;
          wrap.appendChild(hdr);

          const sumEl = document.createElement('div');
          sumEl.style.cssText = 'font-size:0.85em;margin-bottom:8px;opacity:0.75';
          sumEl.textContent = summary;
          wrap.appendChild(sumEl);

          for (const { key, label } of tools) {
            const t = statsObj[key];
            if (!t) continue;

            const section = document.createElement('div');
            section.style.cssText = 'margin-bottom:8px;border:1px solid #444;border-radius:4px;overflow:hidden';

            const header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 10px;background:#2a2a2a';

            const nameEl = document.createElement('span');
            nameEl.style.cssText = 'font-weight:bold;font-family:monospace;flex:1';
            nameEl.textContent = label;
            header.appendChild(nameEl);

            const total = t.hits + (t.failTotal ?? t.missTotal ?? 0);
            const pct   = total > 0 ? Math.round((t.hits / total) * 100) : 100;
            const badge = document.createElement('span');
            const negCount = t.failTotal ?? t.missTotal ?? null;
            const negLabel = t.missTotal !== undefined ? 'misses' : 'fails';
            // hits-only tools (e.g. replace_document) show no fail count
            const badgeText = negCount !== null
              ? `${t.hits} hits / ${negCount} ${negLabel}`
              : `${t.hits} hits`;
            const badgeColor = t.missTotal !== undefined
              ? '#2a4a6a'
              : negCount === null || pct >= 90 ? '#2d6a2d'
              : pct >= 70 ? '#7a5a1a' : '#7a2a2a';
            badge.style.cssText = `font-size:0.75em;padding:2px 7px;border-radius:3px;font-weight:bold;background:${badgeColor}`;
            badge.textContent = badgeText;
            header.appendChild(badge);
            section.appendChild(header);

            const body = document.createElement('div');
            body.style.cssText = 'padding:6px 10px;font-size:0.85em;font-family:monospace;background:#1a1a1a;line-height:1.6';

            const rows = [];
            // Fails — expand each non-zero key on its own line for readability
            if (t.fails) {
              const failEntries = Object.entries(t.fails).filter(([,v]) => v > 0);
              if (failEntries.length)
                rows.push(`fails: ` + failEntries.map(([k,v]) => `${k}:${v}`).join('  '));
            }
            if (t.misses) {
              const missEntries = Object.entries(t.misses).filter(([,v]) => v > 0);
              if (missEntries.length)
                rows.push(`misses: ` + missEntries.map(([k,v]) => `${k}:${v}`).join('  '));
            }
            // Hints — only show non-zero ones
            if (t.hintsUsed) {
              const hintEntries = Object.entries(t.hintsUsed).filter(([,v]) => v > 0);
              if (hintEntries.length)
                rows.push(`hints: ` + hintEntries.map(([k,v]) => `${k}:${v}`).join('  '));
            }
            if (t.fuzzyWhitespaceCommits)   rows.push(`fuzzyCommits: ${t.fuzzyWhitespaceCommits}`);
            if (t.avgOldStrLines !== undefined && t.hits > 0) rows.push(`avgOldStrLines: ${t.avgOldStrLines}`);
            if (t.dryRuns)                  rows.push(`dryRuns: ${t.dryRuns}`);
            if (t.largeEditWarnings)        rows.push(`largeEditWarnings: ${t.largeEditWarnings}`);

            if (rows.length) {
              body.innerHTML = rows.map(r => `<div style="opacity:0.85">${r.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`).join('');
              section.appendChild(body);
            }
            wrap.appendChild(section);
          }
          return wrap;
        }

        // ── Paused badge ─────────────────────────────────────────────────
        const pausedBadge = document.createElement('div');
        pausedBadge.style.cssText = 'display:none;margin-bottom:10px;padding:5px 12px;border-radius:4px;background:#7a6000;color:#ffe066;font-weight:bold;font-size:0.95em';
        pausedBadge.textContent = '⏸ STATS PAUSED — tool hits/fails are not being recorded';
        if (paused) pausedBadge.style.display = 'block';
        el.appendChild(pausedBadge);

        el.appendChild(makeSection(
          '📊 Session',
          `${s.sessionEditSummary}  |  ${s.sessionSearchSummary}`,
          s,
          '#98c379'
        ));

        el.appendChild(makeSection(
          `📈 Lifetime  (${l.lifetimeSessionCount} session${l.lifetimeSessionCount === 1 ? '' : 's'})`,
          `${l.lifetimeEditSummary}  |  ${l.lifetimeSearchSummary}`,
          l,
          '#61afef'
        ));

        // ── Style checks section ──────────────────────────────────────────
        const ssSum = s.sessionStyleSummary;
        const lsSum = l.lifetimeStyleSummary;
        if (ssSum || lsSum) {
          const styleWrap = document.createElement('div');
          styleWrap.style.cssText = 'margin-top:8px;border:1px solid #444;border-radius:4px;overflow:hidden';

          const styleHeader = document.createElement('div');
          styleHeader.style.cssText = 'padding:6px 10px;font-weight:bold;background:#3a2a4a;color:#c678dd';
          styleHeader.textContent = '🎨 Style checks';
          styleWrap.appendChild(styleHeader);

          const styleBody = document.createElement('div');
          styleBody.style.cssText = 'padding:6px 10px;font-size:0.88em;font-family:monospace;background:#1a1a1a;line-height:1.7';

          const styleRows = [];
          if (ssSum) styleRows.push(`session:  ${ssSum}`);
          if (lsSum) styleRows.push(`lifetime: ${lsSum}`);
          const sc = s.styleChecks;
          if (sc && sc.byRule && Object.keys(sc.byRule).length) {
            const sorted = Object.entries(sc.byRule).sort((a, b) => b[1] - a[1]);
            styleRows.push(`top violations (session):`);
            sorted.slice(0, 8).forEach(([rule, n]) => styleRows.push(`  ${rule}: ${n}`));
          }
          styleBody.innerHTML = styleRows
            .map(r => `<div style="opacity:0.85">${r.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`)
            .join('');
          styleWrap.appendChild(styleBody);
          el.appendChild(styleWrap);
        }

        // Buttons row
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px';

        const pauseBtn = document.createElement('button');
        pauseBtn.className = paused ? 'btn btn-success' : 'btn btn-warning';
        pauseBtn.style.cssText = 'flex:1';
        pauseBtn.textContent = paused ? '▶ Resume Stats' : '⏸ Pause Stats';
        pauseBtn.addEventListener('click', () => {
          paused = mcpReg.toggleStatsPause();
          pauseBtn.textContent = paused ? '▶ Resume Stats' : '⏸ Pause Stats';
          pauseBtn.className   = paused ? 'btn btn-success' : 'btn btn-warning';
          pausedBadge.style.display = paused ? 'block' : 'none';
        });
        btnRow.appendChild(pauseBtn);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn btn-warning';
        resetBtn.style.cssText = 'flex:1';
        resetBtn.textContent = 'End Session (flush lifetime + reset)';
        resetBtn.addEventListener('click', () => {
          mcpReg.resetEditStats();
          panel.destroy();
          atom.notifications.addInfo('MCP edit stats: session flushed to lifetime and reset.');
        });
        btnRow.appendChild(resetBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn';
        closeBtn.style.cssText = 'flex:1';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => panel.destroy());
        btnRow.appendChild(closeBtn);

        el.appendChild(btnRow);
        return el;
      })(),
      visible: true
    });
  },

  promptDisableGroup() {
    const currentGroups = atom.config.get('pulsar-edit-mcp-server.toolGroups') || {};
    const enabledGroups = TOGGLEABLE_GROUPS.filter(g => currentGroups[g] !== false);

    if (enabledGroups.length === 0) {
      atom.notifications.addInfo('MCP: All toggleable groups are already disabled.');
      return;
    }

    const items = enabledGroups.map(g => {
      const count = TOOL_CATALOGUE.filter(t => t.group === g).length;
      return { text: `${g}  (${count} tools)`, value: g };
    });

    const panel = atom.workspace.addModalPanel({
      item: (() => {
        const el = document.createElement('div');
        el.style.padding = '12px';
        el.innerHTML = `<div style="margin-bottom:8px;font-weight:bold">Disable MCP tool group (takes effect after reconnect):</div>`;
        items.forEach(item => {
          const btn = document.createElement('button');
          btn.className = 'btn btn-default';
          btn.style.display = 'block';
          btn.style.width = '100%';
          btn.style.marginBottom = '4px';
          btn.style.textAlign = 'left';
          btn.textContent = item.text;
          btn.addEventListener('click', () => {
            const updated = { ...currentGroups, [item.value]: false };
            atom.config.set('pulsar-edit-mcp-server.toolGroups', updated);
            atom.notifications.addSuccess(
              `MCP: '${item.value}' group disabled. Reconnect your AI client to apply.`,
              { detail: 'The group will not be registered on the next MCP session.' }
            );
            panel.destroy();
          });
          el.appendChild(btn);
        });
        const cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.style.marginTop = '8px';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => panel.destroy());
        el.appendChild(cancel);
        return el;
      })(),
      visible: true
    });
  },

};

// Pulsar uses older node js, the crypto randomUUID wasn't working
// Found at https://stackoverflow.com/questions/105034/how-do-i-create-a-guid-uuid
function createUUID() {
  // http://www.ietf.org/rfc/rfc4122.txt
  var s = [];
  var hexDigits = "0123456789abcdef";
  for (var i = 0; i < 36; i++) {
    s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
  }
  s[14] = "4";  // bits 12-15 of the time_hi_and_version field to 0010
  s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);  // bits 6-7 of the clock_seq_hi_and_reserved to 01
  s[8] = s[13] = s[18] = s[23] = "-";

  var uuid = s.join("");
  return uuid;
}
