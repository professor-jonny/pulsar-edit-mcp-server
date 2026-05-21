# Pulsar Edit MCP Server & LLM Coding Assistant

this is a fork of: https://github.com/drunnells/pulsar-edit-mcp-server
I'm trying to refactor this idea using my personal knowledges and a consistent part of AI analysis on code
now includes Ghidra style function source code search and replace tools
added a grep MCP commands so we can grep in windows.
added run command so we can run shell commands from such as build and automating installing packages.

effectively it is an opensource Claude code addon to pulsar with added enhancements.


| :warning: WARNING          |
|:---------------------------|
| Very experimental and incomplete. Use at your own risk!         |

This is an *early* attempt at making an MCP server and chat assistant to control the [Pulsar](https://github.com/pulsar-edit) editor. The goal is to enable an LLM to assist with software development in Pulsar using the built in chat panel or a tool like [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) as a chat client.

**Built in chat:**

<img src="https://github.com/user-attachments/assets/52c74f89-d76f-4faa-9265-009bdc78c32c" width="700" />

**AnythingLLM chat:**

<img src="https://github.com/user-attachments/assets/5e796c45-c0e8-4e15-a9db-1b5dcb27057d" width="700" />

## Installation:
```sh
ppm install https://github.com/coppolaf/pulsar-edit-mcp-server
```

After the Pulsar package is installed, set the MCP server to lisen in **Packages**->**MCP Server**->**Listen**

You will see a "**MCP:On**" tile in the lower left of the Pulsar editor.

### Settings
<img src="https://github.com/user-attachments/assets/a5529835-919d-4c24-8c26-1eb3a904a1b7" width="300" />

### mcpServers JSON:
If you are using a 3rd party LLM client instead of the built-in chat, your client will need to have the below mcpServers configuration.

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

## Supported commands
- **Replace Text** - Search the active editor for `query` and replace it with `replacement`.
- **Get Context Around** - Return up-to `radiusLines` lines before and after the *N-th* match of `query` in the active editor. Useful for content-aware edits.
- **Find Text** - Search the active editor for a substring or regular expression and return the positions of each occurrence (up to `maxMatches`).
- **Replace Document** - Replace entire contents of the document
- **Insert Line** - Insert a blank line at row
- **Insert Text At Line** - Insert a block of text at the specified line number, shifting existing text down. Prefer replace-document for large edits.
- **Delete Line** - Delete a single line
- **Delete Line Range** - Delete a range of lines
- **Get Selection** - Get the selected text
- **Get Document** - Get an array of each line in the document with line numbers
- **Get Line Count** - Get the total number of lines in the current document
- **Get Filename** - Get the filename of the current document
- **Get Full Path** - Get the full path of the current document
- **Get Project Files** - Get all project files in the current project
- **Open File** - Open a file (or move to that file's tab if already open)
- **Undo** - Undo the last change in the editor
- **Redo** - Redo the last undo in the editor

## Background
I've written a quick [blog post](https://dev.to/drunnells/creating-an-mcp-server-for-the-pulsar-editor-1m5) around my motivations and some of the challenges that I initially encountered.

# Contributing
This project is still in its very early stages. I'm hoping to turn it into something useful one day. If you’re interested in helping shape it, any contribution is welcome and appreciated!
