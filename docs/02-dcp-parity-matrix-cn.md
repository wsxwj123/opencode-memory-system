# Memory-System vs DCP 对齐矩阵（2026-03-05）

## 能力对比

| 能力 | DCP | memory-system 当前状态 | 备注 |
|---|---|---|---|
| 发送前自动裁剪 | 是 | 是 | `experimental.chat.messages.transform` 钩子 |
| 低信号输出丢弃（discard） | 是 | 是 | 自动 + 手动 `/memory discard` |
| 上下文蒸馏（extract/distill） | 是 | 是 | 自动 + 手动 `/memory extract` |
| 替换式压缩（非仅追加） | 是 | 是 | anchor-replace + block 占位 |
| 独立 LLM 蒸馏 | 是（可配置） | 是（可配置） | `independent` 模式 |
| 自动回退链 | 是 | 是 | independent -> session -> extract |
| 可观测 traces | 是 | 是 | pretrim traces + doctor |
| 回收站与审计 | 通常无内置 UI | 是 | 37776 面板支持 |
| 内核级历史改写 | 否（同属插件层） | 否 | 都依赖发送前变换 |

## 已对齐重点
- 发送前预算裁剪（budget/target/hard-limit）。
- 二阶段处理（rewrite + distill/extract）。
- block 化蒸馏记录（含起止 messageID、节省估算）。
- 超预算下的 anchor-replace 闭环替换。
- 自适应策略与 phase-aware trim。

## 尚可继续优化项
- 更细粒度的“工具语义保护白名单”（按工具参数与状态）。
- 更强的“任务完成信号识别”（结果优先排序可继续提升）。
- 自检脚本覆盖更多真实日志样本（而非仅合成消息）。

## 验收标准（插件层）
- 超预算时：`beforeTokens > afterTokens` 且存在重写/蒸馏证据。
- 系统层消息保留：system token 不被误裁剪。
- 关键结果不丢：write/edit/bash/read 结果在摘要或保留窗口中可追溯。
- 37776 可追踪最后一次 pretrim 和注入状态。

