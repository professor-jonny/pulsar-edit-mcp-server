'use strict';

const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { handleSendMessage, fetchModels, setModel: _setModel, clearContextHistory } = require('./chat-functions');

class ChatPanel {
  constructor(serializedState) {
    this.element = document.createElement('div');
    this.element.classList.add('chat-panel', 'settings-view');

    const chatDisplay = document.createElement('div');
    chatDisplay.id = 'chat-display';
    chatDisplay.classList.add('chat-display');
    chatDisplay.setAttribute('tabindex', '-1');

    const topDisplay = document.createElement('div');
    topDisplay.classList.add('top-display');

    const clearButton = document.createElement('button');
    clearButton.id = 'clear-button';
    clearButton.textContent = 'Clear';
    clearButton.classList.add('btn', 'btn-error', 'top-button');
    clearButton.addEventListener('click', () => {
      chatDisplay.innerHTML = '';
      clearContextHistory();
    });

    const thinkingIndicator = document.createElement('div');
    thinkingIndicator.classList.add('thinking-indicator');
    const thinkingIcon = document.createElement('div');
    thinkingIcon.classList.add('thinking-icon');
    thinkingIcon.style.display = 'none';
    thinkingIndicator.appendChild(thinkingIcon);

    const chatInputContainer = document.createElement('div');
    chatInputContainer.id = 'chat-input-container';

    const chatInput = document.createElement('textarea');
    chatInput.rows = 3;
    chatInput.id = 'chat-input';
    chatInput.placeholder = 'Type your message...';
    chatInput.classList.add('input-textarea','native-key-bindings');

    const modelSelect = document.createElement('select');
    modelSelect.id   = 'model-select';
    modelSelect.classList.add('input-select','native-key-bindings');
    const apiKey = atom.config.get('pulsar-edit-mcp-server.apiKey');
    if (apiKey) {
      fetchModels()
      .then(models => {
        models.forEach(id => {
          const opt = document.createElement('option');
          opt.value       = id;
          opt.textContent = id;
          modelSelect.appendChild(opt);
        });
      })
      .catch(err => console.error('Could not load models:', err));
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No API key set';
      modelSelect.appendChild(opt);
    }

    // Accept chat message with enter key
    chatInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.handleSend();
      }
    });

    const sendButton = document.createElement('button');
    sendButton.textContent = 'Send';
    sendButton.id = 'send-button';
    sendButton.classList.add('btn','btn-primary');
    sendButton.addEventListener('click', () => this.handleSend());

    this.modelSelect = modelSelect;
    chatInputContainer.appendChild(chatInput);
    chatInputContainer.appendChild(sendButton);
    chatInputContainer.appendChild(modelSelect);

    topDisplay.appendChild(thinkingIndicator);
    topDisplay.appendChild(clearButton);

    this.element.appendChild(topDisplay);
    this.element.appendChild(chatDisplay);
    this.element.appendChild(chatInputContainer);

    // Right-click context menu on the chat display — Copy and Select All
    atom.commands.add(this.element, {
      'chat-panel:copy':       () => document.execCommand('copy'),
      'chat-panel:paste':      () => document.execCommand('paste'),
      'chat-panel:cut':        () => document.execCommand('cut'),
      'chat-panel:select-all': () => {
        const focused = document.activeElement;
        if (focused && focused.id === 'chat-input') {
          focused.select();
        } else {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(this.element.querySelector('#chat-display'));
          sel.removeAllRanges();
          sel.addRange(range);
        }
      },
    });
    atom.contextMenu.add({
      '.chat-panel #chat-display': [
        { label: 'Copy',       command: 'chat-panel:copy' },
        { label: 'Select All', command: 'chat-panel:select-all' },
      ],
      '.chat-panel #chat-input': [
        { label: 'Cut',        command: 'chat-panel:cut' },
        { label: 'Copy',       command: 'chat-panel:copy' },
        { label: 'Paste',      command: 'chat-panel:paste' },
        { label: 'Select All', command: 'chat-panel:select-all' },
      ],
    });
  }

  getTitle() {
    return 'LLM Chat';
  }

  getURI() {
    return 'atom://pulsar-edit-mcp-server/chat';
  }

  getDefaultLocation() {
    return 'right';
  }

  getAllowedLocations() {
    return ['left','right'];
  }

  getPreferredWidth() {
    return 300;
  }

  setMcpClient(inClient) {
    this.mcpClient = inClient;
  }

  handleSend() {
    const chatInput = this.element.querySelector('#chat-input');
    const chatDisplay = this.element.querySelector('#chat-display');
    const model = (this.modelSelect?.value || "").trim() || "gpt-4o";
    if (!chatInput.value) return;
    handleSendMessage(this, chatDisplay, marked, DOMPurify,
                      chatInput.value, model, this.mcpClient)
      .catch(err => this.showError(err.message || 'Unexpected error'));
    chatInput.value = '';
  }

  showError(message) {
    const chatDisplay = this.element.querySelector('#chat-display');
    const errDiv = document.createElement('div');
    errDiv.classList.add('chat-message', 'chat-error');
    errDiv.textContent = message;
    chatDisplay.appendChild(errDiv);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;     // autoscroll
  }

  // Called by mcp-registration run-command spawn handler for live stdout/stderr
  appendOutput(text, type) {
    const chatDisplay = this.element.querySelector('#chat-display');
    const div = document.createElement('div');
    div.classList.add('chat-command-output', `chat-command-${type}`);
    div.textContent = text;
    chatDisplay.appendChild(div);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
  }

  // Called by wrapHandler in mcp-registration when a tool throws unexpectedly
  appendFault(toolName, message) {
    const chatDisplay = this.element.querySelector('#chat-display');
    const div = document.createElement('div');
    div.classList.add('chat-command-fault');
    div.textContent = `⚠ Tool fault [${toolName}]: ${message}`;
    chatDisplay.appendChild(div);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
  }

  thinkingOnOff(inStatus) {
    const thinkingIcon = this.element.querySelector('.thinking-icon');
    if (!thinkingIcon) return;

    if (inStatus) {
      thinkingIcon.style.display = '';           // show
      thinkingIcon.classList.add('is-animating'); // start animation
    } else {
      thinkingIcon.style.display = 'none';        // hide
      thinkingIcon.classList.remove('is-animating');
    }
  }

  getElement() {
    return this.element;
  }
}

module.exports = ChatPanel;
