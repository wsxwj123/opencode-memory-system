#!/usr/bin/env node
// Batch2 security — dashboard HTTP hardening (black-box, real server).
//
// Decision: auth = Host + Origin + Content-Type triple header check (no token).
//
// Contracts under test (each has an attack case AND a legit case so a fix that
// simply blocks everything does NOT pass):
//
//   C1a  Dashboard Host check.
//        GET /api/dashboard with Host: evil.com  -> 403 (reject).
//        GET /api/dashboard with Host: 127.0.0.1:<port> (and localhost) -> 200.
//        EXPECTED PRE-FIX FAILURE: serve() has no Host check
//          (opencode_memory_dashboard.mjs serve(), ~L1259) -> evil Host returns 200.
//
//   C1b  apiKey never echoed in clear.
//        With config.json memorySystem.independentLlmApiKey = "<secret>",
//        GET /api/dashboard and GET /api/memory/settings responses must NOT
//        contain the raw secret (masked / "configured" boolean is fine).
//        EXPECTED PRE-FIX FAILURE: getMemorySystemSettings() is echoed verbatim
//          (dashboard L1307-1310 + buildLiveDashboardData L908-913) -> raw key leaks.
//
//   H1   Write-endpoint CSRF protection.
//        POST /api/memory/session/delete with a fully-valid JSON body but
//          (a) Content-Type: text/plain, or
//          (b) Origin: http://evil.com
//        must be rejected (403/415) and MUST NOT delete the target session.
//        A same-origin application/json POST must succeed and delete.
//        EXPECTED PRE-FIX FAILURE: readJsonBody (L933) ignores Content-Type and
//          there is no Origin check -> both attacks delete the session (200).
//
//   L1   Static-file directory-escape.
//        A path that path.join-folds into a SIBLING dir whose name starts with
//          "dashboard" (…/memory/dashboard-evil/secret.txt via /../dashboard-evil/…)
//        must be 403. A real file inside …/memory/dashboard/ must be 200.
//        EXPECTED PRE-FIX FAILURE: guard is `target.startsWith(dashboardDir)`
//          (L1614-1619) — prefix match, so dashboard-evil/… is served (200 + secret).
//
// Run: node tests/acceptance/batch2_security.test.mjs

import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import {
  withPluginHome, sessionPath, writeJson, writeRaw, dashboardScriptPath,
  waitForDashboard, projectName, sleep
} from './_harness.mjs';

const SECRET_API_KEY = 'sk-SECRETredact1234567890ABCDEFghijklmn';
const STATIC_SECRET = 'STATIC-SIBLING-SECRET-9f3a2b';

// Raw HTTP request with full control over headers/method/body.
function httpReq(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers };
    if (payload != null && !('Content-Length' in h)) h['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, text: '', error: String(err?.message || err) }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, text: '', error: 'timeout' }); });
    if (payload != null) req.write(payload);
    req.end();
  });
}

let ctx = null;

async function boot() {
  return await withPluginHome('batch2_security', async ({ homeDir }) => {
    const memoryDir = path.join(homeDir, '.opencode', 'memory');

    // C1b: config with a plaintext independent-LLM key.
    writeJson(path.join(memoryDir, 'config.json'), {
      trashRetentionDays: 30,
      memorySystem: {
        independentLlmMode: true,
        independentLlmProvider: 'openai_compatible',
        independentLlmBaseURL: 'https://example.invalid/v1',
        independentLlmApiKey: SECRET_API_KEY,
        independentLlmModel: 'test-model',
        // Guard A: numeric "token"-named fields that must NOT be masked.
        independentLlmMaxTokens: 512,
        recallTokenBudget: 8000
      }
    });

    // H1: three distinct sessions so cases are order-independent.
    for (const sid of ['h1-textplain', 'h1-evilorigin', 'h1-legit']) {
      writeJson(sessionPath(homeDir, sid), {
        sessionID: sid, sessionTitle: sid, project: projectName, sessionCwd: process.cwd(),
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        stats: { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 },
        recentEvents: [{ ts: new Date().toISOString(), kind: 'user-message', summary: `hi-${sid}` }],
        summary: {}, summaryBlocks: [], recall: {}, inject: {}, budget: {}, pruneAudit: {}, sendPretrim: {}, alerts: {}
      });
    }

    // L1: sibling dir whose name starts with "dashboard" + a legit file inside dashboardDir.
    writeRaw(path.join(memoryDir, 'dashboard-evil', 'secret.txt'), STATIC_SECRET);
    writeRaw(path.join(memoryDir, 'dashboard', 'ok.txt'), 'inside-dashboard-ok');

    const port = 38200 + Math.floor(Math.random() * 1200);
    const server = spawn(
      process.execPath,
      [dashboardScriptPath, 'serve', String(port), String(process.pid), '4096'],
      { env: { ...process.env, HOME: homeDir }, stdio: 'ignore' }
    );
    const ready = await waitForDashboard(port);
    return { port, ready, server, homeDir };
  });
}

// ---- C1a ----
async function test_C1a_host_reject_evil() {
  const { port } = ctx;
  const res = await httpReq(port, { method: 'GET', path: '/api/dashboard', headers: { Host: 'evil.com' } });
  const ok = res.status === 403;
  return { ok, detail: `evil Host -> status=${res.status} (want 403)` };
}
async function test_C1a_host_allow_local() {
  const { port } = ctx;
  const a = await httpReq(port, { method: 'GET', path: '/api/dashboard', headers: { Host: `127.0.0.1:${port}` } });
  const b = await httpReq(port, { method: 'GET', path: '/api/dashboard', headers: { Host: `localhost:${port}` } });
  const ok = a.status === 200 && b.status === 200;
  return { ok, detail: `127.0.0.1 -> ${a.status}, localhost -> ${b.status} (want 200/200)` };
}

// ---- C1b ----
async function test_C1b_no_plaintext_key_dashboard() {
  const { port } = ctx;
  const res = await httpReq(port, { method: 'GET', path: '/api/dashboard', headers: { Host: `127.0.0.1:${port}` } });
  const leaked = res.status === 200 && res.text.includes(SECRET_API_KEY);
  return { ok: res.status === 200 && !leaked, detail: `status=${res.status} rawKeyPresent=${leaked} (want key absent)` };
}
async function test_C1b_no_plaintext_key_settings() {
  const { port } = ctx;
  const res = await httpReq(port, { method: 'GET', path: '/api/memory/settings', headers: { Host: `127.0.0.1:${port}` } });
  const leaked = res.status === 200 && res.text.includes(SECRET_API_KEY);
  return { ok: res.status === 200 && !leaked, detail: `status=${res.status} rawKeyPresent=${leaked} (want key absent)` };
}

// ---- Guard A: masking must not clobber numeric "token"-named fields ----
// isSecretFieldName substring-matches "token" -> independentLlmMaxTokens /
// recallTokenBudget get masked to ****. Contract: numeric fields keep original
// value AND independentLlmApiKey is still masked.
// PRE-FIX (no masking yet): apiKey leaks raw -> keyMasked=false -> FAIL.
function checkGuardA(ms) {
  const numOk = ms && ms.independentLlmMaxTokens === 512 && ms.recallTokenBudget === 8000;
  const keyMasked = !ms || ms.independentLlmApiKey === undefined || ms.independentLlmApiKey !== SECRET_API_KEY;
  return { numOk, keyMasked };
}
async function test_GuardA_dashboard_numeric_not_masked() {
  const { port } = ctx;
  const res = await httpReq(port, { method: 'GET', path: '/api/dashboard', headers: { Host: `127.0.0.1:${port}` } });
  let ms;
  try { ms = JSON.parse(res.text)?.settings?.memorySystem; } catch { return { ok: false, detail: `body not JSON (status=${res.status})` }; }
  const { numOk, keyMasked } = checkGuardA(ms);
  return { ok: res.status === 200 && numOk && keyMasked, detail: `numericPreserved=${numOk} apiKeyMasked=${keyMasked} maxTokens=${ms?.independentLlmMaxTokens} recallBudget=${ms?.recallTokenBudget}` };
}
async function test_GuardA_settings_numeric_not_masked() {
  const { port } = ctx;
  const res = await httpReq(port, { method: 'GET', path: '/api/memory/settings', headers: { Host: `127.0.0.1:${port}` } });
  let ms;
  try { ms = JSON.parse(res.text)?.memorySystem; } catch { return { ok: false, detail: `body not JSON (status=${res.status})` }; }
  const { numOk, keyMasked } = checkGuardA(ms);
  return { ok: res.status === 200 && numOk && keyMasked, detail: `numericPreserved=${numOk} apiKeyMasked=${keyMasked} maxTokens=${ms?.independentLlmMaxTokens} recallBudget=${ms?.recallTokenBudget}` };
}

// ---- H1 ----
function sessionExists(sid) { return fs.existsSync(sessionPath(ctx.homeDir, sid)); }

async function test_H1_reject_text_plain() {
  const { port } = ctx;
  const before = sessionExists('h1-textplain');
  const res = await httpReq(port, {
    method: 'POST', path: '/api/memory/session/delete',
    headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ confirm: true, projectName, sessionID: 'h1-textplain' })
  });
  const stillThere = sessionExists('h1-textplain');
  const ok = before && (res.status === 403 || res.status === 415) && stillThere;
  return { ok, detail: `status=${res.status} (want 403/415) sessionKept=${stillThere}` };
}
async function test_H1_reject_cross_origin() {
  const { port } = ctx;
  const before = sessionExists('h1-evilorigin');
  const res = await httpReq(port, {
    method: 'POST', path: '/api/memory/session/delete',
    headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', Origin: 'http://evil.com' },
    body: { confirm: true, projectName, sessionID: 'h1-evilorigin' }
  });
  const stillThere = sessionExists('h1-evilorigin');
  const ok = before && (res.status === 403 || res.status === 415) && stillThere;
  return { ok, detail: `status=${res.status} (want 403/415) sessionKept=${stillThere}` };
}
async function test_H1_allow_same_origin_json() {
  const { port } = ctx;
  const before = sessionExists('h1-legit');
  const res = await httpReq(port, {
    method: 'POST', path: '/api/memory/session/delete',
    headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
    body: { confirm: true, projectName, sessionID: 'h1-legit' }
  });
  const gone = !sessionExists('h1-legit');
  const ok = before && res.status === 200 && gone;
  return { ok, detail: `status=${res.status} (want 200) sessionDeleted=${gone}` };
}

// ---- L1 ----
async function test_L1_reject_sibling_escape() {
  const { port } = ctx;
  const res = await httpReq(port, {
    method: 'GET', path: '/../dashboard-evil/secret.txt', headers: { Host: `127.0.0.1:${port}` }
  });
  const leaked = res.text.includes(STATIC_SECRET);
  const ok = res.status === 403 && !leaked;
  return { ok, detail: `status=${res.status} (want 403) secretLeaked=${leaked}` };
}
async function test_L1_allow_inside_dashboard() {
  const { port } = ctx;
  const res = await httpReq(port, { method: 'GET', path: '/ok.txt', headers: { Host: `127.0.0.1:${port}` } });
  const ok = res.status === 200 && res.text.includes('inside-dashboard-ok');
  return { ok, detail: `status=${res.status} (want 200) served=${res.text.includes('inside-dashboard-ok')}` };
}

async function main() {
  ctx = await boot();
  const cases = [
    ['C1a attack: Host evil.com rejected (403)', test_C1a_host_reject_evil],
    ['C1a legit: Host 127.0.0.1/localhost allowed (200)', test_C1a_host_allow_local],
    ['C1b attack: /api/dashboard hides raw apiKey', test_C1b_no_plaintext_key_dashboard],
    ['C1b attack: /api/memory/settings hides raw apiKey', test_C1b_no_plaintext_key_settings],
    ['GuardA: /api/dashboard keeps numeric token fields, masks apiKey', test_GuardA_dashboard_numeric_not_masked],
    ['GuardA: /api/memory/settings keeps numeric token fields, masks apiKey', test_GuardA_settings_numeric_not_masked],
    ['H1 attack: text/plain POST delete rejected + session kept', test_H1_reject_text_plain],
    ['H1 attack: cross-origin POST delete rejected + session kept', test_H1_reject_cross_origin],
    ['H1 legit: same-origin json POST delete succeeds', test_H1_allow_same_origin_json],
    ['L1 attack: /../dashboard-evil escape rejected (403)', test_L1_reject_sibling_escape],
    ['L1 legit: file inside dashboard served (200)', test_L1_allow_inside_dashboard]
  ];
  let pass = 0;
  if (!ctx.ready) {
    process.stdout.write('FAIL | suite | dashboard server never became reachable\n');
  } else {
    for (const [name, fn] of cases) {
      let r;
      try { r = await fn(); } catch (e) { r = { ok: false, detail: `threw: ${e?.message || e}` }; }
      if (r.ok) pass += 1;
      process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} | ${name} | ${r.detail}\n`);
    }
  }
  process.stdout.write(`\nResult: ${pass}/${cases.length} scenarios passed.\n`);
  if (ctx?.server && !ctx.server.killed) { try { ctx.server.kill('SIGKILL'); } catch (_) {} }
  await sleep(200);
  process.exit(ctx.ready && pass === cases.length ? 0 : 1);
}

main().catch((err) => {
  process.stdout.write(`FAIL | suite runtime error | ${err?.stack || err?.message || String(err)}\n`);
  if (ctx?.server && !ctx.server.killed) { try { ctx.server.kill('SIGKILL'); } catch (_) {} }
  process.exit(1);
});
