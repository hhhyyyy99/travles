# 04: 工作台三栏骨架 + 只读画布

**What to build:** 打开一份行程进入三栏工作台：左栏 AI 对话（本工单为占位空态）、中栏行程画布、右栏地图（本工单为占位空态）。三栏可独立收起，AI 栏可拖拽调宽，收起状态按行程记忆。画布从服务端渲染只读数据：按天分栏横向滚动、天签（日期 + 星期 + 按日着色）、每日主题、四类卡片（交通/住宿/游玩/其他，含封面图、序号、备注、无 POI 纯文本卡形态）、卡间交通段（距离 + 时长）。顶栏显示标题、日期区间徽章与返回入口。

**Blocked by:** 02。

**Status:** resolved

- [x] 从行程列表点开行程进入工作台，画布按天渲染服务端数据
- [x] 三栏各自收起/展开，AI 栏宽度可拖拽调整，刷新后状态保持
- [x] 卡片类型视觉区分正确，纯文本卡与 POI 卡形态均可渲染
- [x] 交通段展示距离与时长（数据来自服务端，重算留给后续工单）
- [x] 画布渲染有 Playwright 浏览器测试（mock 服务端数据）

## Answer

Delivered the three-column workbench shell, server canvas projection, typed
day/item/leg normalization, responsive column controls, and the current
canvas/list/map integration used by later tickets. The workbench remains a
projection of server data and keeps corrupt rows from breaking the UI. See the
[shared acceptance report](../acceptance.md) for browser evidence;
`pnpm test` passed 149 frontend and 180 server tests.

## 实现记录（供 05/06/09/10 沿用）

**API（ticket 03 的写入 API 之外新增的只读读路径，全部为增量模块，未动 trips/repository.ts 与 schema.ts）：**

- `GET /api/trips/:id/canvas` → `{ trip, days: Day[], legs: Leg[] }`（404 = 行程不存在）。
- 服务端模块：`server/src/days/`（`types.ts` 契约、`repository.ts` 容错装配、`driver-sqlite.ts` 只读 SELECT、`driver-memory.ts` 测试驱动）。默认经 `createSqliteTripRepository` 打开的同一个 SQLite 文件惰性建库读取；app 工厂新增注入项 `workbenchStore`。

**规范 JSON 形状（camelCase，服务端与前端 `src/domain/workbench.ts` 双侧容错归一）：**

```ts
Day  { id: string, index: number, date: string /*YYYY-MM-DD，可为 ''*/, theme: string, color: string /*#RRGGBB，可空→前端按 index 从调色板取*/, items: Item[] }
Item { id: string, dayId: string, order: number, type: 'traffic'|'stay'|'attraction'|'food'|'other',
       title: string, note: string, poi: PoiRef | null, images: { url: string, caption: string }[], pending: boolean }
Leg  { id: string, fromItemId: string, toItemId: string, mode: string /*默认 'drive'*/, distanceKm: number, durationMin: number, polyline: [lng,lat][] | null }
PoiRef { amapId, name, lat, lng, category, rating, introSummary }
```

- `poi === null` 即"无 POI 纯文本卡"；`images[0]` 为封面图。
- 类型词表为 ticket 语境的 `traffic/stay/attraction/food/other`（PRD §6 的 transport/activity/meal 由此映射：transport→traffic、activity→attraction、meal→food）；视觉上归入四族：traffic / stay / attraction（含 food）/ other。
- Leg 按相邻卡 `(fromItemId,toItemId)` 连接；服务端丢弃引用未知 item 的 leg；跨天 leg 本票不渲染（留给 05/09）。
- DB 列沿用 schema.ts：days(idx,date,theme,color)、items(item_order,type,title,note,poi JSON,images JSON,pending)、legs(from_item_id,to_item_id,mode,distance_km,duration_min,polyline JSON)。ticket 03 的写入 API 落库时按上述 JSON 形状即可被本画布直接渲染。

**前端结构：** `src/components/workbench/`（`WorkbenchPage` 三栏骨架 + 惰性宽度拖拽手柄、`CanvasColumn`/天列/卡片/交通段、`WorkbenchTopbar`、AI 与地图占位）；布局持久化 `src/domain/workbenchLayout.ts` + `src/hooks/useWorkbenchLayout.ts`（localStorage key `journey-workbench-layout-v1`，按 trip id 记 `{aiCollapsed, aiWidth(260–560), canvasCollapsed, mapCollapsed}`）；API 客户端与纯视图函数在 `src/domain/workbench.ts`。入口：行程列表行点击 → 工作台（也支持 `?view=workbench&trip=<id>` 直达）。

**测试：** `tests/workbench-layout.test.ts`、`tests/workbench-canvas.test.ts`（node:test 单测）；`tests/app/10-workbench-canvas.app.browser.cjs`（路由级 mock API：画布渲染、三栏收起/展开 + 刷新保持、AI 栏拖拽宽度持久、API 失败错误态）；`server/tests/days-api.test.ts`。`openApp` 助手新增可选 `setup({page,server})` 前置钩子（导航前装 route mock）。
