#!/usr/bin/env node
import { spawnSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HOST = '127.0.0.1';
const PORT = 4096;
const DB_PATH = '/Users/wsxwj/.local/share/opencode/opencode.db';

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    maxBuffer: 64 * 1024 * 1024
  });
  return {
    ok: res.status === 0,
    code: res.status ?? 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitServerReady(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ignore
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
  return false;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function archivedCount(items) {
  if (!Array.isArray(items)) return 0;
  return items.filter((x) => x?.time?.archived != null).length;
}

function archivedIDs(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((x) => x?.time?.archived != null)
    .map((x) => String(x?.id || ''))
    .filter(Boolean)
    .sort();
}

function sameArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function ensureServer() {
  const baseUrl = `http://${HOST}:${PORT}/`;
  const ready = await waitServerReady(baseUrl, 1200);
  if (ready) return { started: false, child: null };

  const child = spawn('opencode', ['serve', '--port', String(PORT), '--hostname', HOST], {
    stdio: 'ignore',
    detached: false
  });
  const started = await waitServerReady(baseUrl, 9000);
  if (!started) {
    try { child.kill('SIGKILL'); } catch {}
    return { started: false, child: null, failed: true };
  }
  return { started: true, child };
}

function stopServer(child) {
  if (!child) return;
  try { child.kill('SIGTERM'); } catch {}
}

async function runArchiveChecks() {
  const urlBase = `http://${HOST}:${PORT}/session`;
  const baseRes = await fetch(`${urlBase}?limit=200`);
  const falseRes = await fetch(`${urlBase}?archived=false&limit=200`);
  const trueRes = await fetch(`${urlBase}?archived=true&limit=200`);
  const baseJson = parseJson(await baseRes.text()) || [];
  const falseJson = parseJson(await falseRes.text()) || [];
  const trueJson = parseJson(await trueRes.text()) || [];

  const baseArchived = archivedCount(baseJson);
  const falseArchived = archivedCount(falseJson);
  const trueArchived = archivedCount(trueJson);
  const falseIDs = archivedIDs(falseJson);
  const trueIDs = archivedIDs(trueJson);
  const sameArchivedSet = sameArray(falseIDs, trueIDs);

  let sqliteCounts = '';
  let sqliteProbe = '';
  let probeID = falseIDs[0] || '';
  const c1 = run('sqlite3', [DB_PATH, 'select count(*)||"|"||sum(case when time_archived is not null then 1 else 0 end) from session;']);
  if (c1.ok) sqliteCounts = c1.stdout.trim();
  if (probeID) {
    const c2 = run('sqlite3', [DB_PATH, `select id||"|"||ifnull(time_archived,"") from session where id='${probeID}';`]);
    if (c2.ok) sqliteProbe = c2.stdout.trim();
  }

  const archiveFilterMissing =
    falseArchived > 0
    && trueArchived > 0
    && falseArchived === trueArchived
    && sameArchivedSet;

  return {
    ok: archiveFilterMissing && Boolean(sqliteCounts),
    detail: {
      apiCounts: {
        baseCount: Array.isArray(baseJson) ? baseJson.length : -1,
        baseArchived,
        archivedFalseCount: Array.isArray(falseJson) ? falseJson.length : -1,
        archivedFalseArchived: falseArchived,
        archivedTrueCount: Array.isArray(trueJson) ? trueJson.length : -1,
        archivedTrueArchived: trueArchived,
        sameArchivedSet
      },
      sqliteCounts,
      sqliteProbe
    }
  };
}

function runNoticeChecks(repoRoot) {
  const suite = run('node', ['scripts/run_path_regression_suite.mjs'], { cwd: repoRoot });
  if (!suite.ok) {
    return {
      ok: false,
      detail: {
        error: 'run_path_regression_suite failed',
        code: suite.code,
        tail: suite.stdout.split('\n').slice(-30).join('\n')
      }
    };
  }
  const lines = suite.stdout.split('\n');
  const required = [
    'PASS | visible notice prefers tui toast when available |',
    'PASS | visible notice falls back to session.prompt when toast unavailable |',
    'PASS | visible notice falls back to session.update when toast and prompt unavailable |',
    'PASS | visible notices disabled suppresses delivery |',
    'PASS | visible notice (toast path) does not create extra session files |',
    'PASS | visible notice (prompt fallback) does not create extra session files |'
  ];
  const missing = required.filter((s) => !lines.some((line) => line.includes(s)));
  const resultLine = lines.find((line) => line.startsWith('Result: ')) || '';
  const resultPass = /Result:\s+(\d+)\/(\d+)\s+scenarios passed\./.test(resultLine);
  return {
    ok: missing.length === 0 && resultPass,
    detail: {
      resultLine,
      missingRequired: missing
    }
  };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const server = await ensureServer();
  if (server.failed) {
    log('FAIL | bootstrap 4096 server | cannot reach opencode serve');
    process.exit(1);
  }

  let pass = 0;
  const total = 2;
  try {
    const notice = runNoticeChecks(repoRoot);
    log(`${notice.ok ? 'PASS' : 'FAIL'} | notice transport consistency | ${JSON.stringify(notice.detail)}`);
    if (notice.ok) pass += 1;

    const archive = await runArchiveChecks();
    log(`${archive.ok ? 'PASS' : 'FAIL'} | archive path and filter evidence | ${JSON.stringify(archive.detail)}`);
    if (archive.ok) pass += 1;
  } finally {
    if (server.started) stopServer(server.child);
  }

  log(`Result: ${pass}/${total} scenarios passed.`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((err) => {
  log(`FAIL | suite runtime error | ${err?.message || String(err)}`);
  process.exit(1);
});
