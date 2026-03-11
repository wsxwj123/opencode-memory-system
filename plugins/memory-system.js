import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { tool as defineTool } from '@opencode-ai/plugin';

export const MemorySystemPlugin = ({ client }) => {
  const AUTO_MEMORY_VERSION = '2.0.0';

  // Storage and retention controls
  const AUTO_MAX_EVENTS_PER_SESSION = 120;
  const AUTO_MAX_EVENT_TEXT = 800;
  const AUTO_MAX_SESSIONS_PER_PROJECT = 60;
  const AUTO_SUMMARY_TRIGGER_EVENTS = 40;
  const AUTO_SUMMARY_KEEP_RECENT_EVENTS = 18;
  const AUTO_SUMMARY_MAX_CHARS = 2400;
  const AUTO_SUMMARY_MAX_CHARS_BUDGET_MODE = 2600;
  const AUTO_BODY_TOKEN_BUDGET = 50_000;
  const AUTO_BODY_BUDGET_SOFT_RATIO = 0.7;
  const AUTO_BODY_BUDGET_HARD_RATIO = 0.9;
  const AUTO_BODY_BUDGET_TARGET_RATIO = 0.75;
  const AUTO_BODY_KEEP_RECENT_CONVO_EVENTS = 20;
  const AUTO_DISCARD_KEEP_RECENT_TOOL_EVENTS = 8;
  const AUTO_DISCARD_MAX_REMOVALS_PER_PASS = 30;
  const AUTO_EXTRACT_EVENTS_PER_PASS = 24;

  // Send-time pretrim (DCP-like, conservative)
  const AUTO_SEND_PRETRIM_ENABLED = true;
  const AUTO_SEND_PRETRIM_DRY_RUN = false;
  const AUTO_SEND_PRETRIM_BUDGET = 10_000;
  const AUTO_SEND_PRETRIM_TARGET = 7_500;
  const AUTO_SEND_PRETRIM_HARD_RATIO = 0.9;
  const AUTO_SEND_PRETRIM_DISTILL_TRIGGER_RATIO = 0.8;
  const AUTO_SEND_PRETRIM_TRACE_LIMIT = 25;
  const AUTO_SEND_PRETRIM_TURN_PROTECTION = 10;
  const AUTO_SEND_PRETRIM_MAX_REWRITE_MESSAGES = 28;
  const AUTO_SEND_PRETRIM_WARMUP_ENABLED = true;
  const AUTO_SEND_PRETRIM_WARMUP_MIN_RATIO = 0.85;
  const AUTO_SEND_PRETRIM_WARMUP_MIN_INTERVAL_MS = 30 * 1000;
  const AUTO_SEND_PRETRIM_WARMUP_MAX_AGE_MS = 10 * 60 * 1000;
  const AUTO_SEND_PRETRIM_WARMUP_LOG_LIMIT = 20;
  const AUTO_SEND_PRETRIM_PROTECTED_TOOLS = ['write', 'edit', 'bash', 'read'];
  const AUTO_STRATEGY_DEDUP_ENABLED = true;
  const AUTO_STRATEGY_SUPERSEDE_WRITES_ENABLED = true;
  const AUTO_STRATEGY_PURGE_ERRORS_ENABLED = true;
  const AUTO_STRATEGY_PURGE_ERROR_TURNS = 4;
  const AUTO_STRATEGY_PROTECTED_TOOLS = [
    'task', 'todowrite', 'todoread', 'distill', 'compress', 'prune', 'batch', 'plan_enter', 'plan_exit'
  ];
  const AUTO_STRICT_MODE_ENABLED = false;
  const AUTO_STRICT_ANCHOR_MAX_LINES = 18;
  const AUTO_STRICT_ANCHOR_MAX_CHARS = 1800;
  const AUTO_STRICT_SUPPRESS_CURRENT_SUMMARY_MS = 5 * 60 * 1000;
  const AUTO_SUMMARY_BLOCK_MAX = 48;
  const AUTO_DISTILL_SUMMARY_MAX_CHARS = 1600;
  const AUTO_DISTILL_INPUT_MAX_CHARS = 9000;
  const AUTO_DISTILL_RANGE_MAX_MESSAGES = 18;
  const AUTO_DISTILL_RANGE_MIN_MESSAGES = 2;
  const AUTO_PRETRIM_PROFILE_DEFAULT = 'balanced'; // conservative | balanced | aggressive
  const AUTO_DCP_COMPAT_MODE = true;
  const AUTO_SYSTEM_TOKEN_WARN_MIN_TOTAL = 1200;
  const AUTO_SYSTEM_TOKEN_WARN_MIN_SYSTEM = 900;
  const AUTO_SYSTEM_TOKEN_WARN_SHARE = 0.45;
  const AUTO_SYSTEM_TOKEN_WARN_RATIO = 1.2;
  const AUTO_SYSTEM_TOKEN_CRITICAL_MIN_TOTAL = 1800;
  const AUTO_SYSTEM_TOKEN_CRITICAL_MIN_SYSTEM = 1800;
  const AUTO_SYSTEM_TOKEN_CRITICAL_SHARE = 0.6;
  const AUTO_SYSTEM_TOKEN_CRITICAL_RATIO = 1.8;

  function isSendPretrimEnabled() {
    const settingEnabled = getBoolSetting(['sendPretrimEnabled', 'send_pretrim_enabled'], AUTO_SEND_PRETRIM_ENABLED);
    return settingEnabled && String(process.env.OPENCODE_MEMORY_SEND_PRETRIM || '1') !== '0';
  }

  function isStrictModeEnabled() {
    return AUTO_STRICT_MODE_ENABLED || String(process.env.OPENCODE_MEMORY_STRICT_MODE || '0') === '1';
  }

  function isDcpCompatModeEnabled() {
    return getBoolSetting(['dcpCompatMode', 'dcp_compat_mode'], AUTO_DCP_COMPAT_MODE);
  }

  function getIndependentDistillConfig() {
    const enabled = getBoolSetting(
      ['independentLlmEnabled', 'independent_llm_enabled'],
      String(process.env.OPENCODE_MEMORY_DISTILL_ENABLED || '0') === '1'
    );
    const provider = getStringSetting(
      ['independentLlmProvider', 'independent_llm_provider'],
      normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_PROVIDER || 'openai_compatible')).toLowerCase()
    ).toLowerCase();
    const baseURL = getStringSetting(
      ['independentLlmBaseURL', 'independent_llm_base_url'],
      normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_BASE_URL || ''))
    );
    const apiKey = getStringSetting(
      ['independentLlmApiKey', 'independent_llm_api_key'],
      normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_API_KEY || ''))
    );
    const model = getStringSetting(
      ['independentLlmModel', 'independent_llm_model'],
      normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_MODEL || ''))
    );
    const timeoutMs = getIntPreference(
      ['independentLlmTimeoutMs', 'independent_llm_timeout_ms'],
      Math.max(3000, Number(process.env.OPENCODE_MEMORY_DISTILL_TIMEOUT_MS || 30000)),
      3000,
      120000
    );
    const maxTokens = getIntPreference(
      ['independentLlmMaxTokens', 'independent_llm_max_tokens'],
      Math.max(128, Number(process.env.OPENCODE_MEMORY_DISTILL_MAX_TOKENS || 420)),
      64,
      4096
    );
    const temperature = getFloatSetting(
      ['independentLlmTemperature', 'independent_llm_temperature'],
      Number(process.env.OPENCODE_MEMORY_DISTILL_TEMPERATURE || 0.2),
      0,
      1
    );
    const useSessionModel = getBoolSetting(
      ['independentLlmUseSessionModel', 'independent_llm_use_session_model'],
      String(process.env.OPENCODE_MEMORY_DISTILL_USE_SESSION_MODEL || '1') !== '0'
    );
    return {
      enabled,
      provider,
      baseURL,
      apiKey,
      model,
      timeoutMs,
      maxTokens,
      temperature: Number.isFinite(temperature) ? temperature : 0.2,
      useSessionModel
    };
  }

  function getDistillMode() {
    // DCP-style default:
    // "auto" => prefer independent distill when configured, else session-inline.
    // "session" => inline structured distill in transform path.
    // "independent" => external provider call (optional override).
    const m = getStringSetting(
      ['llmSummaryMode', 'llm_summary_mode'],
      normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_MODE || 'auto'))
    ).toLowerCase();
    if (m === 'auto') return 'auto';
    if (m === 'independent') return 'independent';
    return 'session';
  }

  function canUseIndependentDistill(config) {
    if (!config?.enabled) return false;
    if (!config.baseURL || !config.apiKey) return false;
    return ['openai_compatible', 'anthropic', 'gemini'].includes(config.provider);
  }

  function normalizePretrimProfile(value = '') {
    const s = normalizeText(String(value || '')).toLowerCase();
    if (s === 'conservative' || s === 'balanced' || s === 'aggressive') return s;
    if (s === 'safe' || s === '稳妥' || s === '保守') return 'conservative';
    if (s === 'normal' || s === '平衡') return 'balanced';
    if (s === 'hard' || s === 'strict' || s === '激进') return 'aggressive';
    return '';
  }

  function getPretrimProfile() {
    const envMode = normalizePretrimProfile(process.env.OPENCODE_MEMORY_PRETRIM_PROFILE || '');
    if (envMode) return envMode;
    try {
      const gm = readJson(globalMemoryPath) || {};
      const pref = gm?.preferences && typeof gm.preferences === 'object'
        ? gm.preferences.pretrimProfile || gm.preferences.pretrim_profile || ''
        : '';
      const mode = normalizePretrimProfile(pref);
      if (mode) return mode;
    } catch (_) {}
    return AUTO_PRETRIM_PROFILE_DEFAULT;
  }

  function getGlobalPreferenceByKeys(keys = []) {
    try {
      const gm = readJson(globalMemoryPath) || {};
      const prefs = gm?.preferences && typeof gm.preferences === 'object' ? gm.preferences : {};
      for (const k of keys) {
        if (prefs[k] !== undefined && prefs[k] !== null && String(prefs[k]).trim() !== '') return prefs[k];
      }
    } catch (_) {}
    return undefined;
  }

  function getIntPreference(keys = [], fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const rawFromSettings = getSettingRaw(keys);
    const raw = rawFromSettings !== undefined ? rawFromSettings : getGlobalPreferenceByKeys(keys);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function getFloatSetting(keys = [], fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const raw = getSettingRaw(keys);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function getCurrentSessionRefreshEvery() {
    return getIntPreference(
      ['currentSummaryEvery', 'current_summary_every'],
      AUTO_CURRENT_SESSION_REFRESH_EVERY,
      1,
      50
    );
  }

  function getCurrentSessionSummaryTokenBudget() {
    return getIntPreference(
      ['currentSummaryTokenBudget', 'current_summary_token_budget'],
      AUTO_CURRENT_SESSION_SUMMARY_TOKEN_BUDGET,
      120,
      2000
    );
  }

  function getVisibleNoticesEnabled() {
    return getBoolSetting(['visibleNoticesEnabled', 'visible_notices_enabled'], AUTO_VISIBLE_NOTICES);
  }

  function getVisibleNoticeCooldownMs() {
    return getIntPreference(['visibleNoticeCooldownMs', 'visible_notice_cooldown_ms'], AUTO_VISIBLE_NOTICE_COOLDOWN_MS, 0, 600000);
  }

  function getVisibleNoticeForDiscard() {
    return getBoolSetting(['visibleNoticeForDiscard', 'visible_notice_for_discard'], AUTO_VISIBLE_NOTICE_FOR_DISCARD);
  }

  function getVisibleNoticeCurrentSummaryMirrorEnabled() {
    return getBoolSetting(
      ['visibleNoticeCurrentSummaryMirrorEnabled', 'visible_notice_current_summary_mirror_enabled'],
      AUTO_VISIBLE_NOTICE_CURRENT_SUMMARY_MIRROR
    );
  }

  function getVisibleNoticeMirrorDeleteMs() {
    return getIntPreference(
      ['visibleNoticeMirrorDeleteMs', 'visible_notice_mirror_delete_ms'],
      AUTO_VISIBLE_NOTICE_MIRROR_DELETE_MS,
      0,
      30000
    );
  }

  function isWebServerProcess() {
    const argv = Array.isArray(process.argv) ? process.argv.map((x) => String(x || '').trim().toLowerCase()) : [];
    if (argv.includes('web')) return true;
    if (String(process.env.OPENCODE_WEB_UI || '') === '1') return true;
    return false;
  }

  function getStringSetting(keys = [], fallback = '') {
    const raw = getSettingRaw(keys);
    if (raw === undefined || raw === null) return fallback;
    const s = normalizeText(String(raw));
    return s || fallback;
  }

  function getNotificationMode() {
    const mode = getStringSetting(['notificationMode', 'notification_mode'], AUTO_NOTIFICATION_MODE).toLowerCase();
    if (mode === 'off' || mode === 'minimal' || mode === 'detailed') return mode;
    return AUTO_NOTIFICATION_MODE;
  }

  function getDcpPrunableToolsEnabled() {
    return getBoolSetting(['dcpPrunableToolsEnabled', 'dcp_prunable_tools_enabled'], AUTO_DCP_PRUNABLE_TOOLS_ENABLED);
  }

  function getDcpMessageIdTagsEnabled() {
    return getBoolSetting(['dcpMessageIdTagsEnabled', 'dcp_message_id_tags_enabled'], AUTO_DCP_MESSAGE_ID_TAGS_ENABLED);
  }

  function getDcpSystemPromptEnabled() {
    return getBoolSetting(['dcpSystemPromptEnabled', 'dcp_system_prompt_enabled'], AUTO_DCP_SYSTEM_PROMPT_ENABLED);
  }

  function getSystemPromptAuditEnabled() {
    return getBoolSetting(['systemPromptAuditEnabled', 'system_prompt_audit_enabled'], AUTO_SYSTEM_PROMPT_AUDIT_ENABLED);
  }

  function getSystemPromptAuditMaxChars() {
    return getIntPreference(
      ['systemPromptAuditMaxChars', 'system_prompt_audit_max_chars'],
      AUTO_SYSTEM_PROMPT_AUDIT_MAX_CHARS,
      800,
      50000
    );
  }

  function getRecallEnabled() {
    return getBoolSetting(['recallEnabled', 'recall_enabled'], AUTO_RECALL_ENABLED);
  }

  function getRecallTopSessions() {
    return getIntPreference(['recallTopSessions', 'recall_top_sessions'], AUTO_RECALL_TOP_SESSIONS, 1, 10);
  }

  function getRecallMaxEventsPerSession() {
    return getIntPreference(['recallMaxEventsPerSession', 'recall_max_events_per_session'], AUTO_RECALL_MAX_EVENTS_PER_SESSION, 1, 12);
  }

  function getRecallTokenBudget() {
    return getIntPreference(['recallTokenBudget', 'recall_token_budget'], AUTO_RECALL_TOKEN_BUDGET, 120, 2000);
  }

  function getRecallCooldownMs() {
    return getIntPreference(['recallCooldownMs', 'recall_cooldown_ms'], AUTO_RECALL_COOLDOWN_MS, 0, 600000);
  }

  function getInjectGlobalPrefsOnSessionStart() {
    return getBoolSetting(['injectGlobalPrefsOnSessionStart', 'inject_global_prefs_on_session_start'], AUTO_INJECT_GLOBAL_PREFS_ON_SESSION_START);
  }

  function getInjectMemoryDocsEnabled() {
    return getBoolSetting(['injectMemoryDocsEnabled', 'inject_memory_docs_enabled'], AUTO_INJECT_MEMORY_DOCS);
  }

  function getSendPretrimBudget() {
    return getIntPreference(['sendPretrimBudget', 'send_pretrim_budget'], AUTO_SEND_PRETRIM_BUDGET, 200, 200000);
  }

  function getSendPretrimTarget() {
    const budget = getSendPretrimBudget();
    return getIntPreference(['sendPretrimTarget', 'send_pretrim_target'], Math.min(AUTO_SEND_PRETRIM_TARGET, budget), 100, budget);
  }

  function getSendPretrimHardRatio() {
    return getFloatSetting(['sendPretrimHardRatio', 'send_pretrim_hard_ratio'], AUTO_SEND_PRETRIM_HARD_RATIO, 0.5, 0.99);
  }

  function getSendPretrimDistillTriggerRatio() {
    return getFloatSetting(
      ['sendPretrimDistillTriggerRatio', 'send_pretrim_distill_trigger_ratio'],
      AUTO_SEND_PRETRIM_DISTILL_TRIGGER_RATIO,
      0.4,
      0.99
    );
  }

  function getSendPretrimTurnProtection() {
    return getIntPreference(['sendPretrimTurnProtection', 'send_pretrim_turn_protection'], AUTO_SEND_PRETRIM_TURN_PROTECTION, 1, 20);
  }

  function getSendPretrimMaxRewriteMessages() {
    return getIntPreference(['sendPretrimMaxRewriteMessages', 'send_pretrim_max_rewrite_messages'], AUTO_SEND_PRETRIM_MAX_REWRITE_MESSAGES, 4, 120);
  }

  function getSendPretrimWarmupEnabled() {
    return getBoolSetting(['sendPretrimWarmupEnabled', 'send_pretrim_warmup_enabled'], AUTO_SEND_PRETRIM_WARMUP_ENABLED);
  }

  function getDistillSummaryMaxChars() {
    return getIntPreference(['distillSummaryMaxChars', 'distill_summary_max_chars'], AUTO_DISTILL_SUMMARY_MAX_CHARS, 400, 8000);
  }

  function getDistillInputMaxChars() {
    return getIntPreference(['distillInputMaxChars', 'distill_input_max_chars'], AUTO_DISTILL_INPUT_MAX_CHARS, 1000, 200000);
  }

  function getDistillRangeMaxMessages() {
    return getIntPreference(['distillRangeMaxMessages', 'distill_range_max_messages'], AUTO_DISTILL_RANGE_MAX_MESSAGES, 2, 100);
  }

  function getDistillRangeMinMessages() {
    const maxMsgs = getDistillRangeMaxMessages();
    return getIntPreference(['distillRangeMinMessages', 'distill_range_min_messages'], AUTO_DISTILL_RANGE_MIN_MESSAGES, 1, maxMsgs);
  }

  function getStrategyPurgeErrorTurns() {
    return getIntPreference(['strategyPurgeErrorTurns', 'strategy_purge_error_turns'], AUTO_STRATEGY_PURGE_ERROR_TURNS, 1, 20);
  }

  function getRecallMaxChars() {
    return getIntPreference(['recallMaxChars', 'recall_max_chars'], AUTO_RECALL_MAX_CHARS, 300, 12000);
  }

  function getCurrentSessionSummaryMaxChars() {
    return getIntPreference(
      ['currentSummaryMaxChars', 'current_summary_max_chars'],
      AUTO_CURRENT_SESSION_SUMMARY_MAX_CHARS,
      400,
      12000
    );
  }

  function getCurrentSessionSummaryMaxEvents() {
    return getIntPreference(
      ['currentSummaryMaxEvents', 'current_summary_max_events'],
      AUTO_CURRENT_SESSION_SUMMARY_MAX_EVENTS,
      2,
      20
    );
  }

  function getSummaryTriggerEvents() {
    return getIntPreference(['summaryTriggerEvents', 'summary_trigger_events'], AUTO_SUMMARY_TRIGGER_EVENTS, 10, 500);
  }

  function getSummaryKeepRecentEvents() {
    return getIntPreference(['summaryKeepRecentEvents', 'summary_keep_recent_events'], AUTO_SUMMARY_KEEP_RECENT_EVENTS, 6, 200);
  }

  function getSummaryMaxChars() {
    return getIntPreference(['summaryMaxChars', 'summary_max_chars'], AUTO_SUMMARY_MAX_CHARS, 500, 12000);
  }

  function getSummaryMaxCharsBudgetMode() {
    return getIntPreference(['summaryMaxCharsBudgetMode', 'summary_max_chars_budget_mode'], AUTO_SUMMARY_MAX_CHARS_BUDGET_MODE, 600, 16000);
  }

  function getMaxEventsPerSession() {
    return getIntPreference(['maxEventsPerSession', 'max_events_per_session'], AUTO_MAX_EVENTS_PER_SESSION, 40, 1000);
  }

  function getDiscardMaxRemovalsPerPass() {
    return getIntPreference(['discardMaxRemovalsPerPass', 'discard_max_removals_per_pass'], AUTO_DISCARD_MAX_REMOVALS_PER_PASS, 5, 400);
  }

  function getExtractEventsPerPass() {
    return getIntPreference(['extractEventsPerPass', 'extract_events_per_pass'], AUTO_EXTRACT_EVENTS_PER_PASS, 6, 200);
  }

  function runSessionInlineSummaryFallback(candidateItems = []) {
    const items = Array.isArray(candidateItems) ? candidateItems : [];
    const pseudoEvents = items.flatMap((it) => {
      const role = normalizeText(String(it?.role || 'assistant')).toLowerCase() || 'assistant';
      const kind = role === 'user'
        ? 'user-message'
        : (role === 'tool' ? 'tool-result' : 'assistant-message');
      const tool = role === 'tool' ? 'tool' : '';
      return (Array.isArray(it?.snippets) ? it.snippets : [])
        .filter(Boolean)
        .slice(0, 8)
        .map((snippet) => ({
          kind,
          tool,
          summary: truncateText(String(snippet || ''), 280)
        }));
    }).slice(0, 24);

    if (pseudoEvents.length) {
      const templated = normalizeText(
        truncateText(
          buildCompressedChunk(pseudoEvents, {
            sessionCwd: normalizeText(process.cwd()),
            summary: { compressedText: '' }
          }),
          getDistillSummaryMaxChars()
        )
      );
      if (templated) return templated;
    }

    const lines = [];
    const state = { chars: 0, maxChars: getDistillSummaryMaxChars() };
    const snippets = items.flatMap((it) => Array.isArray(it?.snippets) ? it.snippets : []).slice(0, 18);
    const allText = snippets.join('\n');
    const paths = extractPathsFromTextLoose(allText).slice(0, 6);
    const outcomes = snippets.filter((s) => /wrote|saved|fixed|done|pass|完成|已|成功|生成|输出|路径/i.test(s)).slice(0, 6);
    const constraints = snippets.filter((s) => /必须|不要|only|should|constraint|限制|格式|语言/i.test(s)).slice(0, 4);
    const next = snippets.filter((s) => /todo|next|后续|下一步|待办|风险|阻塞/i.test(s)).slice(0, 4);

    pushLineWithLimit(lines, 'Completed outcomes:', state);
    if (outcomes.length) outcomes.forEach((x) => pushLineWithLimit(lines, `- ${truncateText(x, 140)}`, state));
    else snippets.slice(0, 4).forEach((x) => pushLineWithLimit(lines, `- ${truncateText(x, 140)}`, state));

    pushLineWithLimit(lines, 'Key files/paths:', state);
    if (paths.length) paths.forEach((p) => pushLineWithLimit(lines, `- ${p}`, state));
    else pushLineWithLimit(lines, '- (not explicitly detected)', state);

    pushLineWithLimit(lines, 'Decisions/constraints:', state);
    if (constraints.length) constraints.forEach((x) => pushLineWithLimit(lines, `- ${truncateText(x, 140)}`, state));
    else pushLineWithLimit(lines, '- keep existing workflow and tools unchanged unless user requests', state);

    pushLineWithLimit(lines, 'Open risks/next steps:', state);
    if (next.length) next.forEach((x) => pushLineWithLimit(lines, `- ${truncateText(x, 140)}`, state));
    else pushLineWithLimit(lines, '- continue from latest completed step and verify outputs', state);

    return normalizeText(lines.join('\n'));
  }

  function resolveApiKey(raw = '') {
    const s = normalizeText(String(raw || ''));
    if (!s) return '';
    const m = s.match(/^\$\{([A-Z0-9_]+)\}$/i);
    if (m && m[1]) return normalizeText(String(process.env[m[1]] || ''));
    return s;
  }

  function parseProviderProtocol(provider = {}, modelID = '') {
    const npm = normalizeText(String(provider?.npm || '')).toLowerCase();
    if (npm.includes('anthropic')) return 'anthropic';
    if (npm.includes('google') || normalizeText(modelID).toLowerCase().includes('gemini')) return 'gemini';
    return 'openai_compatible';
  }

  function resolveSessionInlineProviderConfig(messages = []) {
    const sessionModel = inferSessionModelFromMessages(messages);
    const providerID = normalizeText(String(sessionModel?.providerID || ''));
    const modelID = normalizeText(String(sessionModel?.modelID || ''));
    if (!providerID || !modelID) return null;
    const cfgPath = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
    const cfg = readJson(cfgPath) || {};
    const providers = cfg?.provider && typeof cfg.provider === 'object' ? cfg.provider : {};
    const p = providers[providerID];
    if (!p || typeof p !== 'object') return null;
    const options = p?.options && typeof p.options === 'object' ? p.options : {};
    const baseURL = normalizeText(String(options.baseURL || ''));
    const apiKey = resolveApiKey(options.apiKey || '');
    if (!baseURL || !apiKey) return null;
    return {
      enabled: true,
      provider: parseProviderProtocol(p, modelID),
      baseURL,
      apiKey,
      model: modelID,
      timeoutMs: Math.max(3000, getIntPreference(['independentLlmTimeoutMs', 'independent_llm_timeout_ms'], 30000, 3000, 120000)),
      maxTokens: Math.max(64, getIntPreference(['independentLlmMaxTokens', 'independent_llm_max_tokens'], 420, 64, 4096)),
      temperature: getFloatSetting(['independentLlmTemperature', 'independent_llm_temperature'], 0.2, 0, 1),
      useSessionModel: true
    };
  }

  // Injection strategy (token-saving defaults)
  const AUTO_INJECT_MEMORY_DOCS = false;
  const AUTO_INJECT_GLOBAL_PREFS_ON_SESSION_START = true;
  const AUTO_INJECT_GLOBAL_PREFS_MAX_CHARS = 500;
  const AUTO_INJECT_GLOBAL_PREFS_MAX_ITEMS = 8;

  // Semi-auto recall
  const AUTO_RECALL_ENABLED = true;
  const AUTO_RECALL_TOP_SESSIONS = 2;
  const AUTO_RECALL_MAX_EVENTS_PER_SESSION = 4;
  const AUTO_RECALL_MAX_CHARS = 1800;
  const AUTO_RECALL_TOKEN_BUDGET = 450;
  const AUTO_RECALL_COOLDOWN_MS = 0;
  const AUTO_RECALL_MIN_QUERY_LEN = 2;

  // Hard budget controls
  const AUTO_SESSION_FILE_MAX_BYTES = 96 * 1024;
  const AUTO_SESSION_FILE_TARGET_BYTES = 72 * 1024;

  // Current-session refresh injection (semi-auto, token-bounded)
  const AUTO_CURRENT_SESSION_SUMMARY_ENABLED = true;
  const AUTO_CURRENT_SESSION_REFRESH_EVERY = 5;
  const AUTO_CURRENT_SESSION_SUMMARY_TOKEN_BUDGET = 500;
  const AUTO_CURRENT_SESSION_SUMMARY_MAX_CHARS = 2200;
  const AUTO_CURRENT_SESSION_SUMMARY_MAX_EVENTS = 6;
  const AUTO_INJECT_DEDUPE_WINDOW_MS = 120000;
  const AUTO_INJECT_DEDUPE_WINDOW_RECALL_MS = 15000;
  const AUTO_INJECT_RISK_GUARD_WINDOW_MS = 5 * 60 * 1000;

  // Dashboard controls
  const DASHBOARD_MAX_EVENTS_PER_SESSION_VIEW = 30;
  const AUTO_DASHBOARD_AUTOSTART = true;
  const AUTO_DASHBOARD_PORT = (() => {
    const raw = Number(process.env.OPENCODE_MEMORY_DASHBOARD_PORT || 37777);
    return Number.isFinite(raw) && raw > 0 ? raw : 37777;
  })();
  const AUTO_OPENCODE_WEB_PORT = (() => {
    const raw = Number(process.env.OPENCODE_WEB_PORT || 4096);
    return Number.isFinite(raw) && raw > 0 ? raw : 4096;
  })();
  const AUTO_VISIBLE_NOTICES = true;
  const AUTO_VISIBLE_NOTICE_COOLDOWN_MS = 120000;
  const AUTO_VISIBLE_NOTICE_FOR_DISCARD = false;
  const AUTO_VISIBLE_NOTICE_CURRENT_SUMMARY_MIRROR = true;
  const AUTO_VISIBLE_NOTICE_MIRROR_DELETE_MS = 1800;
  const AUTO_NOTIFICATION_MODE = 'minimal'; // off | minimal | detailed
  const AUTO_SYSTEM_PROMPT_AUDIT_ENABLED = true;
  const AUTO_SYSTEM_PROMPT_AUDIT_MAX_CHARS = 12000;
  const OBSERVED_USER_FALLBACK_MAX_AGE_MS = 45000;
  const AUTO_DCP_PRUNABLE_TOOLS_ENABLED = true;
  const AUTO_DCP_MESSAGE_ID_TAGS_ENABLED = false;
  const AUTO_DCP_SYSTEM_PROMPT_ENABLED = String(process.env.OPENCODE_MEMORY_DCP_SYSTEM_PROMPT || '0') === '1';

  // --- Storage paths ---
  const memoryDir = path.join(os.homedir(), '.opencode', 'memory');
  const projectsDir = path.join(memoryDir, 'projects');
  const globalMemoryPath = path.join(memoryDir, 'global.json');
  const memoryConfigPath = path.join(memoryDir, 'config.json');
  const dashboardDir = path.join(memoryDir, 'dashboard');
  const dashboardHtmlPath = path.join(dashboardDir, 'index.html');
  const dashboardDataPath = path.join(dashboardDir, 'data.json');
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  const dashboardServiceScript = path.join(pluginDir, 'scripts', 'opencode_memory_dashboard.mjs');

  // Runtime state
  const sessionRecallState = new Map();
  const sessionUserMessageCounters = new Map();
  const sessionTitleByID = new Map();
  const sessionLatestUserTextByID = new Map();
  const sessionObservedUserTextByID = new Map();
  const sessionObservedUserAtByID = new Map();
  let lastActiveSessionID = '';
  let lastObservedUserText = '';
  let lastObservedUserAt = 0;
  const sessionAutoGlobalWriteState = new Map();
  const sessionRecentGlobalMutationState = new Map();
  const rememberGlobalEmptyCallState = new Map();
  const memoryEmptyCallState = new Map();
  const contextEmptyCallState = new Map();
  const messageRoleByID = new Map();
  const pendingTextPartByMessageKey = new Map();
  const processedMessageKeys = new Set();
  const processedUserEventKeys = new Map();
  const sessionUserDedupeState = new Map();
  const sessionUserEventTasks = new Map();
  const sessionStrictHitAt = new Map();
  const sessionNoticeState = new Map();
  const sessionNoticeCleanupTimers = new Map();
  const sessionPendingVisibleNoticeMirrors = new Map();
  const pretrimWarmupTasks = new Map();
  let nativeTokenizerProbeCache = null;

  // Recall trigger patterns
  const RECALL_TRIGGER_PATTERNS = [
    /另一个对话|另外一个对话|上一个对话|上次那个对话|之前那个对话|跨对话/i,
    /刚刚的会话|刚刚会话|之前的会话|之前会话|刚才的会话|刚才会话|刚在另一个会话|刚在那个会话|另一个会话|那个会话|前一个会话|上个对话|上一个会话|刚刚那个聊天|刚刚的那个聊天|那个聊天|前一个聊天|上一个聊天|另一个session|另外的session|上一个session|上一会话|上个会话|之前的session|那个session|刚刚那个会话|刚才那个会话|上个聊天|上次会话/i,
    /刚才在另一个会话|我刚才在另一个会话|刚刚在另一个会话|之前在另一个会话/i,
    /in another chat|in previous chat|from previous session|other session/i
  ];
  const RECALL_LOW_SIGNAL_TOKEN_PATTERN = /^(?:我|你|他|她|它|请|请你|请问|帮我|一下|刚才|刚刚|之前|上次|那个|这个|另外|另一个|会话|对话|聊天|session|chat|提到|提到的|写入|写入的|保存|保存的|记住|记住的|告诉我|看看|读取|读一下|查询|查看|只回复|回复|是什么|是啥|什么|哪个|哪一个|多少|不知道|路径或不知道|里面|里的|中的)$/i;
  const RECALL_FILLER_STRIP_PATTERNS = [
    /我刚才在另一个会话|刚才在另一个会话|我刚刚在另一个会话|刚刚在另一个会话|之前在另一个会话/gi,
    /另一个对话|另外一个对话|上一个对话|上次那个对话|之前那个对话|跨对话/gi,
    /另一个会话|另外一个会话|上一个会话|上个会话|前一个会话|之前的会话|刚才的会话|刚刚的会话|那个会话|上一会话|上次会话/gi,
    /另一个session|另外的session|上一个session|之前的session|other session|previous session|previous chat|another chat/gi,
    /我刚才|我刚刚|刚才|刚刚|之前|上次|请问|请你|请|帮我|告诉我|查看|看看|读取|读一下|查询|提到的|写入的|保存的|记住的/gi,
    /是什么|是啥|什么|哪个|哪一个|多少|只回复|路径或不知道|不知道/gi
  ];
  const RECALL_HIGH_SIGNAL_CN_PATTERN = /[\u4e00-\u9fff]{1,10}(?:计划|工程|项目|插件|记忆|锚点|路径|目录|文件|文档|代号|名字|称呼|昵称|语言|模型|偏好|规则|配置|答案|结果|方案)/g;
  const RECALL_KEYWORD_TOKEN_PATTERN = /(?:路径|锚点|目录|文件|文档|代号|名字|称呼|昵称|语言|模型|偏好|规则|配置|答案|结果|方案)/g;

  if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
  if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true });
  if (!fs.existsSync(globalMemoryPath)) {
    fs.writeFileSync(globalMemoryPath, JSON.stringify({ preferences: {}, snippets: {} }, null, 2));
  }
  ensureDashboardDir();
  if (AUTO_DASHBOARD_AUTOSTART) {
    ensureDashboardServiceStarted();
  }

  function ensureDashboardServiceStarted() {
    try {
      if (!fs.existsSync(dashboardServiceScript)) return;

      const args = [
        dashboardServiceScript,
        'start',
        String(AUTO_DASHBOARD_PORT),
        String(process.pid),
        String(AUTO_OPENCODE_WEB_PORT)
      ];

      // Preserve an existing long-lived dashboard owner. Short-lived CLI runs
      // should not steal 37777 from a web/desktop parent that is still alive.
      const started = spawnSync('node', args, { stdio: 'ignore' });
      if (started.status !== 0) {
        // Avoid aggressive recovery here; plugin may initialize concurrently.
        // If another initializer won the race, service is already running.
      }
    } catch (err) {
      console.error('memory-system dashboard autostart failed:', err);
    }
  }

  function ensureDashboardServiceStopped() {
    try {
      if (!fs.existsSync(dashboardServiceScript)) return;
      spawnSync('node', [dashboardServiceScript, 'stop', String(AUTO_DASHBOARD_PORT)], { stdio: 'ignore' });
    } catch (err) {
      console.error('memory-system dashboard stop failed:', err);
    }
  }

  function getProjectName() {
    return path.basename(process.cwd());
  }

  function getProjectDir(projectName = getProjectName()) {
    const projectDir = path.join(projectsDir, projectName);
    if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });
    return projectDir;
  }

  function getProjectMemoryPath(projectName = getProjectName()) {
    return path.join(getProjectDir(projectName), 'memory.json');
  }

  function getProjectSessionsDir(projectName = getProjectName()) {
    const sessionsDir = path.join(getProjectDir(projectName), 'sessions');
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    return sessionsDir;
  }

  function sessionFileName(sessionID) {
    return `${encodeURIComponent(sessionID)}.json`;
  }

  function getSessionMemoryPath(sessionID, projectName = getProjectName()) {
    return path.join(getProjectSessionsDir(projectName), sessionFileName(sessionID));
  }

  function hasSessionMemoryFile(sessionID, projectName = getProjectName()) {
    return fs.existsSync(getSessionMemoryPath(sessionID, projectName));
  }

  function resolveSessionProjectName(sessionID, preferredProjectName = getProjectName()) {
    const sid = normalizeText(String(sessionID || ''));
    if (!sid) return preferredProjectName;
    if (hasSessionMemoryFile(sid, preferredProjectName)) return preferredProjectName;
    if (!fs.existsSync(projectsDir)) return preferredProjectName;

    const filename = sessionFileName(sid);
    let best = null;
    let bestMtime = 0;
    let dirs = [];
    try {
      dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      dirs = [];
    }
    for (const ent of dirs) {
      if (!ent?.isDirectory?.()) continue;
      const pName = ent.name;
      const p = path.join(projectsDir, pName, 'sessions', filename);
      if (!fs.existsSync(p)) continue;
      let mtime = 0;
      try {
        mtime = Number(fs.statSync(p).mtimeMs || 0);
      } catch {
        mtime = 0;
      }
      if (!best || mtime > bestMtime) {
        best = pName;
        bestMtime = mtime;
      }
    }
    return best || preferredProjectName;
  }

  function resolveSessionLocation(sessionID = '', preferredProjectName = getProjectName()) {
    const sid = normalizeText(String(sessionID || ''))
      || [...sessionUserMessageCounters.keys()].slice(-1)[0]
      || '';
    if (!sid || !isLikelySessionID(sid)) return { sessionID: '', projectName: preferredProjectName };
    const projectName = resolveSessionProjectName(sid, preferredProjectName);
    return { sessionID: sid, projectName };
  }

  function readJson(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  function readMemoryConfig() {
    const cfg = readJson(memoryConfigPath);
    return cfg && typeof cfg === 'object' ? cfg : {};
  }

  function writeMemoryConfig(mutator) {
    const cfg = readMemoryConfig();
    const next = typeof mutator === 'function' ? mutator(cfg) : cfg;
    writeJson(memoryConfigPath, next && typeof next === 'object' ? next : cfg);
  }

  function readMemorySystemSettings() {
    const cfg = readMemoryConfig();
    const ms = cfg?.memorySystem;
    return ms && typeof ms === 'object' ? ms : {};
  }

  function getSettingRaw(keys = []) {
    const s = readMemorySystemSettings();
    for (const k of keys) {
      if (s[k] !== undefined && s[k] !== null) return s[k];
    }
    return undefined;
  }

  function getSettingByAliases(keys = [], fallback = undefined) {
    const raw = getSettingRaw(keys);
    return raw === undefined ? fallback : raw;
  }

  function getBoolSetting(keys = [], fallback = false) {
    const raw = getSettingRaw(keys);
    if (raw === undefined) return fallback;
    if (typeof raw === 'boolean') return raw;
    const t = normalizeText(String(raw)).toLowerCase();
    if (!t) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(t)) return true;
    if (['0', 'false', 'no', 'off'].includes(t)) return false;
    return fallback;
  }

  function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  function normalizeGlobalMemoryKey(rawKey = '') {
    const key = normalizeText(String(rawKey || ''));
    if (!key) return '';
    if (key.includes('.')) return key;
    return `preferences.${key}`;
  }

  function pickFirstDefinedGlobal(obj, keys) {
    for (const key of keys) {
      if (obj && obj[key] !== undefined && obj[key] !== null && String(obj[key]).trim() !== '') {
        return obj[key];
      }
    }
    return undefined;
  }

  function resolveGlobalMutationSessionID(raw = null, action = 'set', rawKey = '', rawValue = '') {
    const direct = normalizeText(
      String(raw?.sessionID || raw?.sessionId || raw?.sid || '')
    );
    if (direct) return direct;
    const textSeed = normalizeText(
      String(
        pickFirstDefinedGlobal(raw || {}, ['query', 'content', 'text', 'message'])
        || ''
      )
    );
    if (textSeed) return `mutation:${stableTextHash(`${action}|${normalizeGlobalMemoryKey(rawKey)}|${String(rawValue ?? '')}|${textSeed}`)}`;
    const fallbackSeed = normalizeText(`${action}|${normalizeGlobalMemoryKey(rawKey)}|${String(rawValue ?? '')}`);
    if (fallbackSeed) return `mutation:${stableTextHash(fallbackSeed)}`;
    return '';
  }

  function getCurrentGlobalMemoryValue(rawKey = '') {
    const key = normalizeGlobalMemoryKey(rawKey);
    if (!key) return undefined;
    const globalMemory = readJson(globalMemoryPath) || {};
    const parts = key.split('.').filter(Boolean);
    let current = globalMemory;
    for (const part of parts) {
      if (!current || typeof current !== 'object' || !(part in current)) return undefined;
      current = current[part];
    }
    return current;
  }

  function rememberRecentGlobalMutation(sessionID = '', action = 'set', rawKey = '', rawValue = '') {
    const sid = normalizeText(String(sessionID || ''));
    const key = normalizeGlobalMemoryKey(rawKey);
    if (!sid || !key) return;
    sessionRecentGlobalMutationState.set(sid, {
      fp: `${String(action || 'set')}|${key}|${String(rawValue ?? '')}`,
      at: Date.now(),
      action: String(action || 'set'),
      key,
      value: String(rawValue ?? '')
    });
  }

  function getRecentGlobalMutationDuplicate(sessionID = '', action = 'set', rawKey = '', rawValue = '', windowMs = 20000) {
    const sid = normalizeText(String(sessionID || ''));
    const key = normalizeGlobalMemoryKey(rawKey);
    if (!sid || !key) return null;
    const prev = sessionRecentGlobalMutationState.get(sid);
    const fp = `${String(action || 'set')}|${key}|${String(rawValue ?? '')}`;
    if (prev && String(prev.fp || '') === fp && (Date.now() - Number(prev.at || 0)) < windowMs) {
      return { key, value: String(rawValue ?? ''), action: String(action || 'set') };
    }
    return null;
  }

  function inferPreferenceFromContent(rawContent = '') {
    const text = normalizeText(String(rawContent || ''));
    if (!text) return null;
    if (/中文|简体中文|chinese/i.test(text)) {
      return { key: 'preferences.language', value: 'Chinese' };
    }
    if (/英文|english/i.test(text)) {
      return { key: 'preferences.language', value: 'English' };
    }
    if (/日文|japanese/i.test(text)) {
      return { key: 'preferences.language', value: 'Japanese' };
    }
    if (/客观|中立|理智|不要安慰|直接一点/.test(text)) {
      return { key: 'preferences.communication_style', value: truncateText(text, 200) };
    }
    const note = sanitizeGlobalNoteContent(text);
    if (note && isExplicitNoteIntent(text)) {
      return { key: 'preferences.note', value: truncateText(note, 200) };
    }
    return null;
  }

  function hasExplicitGlobalMemoryDeleteIntent(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text) return false;
    if (/^\/memory\b/i.test(text)) return false;
    return /(?:删除|移除|清除|删掉|去掉|取消).*(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)|(?:从|在).*(?:全局记忆|全局偏好).*(?:删除|移除|清除|删掉|去掉|取消)/i.test(text);
  }

  function isExplicitNoteIntent(text = '') {
    const t = normalizeText(String(text || ''));
    if (!t) return false;
    return /记住这个路径锚点|记住这个路径|记住这个笔记|保存这个备注|写入备注|保存到note|写入note/i.test(t);
  }

  function shouldFallbackToGlobalNote(rawText = '') {
    const text = normalizeText(String(rawText || ''));
    if (!text) return false;
    if (isExplicitNoteIntent(text)) return true;
    if (/(?:路径锚点|path anchor)/i.test(text)) return true;
    return /(\/[^\s"'，。；;]+(?:\/[^\s"'，。；;]+)*)/.test(text);
  }

  function sanitizeGlobalNoteContent(raw = '') {
    let text = sanitizeUserTextForMemoryInference(raw);
    if (!text) return '';
    const pathMatch = text.match(/(\/[^\s"'，。；;]+(?:\/[^\s"'，。；;]+)*)/);
    if (pathMatch && pathMatch[1]) return normalizeText(pathMatch[1]);
    text = text
      .replace(/^这个路径锚点\s*/i, '')
      .replace(/^记住这个路径锚点\s*/i, '')
      .replace(/^记住这个路径\s*/i, '')
      .replace(/^记住\s*/i, '')
      .replace(/\s*里写的.*$/i, '')
      .replace(/\s*只回复.*$/i, '')
      .replace(/\s*(路径或不知道|不知道)\s*$/i, '')
      .trim();
    if (!text) return '';
    if (/[？?]$/.test(text)) return '';
    return normalizeText(text);
  }

  function sanitizeFallbackGlobalNoteContent(raw = '') {
    let text = sanitizeUserTextForMemoryInference(raw);
    if (!text) return '';
    text = text
      .replace(/[，,。.]?\s*写完后.*$/i, '')
      .replace(/[，,。.]?\s*写好了.*$/i, '')
      .replace(/^(?:可以|好的|行|嗯|好)[，,、\s]*/i, '')
      .replace(/^(?:请)?(?:帮我)?(?:把|将)?(?:这条|这个|这些)?(?:内容|信息|事情)?(?:写入|写到|存入|存到|记入|记到|保存到)?(?:到)?(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)(?:里|中)?[，,:：\s]*/i, '')
      .replace(/^(?:请)?(?:帮我)?(?:在|往)?(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)(?:里|中)?(?:写入|写到|存入|存到|记入|记到|保存)[，,:：\s]*/i, '')
      .replace(/[，,]?\s*(?:你帮我|帮我)?(?:把|将)?(?:这条|这个|这些)?(?:内容|信息|事情)?(?:也)?(?:写入|写到|存入|存到|记入|记到|保存到)?(?:到)?(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)(?:里|中)?\s*$/i, '')
      .replace(/^(?:你把|把)?这个/i, '')
      .replace(/\s*只回复.*$/i, '')
      .replace(/\s*删完后.*$/i, '')
      .trim();
    if (!text) return '';
    if (/[？?]$/.test(text)) return '';
    return normalizeText(text);
  }

  function normalizeGlobalNoteEntries(raw = '') {
    let text = String(raw || '').replace(/\r\n/g, '\n').trim();
    if (!text) return [];
    text = text.replace(/\s+(?=\d+\.\s)/g, '\n');
    return text
      .split('\n')
      .map((line) => String(line || '').trim())
      .filter(Boolean);
  }

  function shouldAppendGlobalNoteFromContext(rawKey = '', rawText = '') {
    const key = normalizeGlobalMemoryKey(rawKey);
    if (key !== 'preferences.note') return false;
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text) return false;
    if (hasExplicitGlobalMemoryDeleteIntent(text)) return false;
    return hasExplicitGlobalMemoryIntent(text);
  }

  function appendValueToGlobalNote(rawValue = '') {
    const value = sanitizeFallbackGlobalNoteContent(rawValue) || sanitizeGlobalNoteContent(rawValue);
    if (!value) return { ok: false, key: 'preferences.note', value: '', message: 'Rejected empty global note content' };

    try {
      const globalMemory = readJson(globalMemoryPath) || {};
      if (!globalMemory.preferences || typeof globalMemory.preferences !== 'object') {
        globalMemory.preferences = {};
      }
      const existing = String(globalMemory.preferences.note || '').trim();
      let next = '';
      const rawEntries = normalizeGlobalNoteEntries(existing);
      const entries = [];
      const existingValues = [];
      for (const rawEntry of rawEntries) {
        const base = String(rawEntry || '').replace(/^\d+\.\s*/, '').trim();
        const cleaned = sanitizeFallbackGlobalNoteContent(base) || sanitizeGlobalNoteContent(base) || base;
        if (!cleaned || existingValues.includes(cleaned)) continue;
        entries.push(cleaned);
        existingValues.push(cleaned);
      }
      if (existingValues.includes(value)) {
        return { ok: true, key: 'preferences.note', value: value, message: `Global setting already present: preferences.note += ${value}` };
      }
      if (!entries.length) {
        next = `1. ${value}`;
      } else {
        next = entries
          .map((line, index) => `${index + 1}. ${line}`)
          .concat(`${entries.length + 1}. ${value}`)
          .join('\n');
      }
      globalMemory.preferences.note = next;
      writeJson(globalMemoryPath, globalMemory);
      writeDashboardFiles();
      return { ok: true, key: 'preferences.note', value: value, message: `Global setting updated: preferences.note += ${value}` };
    } catch (e) {
      return {
        ok: false,
        key: 'preferences.note',
        value,
        message: `Failed to persist global note content: ${e?.message || String(e)}`
      };
    }
  }

  function inferGlobalPreferenceWrite(payload = {}) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const key = raw.key ?? raw.path ?? raw.field;
    const value = raw.value ?? raw.val;
    const content = raw.content ?? raw.text ?? raw.message ?? raw.note;
    if (key !== undefined && value !== undefined && String(key).trim()) {
      return {
        key: normalizeGlobalMemoryKey(String(key)),
        value: typeof value === 'string' ? value : JSON.stringify(value)
      };
    }
    if (content !== undefined && content !== null && String(content).trim()) {
      return inferPreferenceFromContent(String(content));
    }
    return null;
  }

  function inferGlobalPreferenceDeleteFromText(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text || !hasExplicitGlobalMemoryDeleteIntent(text)) return null;
    const keys = new Set();
    for (const m of text.matchAll(/\bpreferences\.[A-Za-z0-9_]+\b/gi)) {
      const key = normalizeGlobalMemoryKey(m[0]);
      if (key) keys.add(key);
    }
    for (const m of text.matchAll(/["“”']([A-Za-z0-9_.-]+)["“”']\s*:/g)) {
      const key = normalizeGlobalMemoryKey(m[1]);
      if (key) keys.add(key);
    }
    for (const m of text.matchAll(/["“”']([A-Za-z0-9_.-]+)["“”']/g)) {
      const key = normalizeGlobalMemoryKey(m[1]);
      if (key) keys.add(key);
    }
    const inferredReadKey = inferPreferenceReadKeyFromText(text);
    if (inferredReadKey) keys.add(inferredReadKey);
    if (/\bnote\b|备注|笔记/i.test(text)) keys.add('preferences.note');
    if (/\bpretrimprofile\b/i.test(text)) keys.add('preferences.pretrimProfile');
    if (/\blanguage\b|中文|英文/i.test(text)) keys.add('preferences.language');
    if (/\bnickname\b|昵称|叫我|称呼/i.test(text)) keys.add('preferences.nickname');
    if (/\bcommunication_style\b|风格|语气/i.test(text)) keys.add('preferences.communication_style');
    const list = [...keys].filter(Boolean);
    return list.length ? { keys: list } : null;
  }

  function writeGlobalMemoryValue(rawKey = '', rawValue = '') {
    const key = normalizeGlobalMemoryKey(rawKey);
    let value = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
    if (!key) return { ok: false, message: 'Missing global memory key' };
    if (key === 'preferences.note') {
      value = sanitizeGlobalNoteContent(value);
      if (!value) return { ok: false, message: 'Rejected unsafe/empty global note content' };
    }

    try {
      const globalMemory = readJson(globalMemoryPath);
      if (!globalMemory.preferences || typeof globalMemory.preferences !== 'object') {
        globalMemory.preferences = {};
      }
      const parts = key.split('.').filter(Boolean);
      if (!parts.length) return { ok: false, message: 'Invalid global memory key' };

      let current = globalMemory;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!current[parts[i]] || typeof current[parts[i]] !== 'object') current[parts[i]] = {};
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = value;
      if (key === 'preferences.language' && globalMemory.preferences.language_preference !== undefined) {
        delete globalMemory.preferences.language_preference;
      }
      writeJson(globalMemoryPath, globalMemory);
      writeDashboardFiles();
      return { ok: true, key, value, message: `Global setting updated: ${key} = ${value}` };
    } catch (e) {
      return {
        ok: false,
        key,
        value,
        message: `Failed to persist global setting: ${e?.message || String(e)}`
      };
    }
  }

  function persistGlobalMemoryValue(raw = null, rawKey = '', rawValue = '') {
    const key = normalizeGlobalMemoryKey(rawKey);
    const value = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
    const rawText = String(
      pickFirstDefinedGlobal(raw || {}, ['query', 'content', 'text', 'message'])
      || value
      || ''
    );
    if (shouldAppendGlobalNoteFromContext(key, rawText)) {
      return appendValueToGlobalNote(rawText);
    }
    return writeGlobalMemoryValue(key, value);
  }

  function deleteGlobalMemoryValue(rawKey = '') {
    const key = normalizeGlobalMemoryKey(rawKey);
    if (!key) return { ok: false, message: 'Missing global memory key' };
    try {
      const globalMemory = readJson(globalMemoryPath) || { preferences: {}, snippets: {} };
      const parts = key.split('.').filter(Boolean);
      if (!parts.length) return { ok: false, message: 'Invalid global memory key' };
      let current = globalMemory;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!current[parts[i]] || typeof current[parts[i]] !== 'object') {
          return { ok: true, key, existed: false, message: `Global setting already absent: ${key}` };
        }
        current = current[parts[i]];
      }
      const leaf = parts[parts.length - 1];
      if (!(leaf in current)) {
        return { ok: true, key, existed: false, message: `Global setting already absent: ${key}` };
      }
      delete current[leaf];
      writeJson(globalMemoryPath, globalMemory);
      writeDashboardFiles();
      return { ok: true, key, existed: true, message: `Global setting deleted: ${key}` };
    } catch (e) {
      return {
        ok: false,
        key,
        message: `Failed to delete global setting: ${e?.message || String(e)}`
      };
    }
  }

  function getLatestUserSummaryForSession(sessionID = '', projectName = getProjectName()) {
    const observed = preferObservedUserText(String(lastObservedUserText || ''));
    const safeObserved = observed && !isLowSignalUserText(observed) && !isSummaryNoiseText(observed)
      ? observed
      : '';
    const argvText = inferUserTextFromProcessArgv();
    const argvHasPriorityIntent = Boolean(argvText) && (hasExplicitGlobalMemoryIntent(argvText) || shouldTriggerRecall(argvText) || shouldTriggerWeakFollowupRecall(argvText));
    const sid = normalizeText(String(sessionID || ''))
      || normalizeText(String(lastActiveSessionID || ''))
      || [...sessionUserMessageCounters.keys()].slice(-1)[0]
      || '';
    if (sid) {
      const runtimeText = normalizeText(String(sessionLatestUserTextByID.get(sid) || ''));
      if (runtimeText && !isLowSignalUserText(runtimeText)) return runtimeText;
      if (argvHasPriorityIntent) return argvText;
      const sess = loadSessionMemory(sid, projectName);
      const events = Array.isArray(sess?.recentEvents) ? sess.recentEvents : [];
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i] || {};
        const summary = normalizeText(String(ev.summary || ''));
        if (ev.kind === 'user-message' && summary && !isSummaryNoiseText(summary)) {
          return summary;
        }
      }
      const runtimeTitle = normalizeText(String(sessionTitleByID.get(sid) || ''));
      if (runtimeTitle && !isLowSignalUserText(runtimeTitle) && !isSummaryNoiseText(runtimeTitle)) return runtimeTitle;
      const persistedTitle = normalizeText(String(sess?.sessionTitle || ''));
      if (persistedTitle && !isLowSignalUserText(persistedTitle) && !isSummaryNoiseText(persistedTitle)) return persistedTitle;
      if (argvHasPriorityIntent) return argvText;
      return '';
    }

    try {
      const sessionsDir = getProjectSessionsDir(projectName);
      const files = fs.readdirSync(sessionsDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(sessionsDir, name))
        .sort((a, b) => {
          const am = Number(fs.statSync(a).mtimeMs || 0);
          const bm = Number(fs.statSync(b).mtimeMs || 0);
          return bm - am;
        });
      for (const file of files.slice(0, 6)) {
        const data = readJson(file);
        const fileEvents = Array.isArray(data?.recentEvents) ? data.recentEvents : [];
        for (let i = fileEvents.length - 1; i >= 0; i -= 1) {
          const ev = fileEvents[i] || {};
          const summary = normalizeText(String(ev.summary || ''));
          if (ev.kind === 'user-message' && summary && !isSummaryNoiseText(summary)) {
            return summary;
          }
        }
      }
    } catch {
      // ignore disk fallback errors
    }
    if (argvHasPriorityIntent) return argvText;
    if (safeObserved) return safeObserved;
    if (argvText) return argvText;
    return '';
  }

  function collapseMemorySlashTemplateWrapper(rawText = '') {
    const raw = String(rawText || '');
    if (!raw) return '';
    const header = raw.match(/^\s*Use the memory tool with the following arguments:\s*([^\n\r]*)/i);
    if (!header) return '';
    if (
      !/If no argument is provided, explain the available `\/memory` subcommands/i.test(raw)
      && !/This slash template is only for a human manually typing `\/memory`/i.test(raw)
    ) {
      return '';
    }
    const argsText = normalizeText(String(header[1] || ''));
    return argsText ? `/memory ${argsText}` : '/memory';
  }

  function trimMemorySlashTemplateSuffix(rawText = '') {
    const text = normalizeText(String(rawText || ''));
    if (!/^\/memory\b/i.test(text)) return text;
    const markers = [
      ' Treat the first token in ',
      ' If no argument is provided, explain the available `/memory` subcommands below and do not call any tool.',
      ' This slash template is only for a human manually typing `/memory` in an interactive shell.',
      ' In `opencode run` and frontend-generated model output, do not emit `/memory ...`.',
      ' For natural-language requests, prefer a direct `memory` tool call instead of slash text.',
      ' For global preference reads such as language, nickname, or path anchor, answer from the known value or make a single `memory` call.',
      ' For generic statements like "记住这个事实" without global/preference keywords, do not call `memory`; answer directly and continue.',
      ' Do not follow a successful `memory` read with `context` or any second tool.',
      ' ## /memory 子命令'
    ];
    let end = text.length;
    for (const marker of markers) {
      const idx = text.indexOf(marker);
      if (idx >= 0 && idx < end) end = idx;
    }
    return normalizeText(text.slice(0, end));
  }

  function inferGlobalPreferenceWriteFromText(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text) return null;
    if (/^\/memory\b/i.test(text)) return null;
    if (hasExplicitGlobalMemoryDeleteIntent(text)) return null;
    if (isAutoGlobalWriteUnsafeText(text)) return null;
    const explicitGlobalIntent = hasExplicitGlobalMemoryIntent(text);

    let m = text.match(/\bkey\b[:=\s]+([A-Za-z0-9._-]+)[,，\s]+(?:and\s+)?\bvalue\b[:=\s]+([A-Za-z0-9._:-]+)/i);
    if (m) {
      const key = normalizeGlobalMemoryKey(m[1]);
      if (!isSafeInferredGlobalKey(key)) return null;
      return {
        key,
        value: m[2]
      };
    }

    m = text.match(/key[为是:=\s]+([A-Za-z0-9._-]+).*?value[为是:=\s]+([^\s，,。；;]+)/i);
    if (m) {
      const key = normalizeGlobalMemoryKey(m[1]);
      if (!isSafeInferredGlobalKey(key)) return null;
      return {
        key,
        value: m[2]
      };
    }

    // Chinese natural language explicit set:
    // "把 preferences.language 设置为 Chinese"
    m = text.match(/(?:把|将)?\s*([A-Za-z0-9._-]+)\s*(?:设置为|设为|改为|=|:)\s*([^\s，,。；;]+)/i);
    if (m) {
      const key = normalizeGlobalMemoryKey(m[1]);
      if (!isSafeInferredGlobalKey(key)) return null;
      return {
        key,
        value: m[2]
      };
    }

    // English-like assignment in sentence:
    // "set preferences.language to Chinese"
    m = text.match(/\bset\s+([A-Za-z0-9._-]+)\s+to\s+([A-Za-z0-9._:-]+)/i);
    if (m) {
      const key = normalizeGlobalMemoryKey(m[1]);
      if (!isSafeInferredGlobalKey(key)) return null;
      return {
        key,
        value: m[2]
      };
    }

    m = text.match(/(?:请你)?记住(.+)/);
    if (m && normalizeText(m[1])) {
      return inferPreferenceFromContent(m[1]);
    }

    m = text.match(/(?:请)?(?:把|将)\s*(.+?)\s*(?:写入|保存到?|记录到?)\s*(?:全局记忆|全局偏好|长期记忆|永久记忆)/i);
    if (m && normalizeText(m[1])) {
      const inferred = inferPreferenceFromContent(m[1]);
      if (inferred?.key) return inferred;
      if (shouldFallbackToGlobalNote(m[1])) {
        const note = sanitizeGlobalNoteContent(m[1]);
        if (note) return { key: 'preferences.note', value: truncateText(note, 200) };
      }
    }

    m = text.match(/写入(?:一个)?全局记忆(.+)/);
    if (m && normalizeText(m[1])) {
      const inferred = inferPreferenceFromContent(m[1]);
      if (inferred?.key) return inferred;
      if (shouldFallbackToGlobalNote(m[1])) {
        const note = sanitizeGlobalNoteContent(m[1]);
        if (note) return { key: 'preferences.note', value: truncateText(note, 200) };
      }
    }

    m = text.match(/(?:全局记住|全局记忆|全局写入|全局保存|永远记住|永久记忆|持续记忆)\s*(.+)/i);
    if (m && normalizeText(m[1])) {
      const inferred = inferPreferenceFromContent(m[1]);
      if (inferred?.key) return inferred;
      if (shouldFallbackToGlobalNote(m[1])) {
        const note = sanitizeGlobalNoteContent(m[1]);
        if (note) return { key: 'preferences.note', value: truncateText(note, 200) };
      }
    }

    if (/全局记忆|记住|偏好|以后默认|默认用|默认使用/i.test(text)) {
      const inferred = inferPreferenceFromContent(text);
      if (inferred?.key) return inferred;
    }

    if (explicitGlobalIntent) {
      if (shouldFallbackToGlobalNote(text)) {
        const note = sanitizeGlobalNoteContent(text);
        if (note) return { key: 'preferences.note', value: truncateText(note, 200) };
      }
    }

    return null;
  }

  function isSafeInferredGlobalKey(key = '') {
    const k = normalizeText(String(key || ''));
    if (!k) return false;
    if (!k.startsWith('preferences.')) return false;
    const leaf = k.slice('preferences.'.length);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(leaf)) return false;
    if (/^(important|the|task|goal|summary|message|unknown)$/i.test(leaf)) return false;
    return true;
  }

  function hasExplicitGlobalMemoryIntent(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text) return false;
    if (/^\/memory\b/i.test(text)) return false;
    return /(?:写入|保存|记录|设为|设置为|改为|记住).*(?:全局记忆|全局偏好|永久记忆|长期记忆)|(?:全局记住|全局保存|全局写入|永远记住|永久记忆|持续记忆|全局记住)/i.test(text);
  }

  function inferPreferenceReadKeyFromText(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText).toLowerCase();
    if (!text) return '';
    if (/(语言|language|中文|english|英文)/i.test(text)) return 'preferences.language';
    if (/(昵称|nickname|怎么称呼|称呼|名字|name|叫什么|叫啥|叫我)/i.test(text)) return 'preferences.nickname';
    if (/(风格|style|语气)/i.test(text)) return 'preferences.communication_style';
    if (/(路径锚点|路径|path anchor|path)/i.test(text)) return 'preferences.note';
    return '';
  }

  function looksLikePreferenceReadRequest(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text) return false;
    if (!inferPreferenceReadKeyFromText(text)) return false;
    if (
      hasExplicitGlobalMemoryIntent(text)
      || /请你记住|请记住|记住这个|保存这个|写入全局记忆|保存到全局记忆|全局记住|全局保存|全局写入|永远记住|持续记忆|永久记忆|以后默认|默认使用|默认用|设置为|设为|改为|set\s+[A-Za-z0-9._-]+\s+to/i.test(text)
    ) {
      return false;
    }
    return /[?？]|是什么|是啥|叫什么|叫啥|怎么称呼|怎么叫|哪(个|条|一个)|多少|告诉我|查看|看看|读取|读一下|查询|全局记忆里|global memory|what|which|who|show|tell me|recall/i.test(text);
  }

  function resolveGlobalReadHintPayload(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!looksLikePreferenceReadRequest(text)) return null;
    const key = inferPreferenceReadKeyFromText(text);
    if (!key) return null;
    const g = readJson(globalMemoryPath) || {};
    const prefs = getNormalizedGlobalPreferences(g);
    const value = lookupGlobalPreferenceValue(prefs, key);
    if (value === undefined || value === null || !String(value).trim()) return null;
    return { key, value: String(value), query: text };
  }

  function cleanContextAddText(rawText = '') {
    let text = normalizeText(String(rawText || ''));
    if (!text) return '';
    text = text
      .replace(/^(?:参数(?:为|是)?|内容(?:为|是)?|文本(?:为|是)?|args?(?:为|是)?|将)\s*/i, '')
      .replace(/^[`"'“”‘’]+/, '')
      .replace(/[`"'“”‘’]+$/, '')
      .replace(/[，,。；;:\s]+$/g, '')
      .trim();
    return normalizeText(text);
  }

  function inferContextCommandFromText(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text || isSummaryNoiseText(text)) return null;

    let match = text.match(
      /(?:请)?(?:使用|调用)?\s*context(?:\s*工具)?\s*(?:执行|运行|run)?\s*add(?:\s*[，,:：]?\s*(?:参数(?:为|是)?|内容(?:为|是)?|文本(?:为|是)?|args?(?:为|是)?)?)?\s*(.+)$/i
    );
    if (match) {
      const value = cleanContextAddText(match[1]);
      if (value) return { command: 'add', args: [value] };
    }

    match = text.match(/(?:请)?(?:把|将)\s*(.+?)\s*(?:加入|添加到?|放入)\s*(?:当前|会话)?上下文/i);
    if (match) {
      const value = cleanContextAddText(match[1]);
      if (value) return { command: 'add', args: [value] };
    }

    if (
      /(?:请)?(?:使用|调用)?\s*context(?:\s*工具)?\s*(?:执行|运行|run)?\s*clear\b/i.test(text)
      || /(?:请)?(?:清空|清除|移除)\s*(?:当前|会话)?上下文/i.test(text)
    ) {
      return { command: 'clear', args: [] };
    }

    if (
      /(?:请)?(?:使用|调用)?\s*context(?:\s*工具)?\s*(?:执行|运行|run)?\s*view\b/i.test(text)
      || /(?:请)?(?:查看|显示|展示|读取)\s*(?:当前|会话)?上下文/i.test(text)
    ) {
      return { command: 'view', args: [] };
    }

    return null;
  }

  function buildCurrentGlobalReadAnswerText(payload = {}) {
    const key = normalizeText(String(payload?.key || ''));
    const value = normalizeText(String(payload?.value || ''));
    if (!key || !value) return '';
    return [
      '<OPENCODE_CURRENT_GLOBAL_READ>',
      `Resolved current request from global memory: ${key} = ${value}`,
      'Reply using this exact value.',
      'Do not answer 不知道.',
      'Do not call context or any second tool after this answer is available.',
      '</OPENCODE_CURRENT_GLOBAL_READ>'
    ].join('\n');
  }

  function shouldAutoWriteGlobalMemoryFromText(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text) return false;
    if (/^\/memory\b/i.test(text)) return false;
    if (hasExplicitGlobalMemoryDeleteIntent(text)) return false;
    if (isAutoGlobalWriteUnsafeText(text) || isSummaryNoiseText(text)) return false;
    if (hasExplicitGlobalMemoryIntent(text)) return true;
    return /写入全局记忆|保存到全局记忆|全局偏好|全局记住|全局保存|全局写入|永远记住|持续记忆|永久记忆|记住这个路径|路径锚点|以后默认|默认使用|默认用|设置为|设为|改为|set\s+[A-Za-z0-9._-]+\s+to/i.test(text);
  }

  function parseExplicitMemorySlashCommandFromText(rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!text || !/^\/memory\b/i.test(text)) return null;
    const remainder = normalizeText(text.replace(/^\/memory\b/i, ''));
    if (!remainder) return { command: '', args: [], query: '' };
    const parts = remainder.split(/\s+/).filter(Boolean);
    if (!parts.length) return { command: '', args: [], query: '' };
    const commandAlias = {
      get: 'global',
      view: 'global',
      remember: 'set',
      write: 'set',
      preference: 'set',
      preferences: 'set',
      prefer: 'prefer',
      remove: 'delete',
      unset: 'delete'
    };
    let command = normalizeText(String(parts[0] || '')).toLowerCase();
    if (commandAlias[command]) command = commandAlias[command];
    const validCommands = new Set([
      'learn', 'project', 'global', 'set', 'prefer', 'save', 'export', 'import', 'clear', 'edit',
      'feedback', 'recall', 'sessions', 'dashboard', 'discard', 'extract', 'prune', 'distill',
      'delete', 'unset',
      'compress', 'context', 'stats', 'doctor'
    ]);
    if (!validCommands.has(command)) return null;
    const args = parts.slice(1);
    return {
      command,
      args,
      query: args.join(' ')
    };
  }

  function maybeAutoPersistGlobalMemoryFromUserText(sessionID = '', rawText = '') {
    const text = sanitizeUserTextForMemoryInference(rawText);
    if (!shouldAutoWriteGlobalMemoryFromText(text)) {
      return { wrote: false, reason: 'no_explicit_intent' };
    }
    const inferred = inferGlobalPreferenceWriteFromText(text);
    if (!inferred?.key) {
      const fallbackNote = sanitizeFallbackGlobalNoteContent(text);
      if (!fallbackNote) return { wrote: false, reason: 'unable_to_infer' };
      const fp = stableTextHash(`${sessionID}|preferences.note|${fallbackNote}|${text}`);
      const prev = sessionAutoGlobalWriteState.get(sessionID);
      if (prev && String(prev.fp || '') === fp) {
        return { wrote: false, reason: 'duplicate_request', key: 'preferences.note', value: fallbackNote };
      }
      const res = appendValueToGlobalNote(fallbackNote);
      if (res?.ok) {
        sessionAutoGlobalWriteState.set(sessionID, { fp, key: res.key, value: res.value, at: new Date().toISOString() });
        rememberRecentGlobalMutation(sessionID, 'set', res.key, res.value);
        return { wrote: true, key: res.key, value: res.value, message: res.message };
      }
      return { wrote: false, reason: 'write_failed', key: 'preferences.note', value: fallbackNote };
    }
    const fp = stableTextHash(`${sessionID}|${inferred.key}|${String(inferred.value || '')}|${text}`);
    const prev = sessionAutoGlobalWriteState.get(sessionID);
    if (prev && String(prev.fp || '') === fp) {
      return { wrote: false, reason: 'duplicate_request', key: inferred.key, value: inferred.value };
    }
    const res = persistGlobalMemoryValue({ content: text, query: text }, inferred.key, inferred.value);
    if (res?.ok) {
      sessionAutoGlobalWriteState.set(sessionID, { fp, key: res.key, value: res.value, at: new Date().toISOString() });
      rememberRecentGlobalMutation(sessionID, 'set', res.key, res.value);
      return { wrote: true, key: res.key, value: res.value, message: res.message };
    }
    return { wrote: false, reason: 'write_failed', key: inferred.key, value: inferred.value };
  }

  function getActiveAutoGlobalWrite(sessionID = '') {
    const sid = normalizeText(String(sessionID || ''))
      || normalizeText(String(lastActiveSessionID || ''))
      || '';
    if (!sid) return null;
    const item = sessionAutoGlobalWriteState.get(sid);
    return item && typeof item === 'object' ? item : null;
  }

  function resolveToolSessionID(input = {}) {
    const sid = normalizeText(
      String(
        input?.sessionID ||
        input?.sessionId ||
        input?.sid ||
        lastActiveSessionID ||
        ''
      )
    );
    return isLikelySessionID(sid) ? sid : '';
  }

  function getLatestUserTextForSession(sessionID = '') {
    const sid = normalizeText(String(sessionID || ''));
    const argvText = inferUserTextFromProcessArgv();
    if (sid) {
      const runtime = normalizeText(String(sessionLatestUserTextByID.get(sid) || ''));
      if (runtime && !isLowSignalUserText(runtime)) return runtime;
      if (argvText && (hasExplicitGlobalMemoryIntent(argvText) || shouldTriggerRecall(argvText) || shouldTriggerWeakFollowupRecall(argvText))) return argvText;
      const bySession = getLatestUserSummaryForSession(sid, getProjectName());
      if (bySession) return bySession;
      if (argvText) return argvText;
      return '';
    }
    const bySession = getLatestUserSummaryForSession(sid, getProjectName());
    if (bySession) return bySession;
    if (argvText) return argvText;
    return normalizeText(String(lastObservedUserText || ''));
  }

  function isLowSignalUserText(raw = '') {
    if (isSkillBoilerplateUserText(raw)) return true;
    const t = normalizeText(String(raw || '')).toLowerCase();
    if (!t) return true;
    if (t.length <= 10) return true;
    if (['fix this bug', 'help', 'unknown', 'n/a', 'na', 'i remember this skill'].includes(t)) return true;
    if (/^fix\s+this\s+bug[\.\!\?]*$/i.test(t)) return true;
    if (/^i remember this skill[\.\!\?]*$/i.test(t)) return true;
    return false;
  }

  function isSkillBoilerplateUserText(raw = '') {
    const text = normalizeText(String(raw || ''));
    if (!text) return false;
    if (/^Loading skill:\s*[A-Za-z0-9._-]+$/i.test(text)) return true;
    if (/^Launching skill:\s*[A-Za-z0-9._-]+$/i.test(text)) return true;
    if (
      /(?:^|\n)(?:Loading|Launching)\s+skill:\s*[A-Za-z0-9._-]+/i.test(text)
      && /(use this skill|this skill should be used|write nature\/science\/cell-level|expert assistant for writing high-impact|converting sci paper materials|npx\s+@0xsero\/open-queue)/i.test(text)
    ) {
      return true;
    }
    if (/^#\s*[A-Za-z0-9._-]+\s*#\s*Helps users discover and install agent skills\b/i.test(text)) return true;
    if (/This skill should be used when the user is looking for functionality that might exist as an installable skill\.?$/i.test(text)) return true;
    if (/#\s*Supporting tools and docs are in\s+\/Users\/[^\s]+\/skills\/[A-Za-z0-9._-]+/i.test(text)) return true;
    if (/^#\s*Find Skills\b[\s\S]*This skill helps you discover and install skills from the open agent skills ecosystem\.?$/i.test(text)) return true;
    if (/^(?:find a skill for x|how do i do x|is there a skill for x|is there a skill that can(?:\.\.\.)?)$/i.test(text)) return true;
    if (/^You MUST use this before any creative work\b/i.test(text)) return true;
    if (/Explores user intent, requirements and design before implementation\.?$/i.test(text)) return true;
    if (/^type\s+mcp__[a-z0-9_]+__[a-z0-9_-]+\s*=\s*\(/im.test(text)) return true;
    if (/^##\s*Namespace:\s*[A-Za-z0-9_-]+/im.test(text) && /type\s+mcp__/i.test(text)) return true;
    if (/^###\s*Tool definitions/im.test(text) && /type\s+mcp__/i.test(text)) return true;
    if (/Model Context Protocol/i.test(text) && /type\s+mcp__/i.test(text)) return true;
    return false;
  }

  function inferUserTextFromProcessArgv() {
    try {
      const argv = Array.isArray(process.argv) ? process.argv : [];
      if (!argv.length) return '';
      const runIdx = argv.findIndex((x) => String(x || '').trim() === 'run');
      if (runIdx < 0) return '';
      const tailParts = [];
      const flagValueOptions = new Set([
        '-m', '--model',
        '-s', '--session',
        '--agent',
        '--command',
        '--log-level',
        '--format',
        '-f', '--file',
        '--title',
        '--attach',
        '--dir',
        '--port',
        '--variant'
      ]);
      let skipNextValue = false;
      for (const rawPart of argv.slice(runIdx + 1)) {
        const part = String(rawPart || '').trim();
        if (!part) continue;
        if (skipNextValue) {
          skipNextValue = false;
          continue;
        }
        if (part === '--') continue;
        if (flagValueOptions.has(part)) {
          skipNextValue = true;
          continue;
        }
        if (/^--(?:model|session|agent|command|log-level|format|title|attach|dir|port|variant)=/i.test(part)) continue;
        if (part === '-c' || part === '--continue' || part === '--fork' || part === '--share' || part === '--print-logs' || part === '--thinking') continue;
        if (part.startsWith('-')) continue;
        tailParts.push(part);
      }
      const raw = normalizeText(tailParts.join(' '));
      if (!raw || raw === 'run' || raw.startsWith('--')) return '';
      if (/opencode-ai|node_modules|\/opencode(\.js)?$/i.test(raw)) return '';
      const text = sanitizeUserTextForMemoryInference(raw);
      if (!text || text.length < 2) return '';
      return text;
    } catch {
      return '';
    }
  }

  function sanitizeUserTextForMemoryInference(rawText = '') {
    let text = String(rawText || '');
    if (!text) return '';
    if (isSkillBoilerplateUserText(text)) return '';
    const collapsedSlashTemplate = collapseMemorySlashTemplateWrapper(text);
    if (collapsedSlashTemplate) text = collapsedSlashTemplate;
    // Superpowers/skill-injection noise often wraps the real user ask in quotes.
    if (/Recall Workflow Rules|Loading skill:|using-superpowers|systematic-debugging/i.test(text)) {
      const quoted = [...text.matchAll(/"([^"\n]{6,1200})"/g)];
      if (quoted.length) {
        const candidates = quoted
          .map((m) => normalizeText(String(m?.[1] || '')))
          .filter(Boolean);
        const strongIntent = candidates.find((c) => /全局记忆|全局偏好|写入全局|全局记住|永远记住|持续记忆|永久记忆|路径锚点|另一个会话|上一个会话|previous session|another chat/i.test(c));
        const memoryIntent = candidates.find((c) => /记住|写入|保存|偏好|默认|global memory|remember/i.test(c));
        const fallbackLong = candidates.find((c) => c.length >= 18);
        const picked = normalizeText(String(strongIntent || memoryIntent || fallbackLong || candidates[candidates.length - 1] || ''));
        if (picked) text = picked;
      }
    }
    text = text
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/<prunable-tools>[\s\S]*?<\/prunable-tools>/gi, ' ')
      .replace(/<message-id-map[\s\S]*?<\/message-id-map>/gi, ' ')
      .replace(/<message-id>[\s\S]*?<\/message-id>/gi, ' ')
      .replace(/<dcp-message-id>[\s\S]*?<\/dcp-message-id>/gi, ' ')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/<reminder>[\s\S]*?<\/reminder>/gi, ' ')
      .replace(/^Loading skill:[^\n]*$/gim, ' ')
      .replace(/^Launching skill:[^\n]*$/gim, ' ')
      .replace(/---\s*Loading skill:[\s\S]*$/gi, ' ')
      .replace(/```[\s\S]*?```/g, ' ');
    text = normalizeText(text);
    if (!text) return '';
    text = text
      .replace(/^(?:---+|—+)\s*/i, '')
      .replace(/^[`"'“”‘’]+/, '')
      .replace(/[`"'“”‘’]+$/, '')
      .replace(/\s*(并|然后)?\s*(只回复|最后只回复|仅回复)\s*[^，。；;]*$/i, '')
      .replace(/\s*里写的.*$/i, '')
      .replace(/\s*(路径或不知道|不知道)\s*$/i, '')
      .trim();
    text = trimMemorySlashTemplateSuffix(text);
    text = normalizeText(text);
    if (isSkillBoilerplateUserText(text)) return '';
    return text;
  }

  function stripObservedWrapperNoise(rawText = '') {
    let text = String(rawText || '');
    if (!text) return '';
    if (isSkillBoilerplateUserText(text)) return '';
    const collapsedSlashTemplate = collapseMemorySlashTemplateWrapper(text);
    if (collapsedSlashTemplate) text = collapsedSlashTemplate;
    text = text
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .replace(/<prunable-tools>[\s\S]*?<\/prunable-tools>/gi, ' ')
      .replace(/<message-id-map[\s\S]*?<\/message-id-map>/gi, ' ')
      .replace(/<message-id>[\s\S]*?<\/message-id>/gi, ' ')
      .replace(/<dcp-message-id>[\s\S]*?<\/dcp-message-id>/gi, ' ')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
      .replace(/<reminder>[\s\S]*?<\/reminder>/gi, ' ')
      .replace(/^Loading skill:[^\n]*$/gim, ' ')
      .replace(/^Launching skill:[^\n]*$/gim, ' ')
      .replace(/---\s*Loading skill:[\s\S]*$/gi, ' ')
      .replace(/```[\s\S]*?```/g, ' ');
    text = normalizeText(text);
    if (!text) return '';
    text = text
      .replace(/^(?:---+|—+)\s*/i, '')
      .replace(/^[`"'“”‘’]+/, '')
      .replace(/[`"'“”‘’]+$/, '')
      .trim();
    text = trimMemorySlashTemplateSuffix(text);
    text = normalizeText(text);
    if (isSkillBoilerplateUserText(text)) return '';
    return text;
  }

  function areLikelySameUserText(a = '', b = '') {
    const left = normalizeText(String(a || ''));
    const right = normalizeText(String(b || ''));
    if (!left || !right) return false;
    if (left === right) return true;

    const directPrefixMatch = (
      (left.startsWith(right) || right.startsWith(left))
      && Math.min(left.length, right.length) >= 12
    );
    if (directPrefixMatch) return true;

    const leftSanitized = sanitizeUserTextForMemoryInference(left);
    const rightSanitized = sanitizeUserTextForMemoryInference(right);
    if (!leftSanitized || !rightSanitized) return false;
    if (leftSanitized === rightSanitized) return true;
    return (
      (leftSanitized.startsWith(rightSanitized) || rightSanitized.startsWith(leftSanitized))
      && Math.min(leftSanitized.length, rightSanitized.length) >= 12
    );
  }

  function preferObservedUserText(rawText = '') {
    const normalized = normalizeText(String(rawText || ''));
    if (!normalized) return '';
    if (isSkillBoilerplateUserText(normalized)) return '';
    const stripped = stripObservedWrapperNoise(normalized);
    const sanitized = sanitizeUserTextForMemoryInference(normalized);
    if (
      isVisibleNoticeText(normalized)
      || isVisibleNoticeText(stripped)
      || isVisibleNoticeText(sanitized)
    ) return '';
    if (sanitized && !isLowSignalUserText(sanitized)) return sanitized;
    const fallback = stripped || normalized;
    if (!sanitized && !isLowSignalUserText(fallback) && !isMemoryInjectionText(fallback) && !isSummaryNoiseText(fallback)) {
      return fallback;
    }
    return '';
  }

  function truncateText(value, max = AUTO_MAX_EVENT_TEXT) {
    if (typeof value !== 'string') return '';
    if (value.length <= max) return value;
    return `${value.slice(0, max)}...`;
  }

  function normalizeText(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/\s+/g, ' ').trim();
  }

  function shiftIsoTimestamp(isoString, deltaMs = 0) {
    const base = Date.parse(String(isoString || ''));
    if (!Number.isFinite(base)) return '';
    const shifted = new Date(base + Number(deltaMs || 0));
    const time = shifted.getTime();
    if (!Number.isFinite(time)) return '';
    return shifted.toISOString();
  }

  function isLikelySessionID(value) {
    const s = normalizeText(String(value || ''));
    if (!s || s.length < 2) return false;
    if (/\s/.test(s) || /[<>]/.test(s)) return false;
    if (/:/.test(s)) return false;
    if (/^(msg|message|call|toolcall|tool|tcall)[_-]?/i.test(s)) return false;
    return /^[A-Za-z0-9._-]{2,}$/.test(s);
  }

  function isAutoGlobalWriteUnsafeText(raw = '') {
    const t = String(raw || '');
    if (!t) return true;
    return (
      /\[memory-system\]/i.test(t) ||
      /<memory-global-write/i.test(t) ||
      /<prunable-tools>/i.test(t) ||
      /<message-id>/i.test(t) ||
      /<message-id-map/i.test(t) ||
      /<dcp-message-id>/i.test(t) ||
      /<OPENCODE_[A-Z_]+/i.test(t) ||
      /Global memory already persisted/i.test(t)
    );
  }

  function truncateFromEnd(value, max = AUTO_MAX_EVENT_TEXT) {
    if (typeof value !== 'string') return '';
    if (value.length <= max) return value;
    return `...${value.slice(value.length - max + 3)}`;
  }

  function isMemoryInjectionText(value) {
    const s = String(value || '');
    return /<OPENCODE_[A-Z_]+/i.test(s) || /<\/OPENCODE_[A-Z_]+>/i.test(s);
  }

  function stripMemoryInjectionMarkers(value) {
    const s = String(value || '');
    return s
      .split('\n')
      .filter((line) => !isMemoryInjectionText(line))
      .join('\n')
      .trim();
  }

  function isSummaryNoiseText(value) {
    const s = String(value || '');
    if (!s) return true;
    if (isMemoryInjectionText(s)) return true;
    if (isSkillBoilerplateUserText(s)) return true;
    return /EXTREMELY_IMPORTANT|using-superpowers|superpowers skill content|OpenCode Memory System|OPENCODE_KNOWLEDGE_BASE|我主要功能包括|我可以帮你完成以下任务|我的工具\/能力|我没有\"?插件\"?|I remember this skill|\[memory-system\]/i.test(s);
  }

  function sanitizeCompressedSummaryText(value) {
    let base = stripMemoryInjectionMarkers(String(value || ''));
    if (!base) return '';

    // Repair legacy summaries that were flattened into a single line.
    if (!base.includes('\n') && /## Structured Session Summary/i.test(base)) {
      base = base
        .replace(/\s-\swindow:/gi, '\n- window:')
        .replace(/\s-\skey facts:/gi, '\n- key facts:')
        .replace(/\s-\stool execution:/gi, '\n- tool execution:')
        .replace(/\s-\sdecisions\/constraints:/gi, '\n- decisions/constraints:')
        .replace(/\s-\stodo\/risks:/gi, '\n- todo/risks:')
        .replace(/\s## Structured Session Summary/gi, '\n## Structured Session Summary');
    }

    return base
      .split('\n')
      .filter((line) => {
        const text = normalizeText(line);
        if (!text) return false;
        if (/^## Structured Session Summary$/i.test(text)) return true;
        if (/^- (window|key facts|tool execution|decisions\/constraints|todo\/risks):/i.test(text)) return true;
        if (/^[- ]{0,2}(TODO:|RISK:)/i.test(text)) return true;
        if (isSummaryNoiseText(text)) return false;
        return true;
      })
      .join('\n')
      .trim();
  }

  function isCorruptedSummaryText(value) {
    const s = String(value || '');
    if (!s) return false;
    if (/<OPENCODE_[A-Z_]+/i.test(s)) return true;
    if (/EXTREMELY_IMPORTANT|using-superpowers|OPENCODE_KNOWLEDGE_BASE/i.test(s)) return true;
    if (!s.includes('\n') && /## Structured Session Summary/i.test(s)) return true;
    if ((s.match(/## Structured Session Summary/gi) || []).length >= 2) return true;
    return false;
  }

  function estimateTokensFromText(text) {
    const chars = String(text || '').length;
    if (chars <= 0) return 0;
    return Math.ceil(chars / 4);
  }

  function estimateSystemPromptTokens(systemParts = []) {
    if (!Array.isArray(systemParts) || !systemParts.length) {
      return { tokens: 0, lines: 0, preview: '', hash: '', fullText: '', fullChars: 0 };
    }
    const lines = systemParts
      .map((x) => normalizeText(String(x || '')))
      .filter(Boolean);
    const joined = lines.join('\n');
    return {
      tokens: estimateTokensFromText(joined),
      lines: lines.length,
      preview: truncateText(joined, 480),
      hash: stableTextHash(joined),
      fullText: truncateText(joined, getSystemPromptAuditMaxChars()),
      fullChars: joined.length
    };
  }

  function stableTextHash(value) {
    const s = String(value || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `h${(h >>> 0).toString(16)}`;
  }

  function extractUserEventIdentity(rawEvent) {
    return normalizeText(
      extractMessageID(rawEvent) ||
      rawEvent?.data?.id ||
      rawEvent?.data?.messageID ||
      rawEvent?.id ||
      ''
    );
  }

  function shouldSkipDuplicateUserEvent(sessionID, cleanText, rawEvent) {
    const identity = extractUserEventIdentity(rawEvent);
    const normalized = normalizeText(String(cleanText || ''));
    const eventType = normalizeText(String(rawEvent?.type || ''));
    const now = Date.now();
    let allowCorrection = false;

    const prevSessionState = sessionUserDedupeState.get(sessionID);
    if (prevSessionState) {
      const elapsed = now - Number(prevSessionState.at || 0);
      const sameType = eventType && prevSessionState.type && eventType === prevSessionState.type;
      const exactSameText = normalized && prevSessionState.text && normalized === prevSessionState.text;
      const nearSameText = normalized && prevSessionState.text && (
        normalized === prevSessionState.text ||
        normalized.startsWith(prevSessionState.text) ||
        prevSessionState.text.startsWith(normalized)
      );
      const semanticSameText = normalized && prevSessionState.text && areLikelySameUserText(normalized, prevSessionState.text);
      if (sameType && eventType === 'message.updated' && exactSameText && normalized.length >= 12 && elapsed < 30000) {
        return true;
      }
      if (sameType && eventType === 'message.updated' && nearSameText && Math.min(normalized.length, String(prevSessionState.text || '').length) >= 12 && elapsed < 10000) {
        return true;
      }
      if (
        sameType
        && eventType === 'message.updated'
        && semanticSameText
        && normalized.length < String(prevSessionState.text || '').length
        && elapsed < 45000
      ) {
        let hasAnsweredSincePreviousUser = false;
        if (isLikelySessionID(sessionID) && hasSessionMemoryFile(sessionID)) {
          try {
            const sessionData = loadSessionMemory(sessionID, getProjectName());
            const recent = Array.isArray(sessionData?.recentEvents) ? sessionData.recentEvents : [];
            for (let i = recent.length - 1; i >= 0; i -= 1) {
              const kind = String(recent[i]?.kind || '');
              if (kind === 'assistant-message' || kind === 'tool-result') {
                hasAnsweredSincePreviousUser = true;
                break;
              }
              if (kind === 'user-message') break;
            }
          } catch {
            hasAnsweredSincePreviousUser = false;
          }
        }
        if (hasAnsweredSincePreviousUser) return true;
      }
      if (elapsed < 15000) {
        if (identity && prevSessionState.identity && prevSessionState.identity === identity) {
          const currentIsCorrection = Boolean(
            normalized &&
            prevSessionState.text &&
            eventType === 'message.part.updated' &&
            prevSessionState.type === 'message.updated' &&
            normalized !== prevSessionState.text &&
            !isLowSignalUserText(normalized) &&
            !isMemoryInjectionText(normalized) &&
            !isSummaryNoiseText(normalized)
          );
          if (currentIsCorrection) allowCorrection = true;
          if (!currentIsCorrection) return true;
        }
        if (!identity && normalized && prevSessionState.text) {
          const a = prevSessionState.text;
          const b = normalized;
          const nearSame = a === b || a.includes(b) || b.includes(a);
          if (nearSame && elapsed < 3000) return true;
        }
      }
    }

    const fallback = cleanText ? stableTextHash(cleanText.slice(0, 240)) : '';
    const key = identity
      ? `${sessionID}:id:${identity}`
      : `${sessionID}:txt:${fallback}`;
    if (!key) return false;

    const prev = Number(processedUserEventKeys.get(key) || 0);
    if (prev && (now - prev) < 15000 && !allowCorrection) return true;
    processedUserEventKeys.set(key, now);
    sessionUserDedupeState.set(sessionID, { at: now, identity: identity || '', text: normalized, type: eventType || '' });

    if (processedUserEventKeys.size > 3000) {
      for (const [k, ts] of processedUserEventKeys.entries()) {
        if ((now - Number(ts || 0)) > 120000) processedUserEventKeys.delete(k);
      }
    }
    if (sessionUserDedupeState.size > 1000) {
      for (const [k, st] of sessionUserDedupeState.entries()) {
        if ((now - Number(st?.at || 0)) > 120000) sessionUserDedupeState.delete(k);
      }
    }
    return false;
  }

  function collapseAdjacentDuplicateUserEvents(sessionData, insertedIndex = -1) {
    if (!sessionData || !Array.isArray(sessionData.recentEvents)) return false;
    const idx = insertedIndex >= 0 ? insertedIndex : (sessionData.recentEvents.length - 1);
    if (idx <= 0 || idx >= sessionData.recentEvents.length) return false;
    const current = sessionData.recentEvents[idx] || {};
    const previous = sessionData.recentEvents[idx - 1] || {};
    if (String(current.kind || '') !== 'user-message' || String(previous.kind || '') !== 'user-message') return false;

    const currentSummary = normalizeText(String(current.summary || ''));
    const previousSummary = normalizeText(String(previous.summary || ''));
    if (!currentSummary || !previousSummary) return false;

    const nearSame = areLikelySameUserText(currentSummary, previousSummary);
    if (!nearSame) return false;
    if (Math.min(currentSummary.length, previousSummary.length) < 12) return false;

    const currentTs = Date.parse(current.ts || 0) || 0;
    const previousTs = Date.parse(previous.ts || 0) || 0;
    if (currentTs && previousTs && Math.abs(currentTs - previousTs) > 45000) return false;

    const currentType = normalizeText(String(current.eventType || ''));
    const previousType = normalizeText(String(previous.eventType || ''));
    const preferCurrentOverFallback = (
      currentType === 'message.updated' &&
      ['messages.transform.user-fallback', 'assistant.user-fallback'].includes(previousType)
    );

    if (preferCurrentOverFallback || currentSummary.length > previousSummary.length) {
      previous.summary = currentSummary;
      if (currentType === 'message.updated') previous.eventType = current.eventType;
    }

    sessionData.recentEvents.splice(idx, 1);
    sessionData.stats = sessionData.stats || emptyStats();
    sessionData.stats.userMessages = Math.max(0, Number(sessionData.stats.userMessages || 0) - 1);
    return true;
  }

  function collapseTransientInitialUserEvent(sessionData, sessionID = '', insertedIndex = -1) {
    if (!sessionData || !Array.isArray(sessionData.recentEvents)) return false;
    const idx = insertedIndex >= 0 ? insertedIndex : (sessionData.recentEvents.length - 1);
    if (idx <= 0 || idx >= sessionData.recentEvents.length) return false;
    const current = sessionData.recentEvents[idx] || {};
    const previous = sessionData.recentEvents[idx - 1] || {};
    if (String(current.kind || '') !== 'user-message' || String(previous.kind || '') !== 'user-message') return false;

    const currentSummary = normalizeText(String(current.summary || ''));
    const previousSummary = normalizeText(String(previous.summary || ''));
    if (!currentSummary || !previousSummary || currentSummary === previousSummary) return false;

    const currentType = normalizeText(String(current.eventType || ''));
    const previousType = normalizeText(String(previous.eventType || ''));
    if (previousType !== 'message.updated') return false;
    if (!['message.updated', 'message.part.updated'].includes(currentType)) return false;

    const currentTs = Date.parse(current.ts || 0) || 0;
    const previousTs = Date.parse(previous.ts || 0) || 0;
    if (currentTs && previousTs && Math.abs(currentTs - previousTs) > 5000) return false;

    const recentBeforeCurrent = sessionData.recentEvents.slice(0, idx + 1);
    if (recentBeforeCurrent.some((ev) => String(ev?.kind || '') === 'assistant-message')) return false;

    const title = normalizeText(String(sessionData.sessionTitle || ''));
    const titleMatchesPrevious = Boolean(
      title
      && (
        title === previousSummary
        || title.startsWith(previousSummary)
        || previousSummary.startsWith(title)
      )
    );
    const previousMatchesAnotherSessionTitle = referencesAnotherSessionTitle(previousSummary, sessionID || String(sessionData.sessionID || ''));
    if (!titleMatchesPrevious && !previousMatchesAnotherSessionTitle) return false;
    if (isLowSignalUserText(currentSummary) || isMemoryInjectionText(currentSummary) || isSummaryNoiseText(currentSummary)) return false;

    previous.summary = currentSummary;
    previous.ts = current.ts || previous.ts;
    previous.eventType = current.eventType || previous.eventType;
    sessionData.recentEvents.splice(idx, 1);
    sessionData.stats = sessionData.stats || emptyStats();
    sessionData.stats.userMessages = Math.max(0, Number(sessionData.stats.userMessages || 0) - 1);

    const derivedTitle = deriveSessionTitleFromEvents(sessionData);
    if (derivedTitle) sessionData.sessionTitle = derivedTitle;
    return true;
  }

  function reconcileExistingLatestUserMessage(sessionID, cleanText, rawEvent) {
    const normalized = normalizeText(String(cleanText || ''));
    if (!isLikelySessionID(sessionID) || !normalized) return false;
    if (!hasSessionMemoryFile(sessionID)) return false;

    const projectName = getProjectName();
    const sessionData = loadSessionMemory(sessionID, projectName);
    sessionData.recentEvents = Array.isArray(sessionData.recentEvents) ? sessionData.recentEvents : [];

    const currentType = normalizeText(String(rawEvent?.type || ''));
    let sawDifferentUserMessage = false;
    for (let i = sessionData.recentEvents.length - 1; i >= 0; i -= 1) {
      const ev = sessionData.recentEvents[i] || {};
      if (String(ev.kind || '') !== 'user-message') continue;
      const existingSummary = normalizeText(String(ev.summary || ''));
      const existingType = normalizeText(String(ev.eventType || ''));
      const nearSame = areLikelySameUserText(existingSummary, normalized);
      if (!nearSame) {
        sawDifferentUserMessage = true;
        continue;
      }
      if (sawDifferentUserMessage) return false;

      let mutated = false;
      if (
        currentType === 'message.updated' &&
        ['messages.transform.user-fallback', 'assistant.user-fallback'].includes(existingType) &&
        existingSummary !== normalized
      ) {
        ev.summary = normalized;
        mutated = true;
      }
      if (currentType === 'message.updated' && existingType !== 'message.updated') {
        ev.eventType = rawEvent.type;
        mutated = true;
      }

      const cwdFromEvent = extractSessionCwd(rawEvent);
      if (cwdFromEvent && normalizeText(String(sessionData.sessionCwd || '')) !== cwdFromEvent) {
        sessionData.sessionCwd = cwdFromEvent;
        mutated = true;
      }

      const titleFromEvent = extractSessionTitle(rawEvent);
      if (titleFromEvent && normalizeText(String(sessionData.sessionTitle || '')) !== titleFromEvent) {
        sessionData.sessionTitle = titleFromEvent;
        mutated = true;
      }

      if (mutated) {
        persistSessionMemory(sessionData, projectName);
        writeDashboardFiles();
      }
      return true;
    }

    return false;
  }

  function maybeMaterializeObservedUserTurnBeforeAssistant(sessionID, assistantText = '', rawEvent = null) {
    if (!isLikelySessionID(sessionID)) return false;
    if (!hasSessionMemoryFile(sessionID)) return false;

    const observedText = preferObservedUserText(
      String(sessionObservedUserTextByID.get(sessionID) || lastObservedUserText || '')
    );
    const observedAt = Number(sessionObservedUserAtByID.get(sessionID) || lastObservedUserAt || 0);
    if (!observedText || !observedAt) return false;
    if ((Date.now() - observedAt) > OBSERVED_USER_FALLBACK_MAX_AGE_MS) return false;
    if (isVisibleNoticeText(observedText)) return false;
    if (isLowSignalUserText(observedText) || isMemoryInjectionText(observedText) || isSummaryNoiseText(observedText)) return false;

    const assistantClean = normalizeText(String(assistantText || ''));
    if (!assistantClean || isVisibleNoticeText(assistantClean)) return false;

    const sessionData = loadSessionMemory(sessionID, getProjectName());
    const recent = Array.isArray(sessionData?.recentEvents) ? sessionData.recentEvents : [];
    let lastUserIndex = -1;
    let lastAssistantIndex = -1;
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const kind = String(recent[i]?.kind || '');
      if (lastUserIndex < 0 && kind === 'user-message') lastUserIndex = i;
      if (lastAssistantIndex < 0 && kind === 'assistant-message') lastAssistantIndex = i;
      if (lastUserIndex >= 0 && lastAssistantIndex >= 0) break;
    }
    const lastUserSummary = lastUserIndex >= 0
      ? normalizeText(String(recent[lastUserIndex]?.summary || ''))
      : '';
    if (lastUserIndex > lastAssistantIndex && areLikelySameUserText(lastUserSummary, observedText)) return false;

    const fallbackEvent = {
      ...(rawEvent || {}),
      type: 'assistant.user-fallback'
    };
    if (shouldSkipDuplicateUserEvent(sessionID, observedText, fallbackEvent)) return false;

    sessionLatestUserTextByID.set(sessionID, observedText);
    sessionObservedUserTextByID.set(sessionID, observedText);
    appendAutoEvent({
      sessionID,
      kind: 'user-message',
      summary: observedText,
      rawEvent: fallbackEvent
    });
    return true;
  }

  function partTextForPretrim(part) {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return normalizeText(part.text);
    if (typeof part.content === 'string') return normalizeText(part.content);
    if (typeof part.output === 'string') return normalizeText(part.output);
    if (part.type === 'tool' && part.state && typeof part.state === 'object') {
      return normalizeText(
        [
          safeJsonPreview(part.state.input, 160),
          typeof part.state.output === 'string' ? part.state.output : safeJsonPreview(part.state.output, 220),
          typeof part.state.error === 'string' ? part.state.error : safeJsonPreview(part.state.error, 120)
        ].filter(Boolean).join(' ')
      );
    }
    return '';
  }

  function partToolNameForPretrim(part, text = '') {
    if (!part || typeof part !== 'object') return '';
    const direct = normalizeText(String(part.tool || part.name || ''));
    if (direct) return direct.toLowerCase();
    const m = String(text || '').match(/^\[([^\]]+)\]/);
    return m?.[1] ? normalizeText(m[1]).toLowerCase() : '';
  }

  function isProtectedToolForPretrim(part, text = '') {
    const tool = partToolNameForPretrim(part, text);
    if (!tool) return false;
    return AUTO_SEND_PRETRIM_PROTECTED_TOOLS.some((t) => tool.includes(String(t).toLowerCase()));
  }

  function isStrategyProtectedToolName(toolName = '') {
    const t = normalizeText(String(toolName || '')).toLowerCase();
    if (!t) return false;
    return AUTO_STRATEGY_PROTECTED_TOOLS.some((x) => t.includes(String(x).toLowerCase()));
  }

  function stableValueSignature(value, depth = 0) {
    if (depth > 5) return '"[depth-limit]"';
    if (value === null || value === undefined) return String(value);
    const t = typeof value;
    if (t === 'number' || t === 'boolean') return String(value);
    if (t === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => stableValueSignature(v, depth + 1)).join(',')}]`;
    if (t === 'object') {
      const keys = Object.keys(value).sort();
      const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableValueSignature(value[k], depth + 1)}`);
      return `{${pairs.join(',')}}`;
    }
    return JSON.stringify(String(value));
  }

  function extractToolInputForStrategy(part) {
    if (!part || typeof part !== 'object') return {};
    if (part?.state && typeof part.state === 'object' && part.state.input !== undefined) return part.state.input;
    if (part.input !== undefined) return part.input;
    if (part.parameters !== undefined) return part.parameters;
    return {};
  }

  function extractPathCandidatesFromInput(input) {
    const out = [];
    const visit = (v, depth = 0, key = '') => {
      if (depth > 4 || v === null || v === undefined) return;
      if (typeof v === 'string') {
        const k = normalizeText(String(key || '')).toLowerCase();
        if (k.includes('path') || k.includes('file') || v.startsWith('/') || /^[a-zA-Z]:\\/.test(v)) {
          const n = normalizeText(v);
          if (n && !out.includes(n)) out.push(n);
        }
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((x) => visit(x, depth + 1, key));
        return;
      }
      if (typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) visit(val, depth + 1, k);
      }
    };
    visit(input, 0, '');
    return out.slice(0, 8);
  }

  function applyAutomaticStrategies(messages, policy = null) {
    const stats = { dedup: 0, supersedeWrites: 0, purgedErrors: 0, phaseTrim: 0 };
    if (!Array.isArray(messages) || !messages.length) return stats;
    const turnProtection = Math.max(1, Number(policy?.turnProtection || getSendPretrimTurnProtection()));
    const protectFrom = getProtectFromByUserTurns(messages, turnProtection, 8);

    // Strategy 1: deduplicate identical tool calls, keep latest output.
    if (AUTO_STRATEGY_DEDUP_ENABLED) {
      const latestBySig = new Map();
      for (let i = 0; i < messages.length; i += 1) {
        if (i >= protectFrom) continue;
        const msg = messages[i];
        const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
        if (!Array.isArray(msg?.parts) || role === 'system' || role === 'user') continue;
        for (let j = 0; j < msg.parts.length; j += 1) {
          const part = msg.parts[j];
          if (!part || part.type !== 'tool') continue;
          const tool = partToolNameForPretrim(part);
          if (!tool || isStrategyProtectedToolName(tool)) continue;
          const sig = `${tool}|${stableValueSignature(extractToolInputForStrategy(part))}`;
          latestBySig.set(sig, { i, j });
        }
      }
      for (let i = 0; i < messages.length; i += 1) {
        if (i >= protectFrom) continue;
        const msg = messages[i];
        const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
        if (!Array.isArray(msg?.parts) || role === 'system' || role === 'user') continue;
        for (let j = 0; j < msg.parts.length; j += 1) {
          const part = msg.parts[j];
          if (!part || part.type !== 'tool') continue;
          const tool = partToolNameForPretrim(part);
          if (!tool || isStrategyProtectedToolName(tool)) continue;
          const sig = `${tool}|${stableValueSignature(extractToolInputForStrategy(part))}`;
          const latest = latestBySig.get(sig);
          if (!latest || latest.i === i && latest.j === j) continue;
          part.state = part.state && typeof part.state === 'object' ? part.state : {};
          const replacement = '[pretrim-dedup: superseded by latest identical tool call]';
          if (part.state.output !== replacement) {
            part.state.output = replacement;
            if (part.state.error) part.state.error = '';
            stats.dedup += 1;
          }
        }
      }
    }

    // Strategy 2: supersede writes if file is read later.
    if (AUTO_STRATEGY_SUPERSEDE_WRITES_ENABLED) {
      const seenReadPaths = new Set();
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
        if (!Array.isArray(msg?.parts) || role === 'system' || role === 'user') continue;
        for (const part of msg.parts) {
          if (!part || part.type !== 'tool') continue;
          const tool = partToolNameForPretrim(part);
          if (!tool || isStrategyProtectedToolName(tool)) continue;
          const input = extractToolInputForStrategy(part);
          const paths = extractPathCandidatesFromInput(input);
          const isRead = /(^|[_-])(read|cat|list|ls|get|open)([_-]|$)/i.test(tool);
          const isWrite = /(^|[_-])(write|edit|update|patch|append|save)([_-]|$)/i.test(tool);
          if (isRead) {
            paths.forEach((p) => seenReadPaths.add(p));
            continue;
          }
          if (i >= protectFrom || !isWrite || !paths.length) continue;
          const hit = paths.some((p) => seenReadPaths.has(p));
          if (!hit) continue;
          part.state = part.state && typeof part.state === 'object' ? part.state : {};
          const replacement = '[pretrim-supersede: write output replaced after later read of same path]';
          if (part.state.output !== replacement) {
            part.state.output = replacement;
            if (part.state.error) part.state.error = '';
            stats.supersedeWrites += 1;
          }
        }
      }
    }

    // Strategy 3: purge errored tool inputs after N user turns.
    if (AUTO_STRATEGY_PURGE_ERRORS_ENABLED) {
      const userSuffix = new Array(messages.length + 1).fill(0);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const role = normalizeText(String(messages[i]?.info?.role || '')).toLowerCase();
        userSuffix[i] = userSuffix[i + 1] + (role === 'user' ? 1 : 0);
      }
      for (let i = 0; i < messages.length; i += 1) {
        if (i >= protectFrom) continue;
        const msg = messages[i];
        const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
        if (!Array.isArray(msg?.parts) || role === 'system' || role === 'user') continue;
        const turnsAfter = userSuffix[i + 1] || 0;
        if (turnsAfter < getStrategyPurgeErrorTurns()) continue;
        for (const part of msg.parts) {
          if (!part || part.type !== 'tool') continue;
          const tool = partToolNameForPretrim(part);
          if (!tool || isStrategyProtectedToolName(tool)) continue;
          part.state = part.state && typeof part.state === 'object' ? part.state : {};
          const hasError = Boolean(normalizeText(String(part.state.error || '')));
          if (!hasError) continue;
          const inputText = safeJsonPreview(part.state.input, 300);
          if (!inputText || inputText.length < 80) continue;
          const replacement = '[pretrim-purgeErrors: tool input removed after error aging]';
          if (part.state.input !== replacement) {
            part.state.input = replacement;
            stats.purgedErrors += 1;
          }
        }
      }
    }

    // Strategy 4: phase-aware trimming when over budget.
    if (Boolean(policy?.phaseTrimEnabled)) {
      for (let i = 0; i < messages.length; i += 1) {
        if (i >= protectFrom) continue;
        const msg = messages[i];
        const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
        if (!Array.isArray(msg?.parts) || role === 'system' || role === 'user') continue;
        for (const part of msg.parts) {
          if (!part || part.type !== 'tool') continue;
          const tool = partToolNameForPretrim(part);
          if (!tool || isStrategyProtectedToolName(tool)) continue;
          const phase = toolPhaseOf(tool);
          if (phase === 'modify') continue; // keep modify outputs conservatively
          part.state = part.state && typeof part.state === 'object' ? part.state : {};
          const existing = normalizeText(String(part.state.output || ''));
          if (!existing || existing.includes('pretrim-phase-trim')) continue;
          const replacement = `[pretrim-phase-trim:${phase}] output compacted by adaptive policy`;
          part.state.output = replacement;
          if (part.state.error && phase !== 'verify') part.state.error = '';
          stats.phaseTrim += 1;
        }
      }
    }

    return stats;
  }

  function isToolDefinitionLikeText(text) {
    const t = normalizeText(String(text || ''));
    if (!t || t.length < 120) return false;
    const jsonSchemaLike = /"type"\s*:\s*"object"/i.test(t) && /"properties"\s*:/i.test(t) && /"required"\s*:/i.test(t);
    const toolMetaLike = /tool\.definition|parameters|description/i.test(t) && /"properties"\s*:/i.test(t);
    return jsonSchemaLike || toolMetaLike;
  }

  function isLowSignalPartForPretrim(part, text = '') {
    const t = normalizeText(String(text || ''));
    if (!t) return false;
    if (isMemoryInjectionText(t) || isSummaryNoiseText(t)) return false;
    if (isToolDefinitionLikeText(t)) return false;
    if (isHighSignalToolSummary(t)) return false;
    if (part && part.type === 'tool' && isDiscardableToolSummary(t)) return true;
    if (/"status":"pending"|"status":"running"|\bpending\b|\brunning\b/i.test(t)) return true;
    if (/^\[.*?\]\s*input=\{\}\s*output=\{\s*"?status"?\s*:\s*"?(pending|running)/i.test(t)) return true;
    if (/tool call|tool result|debug trace|stack trace/i.test(t) && t.length > 240) return true;
    return false;
  }

  function estimateOutgoingMessagesTokens(messages) {
    if (!Array.isArray(messages)) return 0;
    let total = 0;
    for (const msg of messages) {
      const role = normalizeText(String(msg?.info?.role || msg?.role || '')).toLowerCase();
      total += estimateTokensFromText(role);
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];
      for (const part of parts) total += estimateTokensFromText(partTextForPretrim(part));
    }
    return total;
  }

  function estimateInjectedHintTokens(messages) {
    if (!Array.isArray(messages) || !messages.length) return 0;
    let total = 0;
    for (const msg of messages) {
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];
      for (const part of parts) {
        if (!part || part.type !== 'text' || !part.synthetic) continue;
        total += estimateTokensFromText(String(part.text || ''));
      }
    }
    return total;
  }

  function countCompletedToolParts(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return 0;
    let total = 0;
    for (const msg of messages) {
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];
      for (const part of parts) {
        if (!part || part.type !== 'tool') continue;
        const status = normalizeText(String(part?.state?.status || ''));
        if (status === 'completed' || status === 'error') total += 1;
      }
    }
    return total;
  }

  function shouldInjectProtocolHints(messages = [], beforeTokens = 0) {
    if (!Array.isArray(messages) || !messages.length) return false;
    const budget = Math.max(1, getSendPretrimBudget());
    const ratioLine = Math.max(
      200,
      Math.floor(
        budget * Math.max(0.65, Math.min(0.95, Number(getSendPretrimDistillTriggerRatio() || 0.8)))
      )
    );
    const toolCount = countCompletedToolParts(messages);
    return beforeTokens >= ratioLine || toolCount >= 6;
  }

  function getAdaptivePretrimPolicy(beforeTokens) {
    const profile = getPretrimProfile();
    const ratio = beforeTokens > 0 ? beforeTokens / Math.max(1, getSendPretrimBudget()) : 0;
    let turnProtectionBase = getSendPretrimTurnProtection();
    let t1 = 1.05;
    let t2 = 1.25;
    let phaseTrimAt = 1.0;
    let maxRewriteL0 = getSendPretrimMaxRewriteMessages();
    let maxRewriteL1 = 36;
    let maxRewriteL2 = 48;
    if (profile === 'conservative') {
      turnProtectionBase = 6;
      t1 = 1.15;
      t2 = 1.45;
      phaseTrimAt = 1.15;
      maxRewriteL0 = 20;
      maxRewriteL1 = 28;
      maxRewriteL2 = 36;
    } else if (profile === 'aggressive') {
      turnProtectionBase = 3;
      t1 = 0.95;
      t2 = 1.15;
      phaseTrimAt = 0.95;
      maxRewriteL0 = 36;
      maxRewriteL1 = 48;
      maxRewriteL2 = 64;
    }
    let level = 0;
    if (ratio >= t2) level = 2;
    else if (ratio >= t1) level = 1;
    const turnProtection = Math.max(2, turnProtectionBase - (profile === 'aggressive' ? level : 0));
    const maxRewriteMessages = level === 2 ? maxRewriteL2 : level === 1 ? maxRewriteL1 : maxRewriteL0;
    return {
      profile,
      level,
      ratio,
      turnProtection,
      maxRewriteMessages,
      phaseTrimEnabled: ratio >= phaseTrimAt
    };
  }

  function computeOutgoingTokenComposition(messages) {
    const out = { system: 0, user: 0, assistant: 0, tool: 0, other: 0, total: 0 };
    if (!Array.isArray(messages)) return out;
    for (const msg of messages) {
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];
      const roleToken = estimateTokensFromText(role);
      out.total += roleToken;
      if (role === 'system') out.system += roleToken;
      else if (role === 'user') out.user += roleToken;
      else if (role === 'assistant') out.assistant += roleToken;
      else out.other += roleToken;
      for (const part of parts) {
        const textToken = estimateTokensFromText(partTextForPretrim(part));
        out.total += textToken;
        if (part?.type === 'tool') out.tool += textToken;
        else if (role === 'system') out.system += textToken;
        else if (role === 'user') out.user += textToken;
        else if (role === 'assistant') out.assistant += textToken;
        else out.other += textToken;
      }
    }
    return out;
  }

  function toolPhaseOf(toolName = '') {
    const t = normalizeText(String(toolName || '')).toLowerCase();
    if (!t) return 'other';
    if (/(read|list|ls|get|open|find|search|glob|ripgrep|grep)/i.test(t)) return 'discovery';
    if (/(write|edit|update|patch|append|save|create)/i.test(t)) return 'modify';
    if (/(test|pytest|lint|check|validate|build|compile|run)/i.test(t)) return 'verify';
    if (/(fetch|http|request|browser|playwright|web|tavily)/i.test(t)) return 'network';
    return 'other';
  }

  function applyAnchorBlockReplacement(messages, sessionID, protectFrom) {
    const result = { applied: false, replacedMessages: 0, usedBlocks: 0 };
    if (!sessionID || !Array.isArray(messages) || messages.length < 8) return result;
    if (!hasSessionMemoryFile(sessionID)) return result;
    const mem = loadSessionMemory(sessionID);
    const blocks = ensureSummaryBlocks(mem);
    if (!Array.isArray(blocks) || !blocks.length) return result;
    const refs = blocks.slice(-3).map((b) => `b${Number(b?.blockId || 0)}`).filter(Boolean);
    if (!refs.length) return result;
    const anchorLines = [
      '[pretrim-anchor-replace]',
      `compressed blocks in effect: ${refs.join(' ')}`,
      'use these blocks as canonical historical context; older raw traces are replaced to reduce tokens.'
    ];
    const anchor = truncateText(anchorLines.join('\n'), 420);
    const placeholder = '[pretrim-anchor-replaced by compressed blocks]';
    const candidateIdx = [];
    for (let i = 0; i < messages.length; i += 1) {
      if (i >= protectFrom) continue;
      const msg = messages[i];
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      if (role === 'system' || role === 'user') continue;
      if (!Array.isArray(msg?.parts) || !msg.parts.length) continue;
      candidateIdx.push(i);
    }
    if (candidateIdx.length < 2) return result;
    const first = candidateIdx[0];
    messages[first].parts = [{ type: 'text', text: anchor }];
    for (const idx of candidateIdx.slice(1)) {
      messages[idx].parts = [{ type: 'text', text: placeholder }];
      result.replacedMessages += 1;
    }
    result.applied = true;
    result.usedBlocks = refs.length;
    return result;
  }

  function inferSessionIDFromMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const sid = normalizeText(String(messages[i]?.info?.sessionID || messages[i]?.info?.sessionId || ''));
      if (sid && isLikelySessionID(sid)) return sid;
    }
    return '';
  }

  function getProtectFromByUserTurns(messages, userTurns = 4, minRecentMessages = 8) {
    if (!Array.isArray(messages) || !messages.length) return 0;
    const turns = Math.max(1, Number(userTurns || 4));
    const keepRecent = Math.max(1, Number(minRecentMessages || 1));
    const fallbackProtectFrom = Math.max(0, messages.length - keepRecent);
    let userSeen = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const role = normalizeText(String(messages[i]?.info?.role || '')).toLowerCase();
      if (role !== 'user') continue;
      userSeen += 1;
      if (userSeen >= turns) {
        return Math.max(0, Math.min(i, fallbackProtectFrom));
      }
    }
    // If the session has not yet accumulated enough user turns, still allow
    // older messages outside the recent-protection window to be rewritten.
    return fallbackProtectFrom;
  }

  function extractMessageIDFromOutgoing(msg) {
    if (!msg || typeof msg !== 'object') return '';
    return normalizeText(
      String(
        msg?.info?.id ||
        msg?.info?.messageID ||
        msg?.id ||
        ''
      )
    );
  }

  function inferLatestUserMessageID(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const role = normalizeText(String(messages[i]?.info?.role || '')).toLowerCase();
      if (role !== 'user') continue;
      const mid = extractMessageIDFromOutgoing(messages[i]);
      if (mid) return mid;
    }
    return '';
  }

  function inferLatestUserText(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return '';
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      if (role !== 'user') continue;
      const chunks = [];
      if (Array.isArray(msg?.parts)) {
        for (const part of msg.parts) {
          const text = partTextForPretrim(part);
          if (!text || isMemoryInjectionText(text)) continue;
          chunks.push(text);
        }
      }
      const joined = preferObservedUserText(chunks.join('\n'));
      if (joined && !isLowSignalUserText(joined)) return joined;
      const candidates = [
        msg?.text,
        msg?.content,
        msg?.message,
        msg?.prompt,
        msg?.input
      ];
      for (const c of candidates) {
        const t = preferObservedUserText(typeof c === 'string' ? c : safeJsonPreview(c, 1200));
        if (!t || isMemoryInjectionText(t) || isLowSignalUserText(t)) continue;
        return t;
      }
    }
    return '';
  }

  function inferLatestUserTextFromTransformInput(input = {}) {
    const containerCandidates = [];
    if (Array.isArray(input?.messages)) containerCandidates.push(input.messages);
    if (Array.isArray(input?.history)) containerCandidates.push(input.history);
    if (Array.isArray(input?.conversation)) containerCandidates.push(input.conversation);
    for (const arr of containerCandidates) {
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        const msg = arr[i] || {};
        const role = normalizeText(String(msg?.role || msg?.info?.role || '')).toLowerCase();
        if (role !== 'user') continue;
        const text = preferObservedUserText(
          typeof msg?.content === 'string'
            ? msg.content
            : (typeof msg?.text === 'string'
              ? msg.text
              : safeJsonPreview(msg, 1600))
        );
        if (!text || isLowSignalUserText(text)) continue;
        return text;
      }
    }
    const candidates = [
      input?.text,
      input?.prompt,
      input?.content,
      input?.message,
      input?.userMessage,
      input?.input,
      input?.data?.text,
      input?.data?.content,
      input?.data?.message
    ];
    for (const c of candidates) {
      const t = preferObservedUserText(typeof c === 'string' ? c : safeJsonPreview(c, 1200));
      if (!t || isLowSignalUserText(t)) continue;
      return t;
    }
    const wholeRaw = safeJsonPreview(input, 5000);
    const likelyDirective = extractLikelyDirectiveFromRaw(wholeRaw);
    if (likelyDirective) return likelyDirective;
    const whole = preferObservedUserText(wholeRaw);
    if (whole && !isLowSignalUserText(whole)) return whole;
    return '';
  }

  function extractLikelyDirectiveFromRaw(raw = '') {
    const text = normalizeText(String(raw || ''));
    if (!text) return '';
    const patterns = [
      /(?:请你|请)?(?:把|将)[^。\n]{1,280}?(?:写入|保存到?|记录到?)(?:全局记忆|全局偏好|长期记忆|永久记忆)[^。\n]{0,120}/i,
      /(?:全局记住|全局写入|全局保存|永远记住|持续记忆|永久记忆)[^。\n]{1,260}/i,
      /(?:请你|请)?记住[^。\n]{1,260}/i,
      /(?:另一个会话|上一个会话|之前会话|previous session|another chat)[^。\n]{1,260}/i
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (!m || !m[0]) continue;
      const picked = sanitizeUserTextForMemoryInference(m[0]);
      if (picked) return picked;
    }
    return '';
  }


  function inferSessionModelFromMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return { providerID: '', modelID: '' };
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i]?.info || {};
      const providerID = normalizeText(String(info?.model?.providerID || info?.providerID || ''));
      const modelID = normalizeText(String(info?.model?.modelID || info?.modelID || ''));
      if (providerID || modelID) return { providerID, modelID };
    }
    return { providerID: '', modelID: '' };
  }

  function collectDistillSnippetsFromMessage(msg) {
    if (!msg || !Array.isArray(msg.parts)) return [];
    const lines = [];
    for (const part of msg.parts) {
      const text = partTextForPretrim(part);
      if (!text) continue;
      if (isProtectedToolForPretrim(part, text) || isToolDefinitionLikeText(text)) return [];
      if (isMemoryInjectionText(text) || isSummaryNoiseText(text)) continue;
      lines.push(truncateText(text, 220));
      if (lines.length >= 2) break;
    }
    return lines;
  }

  function selectDistillCandidateRange(messages, protectFrom) {
    if (!Array.isArray(messages) || !messages.length) {
      return { indices: [], items: [] };
    }
    const candidates = [];
    for (let i = 0; i < messages.length; i += 1) {
      if (i >= protectFrom) continue;
      const msg = messages[i];
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      if (!msg || !Array.isArray(msg.parts) || !msg.parts.length) continue;
      if (role === 'system' || role === 'user') continue;
      const snippets = collectDistillSnippetsFromMessage(msg);
      if (!snippets.length) continue;

      let score = 0;
      const joined = snippets.join('\n');
      if (/pass|ok|saved|created|wrote|fixed|完成|已生成|已写入/i.test(joined)) score += 4;
      if (/fail|error|exception|报错|失败|阻塞/i.test(joined)) score += 3;
      if (extractPathsFromTextLoose(joined).length) score += 2;
      if (/pending|running/i.test(joined)) score -= 3;
      score += Math.max(0, Math.floor((protectFrom - i) / 12));

      candidates.push({ idx: i, role, snippets, score });
    }

    if (candidates.length < getDistillRangeMinMessages()) {
      return { indices: [], items: [] };
    }

    let best = null;
    for (let s = 0; s < candidates.length; s += 1) {
      let scoreSum = 0;
      let count = 0;
      let prevIdx = -1000;
      const idxs = [];
      const items = [];
      for (let e = s; e < candidates.length; e += 1) {
        const cur = candidates[e];
        if (count > 0 && cur.idx - prevIdx > 4) break;
        prevIdx = cur.idx;
        scoreSum += cur.score;
        count += 1;
        idxs.push(cur.idx);
        items.push({ role: cur.role, snippets: cur.snippets });
        if (count >= getDistillRangeMaxMessages()) break;
      }
      if (count < getDistillRangeMinMessages()) continue;
      const value = scoreSum + count * 2;
      if (!best || value > best.value) {
        best = { value, indices: idxs, items };
      }
    }

    if (!best) return { indices: [], items: [] };
    return { indices: best.indices, items: best.items };
  }

  function getActiveSummaryTemplateTextForLLM() {
    let settings = {};
    try {
      const raw = fs.readFileSync(globalMemoryPath, 'utf8');
      const gm = JSON.parse(raw || '{}');
      settings = (gm && gm.preferences && typeof gm.preferences === 'object') ? gm.preferences : {};
    } catch {
      settings = {};
    }
    const readAlias = (aliases, fallback) => {
      for (const k of aliases) {
        if (Object.prototype.hasOwnProperty.call(settings, k)) return settings[k];
      }
      return fallback;
    };
    const activeTemplateName = normalizeText(String(readAlias(['activeSummaryTemplateName', 'active_summary_template_name'], '')));
    const templateStore = readAlias(['summaryTemplates', 'summary_templates'], {});
    let customTpl = '';
    if (templateStore && typeof templateStore === 'object' && !Array.isArray(templateStore)) {
      const store = templateStore;
      if (activeTemplateName && typeof store[activeTemplateName] === 'string') customTpl = normalizeText(String(store[activeTemplateName]));
      if (!customTpl && typeof store.default === 'string') customTpl = normalizeText(String(store.default));
    }
    if (!customTpl) customTpl = normalizeText(String(readAlias(['summaryTemplateText', 'summary_template_text'], '')));
    if (!customTpl) return '';
    return truncateText(customTpl, 1200);
  }

  function buildDistillPrompt(candidateItems, maxChars = getDistillSummaryMaxChars()) {
    const cleanItems = Array.isArray(candidateItems) ? candidateItems : [];
    const payload = cleanItems.map((it, idx) => {
      const role = normalizeText(String(it?.role || 'assistant')).toLowerCase() || 'assistant';
      const snippets = Array.isArray(it?.snippets) ? it.snippets : [];
      return `${idx + 1}. role=${role}\n${snippets.map((s) => `- ${s}`).join('\n')}`;
    }).join('\n\n');
    const template = getActiveSummaryTemplateTextForLLM();
    const templateBlock = template
      ? `\nPreferred output template (fill with best-effort content, keep concise):\n${template}\n`
      : '';

    return [
      'You are compressing historical chat context for token saving.',
      'Goal: preserve outcomes and actionable facts while removing noisy history.',
      `Output constraints: plain text only, <= ${maxChars} characters, Chinese preferred when source is Chinese.`,
      'Required sections:',
      '1) Completed outcomes',
      '2) Key files/paths',
      '3) Decisions/constraints',
      '4) Open risks/next steps',
      'Do not include tool schema definitions, pending/running logs, or duplicated traces.',
      templateBlock,
      '',
      'Source snippets:',
      payload
    ].join('\n');
  }

  function extractPathsFromTextLoose(text) {
    const t = String(text || '');
    if (!t) return [];
    const unix = t.match(/(?:^|[\s"'`])((?:\/[^\s"'`<>|]+)+)/g) || [];
    const win = t.match(/[A-Za-z]:\\[^\s"'`<>|]+/g) || [];
    const out = [];
    for (const m of [...unix, ...win]) {
      const cleaned = normalizeText(String(m).replace(/^[\s"'`]+/, '').replace(/[\s"'`]+$/, ''));
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
      if (out.length >= 8) break;
    }
    return out;
  }

  function evaluateDistillSummaryQuality(summary, sourceItems = []) {
    const text = normalizeText(String(summary || ''));
    if (!text) return { ok: false, reason: 'empty' };
    if (text.length < 80) return { ok: false, reason: 'too_short' };
    if (/pending|running|debug trace|stack trace/i.test(text) && text.length < 220) {
      return { ok: false, reason: 'noisy_or_shallow' };
    }
    const sectionHits = [
      /完成|结果|outcome|done|fixed/i.test(text),
      /路径|文件|file|path/i.test(text),
      /约束|决定|constraint|decision/i.test(text),
      /风险|下一步|next|todo/i.test(text)
    ].filter(Boolean).length;
    if (sectionHits < 2) return { ok: false, reason: 'missing_structure' };

    const sourcePaths = [];
    for (const it of Array.isArray(sourceItems) ? sourceItems : []) {
      for (const s of Array.isArray(it?.snippets) ? it.snippets : []) {
        for (const p of extractPathsFromTextLoose(s)) {
          if (!sourcePaths.includes(p)) sourcePaths.push(p);
          if (sourcePaths.length >= 6) break;
        }
        if (sourcePaths.length >= 6) break;
      }
      if (sourcePaths.length >= 6) break;
    }
    if (sourcePaths.length) {
      const summaryPaths = extractPathsFromTextLoose(text);
      const hasPathOverlap = summaryPaths.some((p) => sourcePaths.some((sp) => p.includes(sp) || sp.includes(p)));
      if (!hasPathOverlap) return { ok: false, reason: 'missing_key_path' };
    }
    return { ok: true, reason: 'ok' };
  }

  function extractDistillTextFromResponse(provider, json) {
    if (!json || typeof json !== 'object') return '';
    const p = normalizeText(String(provider || '')).toLowerCase();
    if (p === 'openai_compatible') {
      const c0 = json?.choices?.[0]?.message?.content;
      if (typeof c0 === 'string') return normalizeText(c0);
      if (Array.isArray(c0)) {
        return normalizeText(c0.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' '));
      }
      return '';
    }
    if (p === 'anthropic') {
      const arr = Array.isArray(json?.content) ? json.content : [];
      return normalizeText(arr.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' '));
    }
    if (p === 'gemini') {
      const arr = Array.isArray(json?.candidates) ? json.candidates : [];
      const parts = arr.flatMap((c) => Array.isArray(c?.content?.parts) ? c.content.parts : []);
      return normalizeText(parts.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' '));
    }
    return '';
  }

  async function runIndependentDistillLLM(messages, candidateItems, overrideConfig = null) {
    const cfg = overrideConfig && typeof overrideConfig === 'object'
      ? { ...getIndependentDistillConfig(), ...overrideConfig }
      : getIndependentDistillConfig();
    if (!canUseIndependentDistill(cfg)) return { ok: false, reason: 'disabled_or_incomplete_config', text: '' };
    const sessionModel = inferSessionModelFromMessages(messages);
    const model = normalizeText(
      cfg.model || (cfg.useSessionModel ? String(sessionModel.modelID || '') : '')
    );
    if (!model) return { ok: false, reason: 'missing_model', text: '' };

    const prompt = buildDistillPrompt(candidateItems, getDistillSummaryMaxChars());
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      let url = cfg.baseURL.replace(/\/+$/, '');
      let body = {};
      let headers = {};
      const temperature = Math.max(0, Math.min(1, Number(cfg.temperature || 0.2)));
      if (cfg.provider === 'anthropic') {
        url = `${url}/v1/messages`;
        headers = {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        };
        body = {
          model,
          max_tokens: cfg.maxTokens,
          temperature,
          messages: [{ role: 'user', content: prompt }]
        };
      } else if (cfg.provider === 'gemini') {
        url = `${url}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
        headers = { 'content-type': 'application/json' };
        body = {
          generationConfig: {
            maxOutputTokens: cfg.maxTokens,
            temperature
          },
          contents: [{ role: 'user', parts: [{ text: prompt }] }]
        };
      } else {
        url = `${url}/chat/completions`;
        headers = {
          'content-type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        };
        body = {
          model,
          temperature,
          max_tokens: cfg.maxTokens,
          messages: [
            { role: 'system', content: 'You are a high-fidelity context distiller.' },
            { role: 'user', content: prompt }
          ]
        };
      }

      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const raw = await resp.text();
      if (!resp.ok) {
        return { ok: false, reason: `http_${resp.status}`, text: '', provider: cfg.provider, model };
      }
      let json = {};
      try { json = JSON.parse(raw); } catch { return { ok: false, reason: 'non_json_response', text: '', provider: cfg.provider, model }; }
      const text = truncateText(extractDistillTextFromResponse(cfg.provider, json), getDistillSummaryMaxChars());
      if (!text) return { ok: false, reason: 'empty_text', text: '', provider: cfg.provider, model };
      return { ok: true, reason: 'ok', text, provider: cfg.provider, model };
    } catch (err) {
      const msg = String(err?.name === 'AbortError' ? 'timeout' : (err?.message || err || 'unknown_error'));
      return { ok: false, reason: msg, text: '', provider: cfg.provider, model };
    } finally {
      clearTimeout(timeout);
    }
  }

  function buildDistillSourceHash(sourceItems = []) {
    const compact = (Array.isArray(sourceItems) ? sourceItems : []).map((it, idx) => ({
      i: idx + 1,
      role: normalizeText(String(it?.role || 'assistant')).toLowerCase(),
      snippets: (Array.isArray(it?.snippets) ? it.snippets : [])
        .map((s) => truncateText(normalizeText(String(s || '')), 160))
        .filter(Boolean)
        .slice(0, 3)
    }));
    return stableTextHash(JSON.stringify(compact));
  }

  function buildWarmupSummaryText(warmup = {}, predictedBlockId = 0) {
    const text = truncateText(String(warmup?.summary || '').trim(), getDistillSummaryMaxChars());
    if (!text) return '';
    const bid = Number(predictedBlockId || 0) > 0 ? ` b${Number(predictedBlockId || 0)}` : '';
    const mode = String(warmup?.mode || 'llm');
    const tag = mode === 'llm' ? `[pretrim-distill-warmup${bid}]` : `[pretrim-extract-warmup${bid}]`;
    return `${tag}\n${text}`;
  }

  function getWarmupCacheHit(sessionData, sourceHash = '', lastUserMessageID = '') {
    const sp = ensureSendPretrim(sessionData);
    const warm = sp?.warmup && typeof sp.warmup === 'object' ? sp.warmup : null;
    if (!warm) return null;
    if (!sourceHash || String(warm.sourceHash || '') !== String(sourceHash || '')) return null;
    if (lastUserMessageID && String(warm.lastUserMessageID || '') && String(warm.lastUserMessageID || '') !== String(lastUserMessageID || '')) return null;
    const ts = Date.parse(String(warm.preparedAt || '')) || 0;
    if (!ts || (Date.now() - ts) > AUTO_SEND_PRETRIM_WARMUP_MAX_AGE_MS) return null;
    const summary = buildWarmupSummaryText(warm);
    if (!summary) return null;
    return { ...warm, summary };
  }

  function markWarmupPrepared(sessionData, payload = {}) {
    const sp = ensureSendPretrim(sessionData);
    const cur = sp?.warmup && typeof sp.warmup === 'object' ? sp.warmup : {};
    sp.warmup = {
      sourceHash: String(payload.sourceHash || cur.sourceHash || ''),
      summary: truncateText(String(payload.summary || cur.summary || '').trim(), getDistillSummaryMaxChars()),
      mode: String(payload.mode || cur.mode || ''),
      provider: String(payload.provider || cur.provider || ''),
      model: String(payload.model || cur.model || ''),
      status: String(payload.status || cur.status || ''),
      lastUserMessageID: String(payload.lastUserMessageID || cur.lastUserMessageID || ''),
      lastAttemptAt: payload.lastAttemptAt || cur.lastAttemptAt || null,
      consecutiveFails: Number(payload.consecutiveFails !== undefined ? payload.consecutiveFails : (cur.consecutiveFails || 0)),
      failCount: Number(payload.failCount !== undefined ? payload.failCount : (cur.failCount || 0)),
      hitCount: Number(payload.hitCount !== undefined ? payload.hitCount : (cur.hitCount || 0)),
      missCount: Number(payload.missCount !== undefined ? payload.missCount : (cur.missCount || 0)),
      skipBudgetCount: Number(payload.skipBudgetCount !== undefined ? payload.skipBudgetCount : (cur.skipBudgetCount || 0)),
      skipCooldownCount: Number(payload.skipCooldownCount !== undefined ? payload.skipCooldownCount : (cur.skipCooldownCount || 0)),
      skipPausedCount: Number(payload.skipPausedCount !== undefined ? payload.skipPausedCount : (cur.skipPausedCount || 0)),
      preparedAt: payload.preparedAt || new Date().toISOString(),
      usedAt: cur.usedAt || null,
      logs: Array.isArray(cur.logs) ? cur.logs.slice(-AUTO_SEND_PRETRIM_WARMUP_LOG_LIMIT) : []
    };
  }

  function pushWarmupLog(sessionData, level = 'info', message = '') {
    if (!sessionData || !message) return;
    const sp = ensureSendPretrim(sessionData);
    const cur = sp?.warmup && typeof sp.warmup === 'object' ? sp.warmup : {};
    const logs = Array.isArray(cur.logs) ? cur.logs.slice(-AUTO_SEND_PRETRIM_WARMUP_LOG_LIMIT) : [];
    logs.push({
      ts: new Date().toISOString(),
      level: String(level || 'info'),
      message: truncateText(String(message || ''), 240)
    });
    cur.logs = logs.slice(-AUTO_SEND_PRETRIM_WARMUP_LOG_LIMIT);
    sp.warmup = cur;
  }

  function markWarmupUsed(sessionData) {
    const sp = ensureSendPretrim(sessionData);
    const cur = sp?.warmup && typeof sp.warmup === 'object' ? sp.warmup : null;
    if (!cur) return;
    cur.usedAt = new Date().toISOString();
    cur.hitCount = Number(cur.hitCount || 0) + 1;
    pushWarmupLog(sessionData, 'info', 'warmup cache hit');
    sp.warmup = cur;
  }

  function markWarmupMiss(sessionData) {
    const sp = ensureSendPretrim(sessionData);
    const cur = sp?.warmup && typeof sp.warmup === 'object' ? sp.warmup : {};
    cur.missCount = Number(cur.missCount || 0) + 1;
    pushWarmupLog(sessionData, 'info', 'warmup cache miss');
    sp.warmup = cur;
  }

  async function schedulePretrimWarmupFromMessages(sessionID, messages = []) {
    if (!getSendPretrimWarmupEnabled() || !sessionID || !Array.isArray(messages) || !messages.length) return;
    if (pretrimWarmupTasks.has(sessionID)) return;

    const pretrimBudget = getSendPretrimBudget();
    const pretrimTarget = getSendPretrimTarget();
    const before = estimateOutgoingMessagesTokens(messages);
    const triggerLine = Math.floor(pretrimBudget * AUTO_SEND_PRETRIM_WARMUP_MIN_RATIO);
    const warmSess = loadSessionMemory(sessionID);
    const warmState = ensureSendPretrim(warmSess)?.warmup || {};
    const now = Date.now();
    const lastAttemptTs = Date.parse(String(warmState.lastAttemptAt || '')) || 0;
    if (lastAttemptTs > 0 && (now - lastAttemptTs) < AUTO_SEND_PRETRIM_WARMUP_MIN_INTERVAL_MS) {
      markWarmupPrepared(warmSess, { skipCooldownCount: Number(warmState.skipCooldownCount || 0) + 1 });
      pushWarmupLog(warmSess, 'info', 'warmup skipped by cooldown');
      persistSessionMemory(warmSess);
      return;
    }
    if (before <= triggerLine) {
      markWarmupPrepared(warmSess, { skipBudgetCount: Number(warmState.skipBudgetCount || 0) + 1 });
      pushWarmupLog(warmSess, 'info', 'warmup skipped by budget threshold');
      persistSessionMemory(warmSess);
      return;
    }

    const task = (async () => {
      try {
        const latestUserMessageID = inferLatestUserMessageID(messages);
        const protectFrom = getProtectFromByUserTurns(messages, getSendPretrimTurnProtection(), 8);
        const selectedRange = selectDistillCandidateRange(messages, protectFrom);
        const candidateIndices = Array.isArray(selectedRange.indices) ? selectedRange.indices : [];
        const candidateItems = Array.isArray(selectedRange.items) ? selectedRange.items : [];
        const minDistillMessages = Math.max(1, getDistillRangeMinMessages());
        const allowSingleWhenSevere = before > Math.floor(pretrimTarget * 3);
        const enoughCandidates = candidateIndices.length >= minDistillMessages
          || (allowSingleWhenSevere && candidateIndices.length >= 1);
        if (!enoughCandidates || !candidateItems.length) return;

        const sourceItems = [];
        for (const it of candidateItems) {
          sourceItems.push(it);
          if (JSON.stringify(sourceItems).length > getDistillInputMaxChars()) break;
        }
        if (!sourceItems.length) return;

        const sourceHash = buildDistillSourceHash(sourceItems);
        let summaryText = '';
        let mode = 'extract';
        let provider = '';
        let model = '';
        let status = 'no_candidate';

        const runMode = getDistillMode();
        const independentCfg = getIndependentDistillConfig();
        const sessionInlineCfg = resolveSessionInlineProviderConfig(messages);
        let llmCfg = null;
        if (runMode === 'session') llmCfg = sessionInlineCfg;
        else if (runMode === 'independent') llmCfg = canUseIndependentDistill(independentCfg) ? independentCfg : null;
        else llmCfg = canUseIndependentDistill(independentCfg) ? independentCfg : sessionInlineCfg;

        if (llmCfg) {
          const distill = await runIndependentDistillLLM(messages, sourceItems, llmCfg);
          provider = String(distill?.provider || '');
          model = String(distill?.model || '');
          status = String(distill?.reason || '');
          if (distill?.ok && distill?.text) {
            const quality = evaluateDistillSummaryQuality(distill.text, sourceItems);
            if (quality.ok) {
              summaryText = truncateText(distill.text, getDistillSummaryMaxChars());
              mode = 'llm';
              status = 'ok';
            } else {
              status = `low_quality:${quality.reason}`;
            }
          }
        }

        if (!summaryText) {
          const inline = runSessionInlineSummaryFallback(sourceItems);
          const quality = evaluateDistillSummaryQuality(inline, sourceItems);
          if (quality.ok && inline) {
            summaryText = truncateText(inline, getDistillSummaryMaxChars());
            mode = 'llm';
            provider = provider || 'session-inline-fallback';
            model = model || 'current-session';
            status = status ? `${status}|fallback:ok_inline` : 'fallback:ok_inline';
          } else {
            const fallbackLines = sourceItems
              .flatMap((it) => Array.isArray(it.snippets) ? it.snippets : [])
              .slice(0, 12)
              .map((x) => `- ${truncateText(x, 140)}`);
            summaryText = truncateText(fallbackLines.join('\n'), getDistillSummaryMaxChars());
            mode = 'extract';
            status = status ? `${status}|fallback:extract` : 'fallback:extract';
          }
        }

        if (!summaryText) return;
        if (before <= pretrimTarget) return;

        const sess = loadSessionMemory(sessionID);
        const prevWarm = ensureSendPretrim(sess)?.warmup || {};
        let consecutiveFails = Number(prevWarm.consecutiveFails || 0);
        let failCount = Number(prevWarm.failCount || 0);
        const failedUpstream = /http_|timeout|empty_text|non_json_response|missing_model|disabled_or_incomplete_config/i.test(String(status || ''));
        if (failedUpstream) {
          consecutiveFails += 1;
          failCount += 1;
        } else {
          consecutiveFails = 0;
        }
        markWarmupPrepared(sess, {
          sourceHash,
          summary: summaryText,
          mode,
          provider,
          model,
          status,
          lastUserMessageID: latestUserMessageID,
          lastAttemptAt: new Date().toISOString(),
          preparedAt: new Date().toISOString(),
          consecutiveFails,
          failCount
        });
        pushWarmupLog(
          sess,
          failedUpstream ? 'warn' : 'info',
          failedUpstream
            ? `warmup fallback: ${truncateText(String(status || 'unknown'), 120)}`
            : `warmup prepared (${mode})`
        );
        persistSessionMemory(sess);
        writeDashboardFiles();
      } catch (err) {
        // warmup errors should never block normal chat flow
        console.error('memory-system warmup failed:', err);
        try {
          const sess = loadSessionMemory(sessionID);
          const prevWarm = ensureSendPretrim(sess)?.warmup || {};
          const consecutiveFails = Number(prevWarm.consecutiveFails || 0) + 1;
          const failCount = Number(prevWarm.failCount || 0) + 1;
          markWarmupPrepared(sess, {
            status: `runtime_error:${truncateText(String(err?.message || err || ''), 160)}`,
            lastAttemptAt: new Date().toISOString(),
            consecutiveFails,
            failCount
          });
          pushWarmupLog(sess, 'error', `warmup runtime error: ${truncateText(String(err?.message || err || ''), 120)}`);
          persistSessionMemory(sess);
        } catch (_) {}
      } finally {
        pretrimWarmupTasks.delete(sessionID);
      }
    })();

    pretrimWarmupTasks.set(sessionID, task);
  }

  function buildStrictSummaryAnchorFromMessages(items = []) {
    const lines = [];
    const state = { chars: 0, maxChars: AUTO_STRICT_ANCHOR_MAX_CHARS };
    pushLineWithLimit(lines, '[pretrim-summary-anchor]', state);
    pushLineWithLimit(lines, '- type: strict-summary', state);
    pushLineWithLimit(lines, '- note: historical context before recent turns has been compacted', state);
    pushLineWithLimit(lines, '- distilled:', state);
    for (const text of items) {
      if (lines.length >= AUTO_STRICT_ANCHOR_MAX_LINES) break;
      const t = truncateText(normalizeText(String(text || '')), 160);
      if (!t) continue;
      pushLineWithLimit(lines, `  - ${t}`, state);
    }
    return lines.join('\n').trim();
  }

  function applyStrictAnchorCompaction(messages, currentAfterTokens = 0) {
    const result = {
      applied: false,
      replacedMessages: 0,
      beforeTokens: Number(currentAfterTokens || 0),
      afterTokens: Number(currentAfterTokens || 0),
      savedTokens: 0
    };
    if (!isStrictModeEnabled() || !Array.isArray(messages) || messages.length < 6) return result;
    if (result.beforeTokens <= pretrimTarget) return result;

    const protectFrom = getProtectFromByUserTurns(messages, getSendPretrimTurnProtection(), 8);
    const candidateIndices = [];
    const snippets = [];

    for (let i = 0; i < messages.length; i += 1) {
      if (i >= protectFrom) continue;
      const msg = messages[i];
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      if (!msg || !Array.isArray(msg.parts) || !msg.parts.length) continue;
      if (role === 'system' || role === 'user') continue;

      let hasProtectedPart = false;
      const msgSnippets = [];
      for (const part of msg.parts) {
        const text = partTextForPretrim(part);
        if (!text) continue;
        if (isProtectedToolForPretrim(part, text)) {
          hasProtectedPart = true;
          break;
        }
        if (isToolDefinitionLikeText(text)) {
          hasProtectedPart = true;
          break;
        }
        msgSnippets.push(text);
      }
      if (hasProtectedPart || !msgSnippets.length) continue;
      candidateIndices.push(i);
      snippets.push(...msgSnippets.slice(0, 2));
    }

    if (candidateIndices.length < 2 || !snippets.length) return result;

    const anchor = buildStrictSummaryAnchorFromMessages(snippets.slice(0, AUTO_STRICT_ANCHOR_MAX_LINES));
    if (!anchor) return result;

    const first = candidateIndices[0];
    const placeholder = '[strict-trimmed merged into summary-anchor]';
    messages[first].parts = [{ type: 'text', text: anchor }];
    for (const idx of candidateIndices.slice(1)) {
      messages[idx].parts = [{ type: 'text', text: placeholder }];
    }

    const after = estimateOutgoingMessagesTokens(messages);
    result.applied = true;
    result.replacedMessages = candidateIndices.length;
    result.afterTokens = after;
    result.savedTokens = Math.max(0, result.beforeTokens - after);
    return result;
  }

  async function applySendPretrim(messages, sessionID = '') {
    const originalMessages = AUTO_SEND_PRETRIM_DRY_RUN ? null : JSON.parse(JSON.stringify(messages || []));
    const latestSystemTokens = getLatestSystemPromptTokens(sessionID);
    const pretrimBudget = getSendPretrimBudget();
    const pretrimTarget = getSendPretrimTarget();
    const result = {
      enabled: isSendPretrimEnabled(),
      dryRun: AUTO_SEND_PRETRIM_DRY_RUN,
      strictModeEnabled: isStrictModeEnabled(),
      beforeTokens: estimateOutgoingMessagesTokens(messages),
      afterTokens: 0,
      systemTokensBefore: latestSystemTokens,
      systemTokensAfter: latestSystemTokens,
      totalBeforeTokens: 0,
      totalAfterTokens: 0,
      adaptiveLevel: 0,
      adaptiveRatio: 0,
      pretrimProfile: getPretrimProfile(),
      rewrittenParts: 0,
      rewrittenMessages: 0,
      savedTokens: 0,
      reason: '',
      strictApplied: false,
      strictReplacedMessages: 0,
      distillUsed: false,
      distillProvider: '',
      distillModel: '',
      distillStatus: '',
      distillSource: '',
      distillFallbackUsed: false,
      warmupCacheHit: false,
      warmupPreparedAt: '',
      strategyDedup: 0,
      strategySupersedeWrites: 0,
      strategyPurgedErrors: 0,
      strategyPhaseTrim: 0,
      anchorReplaceApplied: false,
      anchorReplaceMessages: 0,
      anchorReplaceBlocks: 0,
      predictedBlockId: 0,
      compositionBefore: computeOutgoingTokenComposition(messages),
      compositionAfter: { system: 0, user: 0, assistant: 0, tool: 0, other: 0, total: 0 },
      compressedBlock: null
    };
    result.totalBeforeTokens = Number(result.beforeTokens || 0) + Number(result.systemTokensBefore || 0);
    result.totalAfterTokens = Number(result.afterTokens || 0) + Number(result.systemTokensAfter || 0);

    if (!isSendPretrimEnabled() || !Array.isArray(messages) || !messages.length) {
      result.afterTokens = result.beforeTokens;
      result.totalAfterTokens = Number(result.afterTokens || 0) + Number(result.systemTokensAfter || 0);
      result.reason = isSendPretrimEnabled() ? 'no_messages' : 'disabled';
      return result;
    }

    if (sessionID && hasSessionMemoryFile(sessionID)) {
      try {
        const sess = loadSessionMemory(sessionID);
        result.predictedBlockId = Number(nextSummaryBlockId(sess) || 0);
      } catch (_) {}
    }

    const policy = getAdaptivePretrimPolicy(result.beforeTokens);
    result.pretrimProfile = String(policy.profile || result.pretrimProfile || AUTO_PRETRIM_PROFILE_DEFAULT);
    result.adaptiveLevel = Number(policy.level || 0);
    result.adaptiveRatio = Number(policy.ratio || 0);

    if (!AUTO_SEND_PRETRIM_DRY_RUN) {
      const st = applyAutomaticStrategies(messages, policy);
      result.strategyDedup = Number(st?.dedup || 0);
      result.strategySupersedeWrites = Number(st?.supersedeWrites || 0);
      result.strategyPurgedErrors = Number(st?.purgedErrors || 0);
      result.strategyPhaseTrim = Number(st?.phaseTrim || 0);
    }

    const tokensAfterStrategies = estimateOutgoingMessagesTokens(messages);
    if (tokensAfterStrategies <= pretrimBudget) {
      result.afterTokens = tokensAfterStrategies;
      result.savedTokens = Math.max(0, result.beforeTokens - result.afterTokens);
      result.reason = (result.strategyDedup || result.strategySupersedeWrites || result.strategyPurgedErrors || result.strategyPhaseTrim)
        ? 'within_budget+strategies'
        : 'within_budget';
      result.compositionAfter = computeOutgoingTokenComposition(messages);
      result.totalAfterTokens = Number(result.afterTokens || 0) + Number(result.systemTokensAfter || 0);
      return result;
    }

    const protectFrom = getProtectFromByUserTurns(messages, Number(policy.turnProtection || getSendPretrimTurnProtection()), 8);
    let rewrites = 0;

    for (let i = 0; i < messages.length; i += 1) {
      if (rewrites >= Number(policy.maxRewriteMessages || getSendPretrimMaxRewriteMessages())) break;
      if (i >= protectFrom) continue;

      const msg = messages[i];
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      if (!msg || !Array.isArray(msg.parts)) continue;
      if (role === 'system' || role === 'user') continue;

      let touchedInMessage = false;
      for (const part of msg.parts) {
        if (result.beforeTokens - result.savedTokens <= pretrimTarget) break;

        const oldText = partTextForPretrim(part);
        if (!oldText) continue;
        if (isProtectedToolForPretrim(part, oldText)) continue;
        if (!isLowSignalPartForPretrim(part, oldText)) continue;

        const oldTokens = estimateTokensFromText(oldText);
        const replacement = '[pretrimmed low-signal tool/context output by memory-system]';
        const newTokens = estimateTokensFromText(replacement);
        const saved = Math.max(0, oldTokens - newTokens);
        if (saved <= 0) continue;

        if (!AUTO_SEND_PRETRIM_DRY_RUN) {
          if (typeof part.text === 'string') part.text = replacement;
          else if (typeof part.content === 'string') part.content = replacement;
          else if (typeof part.output === 'string') part.output = replacement;
          else if (part.type === 'tool') {
            part.state = part.state && typeof part.state === 'object' ? part.state : {};
            part.state.output = replacement;
            if (part.state.error) part.state.error = '';
          }
        }

        result.savedTokens += saved;
        result.rewrittenParts += 1;
        touchedInMessage = true;
      }

      if (touchedInMessage) {
        result.rewrittenMessages += 1;
        rewrites += 1;
      }

      if (result.beforeTokens - result.savedTokens <= pretrimTarget) break;
    }

    result.afterTokens = AUTO_SEND_PRETRIM_DRY_RUN
      ? Math.max(0, result.beforeTokens - result.savedTokens)
      : estimateOutgoingMessagesTokens(messages);

    // Stage-2 (DCP-compatible): after mechanical pretrim, if still above threshold,
    // run LLM summary replacement (inline by default; independent only when enabled).
    const hardLimit = Math.floor(pretrimBudget * getSendPretrimHardRatio());
    const distillTrigger = Math.floor(pretrimBudget * getSendPretrimDistillTriggerRatio());
    const stage2Limit = Math.max(pretrimTarget + 200, Math.min(hardLimit, distillTrigger));
    let extractedMessages = 0;
    if (!AUTO_SEND_PRETRIM_DRY_RUN && result.afterTokens > stage2Limit) {
      const protectFrom = getProtectFromByUserTurns(messages, getSendPretrimTurnProtection(), 8);
      const selectedRange = selectDistillCandidateRange(messages, protectFrom);
      const candidateIndices = Array.isArray(selectedRange.indices) ? selectedRange.indices : [];
      const candidateItems = Array.isArray(selectedRange.items) ? selectedRange.items : [];

      const minDistillMessages = Math.max(1, getDistillRangeMinMessages());
      const allowSingleWhenSevere = result.afterTokens > Math.floor(pretrimTarget * 3);
      const enoughCandidates = candidateIndices.length >= minDistillMessages
        || (allowSingleWhenSevere && candidateIndices.length >= 1);
      if (enoughCandidates && candidateItems.length) {
        let summary = '';
        const sourceItems = [];
        for (const it of candidateItems) {
          sourceItems.push(it);
          if (JSON.stringify(sourceItems).length > getDistillInputMaxChars()) break;
        }
        const sourceHash = buildDistillSourceHash(sourceItems);
        const lastUserMessageID = inferLatestUserMessageID(messages);

        if (sessionID && sourceItems.length) {
          try {
            const sessWarm = loadSessionMemory(sessionID);
            const warmHit = getWarmupCacheHit(sessWarm, sourceHash, lastUserMessageID);
            if (warmHit?.summary) {
              summary = buildWarmupSummaryText(warmHit, result.predictedBlockId);
              result.distillUsed = warmHit.mode === 'llm';
              result.distillProvider = String(warmHit.provider || 'warmup-cache');
              result.distillModel = String(warmHit.model || '');
              result.distillStatus = String(warmHit.status || 'warmup_cache_hit');
              result.distillSource = 'warmup-cache';
              result.warmupCacheHit = true;
              result.warmupPreparedAt = String(warmHit.preparedAt || '');
              markWarmupUsed(sessWarm);
              persistSessionMemory(sessWarm);
            } else {
              markWarmupMiss(sessWarm);
              persistSessionMemory(sessWarm);
            }
          } catch (_) {}
        }

        if (!summary && !sourceItems.length) {
          result.distillStatus = result.distillStatus || 'empty_source_items';
        }
        if (!summary) {
          const mode = getDistillMode();
          const dcpCompat = isDcpCompatModeEnabled();
          const independentCfg = getIndependentDistillConfig();
          const sessionInlineCfg = resolveSessionInlineProviderConfig(messages);
          let llmCfg = null;
          if (mode === 'session') llmCfg = sessionInlineCfg;
          else if (mode === 'independent') llmCfg = canUseIndependentDistill(independentCfg) ? independentCfg : null;
          else {
            // auto:
            // compat=true  -> mechanical first + inline unless independent was explicitly enabled/configured
            // compat=false -> keep previous behavior (still prefers independent when configured)
            llmCfg = canUseIndependentDistill(independentCfg) ? independentCfg : sessionInlineCfg;
          }
          if (!dcpCompat && mode === 'auto' && !llmCfg) {
            // explicit marker for diagnostics when auto mode found no runnable LLM path.
            result.distillStatus = result.distillStatus || 'auto_no_runnable_llm';
          }

          if (llmCfg) {
            const sourceTag = (llmCfg === sessionInlineCfg) ? 'session-model' : 'independent';
            const distill = await runIndependentDistillLLM(messages, sourceItems, llmCfg);
            const providerRaw = String(distill?.provider || '');
            result.distillProvider = sourceTag === 'session-model'
              ? `session-inline/${providerRaw || 'current-provider'}`
              : providerRaw;
            result.distillModel = String(distill?.model || '');
            result.distillStatus = String(distill?.reason || '');
            result.distillSource = sourceTag;
            if (distill?.ok && distill?.text) {
              const quality = evaluateDistillSummaryQuality(distill.text, sourceItems);
              result.distillStatus = quality.ok ? 'ok' : `low_quality:${quality.reason}`;
              if (quality.ok) {
                const bid = result.predictedBlockId > 0 ? ` b${result.predictedBlockId}` : '';
                summary = `[pretrim-distill${bid}]\n${truncateText(distill.text, getDistillSummaryMaxChars())}`;
                result.distillUsed = true;
              }
            }
          } else {
            result.distillStatus = result.distillStatus || 'llm_unavailable_fallback';
          }
        }

        if (!summary) {
          const inline = runSessionInlineSummaryFallback(sourceItems);
          const quality = evaluateDistillSummaryQuality(inline, sourceItems);
          result.distillProvider = 'session-inline-fallback';
          result.distillModel = result.distillModel || 'current-session';
          const fallbackStatus = quality.ok ? 'ok_inline' : `low_quality_inline:${quality.reason}`;
          result.distillStatus = result.distillStatus
            ? `${result.distillStatus}|fallback:${fallbackStatus}`
            : fallbackStatus;
          result.distillSource = result.distillSource || 'fallback-rules';
          result.distillFallbackUsed = true;
          if (quality.ok && inline) {
            const bid = result.predictedBlockId > 0 ? ` b${result.predictedBlockId}` : '';
            summary = `[pretrim-distill-inline${bid}]\n${truncateText(inline, getDistillSummaryMaxChars())}`;
            result.distillUsed = true;
          } else {
            const fallbackLines = sourceItems
              .flatMap((it) => Array.isArray(it.snippets) ? it.snippets : [])
              .slice(0, 12)
              .map((x) => `- ${truncateText(x, 140)}`);
            if (fallbackLines.length) {
              summary = `[pretrim-extract]\n${fallbackLines.join('\n')}`;
            }
          }
        }

        if (summary) {
          const refs = getRecentBlockPlaceholders(sessionID, getProjectName(), 3);
          if (refs.length) {
            const refLine = `\nReferenced compressed blocks: ${refs.map((r) => r.placeholder).join(' ')}`;
            summary = truncateText(`${summary}${refLine}`, getDistillSummaryMaxChars());
          }
          const first = candidateIndices[0];
          const last = candidateIndices[candidateIndices.length - 1];
          const startMessageID = extractMessageIDFromOutgoing(messages[first]) || `i${first}`;
          const endMessageID = extractMessageIDFromOutgoing(messages[last]) || `i${last}`;
          const anchorMessageID = startMessageID;
          messages[first].parts = [{ type: 'text', text: summary }];
          const placeholder = '[pretrim-distilled into anchor-summary]';
          for (const idx of candidateIndices.slice(1)) {
            messages[idx].parts = [{ type: 'text', text: placeholder }];
            extractedMessages += 1;
          }
          extractedMessages += 1;
          result.rewrittenMessages += candidateIndices.length;
          result.rewrittenParts += candidateIndices.length;
          result.afterTokens = estimateOutgoingMessagesTokens(messages);
          result.compressedBlock = {
            source: 'pretrim-distill',
            startMessageID,
            endMessageID,
            anchorMessageID,
            consumedMessages: Number(candidateIndices.length || 0),
            summary: truncateText(normalizeText(summary.replace(/^\[[^\]]+\]\s*/,'').trim()), 2000)
          };
        }
      }

      if (!extractedMessages) {
        // fallback to conservative per-message extract if batching couldn't run
        for (let i = 0; i < messages.length; i += 1) {
          if (result.afterTokens <= pretrimTarget) break;
          if (i >= protectFrom) continue;
          const msg = messages[i];
          const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
          if (!msg || !Array.isArray(msg.parts) || !msg.parts.length) continue;
          if (role === 'system' || role === 'user') continue;
          const snippets = collectDistillSnippetsFromMessage(msg);
          if (!snippets.length) continue;
          msg.parts = [{ type: 'text', text: `[pretrim-extract] ${snippets.join(' | ')}` }];
          extractedMessages += 1;
          result.rewrittenMessages += 1;
          result.rewrittenParts += 1;
          result.afterTokens = estimateOutgoingMessagesTokens(messages);
        }
      }
    }

    result.savedTokens = Math.max(0, result.beforeTokens - result.afterTokens);
    if (extractedMessages > 0) result.reason = result.distillUsed
      ? `trimmed+distill(${extractedMessages})`
      : `trimmed+extract(${extractedMessages})`;
    else result.reason = result.rewrittenParts > 0 ? (AUTO_SEND_PRETRIM_DRY_RUN ? 'dry_run' : 'trimmed') : 'no_rewrite_candidates';
    result.extractedMessages = extractedMessages;

    // Anchor replacement loop (DCP-like): when still over target and we already have compressed blocks,
    // replace old assistant/tool raw traces with one anchor referring blocks.
    if (!AUTO_SEND_PRETRIM_DRY_RUN && result.afterTokens > pretrimTarget) {
      const protectFrom = getProtectFromByUserTurns(messages, Number(policy.turnProtection || getSendPretrimTurnProtection()), 8);
      const ar = applyAnchorBlockReplacement(messages, sessionID, protectFrom);
      if (ar.applied) {
        result.anchorReplaceApplied = true;
        result.anchorReplaceMessages = Number(ar.replacedMessages || 0);
        result.anchorReplaceBlocks = Number(ar.usedBlocks || 0);
        result.afterTokens = estimateOutgoingMessagesTokens(messages);
        result.savedTokens = Math.max(0, result.beforeTokens - result.afterTokens);
        result.reason = `anchor-replace(${result.anchorReplaceMessages})`;
      }
    }

    // Strict mode (optional): replace old assistant/tool history with one summary anchor.
    if (!AUTO_SEND_PRETRIM_DRY_RUN && result.afterTokens > pretrimTarget && isStrictModeEnabled()) {
      const strict = applyStrictAnchorCompaction(messages, result.afterTokens);
      if (strict.applied) {
        result.strictApplied = true;
        result.strictReplacedMessages = Number(strict.replacedMessages || 0);
        result.afterTokens = Number(strict.afterTokens || result.afterTokens);
        result.savedTokens = Math.max(0, result.beforeTokens - result.afterTokens);
        result.reason = `strict-anchor(${result.strictReplacedMessages})`;
      }
    }
    if (
      !AUTO_SEND_PRETRIM_DRY_RUN &&
      originalMessages &&
      result.rewrittenParts > 0 &&
      Number(result.afterTokens || 0) >= Number(result.beforeTokens || 0)
    ) {
      messages.splice(0, messages.length, ...originalMessages);
      result.afterTokens = estimateOutgoingMessagesTokens(messages);
      result.savedTokens = 0;
      result.rewrittenParts = 0;
      result.rewrittenMessages = 0;
      result.extractedMessages = 0;
      result.strictApplied = false;
      result.strictReplacedMessages = 0;
      result.anchorReplaceApplied = false;
      result.anchorReplaceMessages = 0;
      result.anchorReplaceBlocks = 0;
      result.distillUsed = false;
      result.reason = 'no_gain_revert';
    }
    result.compositionAfter = computeOutgoingTokenComposition(messages);
    result.totalAfterTokens = Number(result.afterTokens || 0) + Number(result.systemTokensAfter || 0);
    return result;
  }

  function defaultSendPretrim() {
    return {
      autoRuns: 0,
      manualRuns: 0,
      savedTokensTotal: 0,
      lastBeforeTokens: 0,
      lastAfterTokens: 0,
      lastSavedTokens: 0,
      lastAt: null,
      lastReason: '',
      lastStatus: '',
      warmup: {
        sourceHash: '',
        summary: '',
        mode: '',
        provider: '',
        model: '',
        status: '',
        lastUserMessageID: '',
        lastAttemptAt: null,
        consecutiveFails: 0,
        failCount: 0,
        hitCount: 0,
        missCount: 0,
        skipBudgetCount: 0,
        skipCooldownCount: 0,
        skipPausedCount: 0,
        preparedAt: null,
        usedAt: null,
        logs: []
      },
      traces: []
    };
  }

  function ensureSendPretrim(sessionData) {
    if (!sessionData || typeof sessionData !== 'object') return defaultSendPretrim();
    const cur = sessionData.sendPretrim && typeof sessionData.sendPretrim === 'object'
      ? sessionData.sendPretrim
      : {};
    sessionData.sendPretrim = {
      autoRuns: Number(cur.autoRuns || 0),
      manualRuns: Number(cur.manualRuns || 0),
      savedTokensTotal: Number(cur.savedTokensTotal || 0),
      lastBeforeTokens: Number(cur.lastBeforeTokens || 0),
      lastAfterTokens: Number(cur.lastAfterTokens || 0),
      lastSavedTokens: Number(cur.lastSavedTokens || 0),
      lastAt: cur.lastAt || null,
      lastReason: cur.lastReason || '',
      lastStatus: cur.lastStatus || '',
      warmup: {
        sourceHash: String(cur?.warmup?.sourceHash || ''),
        summary: truncateText(String(cur?.warmup?.summary || '').trim(), getDistillSummaryMaxChars()),
        mode: String(cur?.warmup?.mode || ''),
        provider: String(cur?.warmup?.provider || ''),
        model: String(cur?.warmup?.model || ''),
        status: String(cur?.warmup?.status || ''),
        lastUserMessageID: String(cur?.warmup?.lastUserMessageID || ''),
        lastAttemptAt: cur?.warmup?.lastAttemptAt || null,
        consecutiveFails: Number(cur?.warmup?.consecutiveFails || 0),
        failCount: Number(cur?.warmup?.failCount || 0),
        hitCount: Number(cur?.warmup?.hitCount || 0),
        missCount: Number(cur?.warmup?.missCount || 0),
        skipBudgetCount: Number(cur?.warmup?.skipBudgetCount || 0),
        skipCooldownCount: Number(cur?.warmup?.skipCooldownCount || 0),
        skipPausedCount: Number(cur?.warmup?.skipPausedCount || 0),
        preparedAt: cur?.warmup?.preparedAt || null,
        usedAt: cur?.warmup?.usedAt || null,
        logs: Array.isArray(cur?.warmup?.logs)
          ? cur.warmup.logs.slice(-AUTO_SEND_PRETRIM_WARMUP_LOG_LIMIT)
          : []
      },
      traces: Array.isArray(cur.traces) ? cur.traces.slice(-AUTO_SEND_PRETRIM_TRACE_LIMIT) : []
    };
    return sessionData.sendPretrim;
  }

  function buildSystemTokenRiskAlert({ bodyTokens = 0, systemTokens = 0, pluginHintTokens = 0, totalTokens = 0 } = {}) {
    const body = Math.max(0, Number(bodyTokens || 0));
    const system = Math.max(0, Number(systemTokens || 0));
    const pluginHint = Math.max(0, Number(pluginHintTokens || 0));
    const total = Math.max(0, Number(totalTokens || (body + system)));
    if (system <= 0 || total <= 0) return null;

    const share = system / Math.max(1, total);
    const ratioToBody = body > 0 ? (system / body) : (system > 0 ? Number.POSITIVE_INFINITY : 0);
    const warn = total >= AUTO_SYSTEM_TOKEN_WARN_MIN_TOTAL
      && system >= AUTO_SYSTEM_TOKEN_WARN_MIN_SYSTEM
      && (share >= AUTO_SYSTEM_TOKEN_WARN_SHARE || ratioToBody >= AUTO_SYSTEM_TOKEN_WARN_RATIO);
    if (!warn) return null;

    const critical = total >= AUTO_SYSTEM_TOKEN_CRITICAL_MIN_TOTAL
      && system >= AUTO_SYSTEM_TOKEN_CRITICAL_MIN_SYSTEM
      && (share >= AUTO_SYSTEM_TOKEN_CRITICAL_SHARE || ratioToBody >= AUTO_SYSTEM_TOKEN_CRITICAL_RATIO);

    const reason = critical
      ? 'system_overhead_critical'
      : (share >= AUTO_SYSTEM_TOKEN_WARN_SHARE ? 'system_share_high' : 'system_to_body_ratio_high');

    return {
      level: critical ? 'critical' : 'warn',
      at: new Date().toISOString(),
      reason,
      bodyTokens: body,
      systemTokens: system,
      pluginHintTokens: pluginHint,
      totalTokens: total,
      systemShare: Number(share.toFixed(3)),
      systemToBodyRatio: Number(Number.isFinite(ratioToBody) ? ratioToBody.toFixed(3) : 999),
      suggestions: [
        'System tokens are not pretrimmed. Reduce MCP/skills/system prompt payload first.',
        'Disable unnecessary system-side injections (for example message-id tags or prunable-tools hints) if not needed.'
      ]
    };
  }

  function syncBudgetTokenSnapshot(sessionData, patch = {}) {
    if (!sessionData || typeof sessionData !== 'object') return null;
    sessionData.budget = sessionData.budget || {};
    const budget = sessionData.budget;
    if (Object.prototype.hasOwnProperty.call(patch, 'bodyTokens')) {
      budget.lastEstimatedBodyTokens = Number(patch.bodyTokens || 0);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'systemTokens')) {
      budget.lastEstimatedSystemTokens = Number(patch.systemTokens || 0);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'pluginHintTokens')) {
      budget.lastEstimatedPluginHintTokens = Number(patch.pluginHintTokens || 0);
    }
    budget.lastEstimatedBodyTokens = Number(budget.lastEstimatedBodyTokens || 0);
    budget.lastEstimatedSystemTokens = Number(budget.lastEstimatedSystemTokens || 0);
    budget.lastEstimatedPluginHintTokens = Number(budget.lastEstimatedPluginHintTokens || 0);
    budget.lastEstimatedTotalTokens = budget.lastEstimatedBodyTokens + budget.lastEstimatedSystemTokens;

    sessionData.alerts = sessionData.alerts && typeof sessionData.alerts === 'object'
      ? sessionData.alerts
      : {};
    const systemRisk = buildSystemTokenRiskAlert({
      bodyTokens: budget.lastEstimatedBodyTokens,
      systemTokens: budget.lastEstimatedSystemTokens,
      pluginHintTokens: budget.lastEstimatedPluginHintTokens,
      totalTokens: budget.lastEstimatedTotalTokens
    });
    if (systemRisk) sessionData.alerts.systemTokenRisk = systemRisk;
    else if (sessionData.alerts.systemTokenRisk) delete sessionData.alerts.systemTokenRisk;
    return budget;
  }

  function buildBudgetTokenView(rawBudget = {}) {
    const bodyTokens = Number(rawBudget?.lastEstimatedBodyTokens || 0);
    const systemTokens = Number(rawBudget?.lastEstimatedSystemTokens || 0);
    const pluginHintTokens = Number(rawBudget?.lastEstimatedPluginHintTokens || 0);
    const totalTokens = Number(rawBudget?.lastEstimatedTotalTokens || (bodyTokens + systemTokens));
    const tokenizerProbe = getNativeTokenizerProbe();
    return {
      bodyTokens,
      systemTokens,
      pluginHintTokens,
      totalTokens,
      totalWithPluginHintTokens: totalTokens + pluginHintTokens,
      pluginHintIncludedInTotal: false,
      estimateMethod: 'heuristic_chars_div_4',
      estimateBase: 'ceil(chars/4)',
      exactBillingEquivalent: false,
      bodyIncludesCompressedSummary: true,
      displayFormula: 'body+system',
      displayNote: 'Estimated tokens use ceil(chars/4). total=body+system; plugin-hint is displayed separately and not included in total.',
      nativeTokenizerAvailable: Boolean(tokenizerProbe?.available),
      nativeTokenizerSource: String(tokenizerProbe?.source || ''),
      nativeTokenizerCallable: Boolean(tokenizerProbe?.callable),
      nativeTokenizerProbeNote: String(tokenizerProbe?.note || '')
    };
  }

  function getNativeTokenizerProbe() {
    if (nativeTokenizerProbeCache) return nativeTokenizerProbeCache;
    const candidates = [
      ['client.tokenizer.count', client?.tokenizer?.count],
      ['client.tokenizer.tokenize', client?.tokenizer?.tokenize],
      ['client.tokens.count', client?.tokens?.count],
      ['client.tokens.estimate', client?.tokens?.estimate],
      ['client.token.count', client?.token?.count],
      ['client.tokenize', client?.tokenize],
      ['client.countTokens', client?.countTokens]
    ];
    for (const [source, fn] of candidates) {
      if (typeof fn === 'function') {
        nativeTokenizerProbeCache = {
          available: true,
          callable: true,
          source: String(source || ''),
          note: 'Native tokenizer API is exposed in current plugin runtime (probe only; estimation still uses chars/4 baseline).'
        };
        return nativeTokenizerProbeCache;
      }
    }
    nativeTokenizerProbeCache = {
      available: false,
      callable: false,
      source: '',
      note: 'No stable native tokenizer API is exposed to plugin runtime; fallback remains chars/4 estimation.'
    };
    return nativeTokenizerProbeCache;
  }

  function recordSendPretrimAudit(sessionID, stats, source = 'auto') {
    if (!sessionID || !stats || typeof stats !== 'object') return;
    if (!hasSessionMemoryFile(sessionID)) return;
    const mem = loadSessionMemory(sessionID);
    const audit = ensureSendPretrim(mem);
    if (source === 'auto') audit.autoRuns += 1;
    else audit.manualRuns += 1;
    audit.savedTokensTotal += Number(stats.savedTokens || 0);
    audit.lastBeforeTokens = Number(stats.beforeTokens || 0);
    audit.lastAfterTokens = Number(stats.afterTokens || 0);
    audit.lastSavedTokens = Number(stats.savedTokens || 0);
    audit.lastAt = new Date().toISOString();
    audit.lastReason = String(stats.reason || '');
    audit.lastStatus = stats.savedTokens > 0 ? 'trimmed' : 'nochange';

    const traceItem = {
      ts: audit.lastAt,
      source: String(source || 'auto'),
      beforeTokens: Number(stats.beforeTokens || 0),
      afterTokens: Number(stats.afterTokens || 0),
      systemTokensBefore: Number(stats.systemTokensBefore || 0),
      systemTokensAfter: Number(stats.systemTokensAfter || 0),
      pluginHintTokensBefore: Number(stats.pluginHintTokensBefore || 0),
      pluginHintTokensAfter: Number(stats.pluginHintTokensAfter || 0),
      totalBeforeTokens: Number(stats.totalBeforeTokens || 0),
      totalAfterTokens: Number(stats.totalAfterTokens || 0),
      savedTokens: Number(stats.savedTokens || 0),
      rewrittenParts: Number(stats.rewrittenParts || 0),
      rewrittenMessages: Number(stats.rewrittenMessages || 0),
      extractedMessages: Number(stats.extractedMessages || 0),
      strictApplied: Boolean(stats.strictApplied),
      strictReplacedMessages: Number(stats.strictReplacedMessages || 0),
      distillUsed: Boolean(stats.distillUsed),
      distillProvider: String(stats.distillProvider || ''),
      distillModel: String(stats.distillModel || ''),
      distillStatus: String(stats.distillStatus || ''),
      distillSource: String(stats.distillSource || ''),
      distillFallbackUsed: Boolean(stats.distillFallbackUsed),
      warmupCacheHit: Boolean(stats.warmupCacheHit),
      warmupPreparedAt: String(stats.warmupPreparedAt || ''),
      strategyDedup: Number(stats.strategyDedup || 0),
      strategySupersedeWrites: Number(stats.strategySupersedeWrites || 0),
      strategyPurgedErrors: Number(stats.strategyPurgedErrors || 0),
      strategyPhaseTrim: Number(stats.strategyPhaseTrim || 0),
      pretrimProfile: String(stats.pretrimProfile || getPretrimProfile()),
      adaptiveLevel: Number(stats.adaptiveLevel || 0),
      adaptiveRatio: Number(stats.adaptiveRatio || 0),
      anchorReplaceApplied: Boolean(stats.anchorReplaceApplied),
      anchorReplaceMessages: Number(stats.anchorReplaceMessages || 0),
      anchorReplaceBlocks: Number(stats.anchorReplaceBlocks || 0),
      compositionBefore: stats.compositionBefore && typeof stats.compositionBefore === 'object' ? stats.compositionBefore : null,
      compositionAfter: stats.compositionAfter && typeof stats.compositionAfter === 'object' ? stats.compositionAfter : null,
      predictedBlockId: Number(stats.predictedBlockId || 0),
      reason: String(stats.reason || '')
    };
    audit.traces = Array.isArray(audit.traces) ? audit.traces : [];
    audit.traces.push(traceItem);
    if (audit.traces.length > AUTO_SEND_PRETRIM_TRACE_LIMIT) {
      audit.traces = audit.traces.slice(-AUTO_SEND_PRETRIM_TRACE_LIMIT);
    }

    mem.budget = mem.budget || {};
    mem.budget.sendPretrimBudget = getSendPretrimBudget();
    mem.budget.sendPretrimTarget = getSendPretrimTarget();
    syncBudgetTokenSnapshot(mem, {
      bodyTokens: Number(stats.afterTokens || 0),
      systemTokens: Number(stats.systemTokensAfter || 0),
      pluginHintTokens: Number(stats.pluginHintTokensAfter || 0)
    });
    mem.budget.lastCompactedAt = audit.lastAt;
    mem.budget.lastCompactionReason = `send_pretrim:${audit.lastReason || 'unknown'}`;
    mem.systemPrompt = ensureSystemPromptAudit(mem);
    mem.systemPrompt.lastPluginHintTokens = Number(stats.pluginHintTokensAfter || 0);

    if (stats?.compressedBlock && typeof stats.compressedBlock === 'object') {
      const blockId = Number(stats.predictedBlockId || nextSummaryBlockId(mem));
      const appended = appendSummaryBlock(mem, {
        blockId,
        createdAt: audit.lastAt,
        source: normalizeText(String(stats.compressedBlock.source || 'pretrim-distill')),
        startMessageID: normalizeText(String(stats.compressedBlock.startMessageID || '')),
        endMessageID: normalizeText(String(stats.compressedBlock.endMessageID || '')),
        anchorMessageID: normalizeText(String(stats.compressedBlock.anchorMessageID || '')),
        consumedMessages: Number(stats.compressedBlock.consumedMessages || 0),
        summary: normalizeText(String(stats.compressedBlock.summary || ''))
      });
      if (appended) {
        traceItem.blockId = appended.blockId;
      }
    }

    // Conflict hint: high prompt size with little/no savings may indicate injection stacking.
    mem.alerts = mem.alerts || {};
    const bigBefore = Number(stats.beforeTokens || 0) > Math.floor(getSendPretrimBudget() * 1.25);
    const weakSave = Number(stats.savedTokens || 0) < 120;
    if (bigBefore && weakSave) {
      mem.alerts.contextStackRisk = {
        level: 'warn',
        at: audit.lastAt,
        reason: 'high_before_low_saved',
        beforeTokens: Number(stats.beforeTokens || 0),
        afterTokens: Number(stats.afterTokens || 0)
      };
    }

    persistSessionMemory(mem);
  }

  function recordSystemPromptAudit(sessionID, systemParts = [], model = '') {
    const sid = normalizeText(String(sessionID || ''));
    const estimate = estimateSystemPromptTokens(systemParts);
    const auditEnabled = getSystemPromptAuditEnabled();
    writeMemoryConfig((cfg) => {
      const next = cfg && typeof cfg === 'object' ? { ...cfg } : {};
      next.runtimeSystemPrompt = {
        lastObservedTokens: Number(estimate.tokens || 0),
        lastObservedLines: Number(estimate.lines || 0),
        lastObservedAt: new Date().toISOString(),
        lastObservedHash: String(estimate.hash || ''),
        lastObservedPreview: String(estimate.preview || ''),
        lastObservedModel: String(model || ''),
        lastObservedChars: Number(estimate.fullChars || 0),
        lastObservedText: auditEnabled ? String(estimate.fullText || '') : ''
      };
      return next;
    });
    if (!sid || !hasSessionMemoryFile(sid)) return estimate;
    const mem = loadSessionMemory(sid);
    const audit = ensureSystemPromptAudit(mem);
    audit.lastObservedTokens = Number(estimate.tokens || 0);
    audit.lastObservedLines = Number(estimate.lines || 0);
    audit.lastObservedAt = new Date().toISOString();
    audit.lastObservedHash = String(estimate.hash || '');
    audit.lastObservedPreview = String(estimate.preview || '');
    audit.lastObservedModel = String(model || '');
    audit.lastObservedChars = Number(estimate.fullChars || 0);
    audit.lastObservedText = auditEnabled ? String(estimate.fullText || '') : '';
    syncBudgetTokenSnapshot(mem, { systemTokens: Number(estimate.tokens || 0) });
    persistSessionMemory(mem);
    return estimate;
  }

  function getLatestSystemPromptTokens(sessionID = '') {
    const sid = normalizeText(String(sessionID || ''));
    if (sid && hasSessionMemoryFile(sid)) {
      const mem = loadSessionMemory(sid);
      const audit = ensureSystemPromptAudit(mem);
      const tok = Number(audit.lastObservedTokens || mem?.budget?.lastEstimatedSystemTokens || 0);
      if (tok > 0) return tok;
    }
    const cfg = readMemoryConfig();
    const rt = cfg?.runtimeSystemPrompt && typeof cfg.runtimeSystemPrompt === 'object'
      ? cfg.runtimeSystemPrompt
      : {};
    return Number(rt.lastObservedTokens || 0);
  }

  function deriveSessionTitleFromEvents(sessionData) {
    const events = Array.isArray(sessionData?.recentEvents) ? sessionData.recentEvents : [];
    const firstUser = events.find((ev) => {
      if (ev?.kind !== 'user-message') return false;
      const s = normalizeText(String(ev?.summary || ''));
      return s && !isSummaryNoiseText(s);
    });
    if (firstUser) return truncateText(normalizeText(String(firstUser.summary || '')), 60);

    const firstAssistant = events.find((ev) => {
      if (ev?.kind !== 'assistant-message') return false;
      const s = normalizeText(String(ev?.summary || ''));
      return s && !isSummaryNoiseText(s);
    });
    if (firstAssistant) return truncateText(normalizeText(String(firstAssistant.summary || '')), 60);

    return '';
  }

  function charsFromTokenBudget(tokenBudget) {
    return Math.max(200, Number(tokenBudget || 0) * 4);
  }

  function isConversationEvent(ev) {
    return ev?.kind === 'user-message' || ev?.kind === 'assistant-message';
  }

  function isQuestionLikeRecallText(text = '') {
    const t = normalizeText(String(text || ''));
    if (!t) return false;
    return /[?？]|是什么|是啥|什么|哪个|哪一个|多少|告诉我|查看|看看|读取|读一下|查询|全局记忆里|what|which|who|show|tell me|recall/i.test(t);
  }

  function stripRecallQueryFiller(text = '') {
    let clean = normalizeText(String(text || '')).toLowerCase();
    if (!clean) return '';
    clean = clean
      .replace(/\s*(并|然后)?\s*(只回复|最后只回复|仅回复)\s*[^，。；;]*$/i, ' ')
      .replace(/\s*(路径或不知道|不知道)\s*$/i, ' ');
    for (const re of RECALL_FILLER_STRIP_PATTERNS) {
      clean = clean.replace(re, ' ');
    }
    return normalizeText(clean);
  }

  function isLowSignalRecallToken(token = '') {
    const t = normalizeText(String(token || '')).toLowerCase();
    if (!t) return true;
    if (t.length > 80) return true;
    if (RECALL_LOW_SIGNAL_TOKEN_PATTERN.test(t)) return true;
    if (t.length <= 2 && !/[a-z0-9]/i.test(t) && !/(路径|锚点|代号|模型|语言|昵称|名字|称呼)/.test(t)) return true;
    return false;
  }

  function addRecallToken(bucket, token = '') {
    const t = normalizeText(String(token || '')).toLowerCase();
    if (!t) return;
    if (t.length < AUTO_RECALL_MIN_QUERY_LEN) return;
    if (isLowSignalRecallToken(t)) return;
    bucket.add(t);
  }

  function recallTokenWeight(token = '') {
    const t = normalizeText(String(token || '')).toLowerCase();
    if (!t || isLowSignalRecallToken(t)) return 0;
    if (/\/|[a-z]:\\|_\d+|-\d+|\d/.test(t)) return 3.8;
    if (/[a-z]/i.test(t) && t.length >= 4) return 3.2;
    if (/(路径|锚点|目录|文件|文档|代号|名字|称呼|昵称|语言|模型|偏好|规则|配置|答案|结果|方案|计划|工程|项目|插件|记忆)/.test(t)) {
      return t.length >= 4 ? 2.8 : 2.2;
    }
    if (t.length >= 6) return 2.4;
    if (t.length >= 4) return 1.8;
    return 1.2;
  }

  function tokenize(text) {
    const clean = normalizeText(String(text || '')).toLowerCase();
    if (!clean) return [];
    const tokens = new Set();

    for (const match of clean.matchAll(/[a-z0-9]+(?:[._/-][a-z0-9]+)*/g)) {
      addRecallToken(tokens, match[0]);
    }

    const stripped = stripRecallQueryFiller(clean);
    for (const token of stripped.match(RECALL_HIGH_SIGNAL_CN_PATTERN) || []) {
      addRecallToken(tokens, token);
    }
    for (const token of stripped.match(RECALL_KEYWORD_TOKEN_PATTERN) || []) {
      addRecallToken(tokens, token);
    }

    const cnRuns = stripped.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (const run of cnRuns) {
      if (run.length <= 10) addRecallToken(tokens, run);
      if (tokens.size >= 2) continue;
      for (let size = Math.min(4, run.length); size >= 2; size -= 1) {
        for (let i = 0; i + size <= run.length; i += 1) {
          addRecallToken(tokens, run.slice(i, i + size));
          if (tokens.size >= 12) break;
        }
        if (tokens.size >= 12) break;
      }
      if (tokens.size >= 12) break;
    }

    return [...tokens].slice(0, 12);
  }

  function isWeakFollowupRecallQuery(text = '') {
    const clean = normalizeText(String(text || ''));
    if (!clean) return false;
    if (!/(另一个|另外一个|那个|上一个|前一个|之前那个|另一条|剩下那个|对应的|另一个代号|另一个路径|那个代号|那个路径|另一个名字|那个名字)/i.test(clean)) {
      return false;
    }
    return /(?:是什么|是啥|哪个|哪一个|多少|怎么|在哪里|啥|什么|呢|还有呢|还有一个呢|剩下那个呢|剩下哪个呢|那另一个呢|那个呢)|(?:代号|路径|目录|文件|名字|称呼|昵称|结果|方案|项目|计划|模型|语言)/i.test(clean);
  }

  function shouldTriggerWeakFollowupRecall(text = '') {
    const clean = normalizeText(String(text || ''));
    if (!clean || !isWeakFollowupRecallQuery(clean)) return false;
    return /[A-Z]{2,}(?:[-_]\d+)?|\/[\w./-]+|(?:代号|路径|锚点|目录|文件|名字|称呼|昵称|结果|方案|项目|计划|模型|语言)/.test(clean);
  }

  function buildEffectiveRecallQuery(queryText = '', currentSessionID = '', projectName = getProjectName()) {
    const query = normalizeText(String(queryText || ''));
    if (!query || !currentSessionID || !isWeakFollowupRecallQuery(query)) return query;
    if (!hasSessionMemoryFile(currentSessionID, projectName)) return query;

    const sess = loadSessionMemory(currentSessionID, projectName);
    const recent = Array.isArray(sess?.recentEvents) ? sess.recentEvents : [];
    if (!recent.length) return query;

    const snippets = [];
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const ev = recent[i] || {};
      const kind = String(ev.kind || '');
      if (!['user-message', 'assistant-message'].includes(kind)) continue;
      const summary = normalizeText(String(ev.summary || ''));
      if (!summary || isVisibleNoticeText(summary) || isSummaryNoiseText(summary) || isMemoryInjectionText(summary)) continue;
      if (/不知道|no relevant memory found/i.test(summary)) continue;
      const highSignal = /[A-Z]{2,}(?:[-_]\d+)?|\/[\w./-]+|(?:代号|路径|锚点|目录|文件|名字|称呼|昵称|结果|方案|项目|计划|模型|语言)/.test(summary);
      if (!highSignal && kind !== 'user-message') continue;
      snippets.push(summary);
      if (snippets.length >= 4) break;
    }

    if (!snippets.length) return query;
    return normalizeText(`${query} ${snippets.reverse().join(' ')}`);
  }

  function extractContentText(content) {
    if (typeof content === 'string') return normalizeText(content);
    if (Array.isArray(content)) {
      return normalizeText(
        content
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item && typeof item.text === 'string') return item.text;
            if (item && typeof item.content === 'string') return item.content;
            return '';
          })
          .filter(Boolean)
          .join(' ')
      );
    }
    if (content && typeof content === 'object') {
      if (typeof content.text === 'string') return normalizeText(content.text);
      if (typeof content.content === 'string') return normalizeText(content.content);
    }
    return '';
  }

  function stableFingerprint(kind, summary, sessionId, toolName = '') {
    return `${sessionId || 'unknown'}|${kind}|${toolName}|${summary}`;
  }

  function emptyStats() {
    return {
      userMessages: 0,
      assistantMessages: 0,
      toolResults: 0,
      systemEvents: 0
    };
  }

  function defaultPruneAudit() {
    return {
      autoRuns: 0,
      manualRuns: 0,
      discardRemovedTotal: 0,
      extractMovedTotal: 0,
      lastAt: null,
      lastSource: '',
      lastDiscardRemoved: 0,
      lastExtractMoved: 0,
      lastEstimatedBodyTokens: 0
    };
  }

  function ensurePruneAudit(sessionData) {
    if (!sessionData || typeof sessionData !== 'object') return defaultPruneAudit();
    const cur = sessionData.pruneAudit && typeof sessionData.pruneAudit === 'object'
      ? sessionData.pruneAudit
      : {};
    sessionData.pruneAudit = {
      autoRuns: Number(cur.autoRuns || 0),
      manualRuns: Number(cur.manualRuns || 0),
      discardRemovedTotal: Number(cur.discardRemovedTotal || 0),
      extractMovedTotal: Number(cur.extractMovedTotal || 0),
      lastAt: cur.lastAt || null,
      lastSource: cur.lastSource || '',
      lastDiscardRemoved: Number(cur.lastDiscardRemoved || 0),
      lastExtractMoved: Number(cur.lastExtractMoved || 0),
      lastEstimatedBodyTokens: Number(cur.lastEstimatedBodyTokens || 0)
    };
    return sessionData.pruneAudit;
  }

  function recordPruneAudit(sessionData, { source = 'auto', discardRemoved = 0, extractMoved = 0, estimatedTokens = 0 } = {}) {
    const audit = ensurePruneAudit(sessionData);
    if (source === 'auto') audit.autoRuns += 1;
    else audit.manualRuns += 1;
    audit.discardRemovedTotal += Number(discardRemoved || 0);
    audit.extractMovedTotal += Number(extractMoved || 0);
    audit.lastAt = new Date().toISOString();
    audit.lastSource = String(source || 'auto');
    audit.lastDiscardRemoved = Number(discardRemoved || 0);
    audit.lastExtractMoved = Number(extractMoved || 0);
    audit.lastEstimatedBodyTokens = Number(estimatedTokens || 0);
  }

  function sortByUpdated(items) {
    return [...items].sort((a, b) => {
      const ta = Date.parse(a?.updatedAt || a?.createdAt || 0) || 0;
      const tb = Date.parse(b?.updatedAt || b?.createdAt || 0) || 0;
      return tb - ta;
    });
  }

  function extractSessionID(event) {
    const sid = (
      event?.properties?.info?.sessionID ||
      event?.properties?.sessionID ||
      event?.properties?.part?.sessionID ||
      event?.session?.id ||
      event?.data?.sessionID ||
      null
    );
    return isLikelySessionID(sid) ? normalizeText(String(sid || '')) : null;
  }

  function extractSessionTitle(event) {
    return normalizeText(
      event?.properties?.info?.title ||
      event?.session?.title ||
      event?.data?.title ||
      event?.title ||
      ''
    );
  }

  function extractSessionCwd(event) {
    return normalizeText(
      event?.session?.cwd ||
      event?.properties?.info?.cwd ||
      event?.properties?.cwd ||
      event?.data?.cwd ||
      ''
    );
  }

  function extractAbsolutePaths(text) {
    const s = String(text || '');
    if (!s) return [];
    const out = [];
    const quoted = [...s.matchAll(/['"]((?:\/Users\/|\/home\/|[A-Za-z]:\\)[^'"]+)['"]/g)].map((m) => m[1]);
    const unix = s.match(/\/Users\/[^\s"'`<>|]+|\/home\/[^\s"'`<>|]+/g) || [];
    const win = s.match(/[A-Za-z]:\\[^\s"'`<>|]+/g) || [];
    for (const raw of [...quoted, ...unix, ...win]) {
      const cleaned = raw.replace(/[),.;:]+$/g, '').replace(/[\\]+$/g, '');
      if (cleaned.length > 5) out.push(cleaned);
    }
    return [...new Set(out)];
  }

  function extractMessageID(event) {
    return (
      event?.properties?.part?.messageID ||
      event?.properties?.info?.id ||
      event?.properties?.messageID ||
      event?.data?.messageID ||
      event?.message?.id ||
      null
    );
  }

  function extractEventMessageRole(event) {
    const role = normalizeText(
      String(
        event?.properties?.part?.role ||
        event?.properties?.info?.role ||
        event?.data?.role ||
        event?.message?.role ||
        ''
      )
    ).toLowerCase();
    return role === 'assistant' || role === 'user' ? role : '';
  }

  function makeSessionMessageKey(sessionID = '', messageID = '') {
    const sid = normalizeText(String(sessionID || ''));
    const mid = normalizeText(String(messageID || ''));
    if (!sid || !mid) return '';
    return `${sid}:${mid}`;
  }

  function cleanupPendingTextPartState(now = Date.now()) {
    if (pendingTextPartByMessageKey.size <= 400) return;
    for (const [key, state] of pendingTextPartByMessageKey.entries()) {
      if ((now - Number(state?.at || 0)) > 120000) pendingTextPartByMessageKey.delete(key);
    }
  }

  function rememberPendingTextPart(sessionID, messageID, text, rawEvent = null) {
    const key = makeSessionMessageKey(sessionID, messageID);
    const normalized = normalizeText(String(text || ''));
    if (!key || !normalized || isVisibleNoticeText(normalized)) return false;
    const now = Date.now();
    const previous = pendingTextPartByMessageKey.get(key);
    const nextText = !previous?.text
      ? normalized
      : (
        normalized === previous.text ||
        normalized.startsWith(previous.text) ||
        previous.text.startsWith(normalized)
      )
        ? (normalized.length >= previous.text.length ? normalized : previous.text)
        : normalized;
    pendingTextPartByMessageKey.set(key, {
      at: now,
      text: nextText,
      rawEvent: rawEvent || previous?.rawEvent || null
    });
    cleanupPendingTextPartState(now);
    return true;
  }

  function consumePendingTextPart(sessionID, messageID) {
    const key = makeSessionMessageKey(sessionID, messageID);
    if (!key) return null;
    const value = pendingTextPartByMessageKey.get(key) || null;
    if (value) pendingTextPartByMessageKey.delete(key);
    return value;
  }

  function observedReplyOnlyMatches(observedText, candidateText) {
    const observed = normalizeText(String(observedText || ''));
    const candidate = normalizeText(String(candidateText || ''));
    if (!observed || !candidate) return false;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      new RegExp(`(?:只回复|仅回复|只返回|仅返回|只输出|仅输出|只回答|仅回答)\\s*${escaped}$`, 'i'),
      new RegExp(`(?:only reply|reply only|only return|return only|only output|output only)\\s*${escaped}$`, 'i')
    ].some((re) => re.test(observed));
  }

  function inferRoleForUnknownTextPart(sessionID, text = '') {
    const normalized = normalizeText(String(text || ''));
    if (!normalized || isVisibleNoticeText(normalized)) return '';
    const observedAt = Number(sessionObservedUserAtByID.get(sessionID) || lastObservedUserAt || 0);
    if (!observedAt || (Date.now() - observedAt) > OBSERVED_USER_FALLBACK_MAX_AGE_MS) return '';
    const observed = preferObservedUserText(String(
      sessionObservedUserTextByID.get(sessionID) ||
      lastObservedUserText ||
      ''
    ));
    if (!observed) return '';
    if (
      normalized === observed ||
      normalized.startsWith(observed) ||
      observed.startsWith(normalized)
    ) return 'user';
    if (observedReplyOnlyMatches(observed, normalized)) return 'assistant';
    return '';
  }

  function choosePreferredMessageText(role, summaryText = '', pendingText = '') {
    const primary = normalizeText(String(summaryText || ''));
    const secondary = normalizeText(String(pendingText || ''));
    if (!secondary) return primary;
    if (!primary) return secondary;
    const nearSame = (
      primary === secondary ||
      primary.startsWith(secondary) ||
      secondary.startsWith(primary)
    );
    if (nearSame) return secondary.length >= primary.length ? secondary : primary;
    if (role === 'user') return secondary;
    return primary;
  }

  function safeJsonPreview(value, max = 220) {
    try {
      return truncateText(normalizeText(JSON.stringify(value ?? {})), max);
    } catch {
      return '';
    }
  }

  function extractMessageSummaryFromInfo(info) {
    const title = normalizeText(String(info?.summary?.title || ''));
    const body = normalizeText(String(info?.summary?.body || ''));
    if (title && body) return truncateText(`${title} ${body}`, 400);
    if (body) return truncateText(body, 400);
    if (title) return truncateText(title, 400);
    return '';
  }

  function maybeSetRuntimeSessionTitle(event) {
    const sid = extractSessionID(event);
    if (!sid) return;
    const title = extractSessionTitle(event);
    if (!title) return;
    sessionTitleByID.set(sid, title);
    // Keep dashboard title in sync with OpenCode title without creating
    // new session files before the first user message.
    if (hasSessionMemoryFile(sid)) {
      const sessionData = loadSessionMemory(sid);
      if (normalizeText(sessionData.sessionTitle || '') !== title) {
        sessionData.sessionTitle = title;
        persistSessionMemory(sessionData);
        writeDashboardFiles();
      }
    }
  }

  function ensureDashboardDir() {
    if (!fs.existsSync(dashboardDir)) fs.mkdirSync(dashboardDir, { recursive: true });
  }

  function pushLineWithLimit(lines, line, state) {
    if (!line) return;
    const next = `${line}\n`;
    if (state.chars + next.length > state.maxChars) return;
    lines.push(line);
    state.chars += next.length;
  }

  function readProjectMeta(projectName = getProjectName()) {
    return readJson(getProjectMemoryPath(projectName)) || {};
  }

  function writeProjectMeta(projectMeta, projectName = getProjectName()) {
    writeJson(getProjectMemoryPath(projectName), projectMeta || {});
  }

  function readLegacySessionFromMeta(sessionID, projectName = getProjectName()) {
    const meta = readProjectMeta(projectName);
    const legacy = meta?.autoMemory?.sessions?.[sessionID];
    if (!legacy || typeof legacy !== 'object') return null;
    return {
      sessionID,
      project: projectName,
      createdAt: legacy.createdAt || new Date().toISOString(),
      updatedAt: legacy.updatedAt || new Date().toISOString(),
      stats: legacy.stats || emptyStats(),
      recentEvents: Array.isArray(legacy.recentEvents) ? legacy.recentEvents : [],
      summary: {
        compressedText: sanitizeCompressedSummaryText(String(legacy.summary?.compressedText || legacy.lastSummary || '')),
        compressedEvents: Number(legacy.summary?.compressedEvents || 0),
        lastCompressedAt: legacy.summary?.lastCompressedAt || null
      },
      summaryBlocks: [],
      lastFingerprint: legacy.lastFingerprint || ''
    };
  }

  function createEmptySessionMemory(sessionID, projectName = getProjectName()) {
    const now = new Date().toISOString();
    return {
      sessionID,
      sessionTitle: '',
      sessionCwd: normalizeText(process.cwd()),
      project: projectName,
      createdAt: now,
      updatedAt: now,
      stats: emptyStats(),
      recentEvents: [],
      summary: {
        compressedText: '',
        compressedEvents: 0,
        lastCompressedAt: null
      },
      summaryBlocks: [],
      recall: {
        count: 0,
        lastAt: null,
        lastQuery: ''
      },
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
        bodyTokenBudget: AUTO_BODY_TOKEN_BUDGET,
        lastEstimatedBodyTokens: 0,
        lastEstimatedSystemTokens: 0,
        lastEstimatedTotalTokens: 0,
        lastCompactedAt: null,
        lastCompactionReason: ''
      },
      systemPrompt: {
        lastObservedTokens: 0,
        lastObservedLines: 0,
        lastObservedAt: null,
        lastObservedHash: '',
        lastObservedPreview: '',
        lastObservedModel: '',
        lastObservedChars: 0,
        lastObservedText: ''
      },
      pruneAudit: defaultPruneAudit(),
      sendPretrim: defaultSendPretrim(),
      alerts: {},
      lastFingerprint: ''
    };
  }

  function ensureSummaryBlocks(sessionData) {
    if (!sessionData || typeof sessionData !== 'object') return [];
    const arr = Array.isArray(sessionData.summaryBlocks) ? sessionData.summaryBlocks : [];
    sessionData.summaryBlocks = arr
      .filter((b) => b && typeof b === 'object')
      .map((b) => ({
        blockId: Number(b.blockId || 0),
        createdAt: b.createdAt || null,
        source: normalizeText(String(b.source || 'pretrim')),
        startMessageID: normalizeText(String(b.startMessageID || '')),
        endMessageID: normalizeText(String(b.endMessageID || '')),
        anchorMessageID: normalizeText(String(b.anchorMessageID || '')),
        consumedMessages: Number(b.consumedMessages || 0),
        summary: truncateText(normalizeText(String(b.summary || '')), 2400)
      }))
      .filter((b) => Number.isInteger(b.blockId) && b.blockId > 0 && b.summary);
    if (sessionData.summaryBlocks.length > AUTO_SUMMARY_BLOCK_MAX) {
      sessionData.summaryBlocks = sessionData.summaryBlocks.slice(-AUTO_SUMMARY_BLOCK_MAX);
    }
    return sessionData.summaryBlocks;
  }

  function ensureSystemPromptAudit(sessionData) {
    if (!sessionData || typeof sessionData !== 'object') {
      return {
        lastObservedTokens: 0,
        lastObservedLines: 0,
        lastObservedAt: null,
        lastObservedHash: '',
        lastObservedPreview: '',
        lastObservedModel: '',
        lastObservedChars: 0,
        lastObservedText: ''
      };
    }
    const cur = sessionData.systemPrompt && typeof sessionData.systemPrompt === 'object'
      ? sessionData.systemPrompt
      : {};
    sessionData.systemPrompt = {
      lastObservedTokens: Number(cur.lastObservedTokens || 0),
      lastObservedLines: Number(cur.lastObservedLines || 0),
      lastObservedAt: cur.lastObservedAt || null,
      lastObservedHash: String(cur.lastObservedHash || ''),
      lastObservedPreview: String(cur.lastObservedPreview || ''),
      lastObservedModel: String(cur.lastObservedModel || ''),
      lastObservedChars: Number(cur.lastObservedChars || 0),
      lastObservedText: String(cur.lastObservedText || ''),
      lastPluginHintTokens: Number(cur.lastPluginHintTokens || 0)
    };
    return sessionData.systemPrompt;
  }

  function nextSummaryBlockId(sessionData) {
    const arr = ensureSummaryBlocks(sessionData);
    let maxId = 0;
    for (const b of arr) maxId = Math.max(maxId, Number(b.blockId || 0));
    return maxId + 1;
  }

  function appendSummaryBlock(sessionData, block) {
    if (!sessionData || !block || typeof block !== 'object') return null;
    const arr = ensureSummaryBlocks(sessionData);
    const id = Number(block.blockId || nextSummaryBlockId(sessionData));
    const rec = {
      blockId: id,
      createdAt: block.createdAt || new Date().toISOString(),
      source: normalizeText(String(block.source || 'pretrim')),
      startMessageID: normalizeText(String(block.startMessageID || '')),
      endMessageID: normalizeText(String(block.endMessageID || '')),
      anchorMessageID: normalizeText(String(block.anchorMessageID || '')),
      consumedMessages: Number(block.consumedMessages || 0),
      summary: truncateText(normalizeText(String(block.summary || '')), 2400)
    };
    if (!rec.summary) return null;
    arr.push(rec);
    if (arr.length > AUTO_SUMMARY_BLOCK_MAX) {
      sessionData.summaryBlocks = arr.slice(-AUTO_SUMMARY_BLOCK_MAX);
    }
    return rec;
  }

  function ensureSummaryBlockPresent(sessionData, block) {
    if (!sessionData || !block || typeof block !== 'object') return false;
    const id = Number(block.blockId || 0);
    if (!(id > 0)) return false;
    const arr = ensureSummaryBlocks(sessionData);
    const idx = arr.findIndex((x) => Number(x?.blockId || 0) === id);
    if (idx >= 0) {
      arr[idx] = {
        ...arr[idx],
        ...block,
        blockId: id,
        summary: truncateText(normalizeText(String(block.summary || arr[idx]?.summary || '')), 2400)
      };
      return true;
    }
    arr.push({
      blockId: id,
      createdAt: block.createdAt || new Date().toISOString(),
      source: normalizeText(String(block.source || 'pretrim')),
      startMessageID: normalizeText(String(block.startMessageID || '')),
      endMessageID: normalizeText(String(block.endMessageID || '')),
      anchorMessageID: normalizeText(String(block.anchorMessageID || '')),
      consumedMessages: Number(block.consumedMessages || 0),
      summary: truncateText(normalizeText(String(block.summary || '')), 2400)
    });
    if (arr.length > AUTO_SUMMARY_BLOCK_MAX) {
      sessionData.summaryBlocks = arr.slice(-AUTO_SUMMARY_BLOCK_MAX);
    }
    return true;
  }

  function loadSessionMemory(sessionID, projectName = getProjectName()) {
    const filePath = getSessionMemoryPath(sessionID, projectName);
    if (fs.existsSync(filePath)) {
      const data = readJson(filePath);
      if (data && typeof data === 'object' && data.sessionID) {
        if (!normalizeText(data.sessionTitle || '')) {
          data.sessionTitle = deriveSessionTitleFromEvents(data);
        }
        data.summary = data.summary || {};
        const rawSummary = String(data?.summary?.compressedText || '');
        const cleanSummary = sanitizeCompressedSummaryText(rawSummary);
        if (!normalizeText(data.sessionCwd || '')) data.sessionCwd = normalizeText(process.cwd());
        if (isCorruptedSummaryText(rawSummary) && Array.isArray(data.recentEvents) && data.recentEvents.length) {
          // Rebuild from recent events to avoid carrying broken legacy summaries forever.
          data.summary.compressedText = buildCompressedChunk(data.recentEvents.slice(-36), data) || cleanSummary;
          data.summary.lastCompressedAt = new Date().toISOString();
        } else {
          data.summary.compressedText = cleanSummary;
        }
        data.inject = data.inject || {};
        data.inject.globalPrefsCount = Number(data.inject.globalPrefsCount || 0);
        data.inject.currentSummaryCount = Number(data.inject.currentSummaryCount || 0);
        data.inject.triggerRecallCount = Number(data.inject.triggerRecallCount || 0);
        data.inject.memoryDocsCount = Number(data.inject.memoryDocsCount || 0);
        data.inject.lastAt = data.inject.lastAt || null;
        data.inject.lastReason = data.inject.lastReason || '';
        data.inject.lastStatus = data.inject.lastStatus || '';
        data.inject.lastDigest = data.inject.lastDigest || '';
        data.inject.lastSkippedAt = data.inject.lastSkippedAt || null;
        data.inject.lastSkipReason = data.inject.lastSkipReason || '';
        data.inject.lastNoticeAt = data.inject.lastNoticeAt || null;
        data.inject.lastNoticeKey = data.inject.lastNoticeKey || '';
        data.inject.lastNoticeChannel = data.inject.lastNoticeChannel || '';
        data.inject.lastNoticeText = data.inject.lastNoticeText || '';
        ensurePruneAudit(data);
        ensureSendPretrim(data);
        ensureSummaryBlocks(data);
        return data;
      }
    }

    const legacy = readLegacySessionFromMeta(sessionID, projectName);
    if (legacy) return legacy;

    return createEmptySessionMemory(sessionID, projectName);
  }

  function listSessionMemories(projectName = getProjectName()) {
    const results = [];
    const sessionsDir = getProjectSessionsDir(projectName);

    let files = [];
    try {
      files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    } catch {
      files = [];
    }

    for (const file of files) {
      const p = path.join(sessionsDir, file);
      const data = readJson(p);
      if (data && typeof data === 'object' && data.sessionID) {
        results.push(data);
      }
    }

    // Backward compatibility: include legacy sessions not yet migrated.
    const meta = readProjectMeta(projectName);
    const legacySessions = meta?.autoMemory?.sessions && typeof meta.autoMemory.sessions === 'object'
      ? meta.autoMemory.sessions
      : {};

    for (const [sid] of Object.entries(legacySessions)) {
      if (results.some((r) => r.sessionID === sid)) continue;
      const legacy = readLegacySessionFromMeta(sid, projectName);
      if (legacy) results.push(legacy);
    }

    return sortByUpdated(results);
  }

  function getRecentBlockPlaceholders(sessionID, projectName = getProjectName(), limit = 3) {
    if (!sessionID || !hasSessionMemoryFile(sessionID, projectName)) return [];
    const sess = loadSessionMemory(sessionID, projectName);
    const blocks = ensureSummaryBlocks(sess);
    return blocks
      .slice(-Math.max(0, Number(limit || 0)))
      .map((b) => ({
        blockId: Number(b.blockId || 0),
        placeholder: `(b${Number(b.blockId || 0)})`,
        summary: truncateText(normalizeText(String(b.summary || '')), 120)
      }))
      .filter((x) => x.blockId > 0);
  }

  function pruneSessionFiles(projectName = getProjectName(), keepSessionID = '') {
    const all = listSessionMemories(projectName);
    if (all.length <= AUTO_MAX_SESSIONS_PER_PROJECT) return;

    const removable = all
      .filter((s) => s.sessionID !== keepSessionID)
      .slice(AUTO_MAX_SESSIONS_PER_PROJECT - 1);

    for (const s of removable) {
      const p = getSessionMemoryPath(s.sessionID, projectName);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }

  function updateProjectMetaFromSession(sessionData, projectName = getProjectName()) {
    const metaPath = getProjectMemoryPath(projectName);
    const meta = readJson(metaPath) || {};

    if (!meta.autoMemory || typeof meta.autoMemory !== 'object') {
      meta.autoMemory = {
        enabled: true,
        version: AUTO_MEMORY_VERSION,
        createdAt: new Date().toISOString(),
        sessions: {}
      };
    }

    if (!meta.autoMemory.sessions || typeof meta.autoMemory.sessions !== 'object') {
      meta.autoMemory.sessions = {};
    }

    meta.autoMemory.version = AUTO_MEMORY_VERSION;
    meta.autoMemory.updatedAt = new Date().toISOString();

    meta.autoMemory.sessions[sessionData.sessionID] = {
      sessionID: sessionData.sessionID,
      createdAt: sessionData.createdAt,
      updatedAt: sessionData.updatedAt,
      stats: sessionData.stats || emptyStats(),
      // keep only short recent tail in meta to avoid giant file
      recentEvents: Array.isArray(sessionData.recentEvents)
        ? sessionData.recentEvents.slice(-12)
        : [],
      summary: {
        compressedEvents: Number(sessionData?.summary?.compressedEvents || 0),
        lastCompressedAt: sessionData?.summary?.lastCompressedAt || null,
        compressedText: truncateText(normalizeText(String(sessionData?.summary?.compressedText || '')), 600)
      },
      summaryBlocks: {
        count: Array.isArray(sessionData?.summaryBlocks) ? sessionData.summaryBlocks.length : 0,
        latest: Array.isArray(sessionData?.summaryBlocks) && sessionData.summaryBlocks.length
          ? (() => {
              const b = sessionData.summaryBlocks[sessionData.summaryBlocks.length - 1] || {};
              return {
                blockId: Number(b.blockId || 0),
                createdAt: b.createdAt || null,
                source: b.source || '',
                consumedMessages: Number(b.consumedMessages || 0)
              };
            })()
          : null
      },
      lastFingerprint: sessionData.lastFingerprint || ''
    };

    // prune legacy map to avoid growth
    const entries = Object.entries(meta.autoMemory.sessions || {});
    const sorted = entries.sort((a, b) => {
      const ta = Date.parse(a[1]?.updatedAt || a[1]?.createdAt || 0) || 0;
      const tb = Date.parse(b[1]?.updatedAt || b[1]?.createdAt || 0) || 0;
      return tb - ta;
    });
    for (const [sid] of sorted.slice(AUTO_MAX_SESSIONS_PER_PROJECT)) {
      delete meta.autoMemory.sessions[sid];
    }

    writeJson(metaPath, meta);
  }

  function buildCompressedChunk(events, sessionData = null) {
    if (!Array.isArray(events) || events.length === 0) return '';

    const counts = {
      user: 0,
      assistant: 0,
      tool: 0,
      other: 0
    };
    const userHighlights = [];
    const assistantHighlights = [];
    const outcomeHighlights = [];
    const goalHints = [];
    const nextActions = [];
    const decisionHints = [];
    const riskHints = [];
    const todoHints = [];
    const blockerHints = [];
    const toolCounts = new Map();
    const skillCounts = new Map();
    const dirScores = new Map();
    const keyFileScores = new Map();
    const dirSignals = new Map();
    let latestOutcomeKind = '';
    const seen = new Set();

    const addDirScore = (dir, score = 1) => {
      const d = normalizeText(dir);
      if (!d || d.length < 2) return;
      if (!d.startsWith('/Users/') && !d.startsWith('/home/') && !/^[A-Za-z]:[\\/]/.test(d)) return;
      if (/\/\.config\/opencode\/skills\//i.test(d) || /\/node_modules\//i.test(d)) return;
      dirScores.set(d, Number(dirScores.get(d) || 0) + Number(score || 0));
    };

    const addDirSignal = (dir, field, score = 0) => {
      const d = normalizeText(dir);
      if (!d || !dirScores.has(d)) return;
      const cur = dirSignals.get(d) || { goal: 0, result: 0, intensity: 0, continuity: 0, convergence: 0 };
      cur[field] = Number(cur[field] || 0) + Number(score || 0);
      dirSignals.set(d, cur);
    };

    const extractPaths = (text) => {
      const s = String(text || '');
      const out = [];
      const quoted = [...s.matchAll(/['"]((?:\/|[A-Za-z]:\\)[^'"]+)['"]/g)].map((m) => m[1]);
      const unix = s.match(/\/Users\/[^\n"'`<>|]+/g) || [];
      const win = s.match(/[A-Za-z]:\\[^\s"'`<>|]+/g) || [];
      for (const raw of [...quoted, ...unix, ...win]) {
        const cleaned = raw.replace(/[),.;:]+$/g, '').replace(/[\\]+$/g, '');
        if (cleaned.length > 3) out.push(cleaned);
      }
      return out;
    };

    const addSkill = (name) => {
      const n = normalizeText(String(name || '')).toLowerCase();
      if (!n) return;
      skillCounts.set(n, Number(skillCounts.get(n) || 0) + 1);
    };

    for (const ev of events) {
      if (ev?.kind === 'user-message') counts.user += 1;
      else if (ev?.kind === 'assistant-message') counts.assistant += 1;
      else if (ev?.kind === 'tool-result') counts.tool += 1;
      else counts.other += 1;

      const rawMsg = normalizeText(String(ev?.summary || ''));
      const msg = truncateText(rawMsg, 180);
      if (!rawMsg) continue;
      if (isSummaryNoiseText(rawMsg)) continue;
      if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(rawMsg)) continue;
      if (rawMsg.length < 3) continue;
      if (seen.has(`${ev?.kind || 'event'}:${rawMsg}`)) continue;
      seen.add(`${ev?.kind || 'event'}:${rawMsg}`);

      if (ev?.tool) toolCounts.set(ev.tool, Number(toolCounts.get(ev.tool) || 0) + 1);

      if (ev?.tool === 'use_skill') {
        const m1 = msg.match(/skill_name["':\s]+([A-Za-z0-9._-]+)/i);
        const m2 = msg.match(/Launching skill:\s*([A-Za-z0-9._-]+)/i);
        if (m1?.[1]) addSkill(m1[1]);
        if (m2?.[1]) addSkill(m2[1]);
      }
      const m3 = rawMsg.match(/\/\.config\/opencode\/skills\/([A-Za-z0-9._-]+)/i);
      if (m3?.[1]) addSkill(m3[1]);

      const isResultLike = /PASS|FAIL|WROTE|Edit applied successfully|Fixed\s+\S+|error|failed|成功|失败|完成|已生成|已创建/i.test(rawMsg);
      const isProcessLike = /"status":"pending"|"status":"running"|pending|running/i.test(rawMsg);

      if (ev?.kind === 'user-message' && userHighlights.length < 4) userHighlights.push(msg);
      if (ev?.kind === 'assistant-message' && assistantHighlights.length < 4) assistantHighlights.push(msg);
      if (goalHints.length < 3 && ev?.kind === 'user-message' && /请|需要|帮我|目标|完成|交付|回复|写|生成|修复|看一下|路径/i.test(rawMsg)) {
        goalHints.push(msg);
      }
      if (ev?.kind === 'tool-result' && isResultLike && outcomeHighlights.length < 8) {
        const hasToolPrefix = /^\[[^\]]+\]\s/.test(msg);
        const tool = ev?.tool ? `[${ev.tool}] ` : '';
        outcomeHighlights.push(hasToolPrefix ? msg : `${tool}${msg}`);
        latestOutcomeKind = /FAIL|error|failed|失败/i.test(msg) ? 'blocked' : 'progress';
      } else if (ev?.kind === 'assistant-message' && /完成|已生成|done|finished|created/i.test(msg) && outcomeHighlights.length < 8) {
        outcomeHighlights.push(msg);
        latestOutcomeKind = 'done';
      }

      if (decisionHints.length < 4 && /决定|采用|使用|必须|约束|计划|方案|将会|will|must|plan|decide/i.test(msg)) {
        decisionHints.push(msg);
      }
      if (riskHints.length < 3 && /错误|失败|冲突|超时|缺失|问题|风险|error|failed|conflict|timeout|missing/i.test(msg)) {
        riskHints.push(msg);
      }
      if (blockerHints.length < 3 && /FAIL|error|failed|失败|阻塞|missing/i.test(msg)) {
        blockerHints.push(msg);
      }
      if (
        todoHints.length < 3 &&
        ((ev?.kind === 'user-message' && /待办|下一步|TODO|next|follow[- ]?up|to do/i.test(msg)) ||
          /(^|\s)(TODO|next step|follow[- ]?up)(\s|:|$)/i.test(msg))
      ) {
        todoHints.push(msg);
      }
      if (nextActions.length < 3 && /需要|请|下一步|TODO|next|修复|补充|继续/i.test(rawMsg)) {
        nextActions.push(msg);
      }

      for (const p of extractPaths(rawMsg)) {
        const dir = path.extname(p) ? path.dirname(p) : p;
        let score = 1;
        if (ev?.kind === 'user-message') score += 2;
        if (ev?.kind === 'tool-result') score += 1;
        if (/WROTE|output=|已生成|写入/i.test(rawMsg)) score += 4;
        if (/PASS|FAIL|error|failed|失败/i.test(rawMsg)) score += 3;
        if (/read|cat|view|查看/i.test(rawMsg) && !/WROTE|Edit applied|Fixed/i.test(rawMsg)) score -= 1;
        addDirScore(dir, score);
        addDirSignal(dir, 'intensity', 1);
        addDirSignal(dir, 'continuity', 0.5);
        if (ev?.kind === 'user-message') addDirSignal(dir, 'goal', 1.5);
        if (/PASS|FAIL|WROTE|output=|已生成|写入/i.test(rawMsg)) addDirSignal(dir, 'result', 2);
        if (/response_package|output|deliver|交付|投稿|manuscript|review/i.test(rawMsg)) addDirSignal(dir, 'convergence', 1);
        if (path.extname(p)) {
          keyFileScores.set(p, Number(keyFileScores.get(p) || 0) + Math.max(score, 1));
        }
      }
    }

    const keyFacts = [...userHighlights, ...assistantHighlights].slice(0, 6);
    const toolTop = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const skillTop = [...skillCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const isGoodDir = (dir) => {
      const d = normalizeText(dir);
      if (!d) return false;
      if (/^\/[A-Za-z]$/.test(d)) return false;
      if (/^\/Users\/[^/]+$/.test(d)) return false;
      if (/^\/Users\/[^/]+\/[^/]{1,4}$/.test(d)) return false;
      const depth = d.split('/').filter(Boolean).length;
      return depth >= 4;
    };
    const workdirs = [...dirScores.entries()]
      .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
      .map((x) => x[0])
      .filter((d) => isGoodDir(d))
      .filter((d, i, arr) => arr.findIndex((o) => o === d || o.endsWith(d) || d.endsWith(o)) === i)
      .slice(0, 5);
    const keyFiles = [...keyFileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map((x) => x[0])
      .filter((f, i, arr) => arr.findIndex((o) => o === f) === i)
      .slice(0, 5);
    const sessionCwd = normalizeText(String(sessionData?.sessionCwd || process.cwd()));
    const recommendedWorkdir = workdirs.length ? workdirs[0] : sessionCwd;
    const relatedWorkdirs = workdirs.slice(1);
    const status = blockerHints.length
      ? 'blocked'
      : (latestOutcomeKind || (outcomeHighlights.length ? 'progress' : 'in-progress'));

    const lines = [];
    lines.push(`## Structured Session Summary`);
    lines.push(`- window: ${new Date().toISOString()} · events=${events.length} (u=${counts.user}, a=${counts.assistant}, t=${counts.tool}, o=${counts.other})`);
    lines.push(`- status: ${status}`);
    lines.push(`- workspace: session_cwd=${sessionCwd || 'N/A'} · recommended_workdir=${recommendedWorkdir || 'N/A'}`);
    if (relatedWorkdirs.length) {
      lines.push(`- related_workdirs:`);
      relatedWorkdirs.slice(0, 4).forEach((d) => lines.push(`  - ${truncateText(d, 160)}`));
    }
    lines.push(`- key facts:`);
    if (keyFacts.length) keyFacts.forEach((x) => lines.push(`  - ${x}`));
    else lines.push(`  - no stable key fact extracted`);
    lines.push(`- task goal:`);
    if (goalHints.length) goalHints.slice(0, 3).forEach((x) => lines.push(`  - ${x}`));
    else if (keyFacts.length) lines.push(`  - ${keyFacts[0]}`);
    else lines.push(`  - not explicit`);
    lines.push(`- key outcomes:`);
    if (outcomeHighlights.length) outcomeHighlights.slice(0, 6).forEach((x) => lines.push(`  - ${x}`));
    else lines.push(`  - no high-signal outcome captured`);
    lines.push(`- tools used:`);
    if (toolTop.length) toolTop.forEach(([k, v]) => lines.push(`  - ${k} (${v})`));
    else lines.push(`  - none`);
    lines.push(`- skills used:`);
    if (skillTop.length) skillTop.forEach(([k, v]) => lines.push(`  - ${k} (${v})`));
    else lines.push(`  - none detected`);
    lines.push(`- key files:`);
    if (keyFiles.length) keyFiles.forEach((f) => lines.push(`  - ${truncateText(f, 180)}`));
    else lines.push(`  - none extracted`);
    lines.push(`- decisions/constraints:`);
    if (decisionHints.length) decisionHints.forEach((x) => lines.push(`  - ${x}`));
    else lines.push(`  - no explicit decision captured`);
    lines.push(`- blockers:`);
    if (blockerHints.length) blockerHints.forEach((x) => lines.push(`  - ${x}`));
    else lines.push(`  - none`);
    lines.push(`- todo/risks:`);
    if (todoHints.length) todoHints.forEach((x) => lines.push(`  - TODO: ${x}`));
    if (riskHints.length) riskHints.forEach((x) => lines.push(`  - RISK: ${x}`));
    if (!todoHints.length && !riskHints.length) lines.push(`  - none detected`);
    lines.push(`- next actions:`);
    if (nextActions.length) nextActions.slice(0, 3).forEach((x) => lines.push(`  - ${x}`));
    else if (blockerHints.length) lines.push(`  - resolve blockers listed above`);
    else lines.push(`  - continue from recommended_workdir and verify outputs`);
    lines.push(`- workdir scoring:`);
    if (workdirs.length) {
      workdirs.slice(0, 3).forEach((d) => {
        const sig = dirSignals.get(d) || {};
        lines.push(
          `  - ${truncateText(d, 140)} · goal=${Number(sig.goal || 0).toFixed(1)} result=${Number(sig.result || 0).toFixed(1)} intensity=${Number(sig.intensity || 0).toFixed(1)} continuity=${Number(sig.continuity || 0).toFixed(1)} convergence=${Number(sig.convergence || 0).toFixed(1)}`
        );
      });
    } else {
      lines.push(`  - no workdir score`);
    }
    lines.push(`- handoff anchor:`);
    lines.push(`  - Continue in ${recommendedWorkdir || sessionCwd || 'current workspace'}; start by checking key outcomes and key files, then execute next actions.`);

    const listOrNone = (arr, fallback = 'none') => {
      const safe = Array.isArray(arr) ? arr.filter(Boolean) : [];
      if (!safe.length) return `  - ${fallback}`;
      return safe.map((x) => `  - ${truncateText(String(x), 220)}`).join('\n');
    };
    const vars = {
      window: `${new Date().toISOString()} · events=${events.length} (u=${counts.user}, a=${counts.assistant}, t=${counts.tool}, o=${counts.other})`,
      events: `${events.length} (u=${counts.user}, a=${counts.assistant}, t=${counts.tool}, o=${counts.other})`,
      status,
      sessionCwd: sessionCwd || 'N/A',
      recommendedWorkdir: recommendedWorkdir || 'N/A',
      relatedWorkdirs: listOrNone(relatedWorkdirs.slice(0, 4)),
      keyFacts: listOrNone(keyFacts, 'no stable key fact extracted'),
      taskGoal: listOrNone(goalHints.slice(0, 3), keyFacts[0] || 'not explicit'),
      keyOutcomes: listOrNone(outcomeHighlights.slice(0, 6), 'no high-signal outcome captured'),
      toolsUsed: listOrNone(toolTop.map(([k, v]) => `${k} (${v})`), 'none'),
      skillsUsed: listOrNone(skillTop.map(([k, v]) => `${k} (${v})`), 'none detected'),
      keyFiles: listOrNone(keyFiles, 'none extracted'),
      decisions: listOrNone(decisionHints, 'no explicit decision captured'),
      blockers: listOrNone(blockerHints, 'none'),
      todoRisks: listOrNone([
        ...todoHints.map((x) => `TODO: ${x}`),
        ...riskHints.map((x) => `RISK: ${x}`)
      ], 'none detected'),
      nextActions: listOrNone(
        nextActions.slice(0, 3).length ? nextActions.slice(0, 3) : (blockerHints.length ? ['resolve blockers listed above'] : ['continue from recommended_workdir and verify outputs'])
      ),
      workdirScoring: listOrNone(
        workdirs.slice(0, 3).map((d) => {
          const sig = dirSignals.get(d) || {};
          return `${truncateText(d, 140)} · goal=${Number(sig.goal || 0).toFixed(1)} result=${Number(sig.result || 0).toFixed(1)} intensity=${Number(sig.intensity || 0).toFixed(1)} continuity=${Number(sig.continuity || 0).toFixed(1)} convergence=${Number(sig.convergence || 0).toFixed(1)}`;
        }),
        'no workdir score'
      ),
      handoffAnchor: listOrNone([`Continue in ${recommendedWorkdir || sessionCwd || 'current workspace'}; start by checking key outcomes and key files, then execute next actions.`])
    };
    const activeTemplateName = normalizeText(String(getSettingByAliases(['activeSummaryTemplateName', 'active_summary_template_name'], '')));
    const templateStore = getSettingByAliases(['summaryTemplates', 'summary_templates'], {});
    let customTpl = '';
    if (templateStore && typeof templateStore === 'object') {
      const store = templateStore;
      if (activeTemplateName && typeof store[activeTemplateName] === 'string') customTpl = normalizeText(String(store[activeTemplateName]));
      if (!customTpl && typeof store.default === 'string') customTpl = normalizeText(String(store.default));
    }
    if (!customTpl) customTpl = normalizeText(String(getSettingByAliases(['summaryTemplateText', 'summary_template_text'], '')));
    if (customTpl) {
      let out = customTpl;
      for (const [k, v] of Object.entries(vars)) {
        out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
      }
      return normalizeText(out);
    }
    return lines.join('\n');
  }

  function compressSessionMemory(sessionData) {
    if (!Array.isArray(sessionData.recentEvents)) sessionData.recentEvents = [];

    if (sessionData.recentEvents.length <= getSummaryTriggerEvents()) return;

    const toCompress = sessionData.recentEvents.slice(
      0,
      Math.max(0, sessionData.recentEvents.length - getSummaryKeepRecentEvents())
    );
    if (!toCompress.length) return;

    const chunk = buildCompressedChunk(toCompress, sessionData);
      const current = sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || ''));
    const merged = [current, chunk].filter(Boolean).join('\n\n');

    sessionData.summary = {
      compressedText: truncateFromEnd(merged, getSummaryMaxChars()),
      compressedEvents: Number(sessionData?.summary?.compressedEvents || 0) + toCompress.length,
      lastCompressedAt: new Date().toISOString()
    };

    sessionData.recentEvents = sessionData.recentEvents.slice(-getSummaryKeepRecentEvents());
  }

  function estimateBodyTokens(sessionData) {
    const events = Array.isArray(sessionData?.recentEvents) ? sessionData.recentEvents : [];
    let tokens = 0;
    for (const ev of events) {
      if (!isConversationEvent(ev)) continue;
      tokens += estimateTokensFromText(ev?.summary || '');
    }
    tokens += estimateTokensFromText(sessionData?.summary?.compressedText || '');
    return tokens;
  }

  function appendCompressedSummaryChunk(sessionData, eventsToCompress) {
    const chunk = buildCompressedChunk(eventsToCompress, sessionData);
    const current = sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || ''));
    const merged = [current, chunk].filter(Boolean).join('\n\n');
    sessionData.summary = {
      compressedText: truncateFromEnd(merged, getSummaryMaxCharsBudgetMode()),
      compressedEvents: Number(sessionData?.summary?.compressedEvents || 0) + eventsToCompress.length,
      lastCompressedAt: new Date().toISOString()
    };
  }

  function compactConversationByBudget(sessionData) {
    if (!Array.isArray(sessionData.recentEvents) || !sessionData.recentEvents.length) {
      return { extracted: 0, estimated: Number(sessionData?.budget?.lastEstimatedBodyTokens || 0) };
    }

    const budget = AUTO_BODY_TOKEN_BUDGET;
    const softLimit = Math.floor(budget * AUTO_BODY_BUDGET_SOFT_RATIO);
    const hardLimit = Math.floor(budget * AUTO_BODY_BUDGET_HARD_RATIO);
    const target = Math.floor(budget * AUTO_BODY_BUDGET_TARGET_RATIO);
    let estimated = estimateBodyTokens(sessionData);

    sessionData.budget = sessionData.budget || {
      bodyTokenBudget: budget,
      lastEstimatedBodyTokens: 0,
      lastCompactedAt: null,
      lastCompactionReason: ''
    };
    sessionData.budget.bodyTokenBudget = budget;
    syncBudgetTokenSnapshot(sessionData, { bodyTokens: estimated });

    if (estimated <= softLimit) return { extracted: 0, estimated };

    let extracted = 0;
    let guard = 0;
    while (estimated > target && guard < 12) {
      guard += 1;
      const convoIndices = [];
      for (let i = 0; i < sessionData.recentEvents.length; i += 1) {
        if (isConversationEvent(sessionData.recentEvents[i])) convoIndices.push(i);
      }
      if (convoIndices.length <= AUTO_BODY_KEEP_RECENT_CONVO_EVENTS) break;

      const keepFrom = convoIndices.length - AUTO_BODY_KEEP_RECENT_CONVO_EVENTS;
      const compactable = convoIndices.slice(0, keepFrom);
      if (!compactable.length) break;

      const batchSize = estimated >= hardLimit ? 10 : 6;
      const selected = compactable.slice(0, batchSize);
      const selectedSet = new Set(selected);
      const toCompress = selected.map((idx) => sessionData.recentEvents[idx]).filter(Boolean);
      if (!toCompress.length) break;

      appendCompressedSummaryChunk(sessionData, toCompress);
      sessionData.recentEvents = sessionData.recentEvents.filter((_, idx) => !selectedSet.has(idx));
      extracted += toCompress.length;
      estimated = estimateBodyTokens(sessionData);
    }

    syncBudgetTokenSnapshot(sessionData, { bodyTokens: estimated });
    if (estimated > softLimit) {
      sessionData.budget.lastCompactedAt = new Date().toISOString();
      sessionData.budget.lastCompactionReason = `conversation_budget_over_soft_limit(${softLimit})`;
    }
    return { extracted, estimated };
  }

  function isHighSignalToolSummary(text) {
    const s = normalizeText(String(text || ''));
    if (!s) return false;
    return /PASS|FAIL|WROTE|Fixed|Edit applied|error|failed|成功|失败|完成|已生成|已创建|路径|path|目录|workdir|response_package/i.test(s);
  }

  function isDiscardableToolSummary(text) {
    const s = normalizeText(String(text || ''));
    if (!s) return false;
    if (isHighSignalToolSummary(s)) return false;
    if (/"status":"pending"|"status":"running"|\bpending\b|\brunning\b/i.test(s)) return true;
    if (/^(\[[^\]]+\]\s*)?input=\{\}\s*output=\{\s*"?status"?\s*:\s*"?pending"?/i.test(s)) return true;
    if (/^\[[^\]]+\]\s*input=.*\soutput=\s*$/i.test(s)) return true;
    return false;
  }

  function discardLowValueToolEvents(sessionData, options = {}) {
    const keepRecent = Number(options.keepRecent || AUTO_DISCARD_KEEP_RECENT_TOOL_EVENTS);
    const maxRemovals = Number(options.maxRemovals || getDiscardMaxRemovalsPerPass());
    const events = Array.isArray(sessionData?.recentEvents) ? sessionData.recentEvents : [];
    if (!events.length) return { removed: 0 };

    const toolIdx = [];
    for (let i = 0; i < events.length; i += 1) {
      if (events[i]?.kind === 'tool-result') toolIdx.push(i);
    }
    if (toolIdx.length <= keepRecent) return { removed: 0 };

    const protectedSet = new Set(toolIdx.slice(-keepRecent));
    const removeSet = new Set();
    for (const idx of toolIdx) {
      if (protectedSet.has(idx)) continue;
      const ev = events[idx];
      if (isDiscardableToolSummary(ev?.summary || '')) {
        removeSet.add(idx);
        if (removeSet.size >= maxRemovals) break;
      }
    }

    if (!removeSet.size) return { removed: 0 };

    const removedEvents = events.filter((_, idx) => removeSet.has(idx));
    const removedByTool = new Map();
    for (const ev of removedEvents) {
      const key = ev?.tool || 'tool';
      removedByTool.set(key, Number(removedByTool.get(key) || 0) + 1);
    }

    sessionData.recentEvents = events.filter((_, idx) => !removeSet.has(idx));
    appendCompressedSummaryChunk(sessionData, removedEvents.map((ev) => ({
      ...ev,
      summary: `[discarded-low-signal] ${truncateText(normalizeText(String(ev?.summary || '')), 160)}`
    })));

    return {
      removed: removeSet.size,
      removedByTool: [...removedByTool.entries()].sort((a, b) => b[1] - a[1])
    };
  }

  function extractSessionContext(sessionData, options = {}) {
    const events = Array.isArray(sessionData?.recentEvents) ? sessionData.recentEvents : [];
    if (!events.length) return { extracted: 0 };
    const maxExtract = Math.max(6, Number(options.maxExtract || getExtractEventsPerPass()));
    const keepRecentConvo = Math.max(8, Number(options.keepRecentConvo || AUTO_BODY_KEEP_RECENT_CONVO_EVENTS));

    const convoIdx = [];
    for (let i = 0; i < events.length; i += 1) {
      if (isConversationEvent(events[i])) convoIdx.push(i);
    }
    if (convoIdx.length <= keepRecentConvo) return { extracted: 0 };

    const keepFrom = convoIdx.length - keepRecentConvo;
    const extractableConvo = convoIdx.slice(0, keepFrom);
    const picked = extractableConvo.slice(0, maxExtract);
    if (!picked.length) return { extracted: 0 };

    const pickedSet = new Set(picked);
    const selected = events.filter((_, idx) => pickedSet.has(idx));
    appendCompressedSummaryChunk(sessionData, selected);
    sessionData.recentEvents = events.filter((_, idx) => !pickedSet.has(idx));
    return { extracted: picked.length };
  }

  function enforceSessionFileBudget(sessionData, sessionPath) {
    let guard = 0;
    while (fs.existsSync(sessionPath) && fs.statSync(sessionPath).size > AUTO_SESSION_FILE_MAX_BYTES && guard < 8) {
      guard += 1;
      ensureSummaryBlocks(sessionData);

      const events = Array.isArray(sessionData.recentEvents) ? sessionData.recentEvents : [];
      if (events.length > 6) {
        const cut = Math.max(1, events.length - 6);
        const chunk = buildCompressedChunk(events.slice(0, cut), sessionData);
        const merged = [
          sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || '')),
          chunk
        ].filter(Boolean).join('\n\n');
        sessionData.summary = {
          compressedText: truncateFromEnd(merged, getSummaryMaxCharsBudgetMode()),
          compressedEvents: Number(sessionData?.summary?.compressedEvents || 0) + cut,
          lastCompressedAt: new Date().toISOString()
        };
        sessionData.recentEvents = events.slice(cut);
      } else {
        sessionData.summary = {
          compressedText: truncateFromEnd(
            sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || '')),
            Math.min(getSummaryMaxCharsBudgetMode(), 1000)
          ),
          compressedEvents: Number(sessionData?.summary?.compressedEvents || 0),
          lastCompressedAt: new Date().toISOString()
        };
        sessionData.recentEvents = events.slice(-4).map((ev) => ({
          ts: ev?.ts || new Date().toISOString(),
          kind: ev?.kind || 'event',
          tool: ev?.tool,
          summary: truncateText(normalizeText(String(ev?.summary || '')), 160)
        }));
      }

      if (sessionData?.recall?.lastQuery) {
        sessionData.recall.lastQuery = truncateText(normalizeText(String(sessionData.recall.lastQuery)), 120);
      }

      sessionData.budget = sessionData.budget || {};
      sessionData.budget.lastCompactedAt = new Date().toISOString();
      sessionData.budget.lastCompactionReason = `session_file_size_over_limit(${AUTO_SESSION_FILE_MAX_BYTES})`;

      if (Array.isArray(sessionData.summaryBlocks) && sessionData.summaryBlocks.length > 0) {
        if (sessionData.summaryBlocks.length > Math.max(12, Math.floor(AUTO_SUMMARY_BLOCK_MAX / 2))) {
          sessionData.summaryBlocks = sessionData.summaryBlocks.slice(-Math.max(12, Math.floor(AUTO_SUMMARY_BLOCK_MAX / 2)));
        }
        sessionData.summaryBlocks = sessionData.summaryBlocks.map((b) => ({
          ...b,
          summary: truncateText(normalizeText(String(b?.summary || '')), 800)
        }));
      }

      writeJson(sessionPath, sessionData);
      if (fs.statSync(sessionPath).size <= AUTO_SESSION_FILE_TARGET_BYTES) break;
    }
  }

  function persistSessionMemory(sessionData, projectName = getProjectName()) {
    sessionData.updatedAt = new Date().toISOString();
    ensureSummaryBlocks(sessionData);
    const sessionPath = getSessionMemoryPath(sessionData.sessionID, projectName);
    if (fs.existsSync(sessionPath)) {
      const existing = readJson(sessionPath) || {};
      const existingBlocks = Array.isArray(existing.summaryBlocks) ? existing.summaryBlocks : [];
      const nextBlocks = Array.isArray(sessionData.summaryBlocks) ? sessionData.summaryBlocks : [];
      if (existingBlocks.length) {
        const byId = new Map();
        for (const b of existingBlocks) {
          const id = Number(b?.blockId || 0);
          if (id > 0 && !byId.has(id)) byId.set(id, b);
        }
        for (const b of nextBlocks) {
          const id = Number(b?.blockId || 0);
          if (id > 0) byId.set(id, b);
        }
        sessionData.summaryBlocks = [...byId.values()]
          .sort((a, b) => Number(a?.blockId || 0) - Number(b?.blockId || 0))
          .slice(-AUTO_SUMMARY_BLOCK_MAX);
      }

      // Preserve max counters across concurrent writes.
      const oldPrune = existing?.pruneAudit && typeof existing.pruneAudit === 'object' ? existing.pruneAudit : null;
      if (oldPrune && sessionData?.pruneAudit && typeof sessionData.pruneAudit === 'object') {
        sessionData.pruneAudit.autoRuns = Math.max(
          Number(sessionData.pruneAudit.autoRuns || 0),
          Number(oldPrune.autoRuns || 0)
        );
        sessionData.pruneAudit.manualRuns = Math.max(
          Number(sessionData.pruneAudit.manualRuns || 0),
          Number(oldPrune.manualRuns || 0)
        );
        sessionData.pruneAudit.discardRemovedTotal = Math.max(
          Number(sessionData.pruneAudit.discardRemovedTotal || 0),
          Number(oldPrune.discardRemovedTotal || 0)
        );
        sessionData.pruneAudit.extractMovedTotal = Math.max(
          Number(sessionData.pruneAudit.extractMovedTotal || 0),
          Number(oldPrune.extractMovedTotal || 0)
        );
      }
    }
    writeJson(sessionPath, sessionData);
    enforceSessionFileBudget(sessionData, sessionPath);
    updateProjectMetaFromSession(sessionData, projectName);
    pruneSessionFiles(projectName, sessionData.sessionID);
  }

  function appendAutoEvent({ sessionID, kind, summary, rawEvent = null, toolName = '' }) {
    try {
      if (!sessionID || !kind || !isLikelySessionID(sessionID)) return;

      const projectName = getProjectName();
      const sessionData = loadSessionMemory(sessionID, projectName);
      const cwdFromEvent = extractSessionCwd(rawEvent);
      if (cwdFromEvent) sessionData.sessionCwd = cwdFromEvent;
      else if (!normalizeText(sessionData.sessionCwd || '')) sessionData.sessionCwd = normalizeText(process.cwd());
      const titleFromEvent = extractSessionTitle(rawEvent);
      if (titleFromEvent) sessionData.sessionTitle = titleFromEvent;
      if (!normalizeText(sessionData.sessionTitle || '')) {
        const runtimeTitle = sessionTitleByID.get(sessionID) || '';
        if (runtimeTitle) sessionData.sessionTitle = runtimeTitle;
      }
      const cleanSummary = truncateText(normalizeText(summary || ''));
      if (isMemoryInjectionText(cleanSummary)) return;
      if (isSummaryNoiseText(cleanSummary)) return;
      const fp = stableFingerprint(kind, cleanSummary, sessionID, toolName);

      if (sessionData.lastFingerprint === fp) return;

      const eventRecord = {
        ts: new Date().toISOString(),
        kind,
        summary: cleanSummary
      };

      if (toolName) eventRecord.tool = toolName;
      if (rawEvent?.type) eventRecord.eventType = rawEvent.type;

      sessionData.stats = sessionData.stats || emptyStats();
      sessionData.recentEvents = Array.isArray(sessionData.recentEvents) ? sessionData.recentEvents : [];
      let insertIndex = -1;
      let insertBeforeTs = '';
      if (kind === 'user-message') {
        for (let i = sessionData.recentEvents.length - 1; i >= 0; i -= 1) {
          const ev = sessionData.recentEvents[i] || {};
          if (String(ev.kind || '') !== 'assistant-message' || !ev.inferredUserTurn) continue;
          delete ev.inferredUserTurn;
          sessionData.stats.userMessages = Math.max(0, Number(sessionData.stats.userMessages || 0) - 1);
          insertIndex = i;
          insertBeforeTs = shiftIsoTimestamp(ev.ts, -1) || '';
          break;
        }
      }
      if (insertBeforeTs) eventRecord.ts = insertBeforeTs;
      if (insertIndex >= 0) sessionData.recentEvents.splice(insertIndex, 0, eventRecord);
      else sessionData.recentEvents.push(eventRecord);
      if (kind === 'user-message') {
        const effectiveIndex = insertIndex >= 0 ? insertIndex : (sessionData.recentEvents.length - 1);
        collapseAdjacentDuplicateUserEvents(sessionData, effectiveIndex);
        collapseTransientInitialUserEvent(sessionData, sessionID, effectiveIndex);
      }
      const shouldRefreshTitleFromDerivedUser = kind === 'user-message' && insertIndex >= 0;
      if (!normalizeText(sessionData.sessionTitle || '') || shouldRefreshTitleFromDerivedUser) {
        const derivedTitle = deriveSessionTitleFromEvents(sessionData);
        if (derivedTitle) sessionData.sessionTitle = derivedTitle;
      }
      if (sessionData.recentEvents.length > getMaxEventsPerSession()) {
        sessionData.recentEvents = sessionData.recentEvents.slice(-getMaxEventsPerSession());
      }

      if (kind === 'user-message') sessionData.stats.userMessages = (sessionData.stats.userMessages || 0) + 1;
      else if (kind === 'assistant-message') sessionData.stats.assistantMessages = (sessionData.stats.assistantMessages || 0) + 1;
      else if (kind === 'tool-result') sessionData.stats.toolResults = (sessionData.stats.toolResults || 0) + 1;
      else sessionData.stats.systemEvents = (sessionData.stats.systemEvents || 0) + 1;

      // Some run/front-end paths may omit explicit user events. Keep counters sane:
      // if assistant content exists but no user event has ever been recorded, infer one user turn.
      if (kind === 'assistant-message' && Number(sessionData.stats.userMessages || 0) === 0) {
        const hasUserEvent = Array.isArray(sessionData.recentEvents)
          && sessionData.recentEvents.some((ev) => String(ev?.kind || '') === 'user-message');
        if (!hasUserEvent) {
          sessionData.stats.userMessages = 1;
          eventRecord.inferredUserTurn = true;
        }
      }

      sessionData.lastFingerprint = fp;
      compressSessionMemory(sessionData);
      const compactResult = compactConversationByBudget(sessionData) || { extracted: 0, estimated: 0 };
      const discardResult = discardLowValueToolEvents(sessionData);
      const estimatedTokens = estimateBodyTokens(sessionData);
      recordPruneAudit(sessionData, {
        source: 'auto',
        discardRemoved: Number(discardResult.removed || 0),
        extractMoved: Number(compactResult.extracted || 0),
        estimatedTokens
      });
      if (discardResult.removed > 0) {
        sessionData.budget = sessionData.budget || {};
        sessionData.budget.lastCompactedAt = new Date().toISOString();
        sessionData.budget.lastCompactionReason = `discard_low_signal_tools(${discardResult.removed})`;
        if (getVisibleNoticeForDiscard()) {
          void emitVisibleNotice(
            sessionID,
            `已裁剪 ${discardResult.removed} 条低信号工具输出，正文估算 ~${estimatedTokens} tokens`,
            'discard:auto'
          );
        }
      }
      persistSessionMemory(sessionData, projectName);
      writeDashboardFiles();
    } catch (err) {
      console.error('memory-system auto event write failed:', err);
    }
  }

  function shouldTriggerRecall(text) {
    const t = normalizeText(String(text || ''));
    if (!t) return false;
    return RECALL_TRIGGER_PATTERNS.some((re) => re.test(t));
  }

  function shouldBypassSendPretrimForAgent(agent) {
    const a = normalizeText(String(agent || '')).toLowerCase();
    if (!a) return false;
    if (a === 'orchestrator') return false;
    // OpenCode real interactive sessions commonly run under "build".
    // Bypassing all non-orchestrator agents disables pretrim in normal usage.
    if (a === 'build') return false;
    return [
      'title',
      'title-generator',
      'session-title',
      'naming',
      'summarizer',
      'summary',
      'internal'
    ].some((token) => a === token || a.includes(token));
  }

  function referencesAnotherSessionTitle(text, currentSessionID = '') {
    const t = normalizeText(String(text || ''));
    if (!t || t.length < 6) return false;
    const sessions = listSessionMemories(getProjectName());
    for (const s of sessions) {
      if (!s?.sessionID || s.sessionID === currentSessionID) continue;
      const title = normalizeText(String(s?.sessionTitle || ''));
      if (!title || title.length < 6) continue;
      if (t.includes(title) || title.includes(t)) return true;
    }
    return false;
  }

  function findDirectRecallSessionMatch(queryText = '', projectName = getProjectName(), currentSessionID = '') {
    const query = normalizeText(String(queryText || ''));
    if (!query) return null;
    const q = query.toLowerCase();
    const explicitSessionSelector =
      /\b(session|sid)\b/i.test(query) ||
      /会话|标题|session\s*id|sessionid|对话/.test(query) ||
      /[“"'`「『].+?[”"'`」』]/.test(query);
    if (!explicitSessionSelector) return null;
    const sessions = listSessionMemories(projectName);
    let best = null;
    for (const s of sessions) {
      const sessionID = normalizeText(String(s?.sessionID || ''));
      if (!sessionID || (currentSessionID && sessionID === currentSessionID)) continue;
      const title = normalizeText(String(s?.sessionTitle || ''));
      let score = 0;
      if (sessionID && (q === sessionID.toLowerCase() || q.includes(sessionID.toLowerCase()))) score += 1000;
      if (title) {
        const titleLower = title.toLowerCase();
        if (q === titleLower) score += 900;
        else if (q.includes(titleLower) || titleLower.includes(q)) score += 700;
        else {
          const quoted = query.match(/[“"'`「『](.+?)[”"'`」』]/);
          const quotedText = normalizeText(String(quoted?.[1] || '')).toLowerCase();
          if (quotedText && (quotedText === titleLower || quotedText.includes(titleLower) || titleLower.includes(quotedText))) {
            score += 850;
          }
        }
      }
      if (score <= 0) continue;
      const updated = Date.parse(String(s?.updatedAt || '')) || 0;
      if (!best || score > best.score || (score === best.score && updated > best.updatedAt)) {
        best = { score, updatedAt: updated, session: s };
      }
    }
    return best?.session || null;
  }

  function shouldSuppressCurrentSummaryInjection(sessionID, projectName = getProjectName()) {
    if (!sessionID || !isStrictModeEnabled()) return false;
    const runtimeTs = Number(sessionStrictHitAt.get(sessionID) || 0);
    if (runtimeTs > 0 && (Date.now() - runtimeTs) < AUTO_STRICT_SUPPRESS_CURRENT_SUMMARY_MS) return true;
    if (!hasSessionMemoryFile(sessionID, projectName)) return false;
    const sess = loadSessionMemory(sessionID, projectName);
    const sp = ensureSendPretrim(sess);
    const traces = Array.isArray(sp?.traces) ? sp.traces : [];
    if (!traces.length) return false;
    const last = traces[traces.length - 1] || {};
    if (!last.strictApplied) return false;
    const ts = Date.parse(last.ts || 0) || 0;
    if (!ts) return false;
    return (Date.now() - ts) < AUTO_STRICT_SUPPRESS_CURRENT_SUMMARY_MS;
  }

  async function processUserMessageEventSerial(sessionID, text, rawEvent) {
    const rawNormalized = normalizeText(String(text || ''));
    const sanitized = sanitizeUserTextForMemoryInference(rawNormalized);
    const clean = stripObservedWrapperNoise(rawNormalized) || rawNormalized;
    if (isSkillBoilerplateUserText(rawNormalized) || isSkillBoilerplateUserText(sanitized) || isSkillBoilerplateUserText(clean)) return;
    if (isVisibleNoticeText(rawNormalized) || isVisibleNoticeText(sanitized) || isVisibleNoticeText(clean)) return;
    if (
      (
        /<system-reminder>[\s\S]*?<\/system-reminder>/i.test(rawNormalized)
        || /The user sent the following message:/i.test(rawNormalized)
        || /Please address this message and continue with your tasks\./i.test(rawNormalized)
      )
      && (isVisibleNoticeText(clean) || isVisibleNoticeText(sanitized) || /(?:记忆提示[:：]|\[memory-system\])/i.test(rawNormalized))
    ) {
      return;
    }
    let hasPersistedUserEvent = false;
    if (isLikelySessionID(sessionID) && hasSessionMemoryFile(sessionID)) {
      try {
        const existingSession = loadSessionMemory(sessionID, getProjectName());
        hasPersistedUserEvent = Array.isArray(existingSession?.recentEvents)
          && existingSession.recentEvents.some((ev) => String(ev?.kind || '') === 'user-message');
      } catch {
        hasPersistedUserEvent = false;
      }
    }
    const observedSessionFallback = sanitizeUserTextForMemoryInference(
      String(sessionObservedUserTextByID.get(sessionID) || '')
    );
    const observedGlobalFallback = !clean && !hasPersistedUserEvent
      ? sanitizeUserTextForMemoryInference(String(lastObservedUserText || ''))
      : '';
    const sessionScopedFallback = sanitizeUserTextForMemoryInference(getLatestUserTextForSession(sessionID));
    const observedTransformFallback = normalizeText(String(rawEvent?.type || '')) === 'messages.transform.user-fallback'
      ? sanitizeUserTextForMemoryInference(String(lastObservedUserText || ''))
      : '';
    const inferredClean =
      clean
      || observedSessionFallback
      || observedGlobalFallback
      || sessionScopedFallback
      || observedTransformFallback;
    const persistedUserText = inferredClean;
    if (isSkillBoilerplateUserText(persistedUserText)) return;
    if (!persistedUserText || isVisibleNoticeText(persistedUserText)) return;
    if (!isLikelySessionID(sessionID)) return;
    rememberGlobalEmptyCallState.delete(sessionID);
    memoryEmptyCallState.delete(sessionID);
    if (sessionID) lastActiveSessionID = sessionID;
    if (reconcileExistingLatestUserMessage(sessionID, persistedUserText, rawEvent)) {
      if (sessionID && persistedUserText && !isLowSignalUserText(persistedUserText) && !isMemoryInjectionText(persistedUserText) && !isSummaryNoiseText(persistedUserText)) {
        const observedAt = Date.now();
        sessionLatestUserTextByID.set(sessionID, persistedUserText);
        sessionObservedUserTextByID.set(sessionID, persistedUserText);
        sessionObservedUserAtByID.set(sessionID, observedAt);
        lastObservedUserAt = observedAt;
      }
      return;
    }
    if (shouldSkipDuplicateUserEvent(sessionID, persistedUserText, rawEvent)) return;
    const isFirstUserMessageForSession = !hasSessionMemoryFile(sessionID);

    if (isFirstUserMessageForSession) {
      appendAutoEvent({
        sessionID,
        kind: 'session-start',
        summary: 'Session created',
        rawEvent
      });

      if (getInjectMemoryDocsEnabled()) {
        await injectMemoryText(sessionID, memoryDocs, 'memory-docs');
      }

      if (getInjectGlobalPrefsOnSessionStart()) {
        const globalText = buildGlobalPrefsContextText();
        if (globalText) await injectMemoryText(sessionID, globalText, 'global-prefs');
      }
    }

    const currentReadHint = resolveGlobalReadHintPayload(persistedUserText);
    const currentReadText = buildCurrentGlobalReadAnswerText(currentReadHint || {});
    if (currentReadText) {
      await injectMemoryText(sessionID, currentReadText, 'current-global-read');
    }

    if (sessionID && persistedUserText && !isLowSignalUserText(persistedUserText) && !isMemoryInjectionText(persistedUserText) && !isSummaryNoiseText(persistedUserText)) {
      const observedAt = Date.now();
      sessionLatestUserTextByID.set(sessionID, persistedUserText);
      sessionObservedUserTextByID.set(sessionID, persistedUserText);
      sessionObservedUserAtByID.set(sessionID, observedAt);
      lastObservedUserAt = observedAt;
    }
    if (persistedUserText && !isMemoryInjectionText(persistedUserText) && !isSummaryNoiseText(persistedUserText)) {
      appendAutoEvent({
        sessionID,
        kind: 'user-message',
        summary: persistedUserText,
        rawEvent
      });
    }

    const persistedUserCount = Number(loadSessionMemory(sessionID)?.stats?.userMessages || 0);
    const currentCount = Math.max(sessionUserMessageCounters.get(sessionID) || 0, persistedUserCount);
    if (currentCount > 0) sessionUserMessageCounters.set(sessionID, currentCount);
    else sessionUserMessageCounters.delete(sessionID);

    const refreshEvery = getCurrentSessionRefreshEvery();
    if (
      AUTO_CURRENT_SESSION_SUMMARY_ENABLED &&
      currentCount >= refreshEvery &&
      currentCount % refreshEvery === 0 &&
      !shouldSuppressCurrentSummaryInjection(sessionID)
    ) {
      const currentSummary = buildCurrentSessionSummaryText(sessionID);
      if (currentSummary) {
        await injectMemoryText(sessionID, currentSummary, 'current-session-refresh');
      }
    }

    if (getRecallEnabled() && clean && (shouldTriggerRecall(clean) || shouldTriggerWeakFollowupRecall(clean) || referencesAnotherSessionTitle(clean, sessionID))) {
      await maybeInjectTriggerRecall(sessionID, clean);
    }
  }

  async function processUserMessageEvent(sessionID, text, rawEvent) {
    const sid = normalizeText(String(sessionID || ''));
    if (!sid) return;
    const previousTask = sessionUserEventTasks.get(sid) || Promise.resolve();
    let currentTask = null;
    currentTask = previousTask
      .catch(() => {})
      .then(() => processUserMessageEventSerial(sid, text, rawEvent));
    sessionUserEventTasks.set(sid, currentTask);
    try {
      await currentTask;
    } finally {
      if (sessionUserEventTasks.get(sid) === currentTask) {
        sessionUserEventTasks.delete(sid);
      }
    }
  }

  function scoreSessionForQuery(sessionData, queryTokens) {
    if (!sessionData || !queryTokens.length) return 0;
    const queryJoined = queryTokens.join(' ');
    const recent = (
      Array.isArray(sessionData.recentEvents)
        ? sessionData.recentEvents.map((e) => normalizeText(String(e?.summary || ''))).join(' ')
        : ''
    ).toLowerCase();
    const compressed = normalizeText(sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || ''))).toLowerCase();
    const title = normalizeText(String(sessionData?.sessionTitle || '')).toLowerCase();
    const cwd = normalizeText(String(sessionData?.sessionCwd || '')).toLowerCase();
    const blob = `${title} ${cwd} ${recent} ${compressed}`.toLowerCase();

    // Guard: if query contains strong identity tokens (e.g. DELTA-87321/path),
    // require at least one exact strong-token match to avoid drifting to generic
    // "代号/另一个" sessions.
    const strongIdentityTokens = queryTokens.filter((token) =>
      /(?:[a-z]{2,}[-_]\d{2,}|\/[\w./-]+|[a-z]:\\[\w\\.-]+)/i.test(token)
    );
    const strongIdentitySuffixes = strongIdentityTokens
      .map((token) => {
        const m = String(token || '').match(/[-_](\d{2,})$/i);
        return m ? String(m[1] || '') : '';
      })
      .filter(Boolean);
    const hasStrongExact = strongIdentityTokens.some((token) =>
      title.includes(token) || compressed.includes(token) || recent.includes(token) || cwd.includes(token)
    );
    const hasStrongSuffix = strongIdentitySuffixes.some((suffix) => {
      const re = new RegExp(`(?:[-_])${suffix}(?:\\b|[^0-9])`, 'i');
      return re.test(title) || re.test(compressed) || re.test(recent) || re.test(cwd);
    });
    if (
      strongIdentityTokens.length > 0
      && !hasStrongExact
      && !hasStrongSuffix
    ) {
      return 0;
    }

    let score = 0;
    let matched = 0;
    for (const token of queryTokens) {
      const weight = recallTokenWeight(token);
      if (!weight) continue;
      let hit = false;
      if (title.includes(token)) {
        score += weight * 2.4;
        hit = true;
      }
      if (compressed.includes(token)) {
        score += weight * 1.8;
        hit = true;
      }
      if (recent.includes(token)) {
        score += weight * 1.4;
        hit = true;
      }
      if (cwd.includes(token)) {
        score += weight * 0.8;
        hit = true;
      }
      if (hit) matched += 1;
    }
    if (/路径|path|目录|folder|workdir/i.test(queryJoined) && /\/|[a-z]:\\/i.test(blob)) score += 1;
    if (/审稿|review|reviewer|投稿|response/i.test(queryJoined) && /审稿|review|response/i.test(blob)) score += 2;
    if (/另一个|之前|上次|session|对话/i.test(queryJoined)) score += 1;
    if (/代号|code name|codename/i.test(queryJoined) && /(?:代号|code name|codename)[^\n]{0,24}[a-z]+[-_]?\d+|是\s*[a-z]+[-_]?\d+/i.test(blob)) {
      score += 4;
    }

    const titleQuestionLike = isQuestionLikeRecallText(title);
    if (titleQuestionLike) score *= 0.75;
    if (titleQuestionLike && /不知道/.test(recent) && !compressed) score *= 0.25;
    if (titleQuestionLike && matched <= 2) score *= 0.7;

    // Slight recency bias
    const updated = Date.parse(sessionData?.updatedAt || 0) || 0;
    if (updated > 0) score += 0.1;

    return score;
  }

  function buildRecallContextText(query, sessions, options = {}) {
    const budgetChars = charsFromTokenBudget(options.tokenBudget || getRecallTokenBudget());
    const maxChars = Math.min(Number(options.maxChars || getRecallMaxChars()), budgetChars);
    const maxEventsPerSession = Number(options.maxEventsPerSession || getRecallMaxEventsPerSession());

    const lines = [];
    const state = { chars: 0, maxChars };

    pushLineWithLimit(lines, `<OPENCODE_MEMORY_RECALL query="${truncateText(normalizeText(query), 120)}">`, state);
    pushLineWithLimit(lines, 'Execution policy:', state);
    pushLineWithLimit(lines, '- If recalled memory already contains enough facts to answer the user question, answer directly from recalled memory first.', state);
    pushLineWithLimit(lines, '- STRONG RULE: Do NOT run file search/read/list tools unless user explicitly asks to verify/re-check, or recalled memory is insufficient/ambiguous.', state);
    pushLineWithLimit(lines, '- If answering from memory, clearly state it is based on recalled memory and include the key evidence (facts/paths/decisions).', state);
    pushLineWithLimit(lines, '- Never answer with a session ID unless the user explicitly asked for a session identifier.', state);

    for (const s of sessions) {
      const stats = s?.stats || emptyStats();
      pushLineWithLimit(
        lines,
        `Recalled session facts (updated=${s.updatedAt || 'unknown'}, u=${stats.userMessages || 0}, a=${stats.assistantMessages || 0}, t=${stats.toolResults || 0}):`,
        state
      );
      const title = truncateText(normalizeText(String(s?.sessionTitle || '')), 120);
      if (title) pushLineWithLimit(lines, `- title: ${title}`, state);
      const cwd = truncateText(normalizeText(String(s?.sessionCwd || '')), 160);
      if (cwd) pushLineWithLimit(lines, `- session_cwd: ${cwd}`, state);

      const summary = truncateText(normalizeText(String(s?.summary?.compressedText || '')), 360);
      if (summary) pushLineWithLimit(lines, `- compressed: ${summary}`, state);

      const pathCandidates = new Set();
      for (const p of extractAbsolutePaths(String(s?.summary?.compressedText || ''))) pathCandidates.add(p);
      for (const ev of (Array.isArray(s?.recentEvents) ? s.recentEvents.slice(-10) : [])) {
        for (const p of extractAbsolutePaths(String(ev?.summary || ''))) pathCandidates.add(p);
      }
      const topPaths = [...pathCandidates].slice(0, 5);
      if (topPaths.length) {
        pushLineWithLimit(lines, '- candidate_paths:', state);
        for (const p of topPaths) pushLineWithLimit(lines, `  - ${truncateText(p, 200)}`, state);
      }

      const directHints = [];
      const comp = normalizeText(String(s?.summary?.compressedText || ''));
      if (comp) {
        for (const row of comp.split('\n')) {
          const t = normalizeText(row.replace(/^- /, '').replace(/^  - /, ''));
          if (!t) continue;
          if (/status:|task goal:|key outcomes:|blockers:|next actions:|handoff anchor:/i.test(t)) continue;
          if (/PASS|FAIL|WROTE|Fixed|Edit applied|blocked|done|in-progress|路径|path|目录|workdir|response_package|manuscript|units/i.test(t)) {
            directHints.push(t);
          }
          if (directHints.length >= 5) break;
        }
      }
      if (directHints.length) {
        pushLineWithLimit(lines, '- direct_answer_hints:', state);
        for (const h of directHints) pushLineWithLimit(lines, `  - ${truncateText(h, 220)}`, state);
      }

      const events = Array.isArray(s?.recentEvents)
        ? s.recentEvents.slice(-maxEventsPerSession)
        : [];

      for (const ev of events) {
        const toolTag = ev?.tool ? ` [${ev.tool}]` : '';
        const msg = truncateText(normalizeText(String(ev?.summary || '')), 220);
        if (msg) pushLineWithLimit(lines, `- ${ev?.kind || 'event'}${toolTag}: ${msg}`, state);
      }
    }

    pushLineWithLimit(lines, '</OPENCODE_MEMORY_RECALL>', state);

    if (lines.length <= 2) return '';
    return lines.join('\n');
  }

  function recallProjectMemories(query, options = {}) {
    const projectName = options.projectName || getProjectName();
    const currentSessionID = options.currentSessionID || null;
    const includeCurrent = Boolean(options.includeCurrent || false);
    const maxSessions = Number(options.maxSessions || getRecallTopSessions());

    const queryText = normalizeText(String(query || ''));
    const effectiveQuery = buildEffectiveRecallQuery(queryText, currentSessionID || '', projectName);
    const tokens = tokenize(effectiveQuery);
    const directMatch = findDirectRecallSessionMatch(queryText, projectName, currentSessionID || '');
    if (!tokens.length && !directMatch) {
      return { text: '', hits: [] };
    }

    const allSessions = listSessionMemories(projectName);
    const scored = [];

    if (directMatch?.sessionID) {
      scored.push({ score: 1e9, session: directMatch });
    }

    for (const s of allSessions) {
      if (!includeCurrent && currentSessionID && s.sessionID === currentSessionID) continue;
      if (directMatch?.sessionID && s.sessionID === directMatch.sessionID) continue;
      const score = scoreSessionForQuery(s, tokens);
      if (score > 0) scored.push({ score, session: s });
    }

    scored.sort((a, b) => b.score - a.score);
    let hits = scored.slice(0, maxSessions).map((x) => x.session);
    if (!hits.length && /路径|path|目录|folder|workdir|审稿|review|投稿|怎么做|结论|决定|方案|结果/i.test(queryText)) {
      const byRecent = allSessions
        .filter((s) => includeCurrent || !currentSessionID || s.sessionID !== currentSessionID)
        .sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0))
        .slice(0, Math.max(1, Math.min(2, maxSessions)));
      hits = byRecent;
    }

    const text = buildRecallContextText(queryText, hits, {
      maxChars: options.maxChars,
      maxEventsPerSession: options.maxEventsPerSession,
      tokenBudget: options.tokenBudget
    });

    return { text, hits, estimatedTokens: estimateTokensFromText(text), effectiveQuery };
  }

  function normalizeWeakRecallCode(code = '') {
    return normalizeText(String(code || '')).toUpperCase();
  }

  function scoreWeakRecallCode(code = '') {
    const c = normalizeWeakRecallCode(code);
    if (!c || !/\d/.test(c)) return -1;
    const digits = (c.match(/\d/g) || []).length;
    let score = c.length + digits * 8;
    if (/[A-Z]{3,}/.test(c)) score += 10;
    if (/[-_]\d{2,}$/.test(c)) score += 90;
    if (/[-_][A-Z0-9]{2,}/.test(c)) score += 25;
    if (/^(?:SRC|TEST|CASE|SESSION|SID)[-_]/i.test(c)) score -= 120;
    return score;
  }

  function pickBestWeakRecallCode(candidates = [], queryCodes = []) {
    const blocked = new Set(
      (Array.isArray(queryCodes) ? queryCodes : [])
        .map((x) => normalizeWeakRecallCode(x))
        .filter(Boolean)
    );
    const uniq = [...new Set(
      (Array.isArray(candidates) ? candidates : [])
        .map((x) => normalizeWeakRecallCode(x))
        .filter((x) => x && /\d/.test(x) && !blocked.has(x))
    )];
    if (!uniq.length) return '';
    uniq.sort((a, b) => {
      const byScore = scoreWeakRecallCode(b) - scoreWeakRecallCode(a);
      if (byScore !== 0) return byScore;
      return b.length - a.length;
    });
    return uniq[0] || '';
  }

  function inferWeakFollowupCounterpartCode(query = '', recallText = '') {
    const cleanQuery = String(query || '');
    const cleanRecall = String(recallText || '');
    if (!cleanQuery || !cleanRecall) return '';
    if (!isWeakFollowupRecallQuery(cleanQuery)) return '';

    const queryCodes = [...new Set(
      (cleanQuery.toUpperCase().match(/\b[A-Z]{2,}(?:[-_][A-Z0-9]{1,})+\b|\b[A-Z]{2,}(?:[-_]\d+)?\b/g) || [])
        .map((x) => normalizeWeakRecallCode(x))
        .filter((x) => /\d/.test(x))
    )];
    if (!queryCodes.length) return '';

    const contextualCodes = [...new Set(
      [...cleanRecall.toUpperCase().matchAll(/(?:代号|CODE\s*NAME|CODENAME)[^A-Z0-9]{0,12}(?:是|:)?\s*([A-Z]{2,}(?:[-_][A-Z0-9]{1,})+)/g)]
        .map((m) => normalizeWeakRecallCode(m?.[1]))
        .filter((x) => /\d/.test(x))
    )];
    const contextualCounterpart = pickBestWeakRecallCode(contextualCodes, queryCodes);
    if (contextualCounterpart) return contextualCounterpart;

    const recallCodes = [...new Set(
      (cleanRecall.toUpperCase().match(/\b[A-Z]{2,}(?:[-_][A-Z0-9]{1,})+\b|\b[A-Z]{2,}(?:[-_]\d+)?\b/g) || [])
        .map((x) => normalizeWeakRecallCode(x))
        .filter((x) => /\d/.test(x))
        .filter((x) => !/^(?:SRC|TEST|CASE|SESSION|SID)[-_]/i.test(x))
    )];
    return pickBestWeakRecallCode(recallCodes, queryCodes);
  }

  function augmentWeakFollowupRecallText(query = '', recallText = '') {
    const base = String(recallText || '');
    if (!base) return base;
    if (/<OPENCODE_MEMORY_RECALL_DIRECT_ANSWER/i.test(base)) return base;

    const counterpart = inferWeakFollowupCounterpartCode(query, base);
    if (!counterpart) return base;

    const queryCodes = [...new Set(
      (String(query || '').match(/\b[A-Z]{2,}(?:[-_]\d+)?\b/g) || [])
        .map((x) => String(x || '').trim())
        .filter((x) => /\d/.test(x))
    )];

    const hint = [
      `<OPENCODE_MEMORY_RECALL_DIRECT_ANSWER candidate="${counterpart}">`,
      `Weak follow-up query detected. User already provided: ${queryCodes.join(', ')}.`,
      `If recalled facts are consistent, return EXACTLY this token: ${counterpart}.`,
      'Do not shorten, paraphrase, or truncate this token.',
      'Do not answer "不知道" when this candidate is present unless recalled facts conflict.',
      '</OPENCODE_MEMORY_RECALL_DIRECT_ANSWER>'
    ].join('\n');
    return `${base}\n${hint}`;
  }

  function resolveWeakFollowupDirectAnswerPayload(rawText = '', currentSessionID = '') {
    const query = sanitizeUserTextForMemoryInference(rawText);
    if (!query || !shouldTriggerWeakFollowupRecall(query)) return null;
    const recall = recallProjectMemories(query, {
      currentSessionID: currentSessionID || '',
      includeCurrent: false,
      maxSessions: getRecallTopSessions(),
      maxEventsPerSession: getRecallMaxEventsPerSession(),
      maxChars: getRecallMaxChars(),
      tokenBudget: getRecallTokenBudget()
    });
    const counterpart = inferWeakFollowupCounterpartCode(query, String(recall?.text || ''));
    if (!counterpart) return null;
    const sourceSessionID = Array.isArray(recall?.hits) && recall.hits.length
      ? normalizeText(String(recall.hits[0]?.sessionID || ''))
      : '';
    return { query, counterpart, sourceSessionID };
  }

  function canEmitVisibleNotice(sessionID, key = 'notice') {
    if (!getVisibleNoticesEnabled() || !sessionID) return false;
    const now = Date.now();
    const cleanKey = normalizeText(String(key || 'notice')) || 'notice';
    const cooldownMs = getVisibleNoticeCooldownMs();
    const state = sessionNoticeState.get(sessionID) instanceof Map
      ? sessionNoticeState.get(sessionID)
      : new Map();
    const prevAt = Number(state.get(cleanKey) || 0);
    if (prevAt > 0 && (now - prevAt) < cooldownMs) return false;
    state.set(cleanKey, now);
    sessionNoticeState.set(sessionID, state);
    return true;
  }

  function makeSyntheticTextPart(text = '') {
    return { type: 'text', text, synthetic: true, ignored: true };
  }

  function makeInjectableTextPart(text = '') {
    return { type: 'text', text, synthetic: true };
  }

  function makeVisibleNoticeTextPart(text = '') {
    return {
      type: 'text',
      text,
      synthetic: true,
      annotations: {
        audience: ['assistant']
      }
    };
  }

  function makeVisibleNoticeMirrorTextPart(text = '') {
    return {
      type: 'text',
      text
    };
  }

  function shouldMirrorVisibleNoticeInSession(key = '') {
    return getVisibleNoticeCurrentSummaryMirrorEnabled()
      && isWebServerProcess()
      && normalizeText(String(key || '')) === 'inject:current-session-refresh';
  }

  function queuePendingVisibleNoticeMirror(sessionID = '', text = '', key = '', baseChannel = 'toast') {
    const sid = normalizeText(String(sessionID || ''));
    const cleanText = truncateText(normalizeText(String(text || '')), 220);
    const cleanKey = normalizeText(String(key || ''));
    if (!sid || !cleanText || !cleanKey) return false;
    sessionPendingVisibleNoticeMirrors.set(sid, {
      text: cleanText,
      key: cleanKey,
      baseChannel: normalizeText(String(baseChannel || 'toast')) || 'toast',
      queuedAt: Date.now()
    });
    return true;
  }

  function clearScheduledVisibleNoticeCleanup(sessionID = '', messageID = '') {
    const sid = normalizeText(String(sessionID || ''));
    const mid = normalizeText(String(messageID || ''));
    if (!sid || !mid) return;
    const timerKey = `${sid}:${mid}`;
    const timer = sessionNoticeCleanupTimers.get(timerKey);
    if (!timer) return;
    clearTimeout(timer);
    sessionNoticeCleanupTimers.delete(timerKey);
  }

  function scheduleVisibleNoticeCleanup(sessionID = '', messageID = '') {
    const sid = normalizeText(String(sessionID || ''));
    const mid = normalizeText(String(messageID || ''));
    if (!sid || !mid) return false;
    clearScheduledVisibleNoticeCleanup(sid, mid);
    const delay = getVisibleNoticeMirrorDeleteMs();
    const timerKey = `${sid}:${mid}`;
    const timer = setTimeout(async () => {
      sessionNoticeCleanupTimers.delete(timerKey);
      let deleted = false;
      try {
        await client.session.deleteMessage({
          sessionID: sid,
          messageID: mid
        });
        deleted = true;
      } catch (_) {
        try {
          await client.session.deleteMessage({
            path: {
              sessionID: sid,
              messageID: mid
            }
          });
          deleted = true;
        } catch (_) {
          // fall through to raw HTTP fallback
        }
      }
      if (deleted) return;
      try {
        await fetch(`http://127.0.0.1:${AUTO_OPENCODE_WEB_PORT}/session/${encodeURIComponent(sid)}/message/${encodeURIComponent(mid)}`, {
          method: 'DELETE'
        });
      } catch (_) {
        // ignore best-effort notice cleanup failures
      }
    }, delay);
    if (typeof timer?.unref === 'function') timer.unref();
    sessionNoticeCleanupTimers.set(timerKey, timer);
    return true;
  }

  async function findVisibleNoticeMessageID(sessionID = '', text = '') {
    const sid = normalizeText(String(sessionID || ''));
    const cleanText = normalizeText(String(text || ''));
    if (!sid || !cleanText) return '';
    try {
      const res = await fetch(
        `http://127.0.0.1:${AUTO_OPENCODE_WEB_PORT}/session/${encodeURIComponent(sid)}/message?limit=12`
      );
      if (!res.ok) return '';
      const messages = await res.json();
      if (!Array.isArray(messages)) return '';
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        const role = normalizeText(String(msg?.info?.role || ''));
        const messageID = normalizeText(String(msg?.info?.id || ''));
        const joinedText = normalizeText(
          (Array.isArray(msg?.parts) ? msg.parts : [])
            .map((part) => normalizeText(String(part?.text || '')))
            .filter(Boolean)
            .join('\n')
        );
        if (role === 'user' && messageID && joinedText === cleanText) return messageID;
      }
    } catch (_) {
      return '';
    }
    return '';
  }

  async function emitEphemeralVisibleSessionNotice(sessionID = '', text = '') {
    if (!client?.session || typeof client.session.prompt !== 'function') return false;
    const sid = normalizeText(String(sessionID || ''));
    const cleanText = truncateText(normalizeText(String(text || '')), 220);
    if (!sid || !cleanText) return false;
    try {
      const response = await client.session.prompt({
        path: { id: sid },
        body: {
          noReply: true,
          parts: [makeVisibleNoticeMirrorTextPart(cleanText)]
        }
      });
      const messageID = normalizeText(String(response?.info?.id || ''))
        || await findVisibleNoticeMessageID(sid, cleanText);
      if (messageID) scheduleVisibleNoticeCleanup(sid, messageID);
      return true;
    } catch {
      return false;
    }
  }

  async function flushPendingVisibleNoticeMirror(sessionID = '') {
    const sid = normalizeText(String(sessionID || ''));
    if (!sid) return false;
    const pending = sessionPendingVisibleNoticeMirrors.get(sid);
    if (!pending?.text) return false;
    sessionPendingVisibleNoticeMirrors.delete(sid);
    const mirrored = await emitEphemeralVisibleSessionNotice(sid, pending.text);
    if (mirrored) {
      const prefix = normalizeText(String(pending.baseChannel || 'toast')) || 'toast';
      recordVisibleNoticeDelivery(sid, pending.key || 'notice', `${prefix}+prompt-ephemeral-deferred`, pending.text);
      return true;
    }
    return false;
  }

  async function emitToastNotice(message = '') {
    const detail = truncateText(normalizeText(String(message || '')), 220);
    if (!detail.trim()) return false;
    if (!client?.tui || typeof client.tui.showToast !== 'function') return false;
    const body = {
      title: '记忆提示',
      message: detail,
      variant: 'info',
      duration: 4200
    };
    try {
      await client.tui.showToast({ body });
      return true;
    } catch {
      try {
        await client.tui.showToast(body);
        return true;
      } catch {
        return false;
      }
    }
  }

  function recordVisibleNoticeDelivery(sessionID, key = '', channel = '', text = '') {
    if (!isLikelySessionID(sessionID) || !hasSessionMemoryFile(sessionID)) return;
    try {
      const mem = loadSessionMemory(sessionID);
      mem.inject = mem.inject || {};
      mem.inject.lastNoticeAt = new Date().toISOString();
      mem.inject.lastNoticeKey = String(key || '');
      mem.inject.lastNoticeChannel = String(channel || '');
      mem.inject.lastNoticeText = truncateText(normalizeText(String(text || '')), 220);
      persistSessionMemory(mem);
      writeDashboardFiles();
    } catch {
      // ignore notice audit failures
    }
  }

  function isVisibleNoticeText(text = '') {
    const clean = normalizeText(String(text || ''));
    return /^(?:\[memory-system\](?:\[detailed\])?\s+|记忆提示[:：]\s*)/i.test(clean);
  }

  function sanitizeHintPartText(text = '') {
    return normalizeText(String(text || '')).slice(0, 3000);
  }

  function clearInjectedHintParts(messages = []) {
    if (!Array.isArray(messages)) return;
    const marks = ['<prunable-tools>', '<message-id>', '<message-id-map>', '<dcp-message-id>', '<memory-global-write', '<memory-global-read', '<OPENCODE_MEMORY_DIRECT_ANSWER'];
    for (const msg of messages) {
      if (!Array.isArray(msg?.parts)) continue;
      msg.parts = msg.parts.filter((p) => {
        if (!p || p.type !== 'text' || !p.synthetic) return true;
        const t = String(p.text || '');
        return !marks.some((m) => t.includes(m));
      });
    }
  }

  function findLastMessageForHint(messages = []) {
    if (!Array.isArray(messages) || !messages.length) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      if (role === 'assistant' || role === 'user') return msg;
    }
    return messages[messages.length - 1] || null;
  }

  function injectGlobalWriteResultHint(messages = [], payload = {}) {
    if (!payload?.key) return { injected: false };
    const target = findLastMessageForHint(messages);
    if (!target) return { injected: false };
    target.parts = Array.isArray(target.parts) ? target.parts : [];
    const key = sanitizeHintPartText(String(payload.key || ''));
    const value = sanitizeHintPartText(String(payload.value || ''));
    const hint = `<memory-global-write status="persisted" key="${key}" value="${value}">Global memory already persisted for this request. Do not retry additional write tools unless overwriting is required.</memory-global-write>`;
    target.parts.push(makeSyntheticTextPart(hint));
    return { injected: true, tokens: estimateTokensFromText(hint) };
  }

  function injectGlobalReadResultHint(messages = [], payload = {}) {
    if (!payload?.key) return { injected: false };
    const target = findLastMessageForHint(messages);
    if (!target) return { injected: false };
    target.parts = Array.isArray(target.parts) ? target.parts : [];
    const key = sanitizeHintPartText(String(payload.key || ''));
    const value = sanitizeHintPartText(String(payload.value || ''));
    const hint = `<memory-global-read key="${key}" value="${value}">Global memory resolution for the current request: ${key} = ${value}. Reply using this exact value or confirm with a single memory {"command":"global","args":["${key}"]} call. Do not call context or any second tool after this value is available. Do not answer "不知道" when this tag is present.</memory-global-read>`;
    target.parts.push(makeInjectableTextPart(hint));
    return { injected: true, tokens: estimateTokensFromText(hint) };
  }

  function injectWeakFollowupDirectAnswerHint(messages = [], payload = {}) {
    const candidate = sanitizeHintPartText(String(payload?.counterpart || payload?.value || ''));
    if (!candidate) return { injected: false };
    const target = findLastMessageForHint(messages);
    if (!target) return { injected: false };
    target.parts = Array.isArray(target.parts) ? target.parts : [];
    const source = sanitizeHintPartText(String(payload?.sourceSessionID || ''));
    const sourceAttr = source ? ` source="${source}"` : '';
    const hint = `<OPENCODE_MEMORY_DIRECT_ANSWER value="${candidate}"${sourceAttr}>Weak follow-up recall resolved counterpart candidate: ${candidate}. Return EXACTLY this token when recalled facts are consistent. Do not shorten or paraphrase it. Do not answer "不知道" when this tag is present unless recalled facts conflict.</OPENCODE_MEMORY_DIRECT_ANSWER>`;
    target.parts.push(makeInjectableTextPart(hint));
    return { injected: true, tokens: estimateTokensFromText(hint) };
  }

  function injectMessageIdTags(messages = [], options = {}) {
    if (!getDcpMessageIdTagsEnabled()) return { injected: 0, skipped: 'disabled' };
    if (!options.force && !shouldInjectProtocolHints(messages, Number(options.beforeTokens || 0))) {
      return { injected: 0, skipped: 'not_needed' };
    }
    let injected = 0;
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg || !Array.isArray(msg.parts)) continue;
      const rid = normalizeText(String(msg?.info?.id || ''));
      const mid = `m${String(i + 1).padStart(4, '0')}`;
      const marker = `<message-id>${mid}</message-id>`;
      const dcpMarker = `<dcp-message-id>${mid}</dcp-message-id>`;
      const mapTag = rid ? ` raw="${rid}"` : '';
      msg.parts.push(makeSyntheticTextPart(`<message-id-map id="${mid}"${mapTag} />`));
      msg.parts.push(makeSyntheticTextPart(marker));
      msg.parts.push(makeSyntheticTextPart(dcpMarker));
      injected += 1;
    }
    return { injected };
  }

  function resolveActiveSessionID(sessionID = '', projectName = getProjectName()) {
    const loc = resolveSessionLocation(sessionID, projectName);
    if (!loc.sessionID) return { sessionID: '', projectName };
    return loc;
  }

  function executePruneForSession(sessionID = '', projectName = getProjectName(), source = 'tool-prune') {
    const loc = resolveActiveSessionID(sessionID, projectName);
    const sid = loc.sessionID;
    const resolvedProjectName = loc.projectName;
    if (!sid) return { ok: false, message: 'No active session id found.' };
    const sess = loadSessionMemory(sid, resolvedProjectName);
    const d = discardLowValueToolEvents(sess);
    const e = extractSessionContext(sess);
    const c = compactConversationByBudget(sess) || { extracted: 0 };
    const est = estimateBodyTokens(sess);
    recordPruneAudit(sess, {
      source,
      discardRemoved: Number(d.removed || 0),
      extractMoved: Number(e.extracted || 0) + Number(c.extracted || 0),
      estimatedTokens: est
    });
    persistSessionMemory(sess, resolvedProjectName);
    writeDashboardFiles();
    return {
      ok: true,
      sessionID: sid,
      projectName: resolvedProjectName,
      discardRemoved: Number(d.removed || 0),
      extractMoved: Number(e.extracted || 0),
      compactExtracted: Number(c.extracted || 0),
      estimatedTokens: Number(est || 0)
    };
  }

  function executeDistillForSession({
    sessionID = '',
    targets = [],
    projectName = getProjectName()
  } = {}) {
    const loc = resolveActiveSessionID(sessionID, projectName);
    const sid = loc.sessionID;
    const resolvedProjectName = loc.projectName;
    if (!sid) return { ok: false, message: 'No active session id found.' };
    if (!Array.isArray(targets) || !targets.length) {
      return { ok: false, message: 'Missing targets. Provide at least one {id, distillation}.' };
    }

    const cleaned = [];
    for (const t of targets) {
      const id = normalizeText(String(t?.id || ''));
      const distillation = normalizeText(String(t?.distillation || ''));
      if (!id || !distillation) {
        return { ok: false, message: 'Each target must include non-empty id and distillation.' };
      }
      cleaned.push({ id, distillation: truncateText(distillation, getDistillSummaryMaxChars()) });
    }

    const sess = loadSessionMemory(sid, resolvedProjectName);
    const blockSummary = cleaned
      .map((x) => `- [${x.id}] ${x.distillation}`)
      .join('\n');
    const appended = appendSummaryBlock(sess, {
      source: 'tool-distill-manual',
      startMessageID: cleaned[0]?.id || '',
      endMessageID: cleaned[cleaned.length - 1]?.id || '',
      anchorMessageID: cleaned[0]?.id || '',
      consumedMessages: cleaned.length,
      summary: truncateText(`[distill]\n${blockSummary}`, getSummaryMaxChars())
    });
    if (appended) ensureSummaryBlockPresent(sess, appended);
    appendCompressedSummaryChunk(sess, [{
      ts: new Date().toISOString(),
      kind: 'assistant-message',
      summary: truncateText(`[manual distill] ${cleaned.map((x) => x.id).join(', ')}`, 320)
    }]);
    const c = compactConversationByBudget(sess) || { extracted: 0 };
    const est = estimateBodyTokens(sess);
    const debugBlocksBeforePersist = Array.isArray(sess.summaryBlocks) ? sess.summaryBlocks.length : 0;
    recordPruneAudit(sess, {
      source: 'tool-distill-manual',
      discardRemoved: 0,
      extractMoved: Number(c.extracted || 0),
      estimatedTokens: est
    });
    persistSessionMemory(sess, resolvedProjectName);
    const debugPath = getSessionMemoryPath(sid, resolvedProjectName);
    const debugAfter = readJson(debugPath) || {};
    const debugBlocksAfterPersist = Array.isArray(debugAfter.summaryBlocks) ? debugAfter.summaryBlocks.length : 0;
    writeDashboardFiles();
    return {
      ok: true,
      sessionID: sid,
      projectName: resolvedProjectName,
      targets: cleaned.length,
      blockAdded: Boolean(appended),
      blockId: Number(appended?.blockId || 0),
      debugBlocksBeforePersist,
      debugBlocksAfterPersist,
      compactExtracted: Number(c.extracted || 0),
      estimatedTokens: Number(est || 0)
    };
  }

  function executeCompressForSession({
    sessionID = '',
    topic = '',
    content = {},
    projectName = getProjectName()
  } = {}) {
    const loc = resolveActiveSessionID(sessionID, projectName);
    const sid = loc.sessionID;
    const resolvedProjectName = loc.projectName;
    if (!sid) return { ok: false, message: 'No active session id found.' };
    const summary = normalizeText(String(content?.summary || ''));
    if (!summary) {
      return { ok: false, message: 'content.summary is required and must be non-empty.' };
    }
    const startId = normalizeText(String(content?.startId || ''));
    const endId = normalizeText(String(content?.endId || ''));
    const sess = loadSessionMemory(sid, resolvedProjectName);
    const appended = appendSummaryBlock(sess, {
      source: 'tool-compress-manual',
      startMessageID: startId,
      endMessageID: endId,
      anchorMessageID: startId || endId || '',
      consumedMessages: Math.max(1, Number(getDistillRangeMinMessages() || 1)),
      summary: truncateText(`[compress:${truncateText(topic || 'phase-summary', 64)}]\n${summary}`, getSummaryMaxChars())
    });
    if (appended) ensureSummaryBlockPresent(sess, appended);
    appendCompressedSummaryChunk(sess, [{
      ts: new Date().toISOString(),
      kind: 'assistant-message',
      summary: truncateText(`[manual compress] ${summary}`, 600)
    }]);
    // Persist newly appended block first; prune path reloads session from disk.
    persistSessionMemory(sess, resolvedProjectName);
    const p = executePruneForSession(sid, resolvedProjectName, 'tool-compress-manual');
    if (!p.ok) return p;
    const debugPath = getSessionMemoryPath(sid, resolvedProjectName);
    const debugAfter = readJson(debugPath) || {};
    const debugBlocksAfterPersist = Array.isArray(debugAfter.summaryBlocks) ? debugAfter.summaryBlocks.length : 0;
    return {
      ok: true,
      sessionID: sid,
      projectName: resolvedProjectName,
      topic: truncateText(topic || 'phase-summary', 64),
      blockAdded: Boolean(appended),
      blockId: Number(appended?.blockId || 0),
      debugBlocksAfterPersist,
      estimatedTokens: Number(p.estimatedTokens || 0),
      discardRemoved: Number(p.discardRemoved || 0),
      extractMoved: Number(p.extractMoved || 0),
      compactExtracted: Number(p.compactExtracted || 0)
    };
  }

  function buildPrunableToolsXml(messages = [], maxItems = 18) {
    const items = [];
    const seen = new Set();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];
      for (const part of parts) {
        if (!part || part.type !== 'tool') continue;
        const callID = normalizeText(String(part?.callID || ''));
        const tool = normalizeText(String(part?.tool || 'unknown'));
        const status = normalizeText(String(part?.state?.status || ''));
        if (!callID || seen.has(callID)) continue;
        seen.add(callID);
        if (!['completed', 'error'].includes(status)) continue;
        const outputText = normalizeText(String(part?.state?.output || part?.state?.error || ''));
        const tokenEst = Math.max(1, estimateTokensFromText(outputText || safeJsonPreview(part?.state?.output, 280)));
        items.push({ callID, tool, status, tokenEst });
        if (items.length >= maxItems) break;
      }
      if (items.length >= maxItems) break;
    }
    if (!items.length) return '';
    const lines = items
      .map((x, idx) => `${idx + 1}: ${x.tool}#${x.callID} (${x.status}, ~${x.tokenEst} tokens)`)
      .join('\n');
    return `<prunable-tools>\n${lines}\n</prunable-tools>`;
  }

  function injectPrunableToolsHint(messages = [], options = {}) {
    if (!getDcpPrunableToolsEnabled()) return { injected: false, skipped: 'disabled', tokens: 0 };
    if (!options.force && !shouldInjectProtocolHints(messages, Number(options.beforeTokens || 0))) {
      return { injected: false, skipped: 'not_needed', tokens: 0 };
    }
    const xml = buildPrunableToolsXml(messages);
    if (!xml) return { injected: false, skipped: 'empty', tokens: 0 };
    const target = findLastMessageForHint(messages);
    if (!target) return { injected: false, skipped: 'no_target', tokens: 0 };
    target.parts = Array.isArray(target.parts) ? target.parts : [];
    target.parts.push(makeSyntheticTextPart(sanitizeHintPartText(xml)));
    return { injected: true, skipped: '', tokens: estimateTokensFromText(xml) };
  }

  function buildDcpSystemProtocolText() {
    return [
      '<memory_context_protocol>',
      '- Prefer mechanical trimming first; use LLM summary only if still over budget.',
      '- Preserve system/tool definitions and the most recent protected turns.',
      '- Treat synthetic summary anchors as replacements for older assistant/tool history.',
      '- Avoid redundant memory write tool retries if global memory is already persisted in this request.',
      '</memory_context_protocol>'
    ].join('\n');
  }

  function injectDcpSystemProtocol(output = {}) {
    if (!getDcpSystemPromptEnabled()) return { injected: false, tokens: 0 };
    const protocol = buildDcpSystemProtocolText();
    if (!protocol) return { injected: false, tokens: 0 };
    if (Array.isArray(output.system)) {
      if (!output.system.some((x) => String(x || '').includes('<memory_context_protocol>'))) {
        output.system.push(protocol);
      }
    } else if (typeof output.system === 'string') {
      if (!String(output.system || '').includes('<memory_context_protocol>')) {
        output.system = `${output.system}\n${protocol}`.trim();
      }
    } else {
      output.system = [protocol];
    }
    return { injected: true, tokens: estimateTokensFromText(protocol) };
  }

  async function emitVisibleNotice(sessionID, message, key = 'notice') {
    try {
      if (!canEmitVisibleNotice(sessionID, key)) return false;
      const mode = getNotificationMode();
      if (mode === 'off') return false;
      const detail = truncateText(normalizeText(String(message || '')), mode === 'detailed' ? 520 : 220);
      const text = mode === 'minimal'
        ? `记忆提示：${detail}`
        : `记忆提示：${detail}`;
      if (!text.trim()) return false;

      const shouldMirror = shouldMirrorVisibleNoticeInSession(key);
      const toastDelivered = await emitToastNotice(detail);
      if (toastDelivered) {
        let channel = 'toast';
        if (shouldMirror) {
          const mirrored = await emitEphemeralVisibleSessionNotice(sessionID, text);
          if (mirrored) {
            channel = 'toast+prompt-ephemeral';
          } else {
            const queued = queuePendingVisibleNoticeMirror(sessionID, text, key, 'toast');
            if (queued) channel = 'toast+prompt-deferred';
          }
        }
        recordVisibleNoticeDelivery(sessionID, key, channel, text);
        return true;
      }

      let delivered = false;

      // Visible in-chat notice must use prompt(noReply) as the primary path.
      // OpenCode session.update is a session-property patch route, not a
      // guaranteed message append route for Web DOM rendering.
      if (client?.session && typeof client.session.prompt === 'function') {
        try {
          if (shouldMirror) {
            const mirrored = await emitEphemeralVisibleSessionNotice(sessionID, text);
            if (mirrored) {
              recordVisibleNoticeDelivery(sessionID, key, 'prompt-ephemeral', text);
              delivered = true;
            } else {
              const queued = queuePendingVisibleNoticeMirror(sessionID, text, key, 'prompt');
              if (queued) {
                recordVisibleNoticeDelivery(sessionID, key, 'prompt-deferred', text);
                delivered = true;
              }
            }
          } else {
            const response = await client.session.prompt({
              path: { id: sessionID },
              body: {
                noReply: true,
                parts: [makeVisibleNoticeMirrorTextPart(text)]
              }
            });
            const messageID = normalizeText(String(response?.info?.id || ''));
            if (messageID) scheduleVisibleNoticeCleanup(sessionID, messageID);
            recordVisibleNoticeDelivery(sessionID, key, messageID ? 'prompt-ephemeral' : 'prompt', text);
            delivered = true;
          }
        } catch {
          // fall through to legacy compatibility path
        }
      }

      if (!delivered && client?.session && typeof client.session.update === 'function') {
        try {
          await client.session.update(sessionID, {
            noReply: false,
            parts: [makeVisibleNoticeTextPart(text)]
          });
          recordVisibleNoticeDelivery(sessionID, key, 'update', text);
          delivered = true;
        } catch {
          try {
            await client.session.update({
              path: { id: sessionID },
              body: {
                noReply: false,
                parts: [makeVisibleNoticeTextPart(text)]
              }
            });
            recordVisibleNoticeDelivery(sessionID, key, 'update', text);
            delivered = true;
          } catch {
            // ignore legacy fallback failure
          }
        }
      }
      return delivered;
    } catch {
      // ignore visible notice failures
    }
    return false;
  }

  async function injectMemoryText(sessionID, text, reason = 'memory-inject') {
    try {
      if (!sessionID || !text || !isLikelySessionID(sessionID)) return false;
      const mem = loadSessionMemory(sessionID);
      mem.inject = mem.inject || {};
      const digest = stableTextHash(text);
      const now = Date.now();
      const dedupeWindow = reason === 'trigger-recall'
        ? AUTO_INJECT_DEDUPE_WINDOW_RECALL_MS
        : AUTO_INJECT_DEDUPE_WINDOW_MS;
      const lastAtTs = Date.parse(mem.inject.lastAt || 0) || 0;
      const sameDigest = String(mem.inject.lastDigest || '') === digest;
      const sameReason = String(mem.inject.lastReason || '') === String(reason || '');
      if (sameDigest && sameReason && lastAtTs > 0 && (now - lastAtTs) < dedupeWindow) {
        mem.inject.lastSkippedAt = new Date().toISOString();
        mem.inject.lastSkipReason = `dedupe_window_${dedupeWindow}ms`;
        mem.inject.lastStatus = 'skipped';
        persistSessionMemory(mem);
        writeDashboardFiles();
        return false;
      }

      const stackRisk = mem?.alerts?.contextStackRisk;
      const stackRiskAt = Date.parse(stackRisk?.at || 0) || 0;
      const riskActive = Boolean(
        stackRisk &&
        stackRisk.level === 'warn' &&
        stackRiskAt > 0 &&
        (now - stackRiskAt) < AUTO_INJECT_RISK_GUARD_WINDOW_MS
      );
      if (riskActive && reason === 'current-session-refresh') {
        mem.inject.lastSkippedAt = new Date().toISOString();
        mem.inject.lastSkipReason = 'context_stack_risk_guard';
        mem.inject.lastStatus = 'skipped';
        persistSessionMemory(mem);
        writeDashboardFiles();
        return false;
      }

        const reasonLabel = (() => {
        const m = {
          'global-prefs': '已注入全局偏好记忆',
          'current-global-read': '已注入当前请求读取答案',
          'current-session-refresh': '已注入当前会话摘要记忆',
          'trigger-recall': '已注入跨会话召回记忆',
          'memory-docs': '已注入记忆系统文档',
          'memory-inject': '已注入记忆'
        };
        return m[String(reason || 'memory-inject')] || '已注入记忆';
      })();
      const noteInject = () => {
        if (reason === 'global-prefs') mem.inject.globalPrefsCount = Number(mem.inject.globalPrefsCount || 0) + 1;
        if (reason === 'current-session-refresh') mem.inject.currentSummaryCount = Number(mem.inject.currentSummaryCount || 0) + 1;
        if (reason === 'trigger-recall') mem.inject.triggerRecallCount = Number(mem.inject.triggerRecallCount || 0) + 1;
        if (reason === 'memory-docs') mem.inject.memoryDocsCount = Number(mem.inject.memoryDocsCount || 0) + 1;
        mem.inject.lastAt = new Date().toISOString();
        mem.inject.lastReason = String(reason || 'memory-inject');
        mem.inject.lastStatus = 'success';
        mem.inject.lastDigest = digest;
        mem.inject.lastSkippedAt = null;
        mem.inject.lastSkipReason = '';
        persistSessionMemory(mem);
        writeDashboardFiles();
      };
      const noteInjectFailed = () => {
        mem.inject.lastAt = new Date().toISOString();
        mem.inject.lastReason = String(reason || 'memory-inject');
        mem.inject.lastStatus = 'failed';
        mem.inject.lastDigest = digest;
        persistSessionMemory(mem);
        writeDashboardFiles();
      };
      if (client?.session && typeof client.session.prompt === 'function') {
        try {
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [makeInjectableTextPart(text)]
            }
          });
          noteInject();
          await emitVisibleNotice(sessionID, `${reasonLabel}（~${estimateTokensFromText(text)} tokens）`, `inject:${reason}`);
          return true;
        } catch {
          // fall through to legacy compatibility path
        }
      }

      if (client?.session && typeof client.session.update === 'function') {
        try {
          await client.session.update(sessionID, {
            noReply: true,
            parts: [{ type: 'text', text, synthetic: true }]
          });
          noteInject();
          await emitVisibleNotice(sessionID, `${reasonLabel}（~${estimateTokensFromText(text)} tokens）`, `inject:${reason}`);
          return true;
        } catch {
          await client.session.update({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [{ type: 'text', text, synthetic: true }]
            }
          });
          noteInject();
          await emitVisibleNotice(sessionID, `${reasonLabel}（~${estimateTokensFromText(text)} tokens）`, `inject:${reason}`);
          return true;
        }
      }

      console.error(`memory-system inject skipped (${reason}): no supported client.session.update method`);
      noteInjectFailed();
      return false;
    } catch (err) {
      console.error(`memory-system inject failed (${reason}):`, err);
      try {
        const mem = loadSessionMemory(sessionID);
        mem.inject = mem.inject || {};
        mem.inject.lastAt = new Date().toISOString();
        mem.inject.lastReason = String(reason || 'memory-inject');
        mem.inject.lastStatus = 'failed';
        mem.inject.lastDigest = stableTextHash(text);
        persistSessionMemory(mem);
        writeDashboardFiles();
      } catch {
        // ignore
      }
      return false;
    }
  }

  function buildGlobalPrefsContextText() {
    const globalMemory = readJson(globalMemoryPath) || {};
    const prefs = getNormalizedGlobalPreferences(globalMemory);

    const maxItems = getIntPreference(['injectGlobalPrefsMaxItems', 'inject_global_prefs_max_items'], AUTO_INJECT_GLOBAL_PREFS_MAX_ITEMS, 1, 30);
    const maxCharsSetting = getIntPreference(['injectGlobalPrefsMaxChars', 'inject_global_prefs_max_chars'], AUTO_INJECT_GLOBAL_PREFS_MAX_CHARS, 120, 3000);
    const priorityKeys = [
      'note',
      'language',
      'communication_style',
      'nickname',
      'user_name',
      'assistant_name'
    ];
    const seen = new Set();
    const orderedEntries = [];
    const pushEntry = (key, value) => {
      const cleanKey = normalizeText(String(key || ''));
      const cleanValue = normalizeText(String(value ?? ''));
      if (!cleanKey || !cleanValue || seen.has(cleanKey)) return;
      seen.add(cleanKey);
      orderedEntries.push([cleanKey, value]);
    };
    for (const key of priorityKeys) pushEntry(key, prefs[key]);
    for (const [key, value] of Object.entries(prefs)) pushEntry(key, value);
    const entries = orderedEntries.slice(0, maxItems);
    if (!entries.length) return '';

    const lines = [];
    const state = { chars: 0, maxChars: maxCharsSetting };
    pushLineWithLimit(lines, '<OPENCODE_GLOBAL_PREFERENCES>', state);
    for (const [k, v] of entries) {
      pushLineWithLimit(lines, `- ${k}: ${truncateText(normalizeText(String(v)), 120)}`, state);
    }
    pushLineWithLimit(lines, '</OPENCODE_GLOBAL_PREFERENCES>', state);

    if (lines.length <= 2) return '';
    return lines.join('\n');
  }

  function normalizeLanguagePreferenceValue(rawValue = '') {
    const value = normalizeText(String(rawValue ?? ''));
    if (!value) return '';
    if (/^(中文|简体中文|zh|zh-cn|chinese|mandarin|汉语|普通话)$/i.test(value)) return '中文';
    if (/^(英文|英语|english|en|en-us)$/i.test(value)) return '英文';
    if (/^(日文|日语|japanese|ja|ja-jp)$/i.test(value)) return '日文';
    return value;
  }

  function normalizeGlobalPreferenceValue(rawKey = '', rawValue = undefined) {
    const key = normalizeText(String(rawKey || '')).replace(/^preferences\./i, '');
    if (!key || rawValue === undefined || rawValue === null) return rawValue;
    if (key === 'language' || key === 'language_preference') {
      return normalizeLanguagePreferenceValue(rawValue) || rawValue;
    }
    return rawValue;
  }

  function getNormalizedGlobalPreferences(globalMemory) {
    const gm = globalMemory && typeof globalMemory === 'object' ? globalMemory : {};
    const prefs =
      gm.preferences && typeof gm.preferences === 'object'
        ? gm.preferences
        : {};
    const legacyTopLevel = {};
    for (const [k, v] of Object.entries(gm)) {
      if (k === 'preferences' || k === 'snippets' || k === 'feedback') continue;
      if (v === null || v === undefined) continue;
      const t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean') {
        legacyTopLevel[k] = v;
      }
    }
    const merged = { ...legacyTopLevel, ...prefs };
    const languageSource =
      normalizeText(String(merged.language ?? ''))
      || normalizeText(String(merged.language_preference ?? ''));
    if (languageSource) {
      merged.language = normalizeLanguagePreferenceValue(languageSource);
    }
    delete merged.language_preference;
    const normalized = {};
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || value === null) continue;
      const cleanKey = normalizeText(String(key || ''));
      if (!cleanKey) continue;
      normalized[cleanKey] = normalizeGlobalPreferenceValue(cleanKey, value);
    }
    return normalized;
  }

  function lookupGlobalPreferenceValue(preferences = {}, rawKey = '') {
    const prefs = preferences && typeof preferences === 'object' ? preferences : {};
    const directKey = normalizeText(String(rawKey || ''));
    if (!directKey) return undefined;
    const normalizedKey = directKey.replace(/^preferences\./i, '');
    const candidates = [];
    const pushCandidate = (key) => {
      const cleanKey = normalizeText(String(key || ''));
      if (!cleanKey || candidates.includes(cleanKey)) return;
      candidates.push(cleanKey);
    };
    pushCandidate(directKey);
    pushCandidate(normalizedKey);
    if (normalizedKey === 'language') {
      pushCandidate('language_preference');
      pushCandidate('preferences.language_preference');
    } else if (normalizedKey === 'language_preference') {
      pushCandidate('language');
      pushCandidate('preferences.language');
    }
    for (const key of candidates) {
      if (!key) continue;
      const value = prefs[key];
      if (value !== undefined && value !== null && normalizeText(String(value))) {
        return normalizeGlobalPreferenceValue(key, value);
      }
    }
    return undefined;
  }

  function buildCurrentSessionSummaryText(sessionID) {
    if (!sessionID) return '';
    const s = loadSessionMemory(sessionID);
    if (!s || !Array.isArray(s.recentEvents)) return '';

    const maxChars = Math.min(
      charsFromTokenBudget(getCurrentSessionSummaryTokenBudget()),
      getCurrentSessionSummaryMaxChars()
    );
    const state = { chars: 0, maxChars };
    const lines = [];

    pushLineWithLimit(lines, `<OPENCODE_CURRENT_SESSION_SUMMARY session="${sessionID}">`, state);

    const stats = s?.stats || emptyStats();
    pushLineWithLimit(
      lines,
      `stats: user=${stats.userMessages || 0}, assistant=${stats.assistantMessages || 0}, tools=${stats.toolResults || 0}`,
      state
    );

    const summary = truncateText(sanitizeCompressedSummaryText(String(s?.summary?.compressedText || '')), 260);
    if (summary) pushLineWithLimit(lines, `compressed: ${summary}`, state);

    const recent = s.recentEvents.slice(-getCurrentSessionSummaryMaxEvents());
    const structured = buildCompressedChunk(recent);
    for (const row of structured.split('\n')) {
      pushLineWithLimit(lines, row, state);
    }

    pushLineWithLimit(lines, '</OPENCODE_CURRENT_SESSION_SUMMARY>', state);
    if (lines.length <= 2) return '';
    return lines.join('\n');
  }

  async function maybeInjectTriggerRecall(sessionID, query) {
    if (!getRecallEnabled() || !sessionID) return;

    const now = Date.now();
    const normQuery = normalizeText(query).toLowerCase();
    const state = sessionRecallState.get(sessionID) || { lastAt: 0, lastQuery: '' };

    if (now - state.lastAt < getRecallCooldownMs() && state.lastQuery === normQuery) {
      return;
    }

    const { text, hits } = recallProjectMemories(query, {
      currentSessionID: sessionID,
      includeCurrent: false,
      maxSessions: getRecallTopSessions(),
      maxEventsPerSession: getRecallMaxEventsPerSession(),
      maxChars: getRecallMaxChars(),
      tokenBudget: getRecallTokenBudget()
    });

    if (!text || !hits.length) return;
    const recallText = augmentWeakFollowupRecallText(query, text);

    const injected = await injectMemoryText(sessionID, recallText, 'trigger-recall');
    if (!injected) {
      appendAutoEvent({
        sessionID,
        kind: 'system-event',
        summary: 'trigger-recall prepared but injection failed',
        rawEvent: null
      });
      return;
    }

    const mem = loadSessionMemory(sessionID);
    mem.recall = mem.recall || { count: 0, lastAt: null, lastQuery: '' };
    mem.recall.count = (mem.recall.count || 0) + 1;
    mem.recall.lastAt = new Date().toISOString();
    mem.recall.lastQuery = truncateText(normQuery, 180);
    persistSessionMemory(mem);

    sessionRecallState.set(sessionID, { lastAt: now, lastQuery: normQuery });
    writeDashboardFiles();
  }

  function buildDashboardData() {
    const globalMemory = readJson(globalMemoryPath) || {};
    const memoryCfg = readMemoryConfig();
    const memorySystemSettings = memoryCfg?.memorySystem && typeof memoryCfg.memorySystem === 'object'
      ? memoryCfg.memorySystem
      : {};
    const projects = [];

    let projectDirs = [];
    try {
      projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      projectDirs = [];
    }

    for (const d of projectDirs) {
      const projectName = d.name;
      const meta = readProjectMeta(projectName);
      const sessionsRaw = listSessionMemories(projectName);

      const sessionList = sessionsRaw.map((sess) => {
        const pretrimTraces = Array.isArray(sess?.sendPretrim?.traces) ? sess.sendPretrim.traces : [];
        const latestTrace = pretrimTraces.length ? pretrimTraces[pretrimTraces.length - 1] : null;
        const budgetSystemFallback = Number(
          sess?.budget?.lastEstimatedSystemTokens ||
          latestTrace?.systemTokensAfter ||
          latestTrace?.systemTokensBefore ||
          0
        );
        const budgetBodyFallback = Number(
          sess?.budget?.lastEstimatedBodyTokens ||
          latestTrace?.afterTokens ||
          latestTrace?.beforeTokens ||
          0
        );
        const budgetPluginHintFallback = Number(
          sess?.budget?.lastEstimatedPluginHintTokens ||
          latestTrace?.pluginHintTokensAfter ||
          latestTrace?.pluginHintTokensBefore ||
          0
        );
        const budgetTotalFallback = Number(budgetBodyFallback + budgetSystemFallback);
        const sessionAlerts = sess?.alerts && typeof sess.alerts === 'object'
          ? { ...sess.alerts }
          : {};
        const derivedSystemTokenRisk = buildSystemTokenRiskAlert({
          bodyTokens: budgetBodyFallback,
          systemTokens: budgetSystemFallback,
          pluginHintTokens: budgetPluginHintFallback,
          totalTokens: budgetTotalFallback
        });
        if (derivedSystemTokenRisk) sessionAlerts.systemTokenRisk = derivedSystemTokenRisk;
        else if (sessionAlerts.systemTokenRisk) delete sessionAlerts.systemTokenRisk;
        const systemPromptFallback = {
          lastObservedTokens: Number(
            sess?.systemPrompt?.lastObservedTokens ||
            sess?.budget?.lastEstimatedSystemTokens ||
            latestTrace?.systemTokensAfter ||
            latestTrace?.systemTokensBefore ||
            0
          ),
          lastObservedLines: Number(sess?.systemPrompt?.lastObservedLines || 0),
          lastObservedAt: sess?.systemPrompt?.lastObservedAt || null,
          lastObservedHash: sess?.systemPrompt?.lastObservedHash || '',
          lastObservedPreview: sess?.systemPrompt?.lastObservedPreview || '',
          lastObservedModel: sess?.systemPrompt?.lastObservedModel || '',
          lastObservedChars: Number(sess?.systemPrompt?.lastObservedChars || 0),
          lastObservedText: sess?.systemPrompt?.lastObservedText || ''
        };
        return ({
        projectName,
        sessionID: sess.sessionID,
        sessionTitle: normalizeText(sess.sessionTitle || '') || deriveSessionTitleFromEvents(sess) || '',
        sessionCwd: normalizeText(sess.sessionCwd || ''),
        createdAt: sess.createdAt || null,
        updatedAt: sess.updatedAt || null,
        stats: sess.stats || emptyStats(),
        recentEvents: Array.isArray(sess.recentEvents)
          ? sess.recentEvents.slice(-DASHBOARD_MAX_EVENTS_PER_SESSION_VIEW)
          : [],
        summary: {
          compressedEvents: Number(sess?.summary?.compressedEvents || 0),
          lastCompressedAt: sess?.summary?.lastCompressedAt || null,
          compressedText: sanitizeCompressedSummaryText(String(sess?.summary?.compressedText || '')),
          compressedPreview: truncateText(sanitizeCompressedSummaryText(String(sess?.summary?.compressedText || '')), 240)
        },
        summaryBlocks: (() => {
          const arr = Array.isArray(sess?.summaryBlocks) ? sess.summaryBlocks : [];
          const traces = pretrimTraces;
          const traceByBlockId = new Map();
          for (const tr of traces) {
            const bid = Number(tr?.blockId || 0);
            if (bid > 0 && !traceByBlockId.has(bid)) traceByBlockId.set(bid, tr);
          }
          const recent = arr.slice(-5).map((b) => ({
            blockId: Number(b?.blockId || 0),
            createdAt: b?.createdAt || null,
            source: b?.source || '',
            startMessageID: b?.startMessageID || '',
            endMessageID: b?.endMessageID || '',
            consumedMessages: Number(b?.consumedMessages || 0),
            summaryPreview: (() => {
              const blkId = Number(b?.blockId || 0);
              const tr = traceByBlockId.get(blkId);
              const range = (b?.startMessageID && b?.endMessageID)
                ? `range:${b.startMessageID}->${b.endMessageID}`
                : '';
              const saved = tr ? ` save~${Number(tr?.savedTokens || 0)}` : '';
              const prefix = `${range}${saved}`.trim();
              const body = normalizeText(String(b?.summary || ''));
              return truncateText(prefix ? `${prefix} | ${body}` : body, 160);
            })()
          }));
          return { count: arr.length, recent };
        })(),
        recall: {
          count: Number(sess?.recall?.count || 0),
          lastAt: sess?.recall?.lastAt || null
        },
        inject: {
          globalPrefsCount: Number(sess?.inject?.globalPrefsCount || 0),
          currentSummaryCount: Number(sess?.inject?.currentSummaryCount || 0),
          triggerRecallCount: Number(sess?.inject?.triggerRecallCount || 0),
          memoryDocsCount: Number(sess?.inject?.memoryDocsCount || 0),
          lastAt: sess?.inject?.lastAt || null,
          lastReason: sess?.inject?.lastReason || '',
          lastStatus: sess?.inject?.lastStatus || '',
          lastDigest: sess?.inject?.lastDigest || '',
          lastSkippedAt: sess?.inject?.lastSkippedAt || null,
          lastSkipReason: sess?.inject?.lastSkipReason || '',
          lastNoticeAt: sess?.inject?.lastNoticeAt || null,
          lastNoticeKey: sess?.inject?.lastNoticeKey || '',
          lastNoticeChannel: sess?.inject?.lastNoticeChannel || '',
          lastNoticeText: sess?.inject?.lastNoticeText || ''
        },
        budget: {
          bodyTokenBudget: Number(sess?.budget?.bodyTokenBudget || AUTO_BODY_TOKEN_BUDGET),
          sendPretrimBudget: Number(sess?.budget?.sendPretrimBudget || getSendPretrimBudget()),
          sendPretrimTarget: Number(sess?.budget?.sendPretrimTarget || getSendPretrimTarget()),
          lastEstimatedBodyTokens: budgetBodyFallback,
          lastEstimatedSystemTokens: budgetSystemFallback,
          lastEstimatedPluginHintTokens: budgetPluginHintFallback,
          lastEstimatedTotalTokens: budgetTotalFallback,
          tokenView: buildBudgetTokenView({
            lastEstimatedBodyTokens: budgetBodyFallback,
            lastEstimatedSystemTokens: budgetSystemFallback,
            lastEstimatedPluginHintTokens: budgetPluginHintFallback,
            lastEstimatedTotalTokens: budgetTotalFallback
          }),
          lastCompactedAt: sess?.budget?.lastCompactedAt || null,
          lastCompactionReason: sess?.budget?.lastCompactionReason || ''
        },
        systemPrompt: systemPromptFallback,
        pruneAudit: {
          autoRuns: Number(sess?.pruneAudit?.autoRuns || 0),
          manualRuns: Number(sess?.pruneAudit?.manualRuns || 0),
          discardRemovedTotal: Number(sess?.pruneAudit?.discardRemovedTotal || 0),
          extractMovedTotal: Number(sess?.pruneAudit?.extractMovedTotal || 0),
          lastAt: sess?.pruneAudit?.lastAt || null,
          lastSource: sess?.pruneAudit?.lastSource || '',
          lastDiscardRemoved: Number(sess?.pruneAudit?.lastDiscardRemoved || 0),
          lastExtractMoved: Number(sess?.pruneAudit?.lastExtractMoved || 0),
          lastEstimatedBodyTokens: Number(sess?.pruneAudit?.lastEstimatedBodyTokens || 0)
        },
        sendPretrim: {
          autoRuns: Number(sess?.sendPretrim?.autoRuns || 0),
          manualRuns: Number(sess?.sendPretrim?.manualRuns || 0),
          savedTokensTotal: Number(sess?.sendPretrim?.savedTokensTotal || 0),
          lastBeforeTokens: Number(sess?.sendPretrim?.lastBeforeTokens || 0),
          lastAfterTokens: Number(sess?.sendPretrim?.lastAfterTokens || 0),
          lastSavedTokens: Number(sess?.sendPretrim?.lastSavedTokens || 0),
          lastAt: sess?.sendPretrim?.lastAt || null,
          lastReason: sess?.sendPretrim?.lastReason || '',
          lastStatus: sess?.sendPretrim?.lastStatus || '',
          warmup: {
            sourceHash: String(sess?.sendPretrim?.warmup?.sourceHash || ''),
            status: String(sess?.sendPretrim?.warmup?.status || ''),
            mode: String(sess?.sendPretrim?.warmup?.mode || ''),
            provider: String(sess?.sendPretrim?.warmup?.provider || ''),
            model: String(sess?.sendPretrim?.warmup?.model || ''),
            lastUserMessageID: String(sess?.sendPretrim?.warmup?.lastUserMessageID || ''),
            lastAttemptAt: sess?.sendPretrim?.warmup?.lastAttemptAt || null,
            consecutiveFails: Number(sess?.sendPretrim?.warmup?.consecutiveFails || 0),
            failCount: Number(sess?.sendPretrim?.warmup?.failCount || 0),
            hitCount: Number(sess?.sendPretrim?.warmup?.hitCount || 0),
            missCount: Number(sess?.sendPretrim?.warmup?.missCount || 0),
            skipBudgetCount: Number(sess?.sendPretrim?.warmup?.skipBudgetCount || 0),
            skipCooldownCount: Number(sess?.sendPretrim?.warmup?.skipCooldownCount || 0),
            skipPausedCount: Number(sess?.sendPretrim?.warmup?.skipPausedCount || 0),
            preparedAt: sess?.sendPretrim?.warmup?.preparedAt || null,
            usedAt: sess?.sendPretrim?.warmup?.usedAt || null,
            logs: Array.isArray(sess?.sendPretrim?.warmup?.logs)
              ? sess.sendPretrim.warmup.logs.slice(-AUTO_SEND_PRETRIM_WARMUP_LOG_LIMIT)
              : []
          },
          traces: Array.isArray(sess?.sendPretrim?.traces) ? sess.sendPretrim.traces.slice(-8) : []
        },
        alerts: sessionAlerts
      })});

      const totalEvents = sessionList.reduce(
        (acc, it) => acc + (it.recentEvents?.length || 0) + Number(it?.summary?.compressedEvents || 0),
        0
      );

      projects.push({
        name: projectName,
        path: getProjectMemoryPath(projectName),
        lastLearned: meta?.lastLearned || null,
        techStack: Array.isArray(meta?.techStack) ? meta.techStack : [],
        sessionCount: sessionList.length,
        totalEvents,
        sessions: sortByUpdated(sessionList)
      });
    }

    projects.sort((a, b) => {
      const ta = Date.parse((a.sessions[0] && a.sessions[0].updatedAt) || a.lastLearned || 0) || 0;
      const tb = Date.parse((b.sessions[0] && b.sessions[0].updatedAt) || b.lastLearned || 0) || 0;
      return tb - ta;
    });

    return {
      generatedAt: new Date().toISOString(),
      settings: {
        memorySystem: memorySystemSettings
      },
      global: {
        preferences: getNormalizedGlobalPreferences(globalMemory),
        snippets: globalMemory?.snippets && typeof globalMemory.snippets === 'object' ? globalMemory.snippets : {},
        feedback: Array.isArray(globalMemory?.feedback) ? globalMemory.feedback : []
      },
      projects,
      summary: {
        projectCount: projects.length,
        sessionCount: projects.reduce((acc, p) => acc + p.sessionCount, 0),
        eventCount: projects.reduce((acc, p) => acc + p.totalEvents, 0)
      }
    };
  }

  function buildDashboardHtmlLegacy(data) {
    const payload = JSON.stringify(data).replace(/</g, '\\u003c');
    const html = [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '  <title>Memory Dashboard</title>',
      '  <style>',
      '    :root { --bg:#f2f2f7; --panel:rgba(255,255,255,.78); --ink:#111111; --muted:#6e6e73; --accent:#0071e3; --line:rgba(15,23,42,.08); --shadow:0 8px 30px rgba(15,23,42,.06); --radius:16px; --blur: saturate(140%) blur(8px); --ok:#047857; --warn:#b45309; --bad:#b91c1c; }',
      '    * { box-sizing: border-box; }',
      '    body { margin:0; font-family:"SF Pro Text","PingFang SC","Noto Sans SC","Segoe UI",sans-serif; color:var(--ink); background:radial-gradient(1200px 500px at 20% -20%, #ffffff 0%, #f2f2f7 45%, #eceef4 100%); }',
      '    .layout { display:grid; grid-template-columns:320px 1fr; min-height:100vh; gap:12px; padding:12px; }',
      '    .sidebar { border:1px solid var(--line); border-radius:var(--radius); background:var(--panel); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur); padding:16px; overflow:auto; box-shadow:var(--shadow); position:sticky; top:12px; max-height:calc(100vh - 24px); }',
      '    .main { overflow:auto; }',
      '    h1 { margin:0 0 8px; font-size:18px; letter-spacing:0; font-weight:700; }',
      '    .sub { color:var(--muted); font-size:12px; margin-bottom:8px; line-height:1.45; }',
      '    .metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:4px 0 14px; }',
      '    .metric { background:rgba(255,255,255,.86); border:1px solid var(--line); border-radius:12px; padding:10px; box-shadow:inset 0 1px 0 rgba(255,255,255,.6); }',
      '    .metric .k { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.6px; }',
      '    .metric .v { font-size:18px; font-weight:700; margin-top:2px; color:var(--ink); }',
      '    .project-item { background:rgba(255,255,255,.78); border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:8px; cursor:pointer; transition:border-color .18s ease, transform .18s ease, background .18s ease; }',
      '    .project-item:hover { border-color:#b7c7dd; transform:translateY(-1px); }',
      '    .project-item.active { border-color:var(--accent); background:#eef6ff; box-shadow:0 0 0 1px rgba(0,113,227,.2) inset; }',
      '    .project-item .name { font-weight:700; font-size:13px; }',
      '    .project-item .meta { color:var(--muted); font-size:12px; margin-top:4px; }',
      '    .panel { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); padding:14px; margin-bottom:10px; box-shadow:var(--shadow); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur); }',
      '    .session { border:1px solid var(--line); border-radius:12px; margin-bottom:8px; overflow:hidden; background:rgba(255,255,255,.9); transition:border-color .12s ease; }',
      '    .session:hover { border-color:#cbd5e1; }',
      '    .session-h { padding:10px 12px; display:flex; justify-content:flex-start; align-items:flex-start; gap:12px; background:#fafafa; border-bottom:1px solid var(--line); cursor:pointer; }',
      '    .session-id { font-family:"IBM Plex Mono","JetBrains Mono",monospace; font-size:12px; text-align:left; font-weight:620; }',
      '    .stats { font-size:12px; color:var(--muted); text-align:left; line-height:1.55; }',
      '    .events { display:block; max-height:0; opacity:0; overflow:hidden; padding:0 12px; transition:max-height .2s ease, opacity .18s ease, padding .18s ease; }',
      '    .events.open { max-height:1600px; opacity:1; padding:10px 12px; }',
      '    .ev { border-left:3px solid #d1d5db; padding:8px 9px; margin-bottom:8px; background:#f8fafc; border-radius:8px; }',
      '    .ev.user-message { border-left-color:#2563eb; }',
      '    .ev.assistant-message { border-left-color:#0ea5a0; }',
      '    .ev.tool-result { border-left-color:#0f766e; }',
      '    .ev.session-start, .ev.session-end { border-left-color:#64748b; }',
      '    .ev .meta { color:var(--muted); font-size:11px; margin-bottom:4px; }',
      '    .ev .txt { white-space:pre-wrap; font-size:13px; line-height:1.45; }',
      '    .pref { font-size:13px; color:var(--ink); margin-bottom:6px; background:#fff; border:1px solid var(--line); border-radius:8px; padding:8px 10px; }',
      '    .empty { color:var(--muted); font-size:13px; padding:6px 0; }',
      '    .trash-row { display:flex; align-items:flex-start; gap:10px; padding:10px; border:1px solid var(--line); border-radius:10px; margin-bottom:8px; background:#f8fafc; }',
      '    .trash-row .meta { font-size:12px; color:var(--muted); }',
      '    .trash-row .path { font-family:"IBM Plex Mono","JetBrains Mono",monospace; font-size:11px; color:#334155; word-break:break-all; }',
      '    .tabbar { display:flex; gap:8px; flex-wrap:wrap; }',
      '    .tab-btn { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:10px; padding:8px 12px; cursor:pointer; font-size:13px; font-weight:600; transition:.12s ease; }',
      '    .tab-btn:hover { border-color:#b4c4d4; }',
      '    .tab-btn.active { background:var(--accent); color:#fff; border-color:var(--accent); box-shadow:none; }',
      '    .tab-pane { display:none; animation:fadeIn .18s ease; }',
      '    .tab-pane.active { display:block; }',
      '    .status-row { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }',
      '    .conn-badge { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:5px 10px; background:#fff; font-size:12px; font-weight:700; color:var(--muted); }',
      '    .conn-badge::before { content:""; width:8px; height:8px; border-radius:999px; background:#94a3b8; box-shadow:0 0 0 2px rgba(148,163,184,.14); }',
      '    .conn-badge.ok { color:var(--ok); border-color:rgba(4,120,87,.18); background:rgba(4,120,87,.06); }',
      '    .conn-badge.ok::before { background:var(--ok); box-shadow:0 0 0 2px rgba(4,120,87,.14); }',
      '    .conn-badge.pending { color:var(--warn); border-color:rgba(180,83,9,.18); background:rgba(180,83,9,.06); }',
      '    .conn-badge.pending::before { background:var(--warn); box-shadow:0 0 0 2px rgba(180,83,9,.14); }',
      '    .conn-badge.bad { color:var(--bad); border-color:rgba(185,28,28,.18); background:rgba(185,28,28,.06); }',
      '    .conn-badge.bad::before { background:var(--bad); box-shadow:0 0 0 2px rgba(185,28,28,.14); }',
      '    @keyframes fadeIn { from { opacity:0; transform:translateY(2px); } to { opacity:1; transform:none; } }',
      '    button { border:1px solid var(--line); background:#fff; color:#111827; border-radius:10px; padding:7px 10px; cursor:pointer; font-weight:600; }',
      '    button:hover { border-color:#9fb3c8; }',
      '    button { transition:transform .06s ease, box-shadow .12s ease, border-color .12s ease, background-color .12s ease; box-shadow:0 1px 0 rgba(15,23,42,.04); }',
      '    button:active { transform:translateY(1px) scale(.995); box-shadow:inset 0 1px 2px rgba(15,23,42,.16); }',
      '    .tab-btn:active { transform:translateY(1px) scale(.995); }',
      '    button:focus-visible, .tab-btn:focus-visible { outline:2px solid rgba(15,118,110,.35); outline-offset:1px; }',
      '    button:disabled { opacity:.45; cursor:not-allowed; }',
      '    select, input[type="number"], textarea { border:1px solid var(--line); border-radius:10px; background:#fff; }',
      '    details.fold { border:1px solid var(--line); border-radius:10px; padding:8px 10px; background:#fcfeff; }',
      '    details.fold > summary { cursor:pointer; list-style:none; font-weight:600; color:#334155; }',
      '    details.fold > summary::-webkit-details-marker { display:none; }',
      '    details.fold > summary::before { content:"▶ "; color:#64748b; }',
      '    details.fold[open] > summary::before { content:"▼ "; }',
      '    .settings-help-list { margin-top:8px; display:grid; grid-template-columns:1fr; gap:6px; }',
      '    .settings-help-item { font-size:12px; color:#475569; line-height:1.45; }',
      '    .settings-help-item b { color:#0f172a; }',
      '    @media (max-width:1080px) { .layout { grid-template-columns:1fr; padding:10px; } .sidebar { position:relative; top:0; max-height:none; } }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div class="layout">',
      '    <aside class="sidebar">',
      '      <div class="status-row"><h1 id="titleMain">Memory Dashboard</h1><div id="connBadge" class="conn-badge pending">连接中</div></div>',
      '      <div class="sub" id="genAt"></div>',
      '      <div class="sub"><label id="langLabel" for="langSel">Language</label>: <select id="langSel"><option value="zh">中文</option><option value="en">English</option></select></div>',
      '      <div class="metrics">',
      '        <div class="metric"><div class="k" id="mProjectsK">Projects</div><div class="v" id="mProjects">0</div></div>',
      '        <div class="metric"><div class="k" id="mSessionsK">Sessions</div><div class="v" id="mSessions">0</div></div>',
      '        <div class="metric"><div class="k" id="mEventsK">Events</div><div class="v" id="mEvents">0</div></div>',
      '      </div>',
      '      <div id="projectList"></div>',
      '    </aside>',
      '    <main class="main">',
      '      <div class="panel"><div class="tabbar"><button id="tabSessionsBtn" class="tab-btn active">会话页</button><button id="tabTemplateBtn" class="tab-btn">摘要模板设置</button><button id="tabLlmBtn" class="tab-btn">LLM设置</button><button id="tabSettingsBtn" class="tab-btn">参数页</button><button id="tabTrashBtn" class="tab-btn">回收站</button></div></div>',
      '      <section id="paneSessions" class="tab-pane active">',
      '        <div class="panel"><h1 id="projectTitle" style="font-size:18px;">No project selected</h1><div class="sub" id="projectMeta"></div></div>',
      '        <div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;"><h1 id="sessionsTitle" style="font-size:16px;">Sessions</h1><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><button id="batchSelectAllBtn" style="height:30px;">全选</button><button id="batchSelectNoneBtn" style="height:30px;">全不选</button><button id="batchDeleteBtn" style="height:30px;">Batch Delete</button></div></div><div id="systemAuditHint" class="sub" style="margin-top:8px;">展开某个会话后，在“发送前系统层审计”卡片里查看最近一次真正发给模型的 system 文本。</div><div id="sessionList" class="empty">No sessions.</div></div>',
      '      </section>',
      '      <section id="paneTemplate" class="tab-pane">',
      '        <div class="panel"><h1 id="templateTitle" style="font-size:16px;">摘要模板设置</h1><div class="sub" id="templateHint">用于机械裁剪/LLM总结的输出格式，不是页面模板。保存后立即生效并持久化。</div><div class="sub" id="templateFormatHint" style="margin-top:6px;">可用占位变量：{{window}} {{events}} {{status}} {{sessionCwd}} {{recommendedWorkdir}} {{relatedWorkdirs}} {{keyFacts}} {{taskGoal}} {{keyOutcomes}} {{toolsUsed}} {{skillsUsed}} {{keyFiles}} {{decisions}} {{blockers}} {{todoRisks}} {{nextActions}} {{workdirScoring}} {{handoffAnchor}}；示例(JSON)：{\"title\":\"{{status}}\",\"facts\":\"{{keyFacts}}\"}</div><div style=\"display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;margin-top:8px;\"><label id=\"templateNameLabel\" for=\"templateNameInput\">模板名称</label><input id=\"templateNameInput\" type=\"text\" placeholder=\"default\" style=\"height:30px;border:1px solid #d9e2ea;border-radius:8px;padding:0 8px;\"/><label id=\"templateSelectLabel\" for=\"templateSelect\">已保存模板</label><select id=\"templateSelect\" style=\"height:30px;border:1px solid #d9e2ea;border-radius:8px;padding:0 6px;\"></select></div><textarea id="templateEditor" style="width:100%;height:260px;margin-top:10px;border:1px solid #d9e2ea;border-radius:8px;padding:10px;font-family:IBM Plex Mono,monospace;"></textarea><div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><button id="templateUseBtn" style="height:30px;">设为当前模板</button><button id="templateSaveBtn" style="height:30px;">按名称保存模板</button><button id="templatePreviewBtn" style="height:30px;">预览当前模板</button><button id="templateResetBtn" style="height:30px;">恢复默认模板</button><span id="templateStatus" class="sub" style="margin:0;"></span></div><pre id="templatePreview" style="margin-top:10px;white-space:pre-wrap;background:#f8fafc;border:1px solid #d9e2ea;border-radius:8px;padding:10px;max-height:260px;overflow:auto;"></pre></div>',
      '      </section>',
      '      <section id="paneSettings" class="tab-pane">',
      '        <div class="panel"><details id="globalPrefsFold" class="fold" open><summary id="globalPrefsFoldSummary">全局偏好设置</summary><div style="margin-top:8px;"><h1 id="globalTitle" style="font-size:16px;">Global Preferences</h1><div class="sub" id="tokenHint">Token estimate is approximate (chars/4).</div><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;"><label id="pretrimProfileLabel" for="pretrimProfileSel" style="font-size:12px;color:var(--muted);">Pretrim Profile</label><select id="pretrimProfileSel"><option value="conservative">Conservative (~20%, preserve detail)</option><option value="balanced" selected>Balanced (~40%, recommended)</option><option value="aggressive">Aggressive (~60%, strongest trim)</option></select><button id="savePretrimProfileBtn" style="height:30px;">Save</button><button id="cleanGlobalNoteBtn" style="height:30px;">清洗 note</button><span id="pretrimProfileHint" class="sub" style="margin:0;"></span></div><div id="globalPrefs" class="empty">No global preferences.</div></div></details></div>',
        '        <div class="panel"><h1 id="settingsTitle" style="font-size:16px;">Memory System Settings</h1><div class="sub" id="settingsHint">Adjust runtime behavior. Saved locally and persisted.</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;"><details id="toggleFold" class="fold" open><summary id="toggleFoldSummary">开关参数（默认展开）</summary><div id="settingsToggleForm" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;margin-top:8px;"></div></details><details id="numericFold" class="fold" open><summary id="numericFoldSummary">数值参数（默认展开）</summary><div id="settingsNumericForm" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:center;margin-top:8px;"></div></details></div><div style="margin-top:10px;display:flex;gap:8px;align-items:center;"><button id="settingsSaveBtn" style="height:30px;">Save Settings</button><span id="settingsStatus" class="sub" style="margin:0;"></span></div></div>',
        '        ',
      '      </section>',
      '      <section id="paneLlm" class="tab-pane">',
      '        <div class="panel"><h1 id="llmTitle" style="font-size:16px;">LLM设置</h1><div class="sub" id="llmHint">内联与独立LLM总结参数。保存后立即生效。</div><div id="llmForm" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:center;margin-top:10px;"></div><datalist id="llmModelList"></datalist><div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><button id="llmFetchModelsBtn" style="height:30px;">自动获取模型</button><button id="llmValidateBtn" style="height:30px;">验证配置</button><button id="llmSaveBtn" style="height:30px;">保存LLM配置</button><span id="llmStatus" class="sub" style="margin:0;"></span></div></div>',
      '      </section>',
      '      <section id="paneTrash" class="tab-pane">',
      '        <div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;"><h1 id="trashTitle" style="font-size:16px;">Trash</h1><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;"><label id="trashRetentionLabel" for="trashRetentionSel" style="font-size:12px;color:var(--muted);">Retention Days</label><select id="trashRetentionSel"><option value="1">1</option><option value="3">3</option><option value="7">7</option><option value="10">10</option><option value="30" selected>30</option></select><button id="trashSelectAllBtn" style="height:30px;">全选</button><button id="trashSelectNoneBtn" style="height:30px;">全不选</button><button id="trashCleanupBtn" style="height:30px;">Cleanup Expired</button><button id="trashDeleteBtn" style="height:30px;" disabled>Delete Permanently(0)</button></div></div><div id="trashMeta" class="sub">-</div><div id="trashList" class="empty">No trash entries</div></div>',
      '      </section>',
    '    </main>',
      '  </div>',
      '  <div id="editModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:9999;align-items:center;justify-content:center;">',
      '    <div style="width:min(900px,92vw);background:#fff;border-radius:12px;padding:14px;border:1px solid #d9e2ea;">',
      '      <div style="font-weight:650;margin-bottom:8px;" id="editTitle">Edit summary</div>',
      '      <textarea id="editTextarea" style="width:100%;height:280px;border:1px solid #d9e2ea;border-radius:8px;padding:10px;font-family:IBM Plex Mono,monospace;"></textarea>',
      '      <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end;">',
      '        <button id="editCancelBtn">Cancel</button>',
      '        <button id="editSaveBtn">Save</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <script>',
      '    let DATA = ' + payload + ';',
      '    const $ = (id) => document.getElementById(id);',
      '    const projectList = $("projectList");',
      '    const sessionList = $("sessionList");',
      '    const projectTitle = $("projectTitle");',
      '    const projectMeta = $("projectMeta");',
      '    const globalPrefs = $("globalPrefs");',
      '    const langSel = $("langSel");',
      '    const pretrimProfileSel = $("pretrimProfileSel");',
      '    const savePretrimProfileBtn = $("savePretrimProfileBtn");',
      '    const cleanGlobalNoteBtn = $("cleanGlobalNoteBtn");',
      '    const pretrimProfileHint = $("pretrimProfileHint");',
      '    const settingsForm = $("settingsForm");',
      '    const settingsToggleForm = $("settingsToggleForm");',
      '    const settingsNumericForm = $("settingsNumericForm");',
      '    const settingsSaveBtn = $("settingsSaveBtn");',
      '    const settingsStatus = $("settingsStatus");',
      '    const settingsHelpBody = $("settingsHelpBody");',
      '    const tabSessionsBtn = $("tabSessionsBtn");',
      '    const tabTemplateBtn = $("tabTemplateBtn");',
      '    const tabSettingsBtn = $("tabSettingsBtn");',
      '    const tabLlmBtn = $("tabLlmBtn");',
      '    const tabTrashBtn = $("tabTrashBtn");',
      '    const paneSessions = $("paneSessions");',
      '    const paneTemplate = $("paneTemplate");',
      '    const paneSettings = $("paneSettings");',
      '    const paneLlm = $("paneLlm");',
      '    const paneTrash = $("paneTrash");',
      '    const templateEditor = $("templateEditor");',
      '    const templateNameInput = $("templateNameInput");',
      '    const templateSelect = $("templateSelect");',
      '    const templateUseBtn = $("templateUseBtn");',
      '    const templateSaveBtn = $("templateSaveBtn");',
      '    const templateResetBtn = $("templateResetBtn");',
      '    const templatePreviewBtn = $("templatePreviewBtn");',
      '    const templateStatus = $("templateStatus");',
      '    const templatePreview = $("templatePreview");',
      '    const llmForm = $("llmForm");',
      '    const llmSaveBtn = $("llmSaveBtn");',
      '    const llmStatus = $("llmStatus");',
      '    const llmFetchModelsBtn = $("llmFetchModelsBtn");',
      '    const llmValidateBtn = $("llmValidateBtn");',
      '    const SETTINGS_SCHEMA = [',
      '      { key:"sendPretrimEnabled", type:"bool", default:true, labelZh:"发送前自动裁剪", labelEn:"Send-time auto pretrim" },',
      '      { key:"sendPretrimWarmupEnabled", type:"bool", default:true, labelZh:"后台预总结加速", labelEn:"Background warmup summary" },',
      '      { key:"sendPretrimBudget", type:"int", default:10000, labelZh:"发送前裁剪预算(token)", labelEn:"Send pretrim budget (tokens)" },',
      '      { key:"sendPretrimTarget", type:"int", default:7500, labelZh:"发送前裁剪目标(token)", labelEn:"Send pretrim target (tokens)" },',
      '      { key:"sendPretrimHardRatio", type:"float", default:0.9, step:"0.01", labelZh:"硬阈值比例(0-1)", labelEn:"Hard ratio (0-1)" },',
      '      { key:"sendPretrimDistillTriggerRatio", type:"float", default:0.8, step:"0.01", labelZh:"LLM总结触发比例(0-1)", labelEn:"Distill trigger ratio (0-1)" },',
      '      { key:"dcpCompatMode", type:"bool", default:true, labelZh:"DCP兼容模式(机械优先)", labelEn:"DCP-compat mode (mechanical first)" },',
      '      { key:"sendPretrimTurnProtection", type:"int", default:10, labelZh:"近轮保护消息数", labelEn:"Turn protection window" },',
      '      { key:"sendPretrimMaxRewriteMessages", type:"int", default:28, labelZh:"单次最大重写消息数", labelEn:"Max rewrite messages per run" },',
      '      { key:"distillSummaryMaxChars", type:"int", default:1600, labelZh:"LLM总结摘要最大字符", labelEn:"Distill summary max chars" },',
      '      { key:"distillInputMaxChars", type:"int", default:9000, labelZh:"LLM总结输入最大字符", labelEn:"Distill input max chars" },',
      '      { key:"distillRangeMinMessages", type:"int", default:2, labelZh:"LLM总结最小消息数", labelEn:"Distill range min messages" },',
      '      { key:"distillRangeMaxMessages", type:"int", default:18, labelZh:"LLM总结最大消息数", labelEn:"Distill range max messages" },',
      '      { key:"strategyPurgeErrorTurns", type:"int", default:4, labelZh:"错误输入清理轮数", labelEn:"Purge error turns" },',
      '      { key:"maxEventsPerSession", type:"int", default:120, labelZh:"单会话最大事件数", labelEn:"Max events per session" },',
      '      { key:"summaryTriggerEvents", type:"int", default:40, labelZh:"自动摘要触发事件数", labelEn:"Summary trigger events" },',
      '      { key:"summaryKeepRecentEvents", type:"int", default:18, labelZh:"自动摘要保留最近事件数", labelEn:"Summary keep recent events" },',
      '      { key:"summaryMaxChars", type:"int", default:2400, labelZh:"自动摘要最大字符", labelEn:"Summary max chars" },',
      '      { key:"summaryMaxCharsBudgetMode", type:"int", default:2600, labelZh:"预算模式摘要最大字符", labelEn:"Budget mode summary max chars" },',
      '      { key:"discardMaxRemovalsPerPass", type:"int", default:30, labelZh:"单次裁剪最大删除条数", labelEn:"Discard max removals per pass" },',
      '      { key:"extractEventsPerPass", type:"int", default:24, labelZh:"单次提取最大事件数", labelEn:"Extract events per pass" },',
      '      { key:"visibleNoticesEnabled", type:"bool", default:true, labelZh:"可见提示", labelEn:"Visible notices" },',
      '      { key:"notificationMode", type:"enum", default:"minimal", options:["off","minimal","detailed"], labelZh:"通知模式", labelEn:"Notification mode" },',
      '      { key:"visibleNoticeForDiscard", type:"bool", default:false, labelZh:"显示裁剪提示", labelEn:"Show discard notices" },',
      '      { key:"visibleNoticeCurrentSummaryMirrorEnabled", type:"bool", default:true, labelZh:"当前摘要镜像提示", labelEn:"Mirror current-summary notice" },',
      '      { key:"visibleNoticeCooldownMs", type:"int", default:120000, labelZh:"可见提示冷却(ms)", labelEn:"Visible notice cooldown (ms)" },',
      '      { key:"visibleNoticeMirrorDeleteMs", type:"int", default:600, labelZh:"镜像提示删除(ms)", labelEn:"Mirror notice delete delay (ms)" },',
      '      { key:"dcpPrunableToolsEnabled", type:"bool", default:true, labelZh:"注入可裁剪工具列表", labelEn:"Inject <prunable-tools>" },',
      '      { key:"dcpMessageIdTagsEnabled", type:"bool", default:false, labelZh:"注入消息ID标签", labelEn:"Inject message-id tags" },',
      '      { key:"injectGlobalPrefsOnSessionStart", type:"bool", default:true, labelZh:"会话开始注入全局偏好", labelEn:"Inject global prefs on session start" },',
      '      { key:"injectMemoryDocsEnabled", type:"bool", default:false, labelZh:"注入记忆文档", labelEn:"Inject memory docs" },',
      '      { key:"systemPromptAuditEnabled", type:"bool", default:true, labelZh:"保存系统层审计", labelEn:"Store system-layer audit" },',
      '      { key:"currentSummaryEvery", type:"int", default:5, labelZh:"当前会话摘要注入间隔(用户消息数)", labelEn:"Current summary interval (user messages)" },',
      '      { key:"currentSummaryTokenBudget", type:"int", default:500, labelZh:"当前会话摘要预算(token)", labelEn:"Current summary budget (tokens)" },',
      '      { key:"currentSummaryMaxChars", type:"int", default:2200, labelZh:"当前会话摘要最大字符", labelEn:"Current summary max chars" },',
      '      { key:"currentSummaryMaxEvents", type:"int", default:6, labelZh:"当前会话摘要最大事件数", labelEn:"Current summary max events" },',
      '      { key:"systemPromptAuditMaxChars", type:"int", default:12000, labelZh:"系统层审计最大字符", labelEn:"System-layer audit max chars" },',
      '      { key:"recallEnabled", type:"bool", default:true, labelZh:"启用跨会话召回", labelEn:"Enable cross-session recall" },',
      '      { key:"recallTokenBudget", type:"int", default:450, labelZh:"跨会话召回预算(token)", labelEn:"Recall budget (tokens)" },',
      '      { key:"recallMaxChars", type:"int", default:1800, labelZh:"跨会话召回最大字符", labelEn:"Recall max chars" },',
      '      { key:"recallTopSessions", type:"int", default:2, labelZh:"跨会话召回会话数", labelEn:"Recall top sessions" },',
      '      { key:"recallMaxEventsPerSession", type:"int", default:4, labelZh:"每会话召回事件数", labelEn:"Recall events per session" },',
      '      { key:"recallCooldownMs", type:"int", default:0, labelZh:"跨会话召回冷却(ms)", labelEn:"Recall cooldown (ms)" }',
      '    ];',
      '    const LLM_SCHEMA = [',
      '      { key:"llmSummaryMode", type:"enum", default:"auto", options:["auto","session","independent"], labelZh:"LLM总结模式", labelEn:"LLM summary mode" },',
      '      { key:"independentLlmEnabled", type:"bool", default:false, labelZh:"启用独立LLM总结", labelEn:"Enable independent LLM summary" },',
      '      { key:"independentLlmProvider", type:"enum", default:"openai_compatible", options:["openai_compatible","gemini","anthropic"], labelZh:"Provider", labelEn:"Provider" },',
      '      { key:"independentLlmBaseURL", type:"string", default:"", labelZh:"Base URL", labelEn:"Base URL" },',
      '      { key:"independentLlmApiKey", type:"string", default:"", labelZh:"API Key", labelEn:"API Key" },',
      '      { key:"independentLlmModel", type:"string", default:"", labelZh:"模型名", labelEn:"Model" },',
      '      { key:"independentLlmUseSessionModel", type:"bool", default:true, labelZh:"模型为空时跟随当前会话模型", labelEn:"Use session model when model empty" },',
      '      { key:"independentLlmTimeoutMs", type:"int", default:30000, labelZh:"请求超时(ms)", labelEn:"Timeout (ms)" },',
      '      { key:"independentLlmMaxTokens", type:"int", default:420, labelZh:"输出上限(token)", labelEn:"Max output tokens" },',
      '      { key:"independentLlmTemperature", type:"float", default:0.2, step:"0.01", labelZh:"温度", labelEn:"Temperature" }',
      '    ];',
      '    const SETTINGS_HELP = {',
      '      sendPretrimEnabled:{zh:"是否在每次发送给模型前自动做上下文瘦身。关闭后不做自动省token。",en:"Enable automatic context slimming before each send."},',
      '      sendPretrimWarmupEnabled:{zh:"在上一轮后后台预生成候选总结，减少下一次发送等待。",en:"Prepare candidate summary in background after previous turn to reduce next-send latency."},',
      '      sendPretrimBudget:{zh:"正文一旦超过这条线，就开始自动瘦身。你可以把它理解成“开始动刀的门槛”。",en:"Budget line that triggers pretrim when body estimate exceeds it."},',
      '      sendPretrimTarget:{zh:"开始瘦身后，插件会尽量把正文压到这个值附近。你可以把它理解成“希望压到多短”。",en:"Target token level after trimming."},',
      '      sendPretrimHardRatio:{zh:"硬阈值比例，越高越保守，越低越激进。",en:"Hard limit ratio: higher is more conservative."},',
      '      sendPretrimDistillTriggerRatio:{zh:"机械裁剪后仍超阈值时，达到该比例会进入LLM总结替换。",en:"After mechanical trim, this ratio triggers LLM-summary replacement."},',
      '      dcpCompatMode:{zh:"开启后：先机械裁剪；仍超阈值再做LLM总结。独立LLM未启用时走内联LLM。",en:"When on: mechanical first, then LLM summary if still over threshold; inline LLM is used unless independent LLM is enabled."},',
      '      sendPretrimTurnProtection:{zh:"保护最近 N 条你的消息对应的近轮上下文，优先不动这些内容。不是按总消息条数算。",en:"Protection window by last N user messages (not total message items)."},',
      '      sendPretrimMaxRewriteMessages:{zh:"单次最多重写多少条旧消息。",en:"Max historical messages rewritten in one pass."},',
      '      distillSummaryMaxChars:{zh:"单个LLM总结块允许的最大长度。",en:"Max chars for one LLM-summary block."},',
      '      distillInputMaxChars:{zh:"用于LLM总结的输入上限，防止过长导致慢或失败。",en:"Max input chars fed into LLM summary."},',
      '      distillRangeMinMessages:{zh:"LLM总结至少覆盖多少条旧消息。",en:"Minimum messages included in one distill range."},',
      '      distillRangeMaxMessages:{zh:"LLM总结最多覆盖多少条旧消息。",en:"Maximum messages included in one distill range."},',
      '      strategyPurgeErrorTurns:{zh:"错误工具调用在多少轮后可被清理。",en:"Error tool outputs become purgeable after N turns."},',
      '      maxEventsPerSession:{zh:"单会话保留的事件上限，超过会自动淘汰更旧条目。",en:"Max retained events per session file."},',
      '      summaryTriggerEvents:{zh:"累计到多少事件后自动做会话摘要压缩。",en:"Event count threshold for auto session summary."},',
      '      summaryKeepRecentEvents:{zh:"自动摘要时保留最近事件不压缩。",en:"Recent events kept uncompressed during summary."},',
      '      summaryMaxChars:{zh:"会话压缩摘要最大长度。",en:"Max chars for session compressed summary."},',
      '      summaryMaxCharsBudgetMode:{zh:"预算紧张时摘要上限。",en:"Summary max chars under budget pressure."},',
      '      discardMaxRemovalsPerPass:{zh:"每轮最多删除多少低信号工具输出。",en:"Max low-signal removals per pruning pass."},',
      '      extractEventsPerPass:{zh:"每轮最多提取多少事件进入摘要块。",en:"Max extracted events per pass into summary block."},',
      '      visibleNoticesEnabled:{zh:"是否在会话中显示可见提示。",en:"Show visible in-chat notices."},',
      '      notificationMode:{zh:"通知展示模式：关闭/简洁/详细。仅影响可见提示，不影响裁剪本身。",en:"Notification display mode: off/minimal/detailed. Affects visibility only."},',
      '      visibleNoticeForDiscard:{zh:"是否显示“已裁剪”提示。",en:"Show notices for discard actions."},',
      '      visibleNoticeCurrentSummaryMirrorEnabled:{zh:"当前会话摘要注入时，同时写入一个可见的短暂提示消息，再自动删除，用于弥补 Web toast 不可见。",en:"When current-summary injects, also mirror a short-lived visible message and auto-delete it to cover Web toast gaps."},',
      '      visibleNoticeCooldownMs:{zh:"可见提示冷却时间，避免刷屏。",en:"Cooldown for visible notices."},',
      '      visibleNoticeMirrorDeleteMs:{zh:"镜像提示保留多久后自动删除。",en:"How long mirrored notices stay visible before auto-delete."},',
      '      dcpPrunableToolsEnabled:{zh:"发送前注入 <prunable-tools> 列表，便于后续精确裁剪。",en:"Inject <prunable-tools> context before send."},',
      '      dcpMessageIdTagsEnabled:{zh:"发送前注入 message-id 标签。开启后token会增加。",en:"Inject message-id tags before send (adds tokens)."},',
      '      injectGlobalPrefsOnSessionStart:{zh:"新会话首条消息后自动注入全局偏好。",en:"Inject global preferences at session start."},',
      '      injectMemoryDocsEnabled:{zh:"是否额外注入一段记忆工具说明。平时一般不用开。",en:"Inject memory-doc helper block."},',
      '      systemPromptAuditEnabled:{zh:"开启后，插件会把最近一次真正发给模型的系统层文本保存下来，供 37777 页面排查到底是 MCP、skill 还是插件在干扰。现在默认开启。旧会话不会自动补历史，需在该会话里再发一条消息才会出现正文。",en:"Store the last real system-layer text sent to the model for dashboard debugging. Enabled by default for new captures; older sessions need one new message to populate text."},',
      '      currentSummaryEvery:{zh:"每收到多少条你的新消息，就自动补一张“本会话重点提醒卡”。",en:"Inject current-session summary every N user messages."},',
      '      currentSummaryTokenBudget:{zh:"当前会话摘要注入预算。",en:"Token budget for current-session summary injection."},',
      '      currentSummaryMaxChars:{zh:"当前会话摘要最大字符数。",en:"Max chars of current-session summary."},',
      '      currentSummaryMaxEvents:{zh:"当前会话摘要最多纳入的事件数。",en:"Max events included in current-session summary."},',
      '      systemPromptAuditMaxChars:{zh:"调试模式下，系统层原文最多保存多少字符。只影响调试展示，不影响真正发送。",en:"Max stored chars for system-layer audit text."},',
      '      recallEnabled:{zh:"是否启用跨会话召回。",en:"Enable cross-session recall."},',
      '      recallTokenBudget:{zh:"跨会话召回注入预算。",en:"Token budget for recall injection."},',
      '      recallMaxChars:{zh:"跨会话召回文本最大字符数。",en:"Max chars of recall text."},',
      '      recallTopSessions:{zh:"一次最多翻几个旧会话来找答案。",en:"How many top sessions to recall from."},',
      '      recallMaxEventsPerSession:{zh:"每个旧会话最多带多少条重点进当前对话。",en:"Max events per recalled session."},',
      '      recallCooldownMs:{zh:"同类召回触发冷却时间。",en:"Cooldown for repeated recall triggers."}',
      '    };',
      '    const LLM_HELP = {',
      '      llmSummaryMode:{zh:"auto=先机械裁剪，若仍超阈值则独立LLM(已启用)否则内联LLM；session=仅内联LLM；independent=仅独立LLM。",en:"auto=mechanical first, then independent(if enabled) else inline LLM; session=inline only; independent=independent only."},',
      '      independentLlmEnabled:{zh:"开启后允许调用独立LLM执行发送前LLM总结。",en:"Allow independent LLM for send-time summary."},',
      '      independentLlmProvider:{zh:"独立LLM提供商协议类型。",en:"Protocol/provider for independent LLM."},',
      '      independentLlmBaseURL:{zh:"独立LLM接口地址。OpenAI兼容通常填 .../v1。",en:"Base URL for independent LLM endpoint."},',
      '      independentLlmApiKey:{zh:"独立LLM密钥。仅本地保存到 ~/.opencode/memory/config.json。",en:"API key stored locally in ~/.opencode/memory/config.json."},',
      '      independentLlmModel:{zh:"独立LLM模型名。留空时可按下面开关跟随当前会话模型。",en:"Model id. Leave empty to use current session model if enabled."},',
      '      independentLlmUseSessionModel:{zh:"当上面模型名为空时，是否跟随当前会话模型。",en:"Use active session model when model is empty."},',
      '      independentLlmTimeoutMs:{zh:"独立LLM请求超时。",en:"Request timeout for independent LLM."},',
      '      independentLlmMaxTokens:{zh:"独立LLM单次总结输出上限。",en:"Max output tokens for one summary call."},',
      '      independentLlmTemperature:{zh:"独立LLM温度。",en:"Temperature for independent LLM summary."}',
      '    };',
      '    const I18N = { zh:{title:"记忆看板",lang:"语言",global:"全局偏好",token:"Token 估算为近似值（chars/4）",generatedLabel:"生成时间",noProjectSelected:"未选择项目",noGlobalPrefs:"暂无全局偏好",noEvents:"暂无事件",compressedSummary:"压缩摘要",compressedBlocks:"压缩块",pretrimTraces:"发送前裁剪轨迹（最近 8 条）",edit:"编辑摘要",del:"删除会话",nos:"暂无会话",noproj:"暂无项目记忆",save:"保存",cancel:"取消",sessions:"会话",tabSessions:"会话页",tabSettings:"参数页",tabLlm:"LLM设置",tabTrash:"回收站",trashTitle:"回收站",trashNone:"暂无回收站条目",trashDelete:"永久删除",trashCleanup:"立即清理过期",trashRetentionLabel:"保留天数",batchDelete:"批量删除",batchSelectFirst:"请先勾选要删除的会话",batchDeleteConfirm:"批量删除 {n} 个会话记忆？将写入审计日志。",pretrimProfileLabel:"裁剪档位",pretrimConservative:"保守（约20%，细节保留优先）",pretrimBalanced:"平衡（约40%，推荐）",pretrimAggressive:"激进（约60%，最强裁剪）",pretrimSave:"保存并立即生效",pretrimCurrent:"当前档位：",pretrimSaved:"已保存，下一次发送前裁剪立即按该档位生效。",cleanGlobalNote:"清洗 note",cleanGlobalNoteDone:"note 已清洗并重新编号。",settingsTitle:"记忆系统设置",settingsHint:"可视化调节关键机制，保存到本地并持久化。",settingsSave:"保存设置",settingsSaved:"设置已保存，后续请求自动生效。",globalPrefsFoldSummary:"全局偏好设置",metricProjects:"项目数",metricSessions:"会话数",metricEvents:"事件数",projectMetaFmt:"会话={sessions} · 事件={events} · 技术栈={tech}",projectListMetaFmt:"会话={sessions} · 事件={events}",sessionStatPrune:"修剪",sessionStatPretrim:"发送前裁剪",sessionStatSaved:"节省",sessionStatBlocks:"压缩块",sessionStatBody:"正文约",sessionStatSystem:"system约",sessionStatTotal:"总量约(正文+system)",sessionStatBudget:"预算",sessionStatTarget:"目标",sessionStatPretrimLast:"最近发送前裁剪",settingsSendPretrimEnabled:"发送前自动裁剪",settingsSendPretrimBudget:"发送前裁剪预算(token)",settingsSendPretrimTarget:"发送前裁剪目标(token)",settingsVisibleNoticesEnabled:"可见提示",settingsVisibleNoticeForDiscard:"显示裁剪提示",settingsNotificationMode:"通知模式",settingsDcpPrunableToolsEnabled:"注入可裁剪工具列表",settingsDcpMessageIdTagsEnabled:"注入消息ID标签",settingsInjectGlobalPrefsOnSessionStart:"会话开始注入全局偏好",settingsInjectMemoryDocsEnabled:"注入记忆文档",settingsRecallEnabled:"启用跨会话召回",settingsCurrentSummaryEvery:"当前会话摘要注入间隔(用户消息数)",settingsCurrentSummaryTokenBudget:"当前会话摘要预算(token)",settingsRecallTokenBudget:"跨会话召回预算(token)",settingsRecallTopSessions:"跨会话召回会话数",settingsRecallMaxEventsPerSession:"每会话召回事件数",settingsRecallCooldownMs:"跨会话召回冷却(ms)",settingsVisibleNoticeCooldownMs:"可见提示冷却(ms)",llmTitle:"LLM设置",llmHint:"内联与独立LLM总结参数。保存后立即生效。",llmSave:"保存LLM配置",llmSaved:"LLM配置已保存，后续请求立即生效。",llmFetchModels:"自动获取模型",llmValidate:"验证配置",llmModelsLoaded:"模型列表已更新",llmValidateOk:"验证成功，可用于LLM总结",llmQuickTitle:"独立LLM总结（快捷查看）",llmQuickHint:"当前配置摘要。可在此确认是否启用独立LLM，点击按钮进入完整配置。",llmQuickModeLabel:"模式",llmQuickProviderLabel:"Provider",llmQuickModelLabel:"Model",llmQuickBaseLabel:"BaseURL",llmQuickGo:"打开独立LLM配置页"}, en:{title:"Memory Dashboard",lang:"Language",global:"Global Preferences",token:"Token estimate is approximate (chars/4).",generatedLabel:"Generated",noProjectSelected:"No project selected",noGlobalPrefs:"No global preferences.",noEvents:"No events.",compressedSummary:"compressed summary",compressedBlocks:"compressed blocks",pretrimTraces:"pretrim traces (latest 8)",edit:"Edit summary",del:"Delete session",nos:"No sessions.",noproj:"No project memory yet.",save:"Save",cancel:"Cancel",sessions:"Sessions",tabSessions:"Sessions",tabSettings:"Settings",tabLlm:"LLM Settings",tabTrash:"Trash",trashTitle:"Trash",trashNone:"No trash entries",trashDelete:"Delete Permanently",trashCleanup:"Cleanup Expired",trashRetentionLabel:"Retention Days",batchDelete:"Batch Delete",batchSelectFirst:"Select sessions first",batchDeleteConfirm:"Batch delete {n} session memories? This writes audit logs.",pretrimProfileLabel:"Pretrim Profile",pretrimConservative:"Conservative (~20%, preserve detail)",pretrimBalanced:"Balanced (~40%, recommended)",pretrimAggressive:"Aggressive (~60%, strongest trim)",pretrimSave:"Save (effective next send)",pretrimCurrent:"Current profile: ",pretrimSaved:"Saved. Effective for next send pretrim.",cleanGlobalNote:"Clean note",cleanGlobalNoteDone:"Note cleaned and renumbered.",settingsTitle:"Memory System Settings",settingsHint:"Tune runtime behaviors with persistent local config.",settingsSave:"Save Settings",settingsSaved:"Settings saved. Effective for next requests.",globalPrefsFoldSummary:"Global Preferences",metricProjects:"Projects",metricSessions:"Sessions",metricEvents:"Events",projectMetaFmt:"sessions={sessions} · events={events} · tech={tech}",projectListMetaFmt:"sessions={sessions} · events={events}",sessionStatPrune:"prune",sessionStatPretrim:"pretrim",sessionStatSaved:"saved",sessionStatBlocks:"blocks",sessionStatBody:"body~",sessionStatSystem:"system~",sessionStatTotal:"total~(body+system)",sessionStatBudget:"budget",sessionStatTarget:"target",sessionStatPretrimLast:"last pretrim",settingsSendPretrimEnabled:"Send-time auto pretrim",settingsSendPretrimBudget:"Send pretrim budget (tokens)",settingsSendPretrimTarget:"Send pretrim target (tokens)",settingsVisibleNoticesEnabled:"Visible notices",settingsVisibleNoticeForDiscard:"Show discard notices",settingsNotificationMode:"Notification mode",settingsDcpPrunableToolsEnabled:"Inject <prunable-tools>",settingsDcpMessageIdTagsEnabled:"Inject message-id tags",settingsInjectGlobalPrefsOnSessionStart:"Inject global prefs on session start",settingsInjectMemoryDocsEnabled:"Inject memory docs",settingsRecallEnabled:"Enable cross-session recall",settingsCurrentSummaryEvery:"Current summary interval (user messages)",settingsCurrentSummaryTokenBudget:"Current summary budget (tokens)",settingsRecallTokenBudget:"Recall budget (tokens)",settingsRecallTopSessions:"Recall top sessions",settingsRecallMaxEventsPerSession:"Recall events per session",settingsRecallCooldownMs:"Recall cooldown (ms)",settingsVisibleNoticeCooldownMs:"Visible notice cooldown (ms)",llmTitle:"LLM Settings",llmHint:"Inline and independent LLM summary settings. Effective immediately after save.",llmSave:"Save LLM Config",llmSaved:"LLM config saved and effective for next requests.",llmFetchModels:"Fetch Models",llmValidate:"Validate Config",llmModelsLoaded:"Model list updated",llmValidateOk:"Validation succeeded",llmQuickTitle:"Independent LLM Summary (Quick View)",llmQuickHint:"Snapshot of current config. Click to open full LLM settings.",llmQuickModeLabel:"Mode",llmQuickProviderLabel:"Provider",llmQuickModelLabel:"Model",llmQuickBaseLabel:"BaseURL",llmQuickGo:"Open Full LLM Settings"} };',
      '    I18N.zh.tabTemplate = "摘要模板设置"; I18N.en.tabTemplate = "Template";',
      '    I18N.zh.templateTitle = "摘要模板设置"; I18N.en.templateTitle = "Template Settings";',
      '    I18N.zh.templateHint = "用于机械裁剪/LLM总结的输出格式，不是页面模板。保存后立即生效并持久化。"; I18N.en.templateHint = "Used for mechanical trim/LLM summary output format, not the dashboard page template.";',
      '    I18N.zh.templateFormatHint = "可用占位变量：{{window}} {{events}} {{status}} {{sessionCwd}} {{recommendedWorkdir}} {{relatedWorkdirs}} {{keyFacts}} {{taskGoal}} {{keyOutcomes}} {{toolsUsed}} {{skillsUsed}} {{keyFiles}} {{decisions}} {{blockers}} {{todoRisks}} {{nextActions}} {{workdirScoring}} {{handoffAnchor}}；示例(JSON)：{\\\"title\\\":\\\"{{status}}\\\",\\\"facts\\\":\\\"{{keyFacts}}\\\"}"; I18N.en.templateFormatHint = "Available placeholders: {{window}} {{events}} {{status}} {{sessionCwd}} {{recommendedWorkdir}} {{relatedWorkdirs}} {{keyFacts}} {{taskGoal}} {{keyOutcomes}} {{toolsUsed}} {{skillsUsed}} {{keyFiles}} {{decisions}} {{blockers}} {{todoRisks}} {{nextActions}} {{workdirScoring}} {{handoffAnchor}}; JSON example: {\\\"title\\\":\\\"{{status}}\\\",\\\"facts\\\":\\\"{{keyFacts}}\\\"}";',
      '    I18N.zh.templateSave = "按名称保存模板"; I18N.en.templateSave = "Save Template by Name";',
      '    I18N.zh.templateUse = "设为当前模板"; I18N.en.templateUse = "Use Selected Template";',
      '    I18N.zh.templateNameLabel = "模板名称"; I18N.en.templateNameLabel = "Template Name";',
      '    I18N.zh.templateSelectLabel = "已保存模板"; I18N.en.templateSelectLabel = "Saved Templates";',
      '    I18N.zh.templateReset = "恢复默认模板"; I18N.en.templateReset = "Restore Default";',
      '    I18N.zh.templatePreviewBtn = "预览当前模板"; I18N.en.templatePreviewBtn = "Preview Template";',
      '    I18N.zh.templateSaved = "模板已保存并立即生效"; I18N.en.templateSaved = "Template saved and effective immediately";',
      '    I18N.zh.templateResetOk = "已恢复默认模板并生效"; I18N.en.templateResetOk = "Default template restored and effective";',
      '    I18N.zh.llmSummaryMechanical = "机械裁剪"; I18N.en.llmSummaryMechanical = "Mechanical trim";',
      '    I18N.zh.llmSummaryInline = "LLM总结(内联)"; I18N.en.llmSummaryInline = "LLM summary (inline)";',
      '    I18N.zh.llmSummaryIndependent = "LLM总结(独立)"; I18N.en.llmSummaryIndependent = "LLM summary (independent)";',
      '    I18N.zh.llmSummaryCache = "LLM总结(缓存)"; I18N.en.llmSummaryCache = "LLM summary (cache)";',
      '    I18N.zh.llmSummaryFailed = "LLM总结失败"; I18N.en.llmSummaryFailed = "LLM summary failed";',
      '    I18N.zh.toggleFoldSummary = "开关参数（默认展开）"; I18N.en.toggleFoldSummary = "Toggle Params (default open)";',
      '    I18N.zh.numericFoldSummary = "数值参数（默认展开）"; I18N.en.numericFoldSummary = "Numeric Params (default open)";',
      '    I18N.zh.selectAll = "全选"; I18N.en.selectAll = "Select all";',
      '    I18N.zh.selectNone = "全不选"; I18N.en.selectNone = "Clear";',
      '    I18N.zh.systemAuditHint = "展开某个会话后，在“发送前系统层审计”卡片里查看最近一次真正发给模型的 system 文本。"; I18N.en.systemAuditHint = "Open a session to inspect the latest real system-layer text in the send-time system audit card.";',
      '    I18N.zh.connPending = "连接中"; I18N.en.connPending = "Connecting";',
      '    I18N.zh.connOk = "已连接"; I18N.en.connOk = "Connected";',
      '    I18N.zh.connBad = "已断开"; I18N.en.connBad = "Disconnected";',
      '    I18N.zh.systemAuditCard = "发送前系统层审计"; I18N.en.systemAuditCard = "send-time system audit";',
      '    I18N.zh.systemAuditEmpty = "本会话还没抓到 system 原文，先再发一条消息试试"; I18N.en.systemAuditEmpty = "no system prompt text captured for this session yet; send one more message to capture it";',
      '    I18N.zh.systemAuditDisabled = "系统层审计当前是关闭的，请到参数页打开"; I18N.en.systemAuditDisabled = "system-layer audit is disabled; enable it in settings";',
      '    I18N.zh.sessionStatInject = "注入"; I18N.en.sessionStatInject = "inject";',
      '    I18N.zh.sessionStatLastInject = "最近注入"; I18N.en.sessionStatLastInject = "last inject";',
      '    I18N.zh.sessionStatWarmup = "预热"; I18N.en.sessionStatWarmup = "warmup";',
      '    I18N.zh.sessionStatBound = "绑定"; I18N.en.sessionStatBound = "bind";',
      '    I18N.zh.sessionStatWarmupStatus = "预热状态"; I18N.en.sessionStatWarmupStatus = "warmup status";',
      '    I18N.zh.sessionStatPluginHint = "插件附加约"; I18N.en.sessionStatPluginHint = "plugin-hint~";',
      '    I18N.zh.sessionWarmupLogs = "预热日志"; I18N.en.sessionWarmupLogs = "warmup logs";',
      '    I18N.zh.autoLabel = "自动"; I18N.en.autoLabel = "auto";',
      '    I18N.zh.manualLabel = "手动"; I18N.en.manualLabel = "manual";',
      '    I18N.zh.tokensLabel = "tokens"; I18N.en.tokensLabel = "tokens";',
      '    I18N.zh.none = "无"; I18N.en.none = "none";',
      '    I18N.zh.injectReasonNone = "无"; I18N.en.injectReasonNone = "none";',
      '    I18N.zh.injectReasonGlobal = "全局偏好注入"; I18N.en.injectReasonGlobal = "global prefs inject";',
      '    I18N.zh.injectReasonCurrent = "当前会话摘要注入"; I18N.en.injectReasonCurrent = "current summary inject";',
      '    I18N.zh.injectReasonRecall = "跨会话召回注入"; I18N.en.injectReasonRecall = "cross-session recall inject";',
      '    I18N.zh.injectReasonDocs = "记忆文档注入"; I18N.en.injectReasonDocs = "memory docs inject";',
      '    I18N.zh.injectReasonManual = "手动注入"; I18N.en.injectReasonManual = "manual inject";',
      '    I18N.zh.sessionStatRiskStack = "风险:上下文叠加疑似"; I18N.en.sessionStatRiskStack = "risk: context stacking suspected";',
      '    I18N.zh.sessionStatRiskSystem = "风险:system开销过高"; I18N.en.sessionStatRiskSystem = "risk: high system token overhead";',
      '    function normalizeLang(v){ const s=String(v||"").trim().toLowerCase(); return (s==="zh"||s==="en")?s:"zh"; }',
      '    let LANG = normalizeLang(localStorage.getItem("memory_dashboard_lang") || "zh");',
      '    const __selectedSessionIDs = new Set();',
      '    const __trashSelectedPaths = new Set();',
      '    let __trashData = { retentionDays:30, entries:[] };',
      '    let __activeProjectName = "";',
      '    let __templateEditorDirty = false;',
      '    const DEFAULT_SUMMARY_TEMPLATE = `## Structured Session Summary\\n- window: {{window}} · events={{events}}\\n- status: {{status}}\\n- workspace: session_cwd={{sessionCwd}} · recommended_workdir={{recommendedWorkdir}}\\n- related_workdirs:\\n{{relatedWorkdirs}}\\n- key facts:\\n{{keyFacts}}\\n- task goal:\\n{{taskGoal}}\\n- key outcomes:\\n{{keyOutcomes}}\\n- tools used:\\n{{toolsUsed}}\\n- skills used:\\n{{skillsUsed}}\\n- key files:\\n{{keyFiles}}\\n- decisions/constraints:\\n{{decisions}}\\n- blockers:\\n{{blockers}}\\n- todo/risks:\\n{{todoRisks}}\\n- next actions:\\n{{nextActions}}\\n- workdir scoring:\\n{{workdirScoring}}\\n- handoff anchor:\\n{{handoffAnchor}}`; ',
      '    function updateBatchDeleteBtn(){ const b=$("batchDeleteBtn"); if(!b) return; const n=__selectedSessionIDs.size; const base=t("batchDelete"); b.textContent=n>0?(base+"("+n+")"):base; b.disabled=n===0; }',
      '    function updateTrashDeleteBtn(){ const b=$("trashDeleteBtn"); if(!b) return; const n=__trashSelectedPaths.size; b.textContent=t("trashDelete")+"(" + n + ")"; b.disabled=n===0; }',
      '    function selectAllSessions(){ const project=(DATA.projects||[]).find((p)=>String(p.name||"")===String(__activeProjectName||"")); __selectedSessionIDs.clear(); (((project&&project.sessions)||[])).forEach((s)=>{ if(s&&s.sessionID) __selectedSessionIDs.add(String(s.sessionID)); }); renderSessions(project||null); updateBatchDeleteBtn(); }',
      '    function clearSelectedSessions(){ __selectedSessionIDs.clear(); const project=(DATA.projects||[]).find((p)=>String(p.name||"")===String(__activeProjectName||"")); renderSessions(project||null); updateBatchDeleteBtn(); }',
      '    function selectAllTrash(){ __trashSelectedPaths.clear(); (((__trashData&&__trashData.entries)||[])).forEach((e)=>{ if(e&&e.path) __trashSelectedPaths.add(String(e.path)); }); renderTrash(); }',
      '    function clearSelectedTrash(){ __trashSelectedPaths.clear(); renderTrash(); }',
      '    function t(k){ return (I18N[LANG]&&I18N[LANG][k]) || (I18N.en&&I18N.en[k]) || k; }',
      '    function setConnectionBadge(state){ const el=$("connBadge"); if(!el) return; el.classList.remove("ok","pending","bad"); if(state==="ok"){ el.classList.add("ok"); el.textContent=t("connOk"); return; } if(state==="bad"){ el.classList.add("bad"); el.textContent=t("connBad"); return; } el.classList.add("pending"); el.textContent=t("connPending"); }',
      '    let __activeTab = "sessions";',
      '    function setActiveTab(tab){ __activeTab=tab; const maps=[["sessions",tabSessionsBtn,paneSessions],["template",tabTemplateBtn,paneTemplate],["llm",tabLlmBtn,paneLlm],["settings",tabSettingsBtn,paneSettings],["trash",tabTrashBtn,paneTrash]]; maps.forEach(([k,b,p])=>{ if(b) b.classList.toggle("active",k===tab); if(p) p.classList.toggle("active",k===tab); }); }',
      '    function updateMetrics(){',
      '      const gen = DATA && DATA.generatedAt ? new Date(DATA.generatedAt).toLocaleString() : "-";',
      '      $("genAt").textContent = t("generatedLabel") + ": " + gen;',
      '      const s = (DATA && DATA.summary) || {projectCount:0,sessionCount:0,eventCount:0};',
      '      $("mProjects").textContent = s.projectCount || 0;',
      '      $("mSessions").textContent = s.sessionCount || 0;',
      '      $("mEvents").textContent = s.eventCount || 0;',
      '    }',
      '    let __lastRefreshAt = 0;',
      '    async function apiFetch(path, opts){',
      '      const p=String(path||"");',
      '      if(location&&location.protocol==="file:"){ throw new Error("dashboard_opened_as_file"); }',
      '      return await fetch(p, opts||{});',
      '    }',
      '    async function refreshDashboardData(){',
      '      setConnectionBadge("pending");',
      '      try {',
      '        const r = await apiFetch("/api/dashboard", { cache: "no-store" });',
      '        if (r.ok) { DATA = await r.json(); __lastRefreshAt = Date.now(); setConnectionBadge("ok"); }',
      '        else { setConnectionBadge("bad"); }',
      '      } catch (_) { setConnectionBadge("bad"); }',
      '      updateMetrics();',
      '      renderSettings();',
      '      renderTemplateSettings();',
      '      renderLlmSettings();',
      '      renderGlobalPrefs();',
      '      renderProjects();',
      '      await refreshTrashData();',
      '    }',
      '    async function apiPost(url,payload){ try{ const r=await apiFetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); if(!r.ok) throw new Error(await r.text()); return r.json(); }catch(e){ const msg=String(e&&e.message?e.message:e||""); if(/Failed to fetch/i.test(msg)) throw new Error("37777 面板连接已断开，请刷新页面；如果还不行，重启 opencode web"); throw e; } }',
      '    async function refreshTrashData(){ try{ const r=await apiFetch("/api/memory/trash",{cache:"no-store"}); if(r.ok){ __trashData=await r.json(); } }catch(_){ } renderTrash(); }',
      '    function renderTrash(){ const list=$("trashList"); const meta=$("trashMeta"); const sel=$("trashRetentionSel"); if(!list||!meta||!sel) return; const entries=Array.isArray(__trashData.entries)?__trashData.entries:[]; const keep=Number(__trashData.retentionDays||30); sel.value=String(keep); meta.textContent=(LANG==="en"?("Retention "+keep+" days · entries="+entries.length):("保留 "+keep+" 天 · 条目="+entries.length)); if(!entries.length){ list.className="empty"; list.textContent=t("trashNone"); __trashSelectedPaths.clear(); updateTrashDeleteBtn(); return; } list.className=""; list.innerHTML=""; entries.forEach((e)=>{ const row=document.createElement("div"); row.className="trash-row"; const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=__trashSelectedPaths.has(e.path||""); cb.addEventListener("change",(ev)=>{ if(ev.target.checked) __trashSelectedPaths.add(e.path||""); else __trashSelectedPaths.delete(e.path||""); updateTrashDeleteBtn(); }); const box=document.createElement("div"); box.style.display="flex"; box.style.flexDirection="column"; box.style.gap="4px"; const m1=document.createElement("div"); m1.className="meta"; m1.textContent=(e.projectName||"-")+" · "+(e.fileName||"-")+" · "+new Date(e.mtime||Date.now()).toLocaleString()+" · "+(e.size||0)+" bytes"; const m2=document.createElement("div"); m2.className="path"; m2.textContent=e.path||""; box.appendChild(m1); box.appendChild(m2); row.appendChild(cb); row.appendChild(box); list.appendChild(row); }); updateTrashDeleteBtn(); }',
      '    async function cleanupTrashNow(){ const sel=$("trashRetentionSel"); const days=Number(sel&&sel.value||30); if(!window.confirm((LANG==="en"?"Cleanup expired trash with retention ":"按保留期清理过期回收站条目：")+days+(LANG==="en"?" days?":" 天？"))) return; try{ await apiPost("/api/memory/trash/cleanup",{days,confirm:true,source:"dashboard"}); __trashSelectedPaths.clear(); await refreshTrashData(); }catch(e){ alert("Trash cleanup failed: "+e.message);} }',
      '    async function deleteTrashSelected(){ const entries=[...__trashSelectedPaths].filter(Boolean); if(!entries.length) return; if(!window.confirm((LANG==="en"?"Delete selected trash entries permanently? ":"永久删除所选回收站条目？ ")+entries.length)) return; try{ await apiPost("/api/memory/trash/delete",{confirm:true,entries,source:"dashboard"}); __trashSelectedPaths.clear(); await refreshTrashData(); }catch(e){ alert("Trash delete failed: "+e.message);} }',
      '    function normalizePretrimProfile(v){ const s=String(v||"").trim().toLowerCase(); if(["conservative","balanced","aggressive"].includes(s)) return s; return "balanced"; }',
      '    function updatePretrimProfileUi(){ const prefs=(DATA&&DATA.global&&DATA.global.preferences)||{}; const v=normalizePretrimProfile(prefs.pretrimProfile||prefs.pretrim_profile||"balanced"); if(pretrimProfileSel) pretrimProfileSel.value=v; const label=(v==="conservative")?t("pretrimConservative"):(v==="aggressive")?t("pretrimAggressive"):t("pretrimBalanced"); if(pretrimProfileHint) pretrimProfileHint.textContent=t("pretrimCurrent")+label; }',
      '    async function savePretrimProfile(){ if(!pretrimProfileSel) return; const v=normalizePretrimProfile(pretrimProfileSel.value); try{ await apiPost("/api/memory/global/preferences",{key:"pretrimProfile",value:v,confirm:true,source:"dashboard"}); if(pretrimProfileHint) pretrimProfileHint.textContent=t("pretrimSaved"); await refreshDashboardData(); }catch(e){ alert("Save profile failed: "+e.message);} }',
      '    async function cleanGlobalNote(){ try{ await apiPost("/api/memory/global/note/clean",{confirm:true,source:"dashboard"}); if(pretrimProfileHint) pretrimProfileHint.textContent=t("cleanGlobalNoteDone"); await refreshDashboardData(); }catch(e){ alert("Clean note failed: "+e.message);} }',
      '    function getSettingsMap(){ const s=(DATA&&DATA.settings&&DATA.settings.memorySystem)||{}; return (s&&typeof s==="object")?s:{}; }',
      '    function toBool(v, d){ if(typeof v==="boolean") return v; const s=String(v||"").trim().toLowerCase(); if(["1","true","yes","on"].includes(s)) return true; if(["0","false","no","off"].includes(s)) return false; return d; }',
      '    function __settingPriority(k){ const p={ sendPretrimEnabled:1,dcpCompatMode:2,sendPretrimWarmupEnabled:3,sendPretrimBudget:4,sendPretrimTarget:5,sendPretrimDistillTriggerRatio:6,sendPretrimHardRatio:7,sendPretrimTurnProtection:8,sendPretrimMaxRewriteMessages:9,distillSummaryMaxChars:10,distillInputMaxChars:11,distillRangeMinMessages:12,distillRangeMaxMessages:13,recallEnabled:14,recallTokenBudget:15,recallTopSessions:16,recallMaxEventsPerSession:17,recallMaxChars:18,recallCooldownMs:19,currentSummaryEvery:20,currentSummaryTokenBudget:21,currentSummaryMaxChars:22,currentSummaryMaxEvents:23,injectGlobalPrefsOnSessionStart:24,injectMemoryDocsEnabled:25,systemPromptAuditEnabled:26,dcpPrunableToolsEnabled:27,dcpMessageIdTagsEnabled:28,visibleNoticesEnabled:29,notificationMode:30,visibleNoticeForDiscard:31,visibleNoticeCurrentSummaryMirrorEnabled:32,visibleNoticeCooldownMs:33,visibleNoticeMirrorDeleteMs:34,systemPromptAuditMaxChars:35,strategyPurgeErrorTurns:36,maxEventsPerSession:37,summaryTriggerEvents:38,summaryKeepRecentEvents:39,summaryMaxChars:40,summaryMaxCharsBudgetMode:41,discardMaxRemovalsPerPass:42,extractEventsPerPass:43 }; return Number(p[k]||999); }',
      '    function __renderSettingRow(it,map,targetForm){ const id="setting_"+it.key; const label=document.createElement("label"); label.htmlFor=id; label.style.fontSize="14px"; label.style.color="#111827"; label.style.fontWeight="600"; label.textContent=(LANG==="zh"?(it.labelZh||""):(it.labelEn||"")) || t("settings"+it.key.charAt(0)+it.key.slice(1)); let input; if(it.type==="enum"){ input=document.createElement("select"); const options=Array.isArray(it.options)?it.options:[]; const enumZh={off:"关闭",minimal:"简洁",detailed:"详细"}; options.forEach((opt)=>{ const o=document.createElement("option"); o.value=String(opt); o.textContent=LANG==="zh"?(enumZh[String(opt)]||String(opt)):String(opt); input.appendChild(o); }); input.value=String((map[it.key]!==undefined&&map[it.key]!==null)?map[it.key]:it.default); input.style.width="100%"; input.style.height="30px"; } else { input=document.createElement("input"); if(it.type==="bool"){ input.type="checkbox"; input.checked=toBool(map[it.key], Boolean(it.default)); input.style.justifySelf="start"; } else { input.type="number"; if(it.type==="float") input.step=String(it.step||"0.01"); input.value=String((map[it.key]!==undefined&&map[it.key]!==null)?map[it.key]:it.default); input.style.width="100%"; input.style.height="30px"; } } input.id=id; input.dataset.key=it.key;  targetForm.appendChild(label); targetForm.appendChild(input); const help=SETTINGS_HELP[it.key]||{}; const desc=document.createElement("div"); desc.className="sub"; desc.style.gridColumn="1 / span 2"; desc.style.margin="-2px 0 8px 0"; desc.style.fontSize="12px"; desc.style.color="#6b7280"; desc.textContent=(LANG==="zh"?(help.zh||""):(help.en||"")); targetForm.appendChild(desc); }',
      '    function __renderSettingsGroup(items,map,targetForm){ if(!items.length||!targetForm) return; items.forEach((it)=>__renderSettingRow(it,map,targetForm)); }',
      '    function renderSettings(){ const map=getSettingsMap(); if(settingsToggleForm) settingsToggleForm.innerHTML=""; if(settingsNumericForm) settingsNumericForm.innerHTML=""; const ordered=SETTINGS_SCHEMA.slice().sort((a,b)=>__settingPriority(a.key)-__settingPriority(b.key)); const toggles=ordered.filter((it)=>it.type==="bool"||it.type==="enum"); const numerics=ordered.filter((it)=>it.type==="int"||it.type==="float"); __renderSettingsGroup(toggles,map,settingsToggleForm); __renderSettingsGroup(numerics,map,settingsNumericForm); const tf=$("toggleFoldSummary"); if(tf) tf.textContent=t("toggleFoldSummary"); const nf=$("numericFoldSummary"); if(nf) nf.textContent=t("numericFoldSummary"); if(settingsHelpBody){ settingsHelpBody.innerHTML=""; } }',
      '    async function saveSettings(){ const patch={}; SETTINGS_SCHEMA.forEach((it)=>{ const el=$("setting_"+it.key); if(!el) return; if(it.type==="bool"){ patch[it.key]=Boolean(el.checked); return; } if(it.type==="enum"){ patch[it.key]=String(el.value||it.default||""); return; } const raw=String(el.value||it.default||0); patch[it.key]=(it.type==="float")?Number.parseFloat(raw):Number(raw); if(!Number.isFinite(patch[it.key])) patch[it.key]=it.default||0; }); try{ await apiPost("/api/memory/settings",{memorySystem:patch,confirm:true,source:"dashboard"}); if(settingsStatus) settingsStatus.textContent=t("settingsSaved"); await refreshDashboardData(); }catch(e){ alert("Save settings failed: "+e.message);} }',
      '    function getTemplateStore(){ const map=getSettingsMap(); const raw=(map&&typeof map.summaryTemplates==="object"&&map.summaryTemplates)?map.summaryTemplates:{}; const store={}; Object.entries(raw).forEach(([k,v])=>{ const key=String(k||"").trim(); const val=String(v||"").trim(); if(key&&val) store[key]=val; }); if(!Object.keys(store).length){ const legacy=String((map&&map.summaryTemplateText)||"").trim(); if(legacy) store.default=legacy; else store.default=DEFAULT_SUMMARY_TEMPLATE; } return store; }',
      '    function getActiveTemplateName(){ const map=getSettingsMap(); const n=String((map&&map.activeSummaryTemplateName)||"").trim(); return n||"default"; }',
      '    function getCurrentTemplateText(){ const store=getTemplateStore(); const active=getActiveTemplateName(); return String(store[active]||store.default||DEFAULT_SUMMARY_TEMPLATE); }',
      '    function getTemplateVarsSample(){ const p=(DATA&&Array.isArray(DATA.projects)&&DATA.projects.length)?DATA.projects[0]:null; const s=(p&&Array.isArray(p.sessions)&&p.sessions.length)?p.sessions[0]:null; const lines=(arr)=>Array.isArray(arr)&&arr.length?arr.map((x)=>`  - ${x}`).join("\\n"):"  - none"; return { window:new Date().toISOString(), events:`${s&&s.stats?((s.stats.userMessages||0)+(s.stats.assistantMessages||0)+(s.stats.toolResults||0)):0} (u=${s&&s.stats?s.stats.userMessages||0:0}, a=${s&&s.stats?s.stats.assistantMessages||0:0}, t=${s&&s.stats?s.stats.toolResults||0:0}, o=0)`, status:"in-progress", sessionCwd:(p&&p.name)||"N/A", recommendedWorkdir:(p&&p.name)||"N/A", relatedWorkdirs:lines([]), keyFacts:lines(["sample key fact"]), taskGoal:lines(["sample task goal"]), keyOutcomes:lines(["sample key outcome"]), toolsUsed:lines(["bash (2)","read (1)"]), skillsUsed:lines(["review-writing (1)"]), keyFiles:lines(["/path/to/file"]), decisions:lines(["sample decision"]), blockers:lines(["none"]), todoRisks:lines(["none"]), nextActions:lines(["continue from recommended_workdir"]), workdirScoring:lines(["/path · goal=1.0 result=1.0 intensity=1.0 continuity=1.0 convergence=1.0"]), handoffAnchor:lines(["Continue in recommended_workdir and verify outputs."]) }; }',
      '    function applyTemplateText(tpl, vars){ let out=String(tpl||""); Object.keys(vars||{}).forEach((k)=>{ const re=new RegExp(`\\\\{\\\\{${k}\\\\}\\\\}`,"g"); out=out.replace(re,String(vars[k]||"")); }); return out; }',
      '    function renderTemplateSettings(){ if(!templateEditor) return; const store=getTemplateStore(); const names=Object.keys(store); const active=getActiveTemplateName(); if(templateSelect){ templateSelect.innerHTML=""; names.forEach((n)=>{ const o=document.createElement("option"); o.value=n; o.textContent=n; templateSelect.appendChild(o); }); templateSelect.value=names.includes(active)?active:(names[0]||"default"); } if(templateNameInput&&!templateNameInput.value){ templateNameInput.value=templateSelect?String(templateSelect.value||active||"default"):(active||"default"); } const useName=(templateSelect&&templateSelect.value)?String(templateSelect.value):String(active||"default"); if(!__templateEditorDirty){ templateEditor.value=String(store[useName]||store.default||DEFAULT_SUMMARY_TEMPLATE); } if(templatePreview){ templatePreview.textContent=applyTemplateText(templateEditor.value,getTemplateVarsSample()); } }',
      '    async function saveTemplateSettings(){ if(!templateEditor) return; const name=String((templateNameInput&&templateNameInput.value)||"default").trim()||"default"; const text=String(templateEditor.value||"").trim(); const store=getTemplateStore(); store[name]=text||DEFAULT_SUMMARY_TEMPLATE; try{ await apiPost("/api/memory/settings",{memorySystem:{summaryTemplates:store,activeSummaryTemplateName:name,summaryTemplateText:store[name]},confirm:true,source:"dashboard"}); __templateEditorDirty=false; if(templateStatus){ templateStatus.textContent="✅ "+t("templateSaved"); templateStatus.style.color="#047857"; } await refreshDashboardData(); }catch(e){ if(templateStatus){ templateStatus.textContent="❌ "+String(e&&e.message?e.message:e); templateStatus.style.color="#b91c1c"; } } }',
      '    async function useTemplateSettings(){ const name=String((templateSelect&&templateSelect.value)||"default").trim()||"default"; const store=getTemplateStore(); const text=String(store[name]||store.default||DEFAULT_SUMMARY_TEMPLATE); try{ await apiPost("/api/memory/settings",{memorySystem:{activeSummaryTemplateName:name,summaryTemplateText:text},confirm:true,source:"dashboard"}); if(templateStatus){ templateStatus.textContent="✅ "+t("templateSaved"); templateStatus.style.color="#047857"; } __templateEditorDirty=false; if(templateEditor) templateEditor.value=text; if(templateNameInput) templateNameInput.value=name; if(templatePreview) templatePreview.textContent=applyTemplateText(text,getTemplateVarsSample()); await refreshDashboardData(); }catch(e){ if(templateStatus){ templateStatus.textContent="❌ "+String(e&&e.message?e.message:e); templateStatus.style.color="#b91c1c"; } } }',
      '    async function resetTemplateSettings(){ if(!templateEditor) return; try{ await apiPost("/api/memory/settings",{memorySystem:{summaryTemplateText:"",activeSummaryTemplateName:"default",summaryTemplates:{default:DEFAULT_SUMMARY_TEMPLATE}},confirm:true,source:"dashboard"}); templateEditor.value=DEFAULT_SUMMARY_TEMPLATE; if(templateNameInput) templateNameInput.value="default"; __templateEditorDirty=false; if(templateStatus){ templateStatus.textContent="✅ "+t("templateResetOk"); templateStatus.style.color="#047857"; } renderTemplateSettings(); await refreshDashboardData(); }catch(e){ if(templateStatus){ templateStatus.textContent="❌ "+String(e&&e.message?e.message:e); templateStatus.style.color="#b91c1c"; } } }',
      '    function renderLlmSettings(){ if(!llmForm) return; const map=getSettingsMap(); llmForm.innerHTML=""; LLM_SCHEMA.forEach((it)=>{ const id="llm_"+it.key; const label=document.createElement("label"); label.htmlFor=id; label.style.fontSize="14px"; label.style.color="#111827"; label.style.fontWeight="600"; label.textContent=(LANG==="zh"?(it.labelZh||""):(it.labelEn||""))||it.key; let input; if(it.type==="enum"){ input=document.createElement("select"); const opts=Array.isArray(it.options)?it.options:[]; const enumZh={auto:"自动",session:"内联",independent:"独立",openai_compatible:"OpenAI兼容",gemini:"Gemini",anthropic:"Anthropic"}; opts.forEach((opt)=>{ const o=document.createElement("option"); o.value=String(opt); o.textContent=LANG==="zh"?(enumZh[String(opt)]||String(opt)):String(opt); input.appendChild(o); }); input.value=String((map[it.key]!==undefined&&map[it.key]!==null)?map[it.key]:it.default); input.style.width="100%"; input.style.height="30px"; } else if(it.key==="independentLlmModel"){ input=document.createElement("select"); input.style.width="100%"; input.style.height="30px"; const cur=String((map[it.key]!==undefined&&map[it.key]!==null)?map[it.key]:it.default||""); const o0=document.createElement("option"); o0.value=cur; o0.textContent=cur||"(empty)"; input.appendChild(o0); input.value=cur; } else if(it.type==="bool"){ input=document.createElement("input"); input.type="checkbox"; input.checked=toBool(map[it.key], Boolean(it.default)); input.style.justifySelf="start"; } else if(it.type==="string"){ input=document.createElement("input"); input.type=(it.key.toLowerCase().includes("apikey"))?"password":"text"; input.value=String((map[it.key]!==undefined&&map[it.key]!==null)?map[it.key]:it.default||""); input.style.width="100%"; input.style.height="30px"; } else { input=document.createElement("input"); input.type="number"; if(it.type==="float") input.step=String(it.step||"0.01"); input.value=String((map[it.key]!==undefined&&map[it.key]!==null)?map[it.key]:it.default||0); input.style.width="100%"; input.style.height="30px"; } input.id=id; input.dataset.key=it.key;  llmForm.appendChild(label); llmForm.appendChild(input); const help=LLM_HELP[it.key]||{}; const desc=document.createElement("div"); desc.className="sub"; desc.style.gridColumn="1 / span 2"; desc.style.margin="-2px 0 8px 0"; desc.style.fontSize="12px"; desc.style.color="#6b7280"; desc.textContent=(LANG==="zh"?(help.zh||""):(help.en||"")); llmForm.appendChild(desc); }); }',
      '    async function saveLlmSettings(){ if(!llmForm) return; const patch={}; LLM_SCHEMA.forEach((it)=>{ const el=$("llm_"+it.key); if(!el) return; if(it.type==="bool"){ patch[it.key]=Boolean(el.checked); return; } if(it.type==="enum"||it.type==="string"){ patch[it.key]=String(el.value||it.default||""); return; } const raw=String(el.value||it.default||0); patch[it.key]=(it.type==="float")?Number.parseFloat(raw):Number(raw); if(!Number.isFinite(patch[it.key])) patch[it.key]=it.default||0; }); try{ await apiPost("/api/memory/settings",{memorySystem:patch,confirm:true,source:"dashboard"}); if(llmStatus) llmStatus.textContent=t("llmSaved"); await refreshDashboardData(); }catch(e){ const msg=String(e&&e.message?e.message:e); if(msg.includes("dashboard_opened_as_file")){ alert("Save LLM settings failed: dashboard must be opened via http://127.0.0.1:37777 (not file://)."); } else { alert("Save LLM settings failed: "+msg); } } }',
      '    async function fetchLlmModels(){ const btn=$("llmFetchModelsBtn"); const old=btn?btn.textContent:""; if(btn){btn.disabled=true;btn.textContent=(LANG==="zh"?"获取中...":"Loading...");btn.style.opacity="0.7";} if(llmStatus) llmStatus.textContent=(LANG==="zh"?"正在获取模型列表...":"Fetching models..."); try{ const provider=String(($("llm_independentLlmProvider")&&$("llm_independentLlmProvider").value)||"openai_compatible"); const baseURL=String(($("llm_independentLlmBaseURL")&&$("llm_independentLlmBaseURL").value)||"").trim(); const apiKey=String(($("llm_independentLlmApiKey")&&$("llm_independentLlmApiKey").value)||"").trim(); const timeoutMs=Number(($("llm_independentLlmTimeoutMs")&&$("llm_independentLlmTimeoutMs").value)||30000); const r=await apiPost("/api/memory/llm/models",{provider,baseURL,apiKey,timeoutMs}); if(!r||!r.ok){ if(llmStatus) llmStatus.textContent=(LANG==="zh"?"获取模型失败: ":"Model fetch failed: ")+(r&&r.error?r.error:"unknown"); return; } const modelInput=$("llm_independentLlmModel"); if(modelInput&&Array.isArray(r.models)){ const current=String(modelInput.value||"").trim(); modelInput.innerHTML=""; const emptyOpt=document.createElement("option"); emptyOpt.value=""; emptyOpt.textContent=(LANG==="zh"?"(请选择模型)":"(Select model)"); modelInput.appendChild(emptyOpt); r.models.forEach((m)=>{ const v=String(m||"").trim(); if(!v) return; const o=document.createElement("option"); o.value=v; o.textContent=v; modelInput.appendChild(o); }); if(current&&r.models.includes(current)) modelInput.value=current; else if(!current&&r.models.length) modelInput.value=String(r.models[0]); } if(llmStatus) llmStatus.textContent=t("llmModelsLoaded")+": "+String((r&&r.count)||0); }catch(e){ if(llmStatus) llmStatus.textContent=(LANG==="zh"?"获取模型失败: ":"Model fetch failed: ")+String(e&&e.message?e.message:e); } finally{ if(btn){ btn.disabled=false; btn.textContent=old||t("llmFetchModels"); btn.style.opacity=""; } } }',
      '    async function validateLlmConfig(){ const btn=$("llmValidateBtn"); const old=btn?btn.textContent:""; if(btn){btn.disabled=true;btn.textContent=(LANG==="zh"?"验证中...":"Validating...");btn.style.opacity="0.7";} if(llmStatus){ llmStatus.textContent=(LANG==="zh"?"正在验证配置...":"Validating config..."); llmStatus.style.color="#6b7280"; } try{ const provider=String(($("llm_independentLlmProvider")&&$("llm_independentLlmProvider").value)||"openai_compatible"); const baseURL=String(($("llm_independentLlmBaseURL")&&$("llm_independentLlmBaseURL").value)||"").trim(); const apiKey=String(($("llm_independentLlmApiKey")&&$("llm_independentLlmApiKey").value)||"").trim(); const model=String(($("llm_independentLlmModel")&&$("llm_independentLlmModel").value)||"").trim(); const timeoutMs=Number(($("llm_independentLlmTimeoutMs")&&$("llm_independentLlmTimeoutMs").value)||30000); const r=await apiPost("/api/memory/llm/validate",{provider,baseURL,apiKey,model,timeoutMs}); if(!r||!r.ok){ if(llmStatus){ llmStatus.textContent=\"❌ \"+((LANG===\"zh\"?\"验证失败: \":\"Validation failed: \")+(r&&r.error?r.error:\"unknown\")); llmStatus.style.color=\"#b91c1c\"; } return; } if(llmStatus){ llmStatus.textContent=\"✅ \"+t(\"llmValidateOk\"); llmStatus.style.color=\"#047857\"; } }catch(e){ if(llmStatus){ llmStatus.textContent=\"❌ \"+((LANG===\"zh\"?\"验证失败: \":\"Validation failed: \")+String(e&&e.message?e.message:e)); llmStatus.style.color=\"#b91c1c\"; } } finally{ if(btn){ btn.disabled=false; btn.textContent=old||t("llmValidate"); btn.style.opacity=""; } } }',
      '    async function editSummary(projectName,sessionID,current){ const modal=$("editModal"); const ta=$("editTextarea"); const saveBtn=$("editSaveBtn"); const cancelBtn=$("editCancelBtn"); $("editTitle").textContent=t("edit")+" - "+sessionID; ta.value=current||""; $("editCancelBtn").textContent=t("cancel"); $("editSaveBtn").textContent=t("save"); modal.style.display="flex"; const close=()=>{ modal.style.display="none"; }; cancelBtn.onclick=close; saveBtn.onclick=async()=>{ if(!window.confirm("Apply summary update and write audit log?")) return; try{ await apiPost("/api/memory/session/summary",{projectName,sessionID,summaryText:ta.value,confirm:true,source:"dashboard"}); close(); window.location.reload(); }catch(e){ alert("Update failed: "+e.message);} }; }',
      '    async function deleteSession(projectName,sessionID){ if(!window.confirm("Delete this session memory file? This writes an audit log.")) return; try{ await apiPost("/api/memory/session/delete",{projectName,sessionID,confirm:true,source:"dashboard"}); window.location.reload(); }catch(e){ alert("Delete failed: "+e.message);} }',
      '    async function batchDeleteSessions(projectName){ const ids=[...__selectedSessionIDs].filter(Boolean); if(!ids.length){ alert(t("batchSelectFirst")); return; } if(!window.confirm(t("batchDeleteConfirm").replace("{n}", String(ids.length)))) return; try{ await apiPost("/api/memory/sessions/delete",{projectName,sessionIDs:ids,confirm:true,source:"dashboard"}); ids.forEach((id)=>__selectedSessionIDs.delete(id)); updateBatchDeleteBtn(); await refreshDashboardData(); }catch(e){ alert("Batch delete failed: "+e.message);} }',
      '    function applyLang(){ $("titleMain").textContent=t("title"); setConnectionBadge(($("connBadge")&&$("connBadge").classList.contains("bad"))?"bad":(($("connBadge")&&$("connBadge").classList.contains("ok"))?"ok":"pending")); $("langLabel").textContent=t("lang"); const mpk=$("mProjectsK"); if(mpk) mpk.textContent=t("metricProjects"); const msk=$("mSessionsK"); if(msk) msk.textContent=t("metricSessions"); const mek=$("mEventsK"); if(mek) mek.textContent=t("metricEvents"); if(tabSessionsBtn) tabSessionsBtn.textContent=t("tabSessions"); if(tabTemplateBtn) tabTemplateBtn.textContent=t("tabTemplate"); if(tabLlmBtn) tabLlmBtn.textContent=t("tabLlm"); if(tabSettingsBtn) tabSettingsBtn.textContent=t("tabSettings"); if(tabTrashBtn) tabTrashBtn.textContent=t("tabTrash"); $("globalTitle").textContent=t("global"); $("tokenHint").textContent=t("token"); const gf=$("globalPrefsFoldSummary"); if(gf) gf.textContent=t("globalPrefsFoldSummary"); if(!__activeProjectName) projectTitle.textContent=t("noProjectSelected"); const settingsTitle=$("settingsTitle"); if(settingsTitle) settingsTitle.textContent=t("settingsTitle"); const llmTitle=$("llmTitle"); if(llmTitle) llmTitle.textContent=t("llmTitle"); const llmHint=$("llmHint"); if(llmHint) llmHint.textContent=t("llmHint"); const settingsHint=$("settingsHint"); if(settingsHint) settingsHint.textContent=t("settingsHint"); const templateTitle=$("templateTitle"); if(templateTitle) templateTitle.textContent=t("templateTitle"); const templateHint=$("templateHint"); if(templateHint) templateHint.textContent=t("templateHint"); const templateFormatHint=$("templateFormatHint"); if(templateFormatHint) templateFormatHint.textContent=t("templateFormatHint"); const templateSaveBtnEl=$("templateSaveBtn"); if(templateSaveBtnEl) templateSaveBtnEl.textContent=t("templateSave"); const templateUseBtnEl=$("templateUseBtn"); if(templateUseBtnEl) templateUseBtnEl.textContent=t("templateUse"); const templateNameLabel=$("templateNameLabel"); if(templateNameLabel) templateNameLabel.textContent=t("templateNameLabel"); const templateSelectLabel=$("templateSelectLabel"); if(templateSelectLabel) templateSelectLabel.textContent=t("templateSelectLabel"); const templateResetBtnEl=$("templateResetBtn"); if(templateResetBtnEl) templateResetBtnEl.textContent=t("templateReset"); const templatePreviewBtnEl=$("templatePreviewBtn"); if(templatePreviewBtnEl) templatePreviewBtnEl.textContent=t("templatePreviewBtn"); const settingsSaveBtnEl=$("settingsSaveBtn"); if(settingsSaveBtnEl) settingsSaveBtnEl.textContent=t("settingsSave"); const llmSaveBtnEl=$("llmSaveBtn"); if(llmSaveBtnEl) llmSaveBtnEl.textContent=t("llmSave"); const llmFetchBtnEl=$("llmFetchModelsBtn"); if(llmFetchBtnEl) llmFetchBtnEl.textContent=t("llmFetchModels"); const llmValidateBtnEl=$("llmValidateBtn"); if(llmValidateBtnEl) llmValidateBtnEl.textContent=t("llmValidate"); const sessionsTitle=$("sessionsTitle"); if(sessionsTitle) sessionsTitle.textContent=t("sessions"); const selectAllBtn=$("batchSelectAllBtn"); if(selectAllBtn) selectAllBtn.textContent=t("selectAll"); const selectNoneBtn=$("batchSelectNoneBtn"); if(selectNoneBtn) selectNoneBtn.textContent=t("selectNone"); const auditHint=$("systemAuditHint"); if(auditHint) auditHint.textContent=t("systemAuditHint"); const trashTitle=$("trashTitle"); if(trashTitle) trashTitle.textContent=t("trashTitle"); const retentionLabel=$("trashRetentionLabel"); if(retentionLabel) retentionLabel.textContent=t("trashRetentionLabel"); const trashAllBtn=$("trashSelectAllBtn"); if(trashAllBtn) trashAllBtn.textContent=t("selectAll"); const trashNoneBtn=$("trashSelectNoneBtn"); if(trashNoneBtn) trashNoneBtn.textContent=t("selectNone"); const c=$("trashCleanupBtn"); if(c) c.textContent=t("trashCleanup"); const pLabel=$("pretrimProfileLabel"); if(pLabel) pLabel.textContent=t("pretrimProfileLabel"); if(pretrimProfileSel&&pretrimProfileSel.options&&pretrimProfileSel.options.length>=3){ pretrimProfileSel.options[0].text=t("pretrimConservative"); pretrimProfileSel.options[1].text=t("pretrimBalanced"); pretrimProfileSel.options[2].text=t("pretrimAggressive"); } const pSave=$("savePretrimProfileBtn"); if(pSave) pSave.textContent=t("pretrimSave"); const cleanBtn=$("cleanGlobalNoteBtn"); if(cleanBtn) cleanBtn.textContent=t("cleanGlobalNote"); updateBatchDeleteBtn(); updateTrashDeleteBtn(); renderSettings(); renderTemplateSettings(); renderLlmSettings(); }',
      '    function renderGlobalPrefs(){ const prefs=(DATA&&DATA.global&&DATA.global.preferences)||{}; const entries=Object.entries(prefs); updatePretrimProfileUi(); if(!entries.length){globalPrefs.textContent=t("noGlobalPrefs"); return;} globalPrefs.innerHTML=""; entries.forEach(([k,v])=>{ const div=document.createElement("div"); div.className="pref"; div.textContent=k+": "+String(v); globalPrefs.appendChild(div); }); }',
      '    function renderSessions(project){ if(!project||!project.sessions||!project.sessions.length){ sessionList.className="empty"; sessionList.textContent=t("nos"); updateBatchDeleteBtn(); return;} sessionList.className=""; sessionList.innerHTML=""; project.sessions.forEach((s)=>{ const wrap=document.createElement("div"); wrap.className="session"; const head=document.createElement("div"); head.className="session-h"; const sel=document.createElement("input"); sel.type="checkbox"; sel.style.marginRight="8px"; sel.checked=__selectedSessionIDs.has(s.sessionID||""); sel.addEventListener("click",(e)=>e.stopPropagation()); sel.addEventListener("change",(e)=>{ if(e.target.checked) __selectedSessionIDs.add(s.sessionID||""); else __selectedSessionIDs.delete(s.sessionID||""); updateBatchDeleteBtn(); }); const sid=document.createElement("div"); sid.className="session-id"; const _title=(s.sessionTitle&&s.sessionTitle.trim())?s.sessionTitle:(s.sessionID||""); sid.textContent=_title+"  id:"+(s.sessionID||""); sid.style.whiteSpace="normal"; const st=document.createElement("div"); st.className="stats"; const bt=(s.budget&&s.budget.lastEstimatedBodyTokens)||0; const stt=(s.budget&&s.budget.lastEstimatedSystemTokens)||0; const pht=(s.budget&&s.budget.lastEstimatedPluginHintTokens)||0; const tt=(s.budget&&s.budget.lastEstimatedTotalTokens)||((bt||0)+(stt||0)); const pb=(s.budget&&s.budget.sendPretrimBudget)||0; const pt=(s.budget&&s.budget.sendPretrimTarget)||0; const ig=(s.inject&&s.inject.globalPrefsCount)||0; const ic=(s.inject&&s.inject.currentSummaryCount)||0; const ir=(s.inject&&s.inject.triggerRecallCount)||0; const pa=s.pruneAudit||{}; const sp=s.sendPretrim||{}; const w=(sp&&sp.warmup)||{}; const lastTrace=(sp.traces&&sp.traces.length)?sp.traces[sp.traces.length-1]:null; const summaryMode=lastTrace?(lastTrace.distillUsed ?((lastTrace.warmupCacheHit||String(lastTrace.distillSource||"").includes("warmup"))?t("llmSummaryCache"):(String(lastTrace.distillProvider||"").includes("session-inline")?t("llmSummaryInline"):t("llmSummaryIndependent"))):t("llmSummaryMechanical")):"-"; const spLast=(sp.lastSavedTokens||0)>0?(" · "+t("sessionStatPretrimLast")+":"+(sp.lastBeforeTokens||0)+"→"+(sp.lastAfterTokens||0)+" (save~"+(sp.lastSavedTokens||0)+")"):""; const strictNow=(sp.traces&&sp.traces.length&&sp.traces[sp.traces.length-1].strictApplied)?(" · strict:ON("+((sp.traces[sp.traces.length-1].strictReplacedMessages)||0)+")"):""; const warmupStats=" · "+t("sessionStatWarmup")+":h"+(w.hitCount||0)+"/m"+(w.missCount||0)+"/s"+((w.skipBudgetCount||0)+(w.skipCooldownCount||0))+"/f"+(w.failCount||0); const warmupBind=" · "+t("sessionStatBound")+":"+((w.lastUserMessageID&&String(w.lastUserMessageID).slice(-16))||"-")+" · "+t("sessionStatWarmupStatus")+":"+((w.status&&String(w.status).slice(0,40))||"-"); const risk=(s.alerts&&s.alerts.contextStackRisk)?(" · "+t("sessionStatRiskStack")):""; const reasonRaw=(s.inject&&s.inject.lastReason)||""; const reasonMap={\"global-prefs\":t(\"injectReasonGlobal\"),\"current-session-refresh\":t(\"injectReasonCurrent\"),\"trigger-recall\":t(\"injectReasonRecall\"),\"memory-docs\":t(\"injectReasonDocs\"),\"memory-inject\":t(\"injectReasonManual\")}; const reasonLabel=reasonMap[reasonRaw]||t(\"none\"); const injectAt=(s.inject&&s.inject.lastAt)?new Date(s.inject.lastAt).toLocaleString():t(\"none\"); st.textContent=\"u:\"+(s.stats.userMessages||0)+\" · a:\"+(s.stats.assistantMessages||0)+\" · t:\"+(s.stats.toolResults||0)+\" · r:\"+((s.recall&&s.recall.count)||0)+\" · \"+t(\"sessionStatInject\")+\":g\"+ig+\"/c\"+ic+\"/x\"+ir+\" · \"+t(\"sessionStatLastInject\")+\":\"+reasonLabel+\" @ \"+injectAt+\" · \"+t(\"sessionStatPrune\")+\":\"+t(\"autoLabel\")+(pa.autoRuns||0)+\"/\"+t(\"manualLabel\")+(pa.manualRuns||0)+\" d\"+(pa.discardRemovedTotal||0)+\" e\"+(pa.extractMovedTotal||0)+\" · \"+t(\"sessionStatPretrim\")+\":\"+t(\"autoLabel\")+(sp.autoRuns||0)+\" \"+t(\"sessionStatSaved\")+\"~\"+(sp.savedTokensTotal||0)+\" · \"+t(\"tabLlm\")+\":\"+summaryMode+spLast+strictNow+risk+\" · \"+t(\"sessionStatBlocks\")+\":\"+(((s.summaryBlocks&&s.summaryBlocks.count)||0))+\" · \"+t(\"sessionStatBudget\")+\":\"+pb+\" · \"+t(\"sessionStatTarget\")+\":\"+pt+\" · \"+t(\"sessionStatBody")+bt+" · "+t("sessionStatSystem")+stt+" · "+t("sessionStatPluginHint")+pht+" · "+t("sessionStatTotal")+tt+" "+t("tokensLabel")+warmupStats+warmupBind; const metaWrap=document.createElement("div"); metaWrap.style.display="flex"; metaWrap.style.flexDirection="column"; metaWrap.style.alignItems="flex-start"; metaWrap.style.gap="4px"; metaWrap.appendChild(sid); metaWrap.appendChild(st); head.appendChild(sel); head.appendChild(metaWrap); const events=document.createElement("div"); events.className="events"; const sorted=(s.recentEvents||[]).slice().sort((a,b)=>(Date.parse(a.ts||0)||0)-(Date.parse(b.ts||0)||0)); if(!sorted.length){ const empty=document.createElement("div"); empty.className="empty"; empty.textContent=t("noEvents"); events.appendChild(empty); } else { sorted.forEach((ev)=>{ const row=document.createElement("div"); row.className="ev "+(ev.kind||""); const meta=document.createElement("div"); meta.className="meta"; meta.textContent=(ev.kind||"event")+(ev.tool?" ["+ev.tool+"]":"")+" · "+(ev.ts?new Date(ev.ts).toLocaleString():""); const txt=document.createElement("div"); txt.className="txt"; txt.textContent=ev.summary||""; row.appendChild(meta); row.appendChild(txt); events.appendChild(row); }); } const actions=document.createElement("div"); actions.style.marginTop="8px"; const eb=document.createElement("button"); eb.textContent=t("edit"); eb.onclick=()=>{ const fallback=(s.summary&&s.summary.compressedText)||((s.recentEvents||[]).slice(-8).map((ev)=>"- "+(ev.kind||"event")+": "+(ev.summary||"")).join("\\n")); editSummary(project.name,s.sessionID,fallback); }; const db=document.createElement("button"); db.textContent=t("del"); db.style.marginLeft="8px"; db.onclick=()=>deleteSession(project.name,s.sessionID); actions.appendChild(eb); actions.appendChild(db); events.appendChild(actions); if(s.summary&&s.summary.compressedText){ const summary=document.createElement("div"); summary.className="ev"; const meta=document.createElement("div"); meta.className="meta"; const reason=(s.budget&&s.budget.lastCompactionReason)?(" · "+s.budget.lastCompactionReason):""; const paInfo=s.pruneAudit?(` · prune(last:${s.pruneAudit.lastSource||\"-\"}, d=${s.pruneAudit.lastDiscardRemoved||0}, e=${s.pruneAudit.lastExtractMoved||0})`):\"\"; meta.textContent=\"compressed summary\"+reason+paInfo; const txt=document.createElement("div"); txt.className="txt"; txt.textContent=s.summary.compressedText; summary.appendChild(meta); summary.appendChild(txt); events.appendChild(summary); } if(s.summaryBlocks&&Array.isArray(s.summaryBlocks.recent)&&s.summaryBlocks.recent.length){ const blk=document.createElement("div"); blk.className="ev"; const bm=document.createElement("div"); bm.className="meta"; bm.textContent=t("compressedBlocks")+" (latest "+s.summaryBlocks.recent.length+")"; const bt=document.createElement("div"); bt.className="txt"; bt.textContent=s.summaryBlocks.recent.map((b)=>`b${b.blockId} | ${b.source||"pretrim"} | m:${b.consumedMessages||0} | ${b.summaryPreview||""}`).join("\\n"); blk.appendChild(bm); blk.appendChild(bt); events.appendChild(blk); } if(s.sendPretrim&&s.sendPretrim.warmup&&Array.isArray(s.sendPretrim.warmup.logs)&&s.sendPretrim.warmup.logs.length){ const wl=document.createElement("div"); wl.className="ev"; const wm=document.createElement("div"); wm.className="meta"; wm.textContent=t("sessionWarmupLogs"); const wt=document.createElement("div"); wt.className="txt"; wt.textContent=s.sendPretrim.warmup.logs.slice(-8).map((x)=>`${x.ts?new Date(x.ts).toLocaleString():"-"} | ${x.level||"info"} | ${x.message||""}`).join("\\n"); wl.appendChild(wm); wl.appendChild(wt); events.appendChild(wl); } if(s.sendPretrim&&Array.isArray(s.sendPretrim.traces)&&s.sendPretrim.traces.length){ const tr=document.createElement("div"); tr.className="ev"; const m=document.createElement("div"); m.className="meta"; m.textContent=t("pretrimTraces"); const traceTxt=document.createElement("div"); traceTxt.className="txt"; const rows=s.sendPretrim.traces.slice(-8).map((x)=>{ const ts=x.ts?new Date(x.ts).toLocaleString():"-"; const strict=x.strictApplied?(` | strict:${x.strictReplacedMessages||0}`):\"\"; const llmMode=x.distillUsed?((String(x.distillProvider||\"\").includes(\"session-inline\"))?(` | ${t(\"llmSummaryInline\")}:${x.distillModel||\"current-session\"}`):(` | ${t(\"llmSummaryIndependent\")}:${x.distillProvider||\"\"}/${x.distillModel||\"\"}`)):((x.distillStatus&&x.distillStatus.includes(\"fail\"))?(` | ${t(\"llmSummaryFailed\")}:${x.distillStatus}`):(` | ${t(\"llmSummaryMechanical\")}`)); const strat=((x.strategyDedup||0)||(x.strategySupersedeWrites||0)||(x.strategyPurgedErrors||0)||(x.strategyPhaseTrim||0))?(` | strat:d${x.strategyDedup||0}/s${x.strategySupersedeWrites||0}/p${x.strategyPurgedErrors||0}/ph${x.strategyPhaseTrim||0}`):\"\"; const block=(x.blockId?(` | block:b${x.blockId}`):\"\"); const anchor=x.anchorReplaceApplied?(` | anchor:${x.anchorReplaceMessages||0}/b${x.anchorReplaceBlocks||0}`):\"\"; const comp=(()=>{ const b=x.compositionBefore||{}; const a=x.compositionAfter||{}; const bt=(b.total||0), at=(a.total||0); if(!bt||!at) return \"\"; const pct=(v,t)=>Math.round((100*v)/Math.max(1,t)); return ` | comp S:${pct(b.system||0,bt)}→${pct(a.system||0,at)} U:${pct(b.user||0,bt)}→${pct(a.user||0,at)} T:${pct(b.tool||0,bt)}→${pct(a.tool||0,at)}`; })(); return `${ts} | ${x.beforeTokens||0}→${x.afterTokens||0} | total:${x.totalBeforeTokens||((x.beforeTokens||0)+(x.systemTokensBefore||0))}→${x.totalAfterTokens||((x.afterTokens||0)+(x.systemTokensAfter||0))} | system~${x.systemTokensAfter||0} | plugin-hint~${x.pluginHintTokensAfter||0} | save~${x.savedTokens||0} | rw:${x.rewrittenMessages||0}/${x.rewrittenParts||0} | ex:${x.extractedMessages||0}${strict}${llmMode}${strat}${block}${anchor}${comp} | ${x.reason||""}`; }); traceTxt.textContent=rows.join("\\n"); tr.appendChild(m); tr.appendChild(traceTxt); events.appendChild(tr); } head.addEventListener("click", ()=>{ events.classList.toggle("open"); }); wrap.appendChild(head); wrap.appendChild(events); sessionList.appendChild(wrap); }); updateBatchDeleteBtn(); }',
      '    function setActiveProject(project,elem){ document.querySelectorAll(".project-item").forEach((e)=>e.classList.remove("active")); if(elem) elem.classList.add("active"); __activeProjectName=project.name||""; __selectedSessionIDs.clear(); projectTitle.textContent=project.name; const ts=(project.techStack&&project.techStack.length)?project.techStack.join(", "):"N/A"; projectMeta.textContent=t("projectMetaFmt").replace("{sessions}",String(project.sessionCount||0)).replace("{events}",String(project.totalEvents||0)).replace("{tech}",ts); const b=$("batchDeleteBtn"); if(b) b.onclick=()=>batchDeleteSessions(project.name); renderSessions(project); updateBatchDeleteBtn(); }',
      '    function renderProjects(){ projectList.innerHTML=""; if(!DATA.projects.length){ const empty=document.createElement("div"); empty.className="empty"; empty.textContent=t("noproj"); projectList.appendChild(empty); projectTitle.textContent=t("noProjectSelected"); projectMeta.textContent=""; const b=$("batchDeleteBtn"); if(b) b.onclick=null; renderSessions(null); return;} DATA.projects.forEach((p,i)=>{ const item=document.createElement("div"); item.className="project-item"; const name=document.createElement("div"); name.className="name"; name.textContent=p.name||""; const meta=document.createElement("div"); meta.className="meta"; meta.textContent=t("projectListMetaFmt").replace("{sessions}",String(p.sessionCount||0)).replace("{events}",String(p.totalEvents||0)); item.appendChild(name); item.appendChild(meta); item.addEventListener("click", ()=>setActiveProject(p,item)); projectList.appendChild(item); if(i===0) setActiveProject(p,item); }); }',
      '    let __autoRefreshTimer = null;',
      '    function startAutoRefresh(){ if(__autoRefreshTimer) clearInterval(__autoRefreshTimer); __autoRefreshTimer = setInterval(()=>{ refreshDashboardData(); }, 60000); }',
      '    document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState!=="visible") return; const now=Date.now(); if(now-(__lastRefreshAt||0)>=60000) refreshDashboardData(); });',
      '    langSel.value=LANG; langSel.onchange=()=>{ LANG=normalizeLang(langSel.value); localStorage.setItem("memory_dashboard_lang",LANG); applyLang(); renderGlobalPrefs(); renderProjects(); renderTrash(); }; const cleanupBtn=$("trashCleanupBtn"); if(cleanupBtn) cleanupBtn.onclick=cleanupTrashNow; const delBtn=$("trashDeleteBtn"); if(delBtn) delBtn.onclick=deleteTrashSelected; const batchAllBtn=$("batchSelectAllBtn"); if(batchAllBtn) batchAllBtn.onclick=selectAllSessions; const batchNoneBtn=$("batchSelectNoneBtn"); if(batchNoneBtn) batchNoneBtn.onclick=clearSelectedSessions; const trashAllBtn=$("trashSelectAllBtn"); if(trashAllBtn) trashAllBtn.onclick=selectAllTrash; const trashNoneBtn=$("trashSelectNoneBtn"); if(trashNoneBtn) trashNoneBtn.onclick=clearSelectedTrash; const retentionSel=$("trashRetentionSel"); if(retentionSel) retentionSel.onchange=()=>{ __trashData.retentionDays=Number(retentionSel.value||30); renderTrash(); }; if(savePretrimProfileBtn) savePretrimProfileBtn.onclick=savePretrimProfile; if(cleanGlobalNoteBtn) cleanGlobalNoteBtn.onclick=cleanGlobalNote; if(settingsSaveBtn) settingsSaveBtn.onclick=saveSettings; if(templateSaveBtn) templateSaveBtn.onclick=saveTemplateSettings; if(templateUseBtn) templateUseBtn.onclick=useTemplateSettings; if(templateSelect) templateSelect.onchange=()=>{ const store=getTemplateStore(); const name=String(templateSelect.value||"default"); if(templateNameInput) templateNameInput.value=name; if(templateEditor){ templateEditor.value=String(store[name]||store.default||DEFAULT_SUMMARY_TEMPLATE); __templateEditorDirty=false; } if(templatePreview) templatePreview.textContent=applyTemplateText((templateEditor&&templateEditor.value)||getCurrentTemplateText(), getTemplateVarsSample()); }; if(templateResetBtn) templateResetBtn.onclick=resetTemplateSettings; if(templatePreviewBtn) templatePreviewBtn.onclick=()=>{ if(templatePreview) templatePreview.textContent=applyTemplateText((templateEditor&&templateEditor.value)||getCurrentTemplateText(), getTemplateVarsSample()); }; if(templateEditor) templateEditor.oninput=()=>{ __templateEditorDirty=true; if(templatePreview) templatePreview.textContent=applyTemplateText(templateEditor.value, getTemplateVarsSample()); }; if(llmSaveBtn) llmSaveBtn.onclick=saveLlmSettings; if(llmFetchModelsBtn) llmFetchModelsBtn.onclick=fetchLlmModels; if(llmValidateBtn) llmValidateBtn.onclick=validateLlmConfig; if(tabSessionsBtn) tabSessionsBtn.onclick=()=>setActiveTab("sessions"); if(tabTemplateBtn) tabTemplateBtn.onclick=()=>setActiveTab("template"); if(tabLlmBtn) tabLlmBtn.onclick=()=>setActiveTab("llm"); if(tabSettingsBtn) tabSettingsBtn.onclick=()=>setActiveTab("settings"); if(tabTrashBtn) tabTrashBtn.onclick=()=>setActiveTab("trash"); setActiveTab("sessions"); applyLang(); updateTrashDeleteBtn(); refreshDashboardData(); startAutoRefresh();',
      '  </script>',
      '</body>',
      '</html>'
    ];
    let rendered = html.join('\n');
    rendered = rendered.replace(
      'const risk=(s.alerts&&s.alerts.contextStackRisk)?(" · "+t("sessionStatRiskStack")):"";',
      'const riskFlags=[]; if(s.alerts&&s.alerts.contextStackRisk) riskFlags.push(t("sessionStatRiskStack")); if(s.alerts&&s.alerts.systemTokenRisk) riskFlags.push(t("sessionStatRiskSystem")); const risk=riskFlags.length?(" · "+riskFlags.join(" / ")):"";'
    );
    rendered = rendered.replace(
      'if(s.summary&&s.summary.compressedText){ const summary=document.createElement("div"); summary.className="ev"; const meta=document.createElement("div"); meta.className="meta"; const reason=(s.budget&&s.budget.lastCompactionReason)?(" · "+s.budget.lastCompactionReason):""; const paInfo=s.pruneAudit?(` · prune(last:${s.pruneAudit.lastSource||"-"}, d=${s.pruneAudit.lastDiscardRemoved||0}, e=${s.pruneAudit.lastExtractMoved||0})`):""; meta.textContent="compressed summary"+reason+paInfo; const txt=document.createElement("div"); txt.className="txt"; txt.textContent=s.summary.compressedText; summary.appendChild(meta); summary.appendChild(txt); events.appendChild(summary); }',
      'if(s.summary&&s.summary.compressedText){ const summary=document.createElement("div"); summary.className="ev"; const meta=document.createElement("div"); meta.className="meta"; const reason=(s.budget&&s.budget.lastCompactionReason)?(" · "+s.budget.lastCompactionReason):""; const paInfo=s.pruneAudit?(` · prune(last:${s.pruneAudit.lastSource||"-"}, d=${s.pruneAudit.lastDiscardRemoved||0}, e=${s.pruneAudit.lastExtractMoved||0})`):""; meta.textContent="compressed summary"+reason+paInfo; const txt=document.createElement("div"); txt.className="txt"; txt.textContent=s.summary.compressedText; summary.appendChild(meta); summary.appendChild(txt); events.appendChild(summary); } { const sys=document.createElement("details"); sys.className="ev fold"; const sum=document.createElement("summary"); sum.textContent=(typeof t==="function"?t("systemAuditCard"):"send-time system audit")+` · tokens~${s.systemPrompt&&s.systemPrompt.lastObservedTokens||0} · chars:${s.systemPrompt&&s.systemPrompt.lastObservedChars||0} · lines:${s.systemPrompt&&s.systemPrompt.lastObservedLines||0} · model:${s.systemPrompt&&s.systemPrompt.lastObservedModel||"-"}`; const stxt=document.createElement("div"); stxt.className="txt"; stxt.style.marginTop="8px"; stxt.textContent=(s.systemPrompt&&s.systemPrompt.lastObservedText)||(s.systemPrompt&&s.systemPrompt.enabled===false?(typeof t==="function"?t("systemAuditDisabled"):"system-layer audit is disabled; enable it in settings"):((typeof t==="function"?t("systemAuditEmpty"):"no system prompt text captured for this session yet; send one more message to capture it"))); sys.appendChild(sum); sys.appendChild(stxt); events.appendChild(sys); }'
    );
    return rendered;
  }

  function buildDashboardHtml(data) {
    // Temporary single-source rendering: use legacy builder only.
    // External template remains on disk but is not used at runtime until it is rebuilt safely.
    return buildDashboardHtmlLegacy(data);
  }

  function writeDashboardFiles() {
    try {
      ensureDashboardDir();
      const data = buildDashboardData();
      const html = buildDashboardHtml(data);
      fs.writeFileSync(dashboardDataPath, JSON.stringify(data, null, 2), 'utf8');
      fs.writeFileSync(dashboardHtmlPath, html, 'utf8');
      return {
        dashboardPath: dashboardHtmlPath,
        dashboardDataPath,
        generatedAt: data.generatedAt,
        summary: data.summary
      };
    } catch (err) {
      console.error('memory-system dashboard write failed:', err);
      return {
        dashboardPath: dashboardHtmlPath,
        generatedAt: null,
        summary: { projectCount: 0, sessionCount: 0, eventCount: 0 },
        error: err?.message || String(err)
      };
    }
  }

const memoryDocs = `
<OPENCODE_KNOWLEDGE_BASE topic="Memory System">
# OpenCode Memory System
Use only ONE tool: memory.
Do NOT call remember_global or recall_memory.
Do NOT call context unless the user explicitly asks to manage session context.
If memory/context tools are called with empty input, they return usage/help text. Prefer explicit arguments.
Preferred global write forms (via memory tool):
- {"command":"set","key":"preferences.language","value":"Chinese"}
- {"command":"prefer","args":["language","Chinese"]}
- {"key":"preferences.communication_style","value":"客观、中立"}
- {"content":"请记住以后默认使用中文回复"}
For explicit user memory requests like "请记住以后默认使用中文回复", the plugin can auto-persist global memory before model response. Avoid redundant retry calls after auto-persist.
For generic facts like "记住这个跨会话事实..." without explicit global/preference intent, do not call memory tool; answer directly.
Preferred recall forms:
- {"command":"recall","args":["word mcp path"]}
- {"command":"global"}
Use /memory recall <query> to manually retrieve relevant memory from previous sessions.
For /memory doctor, do not use task/subagent. Call memory directly and use current session fallback.
</OPENCODE_KNOWLEDGE_BASE>
`;

  return {
    name: 'memory-system',
    tool: {
      memory: {
        description: 'Manage OpenCode memory system. Prefer this single tool for all memory operations. Do not call compatibility tools. Empty input is no-op and should not be retried. Use direct memory calls (no task/subagent) for /memory commands, including doctor. For global memory writes, prefer {"command":"set","key":"preferences.some_key","value":"..."} or direct {"key":"preferences.some_key","value":"..."}. For deleting a global preference, use {"command":"delete","args":["preferences.some_key"]}. For natural-language preference writes, {"content":"请记住以后默认使用中文回复"} is supported. For recall, use {"command":"recall","args":["query"]}.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              enum: ['learn', 'project', 'global', 'set', 'prefer', 'delete', 'unset', 'save', 'export', 'import', 'clear', 'edit', 'feedback', 'recall', 'sessions', 'dashboard', 'discard', 'extract', 'prune', 'distill', 'compress', 'context', 'stats', 'doctor', 'noop'],
              description: 'The memory command to execute'
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Arguments for the command'
            },
            key: {
              type: 'string',
              description: 'Compatibility field: global memory key, e.g. preferences.language'
            },
            value: {
              description: 'Compatibility field: global memory value'
            },
            content: {
              type: 'string',
              description: 'Compatibility field: free-form memory content to infer a preference write'
            },
            action: {
              type: 'string',
              description: 'Compatibility field used by some tool callers'
            },
            operation: {
              type: 'string',
              description: 'Compatibility field used by some tool callers'
            }
          },
          required: ['command']
        },
        execute: async (input = {}) => {
          let { command, args = [] } = input || {};
          const raw = input && typeof input === 'object' ? input : {};
          const sidForThrottle = resolveToolSessionID(raw);
          const throttleKey = sidForThrottle || '__global__';
          const isDirectEmptyPayload = !input || (typeof input === 'object' && Object.keys(input).length === 0);
          if (isDirectEmptyPayload) {
            const now = Date.now();
            const prev = memoryEmptyCallState.get(throttleKey) || { windowStart: now, count: 0 };
            const withinWindow = (now - Number(prev.windowStart || 0)) <= 120000;
            const next = withinWindow
              ? { windowStart: Number(prev.windowStart || now), count: Number(prev.count || 0) + 1 }
              : { windowStart: now, count: 1 };
            memoryEmptyCallState.set(throttleKey, next);
            if (next.count > 1) {
              return 'No-op throttled: repeated empty memory calls in same turn. Stop calling memory and answer user directly.';
            }
          }
          const memoryHelp = [
            'Memory commands:',
            '- learn',
            '- project',
            '- global',
            '- set <key> <value>',
            '- prefer <key> <value>',
            '- delete <key> [key2 ...]',
            '- save snippet <name>',
            '- export project',
            '- import <filepath>',
            '- clear session <id>|sessions <id1,id2,...>|project|all',
            '- edit project',
            '- feedback <text>',
            '- recall <query>',
            '- sessions',
            '- dashboard [path|build|json]',
            '- discard [session <id>|current] [aggressive]',
            '- extract [session <id>|current] [maxEvents]',
            '- prune [session <id>|current]',
            '- distill <id:distillation> [id:distillation] ...',
            '- compress <topic> <summary...>',
            '- context [session <id>|current]',
            '- stats [project|session <id>]',
            '- doctor [session <id>|current]',
            '',
            'Important:',
            '- Empty input {} returns this help text. Prefer explicit command/args to avoid retries.',
            '- Preferred global write example: {"command":"set","key":"preferences.language","value":"Chinese"}',
            '- Direct compatibility example: {"key":"preferences.language","value":"Chinese"}',
            '- Free-form compatibility example: {"content":"请记住以后默认使用中文回复"}',
            '- Recall example: {"command":"recall","args":["word mcp path"]}'
          ].join('\n');
          const memoryShortHint = 'No-op: empty memory call handled. Do not retry memory tool; continue answering user directly.';
          const projectMemoryPath = getProjectMemoryPath();
          const projectName = getProjectName();

          const toArgsArray = (value) => {
            if (Array.isArray(value)) return value.map((x) => String(x));
            if (typeof value === 'string') {
              const s = value.trim();
              if (!s) return [];
              if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
                try {
                  const parsed = JSON.parse(s);
                  if (Array.isArray(parsed)) return parsed.map((x) => String(x));
                  if (parsed && typeof parsed === 'object') return Object.values(parsed).map((x) => String(x));
                } catch {
                  // ignore parse error
                }
              }
              return s.split(/\s+/).map((x) => String(x));
            }
            if (value && typeof value === 'object') return Object.values(value).map((x) => String(x));
            return [];
          };

          const pickFirstDefined = (obj, keys) => {
            for (const k of keys) {
              if (!obj || typeof obj !== 'object') continue;
              if (obj[k] !== undefined && obj[k] !== null) return obj[k];
            }
            return undefined;
          };

          const pickFirstString = (obj, keys) => {
            const v = pickFirstDefined(obj, keys);
            if (typeof v !== 'string') return '';
            return v.trim();
          };

          const applySyntheticCommand = (nextCommand = '', nextArgs = [], extras = {}) => {
            if (!raw || typeof raw !== 'object') return;
            const cmd = normalizeText(String(nextCommand || '')).toLowerCase();
            if (!cmd) return;
            raw.command = cmd;
            if (Array.isArray(nextArgs)) raw.args = nextArgs.map((x) => String(x));
            for (const [key, value] of Object.entries(extras || {})) {
              if (value === undefined || value === null) continue;
              raw[key] = value;
            }
          };

          // Unified compatibility layer for OpenAI/Gemini/Anthropic style payloads.
          const nested = [
            raw,
            raw?.input,
            raw?.arguments,
            raw?.params,
            raw?.parameters,
            raw?.payload,
            raw?.data
          ].filter((x) => x && typeof x === 'object');
          const merged = Object.assign({}, ...nested);

          if (!command || command === 'undefined' || typeof command !== 'string') {
            command =
              pickFirstString(merged, ['command', 'cmd', 'action', 'operation', 'name', 'task']) ||
              command;
          }
          command = normalizeText(String(command || '')).toLowerCase();

          if (command.startsWith('/memory')) {
            const parts = command.split(/\s+/).filter(Boolean);
            command = parts[1] || '';
            if (!args.length && parts.length > 2) args = parts.slice(2);
          }

          if (command === 'memory' || command === 'memory-system') {
            if (args.length) {
              command = normalizeText(String(args[0] || '')).toLowerCase();
              args = args.slice(1);
            } else {
              command = '';
            }
          }

          const commandAlias = {
            get: 'global',
            view: 'global',
            remember: 'set',
            write: 'set',
            preference: 'set',
            preferences: 'set',
            prefer: 'prefer',
            remove: 'delete',
            unset: 'delete'
          };
          if (commandAlias[command]) command = commandAlias[command];

          if (!Array.isArray(args) || !args.length) {
            const rawArgs = pickFirstDefined(merged, ['args', 'arguments', 'argv', 'params', 'values']);
            args = toArgsArray(rawArgs);
          }
          if (!Array.isArray(args)) args = [];

          if ((!command || command === 'undefined') && args.length) {
            const maybeCommand = normalizeText(String(args[0] || '')).toLowerCase();
            const validCommands = new Set([
              'learn', 'project', 'global', 'set', 'prefer', 'save', 'export', 'import', 'clear', 'edit',
              'feedback', 'recall', 'sessions', 'dashboard', 'discard', 'extract', 'prune', 'distill',
              'delete', 'unset',
              'compress', 'context', 'stats', 'doctor'
            ]);
            if (validCommands.has(maybeCommand)) {
              command = maybeCommand;
              args = args.slice(1);
            }
          }

          const toolSessionID = resolveToolSessionID(raw);
          let slashSourceText =
            getLatestUserTextForSession(toolSessionID)
            || getLatestUserSummaryForSession(toolSessionID);
          if (toolSessionID) {
            const toolSession = loadSessionMemory(toolSessionID, projectName);
            const sessionHasRealUserMessage = Array.isArray(toolSession?.recentEvents)
              && toolSession.recentEvents.some((event) => (
                event?.kind === 'user-message'
                && normalizeText(String(event?.summary || ''))
                && !isSummaryNoiseText(String(event?.summary || ''))
              ));
            if (!sessionHasRealUserMessage) {
              const observedFallback = sanitizeUserTextForMemoryInference(String(lastObservedUserText || ''));
              if (observedFallback) slashSourceText = observedFallback;
            }
          } else if (!slashSourceText) {
            slashSourceText = sanitizeUserTextForMemoryInference(String(lastObservedUserText || ''));
          }
          const explicitSlashCommand = parseExplicitMemorySlashCommandFromText(slashSourceText);
          if (explicitSlashCommand?.command) {
            const currentCommandText = normalizeText(String(command || '')).toLowerCase();
            const currentArgsText = Array.isArray(args) ? args.map((x) => String(x)).join(' ') : '';
            const slashArgsText = explicitSlashCommand.args.join(' ');
            if (currentCommandText !== explicitSlashCommand.command || currentArgsText !== slashArgsText) {
              command = explicitSlashCommand.command;
              args = explicitSlashCommand.args.slice();
              applySyntheticCommand(command, args, {
                reason: 'coerced_from_explicit_slash',
                ...(explicitSlashCommand.query ? { query: explicitSlashCommand.query } : {})
              });
              if (raw && typeof raw === 'object') {
                delete raw.key;
                delete raw.value;
                delete raw.content;
                if (!explicitSlashCommand.query) delete raw.query;
              }
            }
          }

          // OpenAI/Gemini compatibility:
          // {"action":"global","content":"...","operation":"learn"}
          // {"command":"set","key":"preferences.language","value":"Chinese"}
          if (command === 'global' || (command === 'learn' && String(pickFirstString(merged, ['action'])).toLowerCase() === 'global')) {
            const compatKey = pickFirstDefined(merged, ['key', 'path', 'field']);
            const compatValue = pickFirstDefined(merged, ['value', 'val']);
            const compatContent = pickFirstDefined(merged, ['content', 'text', 'query', 'message']);
              if (compatKey !== undefined && compatValue !== undefined && String(compatKey).trim()) {
              command = 'set';
              args = [normalizeGlobalMemoryKey(String(compatKey)), String(compatValue)];
            } else if (compatContent) {
              const inferred = inferPreferenceFromContent(compatContent);
              if (inferred) {
                command = 'set';
                args = [inferred.key, inferred.value];
              }
            }
          } else if (command === 'set' || command === 'prefer') {
            if (args.length < 2) {
              const compatKey = pickFirstDefined(merged, ['key', 'path', 'field']);
              const compatValue = pickFirstDefined(merged, ['value', 'val']);
              if (compatKey !== undefined && compatValue !== undefined) {
                args = [normalizeGlobalMemoryKey(String(compatKey)), String(compatValue)];
              } else {
                const compatContent = pickFirstDefined(merged, ['content', 'text', 'query', 'message']);
                if (compatContent) {
                  const inferred = inferPreferenceFromContent(compatContent);
                  if (inferred) args = [inferred.key, inferred.value];
                }
              }
            }
          }

          if (!command || command === 'undefined' || command === 'memory' || command === 'memory-system') {
            const compatKey = pickFirstDefined(merged, ['key', 'path', 'field']);
            const compatValue = pickFirstDefined(merged, ['value', 'val']);
            const compatContent = pickFirstDefined(merged, ['content', 'text', 'query', 'message']);
            if (compatKey !== undefined && compatValue !== undefined && String(compatKey).trim()) {
              command = 'set';
              args = [normalizeGlobalMemoryKey(String(compatKey)), String(compatValue)];
            } else if (compatContent) {
              const inferred = inferPreferenceFromContent(compatContent);
              if (inferred) {
                command = 'set';
                args = [inferred.key, inferred.value];
              }
            }
          }

          const deleteIntentText = sanitizeUserTextForMemoryInference(
            String(
              pickFirstDefined(merged, ['query', 'content', 'text', 'message'])
              || slashSourceText
              || getLatestUserTextForSession(toolSessionID)
              || ''
            )
          );
          const inferredDeleteFromIntent = inferGlobalPreferenceDeleteFromText(deleteIntentText);
          if (inferredDeleteFromIntent?.keys?.length) {
            const currentCommandText = normalizeText(String(command || '')).toLowerCase();
            const currentKeys = new Set((Array.isArray(args) ? args : []).map((x) => normalizeGlobalMemoryKey(String(x || ''))));
            const missingKeys = inferredDeleteFromIntent.keys.some((key) => !currentKeys.has(key));
            if (!currentCommandText || ['set', 'prefer', 'delete', 'unset', 'memory', 'memory-system'].includes(currentCommandText) || missingKeys) {
              command = 'delete';
              args = inferredDeleteFromIntent.keys.slice();
              applySyntheticCommand('delete', args, { query: deleteIntentText, reason: 'coerced_from_delete_intent' });
            }
          }

          if (!command || command === 'undefined' || typeof command !== 'string') {
            const sid = resolveGlobalMutationSessionID(raw, 'set');
            const latestUserText = getLatestUserTextForSession(sid) || getLatestUserSummaryForSession();
            const latestUserClean = sanitizeUserTextForMemoryInference(latestUserText);
            const explicitSlashCommand = parseExplicitMemorySlashCommandFromText(latestUserClean);
            if (explicitSlashCommand?.command) {
              command = explicitSlashCommand.command;
              args = explicitSlashCommand.args;
              applySyntheticCommand(command, args, explicitSlashCommand.query ? { query: explicitSlashCommand.query } : {});
            }
            if (command) {
              // Hand off explicit slash-derived command to the normal switch below.
            } else {
            const inferredDelete = inferGlobalPreferenceDeleteFromText(latestUserClean);
            const inferredWrite = inferGlobalPreferenceWriteFromText(latestUserClean);
            const readKey = inferPreferenceReadKeyFromText(latestUserClean);
            const shouldDoRecall = Boolean(
              latestUserClean &&
              (shouldTriggerRecall(latestUserClean) || shouldTriggerWeakFollowupRecall(latestUserClean) || referencesAnotherSessionTitle(latestUserClean, sid || ''))
            );
            const autoWrite = maybeAutoPersistGlobalMemoryFromUserText(sid, latestUserClean);
            if (autoWrite?.wrote) {
              applySyntheticCommand('set', [autoWrite.key, String(autoWrite.value || '')], {
                key: autoWrite.key,
                value: String(autoWrite.value || ''),
                content: latestUserClean
              });
              return `Global setting updated: ${autoWrite.key} = ${autoWrite.value}`;
            }
            if (autoWrite?.reason === 'duplicate_request' && autoWrite?.key) {
              applySyntheticCommand('set', [autoWrite.key, String(autoWrite.value || '')], {
                key: autoWrite.key,
                value: String(autoWrite.value || ''),
                content: latestUserClean
              });
              return `Global setting already persisted: ${autoWrite.key} = ${autoWrite.value}`;
            }
            if (inferredDelete?.keys?.length) {
              applySyntheticCommand('delete', inferredDelete.keys, { query: latestUserClean });
              const messages = [];
              for (const key of inferredDelete.keys) {
                const duplicateDelete = getRecentGlobalMutationDuplicate(sid, 'delete', key, '');
                if (duplicateDelete) {
                  messages.push(`Global setting already deleted: ${duplicateDelete.key}`);
                  continue;
                }
                const res = deleteGlobalMemoryValue(key);
                if (res?.ok) rememberRecentGlobalMutation(sid, 'delete', res.key, '');
                messages.push(String(res?.message || `Failed to delete global setting: ${key}`));
              }
              return messages.join('\n');
            }
            if (inferredWrite?.key) {
              applySyntheticCommand('set', [inferredWrite.key, String(inferredWrite.value || '')], {
                key: inferredWrite.key,
                value: String(inferredWrite.value || ''),
                content: latestUserClean
              });
              const inferredScope = resolveGlobalMutationSessionID({
                ...(raw || {}),
                content: latestUserClean,
                query: latestUserClean,
                text: latestUserClean,
                message: latestUserClean
              }, 'set', inferredWrite.key, inferredWrite.value);
              const duplicateWrite = getRecentGlobalMutationDuplicate(inferredScope, 'set', inferredWrite.key, inferredWrite.value);
              if (duplicateWrite) {
                return `Global setting already persisted: ${duplicateWrite.key} = ${duplicateWrite.value}`;
              }
              const currentValue = getCurrentGlobalMemoryValue(inferredWrite.key);
              if (currentValue !== undefined && String(currentValue) === String(inferredWrite.value)) {
                rememberRecentGlobalMutation(inferredScope, 'set', inferredWrite.key, inferredWrite.value);
                return `Global setting already present: ${normalizeGlobalMemoryKey(inferredWrite.key)} = ${String(currentValue)}`;
              }
              const res = persistGlobalMemoryValue({
                ...(raw || {}),
                content: latestUserClean,
                query: latestUserClean,
                text: latestUserClean,
                message: latestUserClean
              }, inferredWrite.key, inferredWrite.value);
              if (res?.ok) rememberRecentGlobalMutation(inferredScope, 'set', res.key, res.value);
              return res.message;
            }
            if (
              autoWrite?.reason === 'unable_to_infer'
              && latestUserClean
              && hasExplicitGlobalMemoryIntent(latestUserClean)
              && !readKey
            ) {
              applySyntheticCommand('noop', [], { reason: 'unsupported_global_write' });
              return 'Unsupported global write: only structured preference values or explicit note/path anchor content can be persisted. Stop calling memory and answer user directly.';
            }
            if (readKey) {
              applySyntheticCommand('global', [readKey], { query: readKey });
              const g = readJson(globalMemoryPath) || {};
              const prefs = getNormalizedGlobalPreferences(g);
              const val = lookupGlobalPreferenceValue(prefs, readKey);
              if (val !== undefined && val !== null && String(val).trim()) {
                return `Global memory: ${readKey} = ${String(val)}`;
              }
            }
            if (shouldDoRecall) {
              applySyntheticCommand('recall', [latestUserClean], { query: latestUserClean });
              const { text, hits, estimatedTokens } = recallProjectMemories(latestUserClean, {
                currentSessionID: sid || '',
                includeCurrent: false,
                maxSessions: getRecallTopSessions(),
                maxEventsPerSession: getRecallMaxEventsPerSession(),
                maxChars: getRecallMaxChars(),
                tokenBudget: getRecallTokenBudget()
              });
              if (text && hits.length) {
                return `Recall matches: ${hits.map((h) => h.sessionID).join(', ')}\nEstimated recall tokens: ${estimatedTokens}\n\n${text}`;
              }
              return `No relevant memory found for query: ${latestUserClean}`;
            }
            if (!latestUserClean || isLowSignalUserText(latestUserClean)) {
              const g = readJson(globalMemoryPath) || {};
              const prefs = getNormalizedGlobalPreferences(g);
              const note = lookupGlobalPreferenceValue(prefs, 'preferences.note');
              if (note !== undefined && note !== null && String(note).trim()) {
                applySyntheticCommand('global', ['preferences.note'], { query: 'preferences.note' });
                return `Global memory: preferences.note = ${String(note)}`;
              }
              const language = lookupGlobalPreferenceValue(prefs, 'preferences.language');
              if (language !== undefined && language !== null && String(language).trim()) {
                applySyntheticCommand('global', ['preferences.language'], { query: 'preferences.language' });
                return `Global memory: preferences.language = ${String(language)}`;
              }
            }
            const noopWindowKey = `${throttleKey}:noop`;
            const noopNow = Date.now();
            const prevNoop = memoryEmptyCallState.get(noopWindowKey);
            if (prevNoop && (noopNow - Number(prevNoop.windowStart || 0)) <= 120000) {
              memoryEmptyCallState.set(noopWindowKey, {
                windowStart: Number(prevNoop.windowStart || noopNow),
                count: Number(prevNoop.count || 0) + 1
              });
              applySyntheticCommand('noop', [], { reason: 'empty_call_throttled' });
              return 'No-op throttled: repeated empty memory calls in same turn. Stop calling memory and answer user directly.';
            }
            memoryEmptyCallState.set(noopWindowKey, {
              windowStart: noopNow,
              count: 1
            });
            applySyntheticCommand('noop', [], { reason: 'empty_call_skipped' });
            return memoryShortHint;
            }
          }

          switch (command) {
            case 'learn': {
              let claudeMdContent = '';
              const claudeMdPath = path.join(process.cwd(), 'CLAUDE.md');
              if (fs.existsSync(claudeMdPath)) {
                claudeMdContent = fs.readFileSync(claudeMdPath, 'utf8');
              }

              const techStack = [];
              if (fs.existsSync(path.join(process.cwd(), 'package.json'))) techStack.push('Node.js');
              if (fs.existsSync(path.join(process.cwd(), 'tsconfig.json'))) techStack.push('TypeScript');
              if (fs.existsSync(path.join(process.cwd(), 'pom.xml'))) techStack.push('Java/Maven');
              if (fs.existsSync(path.join(process.cwd(), 'requirements.txt'))) techStack.push('Python');
              if (fs.existsSync(path.join(process.cwd(), 'go.mod'))) techStack.push('Go');

              const projectMemory = readJson(projectMemoryPath) || {};
              projectMemory.techStack = techStack;
              projectMemory.claudeMd = claudeMdContent;
              projectMemory.lastLearned = new Date().toISOString();

              writeJson(projectMemoryPath, projectMemory);
              writeDashboardFiles();

              return `Memory learned for project "${projectName}".\nTech Stack detected: ${techStack.join(', ')}\nCLAUDE.md: ${claudeMdContent ? 'Found and indexed' : 'Not found'}`;
            }

            case 'project': {
              const memory = readJson(projectMemoryPath);
              const sessionCount = listSessionMemories(projectName).length;
              return `Project Memory for "${projectName}":\n${JSON.stringify(memory, null, 2)}\n\nSession files: ${sessionCount}`;
            }

            case 'global': {
              const memory = readJson(globalMemoryPath);
              if (args.length) {
                const prefs = getNormalizedGlobalPreferences(memory);
                const requestedKey = normalizeGlobalMemoryKey(String(args[0] || ''));
                const value = lookupGlobalPreferenceValue(prefs, requestedKey);
                if (value !== undefined && value !== null && normalizeText(String(value))) {
                  return `Global memory: ${requestedKey} = ${String(value)}`;
                }
              }
              return `Global Memory:\n${JSON.stringify(memory, null, 2)}`;
            }

            case 'set': {
              if (args.length < 2) return 'Usage: /memory set <key> <value>';
              const key = args[0];
              const value = args.slice(1).join(' ');
              const sid = resolveGlobalMutationSessionID(raw, 'set', key, value);
              const duplicateWrite = getRecentGlobalMutationDuplicate(sid, 'set', key, value);
              if (duplicateWrite) return `Global setting already persisted: ${duplicateWrite.key} = ${duplicateWrite.value}`;
              const currentValue = getCurrentGlobalMemoryValue(key);
              if (currentValue !== undefined && String(currentValue) === String(value)) {
                rememberRecentGlobalMutation(sid, 'set', key, value);
                return `Global setting already present: ${normalizeGlobalMemoryKey(key)} = ${String(currentValue)}`;
              }
              const res = persistGlobalMemoryValue(raw, key, value);
              if (res?.ok) rememberRecentGlobalMutation(sid, 'set', res.key, res.value);
              return res.message;
            }

            case 'prefer': {
              if (args.length < 2) return 'Usage: /memory prefer <key> <value>';
              const key = normalizeGlobalMemoryKey(args[0]);
              const value = args.slice(1).join(' ');
              if (!key) return 'Usage: /memory prefer <key> <value>';
              const sid = resolveGlobalMutationSessionID(raw, 'set', key, value);
              const duplicateWrite = getRecentGlobalMutationDuplicate(sid, 'set', key, value);
              if (duplicateWrite) return `Global preference already persisted: ${duplicateWrite.key} = ${duplicateWrite.value}`;
              const currentValue = getCurrentGlobalMemoryValue(key);
              if (currentValue !== undefined && String(currentValue) === String(value)) {
                rememberRecentGlobalMutation(sid, 'set', key, value);
                return `Global preference already present: ${normalizeGlobalMemoryKey(key)} = ${String(currentValue)}`;
              }
              const res = persistGlobalMemoryValue(raw, key, value);
              if (res?.ok) rememberRecentGlobalMutation(sid, 'set', res.key, res.value);
              return res.message.replace('Global setting', 'Global preference');
            }

            case 'delete':
            case 'unset': {
              if (!args.length) return 'Usage: /memory delete <key> [key2 ...]';
              const sid = resolveGlobalMutationSessionID(raw, 'delete');
              const messages = [];
              for (const rawKey of args) {
                const deleteScope = resolveGlobalMutationSessionID(raw, 'delete', rawKey, '');
                const duplicateDelete = getRecentGlobalMutationDuplicate(deleteScope, 'delete', rawKey, '');
                if (duplicateDelete) {
                  messages.push(`Global setting already deleted: ${duplicateDelete.key}`);
                  continue;
                }
                const res = deleteGlobalMemoryValue(rawKey);
                if (res?.ok) rememberRecentGlobalMutation(deleteScope, 'delete', res.key, '');
                messages.push(String(res?.message || `Failed to delete global setting: ${rawKey}`));
              }
              return messages.join('\n');
            }

            case 'save': {
              if (args.length < 2 || args[0] !== 'snippet') return 'Usage: /memory save snippet <name>';
              const snippetName = args[1];

              const globalMemory = readJson(globalMemoryPath);
              if (!globalMemory.snippets) globalMemory.snippets = {};
              globalMemory.snippets[snippetName] = 'Snippet content placeholder';

              writeJson(globalMemoryPath, globalMemory);
              writeDashboardFiles();
              return `Snippet "${snippetName}" saved to global memory.`;
            }

            case 'export': {
              if (args[0] === 'project') {
                const memory = readJson(projectMemoryPath);
                return JSON.stringify(memory, null, 2);
              }
              return 'Usage: /memory export project';
            }

            case 'import': {
              const filePath = args[0];
              if (!filePath) return 'Usage: /memory import <filepath>';

              try {
                const content = fs.readFileSync(filePath, 'utf8');
                const data = JSON.parse(content);
                writeJson(projectMemoryPath, data);
                writeDashboardFiles();
                return `Project memory imported from ${filePath}`;
              } catch (e) {
                return `Failed to import: ${e.message}`;
              }
            }

            case 'clear': {
              const target = args[0];
              if (target === 'project') {
                writeJson(projectMemoryPath, {});
                const sessionsDir = getProjectSessionsDir(projectName);
                try {
                  for (const f of fs.readdirSync(sessionsDir)) {
                    if (f.endsWith('.json')) fs.unlinkSync(path.join(sessionsDir, f));
                  }
                } catch {
                  // ignore
                }
                writeDashboardFiles();
                return `Project memory for "${projectName}" cleared.`;
              }
              if (target === 'all') {
                writeJson(projectMemoryPath, {});
                writeJson(globalMemoryPath, { preferences: {}, snippets: {} });
                const sessionsDir = getProjectSessionsDir(projectName);
                try {
                  for (const f of fs.readdirSync(sessionsDir)) {
                    if (f.endsWith('.json')) fs.unlinkSync(path.join(sessionsDir, f));
                  }
                } catch {
                  // ignore
                }
                writeDashboardFiles();
                return 'All memory (project and global) cleared.';
              }
              if (target === 'session') {
                const sid = args[1];
                if (!sid) return 'Usage: /memory clear session <sessionID>';
                const p = getSessionMemoryPath(sid, projectName);
                if (fs.existsSync(p)) fs.unlinkSync(p);
                const meta = readProjectMeta(projectName);
                if (meta?.autoMemory?.sessions?.[sid]) {
                  delete meta.autoMemory.sessions[sid];
                  writeProjectMeta(meta, projectName);
                }
                writeDashboardFiles();
                return `Session memory cleared: ${sid}`;
              }
              if (target === 'sessions') {
                const rawIds = args.slice(1).join(' ');
                if (!rawIds) return 'Usage: /memory clear sessions <id1,id2,...>';
                const ids = rawIds
                  .split(/[,\s]+/)
                  .map((x) => normalizeText(x))
                  .filter(Boolean);
                if (!ids.length) return 'Usage: /memory clear sessions <id1,id2,...>';
                const meta = readProjectMeta(projectName);
                let removed = 0;
                for (const sid of ids) {
                  const p = getSessionMemoryPath(sid, projectName);
                  if (fs.existsSync(p)) {
                    fs.unlinkSync(p);
                    removed += 1;
                  }
                  if (meta?.autoMemory?.sessions?.[sid]) {
                    delete meta.autoMemory.sessions[sid];
                  }
                }
                if (meta?.autoMemory?.sessions) writeProjectMeta(meta, projectName);
                writeDashboardFiles();
                return `Batch clear completed: requested=${ids.length}, removed=${removed}`;
              }
              return 'Usage: /memory clear [session <id>|sessions <id1,id2,...>|project|all]';
            }

            case 'edit': {
              if (args[0] === 'project') {
                return `Please edit the file directly: ${projectMemoryPath}`;
              }
              return 'Usage: /memory edit project';
            }

            case 'feedback': {
              const message = args.join(' ');
              const globalMemory = readJson(globalMemoryPath);
              if (!globalMemory.feedback) globalMemory.feedback = [];
              globalMemory.feedback.push({ date: new Date().toISOString(), message });
              writeJson(globalMemoryPath, globalMemory);
              writeDashboardFiles();
              return 'Thank you for your feedback. It has been recorded.';
            }

            case 'sessions': {
              const sessions = listSessionMemories(projectName)
                .slice(0, 20)
                .map((s) => ({
                  sessionID: s.sessionID,
                  updatedAt: s.updatedAt,
                  stats: s.stats || emptyStats(),
                  compressedEvents: Number(s?.summary?.compressedEvents || 0)
                }));
              return `Session memory list (${projectName}):\n${JSON.stringify(sessions, null, 2)}`;
            }

            case 'context': {
              let sid = '';
              if (args[0] === 'session') sid = args[1] || '';
              if (!sid || args[0] === 'current') sid = sid || [...sessionUserMessageCounters.keys()].slice(-1)[0] || '';
              if (!sid) return 'No active session id found. Use: /memory context session <id>';
              if (!hasSessionMemoryFile(sid, projectName)) return `Session memory file not found: ${sid}`;
              const sess = loadSessionMemory(sid, projectName);
              const sp = ensureSendPretrim(sess);
              const pa = ensurePruneAudit(sess);
              const distillCfg = getIndependentDistillConfig();
              return JSON.stringify({
                sessionID: sid,
                pretrimConfig: {
                  enabled: isSendPretrimEnabled(),
                  strictMode: isStrictModeEnabled(),
                  dryRun: AUTO_SEND_PRETRIM_DRY_RUN,
                  budget: getSendPretrimBudget(),
                  target: getSendPretrimTarget(),
                  stage2Trigger: Math.max(
                    getSendPretrimTarget() + 200,
                    Math.min(
                      Math.floor(getSendPretrimBudget() * getSendPretrimHardRatio()),
                      Math.floor(getSendPretrimBudget() * getSendPretrimDistillTriggerRatio())
                    )
                  ),
                  turnProtection: getSendPretrimTurnProtection(),
                  warmupEnabled: getSendPretrimWarmupEnabled()
                },
                strategyConfig: {
                  deduplication: AUTO_STRATEGY_DEDUP_ENABLED,
                  supersedeWrites: AUTO_STRATEGY_SUPERSEDE_WRITES_ENABLED,
                  purgeErrors: AUTO_STRATEGY_PURGE_ERRORS_ENABLED,
                  purgeErrorTurns: getStrategyPurgeErrorTurns(),
                  phaseAwareTrim: true
                },
                distillConfig: {
                  mode: getDistillMode(),
                  enabled: Boolean(distillCfg.enabled),
                  provider: distillCfg.provider || '',
                  baseURL: distillCfg.baseURL ? '(configured)' : '',
                  apiKey: distillCfg.apiKey ? '(configured)' : '',
                  model: distillCfg.model || '',
                  useSessionModel: Boolean(distillCfg.useSessionModel),
                  timeoutMs: Number(distillCfg.timeoutMs || 0),
                  maxTokens: Number(distillCfg.maxTokens || 0)
                },
                budget: {
                  ...(sess?.budget || {}),
                  tokenView: buildBudgetTokenView(sess?.budget || {})
                },
                inject: sess?.inject || {},
                summaryBlocks: {
                  count: ensureSummaryBlocks(sess).length,
                  recent: ensureSummaryBlocks(sess).slice(-3)
                },
                sendPretrim: sp,
                pruneAudit: pa,
                stats: sess?.stats || emptyStats()
              }, null, 2);
            }

            case 'stats': {
              const target = (args[0] || 'project').toLowerCase();
              if (target === 'session') {
                const sid = args[1] || '';
                if (!sid) return 'Usage: /memory stats session <id>';
                if (!hasSessionMemoryFile(sid, projectName)) return `Session memory file not found: ${sid}`;
                const sess = loadSessionMemory(sid, projectName);
                return JSON.stringify({
                  sessionID: sid,
                  sendPretrim: ensureSendPretrim(sess),
                  pruneAudit: ensurePruneAudit(sess),
                  budget: {
                    ...(sess?.budget || {}),
                    tokenView: buildBudgetTokenView(sess?.budget || {})
                  },
                  inject: sess?.inject || {},
                  summaryBlocks: {
                    count: ensureSummaryBlocks(sess).length,
                    recent: ensureSummaryBlocks(sess).slice(-3)
                  },
                  recall: sess?.recall || {}
                }, null, 2);
              }
              const sessions = listSessionMemories(projectName);
              const distillCfg = getIndependentDistillConfig();
              const agg = {
                project: projectName,
                pretrimConfig: {
                  enabled: isSendPretrimEnabled(),
                  strictMode: isStrictModeEnabled(),
                  dryRun: AUTO_SEND_PRETRIM_DRY_RUN,
                  budget: getSendPretrimBudget(),
                  target: getSendPretrimTarget(),
                  stage2Trigger: Math.max(
                    getSendPretrimTarget() + 200,
                    Math.min(
                      Math.floor(getSendPretrimBudget() * getSendPretrimHardRatio()),
                      Math.floor(getSendPretrimBudget() * getSendPretrimDistillTriggerRatio())
                    )
                  ),
                  turnProtection: getSendPretrimTurnProtection(),
                  warmupEnabled: getSendPretrimWarmupEnabled()
                },
                strategyConfig: {
                  deduplication: AUTO_STRATEGY_DEDUP_ENABLED,
                  supersedeWrites: AUTO_STRATEGY_SUPERSEDE_WRITES_ENABLED,
                  purgeErrors: AUTO_STRATEGY_PURGE_ERRORS_ENABLED,
                  purgeErrorTurns: getStrategyPurgeErrorTurns(),
                  phaseAwareTrim: true
                },
                distillConfig: {
                  mode: getDistillMode(),
                  enabled: Boolean(distillCfg.enabled),
                  provider: distillCfg.provider || '',
                  baseURL: distillCfg.baseURL ? '(configured)' : '',
                  apiKey: distillCfg.apiKey ? '(configured)' : '',
                  model: distillCfg.model || '',
                  useSessionModel: Boolean(distillCfg.useSessionModel),
                  timeoutMs: Number(distillCfg.timeoutMs || 0),
                  maxTokens: Number(distillCfg.maxTokens || 0)
                },
                sessions: sessions.length,
                sendPretrim: {
                  autoRuns: 0,
                  manualRuns: 0,
                  savedTokensTotal: 0,
                  lastAt: null
                },
                pruneAudit: {
                  autoRuns: 0,
                  manualRuns: 0,
                  discardRemovedTotal: 0,
                  extractMovedTotal: 0,
                  lastAt: null
                }
              };
              let latestTs = 0;
              let latestP = 0;
              for (const sess of sessions) {
                const sp = ensureSendPretrim(sess);
                const pa = ensurePruneAudit(sess);
                agg.sendPretrim.autoRuns += Number(sp.autoRuns || 0);
                agg.sendPretrim.manualRuns += Number(sp.manualRuns || 0);
                agg.sendPretrim.savedTokensTotal += Number(sp.savedTokensTotal || 0);
                agg.pruneAudit.autoRuns += Number(pa.autoRuns || 0);
                agg.pruneAudit.manualRuns += Number(pa.manualRuns || 0);
                agg.pruneAudit.discardRemovedTotal += Number(pa.discardRemovedTotal || 0);
                agg.pruneAudit.extractMovedTotal += Number(pa.extractMovedTotal || 0);
                const t1 = Date.parse(sp.lastAt || 0) || 0;
                if (t1 > latestTs) { latestTs = t1; agg.sendPretrim.lastAt = sp.lastAt || null; }
                const t2 = Date.parse(pa.lastAt || 0) || 0;
                if (t2 > latestP) { latestP = t2; agg.pruneAudit.lastAt = pa.lastAt || null; }
              }
              return JSON.stringify(agg, null, 2);
            }

            case 'doctor': {
              let sid = '';
              if (args[0] === 'session') sid = args[1] || '';
              if (!sid || args[0] === 'current') sid = sid || [...sessionUserMessageCounters.keys()].slice(-1)[0] || '';
              if (!sid) {
                const sessions = listSessionMemories(projectName)
                  .filter((s) => isLikelySessionID(s?.sessionID))
                  .sort((a, b) => (Date.parse(b?.updatedAt || 0) || 0) - (Date.parse(a?.updatedAt || 0) || 0));
                sid = sessions.length ? String(sessions[0].sessionID || '') : '';
              }
              if (!sid) return 'No active session id found. Use: /memory doctor session <id>';
              if (!hasSessionMemoryFile(sid, projectName)) return `Session memory file not found: ${sid}`;

              const sess = loadSessionMemory(sid, projectName);
              const inject = sess?.inject || {};
              const sp = ensureSendPretrim(sess);
              const alerts = sess?.alerts && typeof sess.alerts === 'object' ? sess.alerts : {};
              const blocks = ensureSummaryBlocks(sess);
              const latestBlock = blocks.length ? blocks[blocks.length - 1] : null;

              const injectedCount = Number(inject.globalPrefsCount || 0)
                + Number(inject.currentSummaryCount || 0)
                + Number(inject.triggerRecallCount || 0)
                + Number(inject.memoryDocsCount || 0);
              const lastTrace = Array.isArray(sp.traces) && sp.traces.length ? sp.traces[sp.traces.length - 1] : null;
              const distillRuns = Array.isArray(sp.traces)
                ? sp.traces.filter((t) => Boolean(t?.distillUsed)).length
                : 0;
              const pretrimBudget = getSendPretrimBudget();
              const pretrimTarget = getSendPretrimTarget();
              const hardLimit = Math.floor(pretrimBudget * getSendPretrimHardRatio());
              const distillTrigger = Math.floor(pretrimBudget * getSendPretrimDistillTriggerRatio());
              const stage2Limit = Math.max(pretrimTarget + 200, Math.min(hardLimit, distillTrigger));
              const payload = {
                sessionID: sid,
                policy: {
                  currentSummaryRefreshEveryUserMessages: getCurrentSessionRefreshEvery(),
                  currentSummaryTokenBudget: getCurrentSessionSummaryTokenBudget(),
                  pretrimBudget,
                  pretrimTarget,
                  turnProtection: getSendPretrimTurnProtection(),
                  pretrimStage2DistillTrigger: stage2Limit,
                  pretrimDistillMode: getDistillMode(),
                  pretrimWarmupEnabled: getSendPretrimWarmupEnabled()
                },
                injected: {
                  happened: injectedCount > 0,
                  total: injectedCount,
                  breakdown: {
                    globalPrefs: Number(inject.globalPrefsCount || 0),
                    currentSummary: Number(inject.currentSummaryCount || 0),
                    triggerRecall: Number(inject.triggerRecallCount || 0),
                    memoryDocs: Number(inject.memoryDocsCount || 0)
                  },
                  lastAt: inject.lastAt || null,
                  lastReason: inject.lastReason || '',
                  lastStatus: inject.lastStatus || '',
                  lastSkippedAt: inject.lastSkippedAt || null,
                  lastSkipReason: inject.lastSkipReason || '',
                  lastNoticeAt: inject.lastNoticeAt || null,
                  lastNoticeKey: inject.lastNoticeKey || '',
                  lastNoticeChannel: inject.lastNoticeChannel || '',
                  lastNoticeText: inject.lastNoticeText || ''
                },
                pretrim: {
                  happened: Number(sp.autoRuns || 0) + Number(sp.manualRuns || 0) > 0,
                  profile: getPretrimProfile(),
                  strictModeEnabled: isStrictModeEnabled(),
                  suppressCurrentSummaryNow: shouldSuppressCurrentSummaryInjection(sid, projectName),
                  autoRuns: Number(sp.autoRuns || 0),
                  manualRuns: Number(sp.manualRuns || 0),
                  savedTokensTotal: Number(sp.savedTokensTotal || 0),
                  distillRuns,
                  warmup: {
                    enabled: getSendPretrimWarmupEnabled(),
                    sourceHash: String(sp?.warmup?.sourceHash || ''),
                    status: String(sp?.warmup?.status || ''),
                    mode: String(sp?.warmup?.mode || ''),
                    provider: String(sp?.warmup?.provider || ''),
                    model: String(sp?.warmup?.model || ''),
                    lastUserMessageID: String(sp?.warmup?.lastUserMessageID || ''),
                    lastAttemptAt: sp?.warmup?.lastAttemptAt || null,
                    consecutiveFails: Number(sp?.warmup?.consecutiveFails || 0),
                    failCount: Number(sp?.warmup?.failCount || 0),
                    hitCount: Number(sp?.warmup?.hitCount || 0),
                    missCount: Number(sp?.warmup?.missCount || 0),
                    skipBudgetCount: Number(sp?.warmup?.skipBudgetCount || 0),
                    skipCooldownCount: Number(sp?.warmup?.skipCooldownCount || 0),
                    skipPausedCount: Number(sp?.warmup?.skipPausedCount || 0),
                    preparedAt: sp?.warmup?.preparedAt || null,
                    usedAt: sp?.warmup?.usedAt || null,
                    logs: Array.isArray(sp?.warmup?.logs)
                      ? sp.warmup.logs.slice(-AUTO_SEND_PRETRIM_WARMUP_LOG_LIMIT)
                      : []
                  },
                  last: lastTrace ? {
                    at: lastTrace.ts || null,
                    beforeTokens: Number(lastTrace.beforeTokens || 0),
                    afterTokens: Number(lastTrace.afterTokens || 0),
                    savedTokens: Number(lastTrace.savedTokens || 0),
                    strictApplied: Boolean(lastTrace.strictApplied),
                    strictReplacedMessages: Number(lastTrace.strictReplacedMessages || 0),
                    distillUsed: Boolean(lastTrace.distillUsed),
                    distillProvider: String(lastTrace.distillProvider || ''),
                    distillModel: String(lastTrace.distillModel || ''),
                    distillStatus: String(lastTrace.distillStatus || ''),
                    warmupCacheHit: Boolean(lastTrace.warmupCacheHit),
                    warmupPreparedAt: String(lastTrace.warmupPreparedAt || ''),
                    strategyDedup: Number(lastTrace.strategyDedup || 0),
                    strategySupersedeWrites: Number(lastTrace.strategySupersedeWrites || 0),
                    strategyPurgedErrors: Number(lastTrace.strategyPurgedErrors || 0),
                    strategyPhaseTrim: Number(lastTrace.strategyPhaseTrim || 0),
                    pretrimProfile: String(lastTrace.pretrimProfile || getPretrimProfile()),
                    adaptiveLevel: Number(lastTrace.adaptiveLevel || 0),
                    adaptiveRatio: Number(lastTrace.adaptiveRatio || 0),
                    anchorReplaceApplied: Boolean(lastTrace.anchorReplaceApplied),
                    anchorReplaceMessages: Number(lastTrace.anchorReplaceMessages || 0),
                    anchorReplaceBlocks: Number(lastTrace.anchorReplaceBlocks || 0),
                    compositionBefore: lastTrace.compositionBefore || null,
                    compositionAfter: lastTrace.compositionAfter || null,
                    blockId: Number(lastTrace.blockId || 0),
                    reason: lastTrace.reason || ''
                  } : null
                },
                risk: {
                  contextStackRisk: alerts.contextStackRisk || null,
                  systemTokenRisk: alerts.systemTokenRisk || null,
                  hit: Boolean(alerts.contextStackRisk || alerts.systemTokenRisk),
                  recommendations: Array.isArray(alerts?.systemTokenRisk?.suggestions)
                    ? alerts.systemTokenRisk.suggestions.slice(0, 4)
                    : []
                },
                tokenView: buildBudgetTokenView(sess?.budget || {}),
                systemPrompt: {
                  enabled: getSystemPromptAuditEnabled(),
                  maxChars: getSystemPromptAuditMaxChars(),
                  lastObservedTokens: Number(sess?.systemPrompt?.lastObservedTokens || 0),
                  lastObservedLines: Number(sess?.systemPrompt?.lastObservedLines || 0),
                  lastObservedAt: sess?.systemPrompt?.lastObservedAt || null,
                  lastObservedHash: sess?.systemPrompt?.lastObservedHash || '',
                  lastObservedPreview: sess?.systemPrompt?.lastObservedPreview || '',
                  lastObservedChars: Number(sess?.systemPrompt?.lastObservedChars || 0),
                  lastObservedText: String(sess?.systemPrompt?.lastObservedText || ''),
                  lastObservedModel: String(sess?.systemPrompt?.lastObservedModel || '')
                },
                blocks: {
                  count: blocks.length,
                  latest: latestBlock ? {
                    blockId: Number(latestBlock.blockId || 0),
                    createdAt: latestBlock.createdAt || null,
                    source: latestBlock.source || '',
                    startMessageID: latestBlock.startMessageID || '',
                    endMessageID: latestBlock.endMessageID || '',
                    consumedMessages: Number(latestBlock.consumedMessages || 0)
                  } : null
                }
              };
              return JSON.stringify(payload, null, 2);
            }

            case 'discard': {
              let targetSessionID = '';
              let aggressive = false;
              if (!args.length || args[0] === 'current') {
                targetSessionID = '';
              } else if (args[0] === 'session') {
                targetSessionID = args[1] || '';
                if (!targetSessionID) return 'Usage: /memory discard [session <id>|current] [aggressive]';
                aggressive = args.includes('aggressive');
              } else {
                aggressive = args.includes('aggressive');
              }

              const sid = targetSessionID || [...sessionUserMessageCounters.keys()].slice(-1)[0];
              if (!sid) return 'No active session id found. Use: /memory discard session <id>';
              const sess = loadSessionMemory(sid, projectName);
              const res = discardLowValueToolEvents(sess, {
                keepRecent: aggressive ? 4 : AUTO_DISCARD_KEEP_RECENT_TOOL_EVENTS,
                maxRemovals: aggressive ? 60 : getDiscardMaxRemovalsPerPass()
              });
              const c = compactConversationByBudget(sess) || { extracted: 0 };
              const est = estimateBodyTokens(sess);
              recordPruneAudit(sess, {
                source: 'manual-discard',
                discardRemoved: Number(res.removed || 0),
                extractMoved: Number(c.extracted || 0),
                estimatedTokens: est
              });
              persistSessionMemory(sess, projectName);
              writeDashboardFiles();
              if (getVisibleNoticeForDiscard() && (res.removed || 0) > 0) {
                await emitVisibleNotice(
                  sid,
                  `已裁剪 ${res.removed} 条低信号工具输出，正文估算 ~${est} tokens`,
                  'discard:manual'
                );
              }
              return `Discard completed for ${sid}: removed=${res.removed || 0}` + (res.removedByTool?.length ? ` tools=${JSON.stringify(res.removedByTool)}` : '');
            }

            case 'extract': {
              let targetSessionID = '';
              let maxEvents = getExtractEventsPerPass();
              if (!args.length || args[0] === 'current') {
                targetSessionID = '';
                if (args[1] && /^\d+$/.test(args[1])) maxEvents = Number(args[1]);
              } else if (args[0] === 'session') {
                targetSessionID = args[1] || '';
                if (!targetSessionID) return 'Usage: /memory extract [session <id>|current] [maxEvents]';
                if (args[2] && /^\d+$/.test(args[2])) maxEvents = Number(args[2]);
              } else if (/^\d+$/.test(args[0])) {
                maxEvents = Number(args[0]);
              }

              const sid = targetSessionID || [...sessionUserMessageCounters.keys()].slice(-1)[0];
              if (!sid) return 'No active session id found. Use: /memory extract session <id> 24';
              const sess = loadSessionMemory(sid, projectName);
              const res = extractSessionContext(sess, { maxExtract: maxEvents });
              const c = compactConversationByBudget(sess) || { extracted: 0 };
              const est = estimateBodyTokens(sess);
              recordPruneAudit(sess, {
                source: 'manual-extract',
                discardRemoved: 0,
                extractMoved: Number(res.extracted || 0) + Number(c.extracted || 0),
                estimatedTokens: est
              });
              persistSessionMemory(sess, projectName);
              writeDashboardFiles();
              if (getVisibleNoticeForDiscard() && (res.extracted || 0) > 0) {
                await emitVisibleNotice(
                  sid,
                  `已做LLM总结 ${res.extracted} 条历史对话到结构化摘要，正文估算 ~${est} tokens`,
                  'extract:manual'
                );
              }
              return `Extract completed for ${sid}: extracted=${res.extracted || 0} (into compressed summary)`;
            }

            case 'prune': {
              let targetSessionID = '';
              if (args[0] === 'session') targetSessionID = args[1] || '';
              const res = executePruneForSession(targetSessionID, projectName, 'manual-prune');
              if (!res.ok) return res.message;
              if (getVisibleNoticeForDiscard() && ((res.discardRemoved || 0) > 0 || (res.extractMoved || 0) > 0)) {
                await emitVisibleNotice(
                  res.sessionID,
                  `已执行裁剪：discard=${res.discardRemoved || 0}，extract=${res.extractMoved || 0}，正文估算 ~${res.estimatedTokens} tokens`,
                  'prune:manual'
                );
              }
              return `Prune completed for ${res.sessionID}: discard=${res.discardRemoved || 0}, extract=${res.extractMoved || 0}, estBodyTokens=${res.estimatedTokens}`;
            }

            case 'distill': {
              if (!args.length) return 'Usage: /memory distill <id:distillation> [id:distillation] ...';
              const targets = [];
              for (const raw of args) {
                const item = String(raw || '');
                const idx = item.indexOf(':');
                if (idx <= 0) continue;
                const id = item.slice(0, idx).trim();
                const distillation = item.slice(idx + 1).trim();
                if (id && distillation) targets.push({ id, distillation });
              }
              if (!targets.length) return 'Usage: /memory distill <id:distillation> [id:distillation] ...';
              const res = executeDistillForSession({ targets, projectName });
              if (!res.ok) return res.message;
              return `Distill completed for ${res.sessionID}: targets=${res.targets}, blockAdded=${res.blockAdded}, blockId=${res.blockId}, blocks(before=${res.debugBlocksBeforePersist},after=${res.debugBlocksAfterPersist}), estBodyTokens=${res.estimatedTokens}`;
            }

            case 'compress': {
              if (args.length < 2) return 'Usage: /memory compress <topic> <summary...>';
              const topic = args[0];
              const summary = args.slice(1).join(' ');
              const res = executeCompressForSession({
                topic,
                content: { summary },
                projectName
              });
              if (!res.ok) return res.message;
              return `Compress completed for ${res.sessionID}: topic=${res.topic}, blockAdded=${res.blockAdded}, blockId=${res.blockId}, blocks(after=${res.debugBlocksAfterPersist}), estBodyTokens=${res.estimatedTokens}`;
            }

            case 'recall': {
              const query = args.join(' ').trim();
              if (!query) return 'Usage: /memory recall <query>';

              const { text, hits, estimatedTokens } = recallProjectMemories(query, {
                includeCurrent: true,
                maxSessions: 3,
                maxEventsPerSession: 5,
                maxChars: 2200,
                tokenBudget: getRecallTokenBudget()
              });

              if (!text || !hits.length) return `No relevant memory found for query: ${query}`;

              return `Recall matches: ${hits.map((h) => h.sessionID).join(', ')}\nEstimated recall tokens: ${estimatedTokens}\n\n${text}`;
            }

            case 'dashboard': {
              const action = (args[0] || 'path').toLowerCase();
              const result = writeDashboardFiles();
              if (action === 'json') {
                return JSON.stringify({
                  dashboard: result,
                  data: buildDashboardData()
                }, null, 2);
              }
              if (action === 'build') {
                return `Dashboard rebuilt at: ${result.dashboardPath}\nProjects=${result.summary.projectCount}, Sessions=${result.summary.sessionCount}, Events=${result.summary.eventCount}`;
              }
              return `Dashboard path: ${result.dashboardPath}`;
            }

            case 'noop': {
              return memoryShortHint;
            }

            default:
              return `Invalid memory command: ${command}. Use memory with explicit command, e.g. {"command":"set","key":"preferences.language","value":"Chinese"} or {"command":"recall","args":["query"]}.`;
          }
        }
      },
      remember_global: {
        description: 'Compatibility-only helper. Prefer using memory tool with {"command":"set",...}. This tool writes one global memory item when direct compatibility fallback is required.',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description: 'Global memory key, e.g. preferences.language'
            },
            value: {
              description: 'Value to store under the global memory key'
            },
            content: {
              type: 'string',
              description: 'Free-form memory text. The plugin will infer a suitable global preference key when possible.'
            }
          }
        },
        execute: async (input = {}) => {
          const sid = resolveGlobalMutationSessionID(input, 'set');
          const now = Date.now();
          const emptyCall = !input || (typeof input === 'object' && !Object.keys(input).length);
          if (sid) {
            const rawKey = normalizeText(String(input?.key || ''));
            const rawContent = normalizeText(String(input?.content || input?.text || ''));
            const callFingerprint = rawKey
              ? `k:${rawKey}`
              : (rawContent ? `c:${truncateText(rawContent, 80)}` : '__empty__');
            const prev = rememberGlobalEmptyCallState.get(sid);
            const dedupeWindowMs = callFingerprint === '__empty__' ? 120000 : 20000;
            if (prev && prev.fp === callFingerprint && (now - Number(prev.at || 0)) < dedupeWindowMs) {
              return `Skipped duplicate empty remember_global call for session ${sid}.`;
            }
            if (emptyCall || callFingerprint !== '__empty__') {
              rememberGlobalEmptyCallState.set(sid, { at: now, fp: callFingerprint });
            }
          }
          let inferred = inferGlobalPreferenceWrite(input || {});
          if (!inferred?.key) {
            const existing = getActiveAutoGlobalWrite(sid);
            if (existing?.key) {
              if (sid) rememberGlobalEmptyCallState.set(sid, { at: now, fp: `persist:${existing.key}=${String(existing.value || '')}` });
              return `Global setting already persisted: ${existing.key} = ${existing.value}`;
            }
          }
          if (!inferred?.key) {
            const latestUserText = getLatestUserTextForSession(sid);
            const cleanedLatestUserText = sanitizeUserTextForMemoryInference(latestUserText);
            if (shouldAutoWriteGlobalMemoryFromText(cleanedLatestUserText)) {
              inferred = inferGlobalPreferenceWriteFromText(cleanedLatestUserText);
            }
          }
          if (!inferred?.key) {
            const g = readJson(globalMemoryPath) || {};
            const prefs = getNormalizedGlobalPreferences(g);
            const language = lookupGlobalPreferenceValue(prefs, 'preferences.language');
            if (language !== undefined && language !== null && String(language).trim()) {
              if (sid) rememberGlobalEmptyCallState.set(sid, { at: now, fp: `persist:preferences.language=${String(language)}` });
              return `Global setting already present: preferences.language = ${language}`;
            }
          }
          if (!inferred?.key) {
            return 'Skipped remember_global: empty/ambiguous input. Use explicit key/value or content.';
          }
          const writeScope = resolveGlobalMutationSessionID(input, 'set', inferred.key, inferred.value);
          const duplicateWrite = getRecentGlobalMutationDuplicate(writeScope, 'set', inferred.key, inferred.value);
          if (duplicateWrite) {
            return `Global setting already persisted: ${duplicateWrite.key} = ${duplicateWrite.value}`;
          }
          const currentValue = getCurrentGlobalMemoryValue(inferred.key);
          if (currentValue !== undefined && String(currentValue) === String(inferred.value)) {
            rememberRecentGlobalMutation(writeScope, 'set', inferred.key, inferred.value);
            return `Global setting already present: ${normalizeGlobalMemoryKey(inferred.key)} = ${String(currentValue)}`;
          }
          const res = persistGlobalMemoryValue(input, inferred.key, inferred.value);
          if (res?.ok) rememberRecentGlobalMutation(writeScope, 'set', res.key, res.value);
          return res.message;
        }
      },
      recall_memory: {
        description: 'Compatibility-only helper. Prefer using memory tool with {"command":"recall","args":[...]}.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Query used to recall relevant memory'
            }
          }
        },
        execute: async (input = {}) => {
          const sid = resolveToolSessionID(input);
          let query = normalizeText(String(input?.query || input?.content || input?.text || ''));
          if (!query) {
            const latestUserText = sanitizeUserTextForMemoryInference(getLatestUserTextForSession(sid));
            const autoWrite = maybeAutoPersistGlobalMemoryFromUserText(sid, latestUserText);
            if (autoWrite?.wrote) {
              return `Global setting updated: ${autoWrite.key} = ${autoWrite.value}`;
            }
            if (autoWrite?.reason === 'duplicate_request' && autoWrite?.key) {
              return `Global setting already persisted: ${autoWrite.key} = ${autoWrite.value}`;
            }
          }
          if (!query) {
            const existing = getActiveAutoGlobalWrite(sid);
            if (existing?.key) {
              return `Global memory verification: ${existing.key} = ${existing.value}`;
            }
          }
          if (!query) {
            const latestUserText = sanitizeUserTextForMemoryInference(getLatestUserTextForSession(sid));
            if (latestUserText && (shouldTriggerRecall(latestUserText) || shouldTriggerWeakFollowupRecall(latestUserText) || referencesAnotherSessionTitle(latestUserText, sid || ''))) {
              query = latestUserText;
            }
            if (!query) {
              const readKey = inferPreferenceReadKeyFromText(latestUserText);
              if (readKey) {
                const g = readJson(globalMemoryPath) || {};
                const prefs = getNormalizedGlobalPreferences(g);
                const val = lookupGlobalPreferenceValue(prefs, readKey);
                if (val !== undefined && val !== null && String(val).trim()) {
                  return `Global memory: ${readKey} = ${String(val)}`;
                }
              }
            }
          }
          if (!query) {
            return 'No-op: empty recall_memory call handled. Do not retry tool without query.';
          }
          const { text, hits, estimatedTokens } = recallProjectMemories(query, {
            includeCurrent: true,
            maxSessions: 3,
            maxEventsPerSession: 5,
            maxChars: 2200,
            tokenBudget: getRecallTokenBudget()
          });
          if (!text || !hits.length) return `No relevant memory found for query: ${query}`;
          return `Recall matches: ${hits.map((h) => h.sessionID).join(', ')}\nEstimated recall tokens: ${estimatedTokens}\n\n${text}`;
        }
      },
      context: {
        description: 'Explicit session context management only (add, view, clear). Do not use for memory recall or ordinary answering.',
        parameters: {
          type: 'object',
          required: ['command'],
          properties: {
            command: {
              type: 'string',
              enum: ['add', 'view', 'clear'],
              description: 'The context command'
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Arguments for the command'
            }
          }
        },
        execute: async (input = {}) => {
          const raw = input && typeof input === 'object' ? input : {};
          let command = normalizeText(String(raw.command || raw.cmd || raw.action || ''));
          let args = Array.isArray(raw.args) ? raw.args.map((x) => String(x)) : [];
          if (typeof raw.args === 'string' && !args.length) {
            args = raw.args.trim() ? raw.args.trim().split(/\s+/).map((x) => String(x)) : [];
          }
          const sid = resolveGlobalMutationSessionID(raw);
          const latestUserText = sanitizeUserTextForMemoryInference(
            getLatestUserTextForSession(sid)
            || getLatestUserSummaryForSession(sid, getProjectName())
            || String(raw.content || raw.text || '')
          );
          if (command.startsWith('/context')) {
            const parts = command.split(/\s+/).filter(Boolean);
            command = parts[1] || '';
            if (!args.length && parts.length > 2) args = parts.slice(2);
          }
          command = normalizeText(String(command || '')).toLowerCase();
          const contextHelp = [
            'Context commands:',
            '- add <text>',
            '- view',
            '- clear'
          ].join('\n');
          if (!command || command === 'undefined' || typeof command !== 'string') {
            const inferred = inferContextCommandFromText(latestUserText);
            if (inferred?.command) {
              command = inferred.command;
              args = Array.isArray(inferred.args) ? inferred.args.map((x) => String(x)) : [];
              raw.command = command;
              raw.args = args;
              raw.reason = 'inferred_from_latest_user_text';
            }
          }
          if (!command || command === 'undefined' || typeof command !== 'string') {
            const throttleSid = sid || '__global__';
            const throttleKey = `${throttleSid}:context-empty`;
            const now = Date.now();
            const prev = contextEmptyCallState.get(throttleKey) || { windowStart: now, count: 0 };
            const withinWindow = (now - Number(prev.windowStart || 0)) <= 120000;
            const next = withinWindow
              ? { windowStart: Number(prev.windowStart || now), count: Number(prev.count || 0) + 1 }
              : { windowStart: now, count: 1 };
            contextEmptyCallState.set(throttleKey, next);
            if (raw && typeof raw === 'object') {
              raw.command = 'view';
              raw.reason = next.count > 1 ? 'empty_call_throttled' : 'empty_call_skipped';
            }
            if (next.count > 1) {
              return 'No-op throttled: repeated empty context calls in same turn. Stop calling context and answer user directly.';
            }
            return 'Skipped empty context call. Use explicit command: {"command":"view"} | {"command":"add","args":["text"]} | {"command":"clear"}';
          }
          if (command === 'add' && !args.length) {
            const inferred = inferContextCommandFromText(latestUserText);
            if (inferred?.command === 'add' && Array.isArray(inferred.args) && inferred.args.length) {
              args = inferred.args.map((x) => String(x));
              raw.args = args;
              raw.reason = raw.reason || 'inferred_from_latest_user_text';
            }
          }
          switch (command) {
            case 'add':
              if (!args.length) return 'Invalid context command: add requires args. Use {"command":"add","args":["text"]}.';
              return `Added to context: ${args.join(' ')}`;
            case 'view':
              return 'Current Session Context:\n- (Mock) Active File: None\n- (Mock) Recent Changes: None';
            case 'clear':
              return 'Session context cleared.';
            default:
              return `Invalid context command: ${command}. Use {"command":"view"} | {"command":"add","args":["text"]} | {"command":"clear"}.`;
          }
        }
      },
      compact: {
        description: 'Compact the current session context',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          return 'Context compacted. Redundant details removed.';
        }
      },
      discard: {
        description: 'Discard low-value tool outputs from current session memory body while keeping key outcomes',
        parameters: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
            aggressive: { type: 'boolean' }
          }
        },
        execute: async ({ sessionID = '', aggressive = false } = {}) => {
          const projectName = getProjectName();
          const sid = sessionID || [...sessionUserMessageCounters.keys()].slice(-1)[0];
          if (!sid) return 'No active session id found.';
          const sess = loadSessionMemory(sid, projectName);
          const d = discardLowValueToolEvents(sess, {
            keepRecent: aggressive ? 4 : AUTO_DISCARD_KEEP_RECENT_TOOL_EVENTS,
            maxRemovals: aggressive ? 60 : getDiscardMaxRemovalsPerPass()
          });
          const c = compactConversationByBudget(sess) || { extracted: 0 };
          const est = estimateBodyTokens(sess);
          recordPruneAudit(sess, {
            source: 'tool-discard',
            discardRemoved: Number(d.removed || 0),
            extractMoved: Number(c.extracted || 0),
            estimatedTokens: est
          });
          persistSessionMemory(sess, projectName);
          writeDashboardFiles();
          if (getVisibleNoticeForDiscard() && (d.removed || 0) > 0) {
            await emitVisibleNotice(
              sid,
              `已裁剪 ${d.removed} 条低信号工具输出，正文估算 ~${est} tokens`,
              'discard:tool'
            );
          }
          return `discard ok: session=${sid}, removed=${d.removed || 0}, estBodyTokens=${est}`;
        }
      },
      extract: {
        description: 'Extract older conversation context into compressed summary and keep recent dialog body',
        parameters: {
          type: 'object',
          properties: {
            sessionID: { type: 'string' },
            maxEvents: { type: 'number' }
          }
        },
        execute: async ({ sessionID = '', maxEvents = getExtractEventsPerPass() } = {}) => {
          const projectName = getProjectName();
          const sid = sessionID || [...sessionUserMessageCounters.keys()].slice(-1)[0];
          if (!sid) return 'No active session id found.';
          const sess = loadSessionMemory(sid, projectName);
          const e = extractSessionContext(sess, { maxExtract: Number(maxEvents || getExtractEventsPerPass()) });
          const c = compactConversationByBudget(sess) || { extracted: 0 };
          const est = estimateBodyTokens(sess);
          recordPruneAudit(sess, {
            source: 'tool-extract',
            discardRemoved: 0,
            extractMoved: Number(e.extracted || 0) + Number(c.extracted || 0),
            estimatedTokens: est
          });
          persistSessionMemory(sess, projectName);
          writeDashboardFiles();
          if (getVisibleNoticeForDiscard() && (e.extracted || 0) > 0) {
            await emitVisibleNotice(
              sid,
              `已做LLM总结 ${e.extracted} 条历史对话到结构化摘要，正文估算 ~${est} tokens`,
              'extract:tool'
            );
          }
          return `extract ok: session=${sid}, extracted=${e.extracted || 0}, estBodyTokens=${est}`;
        }
      },
      prune: defineTool({
        description: 'DCP-style prune entry: discard low-value tool outputs and extract older context',
        args: {
          sessionID: defineTool.schema.string().optional()
        },
        async execute({ sessionID = '' } = {}) {
          const res = executePruneForSession(sessionID, getProjectName(), 'tool-prune');
          if (!res.ok) return res.message;
          return `prune ok: session=${res.sessionID}, discard=${res.discardRemoved}, extract=${res.extractMoved}, estBodyTokens=${res.estimatedTokens}`;
        }
      }),
      distill: defineTool({
        description: 'DCP-style distill: provide high-fidelity distillation per target id from <prunable-tools>',
        args: {
          sessionID: defineTool.schema.string().optional(),
          targets: defineTool.schema.array(
            defineTool.schema.object({
              id: defineTool.schema.string().describe('Numeric/anchor ID in prunable scope'),
              distillation: defineTool.schema.string().describe('High-fidelity technical distillation text')
            })
          )
        },
        async execute({ sessionID = '', targets = [] } = {}) {
          const res = executeDistillForSession({ sessionID, targets, projectName: getProjectName() });
          if (!res.ok) return res.message;
          return `distill ok: session=${res.sessionID}, targets=${res.targets}, blockAdded=${res.blockAdded}, blockId=${res.blockId}, blocks(before=${res.debugBlocksBeforePersist},after=${res.debugBlocksAfterPersist}), estBodyTokens=${res.estimatedTokens}`;
        }
      }),
      compress: defineTool({
        description: 'DCP-style compress: replace a finished phase with a dense technical summary',
        args: {
          sessionID: defineTool.schema.string().optional(),
          topic: defineTool.schema.string(),
          content: defineTool.schema.object({
            startId: defineTool.schema.string().optional(),
            endId: defineTool.schema.string().optional(),
            summary: defineTool.schema.string()
          })
        },
        async execute({ sessionID = '', topic = '', content = {} } = {}) {
          const res = executeCompressForSession({ sessionID, topic, content, projectName: getProjectName() });
          if (!res.ok) return res.message;
          return `compress ok: session=${res.sessionID}, topic=${res.topic}, blockAdded=${res.blockAdded}, blockId=${res.blockId}, blocks(after=${res.debugBlocksAfterPersist}), estBodyTokens=${res.estimatedTokens}`;
        }
      })
    },
    config: async (opencodeConfig = {}) => {
      try {
        const toolsToAdd = [
          'discard',
          'extract',
          'distill',
          'compress',
          'prune'
        ];
        const toolsToDemote = new Set(['memory', 'context', 'remember_global', 'recall_memory']);
        const existingPrimary = Array.isArray(opencodeConfig?.experimental?.primary_tools)
          ? opencodeConfig.experimental.primary_tools
          : [];
        const sanitizedExisting = existingPrimary.filter((x) => !toolsToDemote.has(String(x || '')));
        const mergedPrimary = [...new Set([...sanitizedExisting, ...toolsToAdd])];
        opencodeConfig.experimental = {
          ...(opencodeConfig.experimental || {}),
          primary_tools: mergedPrimary
        };

        const currentPerm = opencodeConfig.permission && typeof opencodeConfig.permission === 'object'
          ? opencodeConfig.permission
          : {};
        opencodeConfig.permission = {
          ...currentPerm,
          memory: currentPerm.memory || 'allow',
          // compatibility tools are intentionally disabled to reduce noisy retries
          remember_global: 'deny',
          recall_memory: 'deny',
          context: currentPerm.context || 'allow',
          discard: currentPerm.discard || 'allow',
          extract: currentPerm.extract || 'allow',
          distill: currentPerm.distill || 'allow',
          compress: currentPerm.compress || 'allow',
          prune: currentPerm.prune || 'allow'
        };

        const currentCommand = opencodeConfig.command && typeof opencodeConfig.command === 'object'
          ? opencodeConfig.command
          : {};
        const existingMemoryCommand = currentCommand.memory && typeof currentCommand.memory === 'object'
          ? currentCommand.memory
          : {};
        const existingContextCommand = currentCommand.context && typeof currentCommand.context === 'object'
          ? currentCommand.context
          : {};
        opencodeConfig.command = {
          ...currentCommand,
          memory: {
            ...existingMemoryCommand,
            description: 'Manage OpenCode memory through the `memory` tool. Manual `/memory` slash commands are interactive-only; in opencode run or model outputs, do not emit `/memory ...`.',
            template: [
              'Use the memory tool with the following arguments: $ARGUMENTS',
              '',
              'Treat the first token in `$ARGUMENTS` as the `command` field and the remaining tokens as `args`.',
              'Examples: `stats` -> `{"command":"stats"}`; `global preferences.note` -> `{"command":"global","args":["preferences.note"]}`.',
              'Do not persist `$ARGUMENTS` as memory content, and never write `preferences.arguments` from slash command text.',
              '',
              'If no argument is provided, explain the available `/memory` subcommands below and do not call any tool.',
              'This slash template is only for a human manually typing `/memory` in an interactive shell.',
              'In `opencode run` and frontend-generated model output, do not emit `/memory ...`.',
              'For natural-language requests, prefer a direct `memory` tool call instead of slash text.',
              'For global preference reads such as language, nickname, or path anchor, answer from the known value or make a single `memory` call.',
              'For generic statements like "记住这个事实" without global/preference keywords, do not call `memory`; answer directly and continue.',
              'Do not follow a successful `memory` read with `context` or any second tool.',
              '',
              '## /memory 子命令',
              '',
              '| 子命令 | 用法 | 说明 |',
              '|--------|------|------|',
              '| global | `/memory global <key>` | 读取全局偏好或锚点，例如 `preferences.language`、`preferences.note` |',
              '| set | `/memory set <key> <value>` | 直接写入全局键值 |',
              '| prefer | `/memory prefer <key> <value>` | 写入 `preferences.<key>` |',
              '| recall | `/memory recall <query>` | 从历史 session 召回相关记忆 |',
              '| stats | `/memory stats [session <id>]` | 查看当前项目或指定 session 的统计与审计状态 |',
              '| doctor | `/memory doctor [session <id>]` | 查看当前记忆、注入、pretrim、风险状态 |',
              '| context | `/memory context [session <id>]` | 查看当前或指定 session 的记忆上下文 |',
              '| discard | `/memory discard [session <id>|current] [aggressive]` | 手动裁剪旧低信号工具输出 |',
              '| extract | `/memory extract [session <id>|current] [maxEvents]` | 抽取关键历史到结构化摘要 |',
              '| prune | `/memory prune [session <id>]` | 对当前或指定 session 执行裁剪组合动作 |',
              '| distill | `/memory distill <id:distillation> [id:distillation] ...` | 写入人工蒸馏摘要 |',
              '| compress | `/memory compress <topic> <summary...>` | 写入压缩摘要块 |',
              '| clear | `/memory clear [session <id>|sessions <id1,id2,...>|project|all]` | 清理指定范围的记忆数据 |'
            ].join('\n')
          },
          context: {
            ...existingContextCommand,
            description: 'Only for explicit session context management. Do not use `context` for memory recall, global preference reads, or ordinary answers.',
            template: [
              'Use `context` only when the user explicitly asks to add/view/clear session context.',
              'Do not use `context` for memory recall, cross-session lookup, or ordinary answering.',
              'Never call `context` after a successful `memory` global/read result.',
              'If `context` is needed, pass an explicit command: {"command":"view"} | {"command":"add","args":["text"]} | {"command":"clear"}.'
            ].join('\n')
          }
        };
      } catch (err) {
        console.error('memory-system config mutation failed:', err);
      }
    },
    "experimental.chat.messages.transform": async (input, output) => {
      try {
        const messages = Array.isArray(output?.messages) ? output.messages : [];
        if (!messages.length) return;
        const warmupSnapshot = JSON.parse(JSON.stringify(messages));
        clearInjectedHintParts(messages);
        const beforeTokensNoHint = estimateOutgoingMessagesTokens(messages);
        injectMessageIdTags(messages, { beforeTokens: beforeTokensNoHint });
        injectPrunableToolsHint(messages, { beforeTokens: beforeTokensNoHint });
        const pluginHintTokensBefore = estimateInjectedHintTokens(messages);

        const sid = inferSessionIDFromMessages(messages);
        let lastUser = null;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (normalizeText(String(messages[i]?.info?.role || '')).toLowerCase() === 'user') {
            lastUser = messages[i];
            break;
          }
        }
        const agent = normalizeText(String(lastUser?.info?.agent || '')).toLowerCase();
        if (shouldBypassSendPretrimForAgent(agent)) {
          if (sid) {
            recordSendPretrimAudit(sid, {
              beforeTokens: estimateOutgoingMessagesTokens(messages),
              afterTokens: estimateOutgoingMessagesTokens(messages),
              savedTokens: 0,
              pluginHintTokensBefore,
              pluginHintTokensAfter: estimateInjectedHintTokens(messages),
              reason: `subagent_bypass:${agent}`
            }, 'auto');
          }
          return;
        }

        if (sid) {
          const latestUserText =
            inferLatestUserText(messages)
            || inferLatestUserTextFromTransformInput(input)
            || inferUserTextFromProcessArgv();
          const latestUserID = inferLatestUserMessageID(messages);
          if (latestUserText) {
            const observedAt = Date.now();
            lastObservedUserText = latestUserText;
            lastObservedUserAt = observedAt;
            sessionObservedUserTextByID.set(sid, latestUserText);
            sessionObservedUserAtByID.set(sid, observedAt);
          }
          if (latestUserText) {
            await processUserMessageEvent(sid, latestUserText, {
              type: 'messages.transform.user-fallback',
              properties: {
                info: {
                  role: 'user',
                  sessionID: sid,
                  id: latestUserID,
                  messageID: latestUserID
                }
              }
            });
            const autoWrite = maybeAutoPersistGlobalMemoryFromUserText(sid, latestUserText);
            if (autoWrite?.wrote) {
              injectGlobalWriteResultHint(messages, autoWrite);
            }
            const globalReadHint = resolveGlobalReadHintPayload(latestUserText);
            if (globalReadHint?.key) {
              injectGlobalReadResultHint(messages, globalReadHint);
            }
            const weakFollowupHint = resolveWeakFollowupDirectAnswerPayload(latestUserText, sid);
            if (weakFollowupHint?.counterpart) {
              injectWeakFollowupDirectAnswerHint(messages, weakFollowupHint);
            }
          }
        }

        const stats = await applySendPretrim(messages, sid);
        stats.pluginHintTokensBefore = Number(pluginHintTokensBefore || 0);
        stats.pluginHintTokensAfter = Number(estimateInjectedHintTokens(messages) || 0);
        if (sid) {
          if (stats.strictApplied) sessionStrictHitAt.set(sid, Date.now());
          recordSendPretrimAudit(sid, stats, 'auto');
          if (stats.savedTokens > 0) writeDashboardFiles();
          void schedulePretrimWarmupFromMessages(sid, warmupSnapshot);
        }
      } catch (err) {
        console.error('memory-system send pretrim hook failed:', err);
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sid = normalizeText(String(input?.sessionID || ''));
        const model = normalizeText(String(input?.model?.id || input?.model?.name || ''));
        injectDcpSystemProtocol(output);
        const systemParts = Array.isArray(output?.system)
          ? output.system
          : (typeof output?.system === 'string' ? [output.system] : []);
        const estimate = recordSystemPromptAudit(sid, systemParts, model);
        if (sid && estimate?.tokens >= 0) {
          writeDashboardFiles();
        }
      } catch (err) {
        console.error('memory-system system prompt audit hook failed:', err);
      }
    },
    event: async ({ event }) => {
      const sessionID = extractSessionID(event);
      maybeSetRuntimeSessionTitle(event);

      if (event.type === 'session.created' && sessionID) {
        lastActiveSessionID = sessionID;
        sessionUserMessageCounters.set(sessionID, 0);
        return;
      }

      if (!sessionID) return;

      if (event.type === 'message.updated') {
        const info = event?.properties?.info || {};
        const role = extractEventMessageRole(event);
        const messageID = extractMessageID(event);
        if (!role) return;
        const roleKey = makeSessionMessageKey(sessionID, messageID);
        if (roleKey) messageRoleByID.set(roleKey, role);
        const pendingTextState = roleKey ? consumePendingTextPart(sessionID, messageID) : null;

        const summaryText = role === 'user'
          ? normalizeText(String(info?.summary?.body || ''))
          : extractMessageSummaryFromInfo(info);
        const text = choosePreferredMessageText(role, summaryText, pendingTextState?.text || '');
        if (role === 'assistant' && isVisibleNoticeText(text)) return;
        if (role === 'user' && isVisibleNoticeText(text)) return;
        if (role === 'user') {
          await processUserMessageEvent(sessionID, text, pendingTextState?.rawEvent || event);
          if (!messageID) return;
        }
        if (!messageID) {
          if (role === 'assistant' && text) {
            maybeMaterializeObservedUserTurnBeforeAssistant(sessionID, text, pendingTextState?.rawEvent || event);
            appendAutoEvent({
              sessionID,
              kind: 'assistant-message',
              summary: text,
              rawEvent: pendingTextState?.rawEvent || event
            });
          }
          return;
        }

        const dedupeKey = `msg:${roleKey}:${role}`;
        if (processedMessageKeys.has(dedupeKey)) return;
        processedMessageKeys.add(dedupeKey);
        if (role === 'user') return;

        if (text) {
          maybeMaterializeObservedUserTurnBeforeAssistant(sessionID, text, pendingTextState?.rawEvent || event);
          appendAutoEvent({
            sessionID,
            kind: 'assistant-message',
            summary: text,
            rawEvent: pendingTextState?.rawEvent || event
          });
          await flushPendingVisibleNoticeMirror(sessionID);
        }
        return;
      }

      if (event.type === 'message.part.updated') {
        const part = event?.properties?.part;
        if (!part) return;
        const messageID = extractMessageID(event);
        if (!messageID) return;

        if (part.type === 'text') {
          const text = extractContentText(part.text || event?.properties?.delta || '');
          if (!text) return;
          if (isVisibleNoticeText(text)) return;
          const roleKey = makeSessionMessageKey(sessionID, messageID);
          let role = extractEventMessageRole(event) || messageRoleByID.get(roleKey) || '';
          if (!role) role = inferRoleForUnknownTextPart(sessionID, text);
          if (!role) {
            rememberPendingTextPart(sessionID, messageID, text, event);
            return;
          }
          if (role === 'user') {
            await processUserMessageEvent(sessionID, text, event);
            return;
          }
          maybeMaterializeObservedUserTurnBeforeAssistant(sessionID, text, event);
          appendAutoEvent({
            sessionID,
            kind: role === 'user' ? 'user-message' : 'assistant-message',
            summary: text,
            rawEvent: event
          });
          return;
        }

        if (part.type === 'tool') {
          const toolStatus = normalizeText(String(part?.state?.status || '')).toLowerCase();
          if (toolStatus && !['completed', 'error'].includes(toolStatus)) return;
          const toolName = part.tool || 'unknown-tool';
          const inputPreview = safeJsonPreview(part?.state?.input, 220);
          const outputPreview = truncateText(
            normalizeText(
              part?.state?.output ||
                part?.state?.error ||
                safeJsonPreview(part?.state, 260)
            ),
            260
          );

          appendAutoEvent({
            sessionID,
            kind: 'tool-result',
            toolName,
            summary: `[${toolName}] input=${inputPreview} output=${outputPreview}`,
            rawEvent: event
          });
          return;
        }

        return;
      }

      if (event.type === 'user.message') {
        const uid = normalizeText(String(event?.data?.id || event?.data?.messageID || ''));
        if (uid && messageRoleByID.get(`${sessionID}:${uid}`) === 'user') {
          // Already handled through message.updated path for the same message id.
          return;
        }
        const text = extractContentText(event?.data?.content || event?.content || event?.data?.text || '');
        if (isVisibleNoticeText(text)) return;
        await processUserMessageEvent(sessionID, text, event);
        return;
      }

      if (event.type === 'assistant.message') {
        const text = extractContentText(event?.data?.content || event?.content || event?.data?.text || '');
        if (isVisibleNoticeText(text)) return;
        maybeMaterializeObservedUserTurnBeforeAssistant(sessionID, text, event);
        appendAutoEvent({
          sessionID,
          kind: 'assistant-message',
          summary: text || 'Assistant message event',
          rawEvent: event
        });
        await flushPendingVisibleNoticeMirror(sessionID);
        return;
      }

      if (event.type === 'tool.result') {
        const toolName = event?.data?.tool || event?.tool || 'unknown-tool';
        const inputPreview = truncateText(normalizeText(JSON.stringify(event?.data?.input ?? event?.input ?? {})), 220);
        const resultPreview = truncateText(
          normalizeText(
            typeof (event?.data?.result ?? event?.result) === 'string'
              ? (event?.data?.result ?? event?.result)
              : JSON.stringify(event?.data?.result ?? event?.result ?? event?.data?.error ?? event?.error ?? {})
          ),
          260
        );

        appendAutoEvent({
          sessionID,
          kind: 'tool-result',
          toolName,
          summary: `[${toolName}] input=${inputPreview} output=${resultPreview}`,
          rawEvent: event
        });
        return;
      }

      if (event.type === 'session.ended') {
        appendAutoEvent({
          sessionID,
          kind: 'session-end',
          summary: 'Session ended',
          rawEvent: event
        });
        sessionUserMessageCounters.delete(sessionID);
        sessionLatestUserTextByID.delete(sessionID);
        sessionObservedUserTextByID.delete(sessionID);
        sessionObservedUserAtByID.delete(sessionID);
        sessionAutoGlobalWriteState.delete(sessionID);
        rememberGlobalEmptyCallState.delete(sessionID);
        memoryEmptyCallState.delete(sessionID);
        contextEmptyCallState.delete(`${sessionID}:context-empty`);
        if (lastActiveSessionID === sessionID) lastActiveSessionID = '';
        lastObservedUserText = '';
        lastObservedUserAt = 0;
        sessionRecallState.delete(sessionID);
        sessionTitleByID.delete(sessionID);
        sessionUserDedupeState.delete(sessionID);
        sessionStrictHitAt.delete(sessionID);
        sessionPendingVisibleNoticeMirrors.delete(sessionID);
        pretrimWarmupTasks.delete(sessionID);
      }

      if (event.type === 'session.deleted') {
        sessionUserMessageCounters.delete(sessionID);
        sessionLatestUserTextByID.delete(sessionID);
        sessionObservedUserTextByID.delete(sessionID);
        sessionObservedUserAtByID.delete(sessionID);
        sessionAutoGlobalWriteState.delete(sessionID);
        rememberGlobalEmptyCallState.delete(sessionID);
        memoryEmptyCallState.delete(sessionID);
        contextEmptyCallState.delete(`${sessionID}:context-empty`);
        if (lastActiveSessionID === sessionID) lastActiveSessionID = '';
        lastObservedUserText = '';
        lastObservedUserAt = 0;
        sessionRecallState.delete(sessionID);
        sessionTitleByID.delete(sessionID);
        sessionUserDedupeState.delete(sessionID);
        sessionStrictHitAt.delete(sessionID);
        sessionPendingVisibleNoticeMirrors.delete(sessionID);
        pretrimWarmupTasks.delete(sessionID);
      }
    }
  };
};
