# 15: 地图推荐、待计划池、收藏、筛选

**What to build:** 地图底部工具条完整落地："推荐"toggle 在地图上叠加沿途推荐 POI（后端 search_poi 检索），可点击加入行程某天或收藏；"待计划"池收纳收藏/推荐但未排期的点位，可拖入画布某天成卡；"收藏"列表管理已收藏点位；筛选行（全部地区下拉 + 类型 chips 带计数如"游玩·15"）过滤地图点位。AI 的追问 chips（如"帮我看三晚的酒店参考"）可复用同一检索通道。

**Blocked by:** 05, 08。

**Status:** resolved

- [x] 推荐 toggle 展示沿途推荐点位，点击可入行程或收藏
- [x] 待计划池点位可拖入某天成为卡片，入列后从池中移除
- [x] 收藏列表可查看、取消收藏、从收藏加入行程
- [x] 地区/类型筛选正确过滤且计数准确
- [x] 推荐点位入行程后走既有 patch 校验与联动重算

## Answer

Added the persisted recommendation workflow for the workbench. The server now exposes a shared `search_poi` Mastra tool plus recommendation search, stash, and favorites APIs backed by injectable memory/SQLite drivers. The map toolbar loads and filters recommendation POIs, renders Leaflet recommendation markers, supports favorites and pending stash actions, and allows pending items to be dragged into a day. Scheduling uses the existing card-admin route, so legs are recomputed by the existing server path. The completion pass also hardens failed-write rollback, normalizes AMap GCJ-02 coordinates/ratings/photos, exposes `route_legs` and `search_stay_reference` through the planner, and adds an explicit route refresh path that upgrades estimate legs when real routing data is available.

Verification: `pnpm typecheck`; focused node tests for recommendations, route refresh, and canvas POI persistence (18 passing tests); `node --test tests/app/12-map-linkage.app.browser.cjs tests/app/15-recommendations.app.browser.cjs` (8 passing tests). The full server suite remains subject to this sandbox's local-listen/default-database restrictions in its existing environment-only cases.

Final acceptance evidence is consolidated in the [shared acceptance report](../acceptance.md):
pnpm test passed 149 frontend and 180 server tests, and the dev and preview
browser sweeps passed 113/113.
