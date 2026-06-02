'use strict';

const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { handleSendMessage, fetchModels, setModel: _setModel, clearContextHistory } = require('./chat-functions');

class ChatPanel {
  constructor(serializedState) {
    this.element = document.createElement('div');
    this.element.classList.add('chat-panel', 'settings-view');

    // Pending images attached to the next message [{dataUrl, mimeType, name}]
    this._pendingImages = [];

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

    // ── image preview strip ─────────────────────────────────────────────────
    // Shown above the textarea when images are queued
    const imagePreviewStrip = document.createElement('div');
    imagePreviewStrip.id = 'image-preview-strip';
    imagePreviewStrip.classList.add('image-preview-strip');
    imagePreviewStrip.style.display = 'none';
    this._imagePreviewStrip = imagePreviewStrip;

    const chatInputContainer = document.createElement('div');
    chatInputContainer.id = 'chat-input-container';

    const chatInput = document.createElement('textarea');
    chatInput.rows = 3;
    chatInput.id = 'chat-input';
    chatInput.placeholder = 'Type your message… (paste or drop images to attach)';
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

    // ── image paste ──────────────────────────────────────────────────────────
    // Listen on document at capture phase — Pulsar has its own capture listeners
    // on the workspace element that fire before this.element handlers, so we must
    // go higher. Guard with panel membership check so we only act when focus is
    // inside our panel.
    this._pasteHandler = (event) => {
      if (!this.element.contains(document.activeElement) &&
          !this.element.contains(event.target)) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      let hasImage = false;
      for (const item of items) {
        if (item.type.startsWith('image/')) { hasImage = true; break; }
      }
      if (!hasImage) return;   // let text paste fall through to textarea normally
      event.preventDefault();
      event.stopImmediatePropagation();
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) this._attachImageFile(file);
        }
      }
    };
    document.addEventListener('paste', this._pasteHandler, true);  // document capture — beats everything

    // ── drag-and-drop: images attach, other files insert path ───────────────
    chatInput.addEventListener('dragover', (event) => {
      event.preventDefault();
    }, true);
    chatInput.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          this._attachImageFile(file);
        } else {
          // Insert file path at cursor position
          const path = file.path || file.name;
          const start = chatInput.selectionStart;
          const end = chatInput.selectionEnd;
          chatInput.value = chatInput.value.slice(0, start) + path + chatInput.value.slice(end);
          chatInput.selectionStart = chatInput.selectionEnd = start + path.length;
        }
      }
    }, true);   // capture phase

    const sendButton = document.createElement('button');
    sendButton.textContent = 'Send';
    sendButton.id = 'send-button';
    sendButton.classList.add('btn','btn-primary');
    sendButton.addEventListener('click', () => this.handleSend());

    this.modelSelect = modelSelect;
    chatInputContainer.appendChild(imagePreviewStrip);
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
        { label: 'Select All', command: 'chat-panel:select-all' },
      ],
    });
  }

  // ── image attachment helpers ────────────────────────────────────────────────

  _attachImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      const imgEntry = { dataUrl, mimeType: file.type, name: file.name || 'image' };
      this._pendingImages.push(imgEntry);
      this._renderImagePreview(imgEntry);
    };
    reader.readAsDataURL(file);
  }

  _renderImagePreview(imgEntry) {
    const strip = this._imagePreviewStrip;
    strip.style.display = 'flex';

    const wrapper = document.createElement('div');
    wrapper.classList.add('image-preview-item');

    const img = document.createElement('img');
    img.src = imgEntry.dataUrl;
    img.classList.add('image-preview-thumb');
    img.title = imgEntry.name;

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '✕';
    removeBtn.classList.add('image-preview-remove', 'btn', 'btn-xs');
    removeBtn.addEventListener('click', () => {
      const idx = this._pendingImages.indexOf(imgEntry);
      if (idx !== -1) this._pendingImages.splice(idx, 1);
      wrapper.remove();
      if (this._pendingImages.length === 0) strip.style.display = 'none';
    });

    wrapper.appendChild(img);
    wrapper.appendChild(removeBtn);
    strip.appendChild(wrapper);
  }

  _clearPendingImages() {
    this._pendingImages = [];
    this._imagePreviewStrip.innerHTML = '';
    this._imagePreviewStrip.style.display = 'none';
  }

  // ── panel API ───────────────────────────────────────────────────────────────

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
    const model = (this.modelSelect?.value || "").trim();
    const apiKey = atom.config.get('pulsar-edit-mcp-server.apiKey');
    if (!chatInput.value && this._pendingImages.length === 0) return;  // nothing to send
    if (!apiKey) {
      this.showError('No API key set — configure one in Settings → Pulsar Edit MCP Server.');
      return;
    }
    if (!this.mcpClient) {
      this.showError('MCP server not connected — start the server first (Packages → Pulsar Edit MCP Server → Restart Server), then retry.');
      return;
    }
    const pendingImages = this._pendingImages.slice();
    this._clearPendingImages();
    handleSendMessage(this, chatDisplay, marked, DOMPurify,
                      chatInput.value, model || "gpt-4o", this.mcpClient, pendingImages)
      .catch(err => {
        this.thinkingOnOff(false);
        this.showError(err.message || 'Unexpected error');
      });
    chatInput.value = '';
  }

  showError(message) {
    const chatDisplay = this.element.querySelector('#chat-display');
    const errDiv = document.createElement('div');
    errDiv.classList.add('chat-message', 'chat-error');
    errDiv.textContent = message;
    chatDisplay.appendChild(errDiv);
    chatDisplay.scrollTop = chatDisplay.scrollHeight;
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
      thinkingIcon.style.display = '';
      thinkingIcon.classList.add('is-animating');
    } else {
      thinkingIcon.style.display = 'none';
      thinkingIcon.classList.remove('is-animating');
    }
  }

  getElement() {
    return this.element;
  }

  destroy() {
    if (this._pasteHandler) {
      document.removeEventListener('paste', this._pasteHandler, true);
      this._pasteHandler = null;
    }
    this.element.remove();
  }
}

module.exports = ChatPanel;
