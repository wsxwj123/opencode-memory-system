import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

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
  const AUTO_SEND_PRETRIM_TURN_PROTECTION = 4;
  const AUTO_SEND_PRETRIM_MAX_REWRITE_MESSAGES = 28;
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

  function isSendPretrimEnabled() {
    return AUTO_SEND_PRETRIM_ENABLED && String(process.env.OPENCODE_MEMORY_SEND_PRETRIM || '1') !== '0';
  }

  function isStrictModeEnabled() {
    return AUTO_STRICT_MODE_ENABLED || String(process.env.OPENCODE_MEMORY_STRICT_MODE || '0') === '1';
  }

  function getIndependentDistillConfig() {
    const enabled = String(process.env.OPENCODE_MEMORY_DISTILL_ENABLED || '0') === '1';
    const provider = normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_PROVIDER || 'openai_compatible')).toLowerCase();
    const baseURL = normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_BASE_URL || ''));
    const apiKey = normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_API_KEY || ''));
    const model = normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_MODEL || ''));
    const timeoutMs = Math.max(3000, Number(process.env.OPENCODE_MEMORY_DISTILL_TIMEOUT_MS || 12000));
    const maxTokens = Math.max(128, Number(process.env.OPENCODE_MEMORY_DISTILL_MAX_TOKENS || 420));
    const temperature = Number(process.env.OPENCODE_MEMORY_DISTILL_TEMPERATURE || 0.2);
    const useSessionModel = String(process.env.OPENCODE_MEMORY_DISTILL_USE_SESSION_MODEL || '1') !== '0';
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
    const m = normalizeText(String(process.env.OPENCODE_MEMORY_DISTILL_MODE || 'auto')).toLowerCase();
    if (m === 'auto') return 'auto';
    if (m === 'independent') return 'independent';
    return 'session';
  }

  function canUseIndependentDistill(config) {
    if (!config?.enabled) return false;
    if (!config.baseURL || !config.apiKey) return false;
    return ['openai_compatible', 'anthropic', 'gemini'].includes(config.provider);
  }

  function runSessionInlineDistill(candidateItems = []) {
    const lines = [];
    const state = { chars: 0, maxChars: AUTO_DISTILL_SUMMARY_MAX_CHARS };
    const items = Array.isArray(candidateItems) ? candidateItems : [];
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
  const AUTO_DASHBOARD_PORT = 37777;
  const AUTO_OPENCODE_WEB_PORT = 4096;
  const AUTO_VISIBLE_NOTICES = true;
  const AUTO_VISIBLE_NOTICE_COOLDOWN_MS = 120000;
  const AUTO_VISIBLE_NOTICE_FOR_DISCARD = false;

  // --- Storage paths ---
  const memoryDir = path.join(os.homedir(), '.opencode', 'memory');
  const projectsDir = path.join(memoryDir, 'projects');
  const globalMemoryPath = path.join(memoryDir, 'global.json');
  const dashboardDir = path.join(memoryDir, 'dashboard');
  const dashboardHtmlPath = path.join(dashboardDir, 'index.html');
  const dashboardDataPath = path.join(dashboardDir, 'data.json');
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  const dashboardServiceScript = path.join(pluginDir, 'scripts', 'opencode_memory_dashboard.mjs');

  // Runtime state
  const sessionRecallState = new Map();
  const sessionUserMessageCounters = new Map();
  const sessionTitleByID = new Map();
  const messageRoleByID = new Map();
  const processedMessageKeys = new Set();
  const processedUserEventKeys = new Map();
  const sessionUserDedupeState = new Map();
  const sessionStrictHitAt = new Map();
  const sessionNoticeState = new Map();

  // Recall trigger patterns
  const RECALL_TRIGGER_PATTERNS = [
    /另一个对话|另外一个对话|上一个对话|上次那个对话|之前那个对话|跨对话/i,
    /刚刚的会话|刚刚会话|之前的会话|之前会话|刚才的会话|刚才会话|刚在另一个会话|刚在那个会话|另一个会话|那个会话|前一个会话|上个对话|上一个会话|刚刚那个聊天|刚刚的那个聊天|那个聊天|前一个聊天|上一个聊天|另一个session|另外的session|上一个session|上一会话|上个会话|之前的session|那个session|刚刚那个会话|刚才那个会话|上个聊天|上次会话/i,
    /刚才在另一个会话|我刚才在另一个会话|刚刚在另一个会话|之前在另一个会话/i,
    /in another chat|in previous chat|from previous session|other session/i
  ];

  if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
  if (!fs.existsSync(projectsDir)) fs.mkdirSync(projectsDir, { recursive: true });
  if (!fs.existsSync(globalMemoryPath)) {
    fs.writeFileSync(globalMemoryPath, JSON.stringify({ preferences: {}, snippets: {} }, null, 2));
  }
  ensureDashboardDir();
  if (AUTO_DASHBOARD_AUTOSTART) {
    ensureDashboardServiceStarted();
    process.once('exit', () => ensureDashboardServiceStopped());
  }

  function ensureDashboardServiceStarted() {
    try {
      if (!fs.existsSync(dashboardServiceScript)) return;

      const args = [
        dashboardServiceScript,
        'restart',
        String(AUTO_DASHBOARD_PORT),
        String(process.pid),
        String(AUTO_OPENCODE_WEB_PORT)
      ];

      // Normal start (dashboard service handles already-running as success).
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

  function readJson(filePath) {
    if (!fs.existsSync(filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
    return /EXTREMELY_IMPORTANT|using-superpowers|superpowers skill content|OpenCode Memory System|OPENCODE_KNOWLEDGE_BASE|我主要功能包括|我可以帮你完成以下任务|我的工具\/能力|我没有\"?插件\"?|\[memory-system\]/i.test(s);
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
    const now = Date.now();

    const prevSessionState = sessionUserDedupeState.get(sessionID);
    if (prevSessionState && (now - Number(prevSessionState.at || 0)) < 15000) {
      if (identity && prevSessionState.identity && prevSessionState.identity === identity) return true;
      if (!identity && normalized && prevSessionState.text) {
        const a = prevSessionState.text;
        const b = normalized;
        const nearSame = a === b || a.includes(b) || b.includes(a);
        if (nearSame && (now - Number(prevSessionState.at || 0)) < 3000) return true;
      }
    }

    const fallback = cleanText ? stableTextHash(cleanText.slice(0, 240)) : '';
    const key = identity
      ? `${sessionID}:id:${identity}`
      : `${sessionID}:txt:${fallback}`;
    if (!key) return false;

    const prev = Number(processedUserEventKeys.get(key) || 0);
    if (prev && (now - prev) < 15000) return true;
    processedUserEventKeys.set(key, now);
    sessionUserDedupeState.set(sessionID, { at: now, identity: identity || '', text: normalized });

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
    const turnProtection = Math.max(1, Number(policy?.turnProtection || AUTO_SEND_PRETRIM_TURN_PROTECTION));
    const protectedWindow = Math.max(8, turnProtection * 2 + 4);
    const protectFrom = Math.max(0, messages.length - protectedWindow);

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
        if (turnsAfter < AUTO_STRATEGY_PURGE_ERROR_TURNS) continue;
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
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      total += estimateTokensFromText(role);
      const parts = Array.isArray(msg?.parts) ? msg.parts : [];
      for (const part of parts) total += estimateTokensFromText(partTextForPretrim(part));
    }
    return total;
  }

  function getAdaptivePretrimPolicy(beforeTokens) {
    const ratio = beforeTokens > 0 ? beforeTokens / Math.max(1, AUTO_SEND_PRETRIM_BUDGET) : 0;
    let level = 0;
    if (ratio >= 1.25) level = 2;
    else if (ratio >= 1.05) level = 1;
    return {
      level,
      ratio,
      turnProtection: level === 2 ? 3 : AUTO_SEND_PRETRIM_TURN_PROTECTION,
      maxRewriteMessages: level === 2 ? 48 : level === 1 ? 36 : AUTO_SEND_PRETRIM_MAX_REWRITE_MESSAGES,
      phaseTrimEnabled: ratio >= 1.0
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
      if (sid) return sid;
    }
    return '';
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

    if (candidates.length < AUTO_DISTILL_RANGE_MIN_MESSAGES) {
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
        if (count >= AUTO_DISTILL_RANGE_MAX_MESSAGES) break;
      }
      if (count < AUTO_DISTILL_RANGE_MIN_MESSAGES) continue;
      const value = scoreSum + count * 2;
      if (!best || value > best.value) {
        best = { value, indices: idxs, items };
      }
    }

    if (!best) return { indices: [], items: [] };
    return { indices: best.indices, items: best.items };
  }

  function buildDistillPrompt(candidateItems, maxChars = AUTO_DISTILL_SUMMARY_MAX_CHARS) {
    const cleanItems = Array.isArray(candidateItems) ? candidateItems : [];
    const payload = cleanItems.map((it, idx) => {
      const role = normalizeText(String(it?.role || 'assistant')).toLowerCase() || 'assistant';
      const snippets = Array.isArray(it?.snippets) ? it.snippets : [];
      return `${idx + 1}. role=${role}\n${snippets.map((s) => `- ${s}`).join('\n')}`;
    }).join('\n\n');

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

  async function runIndependentDistillLLM(messages, candidateItems) {
    const cfg = getIndependentDistillConfig();
    if (!canUseIndependentDistill(cfg)) return { ok: false, reason: 'disabled_or_incomplete_config', text: '' };
    const sessionModel = inferSessionModelFromMessages(messages);
    const model = normalizeText(
      cfg.model || (cfg.useSessionModel ? String(sessionModel.modelID || '') : '')
    );
    if (!model) return { ok: false, reason: 'missing_model', text: '' };

    const prompt = buildDistillPrompt(candidateItems, AUTO_DISTILL_SUMMARY_MAX_CHARS);
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
      const text = truncateText(extractDistillTextFromResponse(cfg.provider, json), AUTO_DISTILL_SUMMARY_MAX_CHARS);
      if (!text) return { ok: false, reason: 'empty_text', text: '', provider: cfg.provider, model };
      return { ok: true, reason: 'ok', text, provider: cfg.provider, model };
    } catch (err) {
      const msg = String(err?.name === 'AbortError' ? 'timeout' : (err?.message || err || 'unknown_error'));
      return { ok: false, reason: msg, text: '', provider: cfg.provider, model };
    } finally {
      clearTimeout(timeout);
    }
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
    if (result.beforeTokens <= AUTO_SEND_PRETRIM_TARGET) return result;

    const protectedWindow = Math.max(8, AUTO_SEND_PRETRIM_TURN_PROTECTION * 2 + 4);
    const protectFrom = Math.max(0, messages.length - protectedWindow);
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
    const result = {
      enabled: isSendPretrimEnabled(),
      dryRun: AUTO_SEND_PRETRIM_DRY_RUN,
      strictModeEnabled: isStrictModeEnabled(),
      beforeTokens: estimateOutgoingMessagesTokens(messages),
      afterTokens: 0,
      adaptiveLevel: 0,
      adaptiveRatio: 0,
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

    if (!isSendPretrimEnabled() || !Array.isArray(messages) || !messages.length) {
      result.afterTokens = result.beforeTokens;
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
    if (tokensAfterStrategies <= AUTO_SEND_PRETRIM_BUDGET) {
      result.afterTokens = tokensAfterStrategies;
      result.savedTokens = Math.max(0, result.beforeTokens - result.afterTokens);
      result.reason = (result.strategyDedup || result.strategySupersedeWrites || result.strategyPurgedErrors || result.strategyPhaseTrim)
        ? 'within_budget+strategies'
        : 'within_budget';
      result.compositionAfter = computeOutgoingTokenComposition(messages);
      return result;
    }

    const protectedWindow = Math.max(8, Number(policy.turnProtection || AUTO_SEND_PRETRIM_TURN_PROTECTION) * 2 + 4);
    const protectFrom = Math.max(0, messages.length - protectedWindow);
    let rewrites = 0;

    for (let i = 0; i < messages.length; i += 1) {
      if (rewrites >= Number(policy.maxRewriteMessages || AUTO_SEND_PRETRIM_MAX_REWRITE_MESSAGES)) break;
      if (i >= protectFrom) continue;

      const msg = messages[i];
      const role = normalizeText(String(msg?.info?.role || '')).toLowerCase();
      if (!msg || !Array.isArray(msg.parts)) continue;
      if (role === 'system' || role === 'user') continue;

      let touchedInMessage = false;
      for (const part of msg.parts) {
        if (result.beforeTokens - result.savedTokens <= AUTO_SEND_PRETRIM_TARGET) break;

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

      if (result.beforeTokens - result.savedTokens <= AUTO_SEND_PRETRIM_TARGET) break;
    }

    result.afterTokens = AUTO_SEND_PRETRIM_DRY_RUN
      ? Math.max(0, result.beforeTokens - result.savedTokens)
      : estimateOutgoingMessagesTokens(messages);

    // Stage-2: if still above hard threshold, perform DCP-like replacement:
    // independent distill LLM (preferred) -> fallback mechanical extract.
    const hardLimit = Math.floor(AUTO_SEND_PRETRIM_BUDGET * AUTO_SEND_PRETRIM_HARD_RATIO);
    const distillTrigger = Math.floor(AUTO_SEND_PRETRIM_BUDGET * AUTO_SEND_PRETRIM_DISTILL_TRIGGER_RATIO);
    const stage2Limit = Math.max(AUTO_SEND_PRETRIM_TARGET + 200, Math.min(hardLimit, distillTrigger));
    let extractedMessages = 0;
    if (!AUTO_SEND_PRETRIM_DRY_RUN && result.afterTokens > stage2Limit) {
      const protectedWindow = Math.max(8, AUTO_SEND_PRETRIM_TURN_PROTECTION * 2 + 4);
      const protectFrom = Math.max(0, messages.length - protectedWindow);
      const selectedRange = selectDistillCandidateRange(messages, protectFrom);
      const candidateIndices = Array.isArray(selectedRange.indices) ? selectedRange.indices : [];
      const candidateItems = Array.isArray(selectedRange.items) ? selectedRange.items : [];

      if (candidateIndices.length >= 2 && candidateItems.length) {
        let summary = '';
        const sourceItems = [];
        for (const it of candidateItems) {
          sourceItems.push(it);
          if (JSON.stringify(sourceItems).length > AUTO_DISTILL_INPUT_MAX_CHARS) break;
        }
        const mode = getDistillMode();
        const allowIndependent = mode === 'independent' || (mode === 'auto' && canUseIndependentDistill(getIndependentDistillConfig()));
        if (allowIndependent) {
          const distill = await runIndependentDistillLLM(messages, sourceItems);
          result.distillProvider = String(distill?.provider || '');
          result.distillModel = String(distill?.model || '');
          result.distillStatus = String(distill?.reason || '');
          if (distill?.ok && distill?.text) {
            const quality = evaluateDistillSummaryQuality(distill.text, sourceItems);
            result.distillStatus = quality.ok ? 'ok' : `low_quality:${quality.reason}`;
            if (quality.ok) {
              const bid = result.predictedBlockId > 0 ? ` b${result.predictedBlockId}` : '';
              summary = `[pretrim-distill${bid}]\n${truncateText(distill.text, AUTO_DISTILL_SUMMARY_MAX_CHARS)}`;
              result.distillUsed = true;
            }
          }
        }

        if (!summary) {
          const inline = runSessionInlineDistill(sourceItems);
          const quality = evaluateDistillSummaryQuality(inline, sourceItems);
          result.distillProvider = result.distillProvider || 'session-inline';
          result.distillModel = result.distillModel || 'current-session';
          result.distillStatus = quality.ok ? 'ok_inline' : `low_quality_inline:${quality.reason}`;
          if (quality.ok && inline) {
            const bid = result.predictedBlockId > 0 ? ` b${result.predictedBlockId}` : '';
            summary = `[pretrim-distill-inline${bid}]\n${truncateText(inline, AUTO_DISTILL_SUMMARY_MAX_CHARS)}`;
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
            summary = truncateText(`${summary}${refLine}`, AUTO_DISTILL_SUMMARY_MAX_CHARS);
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
          if (result.afterTokens <= AUTO_SEND_PRETRIM_TARGET) break;
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
    if (!AUTO_SEND_PRETRIM_DRY_RUN && result.afterTokens > AUTO_SEND_PRETRIM_TARGET) {
      const protectedWindow = Math.max(8, Number(policy.turnProtection || AUTO_SEND_PRETRIM_TURN_PROTECTION) * 2 + 4);
      const protectFrom = Math.max(0, messages.length - protectedWindow);
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
    if (!AUTO_SEND_PRETRIM_DRY_RUN && result.afterTokens > AUTO_SEND_PRETRIM_TARGET && isStrictModeEnabled()) {
      const strict = applyStrictAnchorCompaction(messages, result.afterTokens);
      if (strict.applied) {
        result.strictApplied = true;
        result.strictReplacedMessages = Number(strict.replacedMessages || 0);
        result.afterTokens = Number(strict.afterTokens || result.afterTokens);
        result.savedTokens = Math.max(0, result.beforeTokens - result.afterTokens);
        result.reason = `strict-anchor(${result.strictReplacedMessages})`;
      }
    }
    result.compositionAfter = computeOutgoingTokenComposition(messages);
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
      traces: Array.isArray(cur.traces) ? cur.traces.slice(-AUTO_SEND_PRETRIM_TRACE_LIMIT) : []
    };
    return sessionData.sendPretrim;
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
      strategyDedup: Number(stats.strategyDedup || 0),
      strategySupersedeWrites: Number(stats.strategySupersedeWrites || 0),
      strategyPurgedErrors: Number(stats.strategyPurgedErrors || 0),
      strategyPhaseTrim: Number(stats.strategyPhaseTrim || 0),
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
    mem.budget.lastEstimatedBodyTokens = Number(stats.afterTokens || 0);
    mem.budget.lastCompactedAt = audit.lastAt;
    mem.budget.lastCompactionReason = `send_pretrim:${audit.lastReason || 'unknown'}`;

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
    const bigBefore = Number(stats.beforeTokens || 0) > Math.floor(AUTO_SEND_PRETRIM_BUDGET * 1.25);
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

  function tokenize(text) {
    const clean = normalizeText(String(text || '')).toLowerCase();
    if (!clean) return [];
    return clean.split(/[^a-z0-9\u4e00-\u9fff]+/i).filter((t) => t.length >= AUTO_RECALL_MIN_QUERY_LEN);
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
    return (
      event?.properties?.info?.sessionID ||
      event?.properties?.sessionID ||
      event?.properties?.part?.sessionID ||
      event?.session?.id ||
      event?.data?.sessionID ||
      event?.properties?.info?.id ||
      null
    );
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
      event?.properties?.info?.id ||
      event?.properties?.messageID ||
      event?.data?.messageID ||
      event?.message?.id ||
      null
    );
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
        lastSkipReason: ''
      },
      budget: {
        bodyTokenBudget: AUTO_BODY_TOKEN_BUDGET,
        lastEstimatedBodyTokens: 0,
        lastCompactedAt: null,
        lastCompactionReason: ''
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

    return lines.join('\n');
  }

  function compressSessionMemory(sessionData) {
    if (!Array.isArray(sessionData.recentEvents)) sessionData.recentEvents = [];

    if (sessionData.recentEvents.length <= AUTO_SUMMARY_TRIGGER_EVENTS) return;

    const toCompress = sessionData.recentEvents.slice(
      0,
      Math.max(0, sessionData.recentEvents.length - AUTO_SUMMARY_KEEP_RECENT_EVENTS)
    );
    if (!toCompress.length) return;

    const chunk = buildCompressedChunk(toCompress, sessionData);
      const current = sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || ''));
    const merged = [current, chunk].filter(Boolean).join('\n\n');

    sessionData.summary = {
      compressedText: truncateFromEnd(merged, AUTO_SUMMARY_MAX_CHARS),
      compressedEvents: Number(sessionData?.summary?.compressedEvents || 0) + toCompress.length,
      lastCompressedAt: new Date().toISOString()
    };

    sessionData.recentEvents = sessionData.recentEvents.slice(-AUTO_SUMMARY_KEEP_RECENT_EVENTS);
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
      compressedText: truncateFromEnd(merged, AUTO_SUMMARY_MAX_CHARS_BUDGET_MODE),
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
    sessionData.budget.lastEstimatedBodyTokens = estimated;

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

    sessionData.budget.lastEstimatedBodyTokens = estimated;
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
    const maxRemovals = Number(options.maxRemovals || AUTO_DISCARD_MAX_REMOVALS_PER_PASS);
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
    const maxExtract = Math.max(6, Number(options.maxExtract || AUTO_EXTRACT_EVENTS_PER_PASS));
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
          compressedText: truncateFromEnd(merged, AUTO_SUMMARY_MAX_CHARS_BUDGET_MODE),
          compressedEvents: Number(sessionData?.summary?.compressedEvents || 0) + cut,
          lastCompressedAt: new Date().toISOString()
        };
        sessionData.recentEvents = events.slice(cut);
      } else {
        sessionData.summary = {
          compressedText: truncateFromEnd(
            sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || '')),
            Math.min(AUTO_SUMMARY_MAX_CHARS_BUDGET_MODE, 1000)
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
    writeJson(sessionPath, sessionData);
    enforceSessionFileBudget(sessionData, sessionPath);
    updateProjectMetaFromSession(sessionData, projectName);
    pruneSessionFiles(projectName, sessionData.sessionID);
  }

  function appendAutoEvent({ sessionID, kind, summary, rawEvent = null, toolName = '' }) {
    try {
      if (!sessionID || !kind) return;

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

      sessionData.recentEvents = Array.isArray(sessionData.recentEvents) ? sessionData.recentEvents : [];
      sessionData.recentEvents.push(eventRecord);
      if (!normalizeText(sessionData.sessionTitle || '')) {
        const derivedTitle = deriveSessionTitleFromEvents(sessionData);
        if (derivedTitle) sessionData.sessionTitle = derivedTitle;
      }
      if (sessionData.recentEvents.length > AUTO_MAX_EVENTS_PER_SESSION) {
        sessionData.recentEvents = sessionData.recentEvents.slice(-AUTO_MAX_EVENTS_PER_SESSION);
      }

      sessionData.stats = sessionData.stats || emptyStats();
      if (kind === 'user-message') sessionData.stats.userMessages = (sessionData.stats.userMessages || 0) + 1;
      else if (kind === 'assistant-message') sessionData.stats.assistantMessages = (sessionData.stats.assistantMessages || 0) + 1;
      else if (kind === 'tool-result') sessionData.stats.toolResults = (sessionData.stats.toolResults || 0) + 1;
      else sessionData.stats.systemEvents = (sessionData.stats.systemEvents || 0) + 1;

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
        if (AUTO_VISIBLE_NOTICE_FOR_DISCARD) {
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

  async function processUserMessageEvent(sessionID, text, rawEvent) {
    const clean = normalizeText(String(text || ''));
    if (!clean || isMemoryInjectionText(clean)) return;
    if (shouldSkipDuplicateUserEvent(sessionID, clean, rawEvent)) return;
    const isFirstUserMessageForSession = !hasSessionMemoryFile(sessionID);

    if (isFirstUserMessageForSession) {
      appendAutoEvent({
        sessionID,
        kind: 'session-start',
        summary: 'Session created',
        rawEvent
      });

      if (AUTO_INJECT_MEMORY_DOCS) {
        await injectMemoryText(sessionID, memoryDocs, 'memory-docs');
      }

      if (AUTO_INJECT_GLOBAL_PREFS_ON_SESSION_START) {
        const globalText = buildGlobalPrefsContextText();
        if (globalText) await injectMemoryText(sessionID, globalText, 'global-prefs');
      }
    }

    if (clean) {
      appendAutoEvent({
        sessionID,
        kind: 'user-message',
        summary: clean,
        rawEvent
      });
    }

    const currentCount = (sessionUserMessageCounters.get(sessionID) || 0) + 1;
    sessionUserMessageCounters.set(sessionID, currentCount);

    if (
      AUTO_CURRENT_SESSION_SUMMARY_ENABLED &&
      currentCount >= AUTO_CURRENT_SESSION_REFRESH_EVERY &&
      currentCount % AUTO_CURRENT_SESSION_REFRESH_EVERY === 0 &&
      !shouldSuppressCurrentSummaryInjection(sessionID)
    ) {
      const currentSummary = buildCurrentSessionSummaryText(sessionID);
      if (currentSummary) {
        await injectMemoryText(sessionID, currentSummary, 'current-session-refresh');
      }
    }

    if (AUTO_RECALL_ENABLED && clean && (shouldTriggerRecall(clean) || referencesAnotherSessionTitle(clean, sessionID))) {
      await maybeInjectTriggerRecall(sessionID, clean);
    }
  }

  function scoreSessionForQuery(sessionData, queryTokens) {
    if (!sessionData || !queryTokens.length) return 0;
    const queryJoined = queryTokens.join(' ');
    const recent = Array.isArray(sessionData.recentEvents)
      ? sessionData.recentEvents.map((e) => normalizeText(String(e?.summary || ''))).join(' ')
      : '';
    const compressed = normalizeText(sanitizeCompressedSummaryText(String(sessionData?.summary?.compressedText || '')));
    const title = normalizeText(String(sessionData?.sessionTitle || ''));
    const cwd = normalizeText(String(sessionData?.sessionCwd || ''));
    const blob = `${title} ${cwd} ${recent} ${compressed}`.toLowerCase();

    let score = 0;
    for (const token of queryTokens) {
      if (blob.includes(token)) score += 2;
    }
    if (/路径|path|目录|folder|workdir/i.test(queryJoined) && /\/|[a-z]:\\/i.test(blob)) score += 1;
    if (/审稿|review|reviewer|投稿|response/i.test(queryJoined) && /审稿|review|response/i.test(blob)) score += 2;
    if (/另一个|之前|上次|session|对话/i.test(queryJoined)) score += 1;

    // Slight recency bias
    const updated = Date.parse(sessionData?.updatedAt || 0) || 0;
    if (updated > 0) score += 0.1;

    return score;
  }

  function buildRecallContextText(query, sessions, options = {}) {
    const budgetChars = charsFromTokenBudget(options.tokenBudget || AUTO_RECALL_TOKEN_BUDGET);
    const maxChars = Math.min(Number(options.maxChars || AUTO_RECALL_MAX_CHARS), budgetChars);
    const maxEventsPerSession = Number(options.maxEventsPerSession || AUTO_RECALL_MAX_EVENTS_PER_SESSION);

    const lines = [];
    const state = { chars: 0, maxChars };

    pushLineWithLimit(lines, `<OPENCODE_MEMORY_RECALL query="${truncateText(normalizeText(query), 120)}">`, state);
    pushLineWithLimit(lines, 'Execution policy:', state);
    pushLineWithLimit(lines, '- If recalled memory already contains enough facts to answer the user question, answer directly from recalled memory first.', state);
    pushLineWithLimit(lines, '- STRONG RULE: Do NOT run file search/read/list tools unless user explicitly asks to verify/re-check, or recalled memory is insufficient/ambiguous.', state);
    pushLineWithLimit(lines, '- If answering from memory, clearly state it is based on recalled memory and include the key evidence (facts/paths/decisions).', state);

    for (const s of sessions) {
      const stats = s?.stats || emptyStats();
      pushLineWithLimit(
        lines,
        `Session ${s.sessionID} (updated=${s.updatedAt || 'unknown'}, u=${stats.userMessages || 0}, a=${stats.assistantMessages || 0}, t=${stats.toolResults || 0}):`,
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
    const maxSessions = Number(options.maxSessions || AUTO_RECALL_TOP_SESSIONS);

    const queryText = normalizeText(String(query || ''));
    const tokens = tokenize(queryText);
    if (!tokens.length) {
      return { text: '', hits: [] };
    }

    const allSessions = listSessionMemories(projectName);
    const scored = [];

    for (const s of allSessions) {
      if (!includeCurrent && currentSessionID && s.sessionID === currentSessionID) continue;
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

    return { text, hits, estimatedTokens: estimateTokensFromText(text) };
  }

  function canEmitVisibleNotice(sessionID, key = 'notice') {
    if (!AUTO_VISIBLE_NOTICES || !sessionID) return false;
    const now = Date.now();
    const prev = sessionNoticeState.get(sessionID);
    if (prev && (now - prev.at) < AUTO_VISIBLE_NOTICE_COOLDOWN_MS) return false;
    sessionNoticeState.set(sessionID, { key, at: now });
    return true;
  }

  async function emitVisibleNotice(sessionID, message, key = 'notice') {
    try {
      if (!canEmitVisibleNotice(sessionID, key)) return false;
      const text = `[memory-system] ${truncateText(normalizeText(String(message || '')), 220)}`;
      if (!text.trim()) return false;

      if (client?.session && typeof client.session.prompt === 'function') {
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{ type: 'text', text, synthetic: true }]
          }
        });
        return true;
      }

      if (client?.session && typeof client.session.update === 'function') {
        try {
          await client.session.update(sessionID, {
            noReply: true,
            parts: [{ type: 'text', text, synthetic: true }]
          });
          return true;
        } catch {
          await client.session.update({
            path: { id: sessionID },
            body: {
              noReply: true,
              parts: [{ type: 'text', text, synthetic: true }]
            }
          });
          return true;
        }
      }
    } catch {
      // ignore visible notice failures
    }
    return false;
  }

  async function injectMemoryText(sessionID, text, reason = 'memory-inject') {
    try {
      if (!sessionID || !text) return false;
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
        await client.session.prompt({
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

      console.error(`memory-system inject skipped (${reason}): no supported client.session method`);
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

    const entries = Object.entries(prefs).slice(0, AUTO_INJECT_GLOBAL_PREFS_MAX_ITEMS);
    if (!entries.length) return '';

    const lines = [];
    const state = { chars: 0, maxChars: AUTO_INJECT_GLOBAL_PREFS_MAX_CHARS };
    pushLineWithLimit(lines, '<OPENCODE_GLOBAL_PREFERENCES>', state);
    for (const [k, v] of entries) {
      pushLineWithLimit(lines, `- ${k}: ${truncateText(normalizeText(String(v)), 120)}`, state);
    }
    pushLineWithLimit(lines, '</OPENCODE_GLOBAL_PREFERENCES>', state);

    if (lines.length <= 2) return '';
    return lines.join('\n');
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
    return { ...legacyTopLevel, ...prefs };
  }

  function buildCurrentSessionSummaryText(sessionID) {
    if (!sessionID) return '';
    const s = loadSessionMemory(sessionID);
    if (!s || !Array.isArray(s.recentEvents)) return '';

    const maxChars = Math.min(
      charsFromTokenBudget(AUTO_CURRENT_SESSION_SUMMARY_TOKEN_BUDGET),
      AUTO_CURRENT_SESSION_SUMMARY_MAX_CHARS
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

    const recent = s.recentEvents.slice(-AUTO_CURRENT_SESSION_SUMMARY_MAX_EVENTS);
    const structured = buildCompressedChunk(recent);
    for (const row of structured.split('\n')) {
      pushLineWithLimit(lines, row, state);
    }

    pushLineWithLimit(lines, '</OPENCODE_CURRENT_SESSION_SUMMARY>', state);
    if (lines.length <= 2) return '';
    return lines.join('\n');
  }

  async function maybeInjectTriggerRecall(sessionID, query) {
    if (!AUTO_RECALL_ENABLED || !sessionID) return;

    const now = Date.now();
    const normQuery = normalizeText(query).toLowerCase();
    const state = sessionRecallState.get(sessionID) || { lastAt: 0, lastQuery: '' };

    if (now - state.lastAt < AUTO_RECALL_COOLDOWN_MS && state.lastQuery === normQuery) {
      return;
    }

    const { text, hits } = recallProjectMemories(query, {
      currentSessionID: sessionID,
      includeCurrent: false,
      maxSessions: AUTO_RECALL_TOP_SESSIONS,
      maxEventsPerSession: AUTO_RECALL_MAX_EVENTS_PER_SESSION,
      maxChars: AUTO_RECALL_MAX_CHARS,
      tokenBudget: AUTO_RECALL_TOKEN_BUDGET
    });

    if (!text || !hits.length) return;

    const injected = await injectMemoryText(sessionID, text, 'trigger-recall');
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

      const sessionList = sessionsRaw.map((sess) => ({
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
          const traces = Array.isArray(sess?.sendPretrim?.traces) ? sess.sendPretrim.traces : [];
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
          lastSkipReason: sess?.inject?.lastSkipReason || ''
        },
        budget: {
          bodyTokenBudget: Number(sess?.budget?.bodyTokenBudget || AUTO_BODY_TOKEN_BUDGET),
          lastEstimatedBodyTokens: Number(sess?.budget?.lastEstimatedBodyTokens || 0),
          lastCompactedAt: sess?.budget?.lastCompactedAt || null,
          lastCompactionReason: sess?.budget?.lastCompactionReason || ''
        },
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
          traces: Array.isArray(sess?.sendPretrim?.traces) ? sess.sendPretrim.traces.slice(-8) : []
        },
        alerts: sess?.alerts && typeof sess.alerts === 'object' ? sess.alerts : {}
      }));

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

  function buildDashboardHtml(data) {
    const payload = JSON.stringify(data).replace(/</g, '\\u003c');
    const html = [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      '  <title>Memory Dashboard</title>',
      '  <style>',
      '    :root { --bg:#f4f6f8; --panel:#fff; --ink:#17212b; --muted:#5f6b76; --accent:#0f766e; --line:#d9e2ea; }',
      '    * { box-sizing: border-box; }',
      '    body { margin:0; font-family:"IBM Plex Sans","Noto Sans SC","PingFang SC","Segoe UI",sans-serif; color:var(--ink); background:radial-gradient(circle at 15% 10%, #e0f2fe 0%, var(--bg) 45%), var(--bg); }',
      '    .layout { display:grid; grid-template-columns:320px 1fr; min-height:100vh; }',
      '    .sidebar { border-right:1px solid var(--line); background:#fbfdff; padding:16px; overflow:auto; }',
      '    .main { padding:20px; overflow:auto; }',
      '    h1 { margin:0 0 12px; font-size:20px; letter-spacing:.2px; }',
      '    .sub { color:var(--muted); font-size:13px; margin-bottom:12px; }',
      '    .metrics { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin-bottom:14px; }',
      '    .metric { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:10px; box-shadow:0 3px 10px rgba(15,23,42,.04); }',
      '    .metric .k { font-size:11px; color:var(--muted); text-transform:uppercase; }',
      '    .metric .v { font-size:18px; font-weight:650; margin-top:2px; }',
      '    .project-item { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:10px; margin-bottom:8px; cursor:pointer; transition:120ms ease; }',
      '    .project-item:hover { border-color:#b6c8d6; transform:translateY(-1px); }',
      '    .project-item.active { border-color:var(--accent); background:#f0fdfa; box-shadow:0 0 0 2px rgba(15,118,110,.08) inset; }',
      '    .project-item .name { font-weight:650; }',
      '    .project-item .meta { color:var(--muted); font-size:12px; margin-top:4px; }',
      '    .panel { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:12px; box-shadow:0 4px 14px rgba(15,23,42,.05); }',
      '    .session { border:1px solid var(--line); border-radius:10px; margin-bottom:10px; overflow:hidden; background:#fff; }',
      '    .session-h { padding:10px 12px; display:flex; justify-content:flex-start; align-items:flex-start; gap:12px; background:linear-gradient(180deg,#f8fafc,#f1f5f9); border-bottom:1px solid var(--line); cursor:pointer; }',
      '    .session-id { font-family:"IBM Plex Mono","JetBrains Mono",monospace; font-size:12px; text-align:left; }',
      '    .stats { font-size:12px; color:var(--muted); text-align:left; }',
      '    .events { padding:10px 12px; display:none; }',
      '    .events.open { display:block; }',
      '    .ev { border-left:3px solid #cbd5e1; padding:6px 8px; margin-bottom:8px; background:#f8fafc; border-radius:6px; }',
      '    .ev.user-message { border-left-color:#2563eb; }',
      '    .ev.assistant-message { border-left-color:#7c3aed; }',
      '    .ev.tool-result { border-left-color:#0f766e; }',
      '    .ev.session-start, .ev.session-end { border-left-color:#64748b; }',
      '    .ev .meta { color:var(--muted); font-size:11px; margin-bottom:4px; }',
      '    .ev .txt { white-space:pre-wrap; font-size:13px; line-height:1.4; }',
      '    .pref { font-size:13px; color:var(--ink); margin-bottom:4px; }',
      '    .empty { color:var(--muted); font-size:13px; }',
      '    .trash-row { display:flex; align-items:flex-start; gap:10px; padding:8px; border:1px solid var(--line); border-radius:8px; margin-bottom:8px; background:#f8fafc; }',
      '    .trash-row .meta { font-size:12px; color:var(--muted); }',
      '    .trash-row .path { font-family:"IBM Plex Mono","JetBrains Mono",monospace; font-size:11px; color:#334155; word-break:break-all; }',
      '    @media (max-width:920px) { .layout { grid-template-columns:1fr; } .sidebar { border-right:none; border-bottom:1px solid var(--line); } }',
      '  </style>',
      '</head>',
      '<body>',
      '  <div class="layout">',
      '    <aside class="sidebar">',
      '      <h1 id="titleMain">Memory Dashboard</h1>',
      '      <div class="sub" id="genAt"></div>',
      '      <div class="sub"><label id="langLabel" for="langSel">Language</label>: <select id="langSel"><option value="zh">中文</option><option value="en">English</option></select></div>',
      '      <div class="metrics">',
      '        <div class="metric"><div class="k">Projects</div><div class="v" id="mProjects">0</div></div>',
      '        <div class="metric"><div class="k">Sessions</div><div class="v" id="mSessions">0</div></div>',
      '        <div class="metric"><div class="k">Events</div><div class="v" id="mEvents">0</div></div>',
      '      </div>',
      '      <div id="projectList"></div>',
      '    </aside>',
      '    <main class="main">',
      '      <div class="panel"><h1 id="projectTitle" style="font-size:18px;">No project selected</h1><div class="sub" id="projectMeta"></div></div>',
      '      <div class="panel"><h1 id="globalTitle" style="font-size:16px;">Global Preferences</h1><div class="sub" id="tokenHint">Token estimate is approximate (chars/4).</div><div id="globalPrefs" class="empty">No global preferences.</div></div>',
      '      <div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><h1 style="font-size:16px;">Sessions</h1><button id="batchDeleteBtn" style="height:30px;">批量删除</button></div><div id="sessionList" class="empty">No sessions.</div></div>',
      '      <div class="panel"><div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;"><h1 style="font-size:16px;">回收站</h1><div style="display:flex;align-items:center;gap:8px;"><label for="trashRetentionSel" style="font-size:12px;color:var(--muted);">保留天数</label><select id="trashRetentionSel"><option value="1">1</option><option value="3">3</option><option value="7">7</option><option value="10">10</option><option value="30" selected>30</option></select><button id="trashCleanupBtn" style="height:30px;">立即清理过期</button><button id="trashDeleteBtn" style="height:30px;" disabled>永久删除(0)</button></div></div><div id="trashMeta" class="sub">-</div><div id="trashList" class="empty">暂无回收站条目</div></div>',
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
      '    const I18N = { zh:{title:"记忆看板",lang:"语言",global:"全局偏好",token:"Token 估算为近似值（chars/4）",edit:"编辑摘要",del:"删除会话",nos:"暂无会话",noproj:"暂无项目记忆",save:"保存",cancel:"取消",trashTitle:"回收站",trashNone:"暂无回收站条目",trashDelete:"永久删除",trashCleanup:"立即清理过期"}, en:{title:"Memory Dashboard",lang:"Language",global:"Global Preferences",token:"Token estimate is approximate (chars/4).",edit:"Edit summary",del:"Delete session",nos:"No sessions.",noproj:"No project memory yet.",save:"Save",cancel:"Cancel",trashTitle:"Trash",trashNone:"No trash entries",trashDelete:"Delete Permanently",trashCleanup:"Cleanup Expired"} };',
      '    let LANG = localStorage.getItem("memory_dashboard_lang") || "zh";',
      '    const __selectedSessionIDs = new Set();',
      '    const __trashSelectedPaths = new Set();',
      '    let __trashData = { retentionDays:30, entries:[] };',
      '    let __activeProjectName = "";',
      '    function updateBatchDeleteBtn(){ const b=$("batchDeleteBtn"); if(!b) return; const n=__selectedSessionIDs.size; b.textContent=n>0?("批量删除("+n+")"):"批量删除"; b.disabled=n===0; }',
      '    function updateTrashDeleteBtn(){ const b=$("trashDeleteBtn"); if(!b) return; const n=__trashSelectedPaths.size; b.textContent=t("trashDelete")+"(" + n + ")"; b.disabled=n===0; }',
      '    function t(k){ return (I18N[LANG]&&I18N[LANG][k]) || (I18N.en&&I18N.en[k]) || k; }',
      '    function updateMetrics(){',
      '      const gen = DATA && DATA.generatedAt ? new Date(DATA.generatedAt).toLocaleString() : "-";',
      '      $("genAt").textContent = "Generated: " + gen;',
      '      const s = (DATA && DATA.summary) || {projectCount:0,sessionCount:0,eventCount:0};',
      '      $("mProjects").textContent = s.projectCount || 0;',
      '      $("mSessions").textContent = s.sessionCount || 0;',
      '      $("mEvents").textContent = s.eventCount || 0;',
      '    }',
      '    let __lastRefreshAt = 0;',
      '    async function refreshDashboardData(){',
      '      try {',
      '        const r = await fetch("/api/dashboard", { cache: "no-store" });',
      '        if (r.ok) { DATA = await r.json(); __lastRefreshAt = Date.now(); }',
      '      } catch (_) {}',
      '      updateMetrics();',
      '      renderGlobalPrefs();',
      '      renderProjects();',
      '      await refreshTrashData();',
      '    }',
      '    async function apiPost(url,payload){ const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); if(!r.ok) throw new Error(await r.text()); return r.json(); }',
      '    async function refreshTrashData(){ try{ const r=await fetch("/api/memory/trash",{cache:"no-store"}); if(r.ok){ __trashData=await r.json(); } }catch(_){ } renderTrash(); }',
      '    function renderTrash(){ const list=$("trashList"); const meta=$("trashMeta"); const sel=$("trashRetentionSel"); if(!list||!meta||!sel) return; const entries=Array.isArray(__trashData.entries)?__trashData.entries:[]; const keep=Number(__trashData.retentionDays||30); sel.value=String(keep); meta.textContent=(LANG==="en"?("Retention "+keep+" days · entries="+entries.length):("保留 "+keep+" 天 · 条目="+entries.length)); if(!entries.length){ list.className="empty"; list.textContent=t("trashNone"); __trashSelectedPaths.clear(); updateTrashDeleteBtn(); return; } list.className=""; list.innerHTML=""; entries.forEach((e)=>{ const row=document.createElement("div"); row.className="trash-row"; const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=__trashSelectedPaths.has(e.path||""); cb.addEventListener("change",(ev)=>{ if(ev.target.checked) __trashSelectedPaths.add(e.path||""); else __trashSelectedPaths.delete(e.path||""); updateTrashDeleteBtn(); }); const box=document.createElement("div"); box.style.display="flex"; box.style.flexDirection="column"; box.style.gap="4px"; const m1=document.createElement("div"); m1.className="meta"; m1.textContent=(e.projectName||"-")+" · "+(e.fileName||"-")+" · "+new Date(e.mtime||Date.now()).toLocaleString()+" · "+(e.size||0)+" bytes"; const m2=document.createElement("div"); m2.className="path"; m2.textContent=e.path||""; box.appendChild(m1); box.appendChild(m2); row.appendChild(cb); row.appendChild(box); list.appendChild(row); }); updateTrashDeleteBtn(); }',
      '    async function cleanupTrashNow(){ const sel=$("trashRetentionSel"); const days=Number(sel&&sel.value||30); if(!window.confirm((LANG==="en"?"Cleanup expired trash with retention ":"按保留期清理过期回收站条目：")+days+(LANG==="en"?" days?":" 天？"))) return; try{ await apiPost("/api/memory/trash/cleanup",{days,confirm:true,source:"dashboard"}); __trashSelectedPaths.clear(); await refreshTrashData(); }catch(e){ alert("Trash cleanup failed: "+e.message);} }',
      '    async function deleteTrashSelected(){ const entries=[...__trashSelectedPaths].filter(Boolean); if(!entries.length) return; if(!window.confirm((LANG==="en"?"Delete selected trash entries permanently? ":"永久删除所选回收站条目？ ")+entries.length)) return; try{ await apiPost("/api/memory/trash/delete",{confirm:true,entries,source:"dashboard"}); __trashSelectedPaths.clear(); await refreshTrashData(); }catch(e){ alert("Trash delete failed: "+e.message);} }',
      '    async function editSummary(projectName,sessionID,current){ const modal=$("editModal"); const ta=$("editTextarea"); const saveBtn=$("editSaveBtn"); const cancelBtn=$("editCancelBtn"); $("editTitle").textContent=t("edit")+" - "+sessionID; ta.value=current||""; $("editCancelBtn").textContent=t("cancel"); $("editSaveBtn").textContent=t("save"); modal.style.display="flex"; const close=()=>{ modal.style.display="none"; }; cancelBtn.onclick=close; saveBtn.onclick=async()=>{ if(!window.confirm("Apply summary update and write audit log?")) return; try{ await apiPost("/api/memory/session/summary",{projectName,sessionID,summaryText:ta.value,confirm:true,source:"dashboard"}); close(); window.location.reload(); }catch(e){ alert("Update failed: "+e.message);} }; }',
      '    async function deleteSession(projectName,sessionID){ if(!window.confirm("Delete this session memory file? This writes an audit log.")) return; try{ await apiPost("/api/memory/session/delete",{projectName,sessionID,confirm:true,source:"dashboard"}); window.location.reload(); }catch(e){ alert("Delete failed: "+e.message);} }',
      '    async function batchDeleteSessions(projectName){ const ids=[...__selectedSessionIDs].filter(Boolean); if(!ids.length){ alert("请先勾选要删除的会话"); return; } if(!window.confirm("批量删除 "+ids.length+" 个会话记忆？将写入审计日志。")) return; try{ await apiPost("/api/memory/sessions/delete",{projectName,sessionIDs:ids,confirm:true,source:"dashboard"}); ids.forEach((id)=>__selectedSessionIDs.delete(id)); updateBatchDeleteBtn(); await refreshDashboardData(); }catch(e){ alert("Batch delete failed: "+e.message);} }',
      '    function applyLang(){ $("titleMain").textContent=t("title"); $("langLabel").textContent=t("lang"); $("globalTitle").textContent=t("global"); $("tokenHint").textContent=t("token"); const c=$("trashCleanupBtn"); if(c) c.textContent=t("trashCleanup"); updateTrashDeleteBtn(); }',
      '    function renderGlobalPrefs(){ const prefs=(DATA&&DATA.global&&DATA.global.preferences)||{}; const entries=Object.entries(prefs); if(!entries.length){globalPrefs.textContent=t("noproj")==="No project memory yet."?"No global preferences.":"暂无全局偏好"; return;} globalPrefs.innerHTML=""; entries.forEach(([k,v])=>{ const div=document.createElement("div"); div.className="pref"; div.textContent=k+": "+String(v); globalPrefs.appendChild(div); }); }',
      '    function renderSessions(project){ if(!project||!project.sessions||!project.sessions.length){ sessionList.className="empty"; sessionList.textContent=t("nos"); updateBatchDeleteBtn(); return;} sessionList.className=""; sessionList.innerHTML=""; project.sessions.forEach((s)=>{ const wrap=document.createElement("div"); wrap.className="session"; const head=document.createElement("div"); head.className="session-h"; const sel=document.createElement("input"); sel.type="checkbox"; sel.style.marginRight="8px"; sel.checked=__selectedSessionIDs.has(s.sessionID||""); sel.addEventListener("click",(e)=>e.stopPropagation()); sel.addEventListener("change",(e)=>{ if(e.target.checked) __selectedSessionIDs.add(s.sessionID||""); else __selectedSessionIDs.delete(s.sessionID||""); updateBatchDeleteBtn(); }); const sid=document.createElement("div"); sid.className="session-id"; const _title=(s.sessionTitle&&s.sessionTitle.trim())?s.sessionTitle:(s.sessionID||""); sid.textContent=_title+"  id:"+(s.sessionID||""); sid.style.whiteSpace="normal"; const st=document.createElement("div"); st.className="stats"; const bt=(s.budget&&s.budget.lastEstimatedBodyTokens)||0; const ig=(s.inject&&s.inject.globalPrefsCount)||0; const ic=(s.inject&&s.inject.currentSummaryCount)||0; const ir=(s.inject&&s.inject.triggerRecallCount)||0; const pa=s.pruneAudit||{}; const sp=s.sendPretrim||{}; const spLast=(sp.lastSavedTokens||0)>0?(" · 最近pretrim:"+(sp.lastBeforeTokens||0)+"→"+(sp.lastAfterTokens||0)+" (save~"+(sp.lastSavedTokens||0)+")"):""; const strictNow=(sp.traces&&sp.traces.length&&sp.traces[sp.traces.length-1].strictApplied)?(" · strict:ON("+((sp.traces[sp.traces.length-1].strictReplacedMessages)||0)+")"):""; const risk=(s.alerts&&s.alerts.contextStackRisk)?" · 风险:上下文叠加疑似":""; const reasonRaw=(s.inject&&s.inject.lastReason)||""; const reasonMap={\"global-prefs\":\"全局偏好注入\",\"current-session-refresh\":\"当前会话摘要注入\",\"trigger-recall\":\"跨会话召回注入\",\"memory-docs\":\"记忆文档注入\",\"memory-inject\":\"手动注入\"}; const reasonZh=reasonMap[reasonRaw]||\"无\"; const injectAt=(s.inject&&s.inject.lastAt)?new Date(s.inject.lastAt).toLocaleString():\"无\"; st.textContent=\"u:\"+(s.stats.userMessages||0)+\" · a:\"+(s.stats.assistantMessages||0)+\" · t:\"+(s.stats.toolResults||0)+\" · r:\"+((s.recall&&s.recall.count)||0)+\" · 注入:g\"+ig+\"/c\"+ic+\"/x\"+ir+\" · 最近注入:\"+reasonZh+\" @ \"+injectAt+\" · prune:auto\"+(pa.autoRuns||0)+\"/manual\"+(pa.manualRuns||0)+\" d\"+(pa.discardRemovedTotal||0)+\" e\"+(pa.extractMovedTotal||0)+\" · pretrim:auto\"+(sp.autoRuns||0)+\" saved~\"+(sp.savedTokensTotal||0)+spLast+strictNow+risk+\" · blocks:\"+(((s.summaryBlocks&&s.summaryBlocks.count)||0))+\" · 正文~\"+bt+\" tokens\"; const metaWrap=document.createElement("div"); metaWrap.style.display="flex"; metaWrap.style.flexDirection="column"; metaWrap.style.alignItems="flex-start"; metaWrap.style.gap="4px"; metaWrap.appendChild(sid); metaWrap.appendChild(st); head.appendChild(sel); head.appendChild(metaWrap); const events=document.createElement("div"); events.className="events"; const sorted=(s.recentEvents||[]).slice().sort((a,b)=>(Date.parse(a.ts||0)||0)-(Date.parse(b.ts||0)||0)); if(!sorted.length){ const empty=document.createElement("div"); empty.className="empty"; empty.textContent="No events."; events.appendChild(empty); } else { sorted.forEach((ev)=>{ const row=document.createElement("div"); row.className="ev "+(ev.kind||""); const meta=document.createElement("div"); meta.className="meta"; meta.textContent=(ev.kind||"event")+(ev.tool?" ["+ev.tool+"]":"")+" · "+(ev.ts?new Date(ev.ts).toLocaleString():""); const txt=document.createElement("div"); txt.className="txt"; txt.textContent=ev.summary||""; row.appendChild(meta); row.appendChild(txt); events.appendChild(row); }); } const actions=document.createElement("div"); actions.style.marginTop="8px"; const eb=document.createElement("button"); eb.textContent=t("edit"); eb.onclick=()=>{ const fallback=(s.summary&&s.summary.compressedText)||((s.recentEvents||[]).slice(-8).map((ev)=>"- "+(ev.kind||"event")+": "+(ev.summary||"")).join("\\n")); editSummary(project.name,s.sessionID,fallback); }; const db=document.createElement("button"); db.textContent=t("del"); db.style.marginLeft="8px"; db.onclick=()=>deleteSession(project.name,s.sessionID); actions.appendChild(eb); actions.appendChild(db); events.appendChild(actions); if(s.summary&&s.summary.compressedText){ const summary=document.createElement("div"); summary.className="ev"; const meta=document.createElement("div"); meta.className="meta"; const reason=(s.budget&&s.budget.lastCompactionReason)?(" · "+s.budget.lastCompactionReason):""; const paInfo=s.pruneAudit?(` · prune(last:${s.pruneAudit.lastSource||\"-\"}, d=${s.pruneAudit.lastDiscardRemoved||0}, e=${s.pruneAudit.lastExtractMoved||0})`):\"\"; meta.textContent=\"compressed summary\"+reason+paInfo; const txt=document.createElement("div"); txt.className="txt"; txt.textContent=s.summary.compressedText; summary.appendChild(meta); summary.appendChild(txt); events.appendChild(summary); } if(s.summaryBlocks&&Array.isArray(s.summaryBlocks.recent)&&s.summaryBlocks.recent.length){ const blk=document.createElement("div"); blk.className="ev"; const bm=document.createElement("div"); bm.className="meta"; bm.textContent="compressed blocks (latest "+s.summaryBlocks.recent.length+")"; const bt=document.createElement("div"); bt.className="txt"; bt.textContent=s.summaryBlocks.recent.map((b)=>`b${b.blockId} | ${b.source||"pretrim"} | m:${b.consumedMessages||0} | ${b.summaryPreview||""}`).join("\n"); blk.appendChild(bm); blk.appendChild(bt); events.appendChild(blk); } if(s.sendPretrim&&Array.isArray(s.sendPretrim.traces)&&s.sendPretrim.traces.length){ const tr=document.createElement("div"); tr.className="ev"; const m=document.createElement("div"); m.className="meta"; m.textContent="pretrim traces (latest 8)"; const t=document.createElement("div"); t.className="txt"; const rows=s.sendPretrim.traces.slice(-8).map((x)=>{ const ts=x.ts?new Date(x.ts).toLocaleString():"-"; const strict=x.strictApplied?(` | strict:${x.strictReplacedMessages||0}`):\"\"; const distill=x.distillUsed?(` | distill:${x.distillProvider||\"\"}/${x.distillModel||\"\"}`):(x.distillStatus?(` | distill-fail:${x.distillStatus}`):\"\"); const strat=((x.strategyDedup||0)||(x.strategySupersedeWrites||0)||(x.strategyPurgedErrors||0)||(x.strategyPhaseTrim||0))?(` | strat:d${x.strategyDedup||0}/s${x.strategySupersedeWrites||0}/p${x.strategyPurgedErrors||0}/ph${x.strategyPhaseTrim||0}`):\"\"; const block=(x.blockId?(` | block:b${x.blockId}`):\"\"); const anchor=x.anchorReplaceApplied?(` | anchor:${x.anchorReplaceMessages||0}/b${x.anchorReplaceBlocks||0}`):\"\"; const comp=(()=>{ const b=x.compositionBefore||{}; const a=x.compositionAfter||{}; const bt=(b.total||0), at=(a.total||0); if(!bt||!at) return \"\"; const pct=(v,t)=>Math.round((100*v)/Math.max(1,t)); return ` | comp S:${pct(b.system||0,bt)}→${pct(a.system||0,at)} U:${pct(b.user||0,bt)}→${pct(a.user||0,at)} T:${pct(b.tool||0,bt)}→${pct(a.tool||0,at)}`; })(); return `${ts} | ${x.beforeTokens||0}→${x.afterTokens||0} | save~${x.savedTokens||0} | rw:${x.rewrittenMessages||0}/${x.rewrittenParts||0} | ex:${x.extractedMessages||0}${strict}${distill}${strat}${block}${anchor}${comp} | ${x.reason||""}`; }); t.textContent=rows.join("\n"); tr.appendChild(m); tr.appendChild(t); events.appendChild(tr); } head.addEventListener("click", ()=>{ events.classList.toggle("open"); }); wrap.appendChild(head); wrap.appendChild(events); sessionList.appendChild(wrap); }); updateBatchDeleteBtn(); }',
      '    function setActiveProject(project,elem){ document.querySelectorAll(".project-item").forEach((e)=>e.classList.remove("active")); if(elem) elem.classList.add("active"); __activeProjectName=project.name||""; __selectedSessionIDs.clear(); projectTitle.textContent=project.name; const ts=(project.techStack&&project.techStack.length)?project.techStack.join(", "):"N/A"; projectMeta.textContent="sessions="+project.sessionCount+" · events="+project.totalEvents+" · tech="+ts; const b=$("batchDeleteBtn"); if(b) b.onclick=()=>batchDeleteSessions(project.name); renderSessions(project); updateBatchDeleteBtn(); }',
      '    function renderProjects(){ projectList.innerHTML=""; if(!DATA.projects.length){ const empty=document.createElement("div"); empty.className="empty"; empty.textContent=t("noproj"); projectList.appendChild(empty); return;} DATA.projects.forEach((p,i)=>{ const item=document.createElement("div"); item.className="project-item"; const name=document.createElement("div"); name.className="name"; name.textContent=p.name||""; const meta=document.createElement("div"); meta.className="meta"; meta.textContent="sessions="+p.sessionCount+" · events="+p.totalEvents; item.appendChild(name); item.appendChild(meta); item.addEventListener("click", ()=>setActiveProject(p,item)); projectList.appendChild(item); if(i===0) setActiveProject(p,item); }); }',
      '    let __autoRefreshTimer = null;',
      '    function startAutoRefresh(){ if(__autoRefreshTimer) clearInterval(__autoRefreshTimer); __autoRefreshTimer = setInterval(()=>{ refreshDashboardData(); }, 60000); }',
      '    document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState!=="visible") return; const now=Date.now(); if(now-(__lastRefreshAt||0)>=60000) refreshDashboardData(); });',
      '    langSel.value=LANG; langSel.onchange=()=>{ LANG=langSel.value; localStorage.setItem("memory_dashboard_lang",LANG); applyLang(); renderGlobalPrefs(); renderProjects(); renderTrash(); }; const cleanupBtn=$("trashCleanupBtn"); if(cleanupBtn) cleanupBtn.onclick=cleanupTrashNow; const delBtn=$("trashDeleteBtn"); if(delBtn) delBtn.onclick=deleteTrashSelected; const retentionSel=$("trashRetentionSel"); if(retentionSel) retentionSel.onchange=()=>{ __trashData.retentionDays=Number(retentionSel.value||30); renderTrash(); }; applyLang(); updateTrashDeleteBtn(); refreshDashboardData(); startAutoRefresh();',
      '  </script>',
      '</body>',
      '</html>'
    ];
    return html.join('\n');
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
Use /memory recall <query> to manually retrieve relevant memory from previous sessions.
</OPENCODE_KNOWLEDGE_BASE>
`;

  return {
    name: 'memory-system',
    tool: {
      memory: {
        description: 'Manage OpenCode memory system (learn, project, global, set, save, export, import, clear, edit, feedback, recall, sessions, dashboard)',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              enum: ['learn', 'project', 'global', 'set', 'prefer', 'save', 'export', 'import', 'clear', 'edit', 'feedback', 'recall', 'sessions', 'dashboard', 'discard', 'extract', 'prune', 'context', 'stats', 'doctor'],
              description: 'The memory command to execute'
            },
            args: {
              type: 'array',
              items: { type: 'string' },
              description: 'Arguments for the command'
            }
          },
          required: ['command']
        },
        execute: async (input = {}) => {
          let { command, args = [] } = input || {};
          const raw = input && typeof input === 'object' ? input : {};
          const memoryHelp = [
            'Memory commands:',
            '- learn',
            '- project',
            '- global',
            '- set <key> <value>',
            '- prefer <key> <value>',
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
            '- context [session <id>|current]',
            '- stats [project|session <id>]',
            '- doctor [session <id>|current]'
          ].join('\n');
          const projectMemoryPath = getProjectMemoryPath();
          const projectName = getProjectName();

          const normalizeGlobalKey = (key) => {
            const k = normalizeText(String(key || ''));
            if (!k) return '';
            if (k.includes('.')) return k;
            return `preferences.${k}`;
          };

          const inferPreferenceFromContent = (content) => {
            const text = normalizeText(String(content || ''));
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
            return { key: 'preferences.note', value: truncateText(text, 200) };
          };

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
          }

          const commandAlias = {
            get: 'global',
            view: 'global',
            remember: 'set',
            write: 'set',
            preference: 'set',
            preferences: 'set',
            prefer: 'prefer'
          };
          if (commandAlias[command]) command = commandAlias[command];

          if (!Array.isArray(args) || !args.length) {
            const rawArgs = pickFirstDefined(merged, ['args', 'arguments', 'argv', 'params', 'values']);
            args = toArgsArray(rawArgs);
          }
          if (!Array.isArray(args)) args = [];

          // OpenAI/Gemini compatibility:
          // {"action":"global","content":"...","operation":"learn"}
          // {"command":"set","key":"preferences.language","value":"Chinese"}
          if (command === 'global' || (command === 'learn' && String(pickFirstString(merged, ['action'])).toLowerCase() === 'global')) {
            const compatKey = pickFirstDefined(merged, ['key', 'path', 'field']);
            const compatValue = pickFirstDefined(merged, ['value', 'val']);
            const compatContent = pickFirstDefined(merged, ['content', 'text', 'query', 'message']);
            if (compatKey !== undefined && compatValue !== undefined && String(compatKey).trim()) {
              command = 'set';
              args = [normalizeGlobalKey(String(compatKey)), String(compatValue)];
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
                args = [normalizeGlobalKey(String(compatKey)), String(compatValue)];
              } else {
                const compatContent = pickFirstDefined(merged, ['content', 'text', 'query', 'message']);
                if (compatContent) {
                  const inferred = inferPreferenceFromContent(compatContent);
                  if (inferred) args = [inferred.key, inferred.value];
                }
              }
            }
          }

          if (!command || command === 'undefined' || typeof command !== 'string') {
            return memoryHelp;
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
              return `Global Memory:\n${JSON.stringify(memory, null, 2)}`;
            }

            case 'set': {
              if (args.length < 2) return 'Usage: /memory set <key> <value>';
              const key = args[0];
              const value = args.slice(1).join(' ');

              const globalMemory = readJson(globalMemoryPath);
              const parts = key.split('.');
              let current = globalMemory;
              for (let i = 0; i < parts.length - 1; i++) {
                if (!current[parts[i]]) current[parts[i]] = {};
                current = current[parts[i]];
              }
              current[parts[parts.length - 1]] = value;

              writeJson(globalMemoryPath, globalMemory);
              writeDashboardFiles();
              return `Global setting updated: ${key} = ${value}`;
            }

            case 'prefer': {
              if (args.length < 2) return 'Usage: /memory prefer <key> <value>';
              const key = normalizeGlobalKey(args[0]);
              const value = args.slice(1).join(' ');
              if (!key) return 'Usage: /memory prefer <key> <value>';

              const globalMemory = readJson(globalMemoryPath);
              const parts = key.split('.');
              let current = globalMemory;
              for (let i = 0; i < parts.length - 1; i++) {
                if (!current[parts[i]]) current[parts[i]] = {};
                current = current[parts[i]];
              }
              current[parts[parts.length - 1]] = value;

              writeJson(globalMemoryPath, globalMemory);
              writeDashboardFiles();
              return `Global preference updated: ${key} = ${value}`;
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
                  budget: AUTO_SEND_PRETRIM_BUDGET,
                  target: AUTO_SEND_PRETRIM_TARGET,
                  stage2Trigger: Math.max(
                    AUTO_SEND_PRETRIM_TARGET + 200,
                    Math.min(
                      Math.floor(AUTO_SEND_PRETRIM_BUDGET * AUTO_SEND_PRETRIM_HARD_RATIO),
                      Math.floor(AUTO_SEND_PRETRIM_BUDGET * AUTO_SEND_PRETRIM_DISTILL_TRIGGER_RATIO)
                    )
                  ),
                  turnProtection: AUTO_SEND_PRETRIM_TURN_PROTECTION
                },
                strategyConfig: {
                  deduplication: AUTO_STRATEGY_DEDUP_ENABLED,
                  supersedeWrites: AUTO_STRATEGY_SUPERSEDE_WRITES_ENABLED,
                  purgeErrors: AUTO_STRATEGY_PURGE_ERRORS_ENABLED,
                  purgeErrorTurns: AUTO_STRATEGY_PURGE_ERROR_TURNS,
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
                budget: sess?.budget || {},
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
                  budget: sess?.budget || {},
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
                  budget: AUTO_SEND_PRETRIM_BUDGET,
                  target: AUTO_SEND_PRETRIM_TARGET,
                  stage2Trigger: Math.max(
                    AUTO_SEND_PRETRIM_TARGET + 200,
                    Math.min(
                      Math.floor(AUTO_SEND_PRETRIM_BUDGET * AUTO_SEND_PRETRIM_HARD_RATIO),
                      Math.floor(AUTO_SEND_PRETRIM_BUDGET * AUTO_SEND_PRETRIM_DISTILL_TRIGGER_RATIO)
                    )
                  ),
                  turnProtection: AUTO_SEND_PRETRIM_TURN_PROTECTION
                },
                strategyConfig: {
                  deduplication: AUTO_STRATEGY_DEDUP_ENABLED,
                  supersedeWrites: AUTO_STRATEGY_SUPERSEDE_WRITES_ENABLED,
                  purgeErrors: AUTO_STRATEGY_PURGE_ERRORS_ENABLED,
                  purgeErrorTurns: AUTO_STRATEGY_PURGE_ERROR_TURNS,
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
              const payload = {
                sessionID: sid,
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
                  lastSkipReason: inject.lastSkipReason || ''
                },
                pretrim: {
                  happened: Number(sp.autoRuns || 0) + Number(sp.manualRuns || 0) > 0,
                  strictModeEnabled: isStrictModeEnabled(),
                  suppressCurrentSummaryNow: shouldSuppressCurrentSummaryInjection(sid, projectName),
                  autoRuns: Number(sp.autoRuns || 0),
                  manualRuns: Number(sp.manualRuns || 0),
                  savedTokensTotal: Number(sp.savedTokensTotal || 0),
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
                    strategyDedup: Number(lastTrace.strategyDedup || 0),
                    strategySupersedeWrites: Number(lastTrace.strategySupersedeWrites || 0),
                    strategyPurgedErrors: Number(lastTrace.strategyPurgedErrors || 0),
                    strategyPhaseTrim: Number(lastTrace.strategyPhaseTrim || 0),
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
                  hit: Boolean(alerts.contextStackRisk)
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
                maxRemovals: aggressive ? 60 : AUTO_DISCARD_MAX_REMOVALS_PER_PASS
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
              if (AUTO_VISIBLE_NOTICE_FOR_DISCARD && (res.removed || 0) > 0) {
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
              let maxEvents = AUTO_EXTRACT_EVENTS_PER_PASS;
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
              if (AUTO_VISIBLE_NOTICE_FOR_DISCARD && (res.extracted || 0) > 0) {
                await emitVisibleNotice(
                  sid,
                  `已蒸馏 ${res.extracted} 条历史对话到结构化摘要，正文估算 ~${est} tokens`,
                  'extract:manual'
                );
              }
              return `Extract completed for ${sid}: extracted=${res.extracted || 0} (into compressed summary)`;
            }

            case 'prune': {
              let targetSessionID = '';
              if (args[0] === 'session') targetSessionID = args[1] || '';
              const sid = targetSessionID || [...sessionUserMessageCounters.keys()].slice(-1)[0];
              if (!sid) return 'No active session id found. Use: /memory prune session <id>';
              const sess = loadSessionMemory(sid, projectName);
              const d = discardLowValueToolEvents(sess);
              const e = extractSessionContext(sess);
              const c = compactConversationByBudget(sess) || { extracted: 0 };
              const est = estimateBodyTokens(sess);
              recordPruneAudit(sess, {
                source: 'manual-prune',
                discardRemoved: Number(d.removed || 0),
                extractMoved: Number(e.extracted || 0) + Number(c.extracted || 0),
                estimatedTokens: est
              });
              persistSessionMemory(sess, projectName);
              writeDashboardFiles();
              if (AUTO_VISIBLE_NOTICE_FOR_DISCARD && ((d.removed || 0) > 0 || (e.extracted || 0) > 0)) {
                await emitVisibleNotice(
                  sid,
                  `已执行裁剪：discard=${d.removed || 0}，extract=${e.extracted || 0}，正文估算 ~${est} tokens`,
                  'prune:manual'
                );
              }
              return `Prune completed for ${sid}: discard=${d.removed || 0}, extract=${e.extracted || 0}, estBodyTokens=${est}`;
            }

            case 'recall': {
              const query = args.join(' ').trim();
              if (!query) return 'Usage: /memory recall <query>';

              const { text, hits, estimatedTokens } = recallProjectMemories(query, {
                includeCurrent: true,
                maxSessions: 3,
                maxEventsPerSession: 5,
                maxChars: 2200,
                tokenBudget: AUTO_RECALL_TOKEN_BUDGET
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

            default:
              return `Unknown memory command: ${command}\n\n${memoryHelp}`;
          }
        }
      },
      context: {
        description: 'Manage session context (add, view, clear)',
        parameters: {
          type: 'object',
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
          },
          required: ['command']
        },
        execute: async ({ command, args = [] }) => {
          const contextHelp = [
            'Context commands:',
            '- add <text>',
            '- view',
            '- clear'
          ].join('\n');
          if (!command || command === 'undefined' || typeof command !== 'string') {
            return contextHelp;
          }
          switch (command) {
            case 'add':
              return `Added to context: ${args.join(' ')}`;
            case 'view':
              return 'Current Session Context:\n- (Mock) Active File: None\n- (Mock) Recent Changes: None';
            case 'clear':
              return 'Session context cleared.';
            default:
              return `Unknown context command: ${command}\n\n${contextHelp}`;
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
            maxRemovals: aggressive ? 60 : AUTO_DISCARD_MAX_REMOVALS_PER_PASS
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
          if (AUTO_VISIBLE_NOTICE_FOR_DISCARD && (d.removed || 0) > 0) {
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
        execute: async ({ sessionID = '', maxEvents = AUTO_EXTRACT_EVENTS_PER_PASS } = {}) => {
          const projectName = getProjectName();
          const sid = sessionID || [...sessionUserMessageCounters.keys()].slice(-1)[0];
          if (!sid) return 'No active session id found.';
          const sess = loadSessionMemory(sid, projectName);
          const e = extractSessionContext(sess, { maxExtract: Number(maxEvents || AUTO_EXTRACT_EVENTS_PER_PASS) });
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
          if (AUTO_VISIBLE_NOTICE_FOR_DISCARD && (e.extracted || 0) > 0) {
            await emitVisibleNotice(
              sid,
              `已蒸馏 ${e.extracted} 条历史对话到结构化摘要，正文估算 ~${est} tokens`,
              'extract:tool'
            );
          }
          return `extract ok: session=${sid}, extracted=${e.extracted || 0}, estBodyTokens=${est}`;
        }
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const messages = Array.isArray(output?.messages) ? output.messages : [];
        if (!messages.length) return;

        const sid = inferSessionIDFromMessages(messages);
        let lastUser = null;
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (normalizeText(String(messages[i]?.info?.role || '')).toLowerCase() === 'user') {
            lastUser = messages[i];
            break;
          }
        }
        const agent = normalizeText(String(lastUser?.info?.agent || '')).toLowerCase();
        if (agent && agent !== 'orchestrator') {
          if (sid) {
            recordSendPretrimAudit(sid, {
              beforeTokens: estimateOutgoingMessagesTokens(messages),
              afterTokens: estimateOutgoingMessagesTokens(messages),
              savedTokens: 0,
              reason: `subagent_bypass:${agent}`
            }, 'auto');
          }
          return;
        }

        const stats = await applySendPretrim(messages, sid);
        if (sid) {
          if (stats.strictApplied) sessionStrictHitAt.set(sid, Date.now());
          recordSendPretrimAudit(sid, stats, 'auto');
          if (stats.savedTokens > 0) writeDashboardFiles();
        }
      } catch (err) {
        console.error('memory-system send pretrim hook failed:', err);
      }
    },
    event: async ({ event }) => {
      const sessionID = extractSessionID(event);
      maybeSetRuntimeSessionTitle(event);

      if (event.type === 'session.created' && sessionID) {
        sessionUserMessageCounters.set(sessionID, 0);
        return;
      }

      if (!sessionID) return;

      if (event.type === 'message.updated') {
        const info = event?.properties?.info || {};
        const role = info?.role === 'assistant' ? 'assistant' : info?.role === 'user' ? 'user' : '';
        const messageID = extractMessageID(event);
        if (!role || !messageID) return;

        const roleKey = `${sessionID}:${messageID}`;
        messageRoleByID.set(roleKey, role);

        const dedupeKey = `msg:${roleKey}:${role}`;
        if (processedMessageKeys.has(dedupeKey)) return;
        processedMessageKeys.add(dedupeKey);

        const text = extractMessageSummaryFromInfo(info);
        if (role === 'user') {
          await processUserMessageEvent(sessionID, text, event);
          return;
        }

        if (text) {
          appendAutoEvent({
            sessionID,
            kind: 'assistant-message',
            summary: text,
            rawEvent: event
          });
        }
        return;
      }

      if (event.type === 'message.part.updated') {
        const part = event?.properties?.part;
        if (!part || !part.messageID) return;

        const role = messageRoleByID.get(`${sessionID}:${part.messageID}`) || 'assistant';

        if (part.type === 'text') {
          const text = extractContentText(part.text || event?.properties?.delta || '');
          if (!text) return;
          // Avoid double-counting user messages:
          // user text is already handled by `message.updated` / `user.message`.
          if (role === 'user') return;
          appendAutoEvent({
            sessionID,
            kind: role === 'user' ? 'user-message' : 'assistant-message',
            summary: text,
            rawEvent: event
          });
          return;
        }

        if (part.type === 'tool') {
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
        await processUserMessageEvent(sessionID, text, event);
        return;
      }

      if (event.type === 'assistant.message') {
        const text = extractContentText(event?.data?.content || event?.content || event?.data?.text || '');
        appendAutoEvent({
          sessionID,
          kind: 'assistant-message',
          summary: text || 'Assistant message event',
          rawEvent: event
        });
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
        sessionRecallState.delete(sessionID);
        sessionTitleByID.delete(sessionID);
        sessionUserDedupeState.delete(sessionID);
        sessionStrictHitAt.delete(sessionID);
      }

      if (event.type === 'session.deleted') {
        sessionUserMessageCounters.delete(sessionID);
        sessionRecallState.delete(sessionID);
        sessionTitleByID.delete(sessionID);
        sessionUserDedupeState.delete(sessionID);
        sessionStrictHitAt.delete(sessionID);
      }
    }
  };
};
