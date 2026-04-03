#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const tmpRoot = path.join(os.tmpdir(), `memory-subcommand-matrix-${Date.now()}`);
fs.mkdirSync(tmpRoot, { recursive: true });

function log(line) {
  process.stdout.write(`${line}\n`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function makeDefineToolStub() {
  return `
const __schemaChain = () => {
  const node = {};
  node.optional = () => node;
  node.describe = () => node;
  return node;
};
const defineTool = (spec) => spec;
defineTool.schema = {
  string: __schemaChain,
  number: __schemaChain,
  boolean: __schemaChain,
  object: __schemaChain,
  array: __schemaChain
};
`;
}

async function loadPluginWithHome(homeDir) {
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const raw = fs.readFileSync(pluginSrcPath, 'utf8');
  const withToolStub = raw.replace(
    "import { tool as defineTool } from '@opencode-ai/plugin';",
    makeDefineToolStub()
  );
  const withTestExports = withToolStub.replace(
    "  return {\n    name: 'memory-system',",
    `  return {\n    __test: {\n      processUserMessageEvent,\n      setLastObservedUserText: (value = '') => { lastObservedUserText = String(value || ''); },\n      setLastObservedUserAt: (value = 0) => { lastObservedUserAt = Number(value || 0); }\n    },\n    name: 'memory-system',`
  );
  const patchedPath = path.join(tmpRoot, `memory-subcommand.${Date.now()}.mjs`);
  fs.writeFileSync(patchedPath, withTestExports, 'utf8');
  const mod = await import(`${pathToFileURL(patchedPath).href}?t=${Date.now()}`);
  process.env.HOME = previousHome;
  return mod;
}

function makeClient(overrides = {}) {
  const sessionOverrides = overrides?.session || {};
  return {
    ...overrides,
    session: {
      async prompt() { return null; },
      async update() { return null; },
      ...sessionOverrides
    }
  };
}

function prepareHome(homeDir) {
  writeJson(path.join(homeDir, '.config', 'opencode', 'opencode.json'), {
    provider: {
      testProvider: {
        npm: '@opencode-ai/provider-openai-compatible',
        options: {
          baseURL: 'https://example.invalid/v1',
          apiKey: 'sk-test'
        },
        models: {
          'test-model': { name: 'test-model' }
        }
      }
    }
  });
  writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
    memorySystem: {},
    trashRetentionDays: 30
  });
  writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
    preferences: {
      language: '中文',
      note: '/tmp/matrix-anchor'
    },
    snippets: {},
    feedback: []
  });
}

function sessionPath(homeDir, sessionID, projectName = path.basename(process.cwd())) {
  return path.join(
    homeDir,
    '.opencode',
    'memory',
    'projects',
    projectName,
    'sessions',
    `${encodeURIComponent(sessionID)}.json`
  );
}

function createSessionFile(homeDir, sessionID, projectName = path.basename(process.cwd())) {
  writeJson(sessionPath(homeDir, sessionID, projectName), {
    sessionID,
    projectName,
    sessionTitle: `matrix-${sessionID}`,
    recentEvents: [],
    stats: { userMessages: 0, assistantMessages: 0, toolResults: 0, systemEvents: 0 },
    summary: { compressedText: '', compressedEvents: 0 },
    recall: { count: 0, lastAt: null, lastQuery: '' },
    inject: {
      globalPrefsCount: 0,
      currentSummaryCount: 0,
      triggerRecallCount: 0,
      memoryDocsCount: 0,
      lastAt: null,
      lastReason: '',
      lastStatus: '',
      lastDigest: '',
      lastSkippedAt: null,
      lastSkipReason: '',
      lastNoticeAt: null,
      lastNoticeKey: '',
      lastNoticeChannel: '',
      lastNoticeText: ''
    },
    budget: {
      bodyTokenBudget: 50000,
      lastEstimatedBodyTokens: 0,
      lastEstimatedSystemTokens: 0,
      lastEstimatedPluginHintTokens: 0,
      lastEstimatedTotalTokens: 0
    },
    pruneAudit: {
      autoRuns: 0,
      manualRuns: 0,
      discardRemovedTotal: 0,
      extractMovedTotal: 0,
      lastAt: null,
      lastSource: '',
      lastDiscardRemoved: 0,
      lastExtractMoved: 0,
      lastEstimatedBodyTokens: 0
    },
    sendPretrim: {
      autoRuns: 0,
      manualRuns: 0,
      savedTokensTotal: 0,
      lastBeforeTokens: 0,
      lastAfterTokens: 0,
      lastSavedTokens: 0,
      lastAt: null,
      lastReason: '',
      lastStatus: '',
      traces: []
    },
    summaryBlocks: []
  });
}

function baseEvent(messageID) {
  return {
    type: 'message.updated',
    properties: {
      info: {
        messageID,
        role: 'user'
      }
    }
  };
}

async function withPluginHome(name, fn, options = {}) {
  const homeDir = path.join(tmpRoot, name);
  fs.mkdirSync(homeDir, { recursive: true });
  prepareHome(homeDir);
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const mod = await loadPluginWithHome(homeDir);
    const plugin = mod.MemorySystemPlugin({ client: makeClient(options.client || {}) });
    return await fn({ homeDir, plugin });
  } finally {
    process.env.HOME = previousHome;
  }
}

async function activateSession(plugin, homeDir, sid) {
  createSessionFile(homeDir, sid);
  await plugin.__test.processUserMessageEvent(
    sid,
    `matrix-activate-${sid}`,
    baseEvent(`msg-${sid}`)
  );
}

function parseJsonOrNull(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return null;
  }
}

async function testGlobalDirect() {
  return withPluginHome('global_direct', async ({ plugin }) => {
    const result = await plugin.tool.memory.execute({ command: 'global', args: ['preferences.note'] });
    return {
      ok: /Global memory: preferences\.note = \/tmp\/matrix-anchor/.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testGlobalSlash() {
  return withPluginHome('global_slash', async ({ plugin }) => {
    const result = await plugin.tool.memory.execute({ command: '/memory global preferences.note' });
    return {
      ok: /Global memory: preferences\.note = \/tmp\/matrix-anchor/.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testSetDirect() {
  return withPluginHome('set_direct', async ({ plugin, homeDir }) => {
    const result = await plugin.tool.memory.execute({ command: 'set', args: ['preferences.language', 'Chinese'] });
    const globalFile = readJson(path.join(homeDir, '.opencode', 'memory', 'global.json'));
    return {
      ok: /Global setting updated/.test(String(result || ''))
        && String(globalFile?.preferences?.language || '') === 'Chinese',
      detail: JSON.stringify({ result, language: globalFile?.preferences?.language })
    };
  });
}

async function testPreferSlash() {
  return withPluginHome('prefer_slash', async ({ plugin, homeDir }) => {
    const result = await plugin.tool.memory.execute({ command: '/memory prefer nickname 柚子' });
    const globalFile = readJson(path.join(homeDir, '.opencode', 'memory', 'global.json'));
    return {
      ok: /Global preference updated/.test(String(result || ''))
        && String(globalFile?.preferences?.nickname || '') === '柚子',
      detail: JSON.stringify({ result, nickname: globalFile?.preferences?.nickname })
    };
  });
}

async function testStatsProjectDirect() {
  return withPluginHome('stats_project_direct', async ({ plugin }) => {
    const result = await plugin.tool.memory.execute({ command: 'stats' });
    const parsed = parseJsonOrNull(result);
    return {
      ok: Boolean(parsed?.project) && parsed?.sessions !== undefined && parsed?.pretrimConfig,
      detail: String(result || '')
    };
  });
}

async function testStatsSessionSlash() {
  return withPluginHome('stats_session_slash', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-stats';
    createSessionFile(homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: `/memory stats session ${sid}` });
    const parsed = parseJsonOrNull(result);
    return {
      ok: String(parsed?.sessionID || '') === sid && parsed?.budget?.tokenView,
      detail: String(result || '')
    };
  });
}

async function testDoctorSessionDirect() {
  return withPluginHome('doctor_session_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-doctor';
    createSessionFile(homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'doctor', args: ['session', sid] });
    const parsed = parseJsonOrNull(result);
    return {
      ok: String(parsed?.sessionID || '') === sid && parsed?.policy && parsed?.risk,
      detail: String(result || '')
    };
  });
}

async function testContextSessionDirect() {
  return withPluginHome('context_session_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-context';
    createSessionFile(homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'context', args: ['session', sid] });
    const parsed = parseJsonOrNull(result);
    return {
      ok: String(parsed?.sessionID || '') === sid && parsed?.stats && parsed?.inject,
      detail: String(result || '')
    };
  });
}

async function testDiscardSessionDirect() {
  return withPluginHome('discard_session_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-discard';
    await activateSession(plugin, homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'discard', args: ['session', sid] });
    return {
      ok: /^Discard completed for /.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testExtractSessionDirect() {
  return withPluginHome('extract_session_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-extract';
    await activateSession(plugin, homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'extract', args: ['session', sid, '8'] });
    return {
      ok: /^Extract completed for /.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testPruneSessionDirect() {
  return withPluginHome('prune_session_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-prune';
    await activateSession(plugin, homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'prune', args: ['session', sid] });
    return {
      ok: /^Prune completed for /.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testDistillDirect() {
  return withPluginHome('distill_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-distill';
    await activateSession(plugin, homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'distill', args: ['1:保留关键决策和路径锚点'] });
    return {
      ok: /^Distill completed for /.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testCompressDirect() {
  return withPluginHome('compress_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-compress';
    await activateSession(plugin, homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'compress', args: ['topicA', 'summaryA'] });
    return {
      ok: /^Compress completed for /.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testRecallSlash() {
  return withPluginHome('recall_slash', async ({ plugin }) => {
    const result = await plugin.tool.memory.execute({ command: '/memory recall 不存在的代号查询' });
    return {
      ok: /No relevant memory found for query:/.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testClearSessionSlash() {
  return withPluginHome('clear_session_slash', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-clear-session';
    createSessionFile(homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: `/memory clear session ${sid}` });
    const exists = fs.existsSync(sessionPath(homeDir, sid));
    return {
      ok: /^Session memory cleared: /.test(String(result || '')) && !exists,
      detail: JSON.stringify({ result, exists })
    };
  });
}

async function testClearSessionsDirect() {
  return withPluginHome('clear_sessions_direct', async ({ plugin, homeDir }) => {
    const sid1 = 'sid-matrix-batch-1';
    const sid2 = 'sid-matrix-batch-2';
    createSessionFile(homeDir, sid1);
    createSessionFile(homeDir, sid2);
    const result = await plugin.tool.memory.execute({ command: 'clear', args: ['sessions', `${sid1},${sid2}`] });
    const exists1 = fs.existsSync(sessionPath(homeDir, sid1));
    const exists2 = fs.existsSync(sessionPath(homeDir, sid2));
    return {
      ok: /^Batch clear completed:/.test(String(result || '')) && !exists1 && !exists2,
      detail: JSON.stringify({ result, exists1, exists2 })
    };
  });
}

async function testClearProjectDirect() {
  return withPluginHome('clear_project_direct', async ({ plugin, homeDir }) => {
    const sid = 'sid-matrix-clear-project';
    createSessionFile(homeDir, sid);
    const result = await plugin.tool.memory.execute({ command: 'clear', args: ['project'] });
    const exists = fs.existsSync(sessionPath(homeDir, sid));
    return {
      ok: /Project memory for/.test(String(result || '')) && !exists,
      detail: JSON.stringify({ result, exists })
    };
  });
}

async function testClearAllDirect() {
  return withPluginHome('clear_all_direct', async ({ plugin, homeDir }) => {
    const result = await plugin.tool.memory.execute({ command: 'clear', args: ['all'] });
    const globalFile = readJson(path.join(homeDir, '.opencode', 'memory', 'global.json'));
    return {
      ok: /^All memory \(project and global\) cleared\./.test(String(result || ''))
        && JSON.stringify(globalFile || {}) === JSON.stringify({ preferences: {}, snippets: {} }),
      detail: JSON.stringify({ result, globalFile })
    };
  });
}

async function testDashboardBuildDirect() {
  return withPluginHome('dashboard_build_direct', async ({ plugin }) => {
    const result = await plugin.tool.memory.execute({ command: 'dashboard', args: ['build'] });
    return {
      ok: /^Dashboard rebuilt at: /.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testCommandMatrixHelpTemplatePresence() {
  return withPluginHome('command_matrix_help_template', async ({ plugin }) => {
    const desc = String(plugin?.tool?.memory?.description || '');
    const ok = /Manage OpenCode memory system/.test(desc)
      && /Empty input is no-op/.test(desc)
      && /For recall, use/.test(desc);
    return {
      ok,
      detail: desc
    };
  });
}

const tests = [
  ['global direct', testGlobalDirect],
  ['global slash', testGlobalSlash],
  ['set direct', testSetDirect],
  ['prefer slash', testPreferSlash],
  ['stats project direct', testStatsProjectDirect],
  ['stats session slash', testStatsSessionSlash],
  ['doctor session direct', testDoctorSessionDirect],
  ['context session direct', testContextSessionDirect],
  ['discard session direct', testDiscardSessionDirect],
  ['extract session direct', testExtractSessionDirect],
  ['prune session direct', testPruneSessionDirect],
  ['distill direct', testDistillDirect],
  ['compress direct', testCompressDirect],
  ['recall slash', testRecallSlash],
  ['clear session slash', testClearSessionSlash],
  ['clear sessions direct', testClearSessionsDirect],
  ['clear project direct', testClearProjectDirect],
  ['clear all direct', testClearAllDirect],
  ['dashboard build direct', testDashboardBuildDirect],
  ['command matrix help template presence', testCommandMatrixHelpTemplatePresence]
];

async function main() {
  log(`Using temp root: ${tmpRoot}`);
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      const { ok, detail } = await fn();
      if (ok) {
        passed += 1;
        log(`PASS | ${name} | ${detail}`);
      } else {
        log(`FAIL | ${name} | ${detail}`);
      }
    } catch (error) {
      log(`ERROR | ${name} | ${error?.stack || error?.message || String(error)}`);
    }
  }
  const total = tests.length;
  log(`\nResult: ${passed}/${total} scenarios passed.`);
  process.exit(passed === total ? 0 : 1);
}

main();
