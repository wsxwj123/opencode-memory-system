#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const tmpRoot = path.join(os.tmpdir(), `mcp-skill-notice-suite-${Date.now()}`);
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
    `  return {\n    __test: {\n      emitVisibleNotice,\n      processUserMessageEvent,\n      setLastObservedUserText: (value = '') => { lastObservedUserText = String(value || ''); },\n      setLastObservedUserAt: (value = 0) => { lastObservedUserAt = Number(value || 0); }\n    },\n    name: 'memory-system',`
  );
  const patchedPath = path.join(tmpRoot, `mcp-skill-notice.${Date.now()}.mjs`);
  fs.writeFileSync(patchedPath, withTestExports, 'utf8');
  const mod = await import(`${pathToFileURL(patchedPath).href}?t=${Date.now()}`);
  process.env.HOME = previousHome;
  return mod;
}

function prepareHome(homeDir, memorySystem = {}) {
  writeJson(path.join(homeDir, '.config', 'opencode', 'opencode.json'), {
    provider: {
      testProvider: {
        npm: '@opencode-ai/provider-openai-compatible',
        options: { baseURL: 'https://example.invalid/v1', apiKey: 'sk-test' },
        models: { 'test-model': { name: 'test-model' } }
      }
    }
  });
  writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
    memorySystem,
    trashRetentionDays: 30
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

function createSessionFile(homeDir, sessionID, recentEvents = []) {
  writeJson(sessionPath(homeDir, sessionID), {
    sessionID,
    projectName: path.basename(process.cwd()),
    sessionTitle: `suite-${sessionID}`,
    recentEvents,
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

function makeClient(recorder) {
  return {
    session: {
      async prompt(payload) {
        recorder.promptCalls.push(payload);
        return { info: { id: `msg-${Date.now()}` } };
      },
      async update(...args) {
        recorder.updateCalls.push(args);
        return null;
      }
    }
  };
}

function baseUserUpdated(messageID = 'msg-1') {
  return {
    type: 'message.updated',
    properties: { info: { messageID, role: 'user' } }
  };
}

async function withPluginHome(name, fn, { memorySystem = {}, recorder = null } = {}) {
  const homeDir = path.join(tmpRoot, name);
  fs.mkdirSync(homeDir, { recursive: true });
  prepareHome(homeDir, memorySystem);
  const rec = recorder || { promptCalls: [], updateCalls: [] };
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const mod = await loadPluginWithHome(homeDir);
    const plugin = mod.MemorySystemPlugin({ client: makeClient(rec) });
    return await fn({ homeDir, plugin, recorder: rec });
  } finally {
    process.env.HOME = previousHome;
  }
}

async function testMcpDefinitionNoiseDoesNotPersist() {
  return withPluginHome('mcp_noise_not_persist', async ({ homeDir, plugin }) => {
    const sid = 'sid-mcp-noise';
    createSessionFile(homeDir, sid);
    const mcpNoise = `## Namespace: functions\n### Tool definitions\ntype mcp__fetch__fetch = (_: { url: string }) => any;`;
    await plugin.__test.processUserMessageEvent(sid, mcpNoise, baseUserUpdated('msg-mcp'));
    await plugin.__test.processUserMessageEvent(sid, '我已经知道 DELTA-99111，另一个代号是什么？', baseUserUpdated('msg-real'));
    const session = readJson(sessionPath(homeDir, sid));
    const userEvents = (session?.recentEvents || []).filter((e) => e.kind === 'user-message');
    const hasMcpNoise = userEvents.some((e) => String(e.summary || '').includes('Namespace: functions') || String(e.summary || '').includes('type mcp__'));
    const hasReal = userEvents.some((e) => String(e.summary || '').includes('DELTA-99111'));
    return {
      ok: !hasMcpNoise && hasReal && userEvents.length === 1,
      detail: JSON.stringify({ userEvents })
    };
  });
}

async function testSkillBoilerplateNoiseDoesNotPersist() {
  return withPluginHome('skill_noise_not_persist', async ({ homeDir, plugin }) => {
    const sid = 'sid-skill-noise';
    createSessionFile(homeDir, sid);
    const noise = '# find-skills # Helps users discover and install agent skills when they ask questions like "how do I do X"';
    await plugin.__test.processUserMessageEvent(sid, noise, baseUserUpdated('msg-skill-noise'));
    await plugin.__test.processUserMessageEvent(sid, '我知道 DELTA-99222，那另一个呢？', baseUserUpdated('msg-real'));
    const session = readJson(sessionPath(homeDir, sid));
    const userEvents = (session?.recentEvents || []).filter((e) => e.kind === 'user-message');
    const hasNoise = userEvents.some((e) => String(e.summary || '').includes('find-skills'));
    const hasReal = userEvents.some((e) => String(e.summary || '').includes('DELTA-99222'));
    return {
      ok: !hasNoise && hasReal && userEvents.length === 1,
      detail: JSON.stringify({ userEvents })
    };
  });
}

async function testVisibleNoticesGlobalOffSuppressesInjectNotice() {
  return withPluginHome(
    'visible_off_inject',
    async ({ homeDir, plugin, recorder }) => {
      const sid = 'sid-visible-off-inject';
      createSessionFile(homeDir, sid);
      const delivered = await plugin.__test.emitVisibleNotice(sid, '记忆提示：inject-off', 'inject:current-session-refresh');
      const session = readJson(sessionPath(homeDir, sid));
      return {
        ok: delivered === false
          && recorder.promptCalls.length === 0
          && recorder.updateCalls.length === 0
          && String(session?.inject?.lastNoticeChannel || '') === '',
        detail: JSON.stringify({ delivered, promptCalls: recorder.promptCalls.length, updateCalls: recorder.updateCalls.length, channel: session?.inject?.lastNoticeChannel || '' })
      };
    },
    { memorySystem: { visibleNoticesEnabled: false } }
  );
}

function buildDiscardSessionEvents() {
  const events = [];
  for (let i = 0; i < 12; i += 1) {
    events.push({
      ts: new Date(Date.now() - (120000 + i * 2000)).toISOString(),
      kind: 'tool-result',
      tool: 'shell',
      summary: `[shell] input={} output={"status":"pending","step":${i}}`
    });
  }
  events.push({
    ts: new Date().toISOString(),
    kind: 'user-message',
    summary: '这是保留窗口内的用户消息'
  });
  return events;
}

async function testDiscardNoticeSwitchOff() {
  return withPluginHome(
    'discard_notice_off',
    async ({ homeDir, plugin, recorder }) => {
      const sid = 'sid-discard-off';
      createSessionFile(homeDir, sid, buildDiscardSessionEvents());
      const result = await plugin.tool.memory.execute({ command: 'discard', args: ['session', sid, 'aggressive'] });
      const session = readJson(sessionPath(homeDir, sid));
      return {
        ok: /^Discard completed for /.test(String(result || ''))
          && recorder.promptCalls.length === 0
          && recorder.updateCalls.length === 0
          && String(session?.inject?.lastNoticeKey || '') === '',
        detail: JSON.stringify({ result, promptCalls: recorder.promptCalls.length, updateCalls: recorder.updateCalls.length, noticeKey: session?.inject?.lastNoticeKey || '' })
      };
    },
    { memorySystem: { visibleNoticesEnabled: true, visibleNoticeForDiscard: false } }
  );
}

async function testDiscardNoticeSwitchOn() {
  return withPluginHome(
    'discard_notice_on',
    async ({ homeDir, plugin, recorder }) => {
      const sid = 'sid-discard-on';
      createSessionFile(homeDir, sid, buildDiscardSessionEvents());
      const result = await plugin.tool.memory.execute({ command: 'discard', args: ['session', sid, 'aggressive'] });
      const session = readJson(sessionPath(homeDir, sid));
      const channel = String(session?.inject?.lastNoticeChannel || '');
      const key = String(session?.inject?.lastNoticeKey || '');
      return {
        ok: /^Discard completed for /.test(String(result || ''))
          && (recorder.promptCalls.length > 0 || recorder.updateCalls.length > 0 || channel.includes('toast'))
          && key === 'discard:manual',
        detail: JSON.stringify({ result, promptCalls: recorder.promptCalls.length, updateCalls: recorder.updateCalls.length, channel, key })
      };
    },
    { memorySystem: { visibleNoticesEnabled: true, visibleNoticeForDiscard: true } }
  );
}

async function testInjectMirrorSwitchOffNoDeferredPrompt() {
  return withPluginHome(
    'inject_mirror_off',
    async ({ homeDir, plugin, recorder }) => {
      const sid = 'sid-inject-mirror-off';
      createSessionFile(homeDir, sid);
      const prevWeb = process.env.OPENCODE_WEB_UI;
      process.env.OPENCODE_WEB_UI = '1';
      const delivered = await plugin.__test.emitVisibleNotice(sid, '记忆提示：inject-mirror-off', 'inject:current-session-refresh');
      process.env.OPENCODE_WEB_UI = prevWeb;
      const session = readJson(sessionPath(homeDir, sid));
      const channel = String(session?.inject?.lastNoticeChannel || '');
      return {
        ok: delivered === true
          && recorder.promptCalls.length > 0
          && channel !== 'prompt-deferred'
          && channel !== 'toast+prompt-deferred',
        detail: JSON.stringify({ delivered, promptCalls: recorder.promptCalls.length, channel })
      };
    },
    { memorySystem: { visibleNoticesEnabled: true, visibleNoticeCurrentSummaryMirrorEnabled: false } }
  );
}

async function testInjectMirrorSwitchOnUsesDeferredPromptPath() {
  return withPluginHome(
    'inject_mirror_on',
    async ({ homeDir, plugin, recorder }) => {
      const sid = 'sid-inject-mirror-on';
      createSessionFile(homeDir, sid);
      const prevWeb = process.env.OPENCODE_WEB_UI;
      process.env.OPENCODE_WEB_UI = '1';
      const delivered = await plugin.__test.emitVisibleNotice(sid, '记忆提示：inject-mirror-on', 'inject:current-session-refresh');
      process.env.OPENCODE_WEB_UI = prevWeb;
      const session = readJson(sessionPath(homeDir, sid));
      const channel = String(session?.inject?.lastNoticeChannel || '');
      return {
        ok: delivered === true
          && recorder.promptCalls.length === 0
          && channel === 'prompt-deferred',
        detail: JSON.stringify({ delivered, promptCalls: recorder.promptCalls.length, channel })
      };
    },
    { memorySystem: { visibleNoticesEnabled: true, visibleNoticeCurrentSummaryMirrorEnabled: true } }
  );
}

const tests = [
  ['mcp definition noise does not persist', testMcpDefinitionNoiseDoesNotPersist],
  ['skill boilerplate noise does not persist', testSkillBoilerplateNoiseDoesNotPersist],
  ['visible notices global off suppresses inject notice', testVisibleNoticesGlobalOffSuppressesInjectNotice],
  ['discard notice switch off suppresses delivery', testDiscardNoticeSwitchOff],
  ['discard notice switch on delivers notice', testDiscardNoticeSwitchOn],
  ['inject mirror switch off avoids deferred-only path', testInjectMirrorSwitchOffNoDeferredPrompt],
  ['inject mirror switch on uses deferred path', testInjectMirrorSwitchOnUsesDeferredPromptPath]
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
