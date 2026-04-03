#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const dashboardScriptPath = path.join(repoRoot, 'plugins', 'scripts', 'opencode_memory_dashboard.mjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-dashboard-lifecycle-'));

function log(line) {
  process.stdout.write(`${line}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortListening(port) {
  return await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: '/', timeout: 500 },
      () => resolve(true)
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function allocateFreePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const allocated = Number(addr?.port || 0);
      server.close(() => resolve(allocated));
    });
  });
}

async function waitForPort(port, expected, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const listening = await isPortListening(port);
    if (listening === expected) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
  return false;
}

async function testPluginLaunchPassesRealParentPid() {
  const src = fs.readFileSync(pluginSrcPath, 'utf8');
  const ok =
    src.includes("String(process.pid)")
    && !src.includes("String(AUTO_DASHBOARD_PORT),\n        '0',");
  return {
    ok,
    detail: ok ? 'memory-system dashboard autostart passes process.pid' : 'memory-system dashboard autostart still uses static parent pid'
  };
}

async function testPluginAutostartDoesNotForceDashboardRestart() {
  const src = fs.readFileSync(pluginSrcPath, 'utf8');
  const ok =
    src.includes("dashboardServiceScript,\n        'start',")
    && !src.includes("dashboardServiceScript,\n        'restart',");
  return {
    ok,
    detail: ok
      ? 'memory-system dashboard autostart preserves existing dashboard ownership'
      : 'memory-system dashboard autostart still forces restart and can steal dashboard ownership'
  };
}

async function testDashboardScriptTokenViewMetadataMatchesPlugin() {
  const src = fs.readFileSync(dashboardScriptPath, 'utf8');
  const ok =
    src.includes("estimateMethod: 'heuristic_chars_div_4'")
    && src.includes("estimateBase: 'ceil(chars/4)'")
    && src.includes('exactBillingEquivalent: false')
    && src.includes('bodyIncludesCompressedSummary: true')
    && src.includes("displayNote: 'Estimated tokens use ceil(chars/4). total=body+system; plugin-hint is displayed separately and not included in total.'");
  return {
    ok,
    detail: ok
      ? 'dashboard script token view metadata matches plugin semantics'
      : 'dashboard script still exposes stale token-view semantics'
  };
}

async function testDashboardParentBindingOverridesGlobalProcessProbe() {
  const homeDir = path.join(tmpRoot, 'parent_binding');
  fs.mkdirSync(homeDir, { recursive: true });
  const fakeBinDir = path.join(homeDir, 'bin');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const fakeOpencodePath = path.join(fakeBinDir, 'opencode');
  try {
    fs.symlinkSync('/bin/sleep', fakeOpencodePath);
  } catch {
    if (!fs.existsSync(fakeOpencodePath)) throw new Error('failed to prepare fake opencode binary');
  }

  const dashboardPort = await allocateFreePort();
  const fakeOpencodePort = await allocateFreePort();
  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCODE_MEMORY_DASHBOARD_WATCHDOG_INTERVAL_MS: '500',
    OPENCODE_MEMORY_DASHBOARD_WATCHDOG_MAX_MISS: '2'
  };

  const fakeOpencode = spawn(fakeOpencodePath, ['30'], { env, stdio: 'ignore' });
  const fakeParent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env, stdio: 'ignore' });

  let started = false;
  try {
    const start = spawnSync(
      process.execPath,
      [dashboardScriptPath, 'start', String(dashboardPort), String(fakeParent.pid), String(fakeOpencodePort)],
      { env, encoding: 'utf8' }
    );
    if (start.status !== 0) {
      return {
        ok: false,
        detail: `start failed: ${start.stderr || start.stdout || start.status}`
      };
    }
    started = true;

    const up = await waitForPort(dashboardPort, true, 6000);
    if (!up) {
      return {
        ok: false,
        detail: 'dashboard never became reachable'
      };
    }

    process.kill(fakeParent.pid, 'SIGTERM');
    const down = await waitForPort(dashboardPort, false, 4000);
    return {
      ok: down,
      detail: down
        ? 'dashboard exited after parent death despite unrelated opencode-like process'
        : 'dashboard stayed alive after explicit parent died'
    };
  } finally {
    if (started) {
      spawnSync(process.execPath, [dashboardScriptPath, 'stop', String(dashboardPort)], { env, stdio: 'ignore' });
    }
    if (isPidAlive(fakeParent.pid)) {
      try { process.kill(fakeParent.pid, 'SIGTERM'); } catch {}
    }
    if (isPidAlive(fakeOpencode.pid)) {
      try { process.kill(fakeOpencode.pid, 'SIGTERM'); } catch {}
    }
  }
}

async function main() {
  const cases = [
    ['plugin launch passes real parent pid', testPluginLaunchPassesRealParentPid],
    ['plugin autostart does not force dashboard restart', testPluginAutostartDoesNotForceDashboardRestart],
    ['dashboard script token view metadata matches plugin', testDashboardScriptTokenViewMetadataMatchesPlugin],
    ['dashboard exits when explicit parent dies even if unrelated opencode-like process exists', testDashboardParentBindingOverridesGlobalProcessProbe]
  ];
  let pass = 0;
  for (const [name, run] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const result = await run();
    if (result.ok) pass += 1;
    log(`${result.ok ? 'PASS' : 'FAIL'} | ${name} | ${result.detail}`);
  }
  log(`\nResult: ${pass}/${cases.length} scenarios passed.`);
  process.exit(pass === cases.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
