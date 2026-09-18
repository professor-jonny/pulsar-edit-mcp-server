'use strict';

// CommandTerminalPanel — a dockable pane, separate from the LLM chat panel,
// that shows live output from run-command's spawned process and lets the
// user type input directly into the process's stdin (Enter to send, or
// close stdin/EOF explicitly). This exists because neither Claude Code nor
// Cline can detect or supply input to a process blocked reading stdin —
// they only hang or time out. Since run-command already spawns a real
// child process inside Pulsar, this panel gives a genuine interactive
// channel instead of just better failure handling.
//
// One panel instance is reused across command runs (like ChatPanel);
// attachProcess() rebinds it to a new proc each time run-command spawns one.

class CommandTerminalPanel {
  constructor(serializedState) {
    this.element = document.createElement('div');
    this.element.classList.add('command-terminal-panel', 'settings-view');

    this._proc = null;

    const topDisplay = document.createElement('div');
    topDisplay.classList.add('top-display');

    this._statusLabel = document.createElement('span');
    this._statusLabel.classList.add('command-terminal-status');
    this._statusLabel.textContent = 'No command running';
    topDisplay.appendChild(this._statusLabel);

    const clearButton = document.createElement('button');
    clearButton.textContent = 'Clear';
    clearButton.classList.add('btn', 'btn-error', 'top-button');
    clearButton.addEventListener('click', () => {
      this._output.innerHTML = '';
    });
    topDisplay.appendChild(clearButton);

    this.element.appendChild(topDisplay);

    const output = document.createElement('div');
    output.id = 'command-terminal-output';
    output.classList.add('command-terminal-output');
    output.setAttribute('tabindex', '-1');
    this._output = output;
    this.element.appendChild(output);

    // -- stdin input row -------------------------------------------------
    const inputRow = document.createElement('div');
    inputRow.id = 'command-terminal-input-row';
    inputRow.classList.add('command-terminal-input-row');

    const stdinInput = document.createElement('input');
    stdinInput.type = 'text';
    stdinInput.id = 'command-terminal-stdin';
    stdinInput.classList.add('input-text', 'native-key-bindings');
    stdinInput.placeholder = 'Type input for the running command and press Enter…';
    stdinInput.disabled = true;
    this._stdinInput = stdinInput;

    stdinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.sendLine(stdinInput.value);
        stdinInput.value = '';
      }
    });

    const sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.classList.add('btn', 'btn-primary');
    sendBtn.disabled = true;
    this._sendBtn = sendBtn;
    sendBtn.addEventListener('click', () => {
      this.sendLine(stdinInput.value);
      stdinInput.value = '';
      stdinInput.focus();
    });

    const eofBtn = document.createElement('button');
    eofBtn.textContent = 'Close stdin (EOF)';
    eofBtn.title = "Signal end-of-input to the running command, e.g. if it is blocked waiting for input you don't need to give.";
    eofBtn.classList.add('btn');
    eofBtn.disabled = true;
    this._eofBtn = eofBtn;
    eofBtn.addEventListener('click', () => {
      this.closeStdin();
    });

    inputRow.appendChild(stdinInput);
    inputRow.appendChild(sendBtn);
    inputRow.appendChild(eofBtn);
    this.element.appendChild(inputRow);
  }

  // -- called by run-command's spawn handler --------------------------------
  attachProcess(proc, { command, cwd } = {}) {
    this._proc = proc;
    this._statusLabel.textContent = `Running: ${command || '(command)'}${cwd ? '  —  ' + cwd : ''}`;
    this._stdinInput.disabled = false;
    this._sendBtn.disabled = false;
    this._eofBtn.disabled = false;
    this._stdinInput.value = '';
    this._stdinInput.focus();

    const onEnd = () => {
      this._stdinInput.disabled = true;
      this._sendBtn.disabled = true;
      this._eofBtn.disabled = true;
      this._statusLabel.textContent = `Finished: ${command || '(command)'}`;
      if (this._proc === proc) this._proc = null;
    };
    proc.once('close', onEnd);
    proc.once('error', onEnd);
  }

  sendLine(text) {
    if (!this._proc || !this._proc.stdin || this._proc.stdin.destroyed) return;
    try {
      this._proc.stdin.write(text + '\n');
      this.appendOutput('> ' + text, 'stdin-echo');
    } catch (_) { /* pipe already closed — ignore */ }
  }

  closeStdin() {
    if (!this._proc || !this._proc.stdin || this._proc.stdin.destroyed) return;
    try {
      this._proc.stdin.end();
      this.appendOutput('[stdin closed]', 'info');
    } catch (_) { /* ignore */ }
    this._stdinInput.disabled = true;
    this._sendBtn.disabled = true;
    this._eofBtn.disabled = true;
  }

  // Same call signature as ChatPanel.appendOutput so run-command can write
  // to whichever panel(s) it's configured to use with one call shape.
  appendOutput(text, type) {
    const div = document.createElement('div');
    div.classList.add('command-terminal-line', `command-terminal-${type}`);
    div.textContent = text;
    this._output.appendChild(div);
    this._output.scrollTop = this._output.scrollHeight;
  }

  // -- panel API -------------------------------------------------------------

  getTitle() {
    return 'Command Output';
  }

  getURI() {
    return 'atom://pulsar-edit-mcp-server/command-terminal';
  }

  getDefaultLocation() {
    return 'bottom';
  }

  getAllowedLocations() {
    return ['bottom', 'left', 'right'];
  }

  getPreferredHeight() {
    return 260;
  }

  getElement() {
    return this.element;
  }

  serialize() {
    return { deserializer: 'CommandTerminalPanel' };
  }

  destroy() {
    this.element.remove();
  }
}

module.exports = CommandTerminalPanel;
