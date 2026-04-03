#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboardScriptPath = path.join(repoRoot, 'plugins', 'scripts', 'opencode_memory_dashboard.mjs');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const tmpRoot = path.join(os.tmpdir(), `protection-provider-suite-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

function log(line) {
  process.stdout.write(`${line}\n`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(port, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      if (resp.ok) return true;
    } catch {}
    await sleep(120);
  }
  return false;
}

async function requestJson(port, method, endpoint, body) {
  const resp = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await resp.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: resp.status, body: json };
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
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const raw = fs.readFileSync(pluginSrcPath, 'utf8');
  const withToolStub = raw.replace(
    "import { tool as defineTool } from '@opencode-ai/plugin';",
    makeDefineToolStub()
  );
  const patchedPath = path.join(tmpRoot, `memory-system.protection-provider.${Date.now()}.mjs`);
  fs.writeFileSync(patchedPath, withToolStub, 'utf8');
  const mod = await import(`${pathToFileURL(patchedPath).href}?t=${Date.now()}`);
  process.env.HOME = previousHome;
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

function setupHome(homeDir) {
  writeJson(path.join(homeDir, '.config', 'opencode', 'opencode.json'), {
    provider: {
      localtest: {
        npm: '@opencode-ai/provider-openai-compatible',
        options: { baseURL: 'https://example.invalid/v1', apiKey: 'sk-test' },
        models: { 'test-model': { name: 'test-model' } }
      }
    }
  });
  writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
    memorySystem: {
      sendPretrimTurnProtection: 10,
      visibleNoticesEnabled: true
    },
    trashRetentionDays: 30
  });
}

function sessionPath(homeDir, sessionID, projectName = path.basename(process.cwd())) {
  return path.join(
    homeDir,
    '.opencode',
    'memory',
    'projects',
    projectName,
    'sessions',
    `${encodeURIComponent(sessionID)}.json`
  );
}

function createSession(homeDir, sessionID, projectName = path.basename(process.cwd())) {
  writeJson(sessionPath(homeDir, sessionID, projectName), {
    sessionID,
    projectName: path.basename(process.cwd()),
    recentEvents: [],
    stats: { userMessages: 0, assistantMessages: 0, toolResults: 0, systemEvents: 0 },
    summary: { compressedText: '', compressedEvents: 0 },
    recall: { count: 0, lastAt: null, lastQuery: '' },
    inject: {
      globalPrefsCount: 0,
      currentSummaryCount: 0,
      triggerRecallCount: 0,
      memoryDocsCount: 0,
      lastAt: null,
      lastReason: '',
      lastStatus: '',
      lastDigest: '',
      lastSkippedAt: null,
      lastSkipReason: '',
      lastNoticeAt: null,
      lastNoticeKey: '',
      lastNoticeChannel: '',
      lastNoticeText: ''
    },
    budget: {
      bodyTokenBudget: 50000,
      lastEstimatedBodyTokens: 0,
      lastEstimatedSystemTokens: 0,
      lastEstimatedPluginHintTokens: 0,
      lastEstimatedTotalTokens: 0
    },
    sendPretrim: { autoRuns: 0, manualRuns: 0, savedTokensTotal: 0, traces: [] },
    pruneAudit: {
      autoRuns: 0,
      manualRuns: 0,
      discardRemovedTotal: 0,
      extractMovedTotal: 0,
      lastAt: null
    },
    summaryBlocks: []
  });
}

async function startMockProviderServer(provider) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const method = (req.method || 'GET').toUpperCase();

    if (provider === 'openai_compatible') {
      if (method === 'GET' && url.pathname === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }] }));
        return;
      }
      if (method === 'POST' && url.pathname === '/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chatcmpl-x', choices: [{ message: { content: 'OK' } }] }));
        return;
      }
    }

    if (provider === 'anthropic') {
      if (method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'claude-3-5-sonnet' }] }));
        return;
      }
      if (method === 'POST' && url.pathname === '/v1/messages') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_x', content: [{ type: 'text', text: 'OK' }] }));
        return;
      }
    }

    if (provider === 'gemini') {
      if (method === 'GET' && url.pathname === '/v1beta/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'models/gemini-1.5-flash' }] }));
        return;
      }
      if (method === 'POST' && /^\/v1beta\/models\/.+:generateContent$/i.test(url.pathname)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
        return;
      }
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', provider, method, path: url.pathname }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { server, port: Number(addr.port) };
}

async function runCase(name, fn) {
  try {
    const { ok, detail } = await fn();
    if (ok) log(`PASS | ${name} | ${detail}`);
    else log(`FAIL | ${name} | ${detail}`);
    return ok;
  } catch (err) {
    log(`ERROR | ${name} | ${err?.stack || err?.message || String(err)}`);
    return false;
  }
}

async function main() {
  const homeDir = path.join(tmpRoot, 'home');
  setupHome(homeDir);

  const dashboardPort = 37993;
  const env = { ...process.env, HOME: homeDir };
  const dashboard = spawn(process.execPath, [dashboardScriptPath, 'serve', String(dashboardPort), String(process.pid), '4096'], {
    env,
    stdio: 'ignore'
  });

  let pass = 0;
  let total = 0;
  const mocks = [];

  try {
    const ready = await waitForHttp(dashboardPort);
    if (!ready) {
      log('FAIL | bootstrap dashboard | not reachable');
      process.exit(1);
    }

    total += 1;
    if (await runCase('protection window setting persists via dashboard api', async () => {
      const save = await requestJson(dashboardPort, 'POST', '/api/memory/settings', {
        confirm: true,
        source: 'protection_provider_acceptance_suite',
        memorySystem: { sendPretrimTurnProtection: 7 }
      });
      const view = await requestJson(dashboardPort, 'GET', '/api/memory/settings');
      const value = Number(view.body?.memorySystem?.sendPretrimTurnProtection || 0);
      return { ok: save.status === 200 && view.status === 200 && value === 7, detail: JSON.stringify({ saveStatus: save.status, value }) };
    })) pass += 1;

    for (const provider of ['openai_compatible', 'anthropic', 'gemini']) {
      // eslint-disable-next-line no-await-in-loop
      const mock = await startMockProviderServer(provider);
      mocks.push(mock);

      total += 1;
      // eslint-disable-next-line no-await-in-loop
      if (await runCase(`provider models endpoint works (${provider})`, async () => {
        const baseURL = `http://127.0.0.1:${mock.port}`;
        const resp = await requestJson(dashboardPort, 'POST', '/api/memory/llm/models', {
          provider,
          baseURL,
          apiKey: 'sk-suite',
          timeoutMs: 3000
        });
        const models = Array.isArray(resp.body?.models) ? resp.body.models : [];
        return {
          ok: resp.status === 200 && resp.body?.ok === true && models.length >= 1,
          detail: JSON.stringify({ status: resp.status, ok: resp.body?.ok, models })
        };
      })) pass += 1;

      total += 1;
      // eslint-disable-next-line no-await-in-loop
      if (await runCase(`provider validate endpoint works (${provider})`, async () => {
        const baseURL = `http://127.0.0.1:${mock.port}`;
        const modelByProvider = {
          openai_compatible: 'gpt-4o-mini',
          anthropic: 'claude-3-5-sonnet',
          gemini: 'gemini-1.5-flash'
        };
        const resp = await requestJson(dashboardPort, 'POST', '/api/memory/llm/validate', {
          provider,
          baseURL,
          apiKey: 'sk-suite',
          model: modelByProvider[provider],
          timeoutMs: 3000
        });
        return {
          ok: resp.status === 200 && resp.body?.ok === true,
          detail: JSON.stringify({ status: resp.status, body: resp.body })
        };
      })) pass += 1;
    }
  } finally {
    for (const m of mocks) {
      try { m.server.close(); } catch {}
    }
    try { dashboard.kill('SIGTERM'); } catch {}
  }

  log(`\nResult: ${pass}/${total} scenarios passed.`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
