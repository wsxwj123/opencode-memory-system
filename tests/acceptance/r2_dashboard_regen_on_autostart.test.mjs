#!/usr/bin/env node
// R2 — 看板自愈：插件启动(autostart)时用当前插件重新生成 index.html。
//
// 复现的 bug：插件升级后，磁盘上残留的旧 index.html（refreshData 打已废弃的
// /api/memory/data）不会被重新生成，看板一直 serve 旧产物，删除后界面不刷新，
// 用户以为没删。修复：memory-system.js 初始化 autostart 分支里，在拉起看板服务
// 之前先 writeDashboardFilesNow() 无条件重生成一次。
//
// 本测试同时守护两点：
//   1) autostart 确实会重新生成 index.html（旧产物被覆盖成新端点）。
//   2) 这次调用发生在初始化早期，不能撞上 __dashboardLastWriteAt 的 let TDZ
//      （撞上就会被内部 try/catch 吞掉、index.html 不生成 → 本测试失败）。
//
// EXPECTED PRE-FIX FAILURE（未修的代码）：autostart 只 ensureDashboardServiceStarted()，
// 不重生成，残留的旧 index.html 保留 → 断言 "index.html 已含 /api/dashboard" 失败。

import fs from 'fs';
import path from 'path';
import { tmpRoot, loadPluginWithHome, makeClient, prepareHome } from './_harness.mjs';

const STALE_HTML = "<!doctype html><html><script>async function refreshData(){DATA=await apiGet('/api/memory/data');}</script></html>";

async function run() {
  const homeDir = path.join(tmpRoot, `r2_regen_${Date.now()}`);
  fs.mkdirSync(homeDir, { recursive: true });
  prepareHome(homeDir);
  const prevHome = process.env.HOME;
  process.env.HOME = homeDir;

  // 预置“插件升级后残留的旧 index.html”。
  const dashDir = path.join(homeDir, '.opencode', 'memory', 'dashboard');
  fs.mkdirSync(dashDir, { recursive: true });
  const indexPath = path.join(dashDir, 'index.html');
  fs.writeFileSync(indexPath, STALE_HTML, 'utf8');

  const beforeStale = fs.readFileSync(indexPath, 'utf8').includes("apiGet('/api/memory/data')");

  // 加载并实例化插件 —— 初始化走 autostart 分支，应触发一次重新生成。
  const mod = await loadPluginWithHome(homeDir);
  process.env.HOME = homeDir; // loadPluginWithHome 内部恢复过 HOME，重设
  mod.MemorySystemPlugin({ client: makeClient() });

  const after = fs.readFileSync(indexPath, 'utf8');
  process.env.HOME = prevHome;

  const hasNew = after.includes("apiGet('/api/dashboard')");
  const hasOld = after.includes("apiGet('/api/memory/data')");
  const grew = after.length > STALE_HTML.length; // 真被完整重生成，而非原样保留

  const ok = beforeStale && hasNew && !hasOld && grew;
  const detail = `staleBefore=${beforeStale} regenerated->/api/dashboard=${hasNew} `
    + `stillHasOld(shouldBeFalse)=${hasOld} grew=${grew} size=${after.length}`;
  return { ok, detail };
}

const cases = [['R2.1 autostart 时旧 index.html 被重新生成为 /api/dashboard（且不 TDZ 静默失败）', run]];
let pass = 0;
for (const [name, fn] of cases) {
  let result;
  try { result = await fn(); } catch (err) { result = { ok: false, detail: `threw: ${err?.stack || err?.message || err}` }; }
  if (result.ok) pass += 1;
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} | ${name} | ${result.detail}\n`);
}
process.stdout.write(`\nResult: ${pass}/${cases.length} scenarios passed.\n`);
process.exit(pass === cases.length ? 0 : 1);
