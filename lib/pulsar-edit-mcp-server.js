'use babel';

const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const PulsarMcpView = require('./pulsar-edit-mcp-server-view');
const { CompositeDisposable } = require('atom');
const path = require("path");
const fs = require("fs");
const Diff = require("diff");
const ChatPanel = require('./chat-panel');
const { initStats } = require('./edit-stats');
// Shared HTML escaper — covers &, <, >, ", ' to prevent attribute/tag injection.
const escapeHTML = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
// so that a syntax error in those files does not prevent activate() from running.
// This keeps the emergency-revert and show-edit-stats commands always available.
let mcpRegistration = null;
const { TOOL_CATALOGUE, TOGGLEABLE_GROUPS } = require('./tool-catalogue');
let mcpModuleError = null;
let mcpDeactivate = null;   // lifetime stats flush — assigned when mcp-registration loads

function loadMcpModules() {
  // Flush stats from the previous module instance before re-importing.
  // The hot-reload window (save → new module evaluates → loadLifetimeStats reads disk)
  // is shorter than the 5s interval, so the old instance's in-session counts would be
  // lost without an explicit flush here. mcpDeactivate is null on the very first load.
  if (mcpDeactivate) {
    try { mcpDeactivate(); } catch {}
  }
  try {
    // Delete cached modules so hot-reload gets fresh copies.
    // tool-framework.js and schema.js are dependencies of mcp-registration.js
    // and must also be invalidated, otherwise changes to them are silently ignored.
    const bust = (p) => { try { delete require.cache[require.resolve(p)]; } catch {} };
    bust('./mcp-registration.js');
    bust('./tool-framework.js');
    bust('./schema.js');
    const reg = require('./mcp-registration.js');
    mcpRegistration      = reg.mcpRegistration;
    mcpDeactivate        = reg.deactivate || null;  // B13: capture so pre-reload flush fires on hot-reload
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
    const ok = loadMcpModules();
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
    await initStats();
    mcpRegistration(mcpServer, linterRegistry, () => latestLinterMessages, groups, chatPanelRef); // Register core editor tools
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
module.exports = {
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
      'pulsar-edit-mcp-server:show-fault-log': () => this.showFaultLog()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:show-last-edited-file': () => this.showLastEditedFile()
    }));

    this.subscriptions.add(
      atom.commands.add('atom-workspace', {
      'pulsar-edit-mcp-server:toggle-focus-edited-file': () => this.toggleFocusEditedFile()
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
          // If MCP client is already connected (panel opened after server start),
          // wire it up immediately — prevents the "not connected" banner.
          if (this.mcpClient) {
            this.chatPanel.setMcpClient(this.mcpClient);
          }
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
        const schema    = typeof atom.config.getSchema === 'function' ? atom.config.getSchema(key) : undefined;
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
      this.serverInstance.once('listening', () => {
        startMcpClient(this.chatPanel || chatPanelRef).then(client => { this.mcpClient = client; }).catch(e => {
          atom.notifications.addError('MCP client failed to connect', { detail: e.message });
        });
      });
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
    // Give the HTTP server a tick to fully bind before the client connects
    await new Promise(resolve => this.serverInstance.once('listening', resolve));
    this.mcpClient = await startMcpClient(this.chatPanel || chatPanelRef);
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
              const esc = escapeHTML(line);
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
    // Live-refresh helper — called once at open and then every second via setInterval.
    // Returns { s, l, paused } from a fresh mcpReg.getEditStats() call each time.
    function liveStats() {
      const stats = mcpReg.getEditStats();
      return { s: stats.session, l: stats.lifetime, paused: stats.paused };
    }
    let { s, l, paused } = liveStats();

    const panel = atom.workspace.addModalPanel({
      item: (() => {
        const el = document.createElement('div');
        el.style.cssText = 'padding:16px;max-height:80vh;overflow-y:auto;min-width:760px;max-width:900px;font-family:sans-serif;font-size:1.1em;background:#21252b;border-radius:6px';

        // Derive tool list from editStats keys — skip summary/meta strings and non-tool objects.
        // A valid tool entry has a numeric 'hits' property.
        const _tools = Object.keys(s)
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

          // ── Group definitions — order and membership ─────────────────────
          const GROUP_DEFS = [
            {
              groupKey: '_editGroup',
              label: '✏️  Edit tools',
              color: '#3a4a2a',
              keys: ['str_replace','insert','delete_line_range','replace_function_body',
                     'replace_block','apply_patch','replace_all','replace_document',
                     'replace_across_files','delete_block','sed'],
            },
            {
              groupKey: '_searchGroup',
              label: '🔍  Search tools',
              color: '#2a3a4a',
              keys: ['grep_file','grep_project','search_symbol','find_text',
                     'get_repo_map','get_structural_anchors',
                     'read_lines','get_region','get_selection','get_linter_messages'],
            },
            {
              groupKey: null,
              label: '🗂️  Nav / file tools',
              color: '#3a2a4a',
              keys: ['close_file','goto_focus','get_project_paths','add_project_path'],
            },
            {
              groupKey: '_reGroup',
              label: '🔬  RE / Ghidra tools',
              color: '#4a3a2a',
              keys: ['ghidra_list_functions','ghidra_search_functions','ghidra_get_function_body',
                     'ghidra_get_xrefs','ghidra_add_comment','ghidra_get_function_list_with_comments'],
            },
            {
              groupKey: '_cmdGroup',
              label: '⚡  Shell',
              color: '#2a3a3a',
              keys: ['run_command'],
            },
          ];

          for (const { groupKey, label: groupLabel, color, keys } of GROUP_DEFS) {
            // Collect tools in this group that actually exist in statsObj
            const groupTools = keys
              .filter(k => statsObj[k] && typeof statsObj[k].hits === 'number')
              .sort((a, b) => a.localeCompare(b));
            if (groupTools.length === 0) continue;

            // ── Group header row ────────────────────────────────────────────
            const groupHdr = document.createElement('div');
            groupHdr.style.cssText = `display:flex;align-items:center;gap:8px;padding:5px 10px;`
              + `background:${color};border-radius:4px;margin-bottom:4px;margin-top:8px`;

            const groupLabel_el = document.createElement('span');
            groupLabel_el.style.cssText = 'font-weight:bold;font-family:sans-serif;font-size:0.9em;flex:1';
            groupLabel_el.textContent = groupLabel;
            groupHdr.appendChild(groupLabel_el);

            // Group pct badge — from _xxxGroup key if available
            if (groupKey && statsObj[groupKey]) {
              const g = statsObj[groupKey];
              const gpct = g.pct !== undefined ? g.pct : (g.total > 0 ? Math.round(g.hits / g.total * 100) : 100);
              const gBadge = document.createElement('span');
              const gColor = gpct >= 90 ? '#2d6a2d' : gpct >= 70 ? '#7a5a1a' : '#7a2a2a';
              gBadge.style.cssText = `font-size:0.78em;padding:2px 8px;border-radius:3px;font-weight:bold;background:${gColor}`;
              // Search group has misses (expected no-result) AND faults (genuine errors) — show both
              let badgeText;
              if (g.misses !== undefined && g.faults !== undefined) {
                badgeText = `${g.hits} hits / ${g.misses} misses / ${g.faults} faults  ${gpct}%`;
              } else {
                badgeText = `${g.hits} hits / ${g.total - g.hits} fails  ${gpct}%`;
              }
              gBadge.textContent = badgeText;
              groupHdr.appendChild(gBadge);
            }
            wrap.appendChild(groupHdr);

            // ── Tool rows ───────────────────────────────────────────────────
            for (const key of groupTools) {
              const t = statsObj[key];
              const label = key.replace(/_/g, '-');

              const section = document.createElement('div');
              section.style.cssText = 'margin-bottom:4px;border:1px solid #444;border-radius:4px;overflow:hidden;margin-left:8px';

              const header = document.createElement('div');
              header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px;background:#2a2a2a';

              const nameEl = document.createElement('span');
              nameEl.style.cssText = 'font-weight:bold;font-family:monospace;flex:1';
              nameEl.textContent = label;
              header.appendChild(nameEl);

              const total    = t.hits + (t.failTotal ?? t.missTotal ?? 0);
              const pct      = total > 0 ? Math.round((t.hits / total) * 100) : 100;
              const negCount = t.failTotal ?? t.missTotal ?? null;
              const negLabel = t.missTotal !== undefined ? 'misses' : 'fails';

              const badgeParts = [];
              if (negCount !== null) {
                badgeParts.push(`${t.hits} hits / ${negCount} ${negLabel}`);
                badgeParts.push(`${pct}%`);
              } else {
                badgeParts.push(`${t.hits} hits`);
              }

              const badge = document.createElement('span');
              const badgeColor = t.missTotal !== undefined
                ? '#2a4a6a'
                : negCount === null || pct >= 90 ? '#2d6a2d'
                : pct >= 70 ? '#7a5a1a' : '#7a2a2a';
              badge.style.cssText = `font-size:0.75em;padding:2px 7px;border-radius:3px;font-weight:bold;background:${badgeColor}`;
              badge.textContent = badgeParts.join('  ');
              header.appendChild(badge);
              section.appendChild(header);

              // Detail body — only shown when there's something non-zero to report
              const rows = [];
              if (t.fails) {
                const failEntries = Object.entries(t.fails).filter(([,v]) => v > 0);
                if (failEntries.length)
                  rows.push('fails: ' + failEntries.map(([k,v]) => `${k}:${v}`).join('  '));
              }
              if (t.misses) {
                const missEntries = Object.entries(t.misses).filter(([,v]) => v > 0);
                if (missEntries.length)
                  rows.push('misses: ' + missEntries.map(([k,v]) => `${k}:${v}`).join('  '));
              }
              if (t.hintsUsed) {
                const hintEntries = Object.entries(t.hintsUsed).filter(([,v]) => v > 0);
                if (hintEntries.length)
                  rows.push('hints: ' + hintEntries.map(([k,v]) => `${k}:${v}`).join('  '));
              }
              if (t.fuzzyWhitespaceCommits)   rows.push(`fuzzyWhitespace: ${t.fuzzyWhitespaceCommits}`);
              if (t.fuzzyContentCommits)      rows.push(`fuzzyContent: ${t.fuzzyContentCommits}`);
              if (t.autoStripCommentCommits)  rows.push(`autoStripComment: ${t.autoStripCommentCommits}`);
              if (t.autoPartialMatchCommits)  rows.push(`autoPartialMatch: ${t.autoPartialMatchCommits}`);
              if (t.rescuedCommits)           rows.push(`rescued: ${t.rescuedCommits}`);
              if (t.avgOldStrLines !== undefined && t.hits > 0) rows.push(`avgOldStrLines: ${t.avgOldStrLines}`);
              if (t.dryRuns)                 rows.push(`dryRuns: ${t.dryRuns}`);
              if (t.largeEditWarnings)       rows.push(`largeEditWarnings: ${t.largeEditWarnings}`);

              if (rows.length) {
                const body = document.createElement('div');
                body.style.cssText = 'padding:4px 10px 4px 18px;font-size:0.82em;font-family:monospace;background:#1a1a1a;line-height:1.6';
                body.innerHTML = rows.map(r =>
                  `<div style="opacity:0.85">${escapeHTML(r)}</div>`
                ).join('');
                section.appendChild(body);
              }

              wrap.appendChild(section);
            }
          }

          return wrap;
        }

        // ── Paused badge ─────────────────────────────────────────────────
        const pausedBadge = document.createElement('div');
        pausedBadge.style.cssText = 'display:none;margin-bottom:10px;padding:5px 12px;border-radius:4px;background:#7a6000;color:#ffe066;font-weight:bold;font-size:0.95em';
        pausedBadge.textContent = '⏸ STATS PAUSED — tool hits/fails are not being recorded';
        if (paused) pausedBadge.style.display = 'block';
        el.appendChild(pausedBadge);

        // ── Live-refresh containers ──────────────────────────────────────
        const sessionContainer  = document.createElement('div');
        const lifetimeContainer = document.createElement('div');
        el.appendChild(sessionContainer);
        el.appendChild(lifetimeContainer);

        function render() {
          const live = liveStats();
          paused = live.paused;
          pausedBadge.style.display = paused ? 'block' : 'none';

          sessionContainer.innerHTML  = '';
          lifetimeContainer.innerHTML = '';
          sessionContainer.appendChild(makeSection(
            '📊 Session',
            `${live.s.sessionEditSummary}  |  ${live.s.sessionSearchSummary}`,
            live.s, '#98c379'
          ));
          lifetimeContainer.appendChild(makeSection(
            `📈 Lifetime  (${live.l.lifetimeSessionCount} session${live.l.lifetimeSessionCount === 1 ? '' : 's'})`,
            `${live.l.lifetimeEditSummary}  |  ${live.l.lifetimeSearchSummary}`,
            live.l, '#61afef'
          ));
        }
        render();
        const _refreshTimer = setInterval(render, 1000);

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
            .map(r => `<div style="opacity:0.85">${escapeHTML(r)}</div>`)
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
        resetBtn.textContent = '🔄 Flush Session Stats';
        resetBtn.addEventListener('click', () => {
          mcpReg.resetEditStats();
          clearInterval(_refreshTimer); panel.destroy();
          atom.notifications.addInfo('MCP edit stats: session flushed to lifetime and reset.');
        });
        btnRow.appendChild(resetBtn);

        const resetLifetimeBtn = document.createElement('button');
        resetLifetimeBtn.className = 'btn btn-error';
        resetLifetimeBtn.style.cssText = 'flex:1';
        resetLifetimeBtn.textContent = '🗑 Reset Lifetime';
        resetLifetimeBtn.addEventListener('click', () => {
          if (!confirm('Reset ALL lifetime stats? This cannot be undone.')) return;
          mcpReg.resetLifetimeStats();
          atom.notifications.addWarning('MCP edit stats: lifetime stats cleared.');
        });
        btnRow.appendChild(resetLifetimeBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn';
        closeBtn.style.cssText = 'flex:1';
        closeBtn.textContent = 'Close';
        closeBtn.addEventListener('click', () => { clearInterval(_refreshTimer); panel.destroy(); });
        btnRow.appendChild(closeBtn);

        el.appendChild(btnRow);
        return el;
      })(),
      visible: true
    });
  },

  toggleFocusEditedFile() {
    const key = 'pulsar-edit-mcp-server.focusEditedFile';
    const current = atom.config.get(key) !== false;
    atom.config.set(key, !current);
    atom.notifications.addInfo(
      `MCP: Focus edited file ${!current ? 'enabled' : 'disabled'} — ` +
      (!current ? 'edited tabs will come to front after each commit.'
                : 'edits will happen in background without switching tabs.')
    );
  },

  showLastEditedFile() {
    let mcpReg;
    try {
      mcpReg = require('./mcp-registration.js');
    } catch (err) {
      atom.notifications.addError('MCP: could not load mcp-registration.js', { detail: err.message });
      return;
    }
    const filePath = mcpReg.getLastEditedFilePath();
    if (!filePath) {
      atom.notifications.addInfo('MCP: No file has been edited yet this session.');
      return;
    }
    atom.workspace.open(filePath, { activateItem: true, searchAllPanes: true });
  },

  showFaultLog() {
    const PKG_PATH = atom.packages.getLoadedPackage('pulsar-edit-mcp-server').path;
    const LOG_PATH = require('path').join(PKG_PATH, 'session', 'session-faults.ndjson');

    // ── read + parse NDJSON ───────────────────────────────────────────────
    let allEntries = [];
    try {
      const raw = require('fs').readFileSync(LOG_PATH, 'utf8');
      allEntries = raw.split('\n').filter(Boolean).map(line => {
        try { return JSON.parse(line); } catch (_) { return null; }
      }).filter(Boolean);
    } catch (_) {
      // file may not exist yet
    }

    const el = document.createElement('div');
    el.style.cssText = 'position:relative;padding:16px;max-height:80vh;overflow-y:auto;min-width:800px;max-width:1000px;font-family:sans-serif;font-size:1.05em;background:#21252b;border-radius:6px;color:#abb2bf';

    // ── title ─────────────────────────────────────────────────────────────
    const title = document.createElement('div');
    title.textContent = '🪲 Fault Log';
    title.style.cssText = 'font-size:1.3em;font-weight:bold;margin-bottom:12px;color:#e06c75';
    el.appendChild(title);

    // ── filter row ────────────────────────────────────────────────────────
    const filterRow = document.createElement('div');
    filterRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;align-items:center;flex-wrap:wrap';

    const mkInput = (placeholder, width) => {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = placeholder;
      inp.classList.add('input-text', 'native-key-bindings');
      inp.style.cssText = `width:${width};background:#2c313a;color:#abb2bf;border:1px solid #3e4451;border-radius:3px;padding:4px 8px`;
      return inp;
    };
    const toolFilter   = mkInput('Filter tool…',   '160px');
    const reasonFilter = mkInput('Filter reason…', '160px');
    const fileFilter   = mkInput('Filter file…',   '260px');

    const countBadge = document.createElement('span');
    countBadge.style.cssText = 'margin-left:auto;color:#98c379;font-size:0.95em';

    filterRow.appendChild(toolFilter);
    filterRow.appendChild(reasonFilter);
    filterRow.appendChild(fileFilter);
    filterRow.appendChild(countBadge);
    el.appendChild(filterRow);

    // ── table ─────────────────────────────────────────────────────────────
    const tableWrap = document.createElement('div');
    tableWrap.style.cssText = 'overflow-x:auto;margin-bottom:12px';
    el.appendChild(tableWrap);

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.92em';

    const thead = document.createElement('thead');
    const hdrRow = document.createElement('tr');
    ['#', 'Time', 'Tool', 'Reason', 'File', 'Line', 'Detail'].forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      th.style.cssText = 'text-align:left;padding:5px 8px;border-bottom:1px solid #3e4451;color:#61afef;white-space:nowrap;position:sticky;top:0;background:#21252b';
      if (i === 4) th.style.maxWidth = '200px'; // File col
      if (i === 6) th.style.maxWidth = '300px'; // Detail col
      hdrRow.appendChild(th);
    });
    thead.appendChild(hdrRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    tableWrap.appendChild(table);

    // ── render table body ─────────────────────────────────────────────────
    function renderTable() {
      const tTool   = toolFilter.value.trim().toLowerCase();
      const tReason = reasonFilter.value.trim().toLowerCase();
      const tFile   = fileFilter.value.trim().toLowerCase();
      const filtered = allEntries.filter(e => {
        if (tTool   && !(e.tool   || '').toLowerCase().includes(tTool))   return false;
        if (tReason && !(e.reason || '').toLowerCase().includes(tReason)) return false;
        if (tFile   && !(e.filePath || '').toLowerCase().includes(tFile)) return false;
        return true;
      });
      countBadge.textContent = `${filtered.length} / ${allEntries.length} entries`;
      tbody.innerHTML = '';
      if (filtered.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 7;
        td.textContent = allEntries.length === 0 ? '(no failures logged yet)' : '(no matches)';
        td.style.cssText = 'padding:12px 8px;color:#5c6370;text-align:center';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      // Show newest-first
      const rows = filtered.slice().reverse();
      rows.forEach((e, idx) => {
        const rowNum = filtered.length - idx;
        const tr = document.createElement('tr');
        const baseBg = idx % 2 === 0 ? '#282c34' : '#21252b';
        tr.style.cssText = `background:${baseBg};cursor:pointer`;
        tr.addEventListener('mouseenter', () => { tr.style.background = '#2c3240'; });
        tr.addEventListener('mouseleave', () => { tr.style.background = baseBg; });
        tr.addEventListener('click', () => showEntryDetail(e, rowNum));
        const ts   = e.ts ? new Date(e.ts).toLocaleTimeString() : '–';
        const file = e.filePath ? require('path').basename(e.filePath) : '–';
        const line = e.nearLine != null ? String(e.nearLine) : '–';
        const skip = new Set(['ts','tool','reason','filePath','nearLine']);
        const hasExtra = Object.keys(e).some(k => !skip.has(k));
        const cells = [String(rowNum), ts, e.tool || '–', e.reason || '–', file, line, hasExtra ? '🔍 click to expand' : '–'];
        cells.forEach((val, ci) => {
          const td = document.createElement('td');
          td.textContent = val;
          td.style.cssText = 'padding:4px 8px;border-bottom:1px solid #2c313a;white-space:nowrap;vertical-align:middle';
          if (ci === 4) { td.title = e.filePath || ''; td.style.maxWidth = '200px'; td.style.overflow = 'hidden'; td.style.textOverflow = 'ellipsis'; }
          if (ci === 6) { td.style.color = '#5c6370'; td.style.fontSize = '0.9em'; }
          if (ci === 3) { td.style.color = '#e5c07b'; }  // reason: amber
          if (ci === 2) { td.style.color = '#56b6c2'; }  // tool: cyan
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    // ── detail overlay — renders inside el, no second modal ──────────────
    function showEntryDetail(e, rowNum) {
      // Build overlay that covers the list inside the same modal element
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:absolute;inset:0;background:#21252b;border-radius:6px;padding:20px;overflow-y:auto;z-index:10;display:flex;flex-direction:column;gap:0';

      // ── back button row ──────────────────────────────────────────────
      const backBtn = document.createElement('button');
      backBtn.className = 'btn';
      backBtn.textContent = '← Back to list';
      backBtn.style.cssText = 'align-self:flex-start;margin-bottom:14px';
      backBtn.addEventListener('click', () => overlay.remove());
      overlay.appendChild(backBtn);

      // ── title ────────────────────────────────────────────────────────
      const dtitle = document.createElement('div');
      dtitle.style.cssText = 'font-size:1.2em;font-weight:bold;margin-bottom:14px;color:#e06c75';
      dtitle.textContent = '\uD83E\uDEB2 Entry #' + rowNum + ' \u2014 ' + (e.tool || '?') + ' / ' + (e.reason || '?');
      overlay.appendChild(dtitle);

      // ── field grid ───────────────────────────────────────────────────
      const FIELD_ORDER = ['ts', 'tool', 'reason', 'filePath', 'nearLine'];
      const allKeys = [...FIELD_ORDER.filter(k => k in e), ...Object.keys(e).filter(k => !FIELD_ORDER.includes(k))];
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid;grid-template-columns:max-content 1fr;gap:4px 12px;margin-bottom:16px';
      allKeys.forEach(k => {
        const raw = e[k];
        const label = document.createElement('div');
        label.textContent = k;
        label.style.cssText = 'color:#56b6c2;font-weight:bold;white-space:nowrap;padding:3px 0';
        const val = document.createElement('div');
        val.style.cssText = 'word-break:break-all;padding:3px 0;white-space:pre-wrap;font-family:monospace;font-size:0.95em';
        if (k === 'ts' && typeof raw === 'string') {
          val.textContent = new Date(raw).toLocaleString() + '  (' + raw + ')';
        } else if (typeof raw === 'object' && raw !== null) {
          val.textContent = JSON.stringify(raw, null, 2);
          val.style.background = '#2c313a';
          val.style.borderRadius = '3px';
          val.style.padding = '6px 8px';
        } else if ((k === 'bufferPreview' || k === 'oldStrPreview' || k === 'diffVsBuffer') && typeof raw === 'string') {
          // Multi-line diagnostic strings — render in a code block
          val.textContent = raw;
          val.style.background = k === 'bufferPreview' ? '#1a2a1a' : k === 'diffVsBuffer' ? '#2a1a1a' : '#2a2520';
          val.style.borderRadius = '3px';
          val.style.padding = '6px 8px';
          val.style.color = k === 'bufferPreview' ? '#98c379' : k === 'diffVsBuffer' ? '#e06c75' : '#d19a66';
        } else {
          val.textContent = String(raw != null ? raw : '\u2013');
        }
        if (k === 'reason')   { val.style.color = '#e5c07b'; }
        if (k === 'filePath') { val.style.color = '#98c379'; }
        grid.appendChild(label);
        grid.appendChild(val);
      });
      overlay.appendChild(grid);

      // ── raw JSON ─────────────────────────────────────────────────────
      const rawLabel = document.createElement('div');
      rawLabel.textContent = 'Raw JSON';
      rawLabel.style.cssText = 'color:#56b6c2;font-weight:bold;margin-bottom:4px';
      overlay.appendChild(rawLabel);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(e, null, 2);
      pre.style.cssText = 'background:#2c313a;border-radius:3px;padding:10px;font-size:0.88em;overflow-x:auto;margin:0 0 16px 0;color:#abb2bf;flex-shrink:0';
      overlay.appendChild(pre);

      el.appendChild(overlay);
      overlay.scrollTop = 0;
    }

    renderTable();
    toolFilter.addEventListener('input', renderTable);
    reasonFilter.addEventListener('input', renderTable);
    fileFilter.addEventListener('input', renderTable);

    // ── button row ────────────────────────────────────────────────────────
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    el.appendChild(btnRow);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-error';
    clearBtn.textContent = '🗑 Clear Log';
    clearBtn.addEventListener('click', () => {
      if (!confirm('Delete all entries in session/session-faults.ndjson? This cannot be undone.')) return;
      try { require('fs').writeFileSync(LOG_PATH, '', 'utf8'); } catch (_) {}
      allEntries = [];
      renderTable();
      atom.notifications.addWarning('MCP fault log cleared.');
    });
    btnRow.appendChild(clearBtn);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => panel.destroy());
    btnRow.appendChild(closeBtn);

    const panel = atom.workspace.addModalPanel({ item: el, visible: true });
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
