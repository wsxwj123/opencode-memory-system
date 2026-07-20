#!/usr/bin/env node
// R1 — cross-platform workdir inference: Windows backslash paths must be
// treated the same as equivalent Unix forward-slash paths.
//
// Contract:
//   The plugin infers "where the user is mainly working" from conversation /
//   tool events and writes it into the session summary (recommendedWorkdir /
//   workdirScoring / handoffAnchor). The internal validity gate is isGoodDir()
//   (plugins/memory-system.js ~5606), fed by the dir scorer addDirScore(~5476);
//   both live as closures inside buildCompressedChunk() (~5450).
//   A legitimate deep project directory MUST be accepted as a workdir candidate
//   whether written Unix-style (/Users/me/Desktop/myproj) or Windows-style
//   (C:\Users\me\Desktop\myproj), and must be treated consistently.
//
// How it is observed:
//   buildCompressedChunk() only emits recommendedWorkdir/workdirScoring when a
//   custom summary template with those {{placeholders}} is configured. We set
//   such a template, feed events referencing exactly one candidate directory,
//   and read back the rendered chunk string. workdirs=[] falls back to
//   sessionCwd, so "the candidate path appears in the chunk" == "isGoodDir
//   accepted it".
//
// Cases:
//   R1.1 Windows deep path  C:\Users\me\Desktop\myproj  -> MUST be good  (FAILS pre-fix)
//   R1.2 Unix deep path     /Users/me/Desktop/myproj    -> MUST be good  (regression guard, passes pre-fix)
//   R1.3 shallow path       C:\Temp                     -> MUST be excluded (over-fix guard)
//
// EXPECTED PRE-FIX FAILURE (unfixed code):
//   isGoodDir() computes depth via d.split('/'). A Windows backslash path has no
//   '/', so split length = 1 < 4 and the path is rejected. R1.1 therefore fails
//   at "chunk contains the Windows path" — recommendedWorkdir falls back to the
//   sentinel sessionCwd instead. R1.2 and R1.3 already hold on unfixed code.

import { withPluginHome, writeJson, runCases } from './_harness.mjs';
import path from 'path';

const WIN_DEEP = 'C:\\Users\\me\\Desktop\\myproj';
const UNIX_DEEP = '/Users/me/Desktop/myproj';
const WIN_SHALLOW = 'C:\\Temp';
const SENTINEL_CWD = '/SENTINEL/session/cwd/never/matches/candidate';

// Marker template: values are paths (no spaces), so normalizeText's
// whitespace-collapse leaves the markers intact.
const TEMPLATE = 'RW=[[{{recommendedWorkdir}}]] SCORING=[[{{workdirScoring}}]]';

function configPath(homeDir) {
  return path.join(homeDir, '.opencode', 'memory', 'config.json');
}

// Drive buildCompressedChunk with events that reference exactly one candidate
// directory, at high score, and return the rendered chunk string.
function renderChunkFor(plugin, dirPath) {
  const events = [
    { kind: 'user-message', tool: null, summary: `请在 ${dirPath} 里修复 bug，谢谢` },
    { kind: 'tool-result', tool: 'write', summary: `[write] WROTE ${dirPath} output=ok 已生成` },
    { kind: 'tool-result', tool: 'bash', summary: `[bash] PASS 测试通过 in ${dirPath}` }
  ];
  return plugin.__test.buildCompressedChunk(events, { sessionCwd: SENTINEL_CWD });
}

async function testWindowsDeepIsGood() {
  return withPluginHome('r1_win_deep', async ({ homeDir, plugin }) => {
    writeJson(configPath(homeDir), {
      memorySystem: { summaryTemplateText: TEMPLATE }, trashRetentionDays: 30
    });
    const chunk = renderChunkFor(plugin, WIN_DEEP);
    const ok = typeof chunk === 'string' && chunk.includes(WIN_DEEP);
    return {
      ok,
      detail: ok
        ? `windows deep path accepted as workdir`
        : `windows path rejected; chunk=${JSON.stringify(String(chunk).slice(0, 160))}`
    };
  });
}

async function testUnixDeepIsGood() {
  return withPluginHome('r1_unix_deep', async ({ homeDir, plugin }) => {
    writeJson(configPath(homeDir), {
      memorySystem: { summaryTemplateText: TEMPLATE }, trashRetentionDays: 30
    });
    const chunk = renderChunkFor(plugin, UNIX_DEEP);
    const ok = typeof chunk === 'string' && chunk.includes(UNIX_DEEP);
    return {
      ok,
      detail: ok
        ? `unix deep path accepted (regression guard)`
        : `unix path unexpectedly rejected; chunk=${JSON.stringify(String(chunk).slice(0, 160))}`
    };
  });
}

async function testShallowExcluded() {
  return withPluginHome('r1_shallow', async ({ homeDir, plugin }) => {
    writeJson(configPath(homeDir), {
      memorySystem: { summaryTemplateText: TEMPLATE }, trashRetentionDays: 30
    });
    const chunk = renderChunkFor(plugin, WIN_SHALLOW);
    // Shallow dir must NOT become a workdir; recommendedWorkdir falls back to
    // the sentinel cwd. Guards against a fix that over-includes shallow paths.
    const excluded = typeof chunk === 'string'
      && !chunk.includes(`RW=[[${WIN_SHALLOW}]]`)
      && chunk.includes(SENTINEL_CWD);
    return {
      ok: excluded,
      detail: excluded
        ? `shallow path excluded (over-fix guard)`
        : `shallow path leaked into workdir; chunk=${JSON.stringify(String(chunk).slice(0, 160))}`
    };
  });
}

runCases([
  ['R1.1 windows deep backslash path is a valid workdir', testWindowsDeepIsGood],
  ['R1.2 unix deep path is a valid workdir (regression guard)', testUnixDeepIsGood],
  ['R1.3 shallow path excluded (over-fix guard)', testShallowExcluded]
]);
