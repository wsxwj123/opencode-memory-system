#!/usr/bin/env node
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function log(line) {
  process.stdout.write(`${line}\n`);
}

function runNodeScript(relativePath) {
  const target = path.join(scriptDir, relativePath);
  const run = spawnSync('node', [target], { encoding: 'utf8', cwd: repoRoot });
  const output = `${run.stdout || ''}${run.stderr || ''}`.trim();
  return {
    ok: run.status === 0,
    code: run.status,
    output
  };
}

const suites = [
  {
    name: 'compat_queue_skills_matrix',
    path: 'compatibility_queue_skills_suite.mjs'
  },
  {
    name: 'notice_archive_closure',
    path: 'notice_archive_closure_suite.mjs'
  },
  {
    name: 'memory_subcommand_matrix',
    path: 'memory_subcommand_matrix_suite.mjs'
  },
  {
    name: 'mcp_skill_notice_switch',
    path: 'mcp_skill_notice_switch_suite.mjs'
  },
  {
    name: 'web_frontend_main_chain',
    path: 'web_frontend_main_chain_suite.mjs'
  }
];

async function main() {
  let passed = 0;
  log(`Running ${suites.length} extended audit suites...`);
  for (const suite of suites) {
    const result = runNodeScript(suite.path);
    if (result.ok) {
      passed += 1;
      const tail = result.output.split('\n').slice(-1)[0] || '';
      log(`PASS | ${suite.name} | ${tail}`);
    } else {
      log(`FAIL | ${suite.name} | exit=${String(result.code)}\n${result.output}`);
    }
  }
  log(`\nResult: ${passed}/${suites.length} suites passed.`);
  process.exit(passed === suites.length ? 0 : 1);
}

main().catch((error) => {
  log(`ERROR | extended_audit_supplement_suite | ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
