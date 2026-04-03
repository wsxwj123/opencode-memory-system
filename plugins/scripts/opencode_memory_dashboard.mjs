#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import vm from 'vm';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const action = (process.argv[2] || 'start').toLowerCase();
const port = Number(process.argv[3] || 37777);
const isServeMode = action === 'serve';
const parentPidArg = Number(process.argv[4] || 0);
const opencodePortArg = Number(process.argv[5] || 4096);
const watchdogIntervalMs = Math.max(500, Number(process.env.OPENCODE_MEMORY_DASHBOARD_WATCHDOG_INTERVAL_MS || 10000));
const watchdogMaxMiss = Math.max(2, Number(process.env.OPENCODE_MEMORY_DASHBOARD_WATCHDOG_MAX_MISS || 12));
const thisFile = fileURLToPath(import.meta.url);

const home = os.homedir();
const isWindows = process.platform === 'win32';
const memoryDir = path.join(home, '.opencode', 'memory');
const projectsDir = path.join(memoryDir, 'projects');
const globalMemoryPath = path.join(memoryDir, 'global.json');
const dashboardDir = path.join(home, '.opencode', 'memory', 'dashboard');
const indexPath = path.join(dashboardDir, 'index.html');
const dataPath = path.join(dashboardDir, 'data.json');
const auditDir = path.join(memoryDir, 'audit');
const auditPath = path.join(auditDir, 'memory-audit.jsonl');
const trashDir = path.join(memoryDir, 'trash');
const memoryConfigPath = path.join(memoryDir, 'config.json');
const statePath = path.join(dashboardDir, '.dashboard-server.json');
const dockerContainer = `opencode-memory-dashboard-${port}`;
const RETENTION_OPTIONS = new Set([1, 3, 7, 10, 30]);
const DEFAULT_RETENTION_DAYS = 30;
const OPENCODE_DB_CANDIDATES = [
  path.join(home, '.local', 'share', 'opencode', 'opencode.db'),
  path.join(home, 'AppData', 'Roaming', 'opencode', 'opencode.db')
];

function pickPluginSourcePath() {
  const candidates = [
    path.join(home, '.config', 'opencode', 'plugins', 'memory-system.js'),
    path.join(home, 'AppData', 'Roaming', 'opencode', 'plugins', 'memory-system.js')
  ];
  let best = '';
  let bestMtime = 0;
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.mtimeMs > bestMtime) {
        best = p;
        bestMtime = st.mtimeMs;
      }
    } catch {
      // ignore missing candidate
    }
  }
  return best;
}

function extractFunctionText(source, fnName) {
  const sig = `function ${fnName}(data) {`;
  const start = source.indexOf(sig);
  if (start < 0) return '';
  let i = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return '';
  return source.slice(start, end + 1);
}

function getDashboardDataFallback() {
  return {
    generatedAt: new Date().toISOString(),
    settings: { memorySystem: {} },
    global: { preferences: {}, snippets: {}, feedback: [] },
    projects: [],
    summary: { projectCount: 0, sessionCount: 0, eventCount: 0 }
  };
}

function syncDashboardHtmlFromPlugin() {
  try {
    const pluginPath = pickPluginSourcePath();
    if (!pluginPath) return { ok: false, reason: 'plugin_source_not_found' };
    const data = safeReadJson(dataPath) || getDashboardDataFallback();
    const src = fs.readFileSync(pluginPath, 'utf8');
    const fnText = extractFunctionText(src, 'buildDashboardHtmlLegacy');
    if (!fnText) return { ok: false, reason: 'buildDashboardHtmlLegacy_not_found' };
    const context = { __data: data, __html: '' };
    vm.createContext(context);
    vm.runInContext(`${fnText}\n__html = buildDashboardHtmlLegacy(__data);`, context, { timeout: 3000 });
    const html = String(context.__html || '');
    if (!html.includes('<!doctype html>') || !html.includes('/api/dashboard')) {
      return { ok: false, reason: 'generated_html_invalid' };
    }
    const oldHtml = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
    if (oldHtml !== html) {
      fs.writeFileSync(indexPath, html, 'utf8');
      return { ok: true, reason: 'updated_from_legacy', source: pluginPath };
    }
    return { ok: true, reason: 'already_latest_legacy', source: pluginPath };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

function ensureDashboardDir() {
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(trashDir, { recursive: true });
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      `<!doctype html>
<html><head><meta charset="utf-8"><title>Memory Dashboard</title></head>
<body><h3>Memory dashboard file not generated yet.</h3><p>Run OpenCode with memory plugin, then refresh.</p></body></html>`,
      'utf8'
    );
  }
  // Keep dashboard template aligned with latest plugin source on every startup.
  syncDashboardHtmlFromPlugin();
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function readMemoryConfig() {
  const cfg = safeReadJson(memoryConfigPath);
  if (!cfg || typeof cfg !== 'object') return { trashRetentionDays: DEFAULT_RETENTION_DAYS, memorySystem: {} };
  const raw = Number(cfg.trashRetentionDays || DEFAULT_RETENTION_DAYS);
  const days = RETENTION_OPTIONS.has(raw) ? raw : DEFAULT_RETENTION_DAYS;
  const memorySystem = cfg.memorySystem && typeof cfg.memorySystem === 'object' ? cfg.memorySystem : {};
  return { ...cfg, trashRetentionDays: days, memorySystem };
}

function getTrashRetentionDays() {
  const cfg = readMemoryConfig();
  return Number(cfg.trashRetentionDays || DEFAULT_RETENTION_DAYS);
}

function getMemorySystemSettings() {
  const cfg = readMemoryConfig();
  return cfg.memorySystem && typeof cfg.memorySystem === 'object' ? cfg.memorySystem : {};
}

function updateMemorySystemSettings(patch = {}) {
  const cfg = readMemoryConfig();
  const current = cfg.memorySystem && typeof cfg.memorySystem === 'object' ? cfg.memorySystem : {};
  cfg.memorySystem = { ...current, ...patch };
  writeJson(memoryConfigPath, cfg);
  return cfg.memorySystem;
}

function listTrashEntries() {
  const out = [];
  if (!fs.existsSync(trashDir)) return out;
  let projects = [];
  try {
    projects = fs.readdirSync(trashDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    projects = [];
  }
  for (const p of projects) {
    const pdir = path.join(trashDir, p.name);
    let files = [];
    try {
      files = fs.readdirSync(pdir, { withFileTypes: true }).filter((f) => f.isFile());
    } catch {
      files = [];
    }
    for (const f of files) {
      const fp = path.join(pdir, f.name);
      try {
        const st = fs.statSync(fp);
        out.push({
          projectName: p.name,
          fileName: f.name,
          path: fp,
          size: Number(st.size || 0),
          mtime: st.mtime.toISOString()
        });
      } catch {
        // ignore broken file
      }
    }
  }
  out.sort((a, b) => (Date.parse(b.mtime || 0) || 0) - (Date.parse(a.mtime || 0) || 0));
  return out;
}

function cleanupTrash(options = {}) {
  const dryRun = Boolean(options.dryRun);
  const days = Number(options.days || getTrashRetentionDays() || DEFAULT_RETENTION_DAYS);
  const ttl = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const entries = listTrashEntries();
  const expired = entries.filter((x) => {
    const ts = Date.parse(x.mtime || 0) || 0;
    if (!ts) return false;
    return now - ts > ttl;
  });
  if (!dryRun) {
    for (const e of expired) {
      try {
        if (fs.existsSync(e.path)) fs.unlinkSync(e.path);
      } catch {
        // ignore per-file errors
      }
    }
  }
  return {
    days,
    scanned: entries.length,
    expired: expired.length,
    removed: dryRun ? 0 : expired.length
  };
}

function deleteTrashEntries(entries = []) {
  const targets = Array.isArray(entries)
    ? entries.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (!targets.length) return { requested: 0, removed: 0 };

  let removed = 0;
  for (const item of targets) {
    const resolved = path.resolve(item);
    if (!resolved.startsWith(path.resolve(trashDir) + path.sep)) continue;
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        fs.unlinkSync(resolved);
        removed += 1;
      }
    } catch {
      // ignore per-file errors
    }
  }
  return { requested: targets.length, removed };
}

function appendAudit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(auditPath, `${line}\n`, 'utf8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readGlobalMemory() {
  const gm = safeReadJson(globalMemoryPath);
  if (!gm || typeof gm !== 'object') return { preferences: {}, snippets: {} };
  if (!gm.preferences || typeof gm.preferences !== 'object') gm.preferences = {};
  if (!gm.snippets || typeof gm.snippets !== 'object') gm.snippets = {};
  return gm;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sanitizeDashboardNoteLine(value) {
  let text = normalizeText(value);
  if (!text) return '';
  text = text
    .replace(/^\d+\.\s*/, '')
    .replace(/[，,。.]?\s*写完后.*$/i, '')
    .replace(/[，,。.]?\s*写好了.*$/i, '')
    .replace(/^(?:可以|好的|行|嗯|好)[，,、\s]*/i, '')
    .replace(/^(?:请)?(?:帮我)?(?:把|将)?(?:这条|这个|这些)?(?:内容|信息|事情)?(?:写入|写到|存入|存到|记入|记到|保存到)?(?:到)?(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)(?:里|中)?[，,:：\s]*/i, '')
    .replace(/^(?:请)?(?:帮我)?(?:在|往)?(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)(?:里|中)?(?:写入|写到|存入|存到|记入|记到|保存)[，,:：\s]*/i, '')
    .replace(/[，,]?\s*(?:你帮我|帮我)?(?:把|将)?(?:这条|这个|这些)?(?:内容|信息|事情)?(?:也)?(?:写入|写到|存入|存到|记入|记到|保存到)?(?:到)?(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)(?:里|中)?\s*$/i, '')
    .replace(/^(?:你把|把)?这个/i, '')
    .replace(/(?:请你|帮我|你帮我|请)?(?:把|将)?(?:这条|这个|这些)?(?:内容|信息|事情)?(?:写入|写到|存入|存到|记入|记到|保存到)?(?:到)?(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆)(?:里|中)?/gi, ' ')
    .trim();
  const clauses = text
    .split(/[，,。；;！!\n]+/)
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .filter((part) => !/(?:全局记忆|全局偏好|长期记忆|永久记忆|memory插件全局记忆|只回复|写完后|删完后)/i.test(part));
  const unique = [];
  for (const part of clauses) {
    if (!part || unique.includes(part)) continue;
    unique.push(part);
  }
  return normalizeText(unique.length ? unique.join('；') : text);
}

function normalizeDashboardNote(raw = '') {
  const seen = new Set();
  const out = [];
  const lines = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+(?=\d+\.\s)/g, '\n')
    .split('\n');
  for (const line of lines) {
    const cleaned = sanitizeDashboardNoteLine(line);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out.map((line, index) => `${index + 1}. ${line}`).join('\n');
}

function truncateText(value, max = 240) {
  const s = String(value || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
}

function buildBudgetTokenView(data = {}) {
  const bodyTokens = Number(data?.lastEstimatedBodyTokens || 0);
  const systemTokens = Number(data?.lastEstimatedSystemTokens || 0);
  const pluginHintTokens = Number(data?.lastEstimatedPluginHintTokens || 0);
  const totalTokens = Number(bodyTokens + systemTokens);
  return {
    bodyTokens,
    systemTokens,
    pluginHintTokens,
    totalTokens,
    totalWithPluginHintTokens: Number(totalTokens + pluginHintTokens),
    pluginHintIncludedInTotal: false,
    estimateMethod: 'heuristic_chars_div_4',
    estimateBase: 'ceil(chars/4)',
    exactBillingEquivalent: false,
    bodyIncludesCompressedSummary: true,
    displayFormula: 'body+system',
    displayNote: 'Estimated tokens use ceil(chars/4). total=body+system; plugin-hint is displayed separately and not included in total.'
  };
}

function normalizeProvider(value) {
  const p = normalizeText(String(value || '')).toLowerCase();
  if (p === 'anthropic' || p === 'gemini') return p;
  return 'openai_compatible';
}

function normalizeBaseURL(value, provider = 'openai_compatible') {
  const raw = normalizeText(String(value || ''));
  if (!raw) return '';
  const base = raw.replace(/\/+$/, '');
  if (provider === 'gemini') {
    return /\/v1beta$/i.test(base) ? base : `${base}/v1beta`;
  }
  return base;
}

function parseBoolQuery(value) {
  const s = normalizeText(String(value || '')).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return null;
}

function findOpencodeDbPath() {
  for (const p of OPENCODE_DB_CANDIDATES) {
    try {
      const st = fs.statSync(p);
      if (st.isFile()) return p;
    } catch {
      // ignore
    }
  }
  return '';
}

function runSqliteQuery(dbPath, sql) {
  const ret = spawnSync('sqlite3', [dbPath, '-separator', '\t', sql], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  });
  if ((ret.status ?? 1) !== 0) {
    return { ok: false, error: String(ret.stderr || ret.stdout || 'sqlite query failed') };
  }
  return { ok: true, stdout: String(ret.stdout || '') };
}

function listOpencodeSessionsFromDb({ archived = null, limit = 200 } = {}) {
  const dbPath = findOpencodeDbPath();
  if (!dbPath) {
    return { ok: false, source: '', error: 'opencode.db not found', items: [] };
  }
  const safeLimit = Math.max(1, Math.min(1000, Number(limit || 200)));
  let where = '';
  if (archived === true) where = 'where time_archived is not null';
  if (archived === false) where = 'where time_archived is null';
  const sql = [
    'select',
    'id,',
    "coalesce(time_created,''),",
    "coalesce(time_updated,''),",
    "coalesce(time_archived,'')",
    'from session',
    where,
    'order by',
    'coalesce(time_updated,time_created) desc',
    `limit ${safeLimit};`
  ].join(' ');
  const q = runSqliteQuery(dbPath, sql);
  if (!q.ok) return { ok: false, source: dbPath, error: q.error, items: [] };
  const lines = String(q.stdout || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const items = lines.map((line) => {
    const [id, createdAt, updatedAt, archivedAt] = line.split('\t');
    return {
      id: String(id || ''),
      createdAt: String(createdAt || ''),
      updatedAt: String(updatedAt || ''),
      archived: Boolean(archivedAt),
      archivedAt: String(archivedAt || '')
    };
  }).filter((x) => x.id);
  return { ok: true, source: dbPath, items };
}

function detectArchiveFilterGap() {
  const active = listOpencodeSessionsFromDb({ archived: false, limit: 400 });
  const archived = listOpencodeSessionsFromDb({ archived: true, limit: 400 });
  if (!active.ok || !archived.ok) {
    return { ok: false, reason: active.error || archived.error || 'query_failed' };
  }
  return {
    ok: true,
    reason: 'sqlite_filter_available',
    activeCount: active.items.length,
    archivedCount: archived.items.length
  };
}

async function fetchIndependentModels({ provider, baseURL, apiKey, timeoutMs = 30000 }) {
  const p = normalizeProvider(provider);
  const base = normalizeBaseURL(baseURL, p);
  const key = normalizeText(String(apiKey || ''));
  if (!base || !key) return { ok: false, error: 'baseURL/apiKey required', models: [] };
  const timeout = Math.max(3000, Number(timeoutMs || 30000));

  async function fetchJson(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const raw = await resp.text();
      if (!resp.ok) return { ok: false, error: `http_${resp.status}`, json: null };
      let json = {};
      try {
        json = JSON.parse(raw);
      } catch {
        return { ok: false, error: 'non_json_response', json: null };
      }
      return { ok: true, error: '', json };
    } catch (err) {
      const msg = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err || 'unknown_error');
      return { ok: false, error: msg, json: null };
    } finally {
      clearTimeout(timer);
    }
  }

  function extractModelIDs(json) {
    const out = [];
    const push = (v) => {
      const s = normalizeText(String(v || '')).replace(/^models\//, '').trim();
      if (s) out.push(s);
    };

    const addFromArray = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const m of arr) {
        if (!m || typeof m !== 'object') continue;
        push(m.id || m.name || m.model || m.model_id || m.slug);
      }
    };

    addFromArray(json?.data);
    addFromArray(json?.models);
    addFromArray(json?.result?.models);
    addFromArray(json?.items);

    // Fallback: shallow recursive scan for common list keys.
    const stack = [json];
    let depth = 0;
    while (stack.length && depth < 3) {
      const node = stack.shift();
      depth += 1;
      if (!node || typeof node !== 'object') continue;
      for (const [k, v] of Object.entries(node)) {
        if (Array.isArray(v) && /(data|models|items|list)/i.test(k)) addFromArray(v);
        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return out;
  }

  try {
    const headers = {};
    const all = [];
    let lastError = '';
    if (p === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      const r = await fetchJson(`${base}/v1/models`, headers);
      if (!r.ok) return { ok: false, error: r.error, models: [] };
      all.push(...extractModelIDs(r.json));
    } else if (p === 'gemini') {
      let pageToken = '';
      for (let i = 0; i < 6; i += 1) {
        const qp = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const url = `${base}/models?key=${encodeURIComponent(key)}${qp}`;
        const r = await fetchJson(url);
        if (!r.ok) {
          lastError = r.error;
          break;
        }
        all.push(...extractModelIDs(r.json));
        pageToken = normalizeText(String(r.json?.nextPageToken || r.json?.next_page_token || ''));
        if (!pageToken) break;
      }
      if (!all.length && lastError) return { ok: false, error: lastError, models: [] };
    } else {
      headers.Authorization = `Bearer ${key}`;
      let next = `${base}/models`;
      for (let i = 0; i < 6; i += 1) {
        const r = await fetchJson(next, headers);
        if (!r.ok) {
          lastError = r.error;
          break;
        }
        all.push(...extractModelIDs(r.json));
        const nextByField = normalizeText(String(r.json?.next || r.json?.next_page || r.json?.nextPage || ''));
        const hasMore = Boolean(r.json?.has_more);
        const lastID = normalizeText(String(r.json?.last_id || ''));
        if (nextByField) {
          next = /^https?:\/\//i.test(nextByField) ? nextByField : `${base}${nextByField.startsWith('/') ? '' : '/'}${nextByField}`;
          continue;
        }
        if (hasMore && lastID) {
          const joiner = next.includes('?') ? '&' : '?';
          next = `${base}/models${joiner}after=${encodeURIComponent(lastID)}`;
          continue;
        }
        break;
      }
      // Fallback endpoint used by some OpenAI-compatible proxies.
      if (!all.length) {
        const r = await fetchJson(`${base}/v1/models`, headers);
        if (r.ok) all.push(...extractModelIDs(r.json));
        else if (lastError) return { ok: false, error: lastError, models: [] };
      }
    }
    const models = [...new Set(all)].filter(Boolean).sort();
    return { ok: true, models, count: models.length };
  } catch (err) {
    const msg = String(err?.message || err || 'unknown_error');
    return { ok: false, error: msg, models: [] };
  }
}

async function validateIndependentLlm({ provider, baseURL, apiKey, model, timeoutMs = 30000 }) {
  const p = normalizeProvider(provider);
  const base = normalizeBaseURL(baseURL, p);
  const key = normalizeText(String(apiKey || ''));
  const m = normalizeText(String(model || ''));
  if (!base || !key || !m) return { ok: false, error: 'provider/baseURL/apiKey/model required' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs || 30000)));
  try {
    let url = '';
    let headers = { 'content-type': 'application/json' };
    let body = {};
    if (p === 'anthropic') {
      url = `${base}/v1/messages`;
      headers = {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      };
      body = {
        model: m,
        max_tokens: 16,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply only: OK' }]
      };
    } else if (p === 'gemini') {
      url = `${base}/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(key)}`;
      body = {
        generationConfig: { maxOutputTokens: 16, temperature: 0 },
        contents: [{ role: 'user', parts: [{ text: 'Reply only: OK' }] }]
      };
    } else {
      url = `${base}/chat/completions`;
      headers.Authorization = `Bearer ${key}`;
      body = {
        model: m,
        temperature: 0,
        max_tokens: 16,
        messages: [
          { role: 'system', content: 'Reply only OK.' },
          { role: 'user', content: 'Reply only: OK' }
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
    if (!resp.ok) return { ok: false, error: `http_${resp.status}`, detail: truncateText(raw, 280) };
    return { ok: true, status: 'ok' };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err || 'unknown_error');
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeCompressedSummaryText(value) {
  let s = String(value || '');
  if (!s) return '';
  if (!s.includes('\n') && /## Structured Session Summary/i.test(s)) {
    s = s
      .replace(/\s-\swindow:/gi, '\n- window:')
      .replace(/\s-\skey facts:/gi, '\n- key facts:')
      .replace(/\s-\stool execution:/gi, '\n- tool execution:')
      .replace(/\s-\sdecisions\/constraints:/gi, '\n- decisions/constraints:')
      .replace(/\s-\stodo\/risks:/gi, '\n- todo/risks:')
      .replace(/\s## Structured Session Summary/gi, '\n## Structured Session Summary');
  }
  return s
    .split('\n')
    .map((x) => x.trimEnd())
    .filter((line) => {
      const t = normalizeText(line);
      if (!t) return false;
      if (/<OPENCODE_[A-Z_]+/i.test(t) || /<\/OPENCODE_[A-Z_]+>/i.test(t)) return false;
      if (/EXTREMELY_IMPORTANT|using-superpowers|OPENCODE_KNOWLEDGE_BASE/i.test(t)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

function listProjectNames() {
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function readProjectSessions(projectName) {
  const dir = path.join(projectsDir, projectName, 'sessions');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const sessions = [];
  for (const f of files) {
    const obj = safeReadJson(path.join(dir, f));
    if (!obj || !obj.sessionID) continue;
    const stats = obj.stats || {};
    const traces = Array.isArray(obj?.sendPretrim?.traces) ? obj.sendPretrim.traces : [];
    const latestTrace = traces.length ? traces[traces.length - 1] : null;
    const budgetSystemFallback = Number(
      obj?.budget?.lastEstimatedSystemTokens ||
      latestTrace?.systemTokensAfter ||
      latestTrace?.systemTokensBefore ||
      0
    );
    const budgetBodyFallback = Number(
      obj?.budget?.lastEstimatedBodyTokens ||
      latestTrace?.afterTokens ||
      latestTrace?.beforeTokens ||
      0
    );
    const budgetTotalFallback = Number(
      obj?.budget?.lastEstimatedTotalTokens ||
      latestTrace?.totalAfterTokens ||
      latestTrace?.totalBeforeTokens ||
      (budgetBodyFallback + budgetSystemFallback)
    );
    const budgetPluginHintFallback = Number(
      obj?.budget?.lastEstimatedPluginHintTokens ||
      latestTrace?.pluginHintTokensAfter ||
      latestTrace?.pluginHintTokensBefore ||
      0
    );
    const systemPromptFallback = {
      lastObservedTokens: Number(
        obj?.systemPrompt?.lastObservedTokens ||
        obj?.budget?.lastEstimatedSystemTokens ||
        latestTrace?.systemTokensAfter ||
        latestTrace?.systemTokensBefore ||
        0
      ),
      lastObservedLines: Number(obj?.systemPrompt?.lastObservedLines || 0),
      lastObservedAt: obj?.systemPrompt?.lastObservedAt || null,
      lastObservedHash: obj?.systemPrompt?.lastObservedHash || '',
      lastObservedPreview: obj?.systemPrompt?.lastObservedPreview || '',
      lastObservedModel: obj?.systemPrompt?.lastObservedModel || '',
      lastObservedChars: Number(obj?.systemPrompt?.lastObservedChars || 0),
      lastObservedText: String(obj?.systemPrompt?.lastObservedText || ''),
      enabled: obj?.systemPrompt?.enabled !== false
    };
    sessions.push({
      projectName,
      sessionID: obj.sessionID,
      sessionTitle: normalizeText(obj.sessionTitle || ''),
      sessionCwd: normalizeText(obj.sessionCwd || ''),
      createdAt: obj.createdAt || null,
      updatedAt: obj.updatedAt || null,
      stats: {
        userMessages: Number(stats.userMessages || 0),
        assistantMessages: Number(stats.assistantMessages || 0),
        toolResults: Number(stats.toolResults || 0),
        systemEvents: Number(stats.systemEvents || 0)
      },
      totalEventsCount: Array.isArray(obj.recentEvents) ? obj.recentEvents.length : 0,
      recentEvents: Array.isArray(obj.recentEvents) ? obj.recentEvents.slice(-80) : [],
      summary: {
        compressedEvents: Number(obj?.summary?.compressedEvents || 0),
        lastCompressedAt: obj?.summary?.lastCompressedAt || null,
        compressedText: sanitizeCompressedSummaryText(obj?.summary?.compressedText || ''),
        compressedPreview: truncateText(sanitizeCompressedSummaryText(obj?.summary?.compressedText || ''), 240)
      },
      summaryBlocks: (() => {
        const arr = Array.isArray(obj?.summaryBlocks) ? obj.summaryBlocks : [];
        const traces = Array.isArray(obj?.sendPretrim?.traces) ? obj.sendPretrim.traces : [];
        const traceByBlockId = new Map();
        for (const tr of traces) {
          const bid = Number(tr?.blockId || 0);
          if (bid > 0 && !traceByBlockId.has(bid)) traceByBlockId.set(bid, tr);
        }
        const recent = arr.slice(-10).map((b) => {
          const blockId = Number(b?.blockId || 0);
          const tr = traceByBlockId.get(blockId);
          const range = (b?.startMessageID && b?.endMessageID)
            ? `range:${b.startMessageID}->${b.endMessageID}`
            : '';
          const saved = tr ? ` save~${Number(tr?.savedTokens || 0)}` : '';
          const prefix = `${range}${saved}`.trim();
          const body = normalizeText(String(b?.summary || ''));
          return {
            blockId,
            createdAt: b?.createdAt || null,
            source: b?.source || '',
            startMessageID: b?.startMessageID || '',
            endMessageID: b?.endMessageID || '',
            consumedMessages: Number(b?.consumedMessages || 0),
            summaryPreview: truncateText(prefix ? `${prefix} | ${body}` : body, 160)
          };
        });
        return { count: arr.length, recent };
      })(),
      recall: {
        count: Number(obj?.recall?.count || 0),
        lastAt: obj?.recall?.lastAt || null
      },
      inject: {
        globalPrefsCount: Number(obj?.inject?.globalPrefsCount || 0),
        currentSummaryCount: Number(obj?.inject?.currentSummaryCount || 0),
        triggerRecallCount: Number(obj?.inject?.triggerRecallCount || 0),
        memoryDocsCount: Number(obj?.inject?.memoryDocsCount || 0),
        lastAt: obj?.inject?.lastAt || null,
        lastReason: obj?.inject?.lastReason || '',
        lastStatus: obj?.inject?.lastStatus || ''
      },
      budget: {
        bodyTokenBudget: Number(obj?.budget?.bodyTokenBudget || 50000),
        lastEstimatedBodyTokens: budgetBodyFallback,
        lastEstimatedSystemTokens: budgetSystemFallback,
        lastEstimatedPluginHintTokens: budgetPluginHintFallback,
        lastEstimatedTotalTokens: budgetTotalFallback,
        tokenView: buildBudgetTokenView({
          lastEstimatedBodyTokens: budgetBodyFallback,
          lastEstimatedSystemTokens: budgetSystemFallback,
          lastEstimatedPluginHintTokens: budgetPluginHintFallback
        }),
        lastCompactedAt: obj?.budget?.lastCompactedAt || null,
        lastCompactionReason: obj?.budget?.lastCompactionReason || ''
      },
      systemPrompt: systemPromptFallback,
      pruneAudit: {
        autoRuns: Number(obj?.pruneAudit?.autoRuns || 0),
        manualRuns: Number(obj?.pruneAudit?.manualRuns || 0),
        discardRemovedTotal: Number(obj?.pruneAudit?.discardRemovedTotal || 0),
        extractMovedTotal: Number(obj?.pruneAudit?.extractMovedTotal || 0),
        lastAt: obj?.pruneAudit?.lastAt || null,
        lastSource: obj?.pruneAudit?.lastSource || '',
        lastDiscardRemoved: Number(obj?.pruneAudit?.lastDiscardRemoved || 0),
        lastExtractMoved: Number(obj?.pruneAudit?.lastExtractMoved || 0),
        lastEstimatedBodyTokens: Number(obj?.pruneAudit?.lastEstimatedBodyTokens || 0)
      },
      sendPretrim: {
        autoRuns: Number(obj?.sendPretrim?.autoRuns || 0),
        manualRuns: Number(obj?.sendPretrim?.manualRuns || 0),
        savedTokensTotal: Number(obj?.sendPretrim?.savedTokensTotal || 0),
        lastBeforeTokens: Number(obj?.sendPretrim?.lastBeforeTokens || 0),
        lastAfterTokens: Number(obj?.sendPretrim?.lastAfterTokens || 0),
        lastSavedTokens: Number(obj?.sendPretrim?.lastSavedTokens || 0),
        lastAt: obj?.sendPretrim?.lastAt || null,
        lastReason: obj?.sendPretrim?.lastReason || '',
        lastStatus: obj?.sendPretrim?.lastStatus || '',
        traces: traces.slice(-8)
      }
      ,
      alerts: obj?.alerts && typeof obj.alerts === 'object' ? obj.alerts : {}
    });
  }
  sessions.sort((a, b) => (Date.parse(b.updatedAt || 0) || 0) - (Date.parse(a.updatedAt || 0) || 0));
  return sessions;
}

function buildLiveDashboardData() {
  const projects = [];
  for (const name of listProjectNames()) {
    const meta = safeReadJson(projectMetaPathFrom(name)) || {};
    const sessions = readProjectSessions(name);
    const totalEvents = sessions.reduce(
      (acc, s) => acc + (s.recentEvents?.length || 0) + Number(s?.summary?.compressedEvents || 0),
      0
    );
    projects.push({
      name,
      path: path.join(projectsDir, name, 'memory.json'),
      lastLearned: meta?.lastLearned || null,
      techStack: Array.isArray(meta?.techStack) ? meta.techStack : [],
      sessionCount: sessions.length,
      totalEvents,
      sessions
    });
  }
  projects.sort((a, b) => {
    const ta = Date.parse((a.sessions[0] && a.sessions[0].updatedAt) || a.lastLearned || 0) || 0;
    const tb = Date.parse((b.sessions[0] && b.sessions[0].updatedAt) || b.lastLearned || 0) || 0;
    return tb - ta;
  });

  const global = (safeReadJson(path.join(memoryDir, 'global.json')) || {});
  const memorySystem = getMemorySystemSettings();
  const data = {
    generatedAt: new Date().toISOString(),
    settings: {
      memorySystem
    },
    config: {
      memorySystem
    },
    global: {
      preferences: global?.preferences && typeof global.preferences === 'object' ? global.preferences : {},
      snippets: global?.snippets && typeof global.snippets === 'object' ? global.snippets : {},
      feedback: Array.isArray(global?.feedback) ? global.feedback : []
    },
    projects,
    summary: {
      projectCount: projects.length,
      sessionCount: projects.reduce((acc, p) => acc + Number(p.sessionCount || 0), 0),
      eventCount: projects.reduce((acc, p) => acc + Number(p.totalEvents || 0), 0)
    }
  };
  try { writeJson(dataPath, data); } catch (_) { /* best-effort disk cache */ }
  return data;
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let rejected = false;
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
      if (!rejected && data.length > 2 * 1024 * 1024) {
        rejected = true;
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sessionPathFrom(projectName, sessionID) {
  const pdir = path.join(projectsDir, String(projectName || ''));
  const sdir = path.join(pdir, 'sessions');
  return path.join(sdir, `${encodeURIComponent(String(sessionID || ''))}.json`);
}

function rawSessionPathFrom(projectName, sessionID) {
  const pdir = path.join(projectsDir, String(projectName || ''));
  const sdir = path.join(pdir, 'sessions');
  return path.join(sdir, `${String(sessionID || '')}.json`);
}

function ensureTrashProjectDir(projectName) {
  const p = path.join(trashDir, String(projectName || 'unknown'));
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function moveFileToTrash(filePath, projectName, sessionID) {
  if (!fs.existsSync(filePath)) return null;
  const projectTrash = ensureTrashProjectDir(projectName);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.basename(filePath);
  const target = path.join(projectTrash, `${encodeURIComponent(String(sessionID || 'unknown'))}__${stamp}__${base}`);
  fs.renameSync(filePath, target);
  return target;
}

function projectMetaPathFrom(projectName) {
  return path.join(projectsDir, String(projectName || ''), 'memory.json');
}

function deleteSessionFileVariants(projectName, sessionID) {
  const encoded = sessionPathFrom(projectName, sessionID);
  const raw = rawSessionPathFrom(projectName, sessionID);
  let existed = false;
  const deleted = [];

  for (const p of [encoded, raw]) {
    if (fs.existsSync(p)) {
      existed = true;
      const moved = moveFileToTrash(p, projectName, sessionID);
      deleted.push(moved || p);
    }
  }

  return { existed, deleted, encoded, raw };
}

function removeLegacySessionFromMeta(projectName, sessionID) {
  const metaPath = projectMetaPathFrom(projectName);
  if (!fs.existsSync(metaPath)) return false;
  const meta = safeReadJson(metaPath) || {};
  if (
    meta?.autoMemory &&
    meta.autoMemory.sessions &&
    typeof meta.autoMemory.sessions === 'object' &&
    Object.prototype.hasOwnProperty.call(meta.autoMemory.sessions, sessionID)
  ) {
    delete meta.autoMemory.sessions[sessionID];
    writeJson(metaPath, meta);
    return true;
  }
  return false;
}

function mutateDashboardData(projectName, sessionID, updater) {
  if (!fs.existsSync(dataPath)) return;
  const data = safeReadJson(dataPath);
  if (!data || !Array.isArray(data.projects)) return;
  const p = data.projects.find((x) => x.name === projectName);
  if (!p || !Array.isArray(p.sessions)) return;
  const idx = p.sessions.findIndex((s) => s.sessionID === sessionID);
  updater({ data, project: p, sessionIndex: idx });
  writeJson(dataPath, data);
}

function removeSessionFromDashboardData(projectName, sessionID) {
  mutateDashboardData(projectName, sessionID, ({ data, project }) => {
    project.sessions = Array.isArray(project.sessions)
      ? project.sessions.filter((s) => s.sessionID !== sessionID)
      : [];
    project.sessionCount = project.sessions.length;
    project.totalEvents = project.sessions.reduce(
      (acc, s) => acc + ((s.recentEvents && s.recentEvents.length) || 0) + Number(s?.summary?.compressedEvents || 0),
      0
    );

    data.summary = data.summary || {};
    data.summary.sessionCount = (data.projects || []).reduce((acc, p) => acc + Number(p.sessionCount || 0), 0);
    data.summary.eventCount = (data.projects || []).reduce((acc, p) => acc + Number(p.totalEvents || 0), 0);
  });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

function clearState() {
  if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
}

function clearOwnNodeState() {
  const state = readState();
  if (!state || state.mode !== 'node') return;
  if (Number(state.port) !== Number(port)) return;
  if (Number(state.pid) !== Number(process.pid)) return;
  clearState();
}

function cmdExists(name) {
  const probe = isWindows ? ['where', [name]] : ['which', [name]];
  return spawnSync(probe[0], probe[1], { stdio: 'ignore' }).status === 0;
}

function dockerReady() {
  if (!cmdExists('docker')) return false;
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

function runDocker(args) {
  return spawnSync('docker', args, { stdio: 'ignore' }).status === 0;
}

function isOpencodeRunning() {
  if (isWindows) {
    const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq opencode.exe'], { encoding: 'utf8' });
    return out.status === 0 && /opencode\.exe/i.test(out.stdout || '');
  }
  // macOS/Unix: accept both CLI and desktop app process names, case-insensitive.
  const out = spawnSync('pgrep', ['-if', '(^|/|\\.)opencode( |$)|opencode web|\\.opencode|OpenCode'], { encoding: 'utf8' });
  if (out.status !== 0) return false;
  return String(out.stdout || '').trim().length > 0;
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isPortInUse(targetPort) {
  return await new Promise((resolve) => {
    const server = http.createServer();
    server.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(targetPort, '127.0.0.1');
  });
}

async function isTcpPortListening(targetPort) {
  return await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: targetPort, method: 'GET', path: '/', timeout: 1200 },
      () => resolve(true)
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function isDashboardHttpResponsive(targetPort) {
  return await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: targetPort, method: 'GET', path: '/api/dashboard', timeout: 1200 },
      (res) => {
        // 200 means data ready; 404 means service is up but dashboard data not built yet.
        resolve(Boolean(res && (res.statusCode === 200 || res.statusCode === 404)));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startDocker() {
  runDocker(['rm', '-f', dockerContainer]);
  const ok = runDocker([
    'run',
    '-d',
    '--name',
    dockerContainer,
    '-p',
    `${port}:80`,
    '-v',
    `${dashboardDir}:/usr/share/nginx/html:ro`,
    'nginx:alpine'
  ]);
  if (!ok) return false;
  writeState({ mode: 'docker', port, container: dockerContainer, startedAt: new Date().toISOString() });
  return true;
}

function startNodeServerDetached() {
  const parentPid = parentPidArg > 0 ? parentPidArg : 0;
  const child = spawn(process.execPath, [thisFile, 'serve', String(port), String(parentPid), String(opencodePortArg)], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  writeState({ mode: 'node', port, pid: child.pid, parentPid, opencodePort: opencodePortArg, startedAt: new Date().toISOString() });
  return true;
}

function stopDocker(container) {
  runDocker(['rm', '-f', container || dockerContainer]);
}

function stopNode(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

function printStatus() {
  const state = readState();
  const lines = [];
  if (!state) {
    lines.push('Mode: none');
  } else if (state.mode === 'docker') {
    const running =
      spawnSync('docker', ['ps', '--filter', `name=^${state.container}$`, '--format', '{{.Names}}'], {
        encoding: 'utf8'
      }).stdout.trim() === state.container;
    lines.push(`Mode: docker (${running ? 'running' : 'stopped'})`);
    lines.push(`Container: ${state.container}`);
  } else if (state.mode === 'node') {
    let running = false;
    try {
      process.kill(state.pid, 0);
      running = true;
    } catch {}
    lines.push(`Mode: node (${running ? 'running' : 'stopped'})`);
    lines.push(`PID: ${state.pid}`);
  }
  lines.push(`URL: http://127.0.0.1:${port}`);
  console.log(lines.join('\n'));
}

function serve() {
  ensureDashboardDir();
  // Startup GC for trash retention policy.
  cleanupTrash({ days: getTrashRetentionDays() });
  // Periodic GC every 6 hours.
  const trashGcTimer = setInterval(() => {
    cleanupTrash({ days: getTrashRetentionDays() });
  }, 6 * 60 * 60 * 1000);
  const parentPid = parentPidArg > 0 ? parentPidArg : 0;
  const opencodePort = opencodePortArg > 0 ? opencodePortArg : 4096;
  const explicitParentBinding = parentPid > 0;
  let miss = 0;
  const watchdog = setInterval(async () => {
    const byParent = explicitParentBinding ? isPidAlive(parentPid) : false;
    const byProcess = isOpencodeRunning();
    const byPort = await isTcpPortListening(opencodePort);
    const alive = byParent || byProcess || byPort;
    if (explicitParentBinding) {
      if (alive) {
        miss = 0;
        return;
      }
      miss += 1;
      if (miss >= Math.min(watchdogMaxMiss, 3)) {
        clearInterval(trashGcTimer);
        clearInterval(watchdog);
        process.exit(0);
      }
      return;
    }
    // No explicit parent PID was provided. Fall back to global OpenCode / port probing.
    if (alive) {
      miss = 0;
      return;
    }
    miss += 1;
    if (miss >= watchdogMaxMiss) {
      clearInterval(trashGcTimer);
      clearInterval(watchdog);
      process.exit(0);
    }
  }, watchdogIntervalMs);

  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const rawPath = decodeURIComponent(parsedUrl.pathname || '/');

    if (method === 'GET' && rawPath === '/api/memory/opencode/sessions') {
      const archived = parseBoolQuery(parsedUrl.searchParams.get('archived'));
      const limit = Number(parsedUrl.searchParams.get('limit') || 200);
      const result = listOpencodeSessionsFromDb({ archived, limit });
      if (!result.ok) {
        sendJson(res, 500, {
          ok: false,
          error: result.error || 'query_failed',
          source: result.source || ''
        });
        return;
      }
      const gap = detectArchiveFilterGap();
      sendJson(res, 200, {
        ok: true,
        archived,
        count: result.items.length,
        source: result.source,
        archiveFilterPolicy: {
          strategy: 'sqlite_direct_filter',
          upstreamSessionListFilterTrusted: false
        },
        filterHealth: gap,
        items: result.items
      });
      return;
    }

    if (method === 'GET' && rawPath === '/api/dashboard') {
      const live = buildLiveDashboardData();
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      sendJson(res, 200, live);
      return;
    }

    if (method === 'GET' && rawPath === '/api/memory/trash') {
      sendJson(res, 200, {
        retentionDays: getTrashRetentionDays(),
        entries: listTrashEntries()
      });
      return;
    }

    if (method === 'GET' && rawPath === '/api/memory/settings') {
      sendJson(res, 200, { memorySystem: getMemorySystemSettings() });
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/settings') {
      try {
        const body = await readJsonBody(req);
        if (!body?.confirm) {
          sendJson(res, 400, { error: 'confirm=true required' });
          return;
        }
        const patch = body?.memorySystem && typeof body.memorySystem === 'object' ? body.memorySystem : {};
        const settings = updateMemorySystemSettings(patch);
        appendAudit({
          action: 'update_memory_settings',
          source: body?.source || 'dashboard',
          keys: Object.keys(patch || {})
        });
        const live = buildLiveDashboardData();
        sendJson(res, 200, { ok: true, settings, dashboard: live.settings || {} });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/llm/models') {
      try {
        const body = await readJsonBody(req);
        const result = await fetchIndependentModels({
          provider: body?.provider,
          baseURL: body?.baseURL,
          apiKey: body?.apiKey,
          timeoutMs: body?.timeoutMs
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err?.message || String(err), models: [] });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/llm/validate') {
      try {
        const body = await readJsonBody(req);
        const result = await validateIndependentLlm({
          provider: body?.provider,
          baseURL: body?.baseURL,
          apiKey: body?.apiKey,
          model: body?.model,
          timeoutMs: body?.timeoutMs
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/trash/cleanup') {
      try {
        const body = await readJsonBody(req);
        const dryRun = Boolean(body?.dryRun);
        const days = Number(body?.days || getTrashRetentionDays() || DEFAULT_RETENTION_DAYS);
        const result = cleanupTrash({ dryRun, days });
        appendAudit({
          action: 'trash_cleanup',
          source: body?.source || 'dashboard',
          dryRun,
          days: result.days,
          scanned: result.scanned,
          expired: result.expired,
          removed: result.removed
        });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/trash/delete') {
      try {
        const body = await readJsonBody(req);
        if (!body?.confirm) {
          sendJson(res, 400, { error: 'confirm=true required' });
          return;
        }
        const result = deleteTrashEntries(body?.entries || []);
        appendAudit({
          action: 'trash_delete',
          source: body?.source || 'dashboard',
          requested: result.requested,
          removed: result.removed
        });
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/session/summary') {
      try {
        const body = await readJsonBody(req);
        if (!body?.confirm) {
          sendJson(res, 400, { error: 'confirm=true required' });
          return;
        }
        const projectName = String(body.projectName || '');
        const sessionID = String(body.sessionID || '');
        if (!projectName || !sessionID) {
          sendJson(res, 400, { error: 'projectName and sessionID are required' });
          return;
        }
        const target = sessionPathFrom(projectName, sessionID);
        if (!fs.existsSync(target)) {
          sendJson(res, 404, { error: 'session file not found' });
          return;
        }
        const obj = safeReadJson(target) || {};
        obj.summary = obj.summary || {};
        obj.summary.compressedText = String(body.summaryText || '').slice(0, 6000);
        obj.summary.lastCompressedAt = new Date().toISOString();
        obj.budget = obj.budget || {};
        obj.budget.lastCompactionReason = 'manual_dashboard_edit';
        writeJson(target, obj);
        appendAudit({
          action: 'update_summary',
          projectName,
          sessionID,
          source: body.source || 'dashboard'
        });
        mutateDashboardData(projectName, sessionID, ({ project, sessionIndex }) => {
          if (sessionIndex < 0) return;
          project.sessions[sessionIndex].summary = project.sessions[sessionIndex].summary || {};
          project.sessions[sessionIndex].summary.compressedText = obj.summary.compressedText;
          project.sessions[sessionIndex].summary.lastCompressedAt = obj.summary.lastCompressedAt;
          project.sessions[sessionIndex].budget = project.sessions[sessionIndex].budget || {};
          project.sessions[sessionIndex].budget.lastCompactionReason = obj.budget.lastCompactionReason;
        });
        sendJson(res, 200, { ok: true, path: target });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/session/delete') {
      try {
        const body = await readJsonBody(req);
        if (!body?.confirm) {
          sendJson(res, 400, { error: 'confirm=true required' });
          return;
        }
        const projectName = String(body.projectName || '');
        const sessionID = String(body.sessionID || '');
        if (!projectName || !sessionID) {
          sendJson(res, 400, { error: 'projectName and sessionID are required' });
          return;
        }
        const deletedInfo = deleteSessionFileVariants(projectName, sessionID);
        const legacyRemoved = removeLegacySessionFromMeta(projectName, sessionID);
        appendAudit({
          action: 'delete_session',
          projectName,
          sessionID,
          source: body.source || 'dashboard',
          existed: deletedInfo.existed,
          legacyRemoved,
          deletedPaths: deletedInfo.deleted
        });
        removeSessionFromDashboardData(projectName, sessionID);
        sendJson(res, 200, {
          ok: true,
          existed: deletedInfo.existed,
          legacyRemoved,
          deletedPaths: deletedInfo.deleted,
          checkedPaths: [deletedInfo.encoded, deletedInfo.raw]
        });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/sessions/delete') {
      try {
        const body = await readJsonBody(req);
        if (!body?.confirm) {
          sendJson(res, 400, { error: 'confirm=true required' });
          return;
        }
        const projectName = String(body.projectName || '');
        const sessionIDs = Array.isArray(body.sessionIDs)
          ? body.sessionIDs.map((x) => String(x || '').trim()).filter(Boolean)
          : [];
        if (!projectName || !sessionIDs.length) {
          sendJson(res, 400, { error: 'projectName and sessionIDs[] are required' });
          return;
        }
        let removed = 0;
        let legacyRemoved = 0;
        const deletedPaths = [];
        for (const sessionID of sessionIDs) {
          const deletedInfo = deleteSessionFileVariants(projectName, sessionID);
          if (deletedInfo.existed) {
            removed += 1;
            deletedPaths.push(...deletedInfo.deleted);
          }
          if (removeLegacySessionFromMeta(projectName, sessionID)) legacyRemoved += 1;
          removeSessionFromDashboardData(projectName, sessionID);
        }
        appendAudit({
          action: 'delete_sessions_batch',
          projectName,
          sessionCount: sessionIDs.length,
          removed,
          legacyRemoved,
          source: body.source || 'dashboard'
        });
        sendJson(res, 200, {
          ok: true,
          requested: sessionIDs.length,
          removed,
          legacyRemoved,
          deletedPaths
        });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/global/preferences') {
      try {
        const body = await readJsonBody(req);
        if (!body?.confirm) {
          sendJson(res, 400, { error: 'confirm=true required' });
          return;
        }
        const key = normalizeText(String(body.key || ''));
        const value = String(body.value || '').trim();
        if (!key) {
          sendJson(res, 400, { error: 'key is required' });
          return;
        }
        const gm = readGlobalMemory();
        gm.preferences[key] = value;
        writeJson(globalMemoryPath, gm);
        appendAudit({
          action: 'update_global_preference',
          source: body.source || 'dashboard',
          key,
          value: truncateText(value, 120)
        });
        const live = buildLiveDashboardData();
        sendJson(res, 200, { ok: true, key, value, global: live.global });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (method === 'POST' && rawPath === '/api/memory/global/note/clean') {
      try {
        const body = await readJsonBody(req);
        if (!body?.confirm) {
          sendJson(res, 400, { error: 'confirm=true required' });
          return;
        }
        const gm = readGlobalMemory();
        const current = String((gm.preferences && gm.preferences.note) || '');
        const next = normalizeDashboardNote(current);
        gm.preferences.note = next;
        writeJson(globalMemoryPath, gm);
        appendAudit({
          action: 'clean_global_note',
          source: body.source || 'dashboard',
          noteChars: next.length
        });
        const live = buildLiveDashboardData();
        sendJson(res, 200, { ok: true, note: next, global: live.global });
      } catch (err) {
        sendJson(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if ((method === 'GET' || method === 'HEAD') && (reqPath === '/' || reqPath === '/index.html' || reqPath === '/dashboard')) {
      ensureDashboardDir();
      buildLiveDashboardData();
      syncDashboardHtmlFromPlugin();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      const html = fs.readFileSync(indexPath, 'utf8');
      res.end(html);
      return;
    }
    const target = path.join(dashboardDir, reqPath);
    if (!target.startsWith(dashboardDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const mime =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.json'
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(target).pipe(res);
  });
  process.once('exit', clearOwnNodeState);
  server.listen(port, '127.0.0.1');
  server.on('close', () => {
    clearInterval(watchdog);
    clearInterval(trashGcTimer);
    clearOwnNodeState();
  });
}

async function main() {
  if (isServeMode) {
    serve();
    return;
  }

  ensureDashboardDir();

  if (action === 'stop') {
    const state = readState();
    if (state?.mode === 'docker') stopDocker(state.container);
    if (state?.mode === 'node') stopNode(state.pid);
    clearState();
    console.log('Stopped dashboard service (if running).');
    return;
  }

  if (action === 'status') {
    printStatus();
    return;
  }

  if (action === 'restart') {
    const state = readState();
    if (state?.mode === 'docker') stopDocker(state.container);
    if (state?.mode === 'node') stopNode(state.pid);
    clearState();
    // best-effort wait to release port
    await new Promise((r) => setTimeout(r, 250));
  } else if (action !== 'start') {
    console.log('Usage: node opencode_memory_dashboard.mjs [start|stop|status|restart] [port]');
    process.exit(1);
  }

  if (await isPortInUse(port)) {
    const state = readState();
    if (state?.mode === 'node' && Number(state.port) === port && isPidAlive(Number(state.pid))) {
      console.log(`Dashboard already running: http://127.0.0.1:${port}`);
      process.exit(0);
    }
    if (await isDashboardHttpResponsive(port)) {
      console.log(`Dashboard already reachable: http://127.0.0.1:${port}`);
      process.exit(0);
    }
    console.log(`Port ${port} is already in use.`);
    process.exit(1);
  }

  // Default to Node server so dashboard editing APIs are available.
  // Docker static mode can be added later as an explicit mode.
  const started = startNodeServerDetached();

  if (!started) {
    console.error('Failed to start dashboard service.');
    process.exit(1);
  }

  console.log(`Started dashboard: http://127.0.0.1:${port}`);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
