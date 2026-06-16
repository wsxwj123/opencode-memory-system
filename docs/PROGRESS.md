# 摘要质量大修 — 进度 / 计划 / TODO

> 本地 git 工作区：`~/Desktop/opencode-memory-system`（remote = wsxwj123/opencode-memory-system）
> 运行中插件：`~/.config/opencode/plugins/memory-system.js`（每次修复 `cp` 同步过去，重启 opencode 生效）
> 更新于 2026-06-16

## 当前状态

起因：用户报 37776 页面"机械裁剪摘要一团乱麻"。opus 子代理体检发现 6 个问题，已修 4 个，**等用户重启 opencode 验证效果后继续 P1/P2/P3**。

### 已完成（4 个，已 push main + 拷回运行环境）

| commit | 问题 | 修法 | 验证 |
|---|---|---|---|
| `f771a98` | 乱麻① compressedText 含思维链 | `buildCompressedChunk` clean 阶段加 CoT 过滤 `isChainOfThoughtText` | 单元测 19/19 |
| `a3e0a0e` | 乱麻② summaryBlocks 也含 CoT | 过滤器提为模块级共享，`collectDistillSnippetsFromMessage` 也用 | 无重复定义 |
| `ae276e1` | 乱麻③ source 标签全标假 distill | `compressedBlock.source` 按 summary 前缀标真实来源 | 单元测 4/4 |
| `ba59758` | P0 注入旧摘要 | `buildCurrentSessionSummaryText` 取 ct/最新block 按时间戳取新鲜者 | 单元测 5/5 |

**乱麻根因**：纯机械路径 `compressSessionMemory→buildCompressedChunk`（每事件 push 都跑）把 assistant 思维链原文当 fact/decision 塞字段，56% 会话中招。`isChainOfThoughtText` 只匹配句首 CoT 虚词（"现在我/让我/Let me/I got"），不杀结论句。

## TODO（待修，按用户选择先停验证）

- [ ] **P2 机械裁剪丢上下文**（medium，最对症用户痛点）
  - 现象：tool 密集/无 block 长会话裁不动（`no_rewrite_candidates`，预算形同虚设，309 条 trace 超预算未裁）
  - **DCP 对比给的更优方向**：借鉴 DCP 的 `protectedFilePatterns` glob 文件保护——关键文件 read/write/edit 永不被裁。我们当前只按"角色+低信号"判定，**没有文件路径保护维度**，这是"丢上下文"的根因维度。
  - 备选方向：改 `selectDistillCandidateRange` 让 tool-result 也能进候选
  - 涉及：`selectDistillCandidateRange`(L3122) / `collectDistillSnippetsFromMessage`(L3092) / `isLowSignalPartForPretrim`
- [ ] **P1 warmup 缓存命中率 0**（medium）
  - 现象：hit=0 / miss=1165 / prepared=0，warmup 机制完全白跑，每次 distill 都打满 LLM
  - 疑似：skipBudget 把所有 warmup 机会拦了（budget 10000 偏紧）
  - 涉及：`schedulePretrimWarmupFromMessages`
- [ ] **P3 质量门 missing_key_path 过严**（low）
  - 现象：硬否决纯讨论会话（69 次失败），要求摘要必须复述源文件路径
  - 修法：放宽为软扣分而非否决
  - 涉及：`evaluateDistillSummaryQuality`

## 全景：体检发现的全部 6 问题

| # | 问题 | 状态 |
|---|---|---|
| 乱麻①②③ | compressedText/blocks 含 CoT + source 标签错 | ✅ 已修 |
| P0 | 注入旧摘要（ct 多写入路径发散） | ✅ 已修 |
| P2 | 机械裁剪丢上下文 / 裁不动 | ⬜ 待修（DCP 文件保护方向） |
| P1 | warmup 命中率 0 | ⬜ 待修 |
| P3 | 质量门过严 | ⬜ 待修 |

## DCP 对比要点

- DCP = `Opencode-DCP/opencode-dynamic-context-pruning`（npm `@tarquinen/opencode-dcp`），OpenCode 上下文裁剪插件。**不是** NeurIPS attention pruning 论文。
- **架构分歧**：DCP 模型驱动（暴露 `compress` 工具让 LLM 自己决定压什么）；我们确定性强制（超阈值代码自动压）。主动设计偏离，非 bug。
- **我们独有**：独立 LLM 蒸馏 / 纯启发式 buildCompressedChunk / warmup / 跨会话召回。
- **我们缺、值得借鉴**：① `protectedFilePatterns` glob 文件保护（→ P2 方向）② 不可变历史 + decompress 还原 ③ 摘要嵌套抗稀释。

## 回滚

```bash
cd ~/Desktop/opencode-memory-system
git log --oneline                       # 查回滚点
git revert <commit>                     # 撤某个修复
# 或回退到某个修复前：
git checkout <commit> -- plugins/memory-system.js
cp plugins/memory-system.js ~/.config/opencode/plugins/   # 同步回运行环境
# 重启 opencode 生效
```

## 重启验证清单

重启 opencode 后跑几个工具密集会话触发裁剪，看 37776 **新生成**的摘要：
- 压缩摘要不应再有 "Let me analyze…"/"我看到了关键线索…" CoT 原文
- summaryBlocks 标签：机械的应标 `pretrim-extract`，真蒸馏标 `pretrim-distill`
- 旧脏摘要要等下次裁剪覆盖，或 dashboard 点"重置摘要"立即重生成
