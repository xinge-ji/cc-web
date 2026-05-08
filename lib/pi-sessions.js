const fs = require('fs');
const path = require('path');

function createPiSessionStore(deps) {
  const { piSessionsDir, sessionsDir, normalizeSession, sanitizeToolInput } = deps;

  function extractTextContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((item) => item && item.type === 'text')
      .map((item) => item.text || '')
      .join('');
  }

  function usageFromMessage(message) {
    const usage = message?.usage || null;
    if (!usage) return null;
    return {
      inputTokens: usage.input || 0,
      cachedInputTokens: usage.cacheRead || 0,
      outputTokens: usage.output || 0,
      cost: Number(usage.cost?.total || 0),
    };
  }

  function addUsage(totalUsage, usage) {
    if (!usage) return;
    totalUsage.inputTokens += usage.inputTokens || 0;
    totalUsage.cachedInputTokens += usage.cachedInputTokens || 0;
    totalUsage.outputTokens += usage.outputTokens || 0;
    totalUsage.cost += usage.cost || 0;
  }

  function parsePiSessionLines(lines) {
    const messages = [];
    const pendingToolCalls = new Map();
    const meta = { sessionId: null, cwd: null, title: '', updatedAt: null, model: '', source: 'pi' };
    const totalUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cost: 0 };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }
      const ts = entry.timestamp || null;
      if (ts) meta.updatedAt = ts;

      if (entry.type === 'session') {
        meta.sessionId = entry.id || meta.sessionId;
        meta.cwd = entry.cwd || meta.cwd;
        continue;
      }
      if (entry.type === 'model_change') {
        const provider = String(entry.provider || '').trim();
        const modelId = String(entry.modelId || '').trim();
        meta.model = provider && modelId ? `${provider}/${modelId}` : (modelId || meta.model);
        continue;
      }
      if (entry.type !== 'message') continue;

      const message = entry.message || {};
      if (message.role === 'user') {
        const text = extractTextContent(message.content).trim();
        if (!text) continue;
        if (!meta.title) meta.title = text.slice(0, 80).replace(/\n/g, ' ');
        messages.push({ role: 'user', content: text, timestamp: ts });
        continue;
      }

      if (message.role === 'assistant') {
        const text = extractTextContent(message.content);
        const toolCalls = [];
        if (Array.isArray(message.content)) {
          for (const item of message.content) {
            if (!item || item.type !== 'toolCall') continue;
            const id = item.id || `${entry.id || 'pi'}-${toolCalls.length}`;
            const tc = {
              name: item.name || 'PiTool',
              id,
              input: sanitizeToolInput(item.name || 'PiTool', item.arguments || {}),
              done: false,
            };
            toolCalls.push(tc);
            pendingToolCalls.set(id, tc);
          }
        }
        addUsage(totalUsage, usageFromMessage(message));
        messages.push({ role: 'assistant', content: text, toolCalls, timestamp: ts });
        continue;
      }

      if (message.role === 'toolResult') {
        const toolCallId = message.toolCallId || '';
        const resultText = extractTextContent(message.content).slice(0, 2000);
        const tc = pendingToolCalls.get(toolCallId);
        if (tc) {
          tc.done = true;
          tc.result = resultText;
        }
      }
    }

    return { meta, messages, totalUsage };
  }

  function walkFiles(dir, files = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return files;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walkFiles(fullPath, files);
      else if (entry.isFile()) files.push(fullPath);
    }
    return files;
  }

  function getPiSessionFiles() {
    if (!fs.existsSync(piSessionsDir)) return [];
    return walkFiles(piSessionsDir, []).filter((filePath) => filePath.endsWith('.jsonl')).sort().reverse();
  }

  function getImportedPiSessionIds() {
    const imported = new Set();
    try {
      for (const f of fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json'))) {
        try {
          const session = normalizeSession(JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')));
          if (session.piSessionId) imported.add(session.piSessionId);
        } catch {}
      }
    } catch {}
    return imported;
  }

  function parsePiSessionFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = parsePiSessionLines(content.split('\n'));
      parsed.filePath = filePath;
      return parsed;
    } catch {
      return null;
    }
  }

  return {
    parsePiSessionLines,
    getPiSessionFiles,
    getImportedPiSessionIds,
    parsePiSessionFile,
  };
}

module.exports = { createPiSessionStore };
