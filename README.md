# OpenCode Memory System

## 中文教程（优先）

### 1. 这是什么
`opencode-memory-system` 是一个 OpenCode 插件，目标是同时解决两件事：
- 长期记忆：保存全局偏好、会话摘要、跨会话召回。
- token 控制：在发送前做机械裁剪与 LLM 总结，降低正文 token。

---

### 2. 安装

#### 2.1 必需文件
只需要两个插件文件：
- `plugins/memory-system.js`
- `plugins/scripts/opencode_memory_dashboard.mjs`

#### 2.2 放到 OpenCode 全局目录
macOS/Linux（默认）：
- `~/.config/opencode/plugins/memory-system.js`
- `~/.config/opencode/plugins/scripts/opencode_memory_dashboard.mjs`

Windows（默认）：
- `%APPDATA%\\opencode\\plugins\\memory-system.js`
- `%APPDATA%\\opencode\\plugins\\scripts\\opencode_memory_dashboard.mjs`

#### 2.3 在 `opencode.json` 启用插件
示例：
```json
{
  "plugin": [
    "./plugins/memory-system.js"
  ]
}
```

如果你使用插件组合，也可以写在同一个数组中。

#### 2.4 重启 OpenCode
重启后插件自动生效。

---

### 3. 使用方式

#### 3.1 自动运行（默认）
- 你正常聊天即可，无需每次手动命令。
- 插件会自动记录记忆、自动进行发送前裁剪。

#### 3.2 仪表盘（37777）
- 启动 OpenCode 后，仪表盘会跟随启动。
- 访问：`http://127.0.0.1:37777`
- 关闭 OpenCode 后，仪表盘会跟随关闭。

#### 3.3 你可以在仪表盘做什么
- 查看全局偏好与会话记忆。
- 编辑会话摘要。
- 批量删除会话记忆。
- 管理回收站（清理过期、永久删除）。
- 调整内存系统参数（保存后持久化，下次启动继续生效）。

---

### 4. 记忆与裁剪机制（简明版）

#### 4.1 记忆写入
- 用户消息、助手消息、工具结果会写入会话记忆文件。
- 全局偏好写入 `global.json`。

#### 4.2 注入
- 会话首条：可注入全局偏好。
- 固定频率：每 N 条用户消息注入当前会话摘要（默认 5）。
- 跨会话：命中跨会话意图时触发 recall 注入。

#### 4.3 发送前 token 控制
发送前按顺序执行：
1. 机械裁剪（低信号工具输出、噪音内容降权/替换）
2. 若仍超预算，再做 LLM 总结（内联或独立）
3. 失败自动回退，不阻断主对话
4. 若开启 `sendPretrimWarmupEnabled`，会在上一轮后后台预生成候选总结，减少下一轮发送等待

说明：
- 裁剪/LLM总结发生在“发送前”，所以可能带来本次发送前等待。
- 开启后台预总结后，下一轮更容易命中缓存（`warmup-cache`），体感更平滑。

---

### 5. 参数说明（核心）

以下参数都可在 37777 参数页配置并保存。

#### 5.1 开关参数
- `sendPretrimEnabled`：是否启用发送前裁剪。
- `sendPretrimWarmupEnabled`：是否启用后台预总结缓存（降低下一轮发送卡顿）。
- `dcpCompatMode`：DCP兼容模式（机械裁剪优先，超阈值再LLM总结）。
- `independentLlmEnabled`：是否启用独立LLM总结通路。
- `injectGlobalPrefsOnSessionStart`：新会话首条是否注入全局偏好。
- `recallEnabled`：是否允许跨会话召回。
- `visibleNoticesEnabled`：是否显示可见提示。

#### 5.2 数值参数
- `sendPretrimBudget`：发送前预算阈值（正文估算 token）。
- `sendPretrimTarget`：裁剪目标 token。
- `sendPretrimTurnProtection`：保护窗口（最近 N 条用户轮次不强裁剪，默认 10）。
- `currentSummaryEvery`：每多少条用户消息注入一次当前会话摘要（默认 5）。
- `currentSummaryTokenBudget`：单次当前会话摘要注入预算。
- `recallTokenBudget`：跨会话召回注入预算。
- `visibleNoticeCooldownMs`：可见提示冷却时间。

#### 5.3 LLM 总结模式
- `llmSummaryMode=auto`：默认模式；若独立LLM可用则优先独立，否则走内联。
- `llmSummaryMode=session`：强制内联总结。
- `llmSummaryMode=independent`：强制独立LLM总结（需配置完整连接信息）。

---

### 6. 数据路径

- 主目录：`~/.opencode/memory/`
- 全局偏好：`~/.opencode/memory/global.json`
- 会话记忆：`~/.opencode/memory/projects/<project>/sessions/*.json`
- 仪表盘数据：`~/.opencode/memory/dashboard/`
- 回收站：`~/.opencode/memory/trash/`
- 审计日志：`~/.opencode/memory/audit/memory-audit.jsonl`

---

### 7. 常见问题（简版）

#### 7.1 为什么没有跨会话记忆
- 检查 `recallEnabled` 是否开启。
- 检查是否命中跨会话意图（或手动 recall）。

#### 7.2 为什么 token 还是高
- 先确认 `sendPretrimEnabled=true`。
- 再确认 `sendPretrimBudget/Target` 设置是否过高。
- 系统层/MCP定义通常不由本插件裁剪。

#### 7.3 为什么 37777 没有更新
- 先刷新页面。
- 检查 OpenCode 是否已启动。

---

## English Guide

### 1. What this plugin does
`opencode-memory-system` combines:
- Long-term memory (global preferences, session summaries, cross-session recall)
- Token control (send-time trimming + LLM summarization)

### 2. Installation

Required files:
- `plugins/memory-system.js`
- `plugins/scripts/opencode_memory_dashboard.mjs`

Default global plugin paths:
- macOS/Linux: `~/.config/opencode/plugins/...`
- Windows: `%APPDATA%\\opencode\\plugins\\...`

Enable plugin in `opencode.json`:
```json
{
  "plugin": [
    "./plugins/memory-system.js"
  ]
}
```

Restart OpenCode.

### 3. Usage
- Works automatically in normal chats.
- Dashboard: `http://127.0.0.1:37777`
- Dashboard follows OpenCode lifecycle (start/stop).

### 4. Runtime flow (short)
1. Record events (user/assistant/tool)
2. Inject memory (global/session/recall, based on rules)
3. Pre-send trim (mechanical first)
4. If still over budget, run LLM summarization
5. Fallback automatically if summarization fails
6. Optional background warmup prepares next-turn summary cache (`warmup-cache`)

Note:
- Trimming/LLM summary runs before sending, so that turn may wait briefly.
- Warmup can reduce the next-send latency.

### 5. Key parameters

Toggles:
- `sendPretrimEnabled`
- `sendPretrimWarmupEnabled`
- `dcpCompatMode`
- `independentLlmEnabled`
- `injectGlobalPrefsOnSessionStart`
- `recallEnabled`
- `visibleNoticesEnabled`

Numeric:
- `sendPretrimBudget`
- `sendPretrimTarget`
- `sendPretrimTurnProtection` (default 10)
- `currentSummaryEvery` (default 5)
- `currentSummaryTokenBudget`
- `recallTokenBudget`
- `visibleNoticeCooldownMs`

LLM summary mode:
- `auto`
- `session`
- `independent`

### 6. Data locations
- `~/.opencode/memory/`
- `~/.opencode/memory/global.json`
- `~/.opencode/memory/projects/<project>/sessions/*.json`
- `~/.opencode/memory/dashboard/`
- `~/.opencode/memory/trash/`
- `~/.opencode/memory/audit/memory-audit.jsonl`
