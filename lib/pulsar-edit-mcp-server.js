'use babel';

import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod";
import PulsarMcpView from './pulsar-edit-mcp-server-view';
import { CompositeDisposable } from 'atom';
import { mcpRegistration } from "./mcp-registration.js";
import { ghidraToolsRegistration } from "./ghidra-tools.js";
import path from "path";
import ChatPanel from './chat-panel';

const { version } = require(path.join(__dirname, '..', 'package.json'));
const mcpServerPort = atom.config.get('pulsar-edit-mcp-server.mcpServerPort');

// Start MCP Server
const app = express();
app.use(express.json());
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
app.post('/mcp', async (req, res) => {
  const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;
  let transport: StreamableHTTPServerTransport;
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
    const mcpServer = new McpServer({
      name: "pulsar-edit-mcp-server-server",
      version: version
    });
    mcpRegistration(mcpServer);        // Register core editor tools
    ghidraToolsRegistration(mcpServer); // Register Ghidra analysis tools
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

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
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
  chatPanel.setMcpClient(mcpClient);
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

  async activate(state) {
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
      atom.workspace.addOpener(uri => {
        if (uri === 'atom://pulsar-edit-mcp-server/chat') {
          this.chatPanel = new ChatPanel();
          return this.chatPanel;
        }
      })
    );

    atom.workspace.open('atom://pulsar-edit-mcp-server/chat');
  },

  deactivate() {
    this.stopListening();
    this.modalPanel.destroy();
    this.subscriptions.dispose();
    this.pulsarMcpView.destroy();

    this.statusBarTile?.destroy();
    this.statusBarTile = null;
    this.statusBarElement = null;

    if (this.subscriptions) {
      this.subscriptions.dispose();
    }

  },

  serialize() {
    return {
      pulsarMcpViewState: this.pulsarMcpView.serialize()
    };
  },

  consumeStatusBar(statusBar) {
    this.setStatusbar(statusBar,true);
  },

  listenToggle() {
    console.log('PulsarMcp was toggled!');
    if (this.listening) {
      this.stopListening();
      this.listening = false;
    } else {
      this.serverInstance = app.listen(mcpServerPort);
      this.listening = true;
      this.mcpClient = startMcpClient(this.chatPanel);
    }
    this.setStatusbar(this.statusBarTile,this.listening);
  },

  stopListening() {
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
