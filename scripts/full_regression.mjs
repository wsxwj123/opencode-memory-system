#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function estimateTokensFromMessages(messages = []) {
  const chars = messages.reduce((sum, m) => {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const partChars = parts.reduce((p, part) => {
      if (part?.type === 'text') return p + String(part?.text || '').length;
      if (part?.type === 'tool') {
        return p
          + JSON.stringify(part?.state?.input || {}).length
          + String(part?.state?.output || '').length
          + String(part?.state?.error || '').length;
      }
      return p;
    }, 0);
    return sum + partChars;
  }, 0);
  return Math.ceil(chars / 4);
}

function makeTextMsg(id, sessionID, role, text) {
  return {
    id,
    info: { id, role, sessionID, agent: 'orchestrator' },
    parts: [{ type: 'text', text }]
  };
}

function makeToolMsg(id, sessionID, tool, input, output) {
  return {
    id,
    info: { id, role: 'assistant', sessionID, agent: 'orchestrator' },
    parts: [{ type: 'tool', tool, state: { input, output } }]
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-regression-'));
  const fakeHome = path.join(tmpRoot, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.OPENCODE_MEMORY_DISTILL_MODE = 'session';
  process.env.OPENCODE_MEMORY_SEND_PRETRIM = '1';
  process.env.OPENCODE_MEMORY_STRICT_MODE = '0';
  process.env.OPENCODE_MEMORY_VISIBLE_NOTICES = '0';
  process.env.OPENCODE_MEMORY_RECALL_COOLDOWN_MS = '0';

  const pluginPath = path.resolve('/Users/wsxwj/Desktop/opencode file/opencode-memory-system/plugins/memory-system.js');
  const mod = await import(pathToFileURL(pluginPath).href);
  assert(mod?.MemorySystemPlugin, 'MemorySystemPlugin export missing');

  const injected = [];
  const client = {
    session: {
      prompt: async (payload) => {
        injected.push(payload);
        return { ok: true };
      }
    }
  };

  const plugin = mod.MemorySystemPlugin({ client });
  assert(plugin?.event, 'missing event hook');
  assert(plugin?.['experimental.chat.messages.transform'], 'missing transform hook');
  assert(plugin?.tool?.memory?.execute, 'missing memory tool');

  const sidA = 'ses_A';
  const sidB = 'ses_B';
  const sharedCwd = '/tmp/opencode-memory-regression-project';
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: sidA, title: '审稿会话A', cwd: sharedCwd } } } });
  await plugin.event({ event: { type: 'user.message', properties: { info: { id: sidA, cwd: sharedCwd } }, data: { id: 'uA1', content: '请记住：投稿材料路径在 /tmp/workB/response_package' } } });
  await plugin.event({ event: { type: 'assistant.message', properties: { info: { id: sidA, cwd: sharedCwd } }, data: { id: 'aA1', content: '已记录路径。' } } });
  await plugin.event({
    event: {
      type: 'tool.result',
      properties: { info: { id: sidA, cwd: sharedCwd } },
      data: {
        tool: 'desktop-commander_read_file',
        input: { path: '/tmp/workB/response_package/response.html' },
        result: 'ok '.repeat(500)
      }
    }
  });

  await plugin.event({ event: { type: 'session.created', properties: { info: { id: sidB, title: '新会话B', cwd: sharedCwd } } } });
  await plugin.event({
    event: {
      type: 'user.message',
      properties: { info: { id: sidB, cwd: sharedCwd } },
      data: { id: 'uB1', content: '看看我刚才在另一个会话“审稿会话A”里的路径在哪里' }
    }
  });

  const injectBlob = injected.map((x) => JSON.stringify(x || {})).join('\n');
  const recallInjected = injectBlob.includes('/tmp/workB/response_package')
    || injectBlob.includes('<OPENCODE_MEMORY_RECALL');
  assert(recallInjected, 'cross-session recall did not inject expected memory');

  const noisy = [];
  noisy.push(makeTextMsg('sys0', sidB, 'system', '<SYSTEM>mcp tool schema + skill rules + safety policy</SYSTEM>'));
  const hugeNoise = 'pending running log '.repeat(2500);
  for (let i = 0; i < 12; i += 1) {
    noisy.push(makeTextMsg(`u${i}`, sidB, 'user', `需求 ${i}: 继续处理审稿回复。`));
    noisy.push(makeToolMsg(`t${i}`, sidB, 'desktop-commander_read_file', { path: `/tmp/workB/log_${i}.txt` }, hugeNoise));
    noisy.push(makeTextMsg(`a${i}`, sidB, 'assistant', `处理中 ${i}`));
  }
  noisy.push(makeTextMsg('u-last', sidB, 'user', '请给我最终路径和下一步'));

  const before = estimateTokensFromMessages(noisy);
  await plugin['experimental.chat.messages.transform']({}, { messages: noisy });
  const after = estimateTokensFromMessages(noisy);
  assert(after < before, `pretrim failed (${before} -> ${after})`);
  assert(String(noisy[0]?.parts?.[0]?.text || '').includes('<SYSTEM>'), 'system layer unexpectedly changed');
  const hasMarker = noisy.some((m) => (m.parts || []).some((p) => p?.type === 'text' && /\[pretrim-|anchor|distill/i.test(String(p?.text || ''))));
  assert(hasMarker, 'no pretrim markers found');

  const doctorRaw = await plugin.tool.memory.execute({ command: 'doctor', args: ['session', sidB] });
  const doctor = JSON.parse(doctorRaw);
  assert(Boolean(doctor?.pretrim?.happened), 'doctor.pretrim.happened=false');
  assert(Number(doctor?.pretrim?.last?.savedTokens || 0) > 0, 'doctor savedTokens<=0');

  const recallRaw = await plugin.tool.memory.execute({ command: 'recall', args: ['审稿会话A 路径'] });
  assert(String(recallRaw).includes('/tmp/workB/response_package'), 'manual recall missing expected path');

  const discardRaw = await plugin.tool.memory.execute({ command: 'discard', args: [] });
  assert(!/Unknown memory command/i.test(String(discardRaw)) && String(discardRaw).trim().length > 0, 'discard did not return expected status');

  const extractRaw = await plugin.tool.memory.execute({ command: 'extract', args: [] });
  assert(!/Unknown memory command/i.test(String(extractRaw)) && String(extractRaw).trim().length > 0, 'extract did not return expected status');

  const pruneRaw = await plugin.tool.memory.execute({ command: 'prune', args: [] });
  assert(!/Unknown memory command/i.test(String(pruneRaw)) && String(pruneRaw).trim().length > 0, 'prune did not return expected status');

  const setRaw = await plugin.tool.memory.execute({
    command: 'set',
    args: [],
    key: 'language_preference',
    value: '中文',
    scope: 'global'
  });
  assert(!/Unknown memory command/i.test(String(setRaw)) && String(setRaw).trim().length > 0, 'global set command failed');

  const globalRaw = await plugin.tool.memory.execute({ command: 'global', args: [] });
  assert(String(globalRaw).includes('language_preference'), 'global preference missing after set');

  const statsRaw = await plugin.tool.memory.execute({ command: 'stats', args: [] });
  const stats = JSON.parse(statsRaw);
  assert(Number(stats?.sessions || 0) >= 1, 'stats session count unexpected');

  const out = {
    pretrim: { before, after, saved: before - after },
    recall: { injectedCount: injected.length, sample: String(injectBlob).slice(0, 220) },
    doctor: {
      happened: Boolean(doctor?.pretrim?.happened),
      savedTokens: Number(doctor?.pretrim?.last?.savedTokens || 0),
      stackingRisk: Boolean(doctor?.risk?.contextStacking)
    },
    commands: {
      discard: String(discardRaw).split('\n')[0],
      extract: String(extractRaw).split('\n')[0],
      prune: String(pruneRaw).split('\n')[0]
    }
  };
  console.log(JSON.stringify(out, null, 2));
}

run().catch((e) => {
  console.error('REGRESSION_FAIL:', e?.message || e);
  process.exit(1);
});
