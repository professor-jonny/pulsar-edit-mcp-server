'use babel';
import { z } from "zod";

// ---------------------------------------------------------------------------
// ghidraToolsRegistration
// Registers Ghidra-style analysis tools for working with Ghidra-decompiled
// C source files (e.g. NML.bin.c, SG2.bin.c, xonlinedash.xbe.c).
// All tools operate on the active editor buffer.
// ---------------------------------------------------------------------------

export function ghidraToolsRegistration(server) {

  // -------------------------------------------------------------------------
  // list-functions
  // Parse the buffer for every function definition and return name + line.
  // Handles Ghidra-style: void FUN_00123456(...) and standard C prototypes.
  // -------------------------------------------------------------------------
  {
    const curTool = "list-functions";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "List Functions",
        description: [
          "List all function definitions in the active C file with their names and line numbers.",
          "Works with Ghidra-decompiled output (FUN_xxxxxxxx style names) and standard C.",
          "Workflow hint: Use open-file first to make sure the right file is active."
        ].join(" "),
        inputSchema: {
          includeUnamed: z.boolean().optional()
        }
      },
      async ({ includeUnamed = true }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { includeUnamed });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const lines = editor.getText().split(/\r?\n/);
        const results = [];

        // Match C function definitions: return_type name(...) {
        // Handles: void FUN_00123456(void), int sub_1234(param_t *p), etc.
        const funcPattern = /^[\w\s\*]+?\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/;
        const skipKeywords = new Set([
          'if','else','while','for','switch','do','return','sizeof',
          'typedef','struct','enum','union'
        ]);

        lines.forEach((line, i) => {
          // Skip preprocessor, blank, comment lines
          if (/^\s*(#|\/\/|\/\*|\*)/.test(line)) return;
          if (/^\s*$/.test(line)) return;

          const m = line.match(funcPattern);
          if (m) {
            const name = m[1];
            if (skipKeywords.has(name)) return;
            if (!includeUnamed && /^FUN_|^sub_|^DAT_/.test(name)) return;
            results.push({ line: i + 1, name, preview: line.trim() });
          }
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: "No function definitions found." }] };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ count: results.length, functions: results }, null, 2)
          }]
        };
      }
    );
  }

  // -------------------------------------------------------------------------
  // search-functions
  // Find functions whose name matches a pattern (substring or regex).
  // -------------------------------------------------------------------------
  {
    const curTool = "search-functions";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Search Functions",
        description: [
          "Search for function definitions whose name matches a query string or regex.",
          "Returns name, line number, and the full signature line.",
          "Useful for finding FUN_8000* or all functions containing 'crypto', 'net', etc."
        ].join(" "),
        inputSchema: {
          query:         z.string(),
          regex:         z.boolean().optional(),
          caseSensitive: z.boolean().optional()
        }
      },
      async ({ query, regex = false, caseSensitive = false }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { query, regex, caseSensitive });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const lines = editor.getText().split(/\r?\n/);
        const results = [];

        const flags = caseSensitive ? "" : "i";
        const searchPat = regex
          ? new RegExp(query, flags)
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

        const funcPattern = /^[\w\s\*]+?\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/;
        const skipKeywords = new Set([
          'if','else','while','for','switch','do','return','sizeof',
          'typedef','struct','enum','union'
        ]);

        lines.forEach((line, i) => {
          if (/^\s*(#|\/\/|\/\*|\*)/.test(line)) return;
          const m = line.match(funcPattern);
          if (m) {
            const name = m[1];
            if (skipKeywords.has(name)) return;
            if (searchPat.test(name)) {
              results.push({ line: i + 1, name, signature: line.trim() });
            }
          }
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No functions matching "${query}" found.` }] };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ count: results.length, functions: results }, null, 2)
          }]
        };
      }
    );
  }

  // -------------------------------------------------------------------------
  // get-function-body
  // Extract the complete source of a named function including its closing brace.
  // -------------------------------------------------------------------------
  {
    const curTool = "get-function-body";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Function Body",
        description: [
          "Extract the complete source code of a named function from the active C file.",
          "Returns the full body from signature to closing brace with line numbers.",
          "Works with Ghidra FUN_ names and standard C function names."
        ].join(" "),
        inputSchema: {
          name: z.string()
        }
      },
      async ({ name }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { name });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const lines = editor.getText().split(/\r?\n/);

        // Find the line where this function is defined
        const sigPattern = new RegExp(
          `^[\\w\\s\\*]+?\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`
        );

        let startLine = -1;
        for (let i = 0; i < lines.length; i++) {
          if (sigPattern.test(lines[i]) && !/;\s*$/.test(lines[i])) {
            startLine = i;
            break;
          }
        }

        if (startLine === -1) {
          return { content: [{ type: "text", text: `Function "${name}" not found.` }] };
        }

        // Walk forward tracking brace depth to find end of function
        let depth = 0;
        let endLine = startLine;
        let foundOpen = false;

        for (let i = startLine; i < lines.length; i++) {
          const line = lines[i];
          for (const ch of line) {
            if (ch === '{') { depth++; foundOpen = true; }
            else if (ch === '}') { depth--; }
          }
          if (foundOpen && depth === 0) {
            endLine = i;
            break;
          }
        }

        const body = lines
          .slice(startLine, endLine + 1)
          .map((t, i) => ({ n: startLine + i + 1, text: t }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              name,
              startLine: startLine + 1,
              endLine: endLine + 1,
              lineCount: endLine - startLine + 1,
              body
            }, null, 2)
          }]
        };
      }
    );
  }

  // -------------------------------------------------------------------------
  // get-xrefs
  // Find all call sites of a given function name in the active file.
  // -------------------------------------------------------------------------
  {
    const curTool = "get-xrefs";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Cross References",
        description: [
          "Find every call site of a named function in the active C file.",
          "Returns line numbers and the full calling line for each reference.",
          "Essential for understanding control flow in decompiled binaries."
        ].join(" "),
        inputSchema: {
          name: z.string()
        }
      },
      async ({ name }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { name });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const lines = editor.getText().split(/\r?\n/);
        const results = [];

        // Match name( as a call - whole word before the paren
        const callPat = new RegExp(
          `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`,
          "g"
        );

        // Also track the function's own definition line to exclude it
        const defPat = new RegExp(
          `^[\\w\\s\\*]+?\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`
        );

        lines.forEach((line, i) => {
          if (defPat.test(line) && !/;\s*$/.test(line)) return; // skip definition
          if (callPat.test(line)) {
            results.push({ line: i + 1, context: line.trim() });
          }
          callPat.lastIndex = 0;
        });

        if (results.length === 0) {
          return { content: [{ type: "text", text: `No calls to "${name}" found.` }] };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ name, callCount: results.length, xrefs: results }, null, 2)
          }]
        };
      }
    );
  }

  // -------------------------------------------------------------------------
  // add-comment
  // Insert a C comment above a named function or at a specific line.
  // -------------------------------------------------------------------------
  {
    const curTool = "add-comment";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Add Comment",
        description: [
          "Insert a comment above a named function or at a specific line number.",
          "Use functionName to target a function by name, or lineNumber for a specific line.",
          "Creates a block comment /* ... */ style above the target."
        ].join(" "),
        inputSchema: {
          comment:      z.string(),
          functionName: z.string().optional(),
          lineNumber:   z.number().optional()
        }
      },
      async ({ comment, functionName, lineNumber }) => {
        console.log(`CMD: ${curTool}, ARGS:`, { comment, functionName, lineNumber });
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const buffer = editor.getBuffer();
        const lines = buffer.getText().split(/\r?\n/);

        let targetRow = -1;

        if (functionName) {
          const sigPattern = new RegExp(
            `^[\\w\\s\\*]+?\\b${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`
          );
          for (let i = 0; i < lines.length; i++) {
            if (sigPattern.test(lines[i]) && !/;\s*$/.test(lines[i])) {
              targetRow = i;
              break;
            }
          }
          if (targetRow === -1) {
            return { content: [{ type: "text", text: `Function "${functionName}" not found.` }] };
          }
        } else if (lineNumber != null) {
          targetRow = lineNumber - 1;
          if (targetRow < 0 || targetRow >= lines.length) {
            throw new Error(`lineNumber ${lineNumber} is out of range (1-${lines.length})`);
          }
        } else {
          throw new Error("Provide either functionName or lineNumber.");
        }

        // Build a block comment, preserving indentation of the target line
        const indent = (lines[targetRow].match(/^(\s*)/) || ["", ""])[1];
        const commentLines = comment.split(/\r?\n/);
        let block;
        if (commentLines.length === 1) {
          block = `${indent}/* ${comment} */\n`;
        } else {
          block = `${indent}/*\n` +
            commentLines.map(l => `${indent} * ${l}`).join("\n") +
            `\n${indent} */\n`;
        }

        buffer.insert([targetRow, 0], block);

        return {
          content: [{
            type: "text",
            text: `Comment inserted above line ${targetRow + 1}${functionName ? ` (function "${functionName}")` : ""}.`
          }]
        };
      }
    );
  }

  // -------------------------------------------------------------------------
  // get-function-list-with-comments
  // List all functions and show any existing comments above them.
  // Great for reviewing reverse engineering progress.
  // -------------------------------------------------------------------------
  {
    const curTool = "get-function-list-with-comments";
    console.log("Registering Tool: " + curTool);
    server.registerTool(
      curTool,
      {
        title: "Get Function List With Comments",
        description: [
          "List all functions with any existing comments above them.",
          "Shows reverse engineering progress at a glance —",
          "annotated functions vs unnamed FUN_ stubs."
        ].join(" "),
        inputSchema: {}
      },
      async () => {
        console.log(`CMD: get-function-list-with-comments`);
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) throw new Error("No active editor");

        const lines = editor.getText().split(/\r?\n/);
        const results = [];

        const funcPattern = /^[\w\s\*]+?\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*\)\s*\{?\s*$/;
        const skipKeywords = new Set([
          'if','else','while','for','switch','do','return','sizeof',
          'typedef','struct','enum','union'
        ]);

        lines.forEach((line, i) => {
          if (/^\s*(#|\/\/|\/\*|\*)/.test(line)) return;
          const m = line.match(funcPattern);
          if (!m) return;
          const name = m[1];
          if (skipKeywords.has(name)) return;

          // Look back for comments immediately above this function
          const commentLines = [];
          for (let j = i - 1; j >= 0 && j >= i - 10; j--) {
            const prev = lines[j].trim();
            if (prev === '' || /^\/[\/*]/.test(prev) || /^\*/.test(prev)) {
              if (prev !== '') commentLines.unshift(prev);
            } else {
              break;
            }
          }

          results.push({
            line: i + 1,
            name,
            isUnnamed: /^FUN_|^sub_/.test(name),
            comment: commentLines.length > 0 ? commentLines.join(" ") : null
          });
        });

        const named   = results.filter(r => !r.isUnnamed).length;
        const unnamed = results.filter(r => r.isUnnamed).length;
        const annotated = results.filter(r => r.comment).length;

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              summary: { total: results.length, named, unnamed, annotated },
              functions: results
            }, null, 2)
          }]
        };
      }
    );
  }

}
