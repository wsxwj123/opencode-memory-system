#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawnSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const action = (process.argv[2] || 'start').toLowerCase();
const port = Number(process.argv[3] || 37777);
const isServeMode = action === 'serve';
const parentPidArg = Number(process.argv[4] || 0);
const opencodePortArg = Number(process.argv[5] || 4096);
const thisFile = fileURLToPath(import.meta.url);

const home = os.homedir();
const isWindows = process.platform === 'win32';
const memoryDir = path.join(home, '.opencode', 'memory');
const projectsDir = path.join(memoryDir, 'projects');
const dashboardDir = path.join(home, '.opencode', 'memory', 'dashboard');
const indexPath = path.join(dashboardDir, 'index.html');
const dataPath = path.join(dashboardDir, 'data.json');
const auditDir = path.join(memoryDir, 'audit');
const auditPath = path.join(auditDir, 'memory-audit.jsonl');
const statePath = path.join(dashboardDir, '.dashboard-server.json');
const dockerContainer = `opencode-memory-dashboard-${port}`;

function ensureDashboardDir() {
  fs.mkdirSync(dashboardDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(
      indexPath,
      `<!doctype html>
<html><head><meta charset="utf-8"><title>Memory Dashboard</title></head>
<body><h3>Memory dashboard file not generated yet.</h3><p>Run OpenCode with memory plugin, then refresh.</p></body></html>`,
      'utf8'
    );
  }
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

function appendAudit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  fs.appendFileSync(auditPath, `${line}\n`, 'utf8');
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, max = 240) {
  const s = String(value || '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}...`;
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
    sessions.push({
      sessionID: obj.sessionID,
      sessionTitle: normalizeText(obj.sessionTitle || ''),
      createdAt: obj.createdAt || null,
      updatedAt: obj.updatedAt || null,
      stats: {
        userMessages: Number(stats.userMessages || 0),
        assistantMessages: Number(stats.assistantMessages || 0),
        toolResults: Number(stats.toolResults || 0),
        systemEvents: Number(stats.systemEvents || 0)
      },
      recentEvents: Array.isArray(obj.recentEvents) ? obj.recentEvents.slice(-12) : [],
      summary: {
        compressedEvents: Number(obj?.summary?.compressedEvents || 0),
        lastCompressedAt: obj?.summary?.lastCompressedAt || null,
        compressedText: sanitizeCompressedSummaryText(obj?.summary?.compressedText || ''),
        compressedPreview: truncateText(sanitizeCompressedSummaryText(obj?.summary?.compressedText || ''), 240)
      },
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
        lastReason: obj?.inject?.lastReason || ''
      },
      budget: {
        bodyTokenBudget: Number(obj?.budget?.bodyTokenBudget || 50000),
        lastEstimatedBodyTokens: Number(obj?.budget?.lastEstimatedBodyTokens || 0),
        lastCompactedAt: obj?.budget?.lastCompactedAt || null,
        lastCompactionReason: obj?.budget?.lastCompactionReason || ''
      }
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
  const data = {
    generatedAt: new Date().toISOString(),
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
  writeJson(dataPath, data);
  return data;
}

async function readJsonBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > 2 * 1024 * 1024) {
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
      fs.unlinkSync(p);
      deleted.push(p);
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
  const out = spawnSync('pgrep', ['-f', '(^|/| )opencode( |$)|opencode web'], { encoding: 'utf8' });
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
  const parentPid = parentPidArg > 0 ? parentPidArg : 0;
  const opencodePort = opencodePortArg > 0 ? opencodePortArg : 4096;
  let miss = 0;
  const watchdog = setInterval(async () => {
    const byPort = await isTcpPortListening(opencodePort);
    const byParent = parentPid > 0 ? isPidAlive(parentPid) : false;
    const alive = byParent || byPort;
    if (alive) {
      miss = 0;
      return;
    }
    miss += 1;
    if (miss >= 12) {
      clearInterval(watchdog);
      process.exit(0);
    }
  }, 10000);

  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    const rawPath = decodeURIComponent((req.url || '/').split('?')[0]);

    if (method === 'GET' && rawPath === '/api/dashboard') {
      const live = buildLiveDashboardData();
      sendJson(res, 200, live);
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

    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const target = reqPath === '/' ? indexPath : path.join(dashboardDir, reqPath);
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
  server.listen(port, '127.0.0.1');
  server.on('close', () => clearInterval(watchdog));
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

  if (action !== 'start') {
    console.log('Usage: node opencode_memory_dashboard.mjs [start|stop|status] [port]');
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
