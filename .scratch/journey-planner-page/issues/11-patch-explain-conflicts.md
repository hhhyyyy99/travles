# 11: 修改回合：影响分析与冲突消解（patch-explain）

**What to build:** AI 处理对既有行程的修改指令时不再直接执行：先复述识别到的变更与影响面、指出冲突（如"10/7 要住海拉尔但原计划住满洲里"），给出处理选项 chips；用户选择后执行重排，并逐日汇报改动与为满足约束所做的妥协（如为赶场次压缩某景点）。边界警示落地：时间约束自相矛盾时先指出；跨天驾车 > 6 小时给拆分建议（AI 与交通段组件双通道）。

**Blocked by:** 08, 09。

**Status:** resolved

- [x] 修改类指令触发影响分析回合：冲突指明 + 解决选项 chips
- [x] 选择方案后全环线重排正确，逐日汇报含妥协说明
- [x] 自相矛盾的时间约束被指出而非静默取其一（mock 模型测试）
- [x] >6h 驾车段在画布上可见警示，AI 侧给拆分建议

## Answer

Added deterministic patch-explain gating with exact one-use confirmation
chips bound to the current trip snapshot, conflict and time-order warnings,
cross-day long-drive analysis, and full-trip patch rebuilds. Forged,
replayed, stale, and storage-invalid confirmations are rejected before model
write access. Final evidence is in the [shared acceptance report](../acceptance.md):
149 frontend and 180 server tests passed, with both dev and preview browser
sweeps at 113/113.
