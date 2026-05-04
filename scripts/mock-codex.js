#!/usr/bin/env node

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function makeMockTurn(id, status = 'completed') {
  return {
    id,
    items: [],
    status,
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
    durationMs: status === 'completed' ? 1 : null,
  };
}

function extractAppServerInput(input) {
  const items = Array.isArray(input) ? input : [];
  return {
    text: items.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n').trim(),
    imageCount: items.filter((item) => item?.type === 'localImage').length,
  };
}

function runAppServerMock() {
  let threadId = `mock-${crypto.randomUUID()}`;
  let serverRequestId = 1000;
  const pendingServerRequests = new Map();

  function rpcResult(id, result = {}) {
    writeJson({ id, result });
  }

  function notify(method, params = {}) {
    writeJson({ method, params });
  }

  function threadResponse(params = {}) {
    return {
      thread: { id: threadId, turns: [], status: 'idle' },
      model: params.model || 'gpt-5.5',
      modelProvider: 'mock',
      serviceTier: null,
      cwd: params.cwd || process.cwd(),
      instructionSources: [],
      approvalPolicy: params.approvalPolicy || 'never',
      sandbox: { type: 'dangerFullAccess' },
      reasoningEffort: null,
    };
  }

  function tokenUsage(threadIdValue, turnId) {
    notify('thread/tokenUsage/updated', {
      threadId: threadIdValue,
      turnId,
      tokenUsage: {
        total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
        last: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 },
        modelContextWindow: null,
      },
    });
  }

  function requestUserInput(threadIdValue, turnId) {
    const id = serverRequestId++;
    writeJson({
      id,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: threadIdValue,
        turnId,
        itemId: 'ask_1',
        questions: [{
          id: 'proceed',
          header: '确认执行',
          question: '请选择 Codex 后续动作。',
          options: [
            { label: '继续执行 (Recommended)', description: '确认后 mock Codex 会继续当前 turn。' },
            { label: '暂停', description: '用于验证前端不会自动采用推荐项。' },
          ],
        }],
      },
    });
    return new Promise((resolve) => {
      pendingServerRequests.set(id, resolve);
    });
  }

  async function runTurn(params = {}) {
    const currentThreadId = params.threadId || threadId;
    const turnId = `turn-${crypto.randomUUID()}`;
    const { text, imageCount } = extractAppServerInput(params.input);

    notify('turn/started', { threadId: currentThreadId, turn: makeMockTurn(turnId, 'inProgress') });

    if (/pwd/i.test(text)) {
      notify('item/started', {
        threadId: currentThreadId,
        turnId,
        item: {
          id: 'item_cmd',
          type: 'commandExecution',
          command: '/bin/bash -lc pwd',
          aggregatedOutput: '',
          exitCode: null,
          status: 'inProgress',
        },
      });
      notify('item/completed', {
        threadId: currentThreadId,
        turnId,
        item: {
          id: 'item_cmd',
          type: 'commandExecution',
          command: '/bin/bash -lc pwd',
          aggregatedOutput: '/tmp/mock-codex\n',
          exitCode: 0,
          status: 'completed',
        },
      });
    }

    let responseText = `Codex mock handled (${imageCount} image): ${text}`;
    if (/ask codex question/i.test(text)) {
      const answer = await requestUserInput(currentThreadId, turnId);
      const firstAnswer = answer?.answers?.proceed?.answers?.[0] || '';
      responseText = `Codex mock received answer: ${firstAnswer}`;
    }

    notify('item/agentMessage/delta', {
      threadId: currentThreadId,
      turnId,
      itemId: 'item_msg',
      delta: responseText,
    });
    notify('item/completed', {
      threadId: currentThreadId,
      turnId,
      item: {
        id: 'item_msg',
        type: 'agentMessage',
        text: responseText,
      },
    });
    tokenUsage(currentThreadId, turnId);
    notify('turn/completed', { threadId: currentThreadId, turn: makeMockTurn(turnId, 'completed') });
  }

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.id !== undefined && !msg.method) {
      const resolve = pendingServerRequests.get(msg.id);
      if (resolve) {
        pendingServerRequests.delete(msg.id);
        resolve(msg.result || {});
      }
      return;
    }

    switch (msg.method) {
      case 'initialize':
        rpcResult(msg.id, {
          protocolVersion: '2',
          serverInfo: { name: 'mock-codex-app-server', version: '0.0.0' },
          capabilities: {},
        });
        break;
      case 'initialized':
        break;
      case 'thread/start':
        threadId = `mock-${crypto.randomUUID()}`;
        rpcResult(msg.id, threadResponse(msg.params || {}));
        notify('thread/started', { thread: { id: threadId, turns: [], status: 'idle' } });
        break;
      case 'thread/resume':
        threadId = msg.params?.threadId || threadId;
        rpcResult(msg.id, threadResponse(msg.params || {}));
        notify('thread/started', { thread: { id: threadId, turns: [], status: 'idle' } });
        break;
      case 'thread/compact/start':
        rpcResult(msg.id, {});
        notify('thread/compacted', { threadId: msg.params?.threadId || threadId, turnId: `turn-${crypto.randomUUID()}` });
        break;
      case 'turn/start':
        rpcResult(msg.id, { turn: makeMockTurn(`turn-${crypto.randomUUID()}`, 'inProgress') });
        setImmediate(() => {
          runTurn(msg.params || {}).catch((err) => {
            notify('error', { message: err?.message || String(err) });
          });
        });
        break;
      default:
        if (msg.id !== undefined) rpcResult(msg.id, {});
        break;
    }
  });
}

(async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'app-server') {
    runAppServerMock();
    return;
  }
  // cc-web can place `resume` after other `codex exec` options (e.g. --json, -s).
  const isResume = args[0] === 'exec' && args.includes('resume');
  const threadId = (() => {
    if (!isResume) return `mock-${crypto.randomUUID()}`;
    for (let i = args.length - 1; i >= 2; i--) {
      const arg = args[i];
      if (arg === '-' || String(arg).startsWith('-')) continue;
      return arg;
    }
    return `mock-${crypto.randomUUID()}`;
  })();
  const input = (await readStdin()).trim();
  const imageCount = args.filter((arg) => arg === '--image').length;
  const statePath = path.join(os.tmpdir(), `cc-web-mock-codex-${threadId}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {}

  process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: threadId })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'turn.started' })}\n`);

  if (/pwd/i.test(input)) {
    process.stdout.write(`${JSON.stringify({
      type: 'item.started',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    })}\n`);
    process.stdout.write(`${JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'item_cmd',
        type: 'command_execution',
        command: '/bin/bash -lc pwd',
        aggregated_output: '/tmp/mock-codex\n',
        exit_code: 0,
        status: 'completed',
      },
    })}\n`);
  }

  if (input === '/compact') {
    state.compacted = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }

  const isInitPrompt = input === '/init' || input.includes('You are running cc-web\'s /init for a Codex session.');

  if (isInitPrompt) {
    const agentsPath = path.join(process.cwd(), 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# AGENTS.md\n\nGenerated by mock Codex /init.\n');
  }

  if (input === 'trigger codex context limit' && !state.compacted) {
    process.stdout.write(`${JSON.stringify({
      type: 'turn.failed',
      error: { message: 'Context window exceeded. Please use /compact and retry.' },
    })}\n`);
    process.exit(1);
  }

  const responseText = input === '/compact'
    ? 'Codex compact finished.'
    : isInitPrompt
      ? 'Codex init finished.'
    : `Codex mock handled (${imageCount} image): ${input}`;

  process.stdout.write(`${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_msg',
      type: 'agent_message',
      text: responseText,
    },
  })}\n`);

  if (input === 'trigger codex context limit' && state.compacted) {
    try { fs.unlinkSync(statePath); } catch {}
  }

  process.stdout.write(`${JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 },
  })}\n`);
})();
