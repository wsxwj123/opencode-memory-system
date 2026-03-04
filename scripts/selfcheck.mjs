#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`OK: ${msg}`);
}

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
    parts: [
      {
        type: 'tool',
        tool,
        state: { input, output }
      }
    ]
  };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-memory-selfcheck-'));
  const fakeHome = path.join(tmpRoot, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.OPENCODE_MEMORY_DISTILL_MODE = 'session';
  process.env.OPENCODE_MEMORY_SEND_PRETRIM = '1';
  process.env.OPENCODE_MEMORY_STRICT_MODE = '0';

  const pluginPath = path.resolve(
    '/Users/wsxwj/Desktop/opencode file/opencode-memory-system/plugins/memory-system.js'
  );
  const mod = await import(pathToFileURL(pluginPath).href);
  if (!mod?.MemorySystemPlugin) fail('MemorySystemPlugin export missing');

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
  if (!plugin?.event || !plugin?.['experimental.chat.messages.transform'] || !plugin?.tool?.memory?.execute) {
    fail('plugin hooks/tools incomplete');
  }

  const sessionID = 'ses_selfcheck_001';
  await plugin.event({ event: { type: 'session.created', properties: { info: { id: sessionID, title: 'Selfcheck Session' } } } });
  await plugin.event({ event: { type: 'user.message', properties: { info: { id: sessionID } }, data: { id: 'u1', content: '请记住：工作目录是 /tmp/workA，目标是完成 DCP 风格裁剪验证。' } } });
  await plugin.event({ event: { type: 'assistant.message', properties: { info: { id: sessionID } }, data: { id: 'a1', content: '收到，开始执行。' } } });
  await plugin.event({
    event: {
      type: 'tool.result',
      properties: { info: { id: sessionID } },
      data: {
        tool: 'desktop-commander_read_file',
        input: { path: '/tmp/workA/README.md' },
        result: 'line '.repeat(4000)
      }
    }
  });

  const longNoise = 'pending running output '.repeat(2200);
  const messages = [
    makeTextMsg('sys1', sessionID, 'system', '<SYSTEM>tool definitions + mcp schema + safety policy</SYSTEM>')
  ];
  for (let i = 0; i < 14; i += 1) {
    messages.push(makeTextMsg(`u_old_${i}`, sessionID, 'user', `历史需求 ${i}: 处理项目与文件路径。`));
    messages.push(makeToolMsg(`t_old_${i}`, sessionID, 'desktop-commander_read_file', { path: `/tmp/workA/log_${i}.txt` }, longNoise));
    messages.push(makeTextMsg(`a_old_${i}`, sessionID, 'assistant', `处理中 ${i}。`));
  }
  messages.push(makeTextMsg('u_new_1', sessionID, 'user', '现在请继续，并告诉我关键路径。'));

  const before = estimateTokensFromMessages(messages);
  await plugin['experimental.chat.messages.transform']({}, { messages });
  const after = estimateTokensFromMessages(messages);

  if (after >= before) fail(`pretrim did not reduce tokens (${before} -> ${after})`);
  ok(`pretrim reduced tokens (${before} -> ${after})`);

  if (!String(messages[0]?.parts?.[0]?.text || '').includes('<SYSTEM>')) {
    fail('system message changed unexpectedly');
  }
  ok('system message preserved');

  const replaced = messages.some((m) =>
    (Array.isArray(m.parts) ? m.parts : []).some((p) =>
      p?.type === 'text' && /\[pretrim-|anchor|distill/i.test(String(p?.text || ''))
    )
  );
  if (!replaced) fail('no pretrim replacement markers detected');
  ok('replacement markers detected');

  const doctorRaw = await plugin.tool.memory.execute({ command: 'doctor', args: ['session', sessionID] });
  let doctor = null;
  try {
    doctor = JSON.parse(doctorRaw);
  } catch {
    fail('doctor output is not valid JSON');
  }
  if (!doctor?.pretrim?.happened) fail('doctor.pretrim.happened=false');
  if (!(Number(doctor?.pretrim?.last?.savedTokens || 0) > 0)) fail('doctor reports no token saving');
  ok('doctor reports pretrim + token saving');

  console.log('SELFTEST PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
