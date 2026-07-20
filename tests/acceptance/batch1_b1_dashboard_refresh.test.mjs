#!/usr/bin/env node
// Batch1 / B1 — dashboard data refresh endpoint.
//
// Contract: .devflow/INTERFACE-batch1.md, section "B1 — 看板数据刷新端点".
//   B1.1  GET /api/dashboard -> 200 JSON, Cache-Control: no-store...; body has
//         generatedAt, summary{projectCount,sessionCount,eventCount}, projects[],
//         settings.memorySystem/config.memorySystem/global.preferences; every
//         sessions[] has sessionID, summary.compressedText/compressedPreview,
//         summaryBlocks{count,recent}, sendPretrim{...} AND sendPretrim.warmup
//         with the full default key set (plugin shape memory-system.js:8010-8030;
//         NO warmup.summary key).
//   B1.2  the generated index.html refreshes via /api/dashboard, NOT
//         /api/memory/data; and GET /api/memory/data returns 404.
//   B1.3  a session with no sendPretrim.warmup raw data still yields a warmup
//         object of defaults; GET / (render) returns 200 and does not throw.
//
// EXPECTED PRE-FIX FAILURE (unfixed code):
//   dashboard sendPretrim payload (plugins/scripts/opencode_memory_dashboard.mjs
//   :829-840) has NO `warmup` key -> B1.1 and B1.3 fail at "sendPretrim.warmup
//   present with default keys".
//   plugin-generated index.html refreshes via '/api/memory/data'
//   (plugins/memory-system.js:8418) -> B1.2 fails at "index.html must not
//   reference /api/memory/data". (The /api/memory/data 404 already holds.)

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import {
  withPluginHome, sessionPath, writeJson, dashboardScriptPath,
  httpGet, waitForDashboard, runCases, projectName, sleep
} from './_harness.mjs';

const WARMUP_STRING_KEYS = ['sourceHash', 'status', 'mode', 'provider', 'model', 'lastUserMessageID'];
const WARMUP_NUMBER_KEYS = ['consecutiveFails', 'failCount', 'hitCount', 'missCount', 'skipBudgetCount', 'skipCooldownCount', 'skipPausedCount'];
const WARMUP_TS_KEYS = ['lastAttemptAt', 'preparedAt', 'usedAt'];
const WARMUP_ARRAY_KEYS = ['logs'];
const WARMUP_ALL_KEYS = [...WARMUP_STRING_KEYS, ...WARMUP_NUMBER_KEYS, ...WARMUP_TS_KEYS, ...WARMUP_ARRAY_KEYS];

function makeSession(sessionID, withWarmup) {
  const sendPretrim = {
    autoRuns: 2, manualRuns: 0, savedTokensTotal: 1234,
    lastBeforeTokens: 900, lastAfterTokens: 700, lastSavedTokens: 200,
    lastAt: new Date().toISOString(), lastReason: 'auto', lastStatus: 'ok', traces: []
  };
  if (withWarmup) {
    sendPretrim.warmup = {
      sourceHash: 'abc123', status: 'ready', mode: 'auto', provider: 'testProvider', model: 'test-model', lastUserMessageID: 'msg-1',
      consecutiveFails: 0, failCount: 0, hitCount: 3, missCount: 1, skipBudgetCount: 0, skipCooldownCount: 0, skipPausedCount: 0,
      lastAttemptAt: new Date().toISOString(), preparedAt: new Date().toISOString(), usedAt: null,
      logs: ['prepared']
    };
  }
  return {
    sessionID, sessionTitle: sessionID, project: projectName, sessionCwd: process.cwd(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    stats: { userMessages: 1, assistantMessages: 1, toolResults: 1, systemEvents: 0 },
    recentEvents: [{ ts: new Date().toISOString(), kind: 'user-message', summary: `hi-${sessionID}` }],
    summary: { compressedText: `summary-${sessionID}`, compressedEvents: 1, lastCompressedAt: new Date().toISOString() },
    summaryBlocks: [],
    recall: { count: 0, lastAt: null }, inject: {},
    budget: { bodyTokenBudget: 50000, lastEstimatedBodyTokens: 100 },
    pruneAudit: { autoRuns: 0, manualRuns: 0, discardRemovedTotal: 0, extractMovedTotal: 0 },
    sendPretrim, alerts: {}
  };
}

// Boot a home, write two sessions + generate index.html via the plugin, then
// spawn the real dashboard HTTP server. Returns { port, indexHtml, stop }.
async function bootDashboard(name) {
  return await withPluginHome(name, async ({ homeDir, plugin }) => {
    writeJson(sessionPath(homeDir, 'sid-with-warmup'), makeSession('sid-with-warmup', true));
    writeJson(sessionPath(homeDir, 'sid-no-warmup'), makeSession('sid-no-warmup', false));
    // Plugin writes index.html (embeds the client refresh endpoint).
    plugin.__test.writeDashboardFilesNow();
    const indexPath = path.join(homeDir, '.opencode', 'memory', 'dashboard', 'index.html');
    const indexHtml = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';

    const port = 38000 + Math.floor(Math.random() * 1500);
    const server = spawn(
      process.execPath,
      [dashboardScriptPath, 'serve', String(port), String(process.pid), '4096'],
      { env: { ...process.env, HOME: homeDir }, stdio: 'ignore' }
    );
    const ready = await waitForDashboard(port);
    return { port, indexHtml, ready, server, homeDir };
  });
}

let ctx = null;

async function testDashboardApiShapeAndWarmup() {
  const { port, ready } = ctx;
  if (!ready) return { ok: false, detail: 'dashboard server never became reachable' };
  const res = await httpGet(port, '/api/dashboard');
  if (res.status !== 200) return { ok: false, detail: `status=${res.status}` };

  const ctType = String(res.headers['content-type'] || '');
  const cacheCtl = String(res.headers['cache-control'] || '');
  let body;
  try { body = JSON.parse(res.text); } catch (e) { return { ok: false, detail: `body not JSON: ${e.message}` }; }

  const topOk = typeof body.generatedAt === 'string'
    && body.summary && typeof body.summary.projectCount === 'number'
    && typeof body.summary.sessionCount === 'number' && typeof body.summary.eventCount === 'number'
    && Array.isArray(body.projects)
    && body.settings && body.settings.memorySystem !== undefined
    && body.config && body.config.memorySystem !== undefined
    && body.global && body.global.preferences !== undefined;

  const allSessions = body.projects.flatMap((p) => Array.isArray(p.sessions) ? p.sessions : []);
  const target = allSessions.find((s) => s.sessionID === 'sid-with-warmup');
  if (!target) return { ok: false, detail: `session not found; sessions=${allSessions.map((s) => s.sessionID).join(',')}` };

  const sessionShapeOk = typeof target.sessionID === 'string'
    && target.summary && typeof target.summary.compressedText === 'string' && typeof target.summary.compressedPreview === 'string'
    && target.summaryBlocks && typeof target.summaryBlocks.count === 'number'
    && target.sendPretrim && typeof target.sendPretrim === 'object';

  const warmup = target.sendPretrim && target.sendPretrim.warmup;
  const warmupPresent = warmup && typeof warmup === 'object';
  const missingKeys = warmupPresent ? WARMUP_ALL_KEYS.filter((k) => !(k in warmup)) : WARMUP_ALL_KEYS;
  const warmupOk = warmupPresent && missingKeys.length === 0;

  const ok = ctType.includes('json') && /no-store/.test(cacheCtl) && topOk && sessionShapeOk && warmupOk;
  return {
    ok,
    detail: `ctype=${ctType.includes('json')} noStore=${/no-store/.test(cacheCtl)} top=${topOk} sessionShape=${sessionShapeOk} warmupPresent=${!!warmupPresent} missingWarmupKeys=[${missingKeys.join(',')}]`
  };
}

async function testWarmupDefaultsWhenMissing() {
  const { port, ready } = ctx;
  if (!ready) return { ok: false, detail: 'dashboard server never became reachable' };
  const res = await httpGet(port, '/api/dashboard');
  const body = JSON.parse(res.text);
  const allSessions = body.projects.flatMap((p) => Array.isArray(p.sessions) ? p.sessions : []);
  const target = allSessions.find((s) => s.sessionID === 'sid-no-warmup');
  const warmup = target && target.sendPretrim && target.sendPretrim.warmup;
  const warmupPresent = warmup && typeof warmup === 'object';
  const missingKeys = warmupPresent ? WARMUP_ALL_KEYS.filter((k) => !(k in warmup)) : WARMUP_ALL_KEYS;
  const defaultsOk = warmupPresent
    && WARMUP_STRING_KEYS.every((k) => warmup[k] === '')
    && WARMUP_NUMBER_KEYS.every((k) => warmup[k] === 0)
    && WARMUP_TS_KEYS.every((k) => warmup[k] === null)
    && Array.isArray(warmup.logs) && warmup.logs.length === 0;

  // render page must not throw
  const page = await httpGet(port, '/');
  const renderOk = page.status === 200 && page.text.length > 0;

  const ok = warmupPresent && missingKeys.length === 0 && defaultsOk && renderOk;
  return { ok, detail: `warmupPresent=${!!warmupPresent} defaults=${defaultsOk} renderStatus=${page.status} missing=[${missingKeys.join(',')}]` };
}

async function testRefreshEndpointAndNoData() {
  const { port, ready, indexHtml } = ctx;
  if (!ready) return { ok: false, detail: 'dashboard server never became reachable' };

  const indexHasDashboard = indexHtml.includes('/api/dashboard');
  const indexHasOldData = indexHtml.includes('/api/memory/data');
  const data404 = await httpGet(port, '/api/memory/data');

  const ok = indexHasDashboard && !indexHasOldData && data404.status === 404;
  return {
    ok,
    detail: `index->/api/dashboard=${indexHasDashboard} index->/api/memory/data(shouldBeFalse)=${indexHasOldData} /api/memory/data status=${data404.status}`
  };
}

async function main() {
  ctx = await bootDashboard('b1_dashboard');
  try {
    await runCasesKeepOpen();
  } finally {
    if (ctx?.server && !ctx.server.killed) {
      try { ctx.server.kill('SIGTERM'); } catch (_) {}
    }
  }
}

// runCases from harness calls process.exit; we need to tear down the server first,
// so run inline and exit here.
async function runCasesKeepOpen() {
  const cases = [
    ['B1.1 /api/dashboard shape + sendPretrim.warmup full key set', testDashboardApiShapeAndWarmup],
    ['B1.3 warmup defaults when session lacks warmup + render 200', testWarmupDefaultsWhenMissing],
    ['B1.2 index.html refreshes via /api/dashboard; /api/memory/data 404', testRefreshEndpointAndNoData]
  ];
  let pass = 0;
  for (const [name, fn] of cases) {
    let result;
    try { result = await fn(); } catch (err) { result = { ok: false, detail: `threw: ${err?.message || err}` }; }
    if (result.ok) pass += 1;
    process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} | ${name} | ${result.detail}\n`);
  }
  process.stdout.write(`\nResult: ${pass}/${cases.length} scenarios passed.\n`);
  if (ctx?.server && !ctx.server.killed) { try { ctx.server.kill('SIGTERM'); } catch (_) {} }
  await sleep(200);
  process.exit(pass === cases.length ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`FAIL | suite runtime error | ${err?.stack || err?.message || String(err)}\n`);
  if (ctx?.server && !ctx.server.killed) { try { ctx.server.kill('SIGTERM'); } catch (_) {} }
  process.exit(1);
});
