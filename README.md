# OpenCode Memory System Plugin

[中文说明（Chinese）](#中文说明)

A practical memory plugin for OpenCode with:

- Session-based JSON memory storage
- Cross-session recall (intent-triggered + manual)
- Token budget compaction
- Local dashboard on `http://127.0.0.1:37777`
- Dashboard edit/delete with audit log
- Dashboard lifecycle synced with OpenCode web lifecycle

## Repository Files

- `plugins/memory-system.js`
- `plugins/scripts/opencode_memory_dashboard.mjs`

## Installation Tutorial (English)

### 1. Prerequisites

- OpenCode installed
- `node` available in PATH (`node -v`)

### 2. Copy plugin files

Copy these files into your OpenCode global config plugin directory:

- Source: `plugins/memory-system.js`
- Target: `<OPENCODE_GLOBAL>/plugins/memory-system.js`

- Source: `plugins/scripts/opencode_memory_dashboard.mjs`
- Target: `<OPENCODE_GLOBAL>/plugins/scripts/opencode_memory_dashboard.mjs`

Typical global paths:

- macOS/Linux (common)
  - `~/.config/opencode/plugins/memory-system.js`
  - `~/.config/opencode/plugins/scripts/opencode_memory_dashboard.mjs`
- Windows (common)
  - `%USERPROFILE%\\.config\\opencode\\plugins\\memory-system.js`
  - `%USERPROFILE%\\.config\\opencode\\plugins\\scripts\\opencode_memory_dashboard.mjs`

### 3. Restart OpenCode

Restart OpenCode completely.

### 4. Verify

- OpenCode web should be on `http://127.0.0.1:4096`
- Dashboard should auto-start on `http://127.0.0.1:37777`
- Stop OpenCode -> dashboard should auto-stop in ~10-20s

### 5. Runtime data

Memory files are saved under:

- `~/.opencode/memory/projects/<project>/sessions/*.json`
- `~/.opencode/memory/global.json`
- `~/.opencode/memory/dashboard/`
- `~/.opencode/memory/audit/memory-audit.jsonl`

### 6. Troubleshooting

- Dashboard not starting:
  - Check `node -v`
  - Ensure port `37777` is free
- Dashboard not stopping:
  - Ensure OpenCode uses port `4096`
  - If your OpenCode port is different, update `AUTO_OPENCODE_WEB_PORT` in `memory-system.js`

---

## 中文说明

这是一个用于 OpenCode 的本地记忆插件，支持：

- 按会话保存 JSON 记忆
- 跨会话召回（触发词 + 手动召回）
- Token 预算压缩
- 本地可视化面板（`http://127.0.0.1:37777`）
- 面板中可编辑/删除记忆并写入审计日志
- 与 OpenCode 启停联动（OpenCode 启动则面板启动，关闭则面板自动关闭）

## 安装教程（中文）

### 1. 前置条件

- 已安装 OpenCode
- 系统可用 `node` 命令（执行 `node -v` 可看到版本号）

### 2. 复制插件文件

把仓库里的两个文件复制到 OpenCode 全局插件目录：

- 源文件：`plugins/memory-system.js`
  - 目标：`<OPENCODE_GLOBAL>/plugins/memory-system.js`
- 源文件：`plugins/scripts/opencode_memory_dashboard.mjs`
  - 目标：`<OPENCODE_GLOBAL>/plugins/scripts/opencode_memory_dashboard.mjs`

常见全局路径：

- macOS/Linux（常见）
  - `~/.config/opencode/plugins/memory-system.js`
  - `~/.config/opencode/plugins/scripts/opencode_memory_dashboard.mjs`
- Windows（常见）
  - `%USERPROFILE%\\.config\\opencode\\plugins\\memory-system.js`
  - `%USERPROFILE%\\.config\\opencode\\plugins\\scripts\\opencode_memory_dashboard.mjs`

### 3. 重启 OpenCode

完整重启 OpenCode（不是只刷新页面）。

### 4. 验证是否成功

- OpenCode Web 默认：`http://127.0.0.1:4096`
- 记忆面板自动启动：`http://127.0.0.1:37777`
- 关闭 OpenCode 后，`37777` 会在约 10-20 秒自动关闭

### 5. 记忆文件保存位置

插件会写入：

- `~/.opencode/memory/projects/<项目名>/sessions/*.json`
- `~/.opencode/memory/global.json`
- `~/.opencode/memory/dashboard/`
- `~/.opencode/memory/audit/memory-audit.jsonl`

### 6. 常见问题

- 面板打不开：
  - 检查 `node` 是否可用
  - 检查 `37777` 端口是否被占用
- 关闭 OpenCode 后面板未关闭：
  - 检查 OpenCode 是否运行在 `4096`
  - 若你改了 OpenCode 端口，需在 `memory-system.js` 中修改 `AUTO_OPENCODE_WEB_PORT`
