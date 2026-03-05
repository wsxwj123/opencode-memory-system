#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const tmpRoot = path.join(os.tmpdir(), `memory-regression-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

function log(line) {
  process.stdout.write(`${line}\n`);
}

function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
}

function loadSessionFile(homeDir, sessionID) {
  const projDir = path.join(homeDir, '.opencode', 'memory', 'projects');
  if (!fs.existsSync(projDir)) return null;
  for (const proj of fs.readdirSync(projDir)) {
    const fp = path.join(projDir, proj, 'sessions', `${encodeURIComponent(sessionID)}.json`);
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }
  return null;
}

function createSessionFile(homeDir, sessionID, projectName = path.basename(process.cwd())) {
  const fp = path.join(
    homeDir,
    '.opencode',
    'memory',
    'projects',
    projectName,
    'sessions',
    `${encodeURIComponent(sessionID)}.json`
  );
  writeJson(fp, {
    version: '2.0.0',
    projectName,
    sessionID,
    updatedAt: new Date().toISOString(),
    stats: { userMessages: 0, assistantMessages: 0, toolResults: 0 },
    events: [],
    summary: { compressedText: '', compressedEvents: 0 },
    recall: { count: 0, lastAt: null, lastQuery: '' },
    inject: {
      globalPrefsCount: 0,
      currentSummaryCount: 0,
      triggerRecallCount: 0,
      memoryDocsCount: 0,
      lastAt: null,
      lastReason: '',
      lastStatus: ''
    },
    budget: {
      bodyTokenBudget: 50000,
      lastEstimatedBodyTokens: 0,
      lastCompactedAt: null,
      lastCompactionReason: ''
    },
    pruneAudit: {
      autoRuns: 0,
      manualRuns: 0,
      discardRemovedTotal: 0,
      extractMovedTotal: 0,
      lastAt: null,
      lastSource: '',
      lastDiscardRemoved: 0,
      lastExtractMoved: 0,
      lastEstimatedBodyTokens: 0
    },
    sendPretrim: {
      autoRuns: 0,
      manualRuns: 0,
      savedTokensTotal: 0,
      lastBeforeTokens: 0,
      lastAfterTokens: 0,
      lastSavedTokens: 0,
      lastAt: null,
      lastReason: '',
      lastStatus: '',
      traces: []
    },
    summaryBlocks: { count: 0, nextBlockId: 1, recent: [] }
  });
}

function buildMessages({ sessionID, providerID = 'testProvider', modelID = 'test-model', noisy = false, long = false }) {
  const messages = [];
  messages.push({
    info: { role: 'system', sessionID, model: { providerID, modelID }, id: `${sessionID}-sys` },
    parts: [{ type: 'text', text: 'system tool definition should be preserved' }]
  });
  for (let i = 0; i < 6; i += 1) {
    messages.push({
      info: { role: 'user', sessionID, model: { providerID, modelID }, id: `${sessionID}-u${i}` },
      parts: [{ type: 'text', text: `user turn ${i}` }]
    });
    const body = noisy
      ? `tool result pending running debug trace ${'x'.repeat(long ? 2200 : 200)}`
      : `assistant analysis paragraph ${i}: ${'A'.repeat(long ? 3600 : 120)}`;
    messages.push({
      info: { role: 'assistant', sessionID, model: { providerID, modelID }, id: `${sessionID}-a${i}` },
      parts: [{ type: 'text', text: body }]
    });
  }
  messages.push({
    info: { role: 'user', sessionID, model: { providerID, modelID }, id: `${sessionID}-u-final` },
    parts: [{ type: 'text', text: 'final request' }]
  });
  return messages;
}

function makeDefineToolStub() {
  return `
const __schemaChain = () => {
  const node = {};
  node.optional = () => node;
  node.describe = () => node;
  return node;
};
const defineTool = (spec) => spec;
defineTool.schema = {
  string: __schemaChain,
  number: __schemaChain,
  boolean: __schemaChain,
  object: __schemaChain,
  array: __schemaChain
};
`;
}

async function loadPluginWithHome(homeDir) {
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  const raw = fs.readFileSync(pluginSrcPath, 'utf8');
  const replaced = raw.replace(
    "import { tool as defineTool } from '@opencode-ai/plugin';",
    makeDefineToolStub()
  );
  const patchedPath = path.join(tmpRoot, `memory-system.patched.${Date.now()}.mjs`);
  fs.writeFileSync(patchedPath, replaced, 'utf8');
  const mod = await import(`${pathToFileURL(patchedPath).href}?t=${Date.now()}`);
  process.env.HOME = originalHome;
  return mod;
}

function makeClient() {
  return {
    session: {
      async prompt() { return null; },
      async update() { return null; }
    }
  };
}

function prepareHome(homeDir, provider = {}) {
  const opencodeCfg = {
    provider: {
      testProvider: {
        npm: '@opencode-ai/provider-openai-compatible',
        options: {
          baseURL: provider.baseURL || 'https://example.invalid/v1',
          apiKey: provider.apiKey || 'sk-test'
        },
        models: {
          'test-model': { name: 'test-model' }
        }
      }
    }
  };
  writeJson(path.join(homeDir, '.config', 'opencode', 'opencode.json'), opencodeCfg);
  writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), { preferences: {}, snippets: {}, feedback: [] });
}

function setMemorySettings(homeDir, memorySystem = {}) {
  writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), { memorySystem, trashRetentionDays: 30 });
}

async function runScenario({ name, settings, messages, fetchImpl, expect }) {
  const homeDir = path.join(tmpRoot, name.replace(/\s+/g, '_'));
  fs.mkdirSync(homeDir, { recursive: true });
  prepareHome(homeDir, { baseURL: 'https://mock.local/v1', apiKey: 'sk-mock' });
  setMemorySettings(homeDir, settings);
  createSessionFile(homeDir, messages?.[0]?.info?.sessionID || `${name}-session`);
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  const prevFetch = global.fetch;
  global.fetch = fetchImpl;
  let ok = false;
  let detail = '';
  try {
    const mod = await loadPluginWithHome(homeDir);
    const plugin = mod.MemorySystemPlugin({ client: makeClient() });
    const output = { messages: JSON.parse(JSON.stringify(messages)) };
    await plugin['experimental.chat.messages.transform']({}, output);
    const sessionID = messages[0]?.info?.sessionID;
    const sess = loadSessionFile(homeDir, sessionID);
    const trace = sess?.sendPretrim?.traces?.slice(-1)?.[0] || {};
    ok = expect(trace, output.messages);
    detail = JSON.stringify({
      before: trace.beforeTokens || 0,
      after: trace.afterTokens || 0,
      saved: trace.savedTokens || 0,
      distillUsed: Boolean(trace.distillUsed),
      distillProvider: trace.distillProvider || '',
      distillStatus: trace.distillStatus || '',
      reason: trace.reason || ''
    });
  } catch (err) {
    ok = false;
    detail = `error: ${err?.message || String(err)}`;
  } finally {
    global.fetch = prevFetch;
    process.env.HOME = prevHome;
  }
  log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
  return ok;
}

const okFetch = async () => ({
  ok: true,
  status: 200,
  async text() {
    return JSON.stringify({
      choices: [{
        message: {
          content: [
            'Structured summary:',
            '- Completed outcomes: generated response package and verified key files.',
            '- Key constraints: preserve system/tool definitions and keep recent user turns.',
            '- Next actions: continue from latest assistant step and validate output paths.',
            '- Notes: compressed historical assistant/tool traces into one anchor block for token control.'
          ].join('\n')
        }
      }]
    });
  }
});

const failFetch = async () => ({
  ok: false,
  status: 503,
  async text() { return 'service unavailable'; }
});

async function main() {
  log(`Using temp root: ${tmpRoot}`);
  const scenarios = [
    {
      name: 'S1_no_trigger',
      settings: { sendPretrimEnabled: true, sendPretrimBudget: 50000, sendPretrimTarget: 40000, llmSummaryMode: 'auto' },
      messages: buildMessages({ sessionID: 's1', noisy: false, long: false }),
      fetchImpl: okFetch,
      expect: (trace) => (trace.savedTokens || 0) === 0 || (trace.reason || '').includes('within_budget')
    },
    {
      name: 'S2_mechanical_trim',
      settings: { sendPretrimEnabled: true, sendPretrimBudget: 3000, sendPretrimTarget: 2400, llmSummaryMode: 'auto', independentLlmEnabled: false },
      messages: buildMessages({ sessionID: 's2', noisy: true, long: true }),
      fetchImpl: okFetch,
      expect: (trace) => (trace.savedTokens || 0) > 0 && !trace.distillUsed
    },
    {
      name: 'S3_inline_llm_success',
      settings: { sendPretrimEnabled: true, sendPretrimBudget: 2400, sendPretrimTarget: 1600, llmSummaryMode: 'session', independentLlmEnabled: false },
      messages: buildMessages({ sessionID: 's3', noisy: false, long: true }),
      fetchImpl: okFetch,
      expect: (trace) => Boolean(trace.distillUsed) && String(trace.distillProvider || '').includes('session-inline') && !String(trace.distillProvider || '').includes('fallback')
    },
    {
      name: 'S4_inline_llm_fail_fallback',
      settings: { sendPretrimEnabled: true, sendPretrimBudget: 2400, sendPretrimTarget: 1600, llmSummaryMode: 'session', independentLlmEnabled: false },
      messages: buildMessages({ sessionID: 's4', noisy: false, long: true }),
      fetchImpl: failFetch,
      expect: (trace) => String(trace.distillStatus || '').includes('http_') && String(trace.distillStatus || '').includes('fallback:')
    },
    {
      name: 'S5_independent_llm_success',
      settings: {
        sendPretrimEnabled: true, sendPretrimBudget: 2400, sendPretrimTarget: 1600,
        llmSummaryMode: 'auto',
        independentLlmEnabled: true,
        independentLlmProvider: 'openai_compatible',
        independentLlmBaseURL: 'https://mock.local/v1',
        independentLlmApiKey: 'sk-mock',
        independentLlmModel: 'independent-model'
      },
      messages: buildMessages({ sessionID: 's5', noisy: false, long: true }),
      fetchImpl: okFetch,
      expect: (trace) => Boolean(trace.distillUsed) && String(trace.distillProvider || '').includes('openai_compatible') && !String(trace.distillProvider || '').includes('fallback')
    },
    {
      name: 'S6_independent_llm_fail_fallback',
      settings: {
        sendPretrimEnabled: true, sendPretrimBudget: 2400, sendPretrimTarget: 1600,
        llmSummaryMode: 'independent',
        independentLlmEnabled: true,
        independentLlmProvider: 'openai_compatible',
        independentLlmBaseURL: 'https://mock.local/v1',
        independentLlmApiKey: 'sk-mock',
        independentLlmModel: 'independent-model'
      },
      messages: buildMessages({ sessionID: 's6', noisy: false, long: true }),
      fetchImpl: failFetch,
      expect: (trace) => String(trace.distillStatus || '').includes('http_') && String(trace.distillStatus || '').includes('fallback:')
    }
  ];

  let pass = 0;
  for (const s of scenarios) {
    // eslint-disable-next-line no-await-in-loop
    if (await runScenario(s)) pass += 1;
  }
  log(`\nResult: ${pass}/${scenarios.length} scenarios passed.`);
  process.exit(pass === scenarios.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
