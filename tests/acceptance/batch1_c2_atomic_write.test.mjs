#!/usr/bin/env node
// Batch1 / C2 — atomic write + corruption preservation.
//
// Contract: .devflow/INTERFACE-batch1.md, section "C2 — 原子写与损坏保留".
//   C2.1  corrupt session JSON must NOT vanish: it is renamed to
//         `<name>.corrupt-<ts>` (byte-identical to the corrupt input) and the
//         read op (memory stats) still returns valid JSON; the `.corrupt-*`
//         file is NOT re-processed as a session (no double rename).
//   C2.2  corrupt global.json is preserved via `.corrupt-*`; read degrades
//         (does not crash).
//   C2.5  corrupt config.json is preserved via `config.json.corrupt-<ts>`;
//         read degrades to {}, op does not crash.
//   C2.3  a single JSON write-replace is atomic: a concurrent reader never
//         observes an unparseable half-written file.
//   C2.4  (guard) write to an unwritable file is swallowed (console.warn) and
//         the tool flow keeps returning a normal result.
//
// EXPECTED PRE-FIX FAILURE (unfixed code):
//   readJson() (plugins/memory-system.js:874-882) returns `{}` on parse failure
//   and does NOT rename/preserve the corrupt file. So C2.1/C2.2/C2.5 fail at the
//   "`.corrupt-*` file exists with original bytes" assertion. writeJson()
//   (925-931) uses fs.writeFileSync directly (no tmp+rename) so C2.3's large
//   concurrent writes can be observed half-written -> parse failures > 0.
//   C2.4 already holds on unfixed code (documented guard).

import fs from 'fs';
import { spawn } from 'child_process';
import {
  withPluginHome, sessionsDir, sessionPath, writeJson, writeRaw,
  runCases, projectName, tmpRoot
} from './_harness.mjs';
import path from 'path';

const CORRUPT_BYTES = '{"sessionID":"bad","summary":{"compressedText":"IRREPLACEABLE_USER_DATA_桃子",';

function listCorrupt(dir, base) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
}

// C2.1 — corrupt session file preserved + stats non-fatal + no re-processing.
async function testCorruptSessionPreserved() {
  return withPluginHome('c2_corrupt_session', async ({ homeDir, plugin }) => {
    const dir = sessionsDir(homeDir);
    // A healthy session so the project is non-empty.
    writeJson(sessionPath(homeDir, 'sid-good'), {
      sessionID: 'sid-good', sessionTitle: 'good', project: projectName,
      sessionCwd: process.cwd(), updatedAt: new Date().toISOString(),
      recentEvents: [{ ts: new Date().toISOString(), kind: 'user-message', summary: 'hi' }],
      summary: { compressedText: 'ok', compressedEvents: 0, lastCompressedAt: new Date().toISOString() },
      summaryBlocks: []
    });
    const badName = 'corrupt-session.json';
    fs.mkdirSync(dir, { recursive: true });
    writeRaw(path.join(dir, badName), CORRUPT_BYTES);

    const out1 = await plugin.tool.memory.execute({ command: 'stats', args: [] });
    const statsOk = typeof out1 === 'string' && out1.includes('"project"') && out1.includes('"sessions"');

    const corruptFiles = listCorrupt(dir, badName);
    const preserved = corruptFiles.length === 1
      && fs.readFileSync(path.join(dir, corruptFiles[0]), 'utf8') === CORRUPT_BYTES;

    // Second read must not re-rename the `.corrupt-*` file (readdir(.json) skips it).
    await plugin.tool.memory.execute({ command: 'stats', args: [] });
    const noDoubleRename = listCorrupt(dir, badName).length === 1;

    const ok = statsOk && preserved && noDoubleRename;
    return {
      ok,
      detail: `statsOk=${statsOk} corruptCopies=${corruptFiles.length} bytesPreserved=${preserved} noDoubleRename=${noDoubleRename}`
    };
  });
}

// C2.2 — corrupt global.json preserved, read degrades non-fatally.
async function testCorruptGlobalPreserved() {
  return withPluginHome('c2_corrupt_global', async ({ homeDir, plugin }) => {
    const gpath = path.join(homeDir, '.opencode', 'memory', 'global.json');
    const original = '{"preferences":{"language":"中文","nickname":"HISTORICAL_PREF_柚子",';
    writeRaw(gpath, original);

    let readOut = '';
    let crashed = false;
    try {
      readOut = String(await plugin.tool.memory.execute({ command: 'global', args: ['preferences.language'] }) || '');
    } catch (err) {
      crashed = true;
      readOut = String(err?.message || err);
    }

    const dir = path.dirname(gpath);
    const corruptFiles = listCorrupt(dir, 'global.json');
    const preserved = corruptFiles.length >= 1
      && fs.readFileSync(path.join(dir, corruptFiles[0]), 'utf8') === original;

    const ok = !crashed && preserved;
    return { ok, detail: `crashed=${crashed} corruptCopies=${corruptFiles.length} bytesPreserved=${preserved} read="${readOut.slice(0, 60)}"` };
  });
}

// C2.5 — corrupt config.json preserved as config.json.corrupt-*, read degrades.
async function testCorruptConfigPreserved() {
  return withPluginHome('c2_corrupt_config', async ({ homeDir, plugin }) => {
    const cpath = path.join(homeDir, '.opencode', 'memory', 'config.json');
    const original = '{"memorySystem":{"visibleNoticeCooldownMs":60000,"HISTORICAL_SETTING":123';
    writeRaw(cpath, original);

    let crashed = false;
    let out = '';
    try {
      out = String(await plugin.tool.memory.execute({ command: 'stats', args: [] }) || '');
    } catch (err) {
      crashed = true;
      out = String(err?.message || err);
    }
    const statsOk = !crashed && out.includes('"project"');

    const dir = path.dirname(cpath);
    const corruptFiles = listCorrupt(dir, 'config.json');
    const preserved = corruptFiles.length >= 1
      && fs.readFileSync(path.join(dir, corruptFiles[0]), 'utf8') === original;

    const ok = statsOk && preserved;
    return { ok, detail: `statsOk=${statsOk} corruptCopies=${corruptFiles.length} bytesPreserved=${preserved}` };
  });
}

// C2.3 — single write-replace is atomic; a CONCURRENT (separate-process) reader
// never observes an unparseable half-written file.
//
// A same-process reader can never catch a half write (synchronous writeFileSync
// blocks the event loop), so the reader must be its own OS process — this also
// matches reality: the dashboard process reads session files while the plugin
// writes them. With a non-atomic writeFileSync, the reader can open the file
// between O_TRUNC and the final byte and see a truncated document.
const READER_SRC = `
const fs = require('fs');
const target = process.argv[2];
const stop = process.argv[3];
let reads = 0, failures = 0;
while (!fs.existsSync(stop)) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const txt = fs.readFileSync(target, 'utf8');
      reads += 1;
      const obj = JSON.parse(txt);
      if (obj.v !== 1 && obj.v !== 2) failures += 1;
    } catch (_) { failures += 1; }
  }
}
process.stdout.write(JSON.stringify({ reads, failures }));
`;

async function testSingleWriteIsAtomic() {
  return withPluginHome('c2_atomic_single_write', async ({ homeDir, plugin }) => {
    const target = path.join(homeDir, '.opencode', 'memory', 'atomic-probe.json');
    const stopFile = path.join(homeDir, '.opencode', 'memory', 'atomic-probe.stop');
    const readerPath = path.join(tmpRoot, `atomic-reader.${Date.now()}.cjs`);
    fs.writeFileSync(readerPath, READER_SRC, 'utf8');

    // ~2MB payloads: writeFileSync spans several write() syscalls, exposing a
    // truncation window to the concurrent reader if the write is not atomic.
    const bigA = { v: 1, blob: 'A'.repeat(2 * 1024 * 1024) };
    const bigB = { v: 2, blob: 'B'.repeat(2 * 1024 * 1024) };
    plugin.__test.writeJson(target, bigA);

    const reader = spawn(process.execPath, [readerPath, target, stopFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    let readerOut = '';
    reader.stdout.on('data', (c) => { readerOut += c; });
    const readerDone = new Promise((resolve) => reader.on('close', resolve));

    // Give the reader a head start, then hammer the file with alternating writes.
    await new Promise((r) => setTimeout(r, 120));
    for (let i = 0; i < 1200; i += 1) {
      plugin.__test.writeJson(target, i % 2 === 0 ? bigA : bigB);
    }
    fs.writeFileSync(stopFile, '1', 'utf8');
    await readerDone;

    let parsed = { reads: 0, failures: -1 };
    try { parsed = JSON.parse(readerOut || '{}'); } catch (_) {}
    const ok = parsed.failures === 0;
    return { ok, detail: `crossProcessReads=${parsed.reads} parseFailures=${parsed.failures} (expect 0 for atomic write)` };
  });
}

// C2.4 — (guard) write failure to a read-only file is non-fatal.
async function testWriteFailureNonFatal() {
  return withPluginHome('c2_write_failure_nonfatal', async ({ homeDir, plugin }) => {
    const gpath = path.join(homeDir, '.opencode', 'memory', 'global.json');
    fs.chmodSync(gpath, 0o400);
    let ok = false;
    let detail = '';
    try {
      const out = await plugin.tool.memory.execute({ command: 'set', args: ['preferences.nickname', '柚子'] });
      ok = typeof out === 'string' && out.length > 0;
      detail = `returned string non-fatally: "${String(out).slice(0, 60)}"`;
    } catch (err) {
      ok = false;
      detail = `threw to top level: ${err?.message || err}`;
    } finally {
      fs.chmodSync(gpath, 0o644);
    }
    return { ok, detail };
  });
}

runCases([
  ['C2.1 corrupt session file preserved + stats non-fatal + no re-processing', testCorruptSessionPreserved],
  ['C2.2 corrupt global.json preserved, read degrades non-fatally', testCorruptGlobalPreserved],
  ['C2.5 corrupt config.json preserved as .corrupt-*, read degrades', testCorruptConfigPreserved],
  ['C2.3 single JSON write-replace is atomic (reader never sees half file)', testSingleWriteIsAtomic],
  ['C2.4 (guard) write failure does not crash tool flow', testWriteFailureNonFatal]
]);
