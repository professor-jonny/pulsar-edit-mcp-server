# Pulsar Edit MCP Server & LLM Coding Assistant

An MCP (Model Context Protocol) server and built-in chat assistant that lets an LLM control the [Pulsar](https://github.com/pulsar-edit) editor. Use the built-in chat panel or any compatible external client such as [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) or [Claude.ai](https://claude.ai).

Tools have been curated from Ghidra, Cline, and Claude Code into a single package. A lazy-load discovery mechanism means the LLM is aware of all tools without paying the token cost of loading every schema upfront — groups are loaded on demand.

> **Beta software** — tested but not production-hardened. Bug reports and suggestions are welcome!

**Built-in chat panel:**

<img src="https://github.com/user-attachments/assets/52c74f89-d76f-4faa-9265-009bdc78c32c" width="700" />

**AnythingLLM external client:**

<img src="https://github.com/user-attachments/assets/5e796c45-c0e8-4e15-a9db-1b5dcb27057d" width="700" />

---

## Installation

```sh
ppm install https://github.com/professor-jonny/pulsar-edit-mcp-server
```

After installation, start the server via **Packages → MCP Server → Listen**, or enable **Auto-Start** in settings so it starts automatically with Pulsar.

A **`MCP:On`** tile appears in the bottom-left status bar when the server is running. Click it to toggle the server on/off.

### Settings

<img src="https://github.com/user-attachments/assets/a5529835-919d-4c24-8c26-1eb3a904a1b7" width="300" />

| Setting | Default | Description |
|---|---|---|
| MCP Server Port | `3000` | Port the server listens on |
| OpenAI API Endpoint | `https://api.openai.com` | Base URL for the built-in chat (everything before `/v1/chat/completions`). Requires restart. |
| API Key | _(empty)_ | API key for the built-in chat |
| Auto-Start MCP Server | `false` | Start the server automatically when Pulsar opens |
| Show Chat Panel | `true` | Open the built-in chat panel on launch |
| Tool Groups | all enabled | Enable/disable individual tool groups to control token usage |

### External client configuration

If you use a third-party LLM client instead of the built-in chat, add this to its MCP servers config:

```json
{
  "mcpServers": {
    "pulsar-edit-mcp-server": {
      "url": "http://localhost:3000/mcp",
      "disabled": false,
      "alwaysAllow": [],
      "type": "streamable"
    }
  }
}
```

---

## Tool Groups

Tools are organised into groups. All groups are enabled by default. Disable unused groups in **Settings → Tool Groups** to reduce the token overhead sent to the LLM on each session. Groups can be re-enabled at runtime by the LLM itself using `enable-group` — no Pulsar restart required. Disabling a group takes effect after the client reconnects.

### Core
Always loaded. Cannot be disabled.

| Tool | Description |
|---|---|
| `get-document` | Return all lines of the active editor with 1-based line numbers |
| `get-line-count` | Return the total line count of the active editor |
| `get-filename` | Return the filename of the active editor |
| `get-full-path` | Return the full absolute path of the active editor |
| `get-file-summary` | Structural summary of a file: functions, includes, defines, TODOs |
| `get-active-editor-info` | Quick metadata: filename, line count, cursor position, language |
| `save-file` | Save the active editor to disk |
| `save-all` | Save all modified editor tabs |
| `list-tools` | List all tools with their group and enabled/disabled status |
| `enable-group` | Enable a disabled tool group at runtime without restarting Pulsar |

### Edit

| Tool | Description |
|---|---|
| `replace-text` | Replace the first occurrence of a string in the active editor |
| `replace-all` | Replace all occurrences of a string in the active editor |
| `replace-document` | Replace the entire editor contents |
| `replace-function-body` | Atomically replace a named function's signature and body |
| `insert-text-at-line` | Insert one or more lines before a given line number |
| `delete-line-range` | Delete a range of lines (inclusive) |
| `get-selection` | Return the currently selected text and its line/column range |
| `get-context-around` | Return lines around the N-th match of a query — useful for targeted edits |
| `find-text` | Find all positions of a string or regex in the active editor |

### File Operations

| Tool | Description |
|---|---|
| `read-file` | Read any project file with 1-based line numbers. Reads from the live buffer if the file is open in Pulsar, otherwise from disk |
| `read-lines` | Read a specific line range from any file (cheaper than read-file for large files). Buffer-first when the file is open in Pulsar |
| `create-file` | Create a new file and open it in the editor |
| `file-line-count` | Return the line count of any file without loading it. Buffer-first when the file is open in Pulsar |
| `get-project-files` | List all files under the current project root |
| `list-project-functions` | List every function definition across all project files |
| `get-includes-and-defines` | Return all `#include` and `#define` lines from a C/C++ file. Buffer-first when the file is open in Pulsar |
| `replace-across-files` | Find and replace across all project files (supports dry-run) |
| `run-command` | Execute a shell command and return stdout, stderr, and exit code |

### Navigation

| Tool | Description |
|---|---|
| `open-file` | Open a file, or switch to its tab if already open |
| `goto-line` | Jump the cursor to a specific line (and optional column) |
| `list-open-files` | List all files currently open in editor tabs |
| `get-surrounding-context` | Return lines around a target line without loading the whole file |

### Search

| Tool | Description |
|---|---|
| `grep-file` | Search a file for a pattern and return matching lines. Buffer-first when the file is open in Pulsar |
| `grep-project` | Search all project files for a pattern |
| `search-symbol` | Find all uses of a C symbol with whole-word matching |

> Grep tools use a cross-platform implementation so they work consistently on Windows and Unix. `grep-file` reads from the live buffer when the file is open in Pulsar; `grep-project` always reads from disk.

### Safety

| Tool | Description |
|---|---|
| `checkpoint` | Save a named in-memory snapshot of the current buffer |
| `restore-checkpoint` | Restore the buffer to a named checkpoint |
| `list-checkpoints` | List all saved checkpoints |
| `diff-preview` | Show a unified diff of proposed changes without applying them |
| `undo` | Undo the last change in the active editor |
| `redo` | Redo the last undone change |

### Diagnostics

| Tool | Description |
|---|---|
| `get-diagnostics` | Syntax-check the active C/C++ file using gcc/clang/cl |

> Note: Diagnostics run against the saved file on disk, not the live buffer, due to Electron 3 compatibility constraints in Pulsar.

### Highlight

| Tool | Description |
|---|---|
| `highlight-range` | Visually highlight a line range in the active editor |

### Ghidra (disabled by default)

Reverse-engineering tools for working with Ghidra-exported C source code. Enable via **Settings → Tool Groups → Ghidra Tools** or ask the LLM to call `enable-group`.

Ghidra's decompiler output is pseudocode — it does not guarantee the exported C is valid or compilable. This group bridges that gap:

- Run the exported C through a real compiler (`gcc`/`clang`) which understands C semantics properly
- Use `clang-tidy` or similar for genuine lint feedback on type errors and bad C
- `get-function-list-with-comments` tracks cleanup progress — annotated functions vs unnamed `FUN_` stubs at a glance
- `get-function-body` is useful when asking the LLM to document or rewrite decompiled functions
- `replace-function-body` rewrites a cleaned-up function atomically without disturbing surrounding code

| Tool | Description |
|---|---|
| `list-functions` | List all functions in the current program |
| `search-functions` | Search functions by name |
| `get-function-body` | Get the decompiled body of a function |
| `get-xrefs` | Get cross-references to/from an address |
| `add-comment` | Add a comment at an address |
| `get-function-list-with-comments` | List functions that have comments |

---

## Notes

- The **Auto-Start** setting starts the MCP server automatically when Pulsar launches. If it fails to start on boot, use **Packages → MCP Server → Restart Server** from the menu.
- Tool groups disabled in Settings take effect after the LLM client reconnects. Re-enabling a group is instant and does not require a reconnect or Pulsar restart.
- The built-in chat panel can be hidden via **Settings → Show Chat Panel** if you prefer an external client.

### WARNING ###
> ⚠️ **Security Warning:** `run-command` has unrestricted shell access — any command can be executed. The LLM acts as gatekeeper, similar to Claude Code and Cline, but without per-command confirmation prompts (removed as too obtrusive for hands-off workflows). It is strongly recommended to run Pulsar in a sandboxed or virtualised environment when this tool is enabled.

---
