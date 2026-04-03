#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const tmpRoot = path.join(os.tmpdir(), `memory-run-path-${Date.now()}`);
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
    `  return {\n    __test: {\n      appendAutoEvent,\n      augmentWeakFollowupRecallText,\n      buildBudgetTokenView,\n      buildDashboardData,\n      buildGlobalPrefsContextText,\n      emitVisibleNotice,\n      extractDistillTextFromResponse,\n      inferGlobalPreferenceWriteFromText,\n      getLatestUserSummaryForSession,\n      getLatestUserTextForSession,\n      inferLatestUserText,\n      inferLatestUserTextFromTransformInput,\n      inferUserTextFromProcessArgv,\n      isVisibleNoticeText,\n      makeVisibleNoticeTextPart,\n      parseProviderProtocol,\n      processUserMessageEvent,\n      recallProjectMemories,\n      sanitizeUserTextForMemoryInference,\n      syncBudgetTokenSnapshot,\n      tokenize,\n      isPathAnchorContent,\n      readProjectPathAnchors,\n      appendProjectPathAnchor,\n      deleteProjectPathAnchor,\n      buildProjectPathAnchorsText,\n      appendValueToGlobalNote,\n      setLastObservedUserText: (value = '') => { lastObservedUserText = String(value || ''); },\n      setLastObservedUserAt: (value = 0) => { lastObservedUserAt = Number(value || 0); },\n      setSessionLatestUserText: (sessionID = '', value = '') => {\n        const sid = normalizeText(String(sessionID || ''));\n        if (!sid) return;\n        sessionLatestUserTextByID.set(sid, String(value || ''));\n      },\n      setSessionObservedUserText: (sessionID = '', value = '', at = Date.now()) => {\n        const sid = normalizeText(String(sessionID || ''));\n        if (!sid) return;\n        sessionObservedUserTextByID.set(sid, String(value || ''));\n        sessionObservedUserAtByID.set(sid, Number(at || Date.now()));\n      }\n    },\n    name: 'memory-system',`
  );
  const patchedPath = path.join(tmpRoot, `memory-system.run-path.${Date.now()}.mjs`);
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
      lastEstimatedTotalTokens: 0,
      lastCompactedAt: null,
      lastCompactionReason: ''
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

function listSessionFiles(homeDir, projectName = path.basename(process.cwd())) {
  const sessionsDir = path.join(
    homeDir,
    '.opencode',
    'memory',
    'projects',
    projectName,
    'sessions'
  );
  if (!fs.existsSync(sessionsDir)) return [];
  return fs.readdirSync(sessionsDir).filter((name) => name.endsWith('.json')).sort();
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

async function testGlobalPrefsPrioritization() {
  return withPluginHome('global_prefs_prioritization', async ({ homeDir, plugin }) => {
    writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
      preferences: {
        language_preference: '简体中文',
        user_info: '我是徐文杰，你可以叫我柚子',
        communication_style: '客观、理智、中立、无安慰型语言',
        user_education: '中南大学（本硕博）',
        nickname: '柚子',
        use_nickname_only: true,
        user_name: '柚子',
        assistant_name: '小六子',
        greeting: '柚子',
        communication_rules: '必须客观、理智、中立',
        language: 'Chinese',
        note: '我喜欢 TypeScript 和简洁代码风格，请注意可读性和代码质量'
      },
      snippets: {},
      feedback: []
    });
    const text = plugin.__test.buildGlobalPrefsContextText();
    const ok =
      text.includes('language: 中文')
      && text.includes('note:')
      && text.includes('TypeScript')
      && !text.includes('language_preference:');
    return {
      ok,
      detail: text || '<empty>'
    };
  });
}

async function testLowSignalLastObservedDoesNotOverrideSession() {
  return withPluginHome('low_signal_last_observed', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-low-signal');
    const fp = sessionPath(homeDir, 'sid-low-signal');
    const session = readJson(fp);
    session.recentEvents.push({
      ts: new Date().toISOString(),
      kind: 'user-message',
      summary: '我刚才在另一个会话写入的路径锚点是什么',
      eventType: 'messages.transform.user-fallback'
    });
    session.stats.userMessages = 1;
    writeJson(fp, session);
    plugin.__test.setLastObservedUserText('Fix this bug');
    const summary = plugin.__test.getLatestUserSummaryForSession('sid-low-signal', path.basename(process.cwd()));
    return {
      ok: summary === '我刚才在另一个会话写入的路径锚点是什么',
      detail: summary
    };
  });
}

async function testEmptyCleanStillPersistsUserEvent() {
  return withPluginHome('persist_inferred_user_event', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-empty-clean');
    plugin.__test.setLastObservedUserText('我刚才在另一个会话写入的路径锚点是什么');
    await plugin.__test.processUserMessageEvent('sid-empty-clean', '', {
      type: 'messages.transform.user-fallback',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-empty-clean'
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-empty-clean'));
    const summaries = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message').map((event) => event.summary)
      : [];
    return {
      ok: summaries.includes('我刚才在另一个会话写入的路径锚点是什么'),
      detail: JSON.stringify(summaries)
    };
  });
}

async function testConfigOverridesSlashCommandGuidance() {
  return withPluginHome('config_command_override', async ({ plugin }) => {
    const opencodeConfig = {
      command: {
        memory: {
          description: '管理记忆系统 — learn | project | global | set | save | export | import | clear | edit | feedback',
          template: 'Use the memory tool with the following arguments: $ARGUMENTS\n\n## /memory 子命令'
        }
      },
      experimental: {
        primary_tools: ['memory', 'context']
      },
      permission: {}
    };
    await plugin.config(opencodeConfig);
    const memoryCommand = opencodeConfig.command?.memory || {};
    const text = `${memoryCommand.description || ''}\n${memoryCommand.template || ''}`;
    return {
      ok:
        /Use the memory tool with the following arguments:\s*\$ARGUMENTS/.test(text)
        && /Treat the first token in `\$ARGUMENTS` as the `command` field/.test(text)
        && /`stats` -> `\{"command":"stats"\}`/.test(text)
        && /## \/memory 子命令/.test(text)
        && /\/memory recall <query>/.test(text)
        && /opencode run/i.test(text)
        && /不要|Do not/i.test(text),
      detail: text
    };
  });
}

async function testConfigOverridesContextGuidance() {
  return withPluginHome('config_context_override', async ({ plugin }) => {
    const opencodeConfig = {
      command: {
        context: {
          description: 'Manage session context',
          template: 'Use the context tool with the following arguments: $ARGUMENTS'
        }
      },
      permission: {}
    };
    await plugin.config(opencodeConfig);
    const contextCommand = opencodeConfig.command?.context || {};
    const text = `${contextCommand.description || ''}\n${contextCommand.template || ''}`;
    return {
      ok: /explicit session context/i.test(text) && /Do not use `context` for memory recall/i.test(text),
      detail: text
    };
  });
}

async function testSlashPrefixedMemoryStatsCommandParsesAndExecutes() {
  return withPluginHome('slash_prefixed_memory_stats', async ({ plugin }) => {
    const result = await plugin.tool.memory.execute({ command: '/memory stats' });
    let parsed = null;
    try {
      parsed = JSON.parse(String(result || 'null'));
    } catch {
      parsed = null;
    }
    return {
      ok:
        parsed
        && typeof parsed === 'object'
        && typeof parsed.project === 'string'
        && parsed.project.length > 0
        && parsed.pretrimConfig
        && parsed.distillConfig,
      detail: String(result || '')
    };
  });
}

async function testSlashPrefixedMemoryGlobalCommandParsesAndExecutes() {
  return withPluginHome('slash_prefixed_memory_global', async ({ homeDir, plugin }) => {
    writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
      preferences: {
        note: '/tmp/slash-memory-anchor-20260308'
      },
      snippets: {},
      feedback: []
    });
    const result = await plugin.tool.memory.execute({ command: '/memory global preferences.note' });
    return {
      ok: /preferences\.note = \/tmp\/slash-memory-anchor-20260308/.test(String(result || '')),
      detail: String(result || '')
    };
  });
}

async function testEmptyPayloadSlashMemoryStatsFallsBackToObservedText() {
  return withPluginHome('empty_payload_slash_memory_stats', async ({ plugin }) => {
    plugin.__test.setLastObservedUserText('/memory stats');
    const payload = {};
    const result = await plugin.tool.memory.execute(payload);
    let parsed = null;
    try {
      parsed = JSON.parse(String(result || 'null'));
    } catch {
      parsed = null;
    }
    return {
      ok:
        payload.command === 'stats'
        && (!Array.isArray(payload.args) || payload.args.length === 0)
        && parsed
        && typeof parsed === 'object'
        && typeof parsed.project === 'string'
        && parsed.project.length > 0,
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testExplicitSlashOverridesWrongToolGuess() {
  return withPluginHome('explicit_slash_overrides_wrong_guess', async ({ homeDir, plugin }) => {
    writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
      preferences: {
        note: '/tmp/should-not-win'
      },
      snippets: {},
      feedback: []
    });
    createSessionFile(homeDir, 'sid-explicit-slash');
    plugin.__test.setLastObservedUserText('/memory stats');
    const payload = {
      sessionID: 'sid-explicit-slash',
      command: 'global',
      args: ['preferences.note'],
      query: 'preferences.note'
    };
    const result = await plugin.tool.memory.execute(payload);
    let parsed = null;
    try {
      parsed = JSON.parse(String(result || 'null'));
    } catch {
      parsed = null;
    }
    return {
      ok:
        payload.command === 'stats'
        && (!Array.isArray(payload.args) || payload.args.length === 0)
        && payload.reason === 'coerced_from_explicit_slash'
        && parsed
        && typeof parsed === 'object'
        && typeof parsed.project === 'string'
        && !/should-not-win/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testContextToolRequiresCommand() {
  return withPluginHome('context_tool_requires_command', async ({ plugin }) => {
    const required = plugin?.tool?.context?.parameters?.required;
    return {
      ok: Array.isArray(required) && required.includes('command'),
      detail: JSON.stringify(required)
    };
  });
}

async function testEmptyContextCallAnnotatesPayload() {
  return withPluginHome('empty_context_call_annotates_payload', async ({ plugin }) => {
    const payload = {};
    const result = await plugin.tool.context.execute(payload);
    return {
      ok: payload.command === 'view' && payload.reason === 'empty_call_skipped' && /Skipped empty context call/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testEmptyContextCallInfersAddFromLatestUserText() {
  return withPluginHome('empty_context_call_infers_add', async ({ plugin }) => {
    plugin.__test.setLastObservedUserText('请使用 context 工具执行 add，参数为 LIVE-CONTEXT-551，然后只回复 CTX-ADD-OK');
    const payload = {};
    const result = await plugin.tool.context.execute(payload);
    return {
      ok:
        payload.command === 'add'
        && Array.isArray(payload.args)
        && payload.args[0] === 'LIVE-CONTEXT-551'
        && payload.reason === 'inferred_from_latest_user_text'
        && String(result || '') === 'Added to context: LIVE-CONTEXT-551',
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testEmptyContextCallInfersClearFromLatestUserText() {
  return withPluginHome('empty_context_call_infers_clear', async ({ plugin }) => {
    plugin.__test.setLastObservedUserText('请使用 context 工具执行 clear，然后只回复 CTX-CLEAR-OK');
    const payload = {};
    const result = await plugin.tool.context.execute(payload);
    return {
      ok:
        payload.command === 'clear'
        && Array.isArray(payload.args)
        && payload.args.length === 0
        && payload.reason === 'inferred_from_latest_user_text'
        && String(result || '') === 'Session context cleared.',
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testEmptyPayloadWriteAnnotatesCommand() {
  return withPluginHome('empty_payload_write_command', async ({ plugin }) => {
    plugin.__test.setLastObservedUserText('请你把我喜欢中文回复写入全局记忆');
    const payload = {};
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok: payload.command === 'set' && payload.key === 'preferences.language' && /preferences\.language/i.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testEmptyPayloadGenericGlobalWriteRejectsUnsupportedNoteFallback() {
  return withPluginHome('empty_payload_generic_global_write_rejects', async ({ plugin }) => {
    plugin.__test.setLastObservedUserText('请把这条普通说明写入全局记忆');
    const payload = {};
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok:
        payload.command === 'noop'
        && payload.reason === 'unsupported_global_write'
        && /Unsupported global write/i.test(String(result || ''))
        && /structured preference/i.test(String(result || ''))
        && /explicit note\/path anchor/i.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testWebPathGenericGlobalWriteDoesNotPolluteNote() {
  return withPluginHome('web_path_generic_global_write_no_note_pollution', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-web-generic-global');
    const globalPath = path.join(homeDir, '.opencode', 'memory', 'global.json');
    writeJson(globalPath, {
      preferences: {
        note: '/tmp/web-note-anchor-baseline'
      },
      snippets: {},
      feedback: []
    });

    await plugin.__test.processUserMessageEvent(
      'sid-web-generic-global',
      '请把这条普通说明写入全局记忆',
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sid-web-generic-global',
            messageID: 'msg-web-generic-global-1',
            role: 'user',
            summary: { body: '请把这条普通说明写入全局记忆' }
          }
        }
      }
    );

    const payload = { sessionID: 'sid-web-generic-global' };
    const result = await plugin.tool.memory.execute(payload);
    const gm = readJson(globalPath);
    const session = readJson(sessionPath(homeDir, 'sid-web-generic-global'));
    const userEvents = Array.isArray(session?.recentEvents)
      ? session.recentEvents.filter((event) => event?.kind === 'user-message')
      : [];

    return {
      ok:
        payload.command === 'noop'
        && payload.reason === 'unsupported_global_write'
        && /Unsupported global write/i.test(String(result || ''))
        && String(gm?.preferences?.note || '') === '/tmp/web-note-anchor-baseline'
        && userEvents.length === 1
        && userEvents[0]?.summary === '请把这条普通说明写入全局记忆',
      detail: JSON.stringify({
        payload,
        result,
        note: gm?.preferences?.note || '',
        userEvents
      })
    };
  });
}

async function testEmptyPayloadReadCanResolveFlattenedPreference() {
  return withPluginHome('empty_payload_read_lookup', async ({ homeDir, plugin }) => {
    // Path anchors are now stored per-project, not in global note
    const projectName = path.basename(process.cwd());
    const projectMetaPath = path.join(homeDir, '.opencode', 'memory', 'projects', projectName, 'memory.json');
    writeJson(projectMetaPath, {
      pathAnchors: ['/tmp/memory-anchor-20260307-r3']
    });
    writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
      preferences: { language: 'Chinese' },
      snippets: {},
      feedback: []
    });
    plugin.__test.setLastObservedUserText('我刚才另一个会话写入的路径锚点是什么');
    const payload = {};
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok: payload.command === 'global' && /path anchor/i.test(String(result || '')) && /\/tmp\/memory-anchor-20260307-r3/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testEmptyPayloadReadCanResolveNicknamePreference() {
  return withPluginHome('empty_payload_read_nickname', async ({ homeDir, plugin }) => {
    writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
      preferences: {
        nickname: '柚子',
        user_name: '柚子',
        greeting: '柚子'
      },
      snippets: {},
      feedback: []
    });
    plugin.__test.setLastObservedUserText('我在全局记忆里的称呼是什么？');
    const payload = {};
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok: payload.command === 'global' && /preferences\.nickname = 柚子/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testEmptyPayloadReadResolvesLegacyLanguageAlias() {
  return withPluginHome('empty_payload_read_legacy_language', async ({ homeDir, plugin }) => {
    writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
      preferences: {
        language_preference: '简体中文'
      },
      snippets: {},
      feedback: []
    });
    plugin.__test.setLastObservedUserText('我的全局语言偏好是什么？');
    const payload = {};
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok: payload.command === 'global' && /preferences\.language = 中文/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testTransformInjectsGlobalReadHintForKnownPreference() {
  return withPluginHome('transform_injects_global_read_hint', async ({ homeDir, plugin }) => {
    // Path anchors are now stored per-project
    const projectName = path.basename(process.cwd());
    const projectMetaPath = path.join(homeDir, '.opencode', 'memory', 'projects', projectName, 'memory.json');
    writeJson(projectMetaPath, {
      pathAnchors: ['/tmp/memory-anchor-20260307-r16']
    });
    writeJson(path.join(homeDir, '.opencode', 'memory', 'global.json'), {
      preferences: {},
      snippets: {},
      feedback: []
    });
    const messages = [
      {
        info: {
          role: 'user',
          sessionID: 'sid-transform-global-read',
          id: 'msg-global-read-1'
        },
        parts: [
          {
            type: 'text',
            text: '我刚才另一个会话写入的路径锚点是什么？只回复路径或不知道'
          }
        ]
      }
    ];
    await plugin['experimental.chat.messages.transform'](
      {},
      { messages }
    );
    const parts = Array.isArray(messages[0]?.parts) ? messages[0].parts : [];
    const injectedPart = parts.find((part) => String(part?.text || '').includes('<memory-global-read'));
    const session = readJson(sessionPath(homeDir, 'sid-transform-global-read'));
    return {
      ok:
        /project\.pathAnchors/.test(String(injectedPart?.text || ''))
        && /\/tmp\/memory-anchor-20260307-r16/.test(String(injectedPart?.text || ''))
        && injectedPart?.synthetic === true
        && injectedPart?.ignored !== true
        && String(session?.inject?.lastReason || '') === 'current-global-read'
        && String(session?.inject?.lastStatus || '') === 'success',
      detail: JSON.stringify({ parts, inject: session?.inject || null })
    };
  });
}

async function testDuplicateUserMessageDedupesAcrossDifferentIds() {
  return withPluginHome('duplicate_user_dedupe', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-duplicate-user');
    const baseEvent = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-duplicate-user',
          id: messageID,
          messageID
        }
      }
    });
    await plugin.__test.processUserMessageEvent('sid-duplicate-user', '请你把我喜欢中文回复写入全局记忆，', baseEvent('msg-1'));
    await plugin.__test.processUserMessageEvent('sid-duplicate-user', '请你把我喜欢中文回复写入全局记忆，', baseEvent('msg-2'));
    const session = readJson(sessionPath(homeDir, 'sid-duplicate-user'));
    const matches = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message' && event.summary === '请你把我喜欢中文回复写入全局记忆，')
      : [];
    return {
      ok: matches.length === 1,
      detail: JSON.stringify(matches)
    };
  });
}

async function testDuplicateUserMessageDedupesBeyondShortWindow() {
  return withPluginHome('duplicate_user_dedupe_long_window', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-duplicate-user-long');
    const baseEvent = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-duplicate-user-long',
          id: messageID,
          messageID
        }
      }
    });
    const originalNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      await plugin.__test.processUserMessageEvent('sid-duplicate-user-long', '请把 /tmp/memory-anchor-20260307-r5 写入全局记忆，', baseEvent('msg-a'));
      const fp = sessionPath(homeDir, 'sid-duplicate-user-long');
      const midSession = readJson(fp);
      midSession.recentEvents.push({
        ts: new Date().toISOString(),
        kind: 'tool-result',
        summary: '[memory] input={"command":"set"} output=Global setting already persisted',
        tool: 'memory',
        eventType: 'message.part.updated'
      });
      midSession.lastFingerprint = 'sid-duplicate-user-long|tool-result|memory|Global setting already persisted';
      writeJson(fp, midSession);
      now += 20_000;
      await plugin.__test.processUserMessageEvent('sid-duplicate-user-long', '请把 /tmp/memory-anchor-20260307-r5 写入全局记忆，', baseEvent('msg-b'));
    } finally {
      Date.now = originalNow;
    }
    const session = readJson(sessionPath(homeDir, 'sid-duplicate-user-long'));
    const matches = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message' && event.summary === '请把 /tmp/memory-anchor-20260307-r5 写入全局记忆，')
      : [];
    return {
      ok: matches.length === 1,
      detail: JSON.stringify(matches)
    };
  });
}

async function testDuplicateUserMessageDedupesAcrossFortyFiveSeconds() {
  return withPluginHome('duplicate_user_dedupe_45s', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-duplicate-user-45s');
    const baseEvent = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-duplicate-user-45s',
          id: messageID,
          messageID
        }
      }
    });
    const originalNow = Date.now;
    try {
      let now = 4_000_000;
      Date.now = () => now;
      await plugin.__test.processUserMessageEvent('sid-duplicate-user-45s', '请把 /tmp/memory-anchor-20260307-r11 写入全局记忆，', baseEvent('msg-a'));
      now += 45_000;
      await plugin.__test.processUserMessageEvent('sid-duplicate-user-45s', '请把 /tmp/memory-anchor-20260307-r11 写入全局记忆，', baseEvent('msg-b'));
    } finally {
      Date.now = originalNow;
    }
    const session = readJson(sessionPath(homeDir, 'sid-duplicate-user-45s'));
    const matches = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message' && event.summary === '请把 /tmp/memory-anchor-20260307-r11 写入全局记忆，')
      : [];
    return {
      ok: matches.length === 1,
      detail: JSON.stringify({
        matches,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testTransformFallbackAndLateMessageUpdateCollapseIntoSingleUserEvent() {
  return withPluginHome('duplicate_user_transform_then_update', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-transform-then-update');
    const messageUpdated = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-transform-then-update',
          id: messageID,
          messageID
        }
      }
    });
    const transformFallback = {
      type: 'messages.transform.user-fallback',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-transform-then-update'
        }
      }
    };
    const originalNow = Date.now;
    try {
      let now = 7_000_000;
      Date.now = () => now;
      await plugin.__test.processUserMessageEvent('sid-transform-then-update', '请把 /tmp/memory-anchor-20260307-r12 写入全局记忆，', messageUpdated('msg-a'));
      now += 4_000;
      await plugin.__test.processUserMessageEvent('sid-transform-then-update', '请把 /tmp/memory-anchor-20260307-r12 写入全局记忆，', transformFallback);
      plugin.__test.appendAutoEvent({
        sessionID: 'sid-transform-then-update',
        kind: 'tool-result',
        summary: '[memory] input={"command":"set"} output=Global setting already persisted',
        toolName: 'memory',
        rawEvent: { type: 'message.part.updated' }
      });
      now += 28_000;
      await plugin.__test.processUserMessageEvent('sid-transform-then-update', '请把 /tmp/memory-anchor-20260307-r12 写入全局记忆，', messageUpdated('msg-b'));
    } finally {
      Date.now = originalNow;
    }
    const session = readJson(sessionPath(homeDir, 'sid-transform-then-update'));
    const matches = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message' && event.summary === '请把 /tmp/memory-anchor-20260307-r12 写入全局记忆，')
      : [];
    const types = matches.map((event) => event.eventType);
    return {
      ok: matches.length === 1 && types[0] === 'message.updated' && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({ matches, stats: session.stats })
    };
  });
}

async function testLateDuplicateUserMessageAfterAssistantIsSkipped() {
  return withPluginHome('duplicate_user_after_assistant', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-duplicate-after-assistant');
    const messageUpdated = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-duplicate-after-assistant',
          id: messageID,
          messageID
        }
      }
    });
    const originalNow = Date.now;
    try {
      let now = 8_000_000;
      Date.now = () => now;
      await plugin.__test.processUserMessageEvent('sid-duplicate-after-assistant', '我刚才另一个会话写入的路径锚点是什么？', messageUpdated('msg-a'));
      plugin.__test.appendAutoEvent({
        sessionID: 'sid-duplicate-after-assistant',
        kind: 'tool-result',
        summary: '[memory] input={"command":"global"} output=Global memory: preferences.note = /tmp/memory-anchor-20260307-r12',
        toolName: 'memory',
        rawEvent: { type: 'message.part.updated' }
      });
      plugin.__test.appendAutoEvent({
        sessionID: 'sid-duplicate-after-assistant',
        kind: 'assistant-message',
        summary: '/tmp/memory-anchor-20260307-r12',
        rawEvent: { type: 'message.part.updated' }
      });
      now += 39_000;
      await plugin.__test.processUserMessageEvent('sid-duplicate-after-assistant', '我刚才另一个会话写入的路径锚点是什么？', messageUpdated('msg-b'));
    } finally {
      Date.now = originalNow;
    }
    const session = readJson(sessionPath(homeDir, 'sid-duplicate-after-assistant'));
    const matches = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message' && event.summary === '我刚才另一个会话写入的路径锚点是什么？')
      : [];
    return {
      ok: matches.length === 1 && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({ matches, stats: session.stats, recentEvents: session.recentEvents })
    };
  });
}

async function testLateTruncatedUserMessageAfterAssistantIsSkipped() {
  return withPluginHome('truncated_duplicate_user_after_assistant', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-truncated-duplicate-after-assistant');
    const messageUpdated = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-truncated-duplicate-after-assistant',
          id: messageID,
          messageID
        }
      }
    });
    const originalNow = Date.now;
    try {
      let now = 9_000_000;
      Date.now = () => now;
      await plugin.__test.processUserMessageEvent(
        'sid-truncated-duplicate-after-assistant',
        '第4轮：这是 synthetic notice 新补丁 fresh live 第4轮，只回复 FRESH-SYN-4',
        messageUpdated('msg-a')
      );
      plugin.__test.appendAutoEvent({
        sessionID: 'sid-truncated-duplicate-after-assistant',
        kind: 'assistant-message',
        summary: 'FRESH-SYN-4',
        rawEvent: { type: 'message.part.updated' }
      });
      now += 22_000;
      await plugin.__test.processUserMessageEvent(
        'sid-truncated-duplicate-after-assistant',
        '第4轮：这是 synthetic notice 新补丁 fresh live 第4轮，',
        messageUpdated('msg-b')
      );
    } finally {
      Date.now = originalNow;
    }
    const session = readJson(sessionPath(homeDir, 'sid-truncated-duplicate-after-assistant'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '第4轮：这是 synthetic notice 新补丁 fresh live 第4轮，只回复 FRESH-SYN-4'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({ userEvents, stats: session.stats, recentEvents: session.recentEvents })
    };
  });
}

async function testLateUserEventPrefersObservedTextOverAssistantSummary() {
  return withPluginHome('late_user_prefers_observed_text', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-late-web-observed');
    const expected = '请把 /tmp/web-retest-anchor-20260308-k1 写入全局记忆，';
    const messageUpdated = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-late-web-observed',
          id: messageID,
          messageID
        }
      }
    });

    plugin.__test.setLastObservedUserText(expected);
    plugin.__test.appendAutoEvent({
      sessionID: 'sid-late-web-observed',
      kind: 'tool-result',
      summary: '[memory] input={"command":"global","args":["preferences.note"],"query":"preferences.note"} output=Global memory: preferences.note = /tmp/web-retest-anchor-20260308-k1',
      toolName: 'memory',
      rawEvent: { type: 'message.part.updated' }
    });
    plugin.__test.appendAutoEvent({
      sessionID: 'sid-late-web-observed',
      kind: 'assistant-message',
      summary: 'WEB-RETEST-K1',
      rawEvent: { type: 'message.part.updated' }
    });

    await plugin.__test.processUserMessageEvent('sid-late-web-observed', '', messageUpdated('msg-web-late'));

    const session = readJson(sessionPath(homeDir, 'sid-late-web-observed'));
    const userMessages = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    const firstUser = userMessages[0] || null;

    return {
      ok:
        firstUser?.summary === expected
        && session.sessionTitle === expected
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        sessionTitle: session.sessionTitle,
        userMessages,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testSanitizeStripsLeadingDashPrefix() {
  return withPluginHome('sanitize_leading_dash', async ({ plugin }) => {
    const result = plugin.__test.sanitizeUserTextForMemoryInference('--- 我刚才另一个会话写入的路径锚点是什么？');
    return {
      ok: result === '我刚才另一个会话写入的路径锚点是什么？',
      detail: result
    };
  });
}

async function testInferUserTextFromRunArgvIgnoresModelFlags() {
  return withPluginHome('infer_user_text_run_argv', async ({ plugin }) => {
    const originalArgv = process.argv.slice();
    try {
      process.argv = [
        '/usr/local/bin/node',
        '/usr/local/bin/opencode',
        'run',
        '-m',
        'maoshu-openai/gpt-5.3-codex',
        '请把 /tmp/memory-anchor-20260307-r7 写入全局记忆，只回复 R7-OK'
      ];
      const result = plugin.__test.inferUserTextFromProcessArgv();
      return {
        ok: result === '请把 /tmp/memory-anchor-20260307-r7 写入全局记忆，',
        detail: result
      };
    } finally {
      process.argv = originalArgv;
    }
  });
}

async function testSessionScopedLookupDoesNotBorrowOtherSessionText() {
  return withPluginHome('session_scoped_lookup_no_cross_borrow', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-current');
    createSessionFile(homeDir, 'sid-other');
    const other = readJson(sessionPath(homeDir, 'sid-other'));
    other.recentEvents.push({
      ts: new Date().toISOString(),
      kind: 'user-message',
      summary: '我刚才另一个会话写入的路径锚点是什么？',
      eventType: 'message.updated'
    });
    other.stats.userMessages = 1;
    writeJson(sessionPath(homeDir, 'sid-other'), other);
    const result = plugin.__test.getLatestUserTextForSession('sid-current');
    return {
      ok: result === '',
      detail: result || '<empty>'
    };
  });
}

async function testLateUserMessageReconcilesInferredAssistantTurn() {
  return withPluginHome('late_user_message_reconcile', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-late-user');
    plugin.__test.appendAutoEvent({
      sessionID: 'sid-late-user',
      kind: 'assistant-message',
      summary: 'LIVE-SEQ-PLAIN-20260307-C1'
    });
    await plugin.__test.processUserMessageEvent('sid-late-user', 'LIVE-SEQ-PLAIN-20260307-C1', {
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-late-user',
          id: 'msg-u1',
          messageID: 'msg-u1'
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-late-user'));
    const recent = Array.isArray(session.recentEvents) ? session.recentEvents : [];
    const kinds = recent.map((event) => `${event.kind}:${event.summary}`);
    const userEvent = recent.find((event) => event.kind === 'user-message');
    const inferredAssistant = recent.find((event) => event.kind === 'assistant-message');
    return {
      ok:
        JSON.stringify(kinds) === JSON.stringify([
          'user-message:LIVE-SEQ-PLAIN-20260307-C1',
          'assistant-message:LIVE-SEQ-PLAIN-20260307-C1'
        ]) &&
        Date.parse(String(userEvent?.ts || 0)) <= Date.parse(String(inferredAssistant?.ts || 0)) &&
        !inferredAssistant?.inferredUserTurn &&
        Number(session?.stats?.userMessages || 0) === 1 &&
        Number(session?.stats?.assistantMessages || 0) === 1,
      detail: JSON.stringify({
        kinds,
        ts: recent.map((event) => ({ kind: event.kind, ts: event.ts })),
        stats: session.stats,
        inferredUserTurn: Boolean(inferredAssistant?.inferredUserTurn)
      })
    };
  });
}

async function testSanitizeStripsBoundaryQuotes() {
  return withPluginHome('sanitize_boundary_quotes', async ({ plugin }) => {
    const result = plugin.__test.sanitizeUserTextForMemoryInference('"请把 /tmp/memory-anchor-20260307-r9 写入全局记忆，只回复 OBS-PATH-20260307-D3');
    return {
      ok: result === '请把 /tmp/memory-anchor-20260307-r9 写入全局记忆，',
      detail: result
    };
  });
}

async function testSanitizeCollapsesMemorySlashTemplateWrapper() {
  return withPluginHome('sanitize_memory_slash_template', async ({ plugin }) => {
    const raw = [
      'Use the memory tool with the following arguments: stats',
      '',
      'If no argument is provided, explain the available `/memory` subcommands below and do not call any tool.',
      'This slash template is only for a human manually typing `/memory` in an interactive shell.',
      'In `opencode run` and frontend-generated model output, do not emit `/memory ...`.'
    ].join('\n');
    const result = plugin.__test.sanitizeUserTextForMemoryInference(raw);
    return {
      ok: result === '/memory stats',
      detail: result
    };
  });
}

async function testSanitizeTrimsSlashTemplateSuffixAfterCommand() {
  return withPluginHome('sanitize_memory_slash_suffix', async ({ plugin }) => {
    const raw = [
      '/memory stats',
      'Treat the first token in `stats` as the `command` field and the remaining tokens as `args`.',
      'Examples: `stats` -> `{"command":"stats"}`; `global preferences.note` -> `{"command":"global","args":["preferences.note"]}`.',
      'Do not persist `stats` as memory content, and never write `preferences.arguments` from slash command text.'
    ].join(' ');
    const result = plugin.__test.sanitizeUserTextForMemoryInference(raw);
    return {
      ok: result === '/memory stats',
      detail: result
    };
  });
}

async function testDiskBackedUserDedupeSurvivesPluginReload() {
  return withPluginHome('disk_backed_user_dedupe', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-disk-dedupe');
    const baseEvent = (messageID) => ({
      type: 'message.updated',
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-disk-dedupe',
          id: messageID,
          messageID
        }
      }
    });
    const originalNow = Date.now;
    try {
      let now = 2_000_000;
      Date.now = () => now;
      await plugin.__test.processUserMessageEvent('sid-disk-dedupe', '请把 /tmp/memory-anchor-20260307-r10 写入全局记忆，', baseEvent('msg-1'));
      now += 20_000;
      const mod2 = await loadPluginWithHome(homeDir);
      const plugin2 = mod2.MemorySystemPlugin({ client: makeClient() });
      await plugin2.__test.processUserMessageEvent('sid-disk-dedupe', '请把 /tmp/memory-anchor-20260307-r10 写入全局记忆，', baseEvent('msg-2'));
    } finally {
      Date.now = originalNow;
    }
    const session = readJson(sessionPath(homeDir, 'sid-disk-dedupe'));
    const matches = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message' && event.summary === '请把 /tmp/memory-anchor-20260307-r10 写入全局记忆，')
      : [];
    return {
      ok: matches.length === 1,
      detail: JSON.stringify(matches)
    };
  });
}

async function testMixedUserEventTypesDedupesSameCleanText() {
  return withPluginHome('mixed_user_event_type_dedupe', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-mixed-dedupe');
    const originalNow = Date.now;
    try {
      let now = 3_000_000;
      Date.now = () => now;
      await plugin.__test.processUserMessageEvent('sid-mixed-dedupe', '"请把 /tmp/memory-anchor-20260307-r11 写入全局记忆，只回复 OBS-PATH-20260307-E2', {
        type: 'messages.transform.user-fallback',
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-mixed-dedupe'
          }
        }
      });
      now += 20_000;
      await plugin.__test.processUserMessageEvent('sid-mixed-dedupe', '请把 /tmp/memory-anchor-20260307-r11 写入全局记忆，', {
        type: 'message.updated',
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-mixed-dedupe',
            id: 'msg-u2',
            messageID: 'msg-u2'
          }
        }
      });
    } finally {
      Date.now = originalNow;
    }
    const session = readJson(sessionPath(homeDir, 'sid-mixed-dedupe'));
    const matches = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message' && event.summary === '请把 /tmp/memory-anchor-20260307-r11 写入全局记忆，')
      : [];
    return {
      ok: matches.length === 1,
      detail: JSON.stringify({
        matches,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testSemanticRecallRanksSourceSessionAboveQuestionSession() {
  return withPluginHome('semantic_recall_source_ranking', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-semantic-query');
    createSessionFile(homeDir, 'sid-semantic-source');

    const querySession = readJson(sessionPath(homeDir, 'sid-semantic-query'));
    querySession.sessionTitle = '我刚才另一个会话提到的海豚计划代号是什么？';
    querySession.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '我刚才另一个会话提到的海豚计划代号是什么？',
        eventType: 'message.updated'
      },
      {
        ts: new Date().toISOString(),
        kind: 'assistant-message',
        summary: '不知道',
        eventType: 'message.updated'
      }
    ];
    querySession.stats = { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-semantic-query'), querySession);

    const sourceSession = readJson(sessionPath(homeDir, 'sid-semantic-source'));
    sourceSession.sessionTitle = '记住这个跨会话事实：海豚计划代号是 DELTA-777。';
    sourceSession.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：海豚计划代号是 DELTA-777。',
        eventType: 'message.updated'
      },
      {
        ts: new Date().toISOString(),
        kind: 'tool-result',
        summary: '[memory] input={"command":"noop"} output=Skipped empty memory call',
        tool: 'memory',
        eventType: 'message.part.updated'
      }
    ];
    sourceSession.summary = {
      compressedText: 'key fact: 海豚计划代号是 DELTA-777。',
      compressedEvents: 0
    };
    sourceSession.stats = { userMessages: 1, assistantMessages: 0, toolResults: 1, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-semantic-source'), sourceSession);

    const query = '我刚才另一个会话提到的海豚计划代号是什么？';
    const tokens = plugin.__test.tokenize(query);
    const recall = plugin.__test.recallProjectMemories(query, {
      currentSessionID: 'sid-semantic-query',
      includeCurrent: false,
      maxSessions: 2
    });

    return {
      ok:
        JSON.stringify(tokens) === JSON.stringify(['海豚计划代号', '代号'])
        && Array.isArray(recall.hits)
        && recall.hits[0]?.sessionID === 'sid-semantic-source'
        && !recall.hits.some((hit) => hit?.sessionID === 'sid-semantic-query'),
      detail: JSON.stringify({
        tokens,
        hits: Array.isArray(recall.hits) ? recall.hits.map((hit) => hit?.sessionID || null) : []
      })
    };
  });
}

async function testTransformInputSkipsLowSignalPlaceholderAndFindsRealWebPrompt() {
  return withPluginHome('transform_input_low_signal_web_placeholder', async ({ plugin }) => {
    const rawPrompt = '请把 /tmp/web-memory-anchor-20260308 写入全局记忆，只回复 WEB-WRITE-OK';
    const fromTransform = plugin.__test.inferLatestUserTextFromTransformInput({
      messages: [
        {
          role: 'user',
          content: '--- 2'
        }
      ],
      data: {
        message: rawPrompt
      }
    });
    const fromMessages = plugin.__test.inferLatestUserText([
      {
        info: {
          role: 'user',
          sessionID: 'sid-web-low-signal',
          id: 'msg-web-low-signal'
        },
        content: '--- 2',
        parts: [
          {
            type: 'text',
            text: '--- 2'
          }
        ]
      }
    ]);
    return {
      ok:
        fromTransform === '请把 /tmp/web-memory-anchor-20260308 写入全局记忆，'
        && fromMessages === '',
      detail: JSON.stringify({ fromTransform, fromMessages })
    };
  });
}

async function testInferLatestUserTextKeepsControlOnlyPromptWhenSanitizeWouldEmpty() {
  return withPluginHome('infer_latest_user_text_control_only', async ({ plugin }) => {
    const fromMessages = plugin.__test.inferLatestUserText([
      {
        info: {
          role: 'user',
          sessionID: 'sid-control-only',
          id: 'msg-control-only'
        },
        parts: [
          {
            type: 'text',
            text: '只回复 FIXFAST-2'
          }
        ]
      }
    ]);
    const fromTransform = plugin.__test.inferLatestUserTextFromTransformInput({
      messages: [
        {
          role: 'user',
          content: '只回复 FIXFAST-3'
        }
      ]
    });
    return {
      ok: fromMessages === '只回复 FIXFAST-2' && fromTransform === '只回复 FIXFAST-3',
      detail: JSON.stringify({ fromMessages, fromTransform })
    };
  });
}

async function testWeakFollowupRecallUsesCurrentSessionContext() {
  return withPluginHome('weak_followup_recall_context', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-followup-current');
    createSessionFile(homeDir, 'sid-followup-source');
    createSessionFile(homeDir, 'sid-followup-distractor');

    const source = readJson(sessionPath(homeDir, 'sid-followup-source'));
    source.sessionTitle = '跨会话事实：鲸落计划代号是 ORCA-904';
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：鲸落计划代号是 ORCA-904。',
        eventType: 'message.updated'
      },
      {
        ts: new Date().toISOString(),
        kind: 'assistant-message',
        summary: '好的，我会记住：鲸落计划代号是 ORCA-904。',
        eventType: 'message.part.updated'
      }
    ];
    source.summary = {
      compressedText: 'key fact: 鲸落计划代号是 ORCA-904。',
      compressedEvents: 0
    };
    source.stats = { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-followup-source'), source);

    const distractor = readJson(sessionPath(homeDir, 'sid-followup-distractor'));
    distractor.sessionTitle = '另一个代号是什么';
    distractor.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '另一个代号是什么',
        eventType: 'message.updated'
      },
      {
        ts: new Date().toISOString(),
        kind: 'assistant-message',
        summary: '不知道',
        eventType: 'message.part.updated'
      }
    ];
    distractor.summary = { compressedText: '', compressedEvents: 0 };
    distractor.stats = { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-followup-distractor'), distractor);

    const current = readJson(sessionPath(homeDir, 'sid-followup-current'));
    current.sessionTitle = '追问：另一个代号是什么';
    current.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '海豚计划代号是什么？',
        eventType: 'message.updated'
      },
      {
        ts: new Date().toISOString(),
        kind: 'assistant-message',
        summary: 'DELTA-904',
        eventType: 'message.part.updated'
      },
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '另一个代号是什么？',
        eventType: 'message.updated'
      }
    ];
    current.stats = { userMessages: 2, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-followup-current'), current);

    const recall = plugin.__test.recallProjectMemories('另一个代号是什么？', {
      currentSessionID: 'sid-followup-current',
      includeCurrent: false,
      maxSessions: 2
    });

    return {
      ok:
        Array.isArray(recall.hits)
        && recall.hits[0]?.sessionID === 'sid-followup-source'
        && /ORCA-904/.test(String(recall.text || ''))
        && /DELTA-904/.test(String(recall.effectiveQuery || '')),
      detail: JSON.stringify({
        effectiveQuery: recall.effectiveQuery,
        hits: Array.isArray(recall.hits) ? recall.hits.map((hit) => hit?.sessionID || null) : [],
        text: recall.text
      })
    };
  });
}

async function testRecallContextHidesSessionIdsInInjectedText() {
  return withPluginHome('recall_context_hides_session_ids', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-recall-hidden-source');
    createSessionFile(homeDir, 'sid-recall-hidden-current');

    const source = readJson(sessionPath(homeDir, 'sid-recall-hidden-source'));
    source.sessionTitle = '跨会话事实：鲸落计划代号是 ORCA-76431';
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：海豚计划代号是 DELTA-76431，鲸落计划代号是 ORCA-76431。',
        eventType: 'message.updated'
      }
    ];
    source.summary = {
      compressedText: 'key fact: 海豚计划代号是 DELTA-76431。鲸落计划代号是 ORCA-76431。',
      compressedEvents: 0
    };
    source.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-recall-hidden-source'), source);

    const recall = plugin.__test.recallProjectMemories('我知道 DELTA-76431，另一个呢？', {
      currentSessionID: 'sid-recall-hidden-current',
      includeCurrent: false,
      maxSessions: 2
    });
    const text = String(recall.text || '');
    return {
      ok:
        Array.isArray(recall.hits)
        && recall.hits[0]?.sessionID === 'sid-recall-hidden-source'
        && /ORCA-76431/.test(text)
        && !/sid-recall-hidden-source/i.test(text)
        && !/Session sid-/i.test(text)
        && /Never answer with a session ID/i.test(text),
      detail: JSON.stringify({
        hits: Array.isArray(recall.hits) ? recall.hits.map((hit) => hit?.sessionID || null) : [],
        text
      })
    };
  });
}

async function testRecallDirectSessionTitleMatch() {
  return withPluginHome('recall_direct_session_title_match', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-direct-title-source');
    createSessionFile(homeDir, 'sid-direct-title-current');
    const source = readJson(sessionPath(homeDir, 'sid-direct-title-source'));
    source.sessionTitle = '海豚计划：路径锚点在 /tmp/direct-title-anchor';
    source.summary = {
      compressedText: 'key fact: 路径锚点是 /tmp/direct-title-anchor。',
      compressedEvents: 0
    };
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'assistant-message',
        summary: '路径锚点已经确认在 /tmp/direct-title-anchor',
        eventType: 'message.part.updated'
      }
    ];
    source.stats = { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-direct-title-source'), source);
    const recall = plugin.__test.recallProjectMemories('请读取会话“海豚计划：路径锚点在 /tmp/direct-title-anchor”里的内容', {
      currentSessionID: 'sid-direct-title-current',
      includeCurrent: false,
      maxSessions: 2
    });
    return {
      ok:
        Array.isArray(recall.hits)
        && recall.hits[0]?.sessionID === 'sid-direct-title-source'
        && /direct-title-anchor/.test(String(recall.text || '')),
      detail: JSON.stringify({
        hits: Array.isArray(recall.hits) ? recall.hits.map((hit) => hit?.sessionID || null) : [],
        text: recall.text
      })
    };
  });
}

async function testRecallNaturalSentenceTitleMatch() {
  return withPluginHome('recall_natural_sentence_title_match', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-natural-title-source');
    createSessionFile(homeDir, 'sid-natural-title-current');
    const source = readJson(sessionPath(homeDir, 'sid-natural-title-source'));
    source.sessionTitle = '海豚计划：文件保存在 /tmp/natural-title-save';
    source.summary = {
      compressedText: 'key fact: 文件保存在 /tmp/natural-title-save。',
      compressedEvents: 0
    };
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '文件保存在哪里了',
        eventType: 'message.updated'
      },
      {
        ts: new Date().toISOString(),
        kind: 'assistant-message',
        summary: '文件保存在 /tmp/natural-title-save',
        eventType: 'message.part.updated'
      }
    ];
    source.stats = { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-natural-title-source'), source);
    const recall = plugin.__test.recallProjectMemories('告诉我在“海豚计划：文件保存在 /tmp/natural-title-save”中我提到了什么，文件保存在哪里了', {
      currentSessionID: 'sid-natural-title-current',
      includeCurrent: false,
      maxSessions: 2
    });
    return {
      ok:
        Array.isArray(recall.hits)
        && recall.hits[0]?.sessionID === 'sid-natural-title-source'
        && /natural-title-save/.test(String(recall.text || '')),
      detail: JSON.stringify({
        hits: Array.isArray(recall.hits) ? recall.hits.map((hit) => hit?.sessionID || null) : [],
        text: recall.text
      })
    };
  });
}

async function testRecallDirectSessionIdMatch() {
  return withPluginHome('recall_direct_session_id_match', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-direct-id-source');
    createSessionFile(homeDir, 'sid-direct-id-current');
    const source = readJson(sessionPath(homeDir, 'sid-direct-id-source'));
    source.sessionTitle = '直接按 session id 召回';
    source.summary = {
      compressedText: 'key fact: 这个会话的关键结论是 ORCA-ID-991。',
      compressedEvents: 0
    };
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'assistant-message',
        summary: '关键结论 ORCA-ID-991',
        eventType: 'message.part.updated'
      }
    ];
    source.stats = { userMessages: 1, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-direct-id-source'), source);
    const recall = plugin.__test.recallProjectMemories('请读取 session sid-direct-id-source 里之前聊过的关键结论', {
      currentSessionID: 'sid-direct-id-current',
      includeCurrent: false,
      maxSessions: 2
    });
    return {
      ok:
        Array.isArray(recall.hits)
        && recall.hits[0]?.sessionID === 'sid-direct-id-source'
        && /ORCA-ID-991/.test(String(recall.text || '')),
      detail: JSON.stringify({
        hits: Array.isArray(recall.hits) ? recall.hits.map((hit) => hit?.sessionID || null) : [],
        text: recall.text
      })
    };
  });
}

async function testWeakFollowupQueryAutoTriggersRecallPath() {
  return withPluginHome('weak_followup_auto_recall', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-auto-followup-source');
    createSessionFile(homeDir, 'sid-auto-followup-current');

    const source = readJson(sessionPath(homeDir, 'sid-auto-followup-source'));
    source.sessionTitle = '跨会话事实：鲸落计划代号是 ORCA-904';
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：海豚计划代号是 DELTA-904，鲸落计划代号是 ORCA-904。',
        eventType: 'message.updated'
      }
    ];
    source.summary = {
      compressedText: 'key fact: 海豚计划代号是 DELTA-904。鲸落计划代号是 ORCA-904。',
      compressedEvents: 0
    };
    source.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-auto-followup-source'), source);

    plugin.__test.setSessionLatestUserText('sid-auto-followup-current', '我已经知道海豚计划代号是 DELTA-904，另一个代号是什么？');
    const payload = { sessionID: 'sid-auto-followup-current' };
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok:
        payload.command === 'recall'
        && /sid-auto-followup-source/.test(String(result || ''))
        && /ORCA-904/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testWeakerFollowupQueryAutoTriggersRecallPath() {
  return withPluginHome('weaker_followup_auto_recall', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-weaker-followup-source');
    createSessionFile(homeDir, 'sid-weaker-followup-current');

    const source = readJson(sessionPath(homeDir, 'sid-weaker-followup-source'));
    source.sessionTitle = '跨会话事实：鲸落计划代号是 ORCA-905';
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：海豚计划代号是 DELTA-905，鲸落计划代号是 ORCA-905。',
        eventType: 'message.updated'
      }
    ];
    source.summary = {
      compressedText: 'key fact: 海豚计划代号是 DELTA-905。鲸落计划代号是 ORCA-905。',
      compressedEvents: 0
    };
    source.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-weaker-followup-source'), source);

    plugin.__test.setSessionLatestUserText('sid-weaker-followup-current', '我已经知道海豚计划代号是 DELTA-905，那另一个呢？');
    const payload = { sessionID: 'sid-weaker-followup-current' };
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok:
        payload.command === 'recall'
        && /sid-weaker-followup-source/.test(String(result || ''))
        && /ORCA-905/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testShortestFollowupQueryAutoTriggersRecallPath() {
  return withPluginHome('shortest_followup_auto_recall', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-shortest-followup-source');
    createSessionFile(homeDir, 'sid-shortest-followup-current');

    const source = readJson(sessionPath(homeDir, 'sid-shortest-followup-source'));
    source.sessionTitle = '跨会话事实：鲸落计划代号是 ORCA-67421';
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：海豚计划代号是 DELTA-67421，鲸落计划代号是 ORCA-67421。',
        eventType: 'message.updated'
      }
    ];
    source.summary = {
      compressedText: 'key fact: 海豚计划代号是 DELTA-67421。鲸落计划代号是 ORCA-67421。',
      compressedEvents: 0
    };
    source.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-shortest-followup-source'), source);

    plugin.__test.setSessionLatestUserText('sid-shortest-followup-current', '我知道 DELTA-67421，另一个呢？');
    const payload = { sessionID: 'sid-shortest-followup-current' };
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok:
        payload.command === 'recall'
        && /sid-shortest-followup-source/.test(String(result || ''))
        && /ORCA-67421/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testWeakFollowupRemainingVariantAutoTriggersRecallPath() {
  return withPluginHome('weak_followup_remaining_variant_auto_recall', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-remaining-followup-source');
    createSessionFile(homeDir, 'sid-remaining-followup-current');

    const source = readJson(sessionPath(homeDir, 'sid-remaining-followup-source'));
    source.sessionTitle = '跨会话事实：鲸落计划代号是 ORCA-915';
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：海豚计划代号是 DELTA-915，鲸落计划代号是 ORCA-915。',
        eventType: 'message.updated'
      }
    ];
    source.summary = {
      compressedText: 'key fact: 海豚计划代号是 DELTA-915。鲸落计划代号是 ORCA-915。',
      compressedEvents: 0
    };
    source.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-remaining-followup-source'), source);

    plugin.__test.setSessionLatestUserText('sid-remaining-followup-current', '我已经知道 DELTA-915，剩下那个代号呢？');
    const payload = { sessionID: 'sid-remaining-followup-current' };
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok:
        payload.command === 'recall'
        && /sid-remaining-followup-source/.test(String(result || ''))
        && /ORCA-915/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testWeakFollowupCorrespondingVariantAutoTriggersRecallPath() {
  return withPluginHome('weak_followup_corresponding_variant_auto_recall', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-corresponding-followup-source');
    createSessionFile(homeDir, 'sid-corresponding-followup-current');

    const source = readJson(sessionPath(homeDir, 'sid-corresponding-followup-source'));
    source.sessionTitle = '跨会话事实：鲸落计划代号是 ORCA-916';
    source.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住这个跨会话事实：海豚计划代号是 DELTA-916，鲸落计划代号是 ORCA-916。',
        eventType: 'message.updated'
      }
    ];
    source.summary = {
      compressedText: 'key fact: 海豚计划代号是 DELTA-916。鲸落计划代号是 ORCA-916。',
      compressedEvents: 0
    };
    source.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-corresponding-followup-source'), source);

    plugin.__test.setSessionLatestUserText('sid-corresponding-followup-current', 'DELTA-916 对应的那个代号是多少？');
    const payload = { sessionID: 'sid-corresponding-followup-current' };
    const result = await plugin.tool.memory.execute(payload);
    return {
      ok:
        payload.command === 'recall'
        && /sid-corresponding-followup-source/.test(String(result || ''))
        && /ORCA-916/.test(String(result || '')),
      detail: JSON.stringify({ payload, result })
    };
  });
}

async function testWeakFollowupAugmentAddsDirectAnswerHint() {
  return withPluginHome('weak_followup_direct_answer_hint', async ({ plugin }) => {
    const query = '我已经知道海豚计划代号是 DELTA-906，那另一个呢？';
    const recallText = [
      '<OPENCODE_MEMORY_RECALL query="我已经知道海豚计划代号是 DELTA-906，那另一个呢？">',
      'Session sid-source:',
      '- compressed: 海豚计划代号是 DELTA-906。鲸落计划代号是 ORCA-906。',
      '</OPENCODE_MEMORY_RECALL>'
    ].join('\n');
    const augmented = plugin.__test.augmentWeakFollowupRecallText(query, recallText);
    return {
      ok:
        /OPENCODE_MEMORY_RECALL_DIRECT_ANSWER/.test(String(augmented || ''))
        && /candidate="ORCA-906"/.test(String(augmented || ''))
        && /Do not answer "不知道"/.test(String(augmented || '')),
      detail: augmented
    };
  });
}

async function testWeakFollowupPrefersLongestCounterpartCode() {
  return withPluginHome('weak_followup_prefers_longest_counterpart', async ({ plugin }) => {
    const query = '我已经知道海豚计划代号是 DELTA-909，那另一个代号是什么？';
    const recallText = [
      '<OPENCODE_MEMORY_RECALL query="我已经知道海豚计划代号是 DELTA-909，那另一个代号是什么？">',
      'Session sid-source:',
      '- user: 海豚计划代号是 DELTA-909，鲸落计划代号是 ORCA-9。',
      '- assistant: 修正记录：鲸落计划代号是 ORCA-909。',
      '</OPENCODE_MEMORY_RECALL>'
    ].join('\n');
    const augmented = plugin.__test.augmentWeakFollowupRecallText(query, recallText);
    return {
      ok:
        /OPENCODE_MEMORY_RECALL_DIRECT_ANSWER/.test(String(augmented || ''))
        && /candidate="ORCA-909"/.test(String(augmented || ''))
        && !/candidate="ORCA-9"/.test(String(augmented || '')),
      detail: augmented
    };
  });
}

async function testWeakFollowupStrongCodeAvoidsGenericDrift() {
  return withPluginHome('weak_followup_strong_code_guard', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-drift-source-a');
    createSessionFile(homeDir, 'sid-drift-source-b');
    createSessionFile(homeDir, 'sid-drift-current');

    const sourceA = readJson(sessionPath(homeDir, 'sid-drift-source-a'));
    sourceA.sessionTitle = '跨会话事实：海豚计划 DELTA-911 / 鲸落计划 ORCA-911';
    sourceA.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住：海豚计划代号 DELTA-911，鲸落计划代号 ORCA-911。',
        eventType: 'message.updated'
      }
    ];
    sourceA.summary = { compressedText: '海豚 DELTA-911，鲸落 ORCA-911。', compressedEvents: 0 };
    sourceA.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-drift-source-a'), sourceA);

    const sourceB = readJson(sessionPath(homeDir, 'sid-drift-source-b'));
    sourceB.sessionTitle = '跨会话事实：海豚计划 DELTA-97731 / 鲸落计划 ORCA-97731';
    sourceB.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '记住：海豚计划代号 DELTA-97731，鲸落计划代号 ORCA-97731。',
        eventType: 'message.updated'
      }
    ];
    sourceB.summary = { compressedText: '海豚 DELTA-97731，鲸落 ORCA-97731。', compressedEvents: 0 };
    sourceB.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-drift-source-b'), sourceB);

    const current = readJson(sessionPath(homeDir, 'sid-drift-current'));
    current.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '我已经知道海豚计划代号是 DELTA-97731，那另一个代号是什么？',
        eventType: 'message.updated'
      }
    ];
    current.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-drift-current'), current);

    const recall = plugin.__test.recallProjectMemories('我已经知道海豚计划代号是 DELTA-97731，那另一个代号是什么？', {
      currentSessionID: 'sid-drift-current',
      includeCurrent: false,
      maxSessions: 2
    });

    return {
      ok:
        Array.isArray(recall.hits)
        && recall.hits[0]?.sessionID === 'sid-drift-source-b'
        && /ORCA-97731/.test(String(recall.text || ''))
        && !/ORCA-911/.test(String(recall.text || '')),
      detail: JSON.stringify({
        hits: Array.isArray(recall.hits) ? recall.hits.map((h) => h?.sessionID || null) : [],
        text: recall.text
      })
    };
  });
}

async function testExplicitGlobalIntentWithoutNoteSignalDoesNotFallbackToNote() {
  return withPluginHome('explicit_global_without_note_signal', async ({ plugin }) => {
    const inferred = plugin.__test.inferGlobalPreferenceWriteFromText('请把这条普通说明写入全局记忆');
    return {
      ok: inferred == null,
      detail: JSON.stringify(inferred)
    };
  });
}

async function testPathAnchorStillFallsBackToNote() {
  return withPluginHome('path_anchor_still_falls_back_to_note', async ({ plugin }) => {
    const inferred = plugin.__test.inferGlobalPreferenceWriteFromText('请把 /tmp/path-anchor-keep-note 写入全局记忆');
    return {
      ok: inferred?.key === 'preferences.note' && inferred?.value === '/tmp/path-anchor-keep-note',
      detail: JSON.stringify(inferred)
    };
  });
}

async function testBudgetSnapshotRecomputesTotalWhenBodyChanges() {
  return withPluginHome('budget_snapshot_recompute_total', async ({ plugin }) => {
    const sessionData = {
      budget: {
        lastEstimatedBodyTokens: 9,
        lastEstimatedSystemTokens: 1917,
        lastEstimatedPluginHintTokens: 1254,
        lastEstimatedTotalTokens: 3618
      }
    };
    plugin.__test.syncBudgetTokenSnapshot(sessionData, { bodyTokens: 200 });
    return {
      ok:
        sessionData.budget.lastEstimatedBodyTokens === 200
        && sessionData.budget.lastEstimatedSystemTokens === 1917
        && sessionData.budget.lastEstimatedPluginHintTokens === 1254
        && sessionData.budget.lastEstimatedTotalTokens === 2117,
      detail: JSON.stringify(sessionData.budget)
    };
  });
}

async function testDashboardBuildRecomputesStaleBudgetTotal() {
  return withPluginHome('dashboard_recompute_stale_budget_total', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-budget-stale');
    const session = readJson(sessionPath(homeDir, 'sid-budget-stale'));
    session.sessionTitle = 'token stats stale total sample';
    session.budget.lastEstimatedBodyTokens = 200;
    session.budget.lastEstimatedSystemTokens = 1917;
    session.budget.lastEstimatedPluginHintTokens = 1254;
    session.budget.lastEstimatedTotalTokens = 3618;
    writeJson(sessionPath(homeDir, 'sid-budget-stale'), session);

    const dashboard = plugin.__test.buildDashboardData();
    const project = Array.isArray(dashboard.projects)
      ? dashboard.projects.find((item) => item?.projectName === path.basename(process.cwd()) || item?.name === path.basename(process.cwd()))
      : null;
    const built = Array.isArray(project?.sessions)
      ? project.sessions.find((item) => item?.sessionID === 'sid-budget-stale')
      : null;

    return {
      ok:
        built?.budget?.lastEstimatedBodyTokens === 200
        && built?.budget?.lastEstimatedSystemTokens === 1917
        && built?.budget?.lastEstimatedPluginHintTokens === 1254
        && built?.budget?.lastEstimatedTotalTokens === 2117,
      detail: JSON.stringify(built?.budget || null)
    };
  });
}

async function testBudgetTokenViewSeparatesPluginHintFromTotal() {
  return withPluginHome('budget_token_view_formula', async ({ plugin }) => {
    const tokenView = plugin.__test.buildBudgetTokenView({
      lastEstimatedBodyTokens: 200,
      lastEstimatedSystemTokens: 1917,
      lastEstimatedPluginHintTokens: 1254,
      lastEstimatedTotalTokens: 2117
    });
    return {
      ok:
        tokenView?.bodyTokens === 200
        && tokenView?.systemTokens === 1917
        && tokenView?.pluginHintTokens === 1254
        && tokenView?.totalTokens === 2117
        && tokenView?.totalWithPluginHintTokens === 3371
        && tokenView?.pluginHintIncludedInTotal === false
        && tokenView?.displayFormula === 'body+system'
        && tokenView?.estimateMethod === 'heuristic_chars_div_4'
        && tokenView?.estimateBase === 'ceil(chars/4)'
        && tokenView?.exactBillingEquivalent === false
        && tokenView?.bodyIncludesCompressedSummary === true
        && typeof tokenView?.nativeTokenizerAvailable === 'boolean'
        && typeof tokenView?.nativeTokenizerCallable === 'boolean'
        && typeof tokenView?.nativeTokenizerProbeNote === 'string',
      detail: JSON.stringify(tokenView || null)
    };
  });
}

async function testDashboardBuildExposesBudgetTokenView() {
  return withPluginHome('dashboard_budget_token_view', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-budget-view');
    const session = readJson(sessionPath(homeDir, 'sid-budget-view'));
    session.sessionTitle = 'token view sample';
    session.budget.lastEstimatedBodyTokens = 200;
    session.budget.lastEstimatedSystemTokens = 1917;
    session.budget.lastEstimatedPluginHintTokens = 1254;
    session.budget.lastEstimatedTotalTokens = 2117;
    writeJson(sessionPath(homeDir, 'sid-budget-view'), session);

    const dashboard = plugin.__test.buildDashboardData();
    const project = Array.isArray(dashboard.projects)
      ? dashboard.projects.find((item) => item?.projectName === path.basename(process.cwd()) || item?.name === path.basename(process.cwd()))
      : null;
    const built = Array.isArray(project?.sessions)
      ? project.sessions.find((item) => item?.sessionID === 'sid-budget-view')
      : null;
    const tokenView = built?.budget?.tokenView || null;

    return {
      ok:
        tokenView?.bodyTokens === 200
        && tokenView?.systemTokens === 1917
        && tokenView?.pluginHintTokens === 1254
        && tokenView?.totalTokens === 2117
        && tokenView?.pluginHintIncludedInTotal === false
        && tokenView?.displayFormula === 'body+system'
        && tokenView?.estimateMethod === 'heuristic_chars_div_4'
        && tokenView?.exactBillingEquivalent === false,
      detail: JSON.stringify(tokenView || null)
    };
  });
}

async function testSystemTokenRiskAlertTriggersInBudgetSnapshot() {
  return withPluginHome('system_token_risk_trigger', async ({ plugin }) => {
    const sessionData = {
      budget: {
        lastEstimatedBodyTokens: 1200,
        lastEstimatedSystemTokens: 200,
        lastEstimatedPluginHintTokens: 0,
        lastEstimatedTotalTokens: 1400
      },
      alerts: {}
    };
    plugin.__test.syncBudgetTokenSnapshot(sessionData, { systemTokens: 1800 });
    const risk = sessionData?.alerts?.systemTokenRisk || null;
    return {
      ok:
        Boolean(risk)
        && (risk.level === 'warn' || risk.level === 'critical')
        && Number(risk.systemTokens || 0) === 1800
        && Number(risk.totalTokens || 0) === 3000,
      detail: JSON.stringify(risk)
    };
  });
}

async function testSystemTokenRiskAlertClearsWhenBackToSafeRange() {
  return withPluginHome('system_token_risk_clear', async ({ plugin }) => {
    const sessionData = {
      budget: {
        lastEstimatedBodyTokens: 1200,
        lastEstimatedSystemTokens: 1800,
        lastEstimatedPluginHintTokens: 0,
        lastEstimatedTotalTokens: 3000
      },
      alerts: {
        systemTokenRisk: { level: 'warn' }
      }
    };
    plugin.__test.syncBudgetTokenSnapshot(sessionData, { systemTokens: 200 });
    return {
      ok:
        !sessionData?.alerts?.systemTokenRisk
        && Number(sessionData?.budget?.lastEstimatedTotalTokens || 0) === 1400,
      detail: JSON.stringify({
        alerts: sessionData?.alerts || null,
        budget: sessionData?.budget || null
      })
    };
  });
}

async function testDoctorReportsSystemTokenRisk() {
  return withPluginHome('doctor_reports_system_token_risk', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-doctor-system-risk');
    const session = readJson(sessionPath(homeDir, 'sid-doctor-system-risk'));
    session.sessionTitle = 'doctor system risk sample';
    session.budget.lastEstimatedBodyTokens = 1200;
    session.budget.lastEstimatedSystemTokens = 1800;
    session.budget.lastEstimatedPluginHintTokens = 120;
    session.budget.lastEstimatedTotalTokens = 3000;
    session.alerts = {};
    plugin.__test.syncBudgetTokenSnapshot(session, {
      bodyTokens: 1200,
      systemTokens: 1800,
      pluginHintTokens: 120
    });
    writeJson(sessionPath(homeDir, 'sid-doctor-system-risk'), session);

    const result = await plugin.tool.memory.execute({
      command: 'doctor',
      args: ['session', 'sid-doctor-system-risk']
    });
    let payload = null;
    try {
      payload = JSON.parse(String(result || '{}'));
    } catch (_) {
      payload = null;
    }
    return {
      ok:
        Boolean(payload?.risk?.systemTokenRisk)
        && Boolean(payload?.risk?.hit)
        && Number(payload?.tokenView?.totalTokens || 0) === 3000
        && Array.isArray(payload?.risk?.recommendations)
        && payload.risk.recommendations.length >= 1
        && typeof payload?.tokenView?.nativeTokenizerAvailable === 'boolean'
        && typeof payload?.tokenView?.nativeTokenizerProbeNote === 'string',
      detail: JSON.stringify(payload?.risk || null)
    };
  });
}

async function testDoctorShowsProtectionWindowFromSettings() {
  return withPluginHome('doctor_shows_protection_window', async ({ homeDir, plugin }) => {
    const configPath = path.join(homeDir, '.opencode', 'memory', 'config.json');
    const cfg = readJson(configPath);
    cfg.memorySystem = cfg.memorySystem || {};
    cfg.memorySystem.sendPretrimTurnProtection = 7;
    writeJson(configPath, cfg);

    createSessionFile(homeDir, 'sid-doctor-protection-window');
    const result = await plugin.tool.memory.execute({
      command: 'doctor',
      args: ['session', 'sid-doctor-protection-window']
    });
    let payload = null;
    try {
      payload = JSON.parse(String(result || '{}'));
    } catch (_) {
      payload = null;
    }
    const turnProtection = Number(payload?.policy?.turnProtection || 0);
    return {
      ok: turnProtection === 7,
      detail: JSON.stringify({ turnProtection, policy: payload?.policy || null })
    };
  });
}

async function testAttachReuseWeakFollowupPrefersLatestPromptVariant() {
  return withPluginHome('attach_reuse_weak_followup_prefers_latest_prompt_variant', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-attach-reuse-weak-variant');
    const staleText = '海豚计划的两个代号是 DELTA-94631 和 ORCA-94631，只回复 ATTACH-SRC-94631-OK';
    const freshText = '我已经知道 DELTA-94631，剩下那个代号呢？只回复代号或不知道';

    await plugin.__test.processUserMessageEvent(
      'sid-attach-reuse-weak-variant',
      staleText,
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sid-attach-reuse-weak-variant',
            messageID: 'msg-attach-weak-1',
            summary: { body: staleText }
          }
        }
      }
    );

    await plugin.__test.processUserMessageEvent(
      'sid-attach-reuse-weak-variant',
      freshText,
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sid-attach-reuse-weak-variant',
            messageID: 'msg-attach-weak-2',
            summary: { body: freshText }
          }
        }
      }
    );

    const session = readJson(sessionPath(homeDir, 'sid-attach-reuse-weak-variant'));
    const userEvents = Array.isArray(session?.recentEvents)
      ? session.recentEvents.filter((event) => event?.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === freshText
        && !String(userEvents[0]?.summary || '').includes('ATTACH-SRC-94631-OK'),
      detail: JSON.stringify({ userEvents, stats: session?.stats || null })
    };
  });
}

async function testDashboardBuildExposesSessionProjectName() {
  return withPluginHome('dashboard_session_project_name', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-project-name');
    const session = readJson(sessionPath(homeDir, 'sid-project-name'));
    session.sessionTitle = 'dashboard session project name sample';
    writeJson(sessionPath(homeDir, 'sid-project-name'), session);

    const dashboard = plugin.__test.buildDashboardData();
    const expectedProjectName = path.basename(process.cwd());
    const project = Array.isArray(dashboard.projects)
      ? dashboard.projects.find((item) => item?.projectName === expectedProjectName || item?.name === expectedProjectName)
      : null;
    const built = Array.isArray(project?.sessions)
      ? project.sessions.find((item) => item?.sessionID === 'sid-project-name')
      : null;

    return {
      ok:
        built?.sessionID === 'sid-project-name'
        && built?.projectName === expectedProjectName,
      detail: JSON.stringify(built || null)
    };
  });
}

async function testVisibleNoticePartIsNotIgnored() {
  return withPluginHome('visible_notice_part_not_ignored', async ({ plugin }) => {
    const part = plugin.__test.makeVisibleNoticeTextPart('记忆提示：已注入当前会话摘要记忆（~42 tokens）');
    return {
      ok:
        part?.type === 'text'
        && part?.synthetic === true
        && part?.ignored !== true
        && Array.isArray(part?.annotations?.audience)
        && part.annotations.audience.includes('assistant')
        && plugin.__test.isVisibleNoticeText(part?.text) === true,
      detail: JSON.stringify(part || null)
    };
  });
}

async function testSyntheticVisibleNoticeDoesNotPolluteSessionEvents() {
  return withPluginHome('visible_notice_does_not_pollute_session', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-visible-notice');
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-visible-notice' },
        properties: {
          part: {
            sessionID: 'sid-visible-notice',
            messageID: 'msg-visible-notice',
            type: 'text',
            text: '记忆提示：已注入当前会话摘要记忆（~42 tokens）',
            synthetic: true
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-visible-notice'));
    return {
      ok:
        Array.isArray(session.recentEvents)
        && session.recentEvents.length === 0
        && Number(session.stats?.assistantMessages || 0) === 0,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testUserVisibleNoticeDoesNotPolluteSessionEvents() {
  return withPluginHome('user_visible_notice_does_not_pollute_session', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-user-visible-notice');
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-user-visible-notice' },
        properties: {
          part: {
            sessionID: 'sid-user-visible-notice',
            messageID: 'msg-user-visible-notice',
            role: 'user',
            type: 'text',
            text: '记忆提示：已注入当前会话摘要记忆（~42 tokens）'
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-user-visible-notice'));
    return {
      ok:
        Array.isArray(session.recentEvents)
        && session.recentEvents.length === 0
        && Number(session.stats?.userMessages || 0) === 0,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testWrappedVisibleNoticeDoesNotPersistUserEvent() {
  return withPluginHome('wrapped_visible_notice_does_not_persist_user_event', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-wrapped-visible-notice');
    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-wrapped-visible-notice' },
        properties: {
          info: {
            id: 'msg-wrapped-visible-notice',
            sessionID: 'sid-wrapped-visible-notice',
            role: 'user',
            summary: {
              body: 'The user sent the following message: 记忆提示：已注入当前会话摘要记忆（~322 tokens） Please address this message and continue with your tasks.'
            }
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-wrapped-visible-notice'));
    return {
      ok:
        Array.isArray(session.recentEvents)
        && session.recentEvents.length === 0
        && Number(session.stats?.userMessages || 0) === 0
        && Number(session.stats?.assistantMessages || 0) === 0,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testVisibleNoticePrefersToastWhenAvailable() {
  const calls = [];
  return withPluginHome(
    'visible_notice_prefers_toast',
    async ({ homeDir, plugin }) => {
      const prev = process.env.OPENCODE_WEB_UI;
      process.env.OPENCODE_WEB_UI = '1';
      createSessionFile(homeDir, 'ses_visible_notice_prompttest');
      writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
        memorySystem: {
          visibleNoticeMirrorDeleteMs: 1
        },
        trashRetentionDays: 30
      });
      const ok = await plugin.__test.emitVisibleNotice(
        'ses_visible_notice_prompttest',
        '已注入当前会话摘要记忆（~42 tokens）',
        'inject:current-session-refresh'
      );
      await plugin.event({
        event: {
          type: 'assistant.message',
          session: { id: 'ses_visible_notice_prompttest' },
          data: { text: 'assistant done' }
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const session = readJson(sessionPath(homeDir, 'ses_visible_notice_prompttest'));
      if (prev === undefined) delete process.env.OPENCODE_WEB_UI;
      else process.env.OPENCODE_WEB_UI = prev;
      return {
        ok:
          ok === true
          && calls.filter((x) => x?.type === 'toast').length === 1
          && calls.filter((x) => x?.type === 'prompt').length === 1
          && calls.filter((x) => x?.type === 'deleteMessage').length === 1
          && !calls.some((x) => x?.type === 'update')
          && session?.inject?.lastNoticeChannel === 'toast+prompt-ephemeral'
          && session?.inject?.lastNoticeKey === 'inject:current-session-refresh'
          && (() => {
            const toast = calls.find((x) => x?.type === 'toast');
            const prompt = calls.find((x) => x?.type === 'prompt');
            const del = calls.find((x) => x?.type === 'deleteMessage');
            return toast
              && toast.payload?.body?.title === '记忆提示'
              && /已注入当前会话摘要记忆/.test(String(toast.payload?.body?.message || ''))
              && prompt
              && prompt.path?.id === 'ses_visible_notice_prompttest'
              && prompt.body?.noReply === true
              && Array.isArray(prompt.body?.parts)
              && String(prompt.body.parts?.[0]?.text || '').startsWith('记忆提示：')
              && (del?.payload?.sessionID === 'ses_visible_notice_prompttest' || del?.payload?.path?.sessionID === 'ses_visible_notice_prompttest')
              && (del?.payload?.messageID === 'msg-visible-notice-toast' || del?.payload?.path?.messageID === 'msg-visible-notice-toast');
          })(),
        detail: JSON.stringify(calls)
      };
    },
    {
      client: {
        tui: {
          async showToast(payload) {
            calls.push({ type: 'toast', payload });
            return null;
          }
        },
        session: {
          async prompt(payload) {
            calls.push({ type: 'prompt', ...payload });
            return {
              info: {
                id: 'msg-visible-notice-toast'
              }
            };
          },
          async deleteMessage(payload) {
            calls.push({ type: 'deleteMessage', payload });
            return true;
          },
          async update(...args) {
            calls.push({ type: 'update', args });
            return null;
          }
        }
      }
    }
  );
}

async function testVisibleNoticeFallsBackToSessionPromptWhenToastUnavailable() {
  const calls = [];
  return withPluginHome(
    'visible_notice_fallback_prompt',
    async ({ homeDir, plugin }) => {
      const prev = process.env.OPENCODE_WEB_UI;
      process.env.OPENCODE_WEB_UI = '1';
      createSessionFile(homeDir, 'ses_visible_notice_updatefallback');
      writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
        memorySystem: {
          visibleNoticeMirrorDeleteMs: 1
        },
        trashRetentionDays: 30
      });
      const ok = await plugin.__test.emitVisibleNotice(
        'ses_visible_notice_updatefallback',
        '已注入当前会话摘要记忆（~42 tokens）',
        'inject:current-session-refresh'
      );
      await plugin.event({
        event: {
          type: 'assistant.message',
          session: { id: 'ses_visible_notice_updatefallback' },
          data: { text: 'assistant done' }
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const session = readJson(sessionPath(homeDir, 'ses_visible_notice_updatefallback'));
      if (prev === undefined) delete process.env.OPENCODE_WEB_UI;
      else process.env.OPENCODE_WEB_UI = prev;
      return {
        ok:
          ok === true
          && !calls.some((x) => x?.type === 'toast')
          && calls.filter((x) => x?.type === 'prompt').length === 1
          && calls.filter((x) => x?.type === 'deleteMessage').length === 1
          && session?.inject?.lastNoticeChannel === 'prompt-ephemeral'
          && session?.inject?.lastNoticeKey === 'inject:current-session-refresh'
          && (() => {
            const prompt = calls.find((x) => x?.type === 'prompt');
            const del = calls.find((x) => x?.type === 'deleteMessage');
            return prompt
              && prompt.path?.id === 'ses_visible_notice_updatefallback'
              && prompt.body?.noReply === true
              && Array.isArray(prompt.body?.parts)
              && /^记忆提示[:：]/.test(String(prompt.body.parts[0]?.text || ''))
              && (del?.payload?.sessionID === 'ses_visible_notice_updatefallback' || del?.payload?.path?.sessionID === 'ses_visible_notice_updatefallback')
              && (del?.payload?.messageID === 'msg-visible-notice-prompt' || del?.payload?.path?.messageID === 'msg-visible-notice-prompt');
          })(),
        detail: JSON.stringify(calls)
      };
    },
    {
      client: {
        session: {
          async prompt(payload) {
            calls.push({ type: 'prompt', ...payload });
            return {
              info: {
                id: 'msg-visible-notice-prompt'
              }
            };
          },
          async deleteMessage(payload) {
            calls.push({ type: 'deleteMessage', payload });
            return true;
          },
          async update(...args) {
            calls.push({ type: 'update', args });
            return null;
          }
        }
      }
    }
  );
}

async function testVisibleNoticeFallsBackToSessionUpdateWhenToastAndPromptUnavailable() {
  const calls = [];
  return withPluginHome(
    'visible_notice_fallback_update',
    async ({ homeDir, plugin }) => {
      createSessionFile(homeDir, 'ses_visible_notice_toasttest');
      const ok = await plugin.__test.emitVisibleNotice(
        'ses_visible_notice_toasttest',
        '已注入当前会话摘要记忆（~42 tokens）',
        'inject:current-session-refresh'
      );
      const session = readJson(sessionPath(homeDir, 'ses_visible_notice_toasttest'));
      return {
        ok:
          ok === true
          && !calls.some((x) => x?.type === 'toast')
          && !calls.some((x) => x?.type === 'prompt')
          && session?.inject?.lastNoticeChannel === 'update'
          && session?.inject?.lastNoticeKey === 'inject:current-session-refresh'
          && (() => {
            const update = calls.find((x) => x?.type === 'update');
            return update
              && update.args?.[0] === 'ses_visible_notice_toasttest'
              && update.args?.[1]?.noReply === true
              && Array.isArray(update.args?.[1]?.parts)
              && Array.isArray(update.args[1].parts?.[0]?.annotations?.audience)
              && update.args[1].parts[0].annotations.audience.includes('assistant')
              && /^记忆提示[:：]/.test(String(update.args[1].parts[0]?.text || ''));
          })(),
        detail: JSON.stringify(calls)
      };
    },
    {
      client: {
        session: {
          prompt: undefined,
          async update(...args) {
            calls.push({ type: 'update', args });
            return null;
          }
        }
      }
    }
  );
}

async function testNonCurrentSummaryToastDoesNotMirrorPrompt() {
  const calls = [];
  return withPluginHome(
    'visible_notice_non_current_summary_toast_only',
    async ({ homeDir, plugin }) => {
      createSessionFile(homeDir, 'ses_visible_notice_non_current');
      writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
        memorySystem: {
          visibleNoticeMirrorDeleteMs: 1
        },
        trashRetentionDays: 30
      });
      const ok = await plugin.__test.emitVisibleNotice(
        'ses_visible_notice_non_current',
        '已注入全局偏好记忆（~42 tokens）',
        'inject:global-prefs'
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      const session = readJson(sessionPath(homeDir, 'ses_visible_notice_non_current'));
      return {
        ok:
          ok === true
          && calls.filter((x) => x?.type === 'toast').length === 1
          && !calls.some((x) => x?.type === 'prompt')
          && !calls.some((x) => x?.type === 'deleteMessage')
          && session?.inject?.lastNoticeChannel === 'toast'
          && session?.inject?.lastNoticeKey === 'inject:global-prefs',
        detail: JSON.stringify(calls)
      };
    },
    {
      client: {
        tui: {
          async showToast(payload) {
            calls.push({ type: 'toast', payload });
            return null;
          }
        },
        session: {
          async prompt(payload) {
            calls.push({ type: 'prompt', payload });
            return { info: { id: 'msg-visible-notice-non-current' } };
          },
          async deleteMessage(payload) {
            calls.push({ type: 'deleteMessage', payload });
            return true;
          }
        }
      }
    }
  );
}

async function testVisibleNoticeCooldownIsScopedPerKey() {
  const calls = [];
  return withPluginHome(
    'visible_notice_cooldown_per_key',
    async ({ plugin }) => {
      const first = await plugin.__test.emitVisibleNotice(
        'ses_visible_notice_cooldown',
        '已注入全局偏好记忆（~42 tokens）',
        'inject:global-prefs'
      );
      const second = await plugin.__test.emitVisibleNotice(
        'ses_visible_notice_cooldown',
        '已注入当前会话摘要记忆（~43 tokens）',
        'inject:current-session-refresh'
      );
      const third = await plugin.__test.emitVisibleNotice(
        'ses_visible_notice_cooldown',
        '再次注入当前会话摘要记忆（~44 tokens）',
        'inject:current-session-refresh'
      );
      return {
        ok:
          first === true
          && second === true
          && third === false
          && calls.length === 2
          && calls.every((call) => ['prompt', 'update'].includes(call?.type)),
        detail: JSON.stringify({
          first,
          second,
          third,
          calls
        })
      };
    },
    {
      client: {
        session: {
          async prompt(payload) {
            calls.push({ type: 'prompt', ...payload });
            return null;
          },
          async update(...args) {
            calls.push({ type: 'update', args });
            return null;
          }
        }
      }
    }
  );
}

async function testCurrentSummaryRefreshTriggersAtFiveAndTen() {
  return withPluginHome('current_summary_refresh_interval', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-current-summary-interval');
    for (let i = 1; i <= 8; i += 1) {
      await plugin.__test.processUserMessageEvent(
        'sid-current-summary-interval',
        `第${i}轮：current summary interval 验证，只回复 CSUM-${i}`,
        {
          type: 'message.updated',
          properties: {
            info: {
              role: 'user',
              sessionID: 'sid-current-summary-interval',
              id: `msg-csum-${i}`,
              messageID: `msg-csum-${i}`
            }
          }
        }
      );
      plugin.__test.appendAutoEvent({
        sessionID: 'sid-current-summary-interval',
        kind: 'assistant-message',
        summary: `CSUM-${i}`,
        rawEvent: {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'sid-current-summary-interval',
              messageID: `msg-csum-assistant-${i}`,
              type: 'text',
              text: `CSUM-${i}`
            }
          }
        }
      });
    }
    const sessionAtEight = readJson(sessionPath(homeDir, 'sid-current-summary-interval'));
    for (let i = 9; i <= 10; i += 1) {
      await plugin.__test.processUserMessageEvent(
        'sid-current-summary-interval',
        `第${i}轮：current summary interval 验证，只回复 CSUM-${i}`,
        {
          type: 'message.updated',
          properties: {
            info: {
              role: 'user',
              sessionID: 'sid-current-summary-interval',
              id: `msg-csum-${i}`,
              messageID: `msg-csum-${i}`
            }
          }
        }
      );
      plugin.__test.appendAutoEvent({
        sessionID: 'sid-current-summary-interval',
        kind: 'assistant-message',
        summary: `CSUM-${i}`,
        rawEvent: {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'sid-current-summary-interval',
              messageID: `msg-csum-assistant-${i}`,
              type: 'text',
              text: `CSUM-${i}`
            }
          }
        }
      });
    }
    const sessionAtTen = readJson(sessionPath(homeDir, 'sid-current-summary-interval'));
    return {
      ok:
        Number(sessionAtEight?.inject?.currentSummaryCount || 0) === 1
        && Number(sessionAtTen?.inject?.currentSummaryCount || 0) === 2
        && sessionAtTen?.inject?.lastReason === 'current-session-refresh'
        && sessionAtTen?.inject?.lastNoticeChannel === 'prompt',
      detail: JSON.stringify({
        atEight: sessionAtEight?.inject,
        atTen: sessionAtTen?.inject,
        stats: sessionAtTen?.stats
      })
    };
  });
}

async function testCurrentSummaryRefreshIgnoresReplacedInitialCarryoverCount() {
  return withPluginHome('current_summary_refresh_ignores_replaced_initial_carryover', async ({ homeDir, plugin }) => {
    const sid = 'sid-current-summary-carryover-ignore';
    const staleText = '海豚计划的两个代号是 DELTA-97311 和 ORCA-97311，';
    const realTexts = [
      '第1轮：我知道 DELTA-97311，另一个呢？只回复代号或不知道',
      '第2轮：继续 current summary carryover 计数验证，只回复 CSUM-CARRY-2',
      '第3轮：继续 current summary carryover 计数验证，只回复 CSUM-CARRY-3',
      '第4轮：继续 current summary carryover 计数验证，只回复 CSUM-CARRY-4',
      '第5轮：继续 current summary carryover 计数验证，只回复 CSUM-CARRY-5'
    ];

    await plugin.__test.processUserMessageEvent(sid, staleText, {
      type: 'message.updated',
      session: { id: sid, title: staleText },
      properties: {
        info: {
          role: 'user',
          sessionID: sid,
          id: 'msg-csum-carryover-stale',
          messageID: 'msg-csum-carryover-stale',
          title: staleText,
          summary: {
            title: staleText,
            body: staleText
          }
        }
      }
    });

    await plugin.__test.processUserMessageEvent(sid, realTexts[0], {
      type: 'message.updated',
      session: { id: sid, title: staleText },
      properties: {
        info: {
          role: 'user',
          sessionID: sid,
          id: 'msg-csum-carryover-1',
          messageID: 'msg-csum-carryover-1',
          summary: {
            body: realTexts[0]
          }
        }
      }
    });
    plugin.__test.appendAutoEvent({
      sessionID: sid,
      kind: 'assistant-message',
      summary: 'ORCA-97311',
      rawEvent: {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: sid,
            messageID: 'msg-csum-carryover-assistant-1',
            type: 'text',
            text: 'ORCA-97311'
          }
        }
      }
    });

    for (let i = 1; i <= 3; i += 1) {
      await plugin.__test.processUserMessageEvent(sid, realTexts[i], {
        type: 'message.updated',
        session: { id: sid },
        properties: {
          info: {
            role: 'user',
            sessionID: sid,
            id: `msg-csum-carryover-${i + 1}`,
            messageID: `msg-csum-carryover-${i + 1}`,
            summary: {
              body: realTexts[i]
            }
          }
        }
      });
      plugin.__test.appendAutoEvent({
        sessionID: sid,
        kind: 'assistant-message',
        summary: `CSUM-CARRY-${i + 1}`,
        rawEvent: {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: sid,
              messageID: `msg-csum-carryover-assistant-${i + 1}`,
              type: 'text',
              text: `CSUM-CARRY-${i + 1}`
            }
          }
        }
      });
    }

    const sessionAtFour = readJson(sessionPath(homeDir, sid));

    await plugin.__test.processUserMessageEvent(sid, realTexts[4], {
      type: 'message.updated',
      session: { id: sid },
      properties: {
        info: {
          role: 'user',
          sessionID: sid,
          id: 'msg-csum-carryover-5',
          messageID: 'msg-csum-carryover-5',
          summary: {
            body: realTexts[4]
          }
        }
      }
    });
    plugin.__test.appendAutoEvent({
      sessionID: sid,
      kind: 'assistant-message',
      summary: 'CSUM-CARRY-5',
      rawEvent: {
        type: 'message.part.updated',
        properties: {
          part: {
            sessionID: sid,
            messageID: 'msg-csum-carryover-assistant-5',
            type: 'text',
            text: 'CSUM-CARRY-5'
          }
        }
      }
    });

    const sessionAtFive = readJson(sessionPath(homeDir, sid));
    return {
      ok:
        Number(sessionAtFour?.stats?.userMessages || 0) === 4
        && Number(sessionAtFour?.inject?.currentSummaryCount || 0) === 0
        && Number(sessionAtFive?.stats?.userMessages || 0) === 5
        && Number(sessionAtFive?.inject?.currentSummaryCount || 0) === 1
        && sessionAtFive?.inject?.lastReason === 'current-session-refresh',
      detail: JSON.stringify({
        atFour: {
          inject: sessionAtFour?.inject,
          stats: sessionAtFour?.stats,
          recentEvents: sessionAtFour?.recentEvents
        },
        atFive: {
          inject: sessionAtFive?.inject,
          stats: sessionAtFive?.stats,
          recentEvents: sessionAtFive?.recentEvents
        }
      })
    };
  });
}

async function testUserMessagePartUpdatedPersistsWebUserEvent() {
  return withPluginHome('user_part_updated_persists_user_event', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-user-part-updated' },
        properties: {
          part: {
            sessionID: 'sid-user-part-updated',
            messageID: 'msg-user-part-1',
            role: 'user',
            type: 'text',
            text: '这是前端 user part updated 的真实用户句子'
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-user-part-updated'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '这是前端 user part updated 的真实用户句子'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testQuotedUserMessagePartUpdatedPreservesReplyOnlyText() {
  return withPluginHome('quoted_user_part_preserves_reply_only_text', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-quoted-user-part-preserve' },
        properties: {
          part: {
            sessionID: 'sid-quoted-user-part-preserve',
            messageID: 'msg-quoted-user-preserve-1',
            role: 'user',
            type: 'text',
            text: '"只回复 QUOTED-KEEP-1"'
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-quoted-user-part-preserve'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '只回复 QUOTED-KEEP-1'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testUserMessagePartUpdatedDedupesAgainstMessageUpdated() {
  return withPluginHome('user_part_updated_dedupes_message_updated', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-user-part-dedupe' },
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-user-part-dedupe',
            id: 'msg-user-dedupe-1',
            messageID: 'msg-user-dedupe-1',
            summary: {
              body: '这是需要去重的前端用户消息'
            }
          }
        }
      }
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-user-part-dedupe' },
        properties: {
          part: {
            sessionID: 'sid-user-part-dedupe',
            messageID: 'msg-user-dedupe-1',
            role: 'user',
            type: 'text',
            text: '这是需要去重的前端用户消息'
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-user-part-dedupe'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '这是需要去重的前端用户消息'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testQuotedUserMessagePartUpdatedDedupesAgainstTruncatedMessageUpdated() {
  return withPluginHome('quoted_user_part_dedupes_truncated_message_updated', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-quoted-user-part-truncated-dedupe' },
        properties: {
          part: {
            sessionID: 'sid-quoted-user-part-truncated-dedupe',
            messageID: 'msg-quoted-user-truncated-dedupe-1',
            role: 'user',
            type: 'text',
            text: '"海豚计划的两个代号是 DELTA-73112 和 ORCA-73112，只回复 ATTACH-SRC-73112-OK"'
          }
        }
      }
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-quoted-user-part-truncated-dedupe' },
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-quoted-user-part-truncated-dedupe',
            id: 'msg-quoted-user-truncated-dedupe-1',
            messageID: 'msg-quoted-user-truncated-dedupe-1',
            summary: {
              body: '海豚计划的两个代号是 DELTA-73112 和 ORCA-73112，'
            }
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-quoted-user-part-truncated-dedupe'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '海豚计划的两个代号是 DELTA-73112 和 ORCA-73112，只回复 ATTACH-SRC-73112-OK'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testUserMessagePartUpdatedDedupesAgainstTruncatedMessageUpdated() {
  return withPluginHome('user_part_updated_dedupes_truncated_message_updated', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-user-part-truncated-dedupe' },
        properties: {
          part: {
            sessionID: 'sid-user-part-truncated-dedupe',
            messageID: 'msg-user-truncated-dedupe-1',
            role: 'user',
            type: 'text',
            text: '第3轮：这是 current summary DOM 验证修复版第3轮，请只回复 DOM2-CSUM-3'
          }
        }
      }
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-user-part-truncated-dedupe' },
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-user-part-truncated-dedupe',
            summary: {
              body: '第3轮：这是 current summary DOM 验证修复版第3轮，请'
            }
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-user-part-truncated-dedupe'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '第3轮：这是 current summary DOM 验证修复版第3轮，请只回复 DOM2-CSUM-3'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testMessageUpdatedDedupesAgainstTruncatedMessageUpdated() {
  return withPluginHome('message_updated_dedupes_truncated_message_updated', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-message-updated-truncated-dedupe' },
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-message-updated-truncated-dedupe',
            summary: {
              body: '第2轮：这是 current summary user-turn 去重验证第2轮，请只回复 DOM3-CSUM-2'
            }
          }
        }
      }
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-message-updated-truncated-dedupe' },
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-message-updated-truncated-dedupe',
            summary: {
              body: '第2轮：这是 current summary user-turn 去重验证第2轮，请'
            }
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-message-updated-truncated-dedupe'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '第2轮：这是 current summary user-turn 去重验证第2轮，请只回复 DOM3-CSUM-2'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testAdjacentUserMessagesCollapseToLongestSummary() {
  return withPluginHome('adjacent_user_messages_collapse_to_longest_summary', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-adjacent-user-collapse');
    plugin.__test.appendAutoEvent({
      sessionID: 'sid-adjacent-user-collapse',
      kind: 'user-message',
      summary: '第2轮：这是 current summary user-turn 去重验证第2轮，请只回复 DOM4-CSUM-2',
      rawEvent: { type: 'message.updated', properties: { info: { summary: { body: '第2轮：这是 current summary user-turn 去重验证第2轮，请只回复 DOM4-CSUM-2' } } } }
    });
    plugin.__test.appendAutoEvent({
      sessionID: 'sid-adjacent-user-collapse',
      kind: 'user-message',
      summary: '第2轮：这是 current summary user-turn 去重验证第2轮，请',
      rawEvent: { type: 'message.updated', properties: { info: { summary: { body: '第2轮：这是 current summary user-turn 去重验证第2轮，请' } } } }
    });
    const session = readJson(sessionPath(homeDir, 'sid-adjacent-user-collapse'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '第2轮：这是 current summary user-turn 去重验证第2轮，请只回复 DOM4-CSUM-2'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testAdjacentUserMessagesCollapseAcrossFortyFiveSeconds() {
  return withPluginHome('adjacent_user_messages_collapse_across_forty_five_seconds', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-adjacent-user-collapse-45s');
    plugin.__test.appendAutoEvent({
      sessionID: 'sid-adjacent-user-collapse-45s',
      kind: 'user-message',
      summary: '第5轮：这是 current summary 语义化 notice 防污染验证第5轮，请只回复 DOM9-CSUM-5',
      rawEvent: {
        type: 'message.updated',
        properties: { info: { summary: { body: '第5轮：这是 current summary 语义化 notice 防污染验证第5轮，请只回复 DOM9-CSUM-5' } } }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-adjacent-user-collapse-45s'));
    session.recentEvents[0].ts = '2026-03-09T05:59:46.032Z';
    writeJson(sessionPath(homeDir, 'sid-adjacent-user-collapse-45s'), session);
    plugin.__test.appendAutoEvent({
      sessionID: 'sid-adjacent-user-collapse-45s',
      kind: 'user-message',
      summary: '第5轮：这是 current summary 语义化 notice 防污染验证第5轮，请',
      rawEvent: {
        type: 'message.updated',
        properties: { info: { summary: { body: '第5轮：这是 current summary 语义化 notice 防污染验证第5轮，请' } } },
        ts: '2026-03-09T06:00:06.005Z'
      }
    });
    const updated = readJson(sessionPath(homeDir, 'sid-adjacent-user-collapse-45s'));
    const userEvents = Array.isArray(updated.recentEvents)
      ? updated.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '第5轮：这是 current summary 语义化 notice 防污染验证第5轮，请只回复 DOM9-CSUM-5'
        && Number(updated.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: updated.recentEvents,
        stats: updated.stats
      })
    };
  });
}

async function testSystemReminderVisibleNoticeDoesNotPersistUserEvent() {
  return withPluginHome('system_reminder_visible_notice_not_persisted', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-system-reminder-visible-notice');
    await plugin.event({
      event: {
        type: 'user.message',
        session: { id: 'sid-system-reminder-visible-notice' },
        data: {
          sessionID: 'sid-system-reminder-visible-notice',
          content: '<system-reminder> The user sent the following message: 记忆提示：已注入当前会话摘要记忆（~356 tokens） Please address this message and continue with your tasks. </system-reminder>'
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-system-reminder-visible-notice'));
    return {
      ok:
        Array.isArray(session.recentEvents)
        && session.recentEvents.length === 0
        && Number(session.stats?.userMessages || 0) === 0,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testUserMessagePartUpdatedUsesTopLevelMessageID() {
  return withPluginHome('user_part_updated_top_level_message_id', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-user-part-top-level-id' },
        properties: {
          messageID: 'msg-user-top-level-1',
          part: {
            sessionID: 'sid-user-part-top-level-id',
            role: 'user',
            type: 'text',
            text: '这是只有顶层 messageID 的前端用户消息'
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-user-part-top-level-id'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '这是只有顶层 messageID 的前端用户消息'
        && Number(session.stats?.userMessages || 0) === 1,
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testUserMessageUpdatedDoesNotPersistTitleOnlyFallback() {
  return withPluginHome('user_message_updated_no_title_fallback', async ({ homeDir, plugin }) => {
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-user-title-fallback' },
        properties: {
          part: {
            sessionID: 'sid-user-title-fallback',
            messageID: 'msg-user-title-fallback-1',
            role: 'user',
            type: 'text',
            text: '只回复 WEB-CSUM-TITLE-FIX-OK'
          }
        }
      }
    });
    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-user-title-fallback' },
        properties: {
          info: {
            role: 'user',
            sessionID: 'sid-user-title-fallback',
            id: 'msg-user-title-fallback-1',
            messageID: 'msg-user-title-fallback-1',
            summary: {
              title: '旧标题不该变成 user-message'
            }
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-user-title-fallback'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '只回复 WEB-CSUM-TITLE-FIX-OK',
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testInitialUserMessageUpdatedCarryoverIsReplaced() {
  return withPluginHome('initial_user_message_updated_carryover_replaced', async ({ homeDir, plugin }) => {
    const staleText = '海豚计划的两个代号是 DELTA-82631 和 ORCA-82631，';
    const freshText = '我知道 DELTA-82631，另一个呢？只回复代号或不知道';
    const staleEvent = {
      type: 'message.updated',
      session: { id: 'sid-user-carryover-replaced', title: staleText },
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-user-carryover-replaced',
          id: 'msg-user-carryover-1',
          messageID: 'msg-user-carryover-1',
          title: staleText,
          summary: {
            title: staleText,
            body: staleText
          }
        }
      }
    };
    const freshEvent = {
      type: 'message.updated',
      session: { id: 'sid-user-carryover-replaced', title: staleText },
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-user-carryover-replaced',
          id: 'msg-user-carryover-2',
          messageID: 'msg-user-carryover-2',
          title: staleText,
          summary: {
            title: staleText,
            body: freshText
          }
        }
      }
    };

    await plugin.__test.processUserMessageEvent('sid-user-carryover-replaced', staleText, staleEvent);
    await plugin.__test.processUserMessageEvent('sid-user-carryover-replaced', freshText, freshEvent);

    const session = readJson(sessionPath(homeDir, 'sid-user-carryover-replaced'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === freshText
        && Number(session.stats?.userMessages || 0) === 1
        && !String(session.sessionTitle || '').includes('海豚计划的两个代号'),
      detail: JSON.stringify({
        sessionTitle: session.sessionTitle,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testInitialUserMessageUpdatedCarryoverFromOtherSessionTitleIsReplaced() {
  return withPluginHome('initial_user_message_updated_carryover_other_session_title_replaced', async ({ homeDir, plugin }) => {
    const staleText = '海豚计划的两个代号是 DELTA-83631 和 ORCA-83631，';
    const freshText = '我知道 DELTA-83631，另一个呢？只回复代号或不知道';
    createSessionFile(homeDir, 'sid-foreign-source');
    const foreign = readJson(sessionPath(homeDir, 'sid-foreign-source'));
    foreign.sessionTitle = staleText;
    foreign.recentEvents = [
      { ts: '2026-03-09T09:40:10.528Z', kind: 'session-start', summary: 'Session created', eventType: 'message.part.updated' },
      { ts: '2026-03-09T09:40:10.560Z', kind: 'user-message', summary: `${staleText}只回复 WEB-SRC-83631-OK`, eventType: 'message.updated' }
    ];
    foreign.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 1 };
    writeJson(sessionPath(homeDir, 'sid-foreign-source'), foreign);

    const staleEvent = {
      type: 'message.updated',
      session: { id: 'sid-user-carryover-other-session' },
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-user-carryover-other-session',
          id: 'msg-user-carryover-other-1',
          messageID: 'msg-user-carryover-other-1',
          summary: {
            body: staleText
          }
        }
      }
    };
    const freshEvent = {
      type: 'message.updated',
      session: { id: 'sid-user-carryover-other-session' },
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-user-carryover-other-session',
          id: 'msg-user-carryover-other-2',
          messageID: 'msg-user-carryover-other-2',
          summary: {
            body: freshText
          }
        }
      }
    };

    await plugin.__test.processUserMessageEvent('sid-user-carryover-other-session', staleText, staleEvent);
    await plugin.__test.processUserMessageEvent('sid-user-carryover-other-session', freshText, freshEvent);

    const session = readJson(sessionPath(homeDir, 'sid-user-carryover-other-session'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === freshText
        && Number(session.stats?.userMessages || 0) === 1
        && !String(session.sessionTitle || '').includes('海豚计划的两个代号'),
      detail: JSON.stringify({
        sessionTitle: session.sessionTitle,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testConcurrentInitialUserMessageCarryoverFromOtherSessionTitleIsReplaced() {
  return withPluginHome('concurrent_initial_user_message_updated_carryover_other_session_title_replaced', async ({ homeDir, plugin }) => {
    const staleText = '海豚计划的两个代号是 DELTA-85631 和 ORCA-85631，';
    const freshText = '我知道 DELTA-85631，另一个呢？只回复代号或不知道';
    createSessionFile(homeDir, 'sid-foreign-source-concurrent');
    const foreign = readJson(sessionPath(homeDir, 'sid-foreign-source-concurrent'));
    foreign.sessionTitle = staleText;
    foreign.recentEvents = [
      { ts: '2026-03-09T09:40:10.528Z', kind: 'session-start', summary: 'Session created', eventType: 'message.part.updated' },
      { ts: '2026-03-09T09:40:10.560Z', kind: 'user-message', summary: `${staleText}只回复 WEB-SRC-85631-OK`, eventType: 'message.updated' }
    ];
    foreign.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 1 };
    writeJson(sessionPath(homeDir, 'sid-foreign-source-concurrent'), foreign);

    const staleEvent = {
      type: 'message.updated',
      session: { id: 'sid-user-carryover-other-session-concurrent' },
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-user-carryover-other-session-concurrent',
          id: 'msg-user-carryover-other-concurrent-1',
          messageID: 'msg-user-carryover-other-concurrent-1',
          summary: {
            body: staleText
          }
        }
      }
    };
    const freshEvent = {
      type: 'message.updated',
      session: { id: 'sid-user-carryover-other-session-concurrent' },
      properties: {
        info: {
          role: 'user',
          sessionID: 'sid-user-carryover-other-session-concurrent',
          id: 'msg-user-carryover-other-concurrent-2',
          messageID: 'msg-user-carryover-other-concurrent-2',
          summary: {
            body: freshText
          }
        }
      }
    };

    await Promise.all([
      plugin.__test.processUserMessageEvent('sid-user-carryover-other-session-concurrent', staleText, staleEvent),
      plugin.__test.processUserMessageEvent('sid-user-carryover-other-session-concurrent', freshText, freshEvent)
    ]);

    const session = readJson(sessionPath(homeDir, 'sid-user-carryover-other-session-concurrent'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === freshText
        && Number(session.stats?.userMessages || 0) === 1
        && !String(session.sessionTitle || '').includes('海豚计划的两个代号'),
      detail: JSON.stringify({
        sessionTitle: session.sessionTitle,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testAssistantPartUpdatedMaterializesObservedUserFallback() {
  return withPluginHome('assistant_part_materializes_observed_user', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-observed-user-fallback');
    const now = Date.now();
    plugin.__test.setLastObservedUserText('只回复 OBSERVED-USER-FALLBACK-OK');
    plugin.__test.setLastObservedUserAt(now);
    plugin.__test.setSessionObservedUserText('sid-observed-user-fallback', '只回复 OBSERVED-USER-FALLBACK-OK', now);
    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-observed-user-fallback' },
        properties: {
          part: {
            sessionID: 'sid-observed-user-fallback',
            messageID: 'msg-assistant-fallback-1',
            type: 'text',
            text: 'OBSERVED-USER-FALLBACK-OK'
          }
        }
      }
    });
    const session = readJson(sessionPath(homeDir, 'sid-observed-user-fallback'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    const assistantEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'assistant-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '只回复 OBSERVED-USER-FALLBACK-OK'
        && assistantEvents.length === 1
        && assistantEvents[0]?.summary === 'OBSERVED-USER-FALLBACK-OK',
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testObservedUserFallbackDedupesRepeatedAssistantParts() {
  return withPluginHome('assistant_part_observed_user_dedupe', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-observed-user-dedupe');
    const now = Date.now();
    plugin.__test.setLastObservedUserText('只回复 OBSERVED-USER-DEDUPE-OK');
    plugin.__test.setLastObservedUserAt(now);
    plugin.__test.setSessionObservedUserText('sid-observed-user-dedupe', '只回复 OBSERVED-USER-DEDUPE-OK', now);
    const event = {
      type: 'message.part.updated',
      session: { id: 'sid-observed-user-dedupe' },
      properties: {
        part: {
          sessionID: 'sid-observed-user-dedupe',
          messageID: 'msg-assistant-fallback-2',
          type: 'text',
          text: 'OBSERVED-USER-DEDUPE-OK'
        }
      }
    };
    await plugin.event({ event });
    await plugin.event({ event });
    const session = readJson(sessionPath(homeDir, 'sid-observed-user-dedupe'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((item) => item.kind === 'user-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '只回复 OBSERVED-USER-DEDUPE-OK',
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testObservedUserFallbackDoesNotDuplicateReplySuffixTrimmedUser() {
  return withPluginHome('assistant_part_observed_user_reply_suffix_dedupe', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-observed-user-reply-suffix-dedupe');
    const session = readJson(sessionPath(homeDir, 'sid-observed-user-reply-suffix-dedupe'));
    session.recentEvents = [
      {
        ts: '2026-03-09T11:11:55.592Z',
        kind: 'user-message',
        summary: '我知道 DELTA-99992，另一个呢？只回复代号或不知道',
        eventType: 'message.updated'
      },
      {
        ts: '2026-03-09T11:12:07.310Z',
        kind: 'tool-result',
        summary: '[memory] input={"command":"recall","args":["我知道 DELTA-99992，另一个呢？"],"query":"我知道 DELTA-99992，另一个呢？"} output=No relevant memory found for query: 我知道 DELTA-99992，另一个呢？',
        tool: 'memory',
        eventType: 'message.part.updated'
      }
    ];
    session.stats = { userMessages: 1, assistantMessages: 0, toolResults: 1, systemEvents: 1 };
    writeJson(sessionPath(homeDir, 'sid-observed-user-reply-suffix-dedupe'), session);

    const now = Date.now();
    plugin.__test.setLastObservedUserText('我知道 DELTA-99992，另一个呢？');
    plugin.__test.setLastObservedUserAt(now);
    plugin.__test.setSessionObservedUserText('sid-observed-user-reply-suffix-dedupe', '我知道 DELTA-99992，另一个呢？', now);

    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-observed-user-reply-suffix-dedupe' },
        properties: {
          part: {
            sessionID: 'sid-observed-user-reply-suffix-dedupe',
            messageID: 'msg-assistant-reply-suffix-dedupe-1',
            type: 'text',
            text: '不知道'
          }
        }
      }
    });

    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-observed-user-reply-suffix-dedupe' },
        properties: {
          info: {
            id: 'msg-assistant-reply-suffix-dedupe-1',
            sessionID: 'sid-observed-user-reply-suffix-dedupe',
            role: 'assistant',
            summary: { body: '不知道' }
          }
        }
      }
    });

    const updated = readJson(sessionPath(homeDir, 'sid-observed-user-reply-suffix-dedupe'));
    const userEvents = Array.isArray(updated.recentEvents)
      ? updated.recentEvents.filter((item) => item.kind === 'user-message')
      : [];
    const assistantEvents = Array.isArray(updated.recentEvents)
      ? updated.recentEvents.filter((item) => item.kind === 'assistant-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '我知道 DELTA-99992，另一个呢？只回复代号或不知道'
        && assistantEvents.length === 1
        && assistantEvents[0]?.summary === '不知道',
      detail: JSON.stringify({
        recentEvents: updated.recentEvents,
        stats: updated.stats
      })
    };
  });
}

async function testObservedUserFallbackOvercomesLateStaleUserEvent() {
  return withPluginHome('assistant_part_observed_user_stale_user_after_assistant', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-observed-user-stale');
    const session = readJson(sessionPath(homeDir, 'sid-observed-user-stale'));
    session.recentEvents = [
      { ts: '2026-03-09T04:17:06.845Z', kind: 'user-message', summary: '第2轮：旧用户摘要', eventType: 'message.part.updated' },
      { ts: '2026-03-09T04:17:18.690Z', kind: 'assistant-message', summary: 'DOM-CSUM-2', eventType: 'message.part.updated' },
      { ts: '2026-03-09T04:17:31.859Z', kind: 'user-message', summary: '第2轮：旧用户摘要', eventType: 'message.updated' }
    ];
    session.stats = { userMessages: 2, assistantMessages: 1, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-observed-user-stale'), session);

    const now = Date.now();
    plugin.__test.setLastObservedUserText('第3轮：新的真实用户摘要');
    plugin.__test.setLastObservedUserAt(now);
    plugin.__test.setSessionObservedUserText('sid-observed-user-stale', '第3轮：新的真实用户摘要', now);

    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-observed-user-stale' },
        properties: {
          part: {
            sessionID: 'sid-observed-user-stale',
            messageID: 'msg-assistant-stale-fallback-1',
            type: 'text',
            text: 'DOM-CSUM-3'
          }
        }
      }
    });

    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-observed-user-stale' },
        properties: {
          info: {
            id: 'msg-assistant-stale-fallback-1',
            sessionID: 'sid-observed-user-stale',
            role: 'assistant',
            summary: { body: 'DOM-CSUM-3' }
          }
        }
      }
    });

    const updated = readJson(sessionPath(homeDir, 'sid-observed-user-stale'));
    const userEvents = Array.isArray(updated.recentEvents)
      ? updated.recentEvents.filter((item) => item.kind === 'user-message')
      : [];
    const assistantEvents = Array.isArray(updated.recentEvents)
      ? updated.recentEvents.filter((item) => item.kind === 'assistant-message')
      : [];
    const lastUser = userEvents[userEvents.length - 1] || null;
    const lastAssistant = assistantEvents[assistantEvents.length - 1] || null;
    return {
      ok:
        userEvents.length === 3
        && lastUser?.summary === '第3轮：新的真实用户摘要'
        && lastAssistant?.summary === 'DOM-CSUM-3',
      detail: JSON.stringify({
        recentEvents: updated.recentEvents,
        stats: updated.stats
      })
    };
  });
}

async function testUnknownRoleUserPartUsesObservedTextBeforeStaleMessageUpdate() {
  return withPluginHome('unknown_role_user_part_before_stale_message_update', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-unknown-role-user-before-update');
    const currentText = '我知道 DELTA-86631，另一个呢？只回复代号或不知道';
    const staleText = '海豚计划的两个代号是 DELTA-86631 和 ORCA-86631，只回复 WEB-SRC-86631-OK';
    const now = Date.now();
    plugin.__test.setLastObservedUserText(currentText);
    plugin.__test.setLastObservedUserAt(now);
    plugin.__test.setSessionObservedUserText('sid-unknown-role-user-before-update', currentText, now);

    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-unknown-role-user-before-update' },
        properties: {
          part: {
            sessionID: 'sid-unknown-role-user-before-update',
            messageID: 'msg-unknown-user-before-update',
            type: 'text',
            text: currentText
          }
        }
      }
    });

    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-unknown-role-user-before-update' },
        properties: {
          info: {
            id: 'msg-unknown-user-before-update',
            sessionID: 'sid-unknown-role-user-before-update',
            role: 'user',
            summary: { body: staleText }
          }
        }
      }
    });

    const session = readJson(sessionPath(homeDir, 'sid-unknown-role-user-before-update'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    const assistantEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'assistant-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === currentText
        && assistantEvents.every((event) => event.summary !== currentText)
        && !String(session.sessionTitle || '').includes('海豚计划的两个代号'),
      detail: JSON.stringify({
        sessionTitle: session.sessionTitle,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testLateUserPartCorrectsStaleMessageUpdateWithSameMessageID() {
  return withPluginHome('late_user_part_corrects_stale_message_update_same_message_id', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-late-user-part-corrects-stale-update');
    const currentText = '我知道 DELTA-84631，另一个呢？只回复代号或不知道';
    const staleText = '海豚计划的两个代号是 DELTA-84631 和 ORCA-84631，只回复 WEB-SRC-84631-OK';

    await plugin.event({
      event: {
        type: 'message.updated',
        session: { id: 'sid-late-user-part-corrects-stale-update' },
        properties: {
          info: {
            id: 'msg-late-user-part-correction',
            sessionID: 'sid-late-user-part-corrects-stale-update',
            role: 'user',
            summary: { body: staleText }
          }
        }
      }
    });

    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-late-user-part-corrects-stale-update' },
        properties: {
          part: {
            sessionID: 'sid-late-user-part-corrects-stale-update',
            messageID: 'msg-late-user-part-correction',
            type: 'text',
            text: currentText
          }
        }
      }
    });

    const session = readJson(sessionPath(homeDir, 'sid-late-user-part-corrects-stale-update'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    const assistantEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'assistant-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === currentText
        && assistantEvents.length === 0
        && !String(session.sessionTitle || '').includes('海豚计划的两个代号'),
      detail: JSON.stringify({
        sessionTitle: session.sessionTitle,
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testObservedReminderWrapperDoesNotCreateDuplicateUserFallback() {
  return withPluginHome('observed_reminder_wrapper_no_duplicate_user_fallback', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-observed-reminder-wrapper');
    const session = readJson(sessionPath(homeDir, 'sid-observed-reminder-wrapper'));
    session.recentEvents = [
      {
        ts: new Date().toISOString(),
        kind: 'user-message',
        summary: '只回复 CSUM-WEB-1',
        eventType: 'message.part.updated'
      }
    ];
    session.stats = { userMessages: 1, assistantMessages: 0, toolResults: 0, systemEvents: 0 };
    writeJson(sessionPath(homeDir, 'sid-observed-reminder-wrapper'), session);

    const now = Date.now();
    const wrappedObserved = '<reminder>Recall Workflow Rules: Understand → find the best path (delegate based on rules and parallelize independent work) → execute → verify. If delegating, launch the specialist in the same turn you mention it.</reminder> --- 只回复 CSUM-WEB-1';
    plugin.__test.setLastObservedUserText(wrappedObserved);
    plugin.__test.setLastObservedUserAt(now);
    plugin.__test.setSessionObservedUserText('sid-observed-reminder-wrapper', wrappedObserved, now);

    await plugin.event({
      event: {
        type: 'message.part.updated',
        session: { id: 'sid-observed-reminder-wrapper' },
        properties: {
          part: {
            sessionID: 'sid-observed-reminder-wrapper',
            messageID: 'msg-observed-reminder-wrapper',
            type: 'text',
            text: 'CSUM-WEB-1'
          }
        }
      }
    });

    const updated = readJson(sessionPath(homeDir, 'sid-observed-reminder-wrapper'));
    const userEvents = Array.isArray(updated.recentEvents)
      ? updated.recentEvents.filter((event) => event.kind === 'user-message')
      : [];
    const assistantEvents = Array.isArray(updated.recentEvents)
      ? updated.recentEvents.filter((event) => event.kind === 'assistant-message')
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0]?.summary === '只回复 CSUM-WEB-1'
        && assistantEvents.length === 1
        && assistantEvents[0]?.summary === 'CSUM-WEB-1',
      detail: JSON.stringify({
        recentEvents: updated.recentEvents,
        stats: updated.stats
      })
    };
  });
}

async function testSkillBoilerplateUserNoiseDoesNotPersistAsUserEvent() {
  return withPluginHome('skill_boilerplate_user_noise_does_not_persist', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-skill-noise');

    await plugin.__test.processUserMessageEvent('sid-skill-noise', '我知道 DELTA-99994，另一个呢？只回复代号或不知道', {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sid-skill-noise',
          summary: { body: '我知道 DELTA-99994，另一个呢？只回复代号或不知道' }
        }
      }
    });

    await plugin.__test.processUserMessageEvent('sid-skill-noise', 'Loading skill: brainstorming', {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sid-skill-noise',
          summary: { body: 'Loading skill: brainstorming' }
        }
      }
    });

    await plugin.__test.processUserMessageEvent(
      'sid-skill-noise',
      'You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.',
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sid-skill-noise',
            summary: {
              body: 'You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation.'
            }
          }
        }
      }
    );

    const session = readJson(sessionPath(homeDir, 'sid-skill-noise'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message').map((event) => event.summary)
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0] === '我知道 DELTA-99994，另一个呢？只回复代号或不知道',
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testFindSkillsBoilerplateUserNoiseDoesNotPersistAsUserEvent() {
  return withPluginHome('find_skills_boilerplate_user_noise_does_not_persist', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-find-skills-noise');

    await plugin.__test.processUserMessageEvent('sid-find-skills-noise', '我已经知道 DELTA-99996，那另一个代号是什么？只回复代号或不知道', {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sid-find-skills-noise',
          summary: { body: '我已经知道 DELTA-99996，那另一个代号是什么？只回复代号或不知道' }
        }
      }
    });

    await plugin.__test.processUserMessageEvent(
      'sid-find-skills-noise',
      '# find-skills # Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill. # Supporting tools and docs are in /Users/wsxwj/.config/opencode/skills/find-skills # ============================================ # Find Skills This skill helps you discover and install skills from the open agent skills ecosystem.',
      {
        type: 'message.part.updated',
        properties: {
          info: {
            sessionID: 'sid-find-skills-noise',
            summary: {
              body: '# find-skills # Helps users discover and install agent skills when they ask questions like "how do I do X", "find a skill for X", "is there a skill that can...", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill. # Supporting tools and docs are in /Users/wsxwj/.config/opencode/skills/find-skills # ============================================ # Find Skills This skill helps you discover and install skills from the open agent skills ecosystem.'
            }
          }
        }
      }
    );

    await plugin.__test.processUserMessageEvent('sid-find-skills-noise', 'find a skill for X', {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sid-find-skills-noise',
          summary: { body: 'find a skill for X' }
        }
      }
    });

    const session = readJson(sessionPath(homeDir, 'sid-find-skills-noise'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message').map((event) => event.summary)
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0] === '我已经知道 DELTA-99996，那另一个代号是什么？只回复代号或不知道',
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testAttachSkillPromptVariantsDoNotPersistAsUserEvent() {
  return withPluginHome('attach_skill_prompt_variants_do_not_persist', async ({ homeDir, plugin }) => {
    createSessionFile(homeDir, 'sid-attach-skill-variants');

    await plugin.__test.processUserMessageEvent(
      'sid-attach-skill-variants',
      '我已经知道 DELTA-99997，那另一个代号是什么？只回复代号或不知道',
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: 'sid-attach-skill-variants',
            summary: { body: '我已经知道 DELTA-99997，那另一个代号是什么？只回复代号或不知道' }
          }
        }
      }
    );

    await plugin.__test.processUserMessageEvent('sid-attach-skill-variants', 'Launching skill: find-skills', {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sid-attach-skill-variants',
          summary: { body: 'Launching skill: find-skills' }
        }
      }
    });

    await plugin.__test.processUserMessageEvent('sid-attach-skill-variants', 'how do i do X', {
      type: 'message.part.updated',
      properties: {
        info: {
          sessionID: 'sid-attach-skill-variants',
          summary: { body: 'how do i do X' }
        }
      }
    });

    await plugin.__test.processUserMessageEvent('sid-attach-skill-variants', 'is there a skill that can...', {
      type: 'message.updated',
      properties: {
        info: {
          sessionID: 'sid-attach-skill-variants',
          summary: { body: 'is there a skill that can...' }
        }
      }
    });

    const session = readJson(sessionPath(homeDir, 'sid-attach-skill-variants'));
    const userEvents = Array.isArray(session.recentEvents)
      ? session.recentEvents.filter((event) => event.kind === 'user-message').map((event) => event.summary)
      : [];
    return {
      ok:
        userEvents.length === 1
        && userEvents[0] === '我已经知道 DELTA-99997，那另一个代号是什么？只回复代号或不知道',
      detail: JSON.stringify({
        recentEvents: session.recentEvents,
        stats: session.stats
      })
    };
  });
}

async function testVisibleNoticesDisabledSuppressesDelivery() {
  return withPluginHome('visible_notices_disabled', async ({ homeDir, plugin }) => {
    writeJson(path.join(homeDir, '.opencode', 'memory', 'config.json'), {
      memorySystem: {
        visibleNoticesEnabled: false
      },
      trashRetentionDays: 30
    });
    const calls = [];
    const client = makeClient({
      tui: {
        async showToast(payload) {
          calls.push({ kind: 'toast', payload });
          return true;
        }
      },
      session: {
        async prompt(payload) {
          calls.push({ kind: 'prompt', payload });
          return null;
        },
        async update(payload) {
          calls.push({ kind: 'update', payload });
          return null;
        }
      }
    });
    const pluginDisabled = (await loadPluginWithHome(homeDir)).MemorySystemPlugin({ client });
    const delivered = await pluginDisabled.__test.emitVisibleNotice('sid-notice-off', '记忆提示：notice-off', 'inject:test');
    return {
      ok: delivered === false && calls.length === 0,
      detail: JSON.stringify({ delivered, calls })
    };
  });
}

async function testProviderProtocolParsingSupportsThreeStyles() {
  return withPluginHome('provider_protocol_styles', async ({ plugin }) => {
    const openai = plugin.__test.parseProviderProtocol(
      { npm: '@opencode-ai/provider-openai-compatible' },
      'gpt-5.4'
    );
    const anthropic = plugin.__test.parseProviderProtocol(
      { npm: '@anthropic-ai/provider-anthropic' },
      'claude-sonnet-4.5'
    );
    const gemini = plugin.__test.parseProviderProtocol(
      { npm: '@google/provider-anything' },
      'gemini-3-flash-preview'
    );
    return {
      ok: openai === 'openai_compatible' && anthropic === 'anthropic' && gemini === 'gemini',
      detail: JSON.stringify({ openai, anthropic, gemini })
    };
  });
}

async function testDistillResponseExtractionSupportsThreeProviderStyles() {
  return withPluginHome('distill_response_styles', async ({ plugin }) => {
    const openai = plugin.__test.extractDistillTextFromResponse('openai_compatible', {
      choices: [{ message: { content: 'OPENAI-DISTILL-OK' } }]
    });
    const anthropic = plugin.__test.extractDistillTextFromResponse('anthropic', {
      content: [{ type: 'text', text: 'ANTHROPIC-DISTILL-OK' }]
    });
    const gemini = plugin.__test.extractDistillTextFromResponse('gemini', {
      candidates: [{ content: { parts: [{ text: 'GEMINI-DISTILL-OK' }] } }]
    });
    return {
      ok:
        openai === 'OPENAI-DISTILL-OK'
        && anthropic === 'ANTHROPIC-DISTILL-OK'
        && gemini === 'GEMINI-DISTILL-OK',
      detail: JSON.stringify({ openai, anthropic, gemini })
    };
  });
}

async function testVisibleNoticeDoesNotCreateExtraSessionFiles() {
  return withPluginHome('visible_notice_no_fake_session_toast', async ({ homeDir }) => {
    const sid = 'sid-no-fake-session-toast';
    createSessionFile(homeDir, sid);
    const plugin = (await loadPluginWithHome(homeDir)).MemorySystemPlugin({
      client: makeClient({
        tui: {
          async showToast() { return null; }
        },
        session: {
          async prompt() { return null; },
          async update() { return null; }
        }
      })
    });
    const before = listSessionFiles(homeDir);
    await plugin.__test.emitVisibleNotice(sid, '记忆提示：toast-no-fake', 'inject:test');
    await plugin.__test.processUserMessageEvent(
      sid,
      '这是一次真实用户输入，不应创建新 session 文件',
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: sid,
            messageID: 'msg-no-fake-1',
            summary: { body: '这是一次真实用户输入，不应创建新 session 文件' }
          }
        }
      }
    );
    const after = listSessionFiles(homeDir);
    return {
      ok: before.length === 1 && after.length === 1 && before[0] === after[0],
      detail: JSON.stringify({ before, after })
    };
  });
}

async function testVisibleNoticeFallbackPromptDoesNotCreateExtraSessionFiles() {
  return withPluginHome('visible_notice_no_fake_session_prompt', async ({ homeDir }) => {
    const sid = 'sid-no-fake-session-prompt';
    createSessionFile(homeDir, sid);
    const plugin = (await loadPluginWithHome(homeDir)).MemorySystemPlugin({
      client: makeClient({
        session: {
          async prompt() { return null; },
          async update() { return null; }
        }
      })
    });
    const before = listSessionFiles(homeDir);
    await plugin.__test.emitVisibleNotice(sid, '记忆提示：prompt-no-fake', 'inject:test');
    await plugin.__test.processUserMessageEvent(
      sid,
      '这是第二条真实用户输入，不应创建新 session 文件',
      {
        type: 'message.updated',
        properties: {
          info: {
            sessionID: sid,
            messageID: 'msg-no-fake-2',
            summary: { body: '这是第二条真实用户输入，不应创建新 session 文件' }
          }
        }
      }
    );
    const after = listSessionFiles(homeDir);
    return {
      ok: before.length === 1 && after.length === 1 && before[0] === after[0],
      detail: JSON.stringify({ before, after })
    };
  });
}

// ===================== Path Anchor Project Isolation Tests =====================

async function testIsPathAnchorContentDetectsFilePaths() {
  return withPluginHome('is_path_anchor_content_detects_file_paths', async ({ plugin }) => {
    const t = plugin.__test.isPathAnchorContent;
    const yes1 = t('根目录: /Users/wsxwj/Desktop/openclaw');
    const yes2 = t('C:\\Users\\test\\project');
    const yes3 = t('路径锚点 my-project');
    const yes4 = t('https://github.com/example/repo');
    const no1 = t('我喜欢简洁的回复风格');
    const no2 = t('');
    return {
      ok: yes1 && yes2 && yes3 && yes4 && !no1 && !no2,
      detail: JSON.stringify({ yes1, yes2, yes3, yes4, no1, no2 })
    };
  });
}

async function testAppendProjectPathAnchorWritesToProjectMeta() {
  return withPluginHome('append_project_path_anchor_writes_to_project_meta', async ({ homeDir, plugin }) => {
    const res = plugin.__test.appendProjectPathAnchor('根目录: /Users/wsxwj/Desktop/openclaw');
    const projectMetaPath = path.join(homeDir, '.opencode', 'memory', 'projects', path.basename(process.cwd()), 'memory.json');
    let meta = {};
    if (fs.existsSync(projectMetaPath)) {
      meta = readJson(projectMetaPath);
    }
    const anchors = meta.pathAnchors || [];
    return {
      ok: res.ok && anchors.length === 1 && anchors[0].includes('/Users/wsxwj/Desktop/openclaw'),
      detail: JSON.stringify({ result: res, anchors })
    };
  });
}

async function testAppendProjectPathAnchorDeduplicates() {
  return withPluginHome('append_project_path_anchor_deduplicates', async ({ homeDir, plugin }) => {
    plugin.__test.appendProjectPathAnchor('根目录: /tmp/test-dedup');
    const res2 = plugin.__test.appendProjectPathAnchor('根目录: /tmp/test-dedup');
    const projectMetaPath = path.join(homeDir, '.opencode', 'memory', 'projects', path.basename(process.cwd()), 'memory.json');
    const meta = fs.existsSync(projectMetaPath) ? readJson(projectMetaPath) : {};
    const anchors = meta.pathAnchors || [];
    return {
      ok: res2.ok && anchors.length === 1,
      detail: JSON.stringify({ result: res2, anchors })
    };
  });
}

async function testDeleteProjectPathAnchorRemovesMatch() {
  return withPluginHome('delete_project_path_anchor_removes_match', async ({ homeDir, plugin }) => {
    plugin.__test.appendProjectPathAnchor('config: /tmp/conf');
    plugin.__test.appendProjectPathAnchor('data: /tmp/data');
    const res = plugin.__test.deleteProjectPathAnchor('/tmp/conf');
    const projectMetaPath = path.join(homeDir, '.opencode', 'memory', 'projects', path.basename(process.cwd()), 'memory.json');
    const meta = fs.existsSync(projectMetaPath) ? readJson(projectMetaPath) : {};
    const anchors = meta.pathAnchors || [];
    return {
      ok: res.ok && anchors.length === 1 && anchors[0].includes('/tmp/data'),
      detail: JSON.stringify({ result: res, anchors })
    };
  });
}

async function testAppendValueToGlobalNoteRedirectsPathToProject() {
  return withPluginHome('append_value_to_global_note_redirects_path_to_project', async ({ homeDir, plugin }) => {
    const res = plugin.__test.appendValueToGlobalNote('根目录: /Users/wsxwj/Desktop/my-project');
    // Should have been redirected to project pathAnchors
    const projectMetaPath = path.join(homeDir, '.opencode', 'memory', 'projects', path.basename(process.cwd()), 'memory.json');
    const meta = fs.existsSync(projectMetaPath) ? readJson(projectMetaPath) : {};
    const anchors = meta.pathAnchors || [];
    // Global note should NOT contain the path
    const globalPath = path.join(homeDir, '.opencode', 'memory', 'global.json');
    const globalMem = fs.existsSync(globalPath) ? readJson(globalPath) : {};
    const globalNote = String(globalMem?.preferences?.note || '');
    return {
      ok: res.ok && anchors.some(a => a.includes('/Users/wsxwj/Desktop/my-project')) && !globalNote.includes('/Users/wsxwj/Desktop/my-project'),
      detail: JSON.stringify({ result: res, anchors, globalNote: globalNote.slice(0, 100) })
    };
  });
}

async function testAppendValueToGlobalNoteKeepsNonPathInGlobal() {
  return withPluginHome('append_value_to_global_note_keeps_non_path_in_global', async ({ homeDir, plugin }) => {
    const res = plugin.__test.appendValueToGlobalNote('我喜欢 TypeScript 和函数式编程风格，请记住这个偏好');
    // Non-path content should stay in global preferences.note (or be rejected if too short/not matching)
    const globalPath = path.join(homeDir, '.opencode', 'memory', 'global.json');
    const globalMem = fs.existsSync(globalPath) ? readJson(globalPath) : {};
    const globalNote = String(globalMem?.preferences?.note || '');
    const projectMetaPath = path.join(homeDir, '.opencode', 'memory', 'projects', path.basename(process.cwd()), 'memory.json');
    const meta = fs.existsSync(projectMetaPath) ? readJson(projectMetaPath) : {};
    const anchors = meta.pathAnchors || [];
    // This content doesn't have paths, so anchors should be empty
    return {
      ok: anchors.length === 0 && (globalNote.includes('TypeScript') || !res.ok),
      detail: JSON.stringify({ result: res, globalNote: globalNote.slice(0, 200), anchors })
    };
  });
}

async function testBuildProjectPathAnchorsText() {
  return withPluginHome('build_project_path_anchors_text', async ({ plugin }) => {
    plugin.__test.appendProjectPathAnchor('根目录: /tmp/proj-a');
    plugin.__test.appendProjectPathAnchor('配置: /tmp/proj-a/config.ts');
    const text = plugin.__test.buildProjectPathAnchorsText();
    return {
      ok: text.includes('OPENCODE_PROJECT_PATH_ANCHORS') && text.includes('/tmp/proj-a') && text.includes('config.ts'),
      detail: text
    };
  });
}

async function testBuildGlobalPrefsContextTextFiltersPathsFromNote() {
  return withPluginHome('build_global_prefs_filters_paths_from_note', async ({ homeDir, plugin }) => {
    // Manually write path anchors into global preferences.note (simulating old data)
    const globalPath = path.join(homeDir, '.opencode', 'memory', 'global.json');
    const globalMem = fs.existsSync(globalPath) ? readJson(globalPath) : {};
    if (!globalMem.preferences) globalMem.preferences = {};
    globalMem.preferences.note = '1. 根目录: /Users/wsxwj/Desktop/openclaw\n2. 我喜欢简洁的代码风格，请注意代码质量和可读性';
    globalMem.preferences.language = 'Chinese';
    writeJson(globalPath, globalMem);
    const text = plugin.__test.buildGlobalPrefsContextText();
    // Should NOT contain the path line, but SHOULD contain the non-path note
    const hasPath = text.includes('/Users/wsxwj/Desktop/openclaw');
    const hasNonPath = text.includes('简洁的代码风格') || text.includes('代码质量');
    return {
      ok: !hasPath && hasNonPath,
      detail: JSON.stringify({ hasPath, hasNonPath, text: text.slice(0, 500) })
    };
  });
}

// ===================== End Path Anchor Project Isolation Tests =====================

async function main() {
  log(`Using temp root: ${tmpRoot}`);
  const cases = [
    ['global prefs prioritize note/language', testGlobalPrefsPrioritization],
    ['low-signal lastObserved does not override session text', testLowSignalLastObservedDoesNotOverrideSession],
    ['empty clean still persists inferred user event', testEmptyCleanStillPersistsUserEvent],
    ['config overrides stale slash guidance', testConfigOverridesSlashCommandGuidance],
    ['config overrides context guidance', testConfigOverridesContextGuidance],
    ['slash-prefixed /memory stats parses and executes', testSlashPrefixedMemoryStatsCommandParsesAndExecutes],
    ['slash-prefixed /memory global parses and executes', testSlashPrefixedMemoryGlobalCommandParsesAndExecutes],
    ['empty payload slash /memory stats falls back to observed text', testEmptyPayloadSlashMemoryStatsFallsBackToObservedText],
    ['explicit slash overrides wrong tool guess', testExplicitSlashOverridesWrongToolGuess],
    ['empty payload write annotates synthetic set command', testEmptyPayloadWriteAnnotatesCommand],
    ['empty payload generic global write rejects unsupported note fallback', testEmptyPayloadGenericGlobalWriteRejectsUnsupportedNoteFallback],
    ['web-path generic global write does not pollute preferences.note', testWebPathGenericGlobalWriteDoesNotPolluteNote],
    ['empty payload read resolves flattened preference key', testEmptyPayloadReadCanResolveFlattenedPreference],
    ['empty payload read resolves nickname preference', testEmptyPayloadReadCanResolveNicknamePreference],
    ['empty payload read resolves legacy language alias', testEmptyPayloadReadResolvesLegacyLanguageAlias],
    ['transform injects global read hint for known preference', testTransformInjectsGlobalReadHintForKnownPreference],
    ['context tool requires command', testContextToolRequiresCommand],
    ['empty context call annotates payload', testEmptyContextCallAnnotatesPayload],
    ['empty context call infers add from latest user text', testEmptyContextCallInfersAddFromLatestUserText],
    ['empty context call infers clear from latest user text', testEmptyContextCallInfersClearFromLatestUserText],
    ['duplicate user-message dedupes across different ids', testDuplicateUserMessageDedupesAcrossDifferentIds],
    ['duplicate user-message dedupes beyond short window', testDuplicateUserMessageDedupesBeyondShortWindow],
    ['duplicate user-message dedupes across forty-five seconds', testDuplicateUserMessageDedupesAcrossFortyFiveSeconds],
    ['transform fallback and late message.update collapse into one user-message', testTransformFallbackAndLateMessageUpdateCollapseIntoSingleUserEvent],
    ['late duplicate user-message after assistant is skipped', testLateDuplicateUserMessageAfterAssistantIsSkipped],
    ['late truncated user-message after assistant is skipped', testLateTruncatedUserMessageAfterAssistantIsSkipped],
    ['late user event prefers observed text over assistant summary', testLateUserEventPrefersObservedTextOverAssistantSummary],
    ['sanitize strips leading dash prefix', testSanitizeStripsLeadingDashPrefix],
    ['sanitize strips boundary quotes', testSanitizeStripsBoundaryQuotes],
    ['sanitize collapses memory slash template wrapper', testSanitizeCollapsesMemorySlashTemplateWrapper],
    ['sanitize trims slash template suffix after command', testSanitizeTrimsSlashTemplateSuffixAfterCommand],
    ['run argv ignores -m model flags', testInferUserTextFromRunArgvIgnoresModelFlags],
    ['session-scoped lookup does not borrow other session text', testSessionScopedLookupDoesNotBorrowOtherSessionText],
    ['late user-message reconciles inferred assistant turn', testLateUserMessageReconcilesInferredAssistantTurn],
    ['disk-backed user dedupe survives plugin reload', testDiskBackedUserDedupeSurvivesPluginReload],
    ['mixed user event types dedupe same clean text', testMixedUserEventTypesDedupesSameCleanText],
    ['semantic recall ranks source session above question session', testSemanticRecallRanksSourceSessionAboveQuestionSession],
    ['transform input skips low-signal placeholder and finds real web prompt', testTransformInputSkipsLowSignalPlaceholderAndFindsRealWebPrompt],
    ['infer latest user text keeps control-only prompt when sanitize would empty', testInferLatestUserTextKeepsControlOnlyPromptWhenSanitizeWouldEmpty],
    ['weak follow-up recall uses current session context', testWeakFollowupRecallUsesCurrentSessionContext],
    ['recall context hides session ids in injected text', testRecallContextHidesSessionIdsInInjectedText],
    ['recall supports direct session title match', testRecallDirectSessionTitleMatch],
    ['recall supports natural sentence title match', testRecallNaturalSentenceTitleMatch],
    ['recall supports direct session id match', testRecallDirectSessionIdMatch],
    ['weak follow-up query auto-triggers recall path', testWeakFollowupQueryAutoTriggersRecallPath],
    ['weaker follow-up query auto-triggers recall path', testWeakerFollowupQueryAutoTriggersRecallPath],
    ['shortest follow-up query auto-triggers recall path', testShortestFollowupQueryAutoTriggersRecallPath],
    ['weak follow-up remaining-variant auto-triggers recall path', testWeakFollowupRemainingVariantAutoTriggersRecallPath],
    ['weak follow-up corresponding-variant auto-triggers recall path', testWeakFollowupCorrespondingVariantAutoTriggersRecallPath],
    ['weak follow-up augment adds direct-answer hint', testWeakFollowupAugmentAddsDirectAnswerHint],
    ['weak follow-up prefers longest counterpart code', testWeakFollowupPrefersLongestCounterpartCode],
    ['weak follow-up strong code avoids generic drift', testWeakFollowupStrongCodeAvoidsGenericDrift],
    ['explicit global intent without note signal does not fallback to note', testExplicitGlobalIntentWithoutNoteSignalDoesNotFallbackToNote],
    ['path anchor still falls back to note', testPathAnchorStillFallsBackToNote],
    ['budget snapshot recomputes total when body changes', testBudgetSnapshotRecomputesTotalWhenBodyChanges],
    ['dashboard build recomputes stale budget total', testDashboardBuildRecomputesStaleBudgetTotal],
    ['budget token view separates plugin-hint from total', testBudgetTokenViewSeparatesPluginHintFromTotal],
    ['dashboard build exposes budget token view', testDashboardBuildExposesBudgetTokenView],
    ['system token risk alert triggers in budget snapshot', testSystemTokenRiskAlertTriggersInBudgetSnapshot],
    ['system token risk alert clears in safe range', testSystemTokenRiskAlertClearsWhenBackToSafeRange],
    ['doctor reports system token risk', testDoctorReportsSystemTokenRisk],
    ['doctor shows protection window from settings', testDoctorShowsProtectionWindowFromSettings],
    ['dashboard build exposes session project name', testDashboardBuildExposesSessionProjectName],
    ['visible notice part is not ignored', testVisibleNoticePartIsNotIgnored],
    ['synthetic visible notice does not pollute session events', testSyntheticVisibleNoticeDoesNotPolluteSessionEvents],
    ['user visible notice does not pollute session events', testUserVisibleNoticeDoesNotPolluteSessionEvents],
    ['wrapped visible notice does not persist user event', testWrappedVisibleNoticeDoesNotPersistUserEvent],
    ['visible notice prefers tui toast when available', testVisibleNoticePrefersToastWhenAvailable],
    ['visible notice falls back to session.prompt when toast unavailable', testVisibleNoticeFallsBackToSessionPromptWhenToastUnavailable],
    ['visible notice falls back to session.update when toast and prompt unavailable', testVisibleNoticeFallsBackToSessionUpdateWhenToastAndPromptUnavailable],
    ['non-current-summary toast does not mirror prompt', testNonCurrentSummaryToastDoesNotMirrorPrompt],
    ['visible notice cooldown is scoped per key', testVisibleNoticeCooldownIsScopedPerKey],
    ['visible notices disabled suppresses delivery', testVisibleNoticesDisabledSuppressesDelivery],
    ['visible notice (toast path) does not create extra session files', testVisibleNoticeDoesNotCreateExtraSessionFiles],
    ['visible notice (prompt fallback) does not create extra session files', testVisibleNoticeFallbackPromptDoesNotCreateExtraSessionFiles],
    ['provider protocol parsing supports three styles', testProviderProtocolParsingSupportsThreeStyles],
    ['distill response extraction supports three provider styles', testDistillResponseExtractionSupportsThreeProviderStyles],
    ['current summary refresh triggers at five and ten', testCurrentSummaryRefreshTriggersAtFiveAndTen],
    ['current summary refresh ignores replaced initial carryover count', testCurrentSummaryRefreshIgnoresReplacedInitialCarryoverCount],
    ['user message.part.updated persists web user event', testUserMessagePartUpdatedPersistsWebUserEvent],
    ['quoted user message.part.updated preserves reply-only text', testQuotedUserMessagePartUpdatedPreservesReplyOnlyText],
    ['skill boilerplate user noise does not persist as user event', testSkillBoilerplateUserNoiseDoesNotPersistAsUserEvent],
    ['find-skills boilerplate user noise does not persist as user event', testFindSkillsBoilerplateUserNoiseDoesNotPersistAsUserEvent],
    ['attach skill prompt variants do not persist as user event', testAttachSkillPromptVariantsDoNotPersistAsUserEvent],
    ['attach reused weak-followup prompt keeps latest user text', testAttachReuseWeakFollowupPrefersLatestPromptVariant],
    ['user message.part.updated dedupes against message.updated', testUserMessagePartUpdatedDedupesAgainstMessageUpdated],
    ['quoted user message.part.updated dedupes against truncated message.updated', testQuotedUserMessagePartUpdatedDedupesAgainstTruncatedMessageUpdated],
    ['user message.part.updated dedupes against truncated message.updated', testUserMessagePartUpdatedDedupesAgainstTruncatedMessageUpdated],
    ['message.updated dedupes against truncated message.updated', testMessageUpdatedDedupesAgainstTruncatedMessageUpdated],
    ['adjacent user-message events collapse to longest summary', testAdjacentUserMessagesCollapseToLongestSummary],
    ['user message.part.updated uses top-level messageID fallback', testUserMessagePartUpdatedUsesTopLevelMessageID],
    ['user message.updated does not persist title-only fallback', testUserMessageUpdatedDoesNotPersistTitleOnlyFallback],
    ['initial user message.updated carryover is replaced', testInitialUserMessageUpdatedCarryoverIsReplaced],
    ['initial user message.updated carryover from other session title is replaced', testInitialUserMessageUpdatedCarryoverFromOtherSessionTitleIsReplaced],
    ['concurrent initial user message.updated carryover from other session title is replaced', testConcurrentInitialUserMessageCarryoverFromOtherSessionTitleIsReplaced],
    ['system reminder visible notice does not persist user event', testSystemReminderVisibleNoticeDoesNotPersistUserEvent],
    ['assistant part updated materializes observed user fallback', testAssistantPartUpdatedMaterializesObservedUserFallback],
    ['observed user fallback dedupes repeated assistant parts', testObservedUserFallbackDedupesRepeatedAssistantParts],
    ['observed user fallback does not duplicate reply-suffix-trimmed user', testObservedUserFallbackDoesNotDuplicateReplySuffixTrimmedUser],
    ['observed user fallback overcomes late stale user event', testObservedUserFallbackOvercomesLateStaleUserEvent],
    ['unknown-role user part uses observed text before stale message.update', testUnknownRoleUserPartUsesObservedTextBeforeStaleMessageUpdate],
    ['late user part corrects stale message.update with same message id', testLateUserPartCorrectsStaleMessageUpdateWithSameMessageID],
    ['observed reminder wrapper does not create duplicate user fallback', testObservedReminderWrapperDoesNotCreateDuplicateUserFallback],
    ['isPathAnchorContent detects file paths and anchors', testIsPathAnchorContentDetectsFilePaths],
    ['appendProjectPathAnchor writes to project meta', testAppendProjectPathAnchorWritesToProjectMeta],
    ['appendProjectPathAnchor deduplicates entries', testAppendProjectPathAnchorDeduplicates],
    ['deleteProjectPathAnchor removes matching entries', testDeleteProjectPathAnchorRemovesMatch],
    ['appendValueToGlobalNote redirects path content to project', testAppendValueToGlobalNoteRedirectsPathToProject],
    ['appendValueToGlobalNote keeps non-path content in global', testAppendValueToGlobalNoteKeepsNonPathInGlobal],
    ['buildProjectPathAnchorsText generates correct XML block', testBuildProjectPathAnchorsText],
    ['buildGlobalPrefsContextText filters paths from note', testBuildGlobalPrefsContextTextFiltersPathsFromNote]
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
