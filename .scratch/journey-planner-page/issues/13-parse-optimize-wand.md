# 13: 智能解析、路线优化、天级魔法棒

**What to build:** 三个 AI 增强能力：① 输入框旁"智能解析"——粘贴一段攻略长文本，AI 解析为结构化行程项供确认后写入；② "路线优化"——AI 对现有行程做全局优化建议（走法、顺序、节奏），确认后应用；③ 列表/画布天签上的魔法棒——只优化指定的一天。三者都走"建议 → 确认 → TripPatch 应用"路径，不静默改行程。

**Blocked by:** 08, 10。

**Status:** done

- [x] 粘贴攻略文本可解析为可确认的行程项（mock 模型测试解析输出形状）
- [x] 全局路线优化给出建议 diff，确认后应用、取消不动
- [x] 魔法棒只重排目标天，其余天不变
- [x] 三个入口均有失败重试，应用走既有 patch 校验

## Answer

已完成三个 AI 入口的“建议 → 确认 → TripPatch 应用”闭环：

- `POST /api/trips/:id/ai/proposals` 调用只读 `create_trip_proposal`，智能解析返回结构化 `items`，全局/天级优化返回 `diff` 与候选 patch；`read_trip_snapshot` 为优化模型提供当前行程上下文。
- `POST /api/trips/:id/ai/proposals/:proposalId/apply` 才会执行既有 `applyTripPatch` 校验与写入；取消、过期、校验失败都不改行程，失败保留建议以便重试。
- 聊天输入旁新增“智能解析”，顶栏新增“路线优化”，画布/列表天签新增魔法棒；确认成功后画布与地图重新读取服务端数据。

验证：`pnpm --filter @hailar/server typecheck`；前端 `pnpm exec tsc --noEmit`；server 107 tests；`tests/ai-proposals.test.ts`；`tests/app/14-ai-proposals.app.browser.cjs`；`pnpm run build` 均通过。
