# OpenCode Memory System · DCP 对齐路线图（2026-03-05）

## 目标
- 让 memory-system 在“记忆保留 + token 控制”两方面尽量对齐 DCP 的体验。
- 默认自动化，无需用户频繁手动干预。
- 维持现有跨平台可移植性（Mac/Windows）与插件兼容性。

## 约束
- 不改 OpenCode 内核。
- 不改其他插件加载顺序与配置。
- 只在本插件范围内实现发送前裁剪、蒸馏、替换和可观测性。

## 分阶段清单

### P0 基线与可观测性
- [x] 增加 `/memory doctor` 输出注入/裁剪/节省/风险状态。
- [x] Dashboard 展示 pretrim traces、summary blocks、近似 token。
- [x] 增加 composition（S/U/T）前后占比。
- [x] 增加“基线回归脚本”自动生成 before/after 报告（本次补齐）。

### P1 发送前替换式裁剪（核心）
- [x] 阶段一：低信号 tool/context 重写（rewrite）。
- [x] 阶段二：批量蒸馏（distill/extract）并写入 summary block。
- [x] 锚点替换闭环（anchor-replace）避免 A+B+C 叠加。
- [x] 严格模式开关与保护窗口（strict mode + turn protection）。

### P2 DCP 风格蒸馏
- [x] 模式：`auto/session/independent`。
- [x] independent 支持 openai-compatible / gemini / anthropic。
- [x] 蒸馏质量门槛（低质量自动回退）。
- [x] 回退链：independent -> session inline -> extract。

### P3 自适应策略
- [x] budget ratio 驱动的 adaptive level/ratio。
- [x] phase-aware trim（discovery/verify/network 优先降权）。
- [x] 策略计数入 traces（dedup/supersede/purge/phaseTrim）。

### P4 记忆与注入策略
- [x] 首条用户消息后建档（避免空会话冗余文件）。
- [x] 每 5 条用户消息注入一次当前会话摘要（预算约 500 tokens，硬上限）。
- [x] 触发词收紧，跨会话误触发降低。
- [x] 跨会话召回支持标题/关键词召回。

### P5 37776 看板与审计
- [x] 动态 `GET /api/dashboard` 拉取。
- [x] 编辑摘要可保存并落盘。
- [x] 批量删除（勾选会话）。
- [x] 回收站 + 保留天数 + 手动永久删除 + 审计日志。
- [x] 自动刷新 60s。

### P6 运行时插件注入问题
- [x] 精确定位 `chinese-settings` 运行时被加载来源。
- [x] 给出无损断链方案（改为非 `.js` 扩展名）。
- [x] 在 README 增补“OpenCode 会自动扫描 plugins/*.js”注意事项（本次补齐）。

### P7 自检与发布
- [x] 增加仿真自检脚本（覆盖 system/MCP/skill 场景）。
- [x] 运行自检并形成报告。
- [x] 同步 README 说明。

## 本轮执行顺序
1. 补齐 P0/P7 自检脚本与报告。
2. 补齐 P6 文档说明。
3. 跑语法检查 + 行为自检 + 结果落盘。
4. 输出“完成项/剩余项/风险”。
