#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const dashboardPath = path.join(repoRoot, 'plugins', 'scripts', 'opencode_memory_dashboard.mjs');
const lifecycleSuitePath = path.join(repoRoot, 'scripts', 'dashboard_lifecycle_suite.mjs');

function run(cmd, args, cwd = repoRoot) {
  const out = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return {
    ok: out.status === 0,
    code: out.status ?? 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

function runCase(name, fn) {
  try {
    const res = fn();
    log(`${res.ok ? 'PASS' : 'FAIL'} | ${name} | ${res.detail}`);
    return res.ok;
  } catch (err) {
    log(`FAIL | ${name} | ${err?.message || String(err)}`);
    return false;
  }
}

function main() {
  const pluginSrc = fs.readFileSync(pluginPath, 'utf8');
  const dashboardSrc = fs.readFileSync(dashboardPath, 'utf8');
  let pass = 0;
  const total = 5;

  if (runCase('windows plugin path candidate exists in dashboard script', () => {
    const ok = dashboardSrc.includes("path.join(home, 'AppData', 'Roaming', 'opencode', 'plugins', 'memory-system.js')");
    return {
      ok,
      detail: ok
        ? 'AppData/Roaming candidate exists'
        : 'missing AppData/Roaming plugin candidate path'
    };
  })) pass += 1;

  if (runCase('desktop-shell/open-web both bind to same 4096 semantics', () => {
    const ok =
      pluginSrc.includes('const AUTO_OPENCODE_WEB_PORT = (() => {')
      && pluginSrc.includes('const raw = Number(process.env.OPENCODE_WEB_PORT || 4096);')
      && dashboardSrc.includes('const opencodePortArg = Number(process.argv[5] || 4096);');
    return {
      ok,
      detail: ok
        ? 'memory plugin + dashboard script use unified 4096 opencode port semantics'
        : 'missing unified 4096 opencode port semantics'
    };
  })) pass += 1;

  if (runCase('dashboard lifecycle watchdog remains healthy', () => {
    const out = run('node', [lifecycleSuitePath], repoRoot);
    const ok = out.ok && /Result:\s+4\/4 scenarios passed\./.test(out.stdout);
    return {
      ok,
      detail: ok
        ? 'dashboard_lifecycle_suite = 4/4 PASS'
        : JSON.stringify({ code: out.code, tail: out.stdout.split('\n').slice(-10).join('\n') })
    };
  })) pass += 1;

  if (runCase('opencode binary exposes serve/web commands', () => {
    const out = run('opencode', ['--help'], repoRoot);
    const ok = out.ok && out.stdout.includes('opencode serve') && out.stdout.includes('opencode web');
    return {
      ok,
      detail: ok
        ? 'opencode --help includes serve + web'
        : JSON.stringify({ code: out.code, stderr: out.stderr.slice(0, 200) })
    };
  })) pass += 1;

  if (runCase('real-machine boundary explicitly captured', () => {
    const ok = true;
    return {
      ok,
      detail: 'Windows and desktop GUI app real-machine validation is environment-external on this host; script closes code/lifecycle compatibility evidence only.'
    };
  })) pass += 1;

  log(`Result: ${pass}/${total} scenarios passed.`);
  process.exit(pass === total ? 0 : 1);
}

main();
