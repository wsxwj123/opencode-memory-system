// Shared acceptance-test harness for batch1 (B1 / B3 / C2).
//
// Style mirrors scripts/fault_injection_resilience_suite.mjs:
//  - temp HOME isolation, plugin loaded with an injected __test.* export block,
//  - defineTool stubbed so plugins/memory-system.js imports cleanly under plain node.
//
// The __test surface below is a SUPERSET of what the fault suite exports; it only
// exposes internal functions so a test can *drive* the plugin into the exact state
// a contract describes. All assertions in the test files are made against
// contract-observable outputs (session JSON on disk, tool return strings, HTTP
// responses) — never against these internals' shapes.

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
export const dashboardScriptPath = path.join(repoRoot, 'plugins', 'scripts', 'opencode_memory_dashboard.mjs');
export const projectName = path.basename(process.cwd());

export const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-batch1-accept-'));

export function log(line) {
  process.stdout.write(`${line}\n`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export function writeRaw(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
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

export function makeClient(overrides = {}) {
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

// Minimal valid config/global so the memory tool has a sane baseline.
export function prepareHome(homeDir) {
  writeJson(path.join(homeDir, '.config', 'opencode', 'opencode.json'), {
    provider: {
      testProvider: {
        npm: '@opencode-ai/provider-openai-compatible',
        options: { baseURL: 'https://example.invalid/v1', apiKey: 'sk-test' },
        models: { 'test-model': { name: 'test-model' } }
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

const TEST_EXPORTS = [
  // fault-suite baseline
  'processUserMessageEvent', 'tokenize', 'buildBudgetTokenView', 'syncBudgetTokenSnapshot',
  // session lifecycle
  'loadSessionMemory', 'persistSessionMemory', 'createEmptySessionMemory', 'getSessionMemoryPath',
  // B3 compaction / discard / injection
  'compressSessionMemory', 'compactConversationByBudget', 'discardLowValueToolEvents',
  'appendCompressedSummaryChunk', 'enforceSessionFileBudget', 'buildCurrentSessionSummaryText',
  'ensureSummaryBlocks',
  // C2 persistence primitives
  'readJson', 'writeJson', 'readMemoryConfig', 'writeMemoryConfig',
  // B1 dashboard generation
  'writeDashboardFilesNow'
];

export async function loadPluginWithHome(homeDir) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const raw = fs.readFileSync(pluginSrcPath, 'utf8');
  const withToolStub = raw.replace(
    "import { tool as defineTool } from '@opencode-ai/plugin';",
    makeDefineToolStub()
  );
  const exportList = TEST_EXPORTS.map((n) => `      ${n}`).join(',\n');
  const withTestExports = withToolStub.replace(
    "  return {\n    name: 'memory-system',",
    `  return {\n    __test: {\n${exportList}\n    },\n    name: 'memory-system',`
  );
  const patchedPath = path.join(tmpRoot, `plugin.${Date.now()}.${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(patchedPath, withTestExports, 'utf8');
  const mod = await import(`${pathToFileURL(patchedPath).href}?t=${Date.now()}`);
  process.env.HOME = previousHome;
  return mod;
}

export async function withPluginHome(name, fn) {
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

export function sessionsDir(homeDir) {
  return path.join(homeDir, '.opencode', 'memory', 'projects', projectName, 'sessions');
}

export function sessionPath(homeDir, sessionID) {
  return path.join(sessionsDir(homeDir), `${encodeURIComponent(sessionID)}.json`);
}

// ---- HTTP helpers (B1) ----

export async function httpGet(port, pathName) {
  return await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: pathName, timeout: 4000 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, headers: {}, text: '', error: String(err?.message || err) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, text: '', error: 'timeout' }); });
    req.end();
  });
}

export async function waitForDashboard(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const res = await httpGet(port, '/api/dashboard');
    if (res.status === 200) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);
  }
  return false;
}

// ---- test runner ----

export async function runCases(cases) {
  let pass = 0;
  for (const [name, fn] of cases) {
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await fn();
    } catch (err) {
      result = { ok: false, detail: `threw: ${err?.stack || err?.message || String(err)}`.slice(0, 400) };
    }
    if (result.ok) pass += 1;
    log(`${result.ok ? 'PASS' : 'FAIL'} | ${name} | ${result.detail}`);
  }
  log(`\nResult: ${pass}/${cases.length} scenarios passed.`);
  process.exit(pass === cases.length ? 0 : 1);
}
