# 13: 智能解析、路线优化、天级魔法棒

**What to build:** 三个 AI 增强能力：① 输入框旁"智能解析"——粘贴一段攻略长文本，AI 解析为结构化行程项供确认后写入；② "路线优化"——AI 对现有行程做全局优化建议（走法、顺序、节奏），确认后应用；③ 列表/画布天签上的魔法棒——只优化指定的一天。三者都走"建议 → 确认 → TripPatch 应用"路径，不静默改行程。

**Blocked by:** 08, 10。

**Status:** resolved

- [x] 粘贴攻略文本可解析为可确认的行程项（mock 模型测试解析输出形状）
- [x] 全局路线优化给出建议 diff，确认后应用、取消不动
- [x] 魔法棒只重排目标天，其余天不变
- [x] 三个入口均有失败重试，应用走既有 patch 校验

## Answer

已完成三个 AI 入口的“建议 → 确认 → TripPatch 应用”闭环：

- `POST /api/trips/:id/ai/proposals` 调用只读 `create_trip_proposal`；智能解析返回结构化 `items`，全局/天级优化返回 `diff` 与候选 patch。全局和天级优化由服务端确认模型先成功读取 `read_trip_snapshot`，再接受建议。
- `POST /api/trips/:id/ai/proposals/:proposalId/apply` 才会执行既有 `applyTripPatch` 校验与写入；取消、过期、校验失败和确认前的天级范围变化都不改行程，失败保留原始请求以便重试。
- 聊天输入旁新增“智能解析”，顶栏新增“路线优化”，画布/列表天签新增魔法棒；解析预览列出行程项与待定标记，确认成功后画布与地图重新读取服务端数据。
- TripPatch 的新增、移动、删除操作会持久化受影响天的最终卡片顺序，确保优化后的顺序不会因重复 order 值回退。

验证：前端 `node --import tsx --test tests/*.test.ts`（132 pass）；后端 ticket 13 + TripPatch 聚焦套件（18 pass）；前端与后端 TypeScript 检查通过；`tests/app/14-ai-proposals.app.browser.cjs`（3 pass，含 apply 失败重试回归）。
