#!/usr/bin/env node
// Batch1 / B3 — summary backup & anti-pollution.
//
// Contract: .devflow/INTERFACE-batch1.md, section "B3 — 摘要备份与防污染".
//   B3.1  Before EVERY automatic replacement of compressedText, the value being
//         evicted is written to summaryBlocks as a `source === 'auto-snapshot'`
//         block. Single round: OLD recallable. Multi-round over-budget compact:
//         OLD + intermediate chunks recallable (bounded by AUTO_SUMMARY_BLOCK_MAX).
//         Boundary: empty prior compressedText -> no auto-snapshot block.
//   B3.2  discard of low-signal tool events must NOT pollute compressedText:
//         `[discarded-low-signal]` never becomes compressedText; the removal
//         still happens.
//   B3.3  injection picks the freshest summary (current compressedText), never
//         regresses to an older backup block. (guard — freshness guard already
//         present; must remain true after the B3.1 fix.)
//
// EXPECTED PRE-FIX FAILURE (unfixed code):
//   appendCompressedSummaryChunk() (plugins/memory-system.js:5768-5780) REPLACES
//   summary.compressedText with a fresh chunk and never snapshots the old value.
//   -> B3.1: no `auto-snapshot` block is ever produced; the OLD marker is
//      unrecoverable -> assertion "OLD recallable via an auto-snapshot block" fails.
//   discardLowValueToolEvents() (5854-5896) feeds `[discarded-low-signal] ...`
//   summaries through the same replace primitive -> B3.2: compressedText becomes
//   "[discarded-low-signal] ..." -> assertion fails.
//   B3.3 already holds pre-fix (documented guard).

import fs from 'fs';
import {
  withPluginHome, sessionPath, writeJson, runCases, projectName
} from './_harness.mjs';

const OLD_MARKER = 'OLD_CT_MARKER_ZZZ_不可丢失';
const REAL_MARKER = 'REAL_SUMMARY_MARKER_真实摘要';

function baseSession(sessionID, overrides = {}) {
  return {
    sessionID,
    sessionTitle: sessionID,
    project: projectName,
    sessionCwd: process.cwd(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 0 },
    recentEvents: [],
    summary: { compressedText: '', compressedEvents: 0, lastCompressedAt: new Date().toISOString() },
    summaryBlocks: [],
    recall: { count: 0, lastAt: null },
    inject: {},
    budget: { bodyTokenBudget: 50000, lastEstimatedBodyTokens: 0, lastCompactedAt: null, lastCompactionReason: '' },
    pruneAudit: { autoRuns: 0, manualRuns: 0, discardRemovedTotal: 0, extractMovedTotal: 0 },
    sendPretrim: { autoRuns: 0, manualRuns: 0, savedTokensTotal: 0, traces: [] },
    alerts: {},
    ...overrides
  };
}

function convoEvents(count, sizeChars) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      ts: new Date(Date.now() + i).toISOString(),
      kind: i % 2 === 0 ? 'assistant-message' : 'user-message',
      summary: `step ${i} 决定 decided to edit path /Users/test/proj/file${i}.js result done ${'填充x'.repeat(Math.ceil(sizeChars / 3))}`
    });
  }
  return out;
}

function autoSnapshotBlocks(sessionData) {
  const arr = Array.isArray(sessionData.summaryBlocks) ? sessionData.summaryBlocks : [];
  return arr.filter((b) => String(b?.source || '') === 'auto-snapshot');
}

// B3.1 single-round: OLD evicted from compressedText lands in an auto-snapshot block.
async function testSingleRoundSnapshot() {
  return withPluginHome('b3_single_round', async ({ homeDir, plugin }) => {
    const sid = 'sid-b3-single';
    const sess = plugin.__test.loadSessionMemory(sid) || baseSession(sid);
    Object.assign(sess, baseSession(sid));
    sess.summary.compressedText = `${OLD_MARKER} 上一轮压缩产物`;
    sess.summary.lastCompressedAt = new Date(Date.now() - 60000).toISOString();
    // One explicit replacement through the shared primitive.
    plugin.__test.appendCompressedSummaryChunk(sess, convoEvents(6, 200));
    plugin.__test.ensureSummaryBlocks(sess);

    const snaps = autoSnapshotBlocks(sess);
    const oldRecallable = snaps.some((b) => String(b.summary || '').includes(OLD_MARKER));
    const ctReplaced = !String(sess.summary.compressedText || '').includes(OLD_MARKER);

    const ok = oldRecallable && ctReplaced;
    return { ok, detail: `autoSnapshotBlocks=${snaps.length} oldRecallable=${oldRecallable} ctReplaced=${ctReplaced}` };
  });
}

// B3.1 multi-round over-budget compact: OLD + intermediate batches recallable,
// observable in the persisted session JSON file.
async function testMultiRoundSnapshotPersisted() {
  return withPluginHome('b3_multi_round', async ({ homeDir, plugin }) => {
    const sid = 'sid-b3-multi';
    const sess = baseSession(sid, { recentEvents: convoEvents(46, 6000) });
    sess.summary.compressedText = `${OLD_MARKER} 上一轮压缩产物`;
    sess.summary.lastCompressedAt = new Date(Date.now() - 60000).toISOString();

    const before = sess.recentEvents.length;
    const result = plugin.__test.compactConversationByBudget(sess) || {};
    plugin.__test.persistSessionMemory(sess, projectName);

    // Re-read the on-disk session JSON — the contract observable.
    const onDisk = JSON.parse(fs.readFileSync(sessionPath(homeDir, sid), 'utf8'));
    const snaps = (onDisk.summaryBlocks || []).filter((b) => String(b?.source || '') === 'auto-snapshot');
    const oldRecallable = snaps.some((b) => String(b.summary || '').includes(OLD_MARKER));
    const multipleRounds = Number(result.extracted || 0) >= 12; // >=2 batches
    const intermediateKept = snaps.length >= 2; // OLD + >=1 intermediate chunk
    const ctFresh = !String(onDisk?.summary?.compressedText || '').includes(OLD_MARKER);
    const shrank = (onDisk.recentEvents || []).length < before;

    const ok = oldRecallable && multipleRounds && intermediateKept && ctFresh && shrank;
    return {
      ok,
      detail: `rounds/extracted=${result.extracted} autoSnapshots=${snaps.length} oldRecallable=${oldRecallable} intermediateKept=${intermediateKept} ctFresh=${ctFresh}`
    };
  });
}

// B3.1 boundary: empty prior compressedText must not create an auto-snapshot block.
async function testEmptyCtNoSnapshot() {
  return withPluginHome('b3_empty_boundary', async ({ plugin }) => {
    const sid = 'sid-b3-empty';
    const sess = baseSession(sid);
    sess.summary.compressedText = ''; // first compression, no old value
    plugin.__test.appendCompressedSummaryChunk(sess, convoEvents(6, 200));
    plugin.__test.ensureSummaryBlocks(sess);
    const snaps = autoSnapshotBlocks(sess);
    const ok = snaps.length === 0;
    return { ok, detail: `autoSnapshotBlocks=${snaps.length} (expect 0; empty value is not backed up)` };
  });
}

// B3.2 discard must not pollute compressedText.
async function testDiscardDoesNotPollute() {
  return withPluginHome('b3_discard_no_pollute', async ({ homeDir, plugin }) => {
    const sid = 'sid-b3-discard';
    const tools = [];
    for (let i = 0; i < 16; i += 1) {
      tools.push({
        ts: new Date(Date.now() + i).toISOString(),
        kind: 'tool-result',
        tool: 'someTool',
        summary: `[someTool] input={} output={"status":"pending"}`
      });
    }
    const sess = baseSession(sid, { recentEvents: tools });
    sess.summary.compressedText = REAL_MARKER;
    sess.summary.lastCompressedAt = new Date().toISOString();

    const res = plugin.__test.discardLowValueToolEvents(sess) || {};
    plugin.__test.persistSessionMemory(sess, projectName);
    const onDisk = JSON.parse(fs.readFileSync(sessionPath(homeDir, sid), 'utf8'));
    const ct = String(onDisk?.summary?.compressedText || '');

    const notPolluted = !ct.includes('[discarded-low-signal]');
    const ctPreserved = ct.includes(REAL_MARKER); // no compact/extract this turn -> stays REAL
    const removalHappened = Number(res.removed || 0) > 0
      && (onDisk.recentEvents || []).length < tools.length;

    // Injection/recall must not surface discard text.
    const injected = String(plugin.__test.buildCurrentSessionSummaryText(sid) || '');
    const injectionClean = !injected.includes('[discarded-low-signal]');

    const ok = notPolluted && ctPreserved && removalHappened && injectionClean;
    return {
      ok,
      detail: `removed=${res.removed} notPolluted=${notPolluted} ctPreserved=${ctPreserved} injectionClean=${injectionClean} ct="${ct.slice(0, 50)}"`
    };
  });
}

// B3.3 (guard) injection uses freshest summary, does not regress to old backup block.
async function testInjectionPicksFreshest() {
  return withPluginHome('b3_freshness', async ({ homeDir, plugin }) => {
    const sid = 'sid-b3-fresh';
    const oldAt = new Date(Date.now() - 120000).toISOString();
    const freshAt = new Date().toISOString();
    const sess = baseSession(sid, {
      recentEvents: convoEvents(4, 100),
      summary: { compressedText: `${REAL_MARKER} 当前最新`, compressedEvents: 1, lastCompressedAt: freshAt },
      summaryBlocks: [
        { blockId: 1, createdAt: oldAt, source: 'auto-snapshot', startMessageID: '', endMessageID: '', anchorMessageID: '', consumedMessages: 3, summary: `${OLD_MARKER} 旧备份块` }
      ]
    });
    writeJson(sessionPath(homeDir, sid), sess);

    const injected = String(plugin.__test.buildCurrentSessionSummaryText(sid) || '');
    const usesFresh = injected.includes(REAL_MARKER);
    const noRegress = !injected.includes(OLD_MARKER);
    const ok = usesFresh && noRegress;
    return { ok, detail: `usesFresh=${usesFresh} noRegressToOldBackup=${noRegress}` };
  });
}

runCases([
  ['B3.1 single round: evicted compressedText -> auto-snapshot block', testSingleRoundSnapshot],
  ['B3.1 multi-round over-budget compact: OLD + intermediate recallable (on-disk)', testMultiRoundSnapshotPersisted],
  ['B3.1 boundary: empty compressedText produces no auto-snapshot block', testEmptyCtNoSnapshot],
  ['B3.2 discard does not pollute compressedText / recall', testDiscardDoesNotPollute],
  ['B3.3 (guard) injection picks freshest summary, no regress to old backup', testInjectionPicksFreshest]
]);
