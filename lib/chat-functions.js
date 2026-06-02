const apiEndpointPrefix = atom.config.get('pulsar-edit-mcp-server.apiEndpointPrefix');
const apiKey = atom.config.get('pulsar-edit-mcp-server.apiKey');
const hljs = require('highlight.js');

var mcpTools = null;
var chatDisplay = null;
var marked = null;
var DOMPurify = null;
var currentModel = null;
var cachedModels = null;
var chatObj = null;
var llmContextHistory = [{
  role: "system",
  content: "You are a helpful coding assistant with access to the user's Pulsar editor IDE."
}];

// ── helpers ──────────────────────────────────────────────────────────────────

function updateChatHistory(sender, markdownText) {
  if (!chatDisplay) return console.error('Chat display missing');
  const rawHtml = marked.parse(markdownText, { breaks: true });
  const safeHtml = DOMPurify.sanitize(rawHtml);
  const msg = document.createElement('div');
  msg.classList.add('message', sender.toLowerCase());
  msg.innerHTML = safeHtml;
  chatDisplay.appendChild(msg);
  msg.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
  msg.scrollIntoView({ block: 'end' });
}

// Create a streaming div and return it + an append function.
// Tokens are appended as raw text; on finish() the full text is
// re-rendered through marked/DOMPurify so code blocks get highlighted.
function createStreamingMessage() {
  if (!chatDisplay) return null;
  const msg = document.createElement('div');
  msg.classList.add('message', 'assistant', 'streaming');
  chatDisplay.appendChild(msg);
  let accumulated = '';
  return {
    append(token) {
      accumulated += token;
      msg.textContent = accumulated;          // plain text while streaming
      msg.scrollIntoView({ block: 'end' });
    },
    finish() {
      msg.classList.remove('streaming');
      const rawHtml = marked.parse(accumulated, { breaks: true });
      msg.innerHTML = DOMPurify.sanitize(rawHtml);
      msg.querySelectorAll('pre code').forEach(block => hljs.highlightElement(block));
      msg.scrollIntoView({ block: 'end' });
      return accumulated;
    }
  };
}

async function getMcpTools(mcpClient) {
  if (!mcpClient) {
    // MCP server not yet connected — tools unavailable, but we can still chat
    return [];
  }
  if (mcpTools == null) {
    const { tools } = await mcpClient.listTools();
    mcpTools = tools.map(t => ({
      type: "function",
      function: {
        name:        t.name,
        description: t.description ?? "",
        parameters:  t.inputSchema
      }
    }));
  }
  return mcpTools;
}

// ── context history ───────────────────────────────────────────────────────────

function updateLlmContextHistory(inMessage) {
  // llama.cpp server does not like null content
  if (!Object.prototype.hasOwnProperty.call(inMessage, 'content')) {
    inMessage['content'] = "";
  }
  if (inMessage['content'] == null) {
    inMessage['content'] = "";
  }
  llmContextHistory.push(inMessage);
}

function clearContextHistory() {
  llmContextHistory = [{
    role: "system",
    content: "You are a helpful coding assistant with access to the user's Pulsar editor IDE."
  }];
  mcpTools = null;   // also clear tool cache so it re-fetches on next call
}

function addToolResultToHistory(tc, toolResult) {
  const newContext = {
    role: "tool",
    name: tc.function.name,
    content: JSON.stringify(toolResult.content),
    tool_call_id: tc.id
  };
  updateLlmContextHistory(newContext);
}

// ── main LLM call ─────────────────────────────────────────────────────────────

async function chatToLLM(message, mcpClient, pendingImages) {
  // Build content — plain string or multipart array when images are attached
  let content;
  if (pendingImages && pendingImages.length > 0) {
    content = [
      { type: "text", text: message },
      ...pendingImages.map(img => ({
        type: "image_url",
        image_url: { url: img.dataUrl }
      }))
    ];
  } else {
    content = message;
  }

  updateLlmContextHistory({ role: "user", content });
  await callLLM(mcpClient);
}

async function callLLM(mcpClient) {
  const maxTokens = atom.config.get('pulsar-edit-mcp-server.maxTokens') || 4096;
  const availableTools = await getMcpTools(mcpClient);
  const requestData = {
    model: currentModel,
    messages: llmContextHistory,
    tools: availableTools,
    tool_choice: "auto",
    max_tokens: maxTokens,
    stream: true,
  };

  try {
    const response = await fetch(apiEndpointPrefix + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestData),
    });

    if (!response.ok) {
      throw new Error(`Error: ${response.statusText}`);
    }

    // ── SSE stream reader ────────────────────────────────────────────────────
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let toolCallsMap = {};       // id → { id, type, function: { name, arguments } }
    let streamMsg = null;        // lazy — only created once first text token arrives
    let finishReason = null;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE lines are separated by \n; a blank line ends an event
      const lines = buffer.split('\n');
      buffer = lines.pop();      // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') break outer;

        let chunk;
        try { chunk = JSON.parse(payload); } catch { continue; }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        finishReason = choice.finish_reason || finishReason;

        const delta = choice.delta || {};

        // Accumulate text tokens
        if (delta.content) {
          fullContent += delta.content;
          if (!streamMsg) streamMsg = createStreamingMessage();
          streamMsg?.append(delta.content);
        }

        // Accumulate streamed tool call deltas
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            }
            const entry = toolCallsMap[idx];
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.function.name += tc.function.name;
            if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
          }
        }
      }
    }

    // Finalise streaming text message
    if (streamMsg) {
      fullContent = streamMsg.finish();
    }

    // Build the assistant message for context history
    const toolCalls = Object.values(toolCallsMap);
    const assistantMsg = { role: "assistant", content: fullContent || "" };
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    updateLlmContextHistory(assistantMsg);

    // Execute tool calls and recurse
    if (toolCalls.length > 0) {
      for (const tc of toolCalls) {
        updateChatHistory('Tool', `🔧 \`${tc.function.name}\``);
        const args = JSON.parse(tc.function.arguments || "{}");
        const toolResult = await mcpClient.callTool({ name: tc.function.name, arguments: args });
        addToolResultToHistory(tc, toolResult);
      }
      return await callLLM(mcpClient);
    }

    // Done — hide thinking indicator
    if (fullContent) {
      chatObj?.thinkingOnOff(false);
    }

  } catch (error) {
    chatObj?.thinkingOnOff(false);
    console.error('Error calling LLM API:', error);
    throw error;
  }
}

// ── models ────────────────────────────────────────────────────────────────────

async function fetchModels() {
  if (cachedModels) {
    return cachedModels;
  }
  const res = await fetch(apiEndpointPrefix + '/v1/models', {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`Model list failed: ${res.statusText}`);
  const data = await res.json();
  cachedModels = data.data?.map(m => m.id) ?? [];
  return cachedModels;
}

// ── entry point ───────────────────────────────────────────────────────────────

async function handleSendMessage(inChatObj, inChatDisplay, inMarked, inDOMPurify, message, inModel, mcpClient, pendingImages) {
  chatObj = inChatObj;
  chatObj.thinkingOnOff(true);
  currentModel = inModel;
  chatDisplay = inChatDisplay;
  marked = inMarked;
  DOMPurify = inDOMPurify;

  updateChatHistory('User', message);
  chatToLLM(message, mcpClient, pendingImages);
}

module.exports = {
  updateChatHistory,
  callLLM,
  fetchModels,
  handleSendMessage,
  clearContextHistory
};
