# 05: 住宿搜索与重复提醒迁移

**What to build:** 用户能够搜索并确认住宿位置，处理重复基地提醒；搜索不可用时可保留草稿转为手动选点。

**Blocked by:** 04

Status: resolved

- [x] 使用 React 与 TypeScript 实现查询、结果选择、位置确认及表单回填，沿用共享住宿创建流程，选中未确认结果不能直接持久化。
- [x] 搜索结果在服务边界完成坐标归一化；酒店与住宿区域沿用现有模型，不编造缺失位置。
- [x] 同名且邻近的候选提示重复，用户能复用现有基地或明确继续新建，不强制合并。
- [x] 空结果、服务不可用和查询失败反馈准确；失败保留查询与草稿，手动选点仍可继续保存并应用。
- [x] 快速修改搜索或关闭界面后，过期结果不覆盖当前查询及草稿；保留键盘操作、焦点行为和移动布局。
- [x] 迁移现有搜索及重复判断行为测试和纯逻辑测试，通过外部 provider 夹具覆盖确认前不保存、复用、继续创建及失败回退；相关回归、类型检查与构建通过。

## Answer

Branch `ticket/05-accommodation-search` (off merged baseline f464a57), worktree t05.
Commands + results (npm cache redirected):

- `npm run typecheck` — pass
- `npm run build` — pass (tsc + vite build)
- `npm test` — 48/48 pass (includes migrated `tests/accommodation-search.test.ts`, 4/4)
- `npm run test:browser` — 20/20 pass (legacy suites untouched)
- `npm run test:app` — 44/44 pass (dev; suites 01–05, incl. new 05-search.app.browser.cjs 7/7)
- `npm run test:app:prod` — 44/44 pass (build + preview)

Commits: 8ebb66f (scaffold: typed search service + duplicate domain helpers), 624065e (search panel in dialog), a3d1e29 (pure + app browser tests).

Notes for ticket 09 (integrate/cutover):
- Search-flow status messages belong to `#accommodation-search-status` (search panel); the create-flow status is `#accommodation-dialog-status` — two separate aria-live elements, legacy contract. `prepareNewBase` writes the dialog status; search writes the search status.
- The migration-notes files (C-maps-and-search.md / B-accommodation-core.md / D-manager-backup-print-tests.md) are NOT present in this worktree; ported against the authoritative legacy sources in-repo (`accommodation-search.js`, `tests/accommodation-search.browser.cjs`, `tests/accommodation-search.test.cjs`).
- `tests/helpers/amap-stub.cjs` now also stubs `PlaceSearch` + `window.placeProvider` (mode/delay/pois, function-of-query) — suites 01–04 unaffected (44/44 dev + preview).
- Stale rejection: dialog-scoped `searchTokenRef` bumped per query and on dialog close; late SDK responses are discarded before any state write.
- Duplicate rule: `findDuplicates` in `src/domain/accommodation.ts`; `DUPLICATE_DISTANCE_METERS`/`distanceMeters` (haversine) in `src/domain/geo.ts`.
- WGS-84 conversion at the service boundary via vendored `window.coordtransform` (`gcj02ToWgs84LngLat`) — fixture POI yields the exact legacy lat `49.198097`.
