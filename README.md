# OpenCode Memory System Plugin

## 中文教程（优先）

这是一个给 OpenCode 使用的本地记忆插件，目标是：

- 自动保存会话记忆到本地 JSON 文件
- 按需做跨会话召回（减少上下文污染）
- 提供可编辑记忆的可视化页面（`37777`）
- 与 OpenCode 启停联动（OpenCode 启动则面板启动，OpenCode 关闭则面板自动停止）

---

### 1. 功能概览

- 会话级记忆：每个 session 一份 JSON 文件
- 全局记忆：偏好/片段等全局信息单独保存
- 半自动注入：按策略注入当前会话摘要，支持手动 recall
- 自动裁剪：内置 DCP 风格 `discard/extract/prune` 机制
- 本地看板：查看、编辑、删除记忆（带审计日志）
- 批量删除：在 `37777` 勾选会话条目后批量删除
- 生命周期联动：默认监听 OpenCode `4096`，控制看板 `37777`

---

### 2. 如何下载插件

你有三种常见方式：

1. `git clone` 下载仓库

```bash
git clone https://github.com/wsxwj123/opencode-memory-system.git
```

2. 在 GitHub 页面点击 `Code -> Download ZIP`

3. 直接复制仓库内两个核心文件（见下一节）

---

### 3. 安装教程（macOS / Linux / Windows）

#### 3.1 先决条件

- 已安装 OpenCode
- 系统可用 `node` 命令（`node -v`）

#### 3.2 只需安装两个核心文件

仓库中这两个文件是运行必需：

- `plugins/memory-system.js`
- `plugins/scripts/opencode_memory_dashboard.mjs`

把它们复制到 OpenCode 的全局插件目录：

- 目标 1：`<OPENCODE_GLOBAL>/plugins/memory-system.js`
- 目标 2：`<OPENCODE_GLOBAL>/plugins/scripts/opencode_memory_dashboard.mjs`

常见路径：

- macOS/Linux（常见）
  - `~/.config/opencode/plugins/memory-system.js`
  - `~/.config/opencode/plugins/scripts/opencode_memory_dashboard.mjs`

- Windows（常见）
  - `%USERPROFILE%\\.config\\opencode\\plugins\\memory-system.js`
  - `%USERPROFILE%\\.config\\opencode\\plugins\\scripts\\opencode_memory_dashboard.mjs`

> 注意：README 不是运行必需文件，仅作为说明文档。

#### 3.3 重启 OpenCode

完整重启 OpenCode（不是只刷新页面）。

---

### 4. 如何验证安装成功

1. 打开 OpenCode（默认 `http://127.0.0.1:4096`）
2. 查看记忆面板：`http://127.0.0.1:37777`
3. 关闭 OpenCode 后，`37777` 应在约 10-20 秒内自动停止
4. 面板自动刷新间隔默认为 `60s`（页面切回前台会立即刷新一次）

如果没生效：见本文“常见问题排查”。

---

### 5. 日常如何使用

#### 5.1 平时你需要做什么

- 正常用 OpenCode 对话即可，记忆会自动写入
- 需要人工修正记忆时，打开 `37777` 页面编辑

#### 5.2 手动命令（可选）

- `/memory recall <关键词>`：手动跨会话召回
- `/memory sessions`：查看会话记忆列表
- `/memory clear session <id>`：删除某个 session 记忆
- `/memory clear sessions <id1,id2,...>`：批量删除多个 session 记忆
- `/memory discard [session <id>|current] [aggressive]`：清理低信号工具噪音
- `/memory extract [session <id>|current] [maxEvents]`：把旧正文蒸馏进摘要
- `/memory prune [session <id>|current]`：执行组合裁剪
- `/memory dashboard`：重建 dashboard 数据

#### 5.3 跨会话召回触发

- 默认是“收紧触发”，只有明显跨会话意图才自动召回（例如“另一个对话/上次那个session”）
- 同会话的“刚刚说的”不会误触发跨会话 recall

---

### 6. 记忆文件结构与管理

插件运行后会写入：

- `~/.opencode/memory/global.json`
  - 全局偏好与片段（例如语言偏好）

- `~/.opencode/memory/projects/<项目名>/sessions/*.json`
  - 每个 session 一份记忆文件（核心数据）

- `~/.opencode/memory/dashboard/data.json`
  - 看板数据快照

- `~/.opencode/memory/dashboard/index.html`
  - 本地页面（内嵌当前快照）

- `~/.opencode/memory/audit/memory-audit.jsonl`
  - 看板编辑/删除审计记录

#### 6.1 删除与归档说明

- OpenCode 里归档/删除会话：默认**不会**自动删记忆文件
- 若要删除记忆：
  - 用 `/memory clear session <id>`
  - 或在 `37777` 页面点 `Delete session`
  - 或在 `37777` 页面勾选多个会话后点“批量删除(n)”

#### 6.2 如果你不开 `37777`

- 仍可手动编辑/删除本地 JSON 文件
- 但不会有页面审计交互和按钮操作

---

### 7. 与其他插件共存建议

- 本插件可与大多数插件共存
- 但不要同时启用多个“自动记忆注入”系统（例如同时强开 DCP + 本插件自动注入）
  - 否则可能导致重复注入、上下文变大

推荐：

- 只保留一个主记忆注入路径
- 其他记忆系统改为手动触发或停用自动注入

---

### 8. 常见问题排查

#### 8.1 `37777` 打不开

- 检查 `node -v`
- 检查端口占用：`lsof -nP -iTCP:37777 -sTCP:LISTEN`（Windows 用 `netstat -ano | findstr 37777`）

#### 8.2 OpenCode 关闭后 `37777` 未停

- 检查 OpenCode 是否运行在 `4096`
- 若你改了 OpenCode 端口，请在 `memory-system.js` 修改 `AUTO_OPENCODE_WEB_PORT`

#### 8.3 页面删 session 报 `session file not found`

- 新版本已兼容：缺文件会按“已删除”处理并同步移除页面条目

#### 8.4 会话标题显示为 ID

- 插件会优先读事件标题；若无标题，会回退用首条用户消息生成标题

#### 8.5 为什么会话里出现 `[memory-system] ...` 提示

- 这是“可见模式”提示，表示注入/裁剪动作已执行
- 新版本会做合并去抖：同一波操作仅显示最新一条，避免刷屏

---

### 9. Windows 使用说明（重点）

可以直接使用，不需要改代码，满足以下即可：

1. 已安装 OpenCode
2. 已安装 Node.js（`node` 可执行）
3. 把两个核心文件复制到 Windows 的 OpenCode 全局插件目录
4. 重启 OpenCode

仅在一种情况下需要改代码：

- 你把 OpenCode web 端口改成非 `4096`，才需要改 `AUTO_OPENCODE_WEB_PORT`

---

## English Guide

This plugin provides local memory for OpenCode with:

- Session-based JSON memory files
- Cross-session recall (intent-triggered + manual)
- Token budget compaction
- DCP-style pruning (`discard/extract/prune`)
- Dashboard with edit/delete/batch-delete + audit log (`37777`)
- Dashboard lifecycle synced to OpenCode web lifecycle (`4096` by default)

### 1. Required files

- `plugins/memory-system.js`
- `plugins/scripts/opencode_memory_dashboard.mjs`

### 2. Install

1. Ensure `node` is available in PATH.
2. Copy files to your OpenCode global plugin directory.
3. Restart OpenCode.

Typical paths:

- macOS/Linux
  - `~/.config/opencode/plugins/memory-system.js`
  - `~/.config/opencode/plugins/scripts/opencode_memory_dashboard.mjs`

- Windows
  - `%USERPROFILE%\\.config\\opencode\\plugins\\memory-system.js`
  - `%USERPROFILE%\\.config\\opencode\\plugins\\scripts\\opencode_memory_dashboard.mjs`

### 3. Verify

- OpenCode web: `http://127.0.0.1:4096`
- Dashboard: `http://127.0.0.1:37777`
- Stop OpenCode -> dashboard stops in ~10-20s
- Dashboard auto-refresh interval: `60s` (and immediate refresh on tab focus)

### 4. Commands

- `/memory recall <query>`
- `/memory sessions`
- `/memory clear session <id>`
- `/memory clear sessions <id1,id2,...>`
- `/memory discard [session <id>|current] [aggressive]`
- `/memory extract [session <id>|current] [maxEvents]`
- `/memory prune [session <id>|current]`
- `/memory dashboard`

### 5. Runtime data paths

- `~/.opencode/memory/global.json`
- `~/.opencode/memory/projects/<project>/sessions/*.json`
- `~/.opencode/memory/dashboard/data.json`
- `~/.opencode/memory/dashboard/index.html`
- `~/.opencode/memory/audit/memory-audit.jsonl`
