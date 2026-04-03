#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginSrcPath = path.join(repoRoot, 'plugins', 'memory-system.js');
const tmpRoot = path.join(os.tmpdir(), `compat-queue-skills-${Date.now()}`);
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

function buildPatchedModule(raw) {
  const withToolStub = raw.replace(
    "import { tool as defineTool } from '@opencode-ai/plugin';",
    makeDefineToolStub()
  );
  return withToolStub.replace(
    "  return {\n    name: 'memory-system',",
    `  return {\n    __test: {\n      processUserMessageEvent\n    },\n    name: 'memory-system',`
  );
}

async function loadPluginWithHome(homeDir) {
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const raw = fs.readFileSync(pluginSrcPath, 'utf8');
    const patched = buildPatchedModule(raw);
    const patchedPath = path.join(tmpRoot, `compat-queue-skill.${Date.now()}.mjs`);
    fs.writeFileSync(patchedPath, patched, 'utf8');
    return await import(`${pathToFileURL(patchedPath).href}?t=${Date.now()}`);
  } finally {
    process.env.HOME = prevHome;
  }
}

function prepareHome(homeDir) {
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

function createSessionFile(homeDir, sessionID) {
  writeJson(sessionPath(homeDir, sessionID), {
    sessionID,
    projectName: path.basename(process.cwd()),
    sessionTitle: `compat-${sessionID}`,
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
      lastStatus: ''
    }
  });
}

function makeClient() {
  return {
    session: {
      async prompt() { return null; },
      async update() { return null; }
    }
  };
}

function baseUserUpdated(messageID = 'msg-1') {
  return {
    type: 'message.updated',
    properties: { info: { messageID, role: 'user' } }
  };
}

async function runNoiseCase({ suiteName, noiseText, forbiddenPattern }) {
  const homeDir = path.join(tmpRoot, suiteName);
  fs.mkdirSync(homeDir, { recursive: true });
  prepareHome(homeDir);
  const sessionID = `sid-${suiteName}`;
  createSessionFile(homeDir, sessionID);

  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const mod = await loadPluginWithHome(homeDir);
    const plugin = mod.MemorySystemPlugin({ client: makeClient() });
    const beforeFiles = fs.readdirSync(path.dirname(sessionPath(homeDir, sessionID))).filter((name) => name.endsWith('.json')).length;
    await plugin.__test.processUserMessageEvent(sessionID, noiseText, baseUserUpdated('msg-noise'));
    await plugin.__test.processUserMessageEvent(
      sessionID,
      '我知道 DELTA-77881，那另一个代号是什么？只回复代号或不知道',
      baseUserUpdated('msg-real')
    );
    const session = readJson(sessionPath(homeDir, sessionID));
    const userEvents = (session?.recentEvents || []).filter((event) => event.kind === 'user-message');
    const polluted = userEvents.some((event) => forbiddenPattern.test(String(event.summary || '')));
    const hasReal = userEvents.some((event) => String(event.summary || '').includes('DELTA-77881'));
    const afterFiles = fs.readdirSync(path.dirname(sessionPath(homeDir, sessionID))).filter((name) => name.endsWith('.json')).length;
    return {
      ok: !polluted && hasReal && userEvents.length === 1 && beforeFiles === afterFiles && beforeFiles === 1,
      detail: JSON.stringify({ beforeFiles, afterFiles, userEvents })
    };
  } finally {
    process.env.HOME = prevHome;
  }
}

const cases = [
  {
    name: 'queue_boilerplate_noise_filtered',
    noiseText: 'Loading skill: queue\nUse queue when user asks to run background jobs. Command: npx @0xsero/open-queue',
    forbiddenPattern: /(open-queue|Loading skill:\s*queue)/i
  },
  {
    name: 'article_writing_boilerplate_noise_filtered',
    noiseText: 'Loading skill: article-writing\nWrite Nature/Science/Cell-level SCI research articles with section-scoped context loading.',
    forbiddenPattern: /(article-writing|Nature\/Science\/Cell-level)/i
  },
  {
    name: 'review_writing_boilerplate_noise_filtered',
    noiseText: 'Loading skill: review-writing\nExpert assistant for writing high-impact academic literature reviews.',
    forbiddenPattern: /(review-writing|high-impact academic literature reviews)/i
  },
  {
    name: 'sci2doc_boilerplate_noise_filtered',
    noiseText: 'Loading skill: sci2doc\nUse when converting SCI paper materials into a Chinese doctoral thesis draft.',
    forbiddenPattern: /(sci2doc|Chinese doctoral thesis draft)/i
  },
  {
    name: 'combined_skill_noise_filtered',
    noiseText: [
      'Loading skill: queue',
      'Loading skill: article-writing',
      'Loading skill: review-writing',
      'Loading skill: sci2doc',
      'npx @0xsero/open-queue',
      'Write Nature/Science/Cell-level SCI research articles'
    ].join('\n'),
    forbiddenPattern: /(open-queue|article-writing|review-writing|sci2doc|Nature\/Science\/Cell-level)/i
  }
];

async function main() {
  log(`Using temp root: ${tmpRoot}`);
  let passed = 0;
  for (const entry of cases) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { ok, detail } = await runNoiseCase({
        suiteName: entry.name,
        noiseText: entry.noiseText,
        forbiddenPattern: entry.forbiddenPattern
      });
      if (ok) {
        passed += 1;
        log(`PASS | ${entry.name} | ${detail}`);
      } else {
        log(`FAIL | ${entry.name} | ${detail}`);
      }
    } catch (error) {
      log(`ERROR | ${entry.name} | ${error?.stack || error?.message || String(error)}`);
    }
  }
  log(`\nResult: ${passed}/${cases.length} scenarios passed.`);
  process.exit(passed === cases.length ? 0 : 1);
}

main();
