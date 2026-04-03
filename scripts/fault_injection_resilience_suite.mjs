#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const tmpRoot = path.join(os.tmpdir(), `memory-fault-injection-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

function log(line) {
  process.stdout.write(`${line}\n`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
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

function makeClient(overrides = {}) {
  const sessionOverrides = overrides?.session || {};
  return {
    ...overrides,
    session: {
      async prompt() { return null; },
      async update() { return null; },
      ...sessionOverrides
    }
  };
}

function prepareHome(homeDir) {
  writeJson(path.join(homeDir, '.config', 'opencode', 'opencode.json'), {
    provider: {
      testProvider: {
        npm: '@opencode-ai/provider-openai-compatible',
        options: {
          baseURL: 'https://example.invalid/v1',
          apiKey: 'sk-test'
        },
        models: {
          'test-model': { name: 'test-model' }
        }
      }
    }
  });
  writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
    memorySystem: {},
    trashRetentionDays: 30
  });
  writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
    preferences: { language: '中文' },
    snippets: {},
    feedback: []
  });
}

async function loadPluginWithHome(homeDir) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const raw = fs.readFileSync(pluginSrcPath, 'utf8');
  const withToolStub = raw.replace(
    "import { tool as defineTool } from '@opencode-ai/plugin';",
    makeDefineToolStub()
  );
  const withTestExports = withToolStub.replace(
    "  return {\n    name: 'memory-system',",
    `  return {\n    __test: {\n      processUserMessageEvent,\n      tokenize,\n      buildBudgetTokenView,\n      syncBudgetTokenSnapshot\n    },\n    name: 'memory-system',`
  );
  const patchedPath = path.join(tmpRoot, `memory-fault.${Date.now()}.mjs`);
  fs.writeFileSync(patchedPath, withTestExports, 'utf8');
  const mod = await import(`${pathToFileURL(patchedPath).href}?t=${Date.now()}`);
  process.env.HOME = previousHome;
  return mod;
}

async function withPluginHome(name, fn) {
  const homeDir = path.join(tmpRoot, name);
  fs.mkdirSync(homeDir, { recursive: true });
  prepareHome(homeDir);
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const mod = await loadPluginWithHome(homeDir);
    const plugin = mod.MemorySystemPlugin({ client: makeClient() });
    return await fn({ homeDir, plugin });
  } finally {
    process.env.HOME = previousHome;
  }
}

async function testWriteFailureNonFatal() {
  return withPluginHome('write_failure_nonfatal', async ({ homeDir, plugin }) => {
    const globalPath = path.join(homeDir, '.opencode', 'memory', 'global.json');
    fs.chmodSync(globalPath, 0o400);
    let ok = false;
    let detail = '';
    try {
      const out = await plugin.tool.memory.execute({ command: 'set', args: ['preferences.nickname', '柚子'] });
      ok = typeof out === 'string' && /Failed to persist global setting|permission|EACCES/i.test(out);
      detail = String(out || '');
    } catch (err) {
      ok = false;
      detail = String(err?.message || err);
    } finally {
      fs.chmodSync(globalPath, 0o644);
    }
    return { ok, detail };
  });
}

async function testBadSessionFileDoesNotCrashStats() {
  return withPluginHome('bad_session_file_nonfatal', async ({ homeDir, plugin }) => {
    const project = path.basename(process.cwd());
    const sdir = path.join(homeDir, '.opencode', 'memory', 'projects', project, 'sessions');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, 'bad%session.json'), '{"sessionID":"bad",', 'utf8');
    try {
      const out = await plugin.tool.memory.execute({ command: 'stats', args: [] });
      const ok = typeof out === 'string' && out.includes('"project"') && out.includes('"sessions"');
      return { ok, detail: out.slice(0, 180) };
    } catch (err) {
      return { ok: false, detail: String(err?.message || err) };
    }
  });
}

async function testDashboardOutageDoesNotBlockCoreFlow() {
  return withPluginHome('dashboard_outage_nonfatal', async ({ plugin }) => {
    try {
      const out1 = await plugin.tool.memory.execute({ command: 'global', args: ['preferences.language'] });
      const out2 = await plugin.tool.memory.execute({ command: 'stats', args: [] });
      const ok = /Global memory:/.test(String(out1 || '')) && String(out2 || '').includes('"project"');
      return { ok, detail: `${out1} | stats-ok=${String(out2 || '').includes('"sessions"')}` };
    } catch (err) {
      return { ok: false, detail: String(err?.message || err) };
    }
  });
}

async function testTokenizerFallbackNonFatal() {
  return withPluginHome('tokenizer_fallback_nonfatal', async ({ plugin }) => {
    try {
      const t1Raw = plugin.__test.tokenize('短文本');
      const t2Raw = plugin.__test.tokenize('x'.repeat(8000));
      const t1 = Number(t1Raw || 0);
      const t2 = Number(t2Raw || 0);
      const budget = plugin.__test.buildBudgetTokenView({
        lastEstimatedBodyTokens: t2,
        lastEstimatedSystemTokens: 1200,
        lastEstimatedPluginHintTokens: 33
      });
      const ok = Number.isFinite(Number(budget.totalTokens || 0)) && Number(budget.totalTokens || 0) >= 1200;
      return { ok, detail: JSON.stringify({ t1Raw, t2Raw, total: budget.totalTokens }) };
    } catch (err) {
      return { ok: false, detail: String(err?.message || err) };
    }
  });
}

async function main() {
  log(`Using temp root: ${tmpRoot}`);
  const cases = [
    ['write failure does not crash tool flow', testWriteFailureNonFatal],
    ['bad session file does not crash stats', testBadSessionFileDoesNotCrashStats],
    ['dashboard outage does not block core memory flow', testDashboardOutageDoesNotBlockCoreFlow],
    ['tokenizer path degrades non-fatally', testTokenizerFallbackNonFatal]
  ];
  let pass = 0;
  for (const [name, fn] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const result = await fn();
    if (result.ok) pass += 1;
    log(`${result.ok ? 'PASS' : 'FAIL'} | ${name} | ${result.detail}`);
  }
  log(`Result: ${pass}/${cases.length} scenarios passed.`);
  process.exit(pass === cases.length ? 0 : 1);
}

main().catch((err) => {
  log(`FAIL | suite runtime error | ${err?.message || String(err)}`);
  process.exit(1);
});
