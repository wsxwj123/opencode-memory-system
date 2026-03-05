# OpenCode Memory System Plugin

## 中文教程（优先）

这是一个给 OpenCode 使用的本地记忆插件，目标是：

- 自动保存会话记忆到本地 JSON 文件
- 按需做跨会话召回（减少上下文污染）
- 提供可编辑记忆的可视化页面（`37777`）
- 前端新增“独立LLM”同级页面，可直接配置 LLM 总结 provider/baseURL/apiKey/model
- 与 OpenCode 启停联动（OpenCode 启动则面板启动，OpenCode 关闭则面板自动停止）

---

### 1. 功能概览

- 会话级记忆：每个 session 一份 JSON 文件
- 全局记忆：偏好/片段等全局信息单独保存
- 半自动注入：按策略注入当前会话摘要，支持手动 recall
- 自动裁剪：内置 DCP 风格 `discard/extract/prune` 机制
- 多模型参数兼容：兼容 OpenAI / Gemini / Anthropic 常见工具参数形态
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

#### 3.4 重要：禁用插件的正确方式

OpenCode 运行时会扫描全局 `plugins/` 目录中的 `.js` 文件。  
因此“仅从 `opencode.json` 的 `plugin` 列表删除”并不总能彻底禁用。

推荐做法：

- 把要禁用的插件改成非 `.js` 后缀（例如 `xxx.disabled`）
- 或移出 `plugins/` 目录

示例（禁用 `chinese-settings`）：

```bash
mv ~/.config/opencode/plugins/chinese-settings.js ~/.config/opencode/plugins/chinese-settings.disabled
```

---

### 4. 如何验证安装成功

1. 打开 OpenCode（默认 `http://127.0.0.1:4096`）
2. 查看记忆面板：`http://127.0.0.1:37777`
3. 关闭 OpenCode 后，`37777` 应在约 10-20 秒内自动停止
4. 面板自动刷新间隔默认为 `60s`（页面切回前台仅在距离上次刷新已满 `60s` 时才刷新）

如果没生效：见本文“常见问题排查”。

---

### 5. 日常如何使用

#### 5.1 平时你需要做什么

- 正常用 OpenCode 对话即可，记忆会自动写入
- 需要人工修正记忆时，打开 `37777` 页面编辑

#### 5.2 手动命令（可选）

- `/memory recall <关键词>`：手动跨会话召回
- `/memory prefer <key> <value>`：写入全局偏好（推荐，最稳）
- `/memory sessions`：查看会话记忆列表
- `/memory doctor [session <id>|current]`：诊断本会话是否注入/是否 pretrim/最近节省 token/是否命中叠加风险
- `/memory clear session <id>`：删除某个 session 记忆
- `/memory clear sessions <id1,id2,...>`：批量删除多个 session 记忆
- `/memory discard [session <id>|current] [aggressive]`：清理低信号工具噪音
- `/memory extract [session <id>|current] [maxEvents]`：把旧正文LLM总结进摘要
- `/memory prune [session <id>|current]`：执行组合裁剪
- `/memory dashboard`：重建 dashboard 数据

#### 5.3 跨会话召回触发

- 默认是“收紧触发”，只有明显跨会话意图才自动召回（例如“另一个对话/上次那个session”）
- 当前已关闭 recall 冷却（可连续跨会话召回）
- 同会话的“刚刚说的”不会误触发跨会话 recall

#### 5.4 发送前裁剪（DCP-like）与 Distill 模式

- 发送前会自动做 `pretrim`，目标是把本次要发给模型的正文 token 压回预算区间
- 策略是两阶段：
  - 阶段 1：低信号内容替换（pending/running/噪音工具输出）
  - 阶段 2：替换式摘要锚点（把旧历史折叠成一段摘要，而不是简单追加）
    - 会先做“候选区间评分”（结果/失败/路径加权，pending/running 降权），再选连续区间做LLM总结，避免把不相关片段混在一起
    - 新增 block 占位追踪：每次范围压缩会生成 `bN` 记录（含起止消息、消耗条目数、摘要）
    - 摘要头会携带本次预测 block 编号（如 `pretrim-distill b7`），便于和 `summaryBlocks` 审计对齐
- 默认是 DCP 兼容风格（无需额外配置）：
  - 永远先机械裁剪（阶段1），只有“仍超阈值”才进入LLM总结（阶段2）
  - 默认保护窗口是最近 `10` 条用户轮次（可在 37777 参数页调）
  - `auto` 模式（默认）：若已手动开启并配置独立LLM则走独立LLM，否则走 `session` 内联LLM总结
  - `session` 模式：在发送前用当前会话上下文做结构化LLM总结替换（无需额外 key/base_url）
- 新增“替换闭环”：
  - 当仍超预算且已有 `bN` 压缩块时，会启用 `anchor-replace`，把旧 assistant/tool 原始轨迹替换为“compressed blocks anchor”，避免 A+B+C 叠加
- 新增“自适应策略”：
  - 根据本次发送前 token/budget 比例自动调节裁剪强度（rewrite 上限、保护窗口、phase-aware trim）
  - phase-aware trim 会优先压缩 discovery/verify/network 类工具输出，保守保留 modify 类输出
- 可选“独立 Distill LLM”增强（手动开启后才会在 auto 模式优先使用）：
  - 仅当你显式设置 `OPENCODE_MEMORY_DISTILL_MODE=independent` 时启用
  - 启用后优先用独立模型生成高保真摘要
  - 若失败，自动回退到 `session` 模式或机械提炼（不阻塞主会话）
- 质量门槛：
  - 若 Distill 结果过短/结构不足/缺关键路径，会判为低质量并回退，不直接替换

可选环境变量（按需设置）：

```bash
OPENCODE_MEMORY_DISTILL_MODE=auto                     # 默认；可改为 session / independent

# 仅 independent 模式需要以下配置
OPENCODE_MEMORY_DISTILL_ENABLED=1
OPENCODE_MEMORY_DISTILL_PROVIDER=openai_compatible   # 或 anthropic / gemini
OPENCODE_MEMORY_DISTILL_BASE_URL=https://api.xxx.com/v1
OPENCODE_MEMORY_DISTILL_API_KEY=sk-xxxx
OPENCODE_MEMORY_DISTILL_MODEL=your-model-id          # 可留空并启用 use_session_model
OPENCODE_MEMORY_DISTILL_USE_SESSION_MODEL=1
OPENCODE_MEMORY_DISTILL_TIMEOUT_MS=12000
OPENCODE_MEMORY_DISTILL_MAX_TOKENS=420
OPENCODE_MEMORY_DISTILL_TEMPERATURE=0.2
```

查看是否生效：

- `/memory doctor current` 看 `pretrim.last.distillUsed/distillStatus`（判断是否用了LLM总结、是否失败回退）
- `/memory doctor current` 看 `pretrim.last.anchorReplaceApplied/anchorReplaceMessages`
- `/memory doctor current` 看 `pretrim.last.adaptiveLevel/adaptiveRatio`
- `/memory doctor current` 看 `pretrim.last.compositionBefore/compositionAfter`（system/user/tool 占比）
- `/memory context current` 看 `llmSummaryConfig.mode`
- `/memory doctor current` 的 `blocks.latest` 可看到最近一次 `bN`
- `37777` 页面会显示 `blocks` 计数与最近 block 摘要，并在 block 预览里展示 `range:start->end` 与 `save~tokens`
- `37777` 的 `pretrim traces` 行会显示 `comp S/U/T` 百分比（发送前后 system/user/tool 占比变化）

---

### 6. 记忆文件结构与管理

插件运行后会写入：

- `~/.opencode/memory/global.json`
  - 全局偏好与片段（例如语言偏好）
  - 支持两种偏好写法：`preferences.*`（推荐）与历史顶层标量键（兼容）

- `~/.opencode/memory/projects/<项目名>/sessions/*.json`
  - 每个 session 一份记忆文件（核心数据）

- `~/.opencode/memory/dashboard/data.json`
  - 看板数据快照

- `~/.opencode/memory/dashboard/index.html`
  - 本地页面（内嵌当前快照）

- `~/.opencode/memory/audit/memory-audit.jsonl`
  - 看板编辑/删除审计记录
- `~/.opencode/memory/trash/`
  - 会话删除回收站（从看板删除会话时，先移动到这里）

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
- 当前默认：`AUTO_VISIBLE_NOTICES=true`（默认会显示可见提示，但有冷却去抖）

#### 8.6 37777 页面数据是静态还是动态

- 页面内容通过 `GET /api/dashboard` 动态拉取
- 自动刷新间隔 `60s`
- 标签页切回前台时，仅在距离上次刷新 `>=60s` 才会拉取

#### 8.7 Session 列表布局说明

- 每条 session 头部现在是左对齐布局
- 第一行显示：`标题 + id`
- 第二行显示：统计信息（`u/a/t/r/注入/最近注入/prune/正文token`）

#### 8.8 自检命令（推荐）

仓库内置最小回归脚本（6场景）：

```bash
node scripts/minimal_regression_suite.mjs
```

当前推荐仅使用这个最小回归脚本；旧的 `full_regression` / `selfcheck` 已移除，避免因本地依赖差异导致误报。

通过标准：
- 依次输出 6 个场景：
  - 无触发
  - 机械裁剪触发
  - 内联LLM触发
  - 内联LLM触发失败并回退
  - 独立LLM触发
  - 独立LLM触发失败并回退

失败并回退的典型触发条件：
- 内联LLM失败：当前会话 provider/model 不可用、接口超时、HTTP 非 2xx、返回空文本或低质量摘要。
- 独立LLM失败：`independentLlmEnabled=true` 但 baseURL/key/model 缺失或错误，或接口超时/HTTP 非 2xx。

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
- OpenAI/Gemini/Anthropic-style tool payload compatibility
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
- Dashboard auto-refresh interval: `60s` (tab-focus refresh only if >=60s since last refresh)
- Dashboard tabs: `Sessions` / `Settings` / `Independent LLM` / `Trash`
- Dashboard data source is dynamic: `/api/dashboard` (not static-only snapshot rendering)

### 4. Commands

- `/memory recall <query>`
- `/memory prefer <key> <value>`
- `/memory sessions`
- `/memory doctor [session <id>|current]`
- `/memory clear session <id>`
- `/memory clear sessions <id1,id2,...>`
- `/memory discard [session <id>|current] [aggressive]`
- `/memory extract [session <id>|current] [maxEvents]`
- `/memory prune [session <id>|current]`
- `/memory dashboard`

### 4.1 Send-time pretrim + LLM summary modes (new)

- Pretrim runs before sending messages to reduce prompt size.
- Stage 1 rewrites low-signal content.
- Stage 2 performs replacement-style anchor compaction (replace old history with one distilled anchor, not append-only).
- Default is `auto` (DCP-compatible):
  - Mechanical trim always runs first.
  - If still over threshold: use independent LLM only when explicitly enabled/configured; otherwise use session-inline LLM summary.
  - `session`: inline structured LLM summary in transform path.
- Replacement loop:
  - If still over budget and there are existing `bN` blocks, plugin applies `anchor-replace` to substitute older assistant/tool traces with a compact block anchor.
- Optional independent LLM summary:
  - Set `OPENCODE_MEMORY_DISTILL_MODE=independent` and provide provider config.
  - On failure/misconfiguration, plugin falls back to session mode or deterministic extraction.
- Quality gate is enforced before replacement (too-short/no-structure/missing key path => fallback).

Environment variables:

```bash
OPENCODE_MEMORY_DISTILL_MODE=auto

# independent mode (optional)
OPENCODE_MEMORY_DISTILL_ENABLED=1
OPENCODE_MEMORY_DISTILL_MODE=independent
OPENCODE_MEMORY_DISTILL_PROVIDER=openai_compatible   # anthropic | gemini
OPENCODE_MEMORY_DISTILL_BASE_URL=https://api.xxx.com/v1
OPENCODE_MEMORY_DISTILL_API_KEY=sk-xxxx
OPENCODE_MEMORY_DISTILL_MODEL=your-model-id
OPENCODE_MEMORY_DISTILL_USE_SESSION_MODEL=1
OPENCODE_MEMORY_DISTILL_TIMEOUT_MS=12000
OPENCODE_MEMORY_DISTILL_MAX_TOKENS=420
OPENCODE_MEMORY_DISTILL_TEMPERATURE=0.2
```

Verification:

- `/memory doctor current` -> `pretrim.last.distillUsed/distillStatus`
- `/memory context current` -> `llmSummaryConfig`

### 5. Runtime data paths

- `~/.opencode/memory/global.json`
- `~/.opencode/memory/projects/<project>/sessions/*.json`
- `~/.opencode/memory/dashboard/data.json`
- `~/.opencode/memory/dashboard/index.html`
- `~/.opencode/memory/audit/memory-audit.jsonl`
- `~/.opencode/memory/trash/`
