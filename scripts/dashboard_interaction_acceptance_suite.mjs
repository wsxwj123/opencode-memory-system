#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboardScriptPath = path.join(repoRoot, 'plugins', 'scripts', 'opencode_memory_dashboard.mjs');
const dashboardTemplatePath = path.join(repoRoot, 'plugins', 'dashboard', 'template.html');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-dashboard-interaction-'));
const projectName = path.basename(process.cwd());

function log(line) {
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sessionPath(homeDir, sessionID) {
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

function createSession(homeDir, sessionID, title = '') {
  writeJson(sessionPath(homeDir, sessionID), {
    sessionID,
    sessionTitle: title || sessionID,
    sessionCwd: process.cwd(),
    project: projectName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 1 },
    recentEvents: [
      { ts: new Date().toISOString(), kind: 'session-start', summary: 'Session created' },
      { ts: new Date().toISOString(), kind: 'user-message', summary: `hello-${sessionID}` },
      { ts: new Date().toISOString(), kind: 'assistant-message', summary: `ack-${sessionID}` }
    ],
    summary: { compressedText: `summary-${sessionID}`, compressedEvents: 1, lastCompressedAt: new Date().toISOString() },
    summaryBlocks: [],
    recall: { count: 0, lastAt: null },
    inject: { globalPrefsCount: 0, currentSummaryCount: 0, triggerRecallCount: 0, memoryDocsCount: 0, lastAt: null, lastReason: '', lastStatus: '' },
    budget: {
      bodyTokenBudget: 50000,
      sendPretrimBudget: 10000,
      sendPretrimTarget: 7500,
      lastEstimatedBodyTokens: 800,
      lastEstimatedSystemTokens: 500,
      lastEstimatedPluginHintTokens: 120,
      lastEstimatedTotalTokens: 1300
    },
    pruneAudit: { autoRuns: 0, manualRuns: 0, discardRemovedTotal: 0, extractMovedTotal: 0 },
    sendPretrim: { autoRuns: 0, manualRuns: 0, savedTokensTotal: 0, traces: [] },
    alerts: {}
  });
}

function setupHome(homeDir) {
  writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
    trashRetentionDays: 30,
    memorySystem: {
      visibleNoticeCooldownMs: 60000,
      independentLlmTimeoutMs: 12000,
      summaryTemplateName: 'default',
      summaryTemplateText: '## Structured Session Summary\n- key facts:\n{{keyFacts}}'
    }
  });
  writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
    preferences: {
      assistant_name: '小六子',
      language: 'Chinese'
    },
    snippets: {},
    feedback: []
  });
  createSession(homeDir, 'sid-dashboard-a', 'dashboard-a');
  createSession(homeDir, 'sid-dashboard-b', 'dashboard-b');
  createSession(homeDir, 'sid-dashboard-c', 'dashboard-c');
}

async function waitForHttp(port, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      if (res.ok) return true;
    } catch (_) {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
  return false;
}

async function requestJson(port, method, pathName, payload = null) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text || '{}'); } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed };
}

async function requestText(port, pathName) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`);
  const text = await res.text();
  return { status: res.status, text };
}

async function runCase(name, fn) {
  try {
    const result = await fn();
    log(`${result.ok ? 'PASS' : 'FAIL'} | ${name} | ${result.detail}`);
    return result.ok;
  } catch (err) {
    log(`FAIL | ${name} | ${err?.message || String(err)}`);
    return false;
  }
}

function findSessionFromDashboard(dashboard, sessionID) {
  const projects = Array.isArray(dashboard?.projects) ? dashboard.projects : [];
  for (const p of projects) {
    const sessions = Array.isArray(p?.sessions) ? p.sessions : [];
    const hit = sessions.find((s) => s?.sessionID === sessionID);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  const homeDir = path.join(tmpRoot, 'home');
  setupHome(homeDir);
  const port = 37991;
  const env = { ...process.env, HOME: homeDir };
  const server = spawn(process.execPath, [dashboardScriptPath, 'serve', String(port), String(process.pid), '4096'], {
    env,
    stdio: 'ignore'
  });

  let pass = 0;
  let total = 0;
  try {
    const ready = await waitForHttp(port);
    if (!ready) {
      log('FAIL | bootstrap dashboard server | dashboard API is not reachable');
      process.exit(1);
    }

    const cases = [
      ['dashboard page and api reachable', async () => {
        const page = await requestText(port, '/');
        const api = await requestJson(port, 'GET', '/api/dashboard');
        const ok =
          page.status === 200
          && page.text.includes('Memory Dashboard')
          && api.status === 200
          && Array.isArray(api.body?.projects);
        return { ok, detail: JSON.stringify({ pageStatus: page.status, apiStatus: api.status, projects: (api.body?.projects || []).length }) };
      }],
      ['settings update requires confirm and persists', async () => {
        const denied = await requestJson(port, 'POST', '/api/memory/settings', { memorySystem: { visibleNoticeCooldownMs: 120000 } });
        const okDenied = denied.status === 400;
        const accepted = await requestJson(port, 'POST', '/api/memory/settings', {
          confirm: true,
          source: 'dashboard_interaction_suite',
          memorySystem: {
            visibleNoticeCooldownMs: 120000,
            independentLlmTimeoutMs: 12000,
            summaryTemplateName: 'suite-template',
            summaryTemplateText: '## SUITE TEMPLATE\n{{keyFacts}}'
          }
        });
        const cfg = readJson(path.join(homeDir, '.opencode', 'memory', 'config.json'));
        const ms = cfg?.memorySystem || {};
        const ok =
          okDenied
          && accepted.status === 200
          && Number(ms.visibleNoticeCooldownMs || 0) === 120000
          && Number(ms.independentLlmTimeoutMs || 0) === 12000
          && String(ms.summaryTemplateName || '') === 'suite-template';
        return { ok, detail: JSON.stringify({ deniedStatus: denied.status, acceptedStatus: accepted.status, memorySystem: ms }) };
      }],
      ['global preference update persists and is visible in dashboard', async () => {
        const set = await requestJson(port, 'POST', '/api/memory/global/preferences', {
          confirm: true,
          key: 'assistant_name',
          value: '仪表盘验收助手',
          source: 'dashboard_interaction_suite'
        });
        const dashboard = await requestJson(port, 'GET', '/api/dashboard');
        const globalName = dashboard.body?.global?.preferences?.assistant_name || '';
        const gm = readJson(path.join(homeDir, '.opencode', 'memory', 'global.json'));
        const ok =
          set.status === 200
          && globalName === '仪表盘验收助手'
          && gm?.preferences?.assistant_name === '仪表盘验收助手';
        return { ok, detail: JSON.stringify({ status: set.status, dashboardName: globalName }) };
      }],
      ['session summary edit writes file and live dashboard', async () => {
        const summaryText = 'manual summary update from dashboard suite';
        const update = await requestJson(port, 'POST', '/api/memory/session/summary', {
          confirm: true,
          projectName,
          sessionID: 'sid-dashboard-a',
          summaryText,
          source: 'dashboard_interaction_suite'
        });
        const session = readJson(sessionPath(homeDir, 'sid-dashboard-a'));
        const dashboard = await requestJson(port, 'GET', '/api/dashboard');
        const built = findSessionFromDashboard(dashboard.body, 'sid-dashboard-a');
        const ok =
          update.status === 200
          && session?.summary?.compressedText === summaryText
          && built?.summary?.compressedText === summaryText;
        return { ok, detail: JSON.stringify({ status: update.status, fileSummary: session?.summary?.compressedText, liveSummary: built?.summary?.compressedText }) };
      }],
      ['manual session summary edit survives restart', async () => {
        const summaryText = 'manual summary persistence check after restart';
        const update = await requestJson(port, 'POST', '/api/memory/session/summary', {
          confirm: true,
          projectName,
          sessionID: 'sid-dashboard-a',
          summaryText,
          source: 'dashboard_interaction_suite_restart_check'
        });
        if (update.status !== 200) {
          return { ok: false, detail: JSON.stringify({ updateStatus: update.status, updateBody: update.body }) };
        }
        const restartPort = port + 1;
        const server2 = spawn(process.execPath, [dashboardScriptPath, 'serve', String(restartPort), String(process.pid), '4096'], {
          env,
          stdio: 'ignore'
        });
        const ready2 = await waitForHttp(restartPort);
        if (!ready2) {
          server2.kill('SIGTERM');
          return { ok: false, detail: 'dashboard restart failed for summary persistence check' };
        }
        const session = readJson(sessionPath(homeDir, 'sid-dashboard-a'));
        const dashboard = await requestJson(restartPort, 'GET', '/api/dashboard');
        const built = findSessionFromDashboard(dashboard.body, 'sid-dashboard-a');
        const ok =
          session?.summary?.compressedText === summaryText
          && built?.summary?.compressedText === summaryText;
        server2.kill('SIGTERM');
        return { ok, detail: JSON.stringify({ fileSummary: session?.summary?.compressedText, liveSummary: built?.summary?.compressedText }) };
      }],
      ['single session delete moves memory to trash and removes session file', async () => {
        const del = await requestJson(port, 'POST', '/api/memory/session/delete', {
          confirm: true,
          projectName,
          sessionID: 'sid-dashboard-b',
          source: 'dashboard_interaction_suite'
        });
        const exists = fs.existsSync(sessionPath(homeDir, 'sid-dashboard-b'));
        const trash = await requestJson(port, 'GET', '/api/memory/trash');
        const hasTrash = Array.isArray(trash.body?.entries)
          ? trash.body.entries.some((e) => String(e?.fileName || '').includes('sid-dashboard-b'))
          : false;
        const ok = del.status === 200 && !exists && hasTrash;
        return { ok, detail: JSON.stringify({ status: del.status, exists, trashHit: hasTrash }) };
      }],
      ['batch session delete removes multiple sessions', async () => {
        createSession(homeDir, 'sid-dashboard-d', 'dashboard-d');
        createSession(homeDir, 'sid-dashboard-e', 'dashboard-e');
        const batch = await requestJson(port, 'POST', '/api/memory/sessions/delete', {
          confirm: true,
          projectName,
          sessionIDs: ['sid-dashboard-d', 'sid-dashboard-e'],
          source: 'dashboard_interaction_suite'
        });
        const leftD = fs.existsSync(sessionPath(homeDir, 'sid-dashboard-d'));
        const leftE = fs.existsSync(sessionPath(homeDir, 'sid-dashboard-e'));
        const ok = batch.status === 200 && !leftD && !leftE && Number(batch.body?.removed || 0) >= 2;
        return { ok, detail: JSON.stringify({ status: batch.status, removed: batch.body?.removed, leftD, leftE }) };
      }],
      ['trash cleanup supports dry-run and real cleanup', async () => {
        const trashFile = path.join(homeDir, '.opencode', 'memory', 'trash', projectName, 'expired-suite.json');
        writeJson(trashFile, { from: 'suite', expired: true });
        const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
        fs.utimesSync(trashFile, old, old);
        const dry = await requestJson(port, 'POST', '/api/memory/trash/cleanup', {
          confirm: true,
          dryRun: true,
          days: 30,
          source: 'dashboard_interaction_suite'
        });
        const real = await requestJson(port, 'POST', '/api/memory/trash/cleanup', {
          confirm: true,
          dryRun: false,
          days: 30,
          source: 'dashboard_interaction_suite'
        });
        const existsAfter = fs.existsSync(trashFile);
        const ok =
          dry.status === 200
          && Number(dry.body?.expired || 0) >= 1
          && Number(dry.body?.removed || 0) === 0
          && real.status === 200
          && Number(real.body?.removed || 0) >= 1
          && !existsAfter;
        return { ok, detail: JSON.stringify({ dry: dry.body, real: real.body, existsAfter }) };
      }],
      ['trash delete endpoint permanently deletes selected entry', async () => {
        const trashFile = path.join(homeDir, '.opencode', 'memory', 'trash', projectName, 'manual-delete-suite.json');
        writeJson(trashFile, { from: 'suite', delete: true });
        const del = await requestJson(port, 'POST', '/api/memory/trash/delete', {
          confirm: true,
          entries: [trashFile],
          source: 'dashboard_interaction_suite'
        });
        const exists = fs.existsSync(trashFile);
        const ok = del.status === 200 && Number(del.body?.removed || 0) === 1 && !exists;
        return { ok, detail: JSON.stringify({ status: del.status, removed: del.body?.removed, exists }) };
      }],
      ['llm model fetch and validate routes are callable', async () => {
        const models = await requestJson(port, 'POST', '/api/memory/llm/models', {
          provider: 'openai_compatible',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-suite',
          timeoutMs: 1000
        });
        const validate = await requestJson(port, 'POST', '/api/memory/llm/validate', {
          provider: 'openai_compatible',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-suite',
          model: 'test-model',
          timeoutMs: 1000
        });
        const ok =
          (models.status === 200 || models.status === 500)
          && (validate.status === 200 || validate.status === 500)
          && typeof models.body === 'object'
          && typeof validate.body === 'object';
        return { ok, detail: JSON.stringify({ modelsStatus: models.status, validateStatus: validate.status }) };
      }],
      ['restart still reads persisted settings and global preferences', async () => {
        server.kill('SIGTERM');
        await sleep(800);
        const server2 = spawn(process.execPath, [dashboardScriptPath, 'serve', String(port), String(process.pid), '4096'], {
          env,
          stdio: 'ignore'
        });
        const ready2 = await waitForHttp(port);
        if (!ready2) {
          server2.kill('SIGTERM');
          return { ok: false, detail: 'dashboard did not restart' };
        }
        const dashboard = await requestJson(port, 'GET', '/api/dashboard');
        const settings = dashboard.body?.settings?.memorySystem || {};
        const globals = dashboard.body?.global?.preferences || {};
        const ok =
          Number(settings.visibleNoticeCooldownMs || 0) === 120000
          && Number(settings.independentLlmTimeoutMs || 0) === 12000
          && String(globals.assistant_name || '') === '仪表盘验收助手';
        server2.kill('SIGTERM');
        return { ok, detail: JSON.stringify({ visibleNoticeCooldownMs: settings.visibleNoticeCooldownMs, independentLlmTimeoutMs: settings.independentLlmTimeoutMs, assistant_name: globals.assistant_name }) };
      }],
      ['template includes zh/en labels for risk indicators', async () => {
        const src = fs.readFileSync(dashboardTemplatePath, 'utf8');
        const ok =
          src.includes('sessionStatRiskStack')
          && src.includes('sessionStatRiskSystem')
          && src.includes('风险:system开销过高')
          && src.includes('risk: high system token overhead');
        return { ok, detail: ok ? 'template risk i18n keys exist' : 'missing risk i18n keys in template' };
      }]
    ];

    for (const [name, fn] of cases) {
      total += 1;
      // eslint-disable-next-line no-await-in-loop
      const ok = await runCase(name, fn);
      if (ok) pass += 1;
    }
  } finally {
    if (!server.killed) {
      try { server.kill('SIGTERM'); } catch {}
    }
  }

  log(`\nResult: ${pass}/${total} scenarios passed.`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
