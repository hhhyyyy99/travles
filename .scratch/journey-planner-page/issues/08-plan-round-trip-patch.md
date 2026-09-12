# 08: 计划回合：TripPatch 工具 + AI 回写三栏（端到端里程碑）

**What to build:** 本项目的 tracer bullet：用户澄清完成后，AI 输出完整计划并**直接写入行程**——`apply_trip_patch` 工具（模型接触行程数据的唯一写通道）产出结构化 diff，服务端校验（日期连续、无重叠住宿、交通段可达），校验失败把错误回传模型重试而非直接失败；通过后落库并经 SSE 通知前端，画布与地图即时更新。AI 正式计划含逐日概览 + 关键提醒；未确认槽位以"待定"写入画布并显式声明。完成本工单即可演示"一句话 + 几次点选 → 一份可看的行程"。

**Blocked by:** 05, 07。

**Status:** resolved

- [x] 澄清完成后 AI 产出计划，画布出现完整天/卡/交通段，地图路线同步重绘
- [x] `apply_trip_patch` 服务端校验：非法 patch 被拒绝且回传模型重试（有测试）
- [x] 应用的 patch 作为结构化记录随消息保存（可追溯 AI 改了什么）
- [x] 待定槽位在画布有可见标记，AI 消息中显式声明
- [x] mock 模型端到端测试：clarify → plan → patch 落库 → SSE 通知全链路

## Answer

Implemented the structured TripPatch plan path with server validation, retry
feedback, durable applied-patch records, SSE updates, pending-slot handling,
and full projected leg rebuilds. Card/day layout changes now include exact
consecutive-day bridges while preserving atomic writes and measured/reference
quality. Final evidence is in the [shared acceptance report](../acceptance.md):
149 frontend and 180 server tests passed, with both dev and preview browser
sweeps at 113/113.

## 实现记录（ticket 08）

### TripPatch JSON schema（zod，server/src/trip-patch/schema.ts）

顶层 `{ ops: Op[] }`（1..200 个，按顺序执行）。所有 id 由模型生成（trim 后 1-64 字符），同一 patch 内新建对象后引用同一 id。

| Op | 字段 |
| --- | --- |
| `add_day` | `dayId`, `date?`(YYYY-MM-DD), `theme?` |
| `update_day` | `dayId`, `date?`, `theme?` |
| `remove_day` | `dayId`（其卡片与 legs 级联删除） |
| `add_item` | `itemId`, `dayId`, `order?`, `type`(`traffic\|stay\|attraction\|food\|other`), `title`, `note?`, `pending?`, `poi?`(`{name,lat,lng,amapId?,category?,rating?}` 或 null), `legPending?` |
| `update_item` | `itemId`, `title?`, `note?`(null=清空), `type?`, `pending?`, `poi?`(null=清除), `legPending?` |
| `move_item` | `itemId`, `dayId`, `order?`（跨天移动 + 同天调序合一，覆盖 PRD 的 ReorderItem） |
| `remove_item` | `itemId` |

`update_item` + `type:'stay'` 覆盖 PRD 的 UpdateStay。Legs 不显式建模：由相邻卡片关系推导（见下）。schema 对 ticket 11（patch-explain 复用同一工具 + 确认步骤）与 13（解析/优化流）前向兼容——它们只需带不同的系统提示词复用本工具。

### 服务端校验（apply 之前，对 patch 之后的投影态）

1. 引用完整性：add_item/move_item 的 dayId 必须已存在或本 patch 更早创建；update/move/remove 的 itemId 必须存在；add_* 的 id 必须是新的；remove_* 目标必须存在。
2. 日期连续不重叠：所有有日期的天排序后必须逐日紧邻、无重复。
3. 住宿不重叠：每天最多 1 张 `stay` 卡。
4. 交通段可达：对本 patch 涉及（新增或移动）的每对相邻卡片——两端都有 POI 坐标，或至少一端 `pending`/`legPending`（待定）；patch 未触及的相邻对豁免（存量/种子数据不受影响）。

校验失败把中文错误作为工具结果回传模型重试（每回合共 3 次调用 = 首次 + 2 次重试，计数在路由持有的 per-turn state 中）；用尽后工具返回 `final:true`，路由发 SSE `error {code:'patch_invalid'}` + `close`，不落库不持久化——流本身从不因 patch 问题崩溃。

### 写路径与 SSE

- 写路径在**新模块** `server/src/trip-patch/`（schema/apply/tool/store-memory/store-sqlite），自带 `TripPatchStoreDriver` seam（BEGIN/COMMIT 事务包裹）。app.ts 以 `tripPatchStore` 注入（测试）或惰性挂在共享 SQLite 库上。**给 ticket 09 合并者的说明**：applier 发出的写调用 = 天 upsert（显式 id/idx/date/theme）、item upsert（含 poi JSON + pending）、item/day 删除（先删 legs 再删 items）、按受影响天重建邻接 legs（占位行，`distance/duration = NULL` 待重算）；内容仓库 `upsertItem` 尚不支持 poi/pending，item 写面合并时以本模块为准对齐。
- 校验通过后按序写入；受影响天的 legs 重建为占位行（真实距离计算属 ticket 09/13）。canvas 对 null 距离渲染为无 chip，不出假数据。
- 成功后：assistant 消息持久化 `applied_patch` JSON `{summary, stats, patch}`（messages 表 02 号工单预留列启用），SSE 在 `meta` 之后、`done` 之前发 `applied_patch {summary, stats, patch}`。事件序列：`start {round:'plan'}` → `delta`* → `meta`? → `applied_patch`? → `done`。
- 每回合经 `RequestContext`（Mastra per-call requestContext）下发 tripId + 重试状态给工具 execute。
- 计划回合系统提示词（mastra.ts）：emit_round_meta(round=plan) → 逐日概览正文 + 关键提醒（预约/证件/天气/返程缓冲）→ apply_trip_patch；未确认槽位 pending:true 且正文标注"待定"，两者必须一致。

### 前端

- `src/domain/chat.ts`：解析 `applied_patch` 事件（容错 normalize），`ChatMessage.appliedPatch` 支持历史恢复。
- `ChatPanel.tsx`：流内/历史消息均渲染"已写入行程"折叠摘要卡（展开显示变更计数）；`onTripPatched` 回调触发工作台 refetch `/canvas` → 三栏与地图即时重绘。待定徽标由画布既有渲染承担（ticket 04），本票加了 `data-card-pending` 钩子便于测试。

### 测试

- `server/tests/trip-patch.test.ts`（9）：校验规则逐条 + 落库/级联/重建。
- `server/tests/chat-plan-patch.test.ts`（3）：mock 模型端到端——合法 patch 全链路（SSE 序列 + DB 行 + appliedPatch 持久化）、非法 patch 回传模型重试成功、重试耗尽 → error 事件且零写入。
- `tests/app/13-chat-plan-patch.app.browser.cjs`（2）：mock SSE → 摘要卡 + 画布重绘 + 待定徽标；历史恢复摘要卡。
