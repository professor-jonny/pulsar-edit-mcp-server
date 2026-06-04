'use strict';

const fs   = require('fs');
const path = require('path');
const { marked } = require('marked');
const DOMPurify = require('dompurify');
const { handleSendMessage, fetchModels, setModel: _setModel, clearContextHistory, clearMcpTools } = require('./chat-functions');

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

    // ── model selector combobox (searchable, sorted, persistent) ─────────────
    const SAVED_MODEL_KEY = 'pulsar-edit-mcp-server.lastSelectedModel';
    this._modelSelectValue = atom.config.get(SAVED_MODEL_KEY) || '';

    const modelCombo = document.createElement('div');
    modelCombo.id = 'model-combo';
    modelCombo.classList.add('model-combo');

    const modelInputRow = document.createElement('div');
    modelInputRow.classList.add('model-combo-row');

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.id = 'model-combo-input';
    modelInput.classList.add('input-text', 'native-key-bindings');
    modelInput.placeholder = 'Search model…';
    modelInput.setAttribute('autocomplete', 'off');
    if (this._modelSelectValue) modelInput.value = this._modelSelectValue;

    const modelClearBtn = document.createElement('button');
    modelClearBtn.id = 'model-combo-clear';
    modelClearBtn.classList.add('model-combo-clear', 'btn', 'btn-xs');
    modelClearBtn.textContent = '✕';
    modelClearBtn.title = 'Clear model selection';
    modelClearBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this._modelSelectValue = '';
      modelInput.value = '';
      atom.config.set(SAVED_MODEL_KEY, '');
      modelInput.focus();
      renderModelList('');  // show full list after clearing
    });

    const modelDropdown = document.createElement('ul');
    modelDropdown.id = 'model-combo-list';
    modelDropdown.classList.add('model-combo-list');
    modelDropdown.style.setProperty('display', 'none', 'important');

    // Populate dropdown; allModelIds holds the sorted master list
    let allModelIds = [];
    const renderModelList = (filter) => {
      modelDropdown.innerHTML = '';
      const q = filter.toLowerCase();
      const filtered = q ? allModelIds.filter(id => id.toLowerCase().includes(q)) : allModelIds;
      filtered.forEach(id => {
        const li = document.createElement('li');
        li.textContent = id;
        li.classList.add('model-combo-item');
        if (id === this._modelSelectValue) li.classList.add('selected');
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this._modelSelectValue = id;
          modelInput.value = id;
          atom.config.set(SAVED_MODEL_KEY, id);
          modelDropdown.style.setProperty('display', 'none', 'important');
          renderModelList(id);
        });
        modelDropdown.appendChild(li);
      });
      modelDropdown.style.setProperty('display', filtered.length ? 'block' : 'none', 'important');
    };

    modelInput.addEventListener('focus', () => {
      if (allModelIds.length) {
        renderModelList(modelInput.value);
      } else {
        // Models not loaded yet — retry fetch (e.g. apiKey set after panel opened)
        const key = atom.config.get('pulsar-edit-mcp-server.apiKey');
        if (key) {
          modelInput.placeholder = 'Loading models…';
          fetchModels()
            .then(models => {
              allModelIds = models.slice().sort((a, b) => a.localeCompare(b));
              modelInput.placeholder = 'Search model…';
              const saved = atom.config.get(SAVED_MODEL_KEY);
              if (saved && allModelIds.includes(saved)) {
                this._modelSelectValue = saved;
                modelInput.value = saved;
              }
              renderModelList(modelInput.value);
            })
            .catch(err => {
              modelInput.placeholder = 'Search model…';
              console.error('Could not load models:', err);
            });
        }
      }
    });
    modelInput.addEventListener('input', () => {
      renderModelList(modelInput.value);
    });
    modelInput.addEventListener('blur', () => {
      // Delay hide so mousedown on list item fires first
      setTimeout(() => { modelDropdown.style.setProperty('display', 'none', 'important'); }, 150);
    });

    const apiKey = atom.config.get('pulsar-edit-mcp-server.apiKey');
    if (apiKey) {
      fetchModels()
        .then(models => {
          allModelIds = models.slice().sort((a, b) => a.localeCompare(b));
          const saved = atom.config.get(SAVED_MODEL_KEY);
          if (saved && allModelIds.includes(saved)) {
            this._modelSelectValue = saved;
            modelInput.value = saved;
          } else if (allModelIds.length) {
            this._modelSelectValue = allModelIds[0];
            modelInput.value = allModelIds[0];
            atom.config.set(SAVED_MODEL_KEY, allModelIds[0]);
          }
        })
        .catch(err => console.error('Could not load models:', err));
    } else {
      modelInput.value = 'No API key set';
      modelInput.disabled = true;
    }

    modelInputRow.appendChild(modelInput);
    modelInputRow.appendChild(modelClearBtn);
    modelCombo.appendChild(modelInputRow);
    modelCombo.appendChild(modelDropdown);

    // ── @// shortcut system ───────────────────────────────────────────────────
    // Parse shortcuts.md from project root. Format:
    //   @//name {
    //     freeform prompt text
    //   }
    const getShortcutsPath = () => {
      const roots = atom.project.getPaths();
      return (roots && roots.length) ? path.join(roots[0], 'shortcuts.md') : null;
    };

    const SHORTCUTS_SAMPLE = [
      '@//start {',
      '  read session notes',
      '  get repo map',
      '}',
      '',
      '@//audit-c {',
      '  run checkpatch on the active file and summarise violations by severity',
      '  run namingcheck and report any issues',
      '  fix all ERROR level violations first then WARNING level',
      '}',
      '',
      '@//fix-errors {',
      '  run checkpatch on the active file, fix all ERROR level style violations only',
      '}',
      '',
      '@//check-docs {',
      '  run check-function-docs on the active file and report missing or wrong-style docs',
      '  then run insert-function-doc for each function flagged as missing',
      '}',
      '',
      '@//session-end {',
      '  write session notes summarising what was done and the current version',
      '  call get-edit-stats with reset:true',
      '}',
    ].join('\n');

    const ensureShortcutsFile = () => {
      const shortcutsFile = getShortcutsPath();
      if (!shortcutsFile) return;
      if (!fs.existsSync(shortcutsFile)) {
        try {
          fs.writeFileSync(shortcutsFile, SHORTCUTS_SAMPLE + '\n', 'utf8');
        } catch (e) {
          console.warn('pulsar-edit-mcp-server: could not create shortcuts.md:', e.message);
        }
      }
    };

    const parseShortcuts = () => {
      const shortcutsFile = getShortcutsPath();
      if (!shortcutsFile) return [];
      let text;
      try {
        text = fs.readFileSync(shortcutsFile, 'utf8');
      } catch (e) {
        return null;  // null = file not found, distinct from [] = file found but empty
      }
      const shortcuts = [];
      const re = /^@\/\/([^\s{]+)\s*\{([\s\S]*?)\}/gm;
      let match;
      while ((match = re.exec(text)) !== null) {
        shortcuts.push({ name: match[1].trim(), body: match[2].trim() });
      }
      return shortcuts;
    };

    // Shortcut dropdown element
    const shortcutDropdown = document.createElement('ul');
    shortcutDropdown.id = 'shortcut-dropdown';
    shortcutDropdown.classList.add('shortcut-dropdown');
    shortcutDropdown.style.setProperty('display', 'none', 'important');

    const renderShortcutList = (shortcuts, filter) => {
      shortcutDropdown.innerHTML = '';
      const q = filter.toLowerCase();
      const filtered = q ? shortcuts.filter(s => s.name.toLowerCase().includes(q)) : shortcuts;
      if (filtered.length === 0) {
        const li = document.createElement('li');
        li.classList.add('shortcut-item', 'shortcut-empty');
        li.textContent = shortcuts === null ? 'No shortcuts.md found in project root' : 'No matches';
        shortcutDropdown.appendChild(li);
      } else {
        filtered.forEach(s => {
          const li = document.createElement('li');
          li.classList.add('shortcut-item');
          li.textContent = `@//${s.name}`;
          li.title = s.body;
          li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            // Suppress input event re-trigger before changing value
            _shortcutActive = false;
            shortcutDropdown.style.setProperty('display', 'none', 'important');
            // Replace the @//... trigger text with the shortcut body
            const val = chatInput.value;
            const triggerRe = /@\/\/\S*$/;
            chatInput.value = val.replace(triggerRe, '') + s.body;
            chatInput.selectionStart = chatInput.selectionEnd = chatInput.value.length;
            chatInput.focus();
          });
          shortcutDropdown.appendChild(li);
        });
      }
      shortcutDropdown.style.setProperty('display', 'block', 'important');
    };

    // Track whether shortcut picker is active
    let _shortcutActive = false;

    // Accept chat message with enter key; intercept @// shortcut trigger
    chatInput.addEventListener('keydown', (event) => {
      if (_shortcutActive) {
        if (event.key === 'Escape') {
          event.preventDefault();
          shortcutDropdown.style.setProperty('display', 'none', 'important');
          _shortcutActive = false;
          return;
        }
        if (event.key === 'Enter') {
          // If dropdown is showing, first Enter selects the focused/first item rather than sending
          const first = shortcutDropdown.querySelector('.shortcut-item:not(.shortcut-empty)');
          if (first) {
            event.preventDefault();
            first.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            _shortcutActive = false;
            return;
          }
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.handleSend();
      }
    });

    // Watch input for @// trigger sequence
    chatInput.addEventListener('input', () => {
      const val = chatInput.value;
      const triggerMatch = val.match(/@\/\/(\S*)$/);
      if (triggerMatch) {
        _shortcutActive = true;
        const shortcuts = parseShortcuts();
        renderShortcutList(shortcuts || [], triggerMatch[1]);
      } else {
        _shortcutActive = false;
        shortcutDropdown.style.setProperty('display', 'none', 'important');
      }
    });

    chatInput.addEventListener('blur', () => {
      setTimeout(() => {
        shortcutDropdown.style.setProperty('display', 'none', 'important');
        _shortcutActive = false;
      }, 150);
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

    // Wrap textarea + shortcut dropdown in a relative-positioned div
    // so the dropdown can be position:absolute and float above the textarea
    const chatInputWrapper = document.createElement('div');
    chatInputWrapper.classList.add('chat-input-wrapper');
    chatInputWrapper.appendChild(chatInput);
    chatInputWrapper.appendChild(shortcutDropdown);

    this.modelCombo = modelCombo;
    chatInputContainer.appendChild(imagePreviewStrip);
    chatInputContainer.appendChild(chatInputWrapper);
    chatInputContainer.appendChild(sendButton);
    chatInputContainer.appendChild(modelCombo);

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

    // Create shortcuts.md with sample content if it doesn't exist yet
    ensureShortcutsFile();
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
    this._mcpWarnShown = false;
    clearMcpTools();  // force re-fetch of tool list from new MCP session
  }

  handleSend() {
    const chatInput = this.element.querySelector('#chat-input');
    const chatDisplay = this.element.querySelector('#chat-display');
    const model = (this._modelSelectValue || '').trim();
    const apiKey = atom.config.get('pulsar-edit-mcp-server.apiKey');
    if (!chatInput.value && this._pendingImages.length === 0) return;  // nothing to send
    if (!apiKey) {
      this.showError('No API key set — configure one in Settings → Pulsar Edit MCP Server.');
      return;
    }
    // mcpClient may be null — chat still works, tools just won't be available
    // Only warn once (flag cleared when mcpClient is set)
    if (!this.mcpClient && !this._mcpWarnShown) {
      this._mcpWarnShown = true;
      this.showError('⚠ MCP server not connected — tool use disabled. Chat messages will still send.');
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
