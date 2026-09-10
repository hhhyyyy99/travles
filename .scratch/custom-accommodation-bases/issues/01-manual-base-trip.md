# 01: 手动添加住宿基地并用于行程

**What to build:** 用户从每日住宿入口在地图上选点，添加酒店、民宿或住宿区域，保存为备选或用于一个或多个住宿晚次；刷新后保留，并在住宿视图、地图和路线中看到一致的结果。

**Blocked by:** None (can start immediately)

Status: resolved

- [x] 先将固定住宿表达整理为可复用的基地和晚次关联，保留原有行程、默认住宿及现有清单行为；此准备工作随本票交付，不形成独立的横向任务。
- [x] 基地具有稳定标识、名称、有效位置、酒店或区域类型、可选地址和备注；名称或位置无效时阻止保存，不要求已经预订。
- [x] 每日住宿旁提供“更换住宿”，可选择已有基地或新增；新增后可保存为备选或用于指定晚次，同一基地可用于多晚。
- [x] 本地保存基地及每晚选择，刷新后恢复；明确说明不自动同步，清除浏览器数据会丢失设置，存储失败不显示保存成功。
- [x] 每日住宿、地图标记及住宿摘要同步更新，基地数量仅统计实际使用的不同基地，备选不计入。
- [x] 保持原有行程天数和景点顺序，住宿变化更新当天终点和次日出发点，并重新查询受影响路段的路线、驾车距离及时间；不存在下一日时不新增行程。
- [x] 路线查询期间显示更新状态；失败或服务不可用时仍保留住宿，明确提示“路线未更新”，不得将旧几何或估算作为新路线结果。
- [x] 区域型基地说明距离按代表位置估算；较旧的异步查询响应不能覆盖较新的住宿选择。
- [x] 通过浏览器用户流程验证手动添加、备选、多晚分配、刷新恢复、计数和路线联动；用可控路线响应覆盖失败与乱序返回，运行现有路线行为测试。
- [x] 主要添加和选择操作在移动屏幕及键盘操作下可完成。

## Answer

Implemented on branch `codex/accommodation-01`. The new accommodation API persists validated custom bases and per-night references, supports Leaflet map picking, multi-night assignment, default restoration, synchronized stay/map/summary rendering, stale-route suppression, and AMap recalculation with request-version protection. D1/D2 route stops preserve the scenic destinations from the approved route contract.

Evidence: `node --check accommodation.js trip.js amap-integration.js`; `node --test` (3 existing tests passed); isolated browser smoke flow at `http://127.0.0.1:4190/index.html` confirmed map pick at `49.300000,119.700000`, multi-night assignment, reload persistence, base count, and `路线未更新` for affected legs. Extension seam: `/private/tmp/accommodation-extension-notes.md`.
