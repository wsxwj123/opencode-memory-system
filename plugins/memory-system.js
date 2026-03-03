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
  const AUTO_RECALL_COOLDOWN_MS = 45_000;
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

  // Dashboard controls
  const DASHBOARD_MAX_EVENTS_PER_SESSION_VIEW = 30;
  const AUTO_DASHBOARD_AUTOSTART = true;
  const AUTO_DASHBOARD_PORT = 37777;
  const AUTO_OPENCODE_WEB_PORT = 4096;
  const AUTO_VISIBLE_NOTICES = false;
  const AUTO_VISIBLE_NOTICE_COOLDOWN_MS = 30000;
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
        lastStatus: ''
      },
      budget: {
        bodyTokenBudget: AUTO_BODY_TOKEN_BUDGET,
        lastEstimatedBodyTokens: 0,
        lastCompactedAt: null,
        lastCompactionReason: ''
      },
      pruneAudit: defaultPruneAudit(),
      lastFingerprint: ''
    };
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
        ensurePruneAudit(data);
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

      writeJson(sessionPath, sessionData);
      if (fs.statSync(sessionPath).size <= AUTO_SESSION_FILE_TARGET_BYTES) break;
    }
  }

  function persistSessionMemory(sessionData, projectName = getProjectName()) {
    sessionData.updatedAt = new Date().toISOString();
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

  async function processUserMessageEvent(sessionID, text, rawEvent) {
    const clean = normalizeText(String(text || ''));
    if (!clean || isMemoryInjectionText(clean)) return;
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
      currentCount % AUTO_CURRENT_SESSION_REFRESH_EVERY === 0
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
    if (prev && prev.key === key && (now - prev.at) < AUTO_VISIBLE_NOTICE_COOLDOWN_MS) return false;
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
        const mem = loadSessionMemory(sessionID);
        mem.inject = mem.inject || {};
        if (reason === 'global-prefs') mem.inject.globalPrefsCount = Number(mem.inject.globalPrefsCount || 0) + 1;
        if (reason === 'current-session-refresh') mem.inject.currentSummaryCount = Number(mem.inject.currentSummaryCount || 0) + 1;
        if (reason === 'trigger-recall') mem.inject.triggerRecallCount = Number(mem.inject.triggerRecallCount || 0) + 1;
        if (reason === 'memory-docs') mem.inject.memoryDocsCount = Number(mem.inject.memoryDocsCount || 0) + 1;
        mem.inject.lastAt = new Date().toISOString();
        mem.inject.lastReason = String(reason || 'memory-inject');
        mem.inject.lastStatus = 'success';
        persistSessionMemory(mem);
        writeDashboardFiles();
      };
      const noteInjectFailed = () => {
        const mem = loadSessionMemory(sessionID);
        mem.inject = mem.inject || {};
        mem.inject.lastAt = new Date().toISOString();
        mem.inject.lastReason = String(reason || 'memory-inject');
        mem.inject.lastStatus = 'failed';
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
          lastStatus: sess?.inject?.lastStatus || ''
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
        }
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
      '    const I18N = { zh:{title:"记忆看板",lang:"语言",global:"全局偏好",token:"Token 估算为近似值（chars/4）",edit:"编辑摘要",del:"删除会话",nos:"暂无会话",noproj:"暂无项目记忆",save:"保存",cancel:"取消"}, en:{title:"Memory Dashboard",lang:"Language",global:"Global Preferences",token:"Token estimate is approximate (chars/4).",edit:"Edit summary",del:"Delete session",nos:"No sessions.",noproj:"No project memory yet.",save:"Save",cancel:"Cancel"} };',
      '    let LANG = localStorage.getItem("memory_dashboard_lang") || "zh";',
      '    const __selectedSessionIDs = new Set();',
      '    let __activeProjectName = "";',
      '    function updateBatchDeleteBtn(){ const b=$("batchDeleteBtn"); if(!b) return; const n=__selectedSessionIDs.size; b.textContent=n>0?("批量删除("+n+")"):"批量删除"; b.disabled=n===0; }',
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
      '    }',
      '    async function apiPost(url,payload){ const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}); if(!r.ok) throw new Error(await r.text()); return r.json(); }',
      '    async function editSummary(projectName,sessionID,current){ const modal=$("editModal"); const ta=$("editTextarea"); const saveBtn=$("editSaveBtn"); const cancelBtn=$("editCancelBtn"); $("editTitle").textContent=t("edit")+" - "+sessionID; ta.value=current||""; $("editCancelBtn").textContent=t("cancel"); $("editSaveBtn").textContent=t("save"); modal.style.display="flex"; const close=()=>{ modal.style.display="none"; }; cancelBtn.onclick=close; saveBtn.onclick=async()=>{ if(!window.confirm("Apply summary update and write audit log?")) return; try{ await apiPost("/api/memory/session/summary",{projectName,sessionID,summaryText:ta.value,confirm:true,source:"dashboard"}); close(); window.location.reload(); }catch(e){ alert("Update failed: "+e.message);} }; }',
      '    async function deleteSession(projectName,sessionID){ if(!window.confirm("Delete this session memory file? This writes an audit log.")) return; try{ await apiPost("/api/memory/session/delete",{projectName,sessionID,confirm:true,source:"dashboard"}); window.location.reload(); }catch(e){ alert("Delete failed: "+e.message);} }',
      '    async function batchDeleteSessions(projectName){ const ids=[...__selectedSessionIDs].filter(Boolean); if(!ids.length){ alert("请先勾选要删除的会话"); return; } if(!window.confirm("批量删除 "+ids.length+" 个会话记忆？将写入审计日志。")) return; try{ await apiPost("/api/memory/sessions/delete",{projectName,sessionIDs:ids,confirm:true,source:"dashboard"}); ids.forEach((id)=>__selectedSessionIDs.delete(id)); updateBatchDeleteBtn(); await refreshDashboardData(); }catch(e){ alert("Batch delete failed: "+e.message);} }',
      '    function applyLang(){ $("titleMain").textContent=t("title"); $("langLabel").textContent=t("lang"); $("globalTitle").textContent=t("global"); $("tokenHint").textContent=t("token"); }',
      '    function renderGlobalPrefs(){ const prefs=(DATA&&DATA.global&&DATA.global.preferences)||{}; const entries=Object.entries(prefs); if(!entries.length){globalPrefs.textContent=t("noproj")==="No project memory yet."?"No global preferences.":"暂无全局偏好"; return;} globalPrefs.innerHTML=""; entries.forEach(([k,v])=>{ const div=document.createElement("div"); div.className="pref"; div.textContent=k+": "+String(v); globalPrefs.appendChild(div); }); }',
      '    function renderSessions(project){ if(!project||!project.sessions||!project.sessions.length){ sessionList.className="empty"; sessionList.textContent=t("nos"); updateBatchDeleteBtn(); return;} sessionList.className=""; sessionList.innerHTML=""; project.sessions.forEach((s)=>{ const wrap=document.createElement("div"); wrap.className="session"; const head=document.createElement("div"); head.className="session-h"; const sel=document.createElement("input"); sel.type="checkbox"; sel.style.marginRight="8px"; sel.checked=__selectedSessionIDs.has(s.sessionID||""); sel.addEventListener("click",(e)=>e.stopPropagation()); sel.addEventListener("change",(e)=>{ if(e.target.checked) __selectedSessionIDs.add(s.sessionID||""); else __selectedSessionIDs.delete(s.sessionID||""); updateBatchDeleteBtn(); }); const sid=document.createElement("div"); sid.className="session-id"; const _title=(s.sessionTitle&&s.sessionTitle.trim())?s.sessionTitle:(s.sessionID||""); sid.textContent=_title+"  id:"+(s.sessionID||""); sid.style.whiteSpace="normal"; const st=document.createElement("div"); st.className="stats"; const bt=(s.budget&&s.budget.lastEstimatedBodyTokens)||0; const ig=(s.inject&&s.inject.globalPrefsCount)||0; const ic=(s.inject&&s.inject.currentSummaryCount)||0; const ir=(s.inject&&s.inject.triggerRecallCount)||0; const pa=s.pruneAudit||{}; const reasonRaw=(s.inject&&s.inject.lastReason)||""; const reasonMap={\"global-prefs\":\"全局偏好注入\",\"current-session-refresh\":\"当前会话摘要注入\",\"trigger-recall\":\"跨会话召回注入\",\"memory-docs\":\"记忆文档注入\",\"memory-inject\":\"手动注入\"}; const reasonZh=reasonMap[reasonRaw]||\"无\"; const injectAt=(s.inject&&s.inject.lastAt)?new Date(s.inject.lastAt).toLocaleString():\"无\"; st.textContent=\"u:\"+(s.stats.userMessages||0)+\" · a:\"+(s.stats.assistantMessages||0)+\" · t:\"+(s.stats.toolResults||0)+\" · r:\"+((s.recall&&s.recall.count)||0)+\" · 注入:g\"+ig+\"/c\"+ic+\"/x\"+ir+\" · 最近注入:\"+reasonZh+\" @ \"+injectAt+\" · prune:auto\"+(pa.autoRuns||0)+\"/manual\"+(pa.manualRuns||0)+\" d\"+(pa.discardRemovedTotal||0)+\" e\"+(pa.extractMovedTotal||0)+\" · 正文~\"+bt+\" tokens\"; const metaWrap=document.createElement("div"); metaWrap.style.display="flex"; metaWrap.style.flexDirection="column"; metaWrap.style.alignItems="flex-start"; metaWrap.style.gap="4px"; metaWrap.appendChild(sid); metaWrap.appendChild(st); head.appendChild(sel); head.appendChild(metaWrap); const events=document.createElement("div"); events.className="events"; const sorted=(s.recentEvents||[]).slice().sort((a,b)=>(Date.parse(a.ts||0)||0)-(Date.parse(b.ts||0)||0)); if(!sorted.length){ const empty=document.createElement("div"); empty.className="empty"; empty.textContent="No events."; events.appendChild(empty); } else { sorted.forEach((ev)=>{ const row=document.createElement("div"); row.className="ev "+(ev.kind||""); const meta=document.createElement("div"); meta.className="meta"; meta.textContent=(ev.kind||"event")+(ev.tool?" ["+ev.tool+"]":"")+" · "+(ev.ts?new Date(ev.ts).toLocaleString():""); const txt=document.createElement("div"); txt.className="txt"; txt.textContent=ev.summary||""; row.appendChild(meta); row.appendChild(txt); events.appendChild(row); }); } const actions=document.createElement("div"); actions.style.marginTop="8px"; const eb=document.createElement("button"); eb.textContent=t("edit"); eb.onclick=()=>{ const fallback=(s.summary&&s.summary.compressedText)||((s.recentEvents||[]).slice(-8).map((ev)=>"- "+(ev.kind||"event")+": "+(ev.summary||"")).join("\\n")); editSummary(project.name,s.sessionID,fallback); }; const db=document.createElement("button"); db.textContent=t("del"); db.style.marginLeft="8px"; db.onclick=()=>deleteSession(project.name,s.sessionID); actions.appendChild(eb); actions.appendChild(db); events.appendChild(actions); if(s.summary&&s.summary.compressedText){ const summary=document.createElement("div"); summary.className="ev"; const meta=document.createElement("div"); meta.className="meta"; const reason=(s.budget&&s.budget.lastCompactionReason)?(" · "+s.budget.lastCompactionReason):""; const paInfo=s.pruneAudit?(` · prune(last:${s.pruneAudit.lastSource||\"-\"}, d=${s.pruneAudit.lastDiscardRemoved||0}, e=${s.pruneAudit.lastExtractMoved||0})`):\"\"; meta.textContent=\"compressed summary\"+reason+paInfo; const txt=document.createElement("div"); txt.className="txt"; txt.textContent=s.summary.compressedText; summary.appendChild(meta); summary.appendChild(txt); events.appendChild(summary); } head.addEventListener("click", ()=>{ events.classList.toggle("open"); }); wrap.appendChild(head); wrap.appendChild(events); sessionList.appendChild(wrap); }); updateBatchDeleteBtn(); }',
      '    function setActiveProject(project,elem){ document.querySelectorAll(".project-item").forEach((e)=>e.classList.remove("active")); if(elem) elem.classList.add("active"); __activeProjectName=project.name||""; __selectedSessionIDs.clear(); projectTitle.textContent=project.name; const ts=(project.techStack&&project.techStack.length)?project.techStack.join(", "):"N/A"; projectMeta.textContent="sessions="+project.sessionCount+" · events="+project.totalEvents+" · tech="+ts; const b=$("batchDeleteBtn"); if(b) b.onclick=()=>batchDeleteSessions(project.name); renderSessions(project); updateBatchDeleteBtn(); }',
      '    function renderProjects(){ projectList.innerHTML=""; if(!DATA.projects.length){ const empty=document.createElement("div"); empty.className="empty"; empty.textContent=t("noproj"); projectList.appendChild(empty); return;} DATA.projects.forEach((p,i)=>{ const item=document.createElement("div"); item.className="project-item"; const name=document.createElement("div"); name.className="name"; name.textContent=p.name||""; const meta=document.createElement("div"); meta.className="meta"; meta.textContent="sessions="+p.sessionCount+" · events="+p.totalEvents; item.appendChild(name); item.appendChild(meta); item.addEventListener("click", ()=>setActiveProject(p,item)); projectList.appendChild(item); if(i===0) setActiveProject(p,item); }); }',
      '    let __autoRefreshTimer = null;',
      '    function startAutoRefresh(){ if(__autoRefreshTimer) clearInterval(__autoRefreshTimer); __autoRefreshTimer = setInterval(()=>{ refreshDashboardData(); }, 60000); }',
      '    document.addEventListener("visibilitychange", ()=>{ if(document.visibilityState!=="visible") return; const now=Date.now(); if(now-(__lastRefreshAt||0)>=60000) refreshDashboardData(); });',
      '    langSel.value=LANG; langSel.onchange=()=>{ LANG=langSel.value; localStorage.setItem("memory_dashboard_lang",LANG); applyLang(); renderGlobalPrefs(); renderProjects(); }; applyLang(); refreshDashboardData(); startAutoRefresh();',
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
              enum: ['learn', 'project', 'global', 'set', 'prefer', 'save', 'export', 'import', 'clear', 'edit', 'feedback', 'recall', 'sessions', 'dashboard', 'discard', 'extract', 'prune'],
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
            '- prune [session <id>|current]'
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
          if (role === 'user') {
            await processUserMessageEvent(sessionID, text, event);
            return;
          }
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
        const text = extractContentText(event?.data?.content || event?.content || event?.data?.text || '');
        const isFirstUserMessageForSession = !hasSessionMemoryFile(sessionID);

        if (isFirstUserMessageForSession) {
          appendAutoEvent({
            sessionID,
            kind: 'session-start',
            summary: 'Session created',
            rawEvent: event
          });

          if (AUTO_INJECT_MEMORY_DOCS) {
            await injectMemoryText(sessionID, memoryDocs, 'memory-docs');
          }

          if (AUTO_INJECT_GLOBAL_PREFS_ON_SESSION_START) {
            const globalText = buildGlobalPrefsContextText();
            if (globalText) await injectMemoryText(sessionID, globalText, 'global-prefs');
          }
        }

        appendAutoEvent({
          sessionID,
          kind: 'user-message',
          summary: text || 'User message event',
          rawEvent: event
        });

        const currentCount = (sessionUserMessageCounters.get(sessionID) || 0) + 1;
        sessionUserMessageCounters.set(sessionID, currentCount);

        if (
          AUTO_CURRENT_SESSION_SUMMARY_ENABLED &&
          currentCount >= AUTO_CURRENT_SESSION_REFRESH_EVERY &&
          currentCount % AUTO_CURRENT_SESSION_REFRESH_EVERY === 0
        ) {
          const currentSummary = buildCurrentSessionSummaryText(sessionID);
          if (currentSummary) {
            await injectMemoryText(sessionID, currentSummary, 'current-session-refresh');
          }
        }

        if (AUTO_RECALL_ENABLED && (shouldTriggerRecall(text) || referencesAnotherSessionTitle(text, sessionID))) {
          await maybeInjectTriggerRecall(sessionID, text);
        }
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
      }

      if (event.type === 'session.deleted') {
        sessionUserMessageCounters.delete(sessionID);
        sessionRecallState.delete(sessionID);
        sessionTitleByID.delete(sessionID);
      }
    }
  };
};
