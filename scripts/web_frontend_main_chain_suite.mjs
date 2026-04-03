#!/usr/bin/env node
import { spawnSync } from 'child_process';

function run(cmd, args, cwd = process.cwd()) {
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

function mustContain(stdout, markers = []) {
  const lines = String(stdout || '').split('\n');
  const missing = markers.filter((m) => !lines.some((line) => line.includes(m)));
  return { ok: missing.length === 0, missing };
}

function runCase(name, fn) {
  try {
    const result = fn();
    log(`${result.ok ? 'PASS' : 'FAIL'} | ${name} | ${result.detail}`);
    return result.ok;
  } catch (err) {
    log(`FAIL | ${name} | ${err?.message || String(err)}`);
    return false;
  }
}

function isAllPassedResultLine(line = '') {
  const m = String(line || '').match(/Result:\s+(\d+)\/(\d+)\s+scenarios passed\./);
  if (!m) return false;
  return Number(m[1]) === Number(m[2]) && Number(m[2]) > 0;
}

function main() {
  const repoRoot = process.cwd();
  let pass = 0;
  const total = 3;

  const case1 = runCase('dashboard interaction full chain', () => {
    const r = run('node', ['scripts/dashboard_interaction_acceptance_suite.mjs'], repoRoot);
    if (!r.ok) {
      return {
        ok: false,
        detail: JSON.stringify({ code: r.code, tail: r.stdout.split('\n').slice(-20).join('\n') })
      };
    }
    const marker = mustContain(r.stdout, [
      'PASS | session summary edit writes file and live dashboard |',
      'PASS | manual session summary edit survives restart |'
    ]);
    const resultLine = r.stdout.split('\n').find((line) => /^Result: \d+\/\d+ scenarios passed\./.test(line)) || '';
    return {
      ok: marker.ok && /Result:\s+12\/12 scenarios passed\./.test(resultLine),
      detail: JSON.stringify({ resultLine, missingMarkers: marker.missing })
    };
  });
  if (case1) pass += 1;

  const case2 = runCase('web-path regression key scenarios', () => {
    const r = run('node', ['scripts/run_path_regression_suite.mjs'], repoRoot);
    if (!r.ok) {
      return {
        ok: false,
        detail: JSON.stringify({ code: r.code, tail: r.stdout.split('\n').slice(-20).join('\n') })
      };
    }
    const marker = mustContain(r.stdout, [
      'PASS | user message.part.updated persists web user event |',
      'PASS | initial user message.updated carryover is replaced |',
      'PASS | weak follow-up remaining-variant auto-triggers recall path |',
      'PASS | weak follow-up corresponding-variant auto-triggers recall path |',
      'PASS | attach reused weak-followup prompt keeps latest user text |'
    ]);
    const resultLine = r.stdout.split('\n').find((line) => /^Result: \d+\/\d+ scenarios passed\./.test(line)) || '';
    return {
      ok: marker.ok && isAllPassedResultLine(resultLine),
      detail: JSON.stringify({ resultLine, missingMarkers: marker.missing })
    };
  });
  if (case2) pass += 1;

  const case3 = runCase('notice/archive closure no regression', () => {
    const r = run('node', ['scripts/notice_archive_closure_suite.mjs'], repoRoot);
    if (!r.ok) {
      return {
        ok: false,
        detail: JSON.stringify({ code: r.code, tail: r.stdout.split('\n').slice(-20).join('\n') })
      };
    }
    const marker = mustContain(r.stdout, [
      'PASS | notice transport consistency |',
      'PASS | archive path and filter evidence |',
      'Result: 2/2 scenarios passed.'
    ]);
    return {
      ok: marker.ok,
      detail: JSON.stringify({ missingMarkers: marker.missing })
    };
  });
  if (case3) pass += 1;

  log(`Result: ${pass}/${total} scenarios passed.`);
  process.exit(pass === total ? 0 : 1);
}

main();
