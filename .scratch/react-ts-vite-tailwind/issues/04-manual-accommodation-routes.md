# 04: 手动添加住宿与路线联动迁移

**What to build:** 用户能继续使用旧住宿安排，通过地图或键盘确认位置创建基地，保存备选或应用多晚，并看到住宿摘要和相关路线同步更新。

**Blocked by:** 03

Status: claimed

- [ ] 建立有类型的住宿基地、晚次引用和路线状态，以单一权威住宿状态派生详情、摘要、使用中基地数量及路线端点。
- [ ] 读取并保持既有住宿存储键、版本及有效数据格式，同源刷新兼容旧基地和晚次选择；与出发清单存储独立。
- [ ] React 住宿表单支持酒店或区域、必填名称和确认位置、选填地址及备注；地图点击和键盘确认位置均可操作，取消选点保留草稿。
- [ ] 支持仅保存为备选、选择已有基地及应用一晚或多晚；备选不计入使用中基地数量，写入失败不报告成功或破坏当前有效安排。
- [ ] 更换住宿只更新相关当天终点、次日出发点及驾车查询，保留景点顺序；区域基地说明按代表位置估算。
- [ ] 呈现更新中、成功及未更新状态；失败保留住宿且不把旧估算显示为有效新路线，旧请求不得覆盖更新选择或改变当前选中日期。
- [ ] 为后续搜索、管理、备份和打印提供显式业务模块接口与共享状态访问方式，不要求保留旧全局业务对象。
- [ ] 复用住宿核心及路线测试场景，通过页面操作和 provider 请求契约验证多晚、刷新、旧数据、必填校验、键盘选点、存储失败和乱序；严格类型检查及构建通过。


---

## Answer (part A — authoritative domain, storage, provider)

Branch `ticket/04-manual-accommodation-routes`; NOT resolved — parts B (dialog/search) and C (manager/backup/print wiring) remain.

### Built items

- `src/domain/types.ts` — appended accommodation domain types: `AccommodationBase` (id, name, type `area|hotel`, lat/lng WGS-84, address?, notes?, createdAt?, isDefault, routeName? — default-base only), `AccommodationState {version:1, bases, stays}` (stays = overrides only), `AccommodationChangeEvent {type, dayIndices, routeDays, base?, previousBase?, changed?}`, `RouteEndpoint` with `kind: 'base'|'point'|'keyword'` (keyword stops carry no lat/lng), `AccommodationDayRoute`, `AccommodationBackup`/`AccommodationBackupBase`.
- `src/domain/accommodation.ts` (new) — pure, framework-free state machine, no storage/DOM/globals: derived `overnightDays` [0..5] + hardcoded `defaultStayByDay` (legacy L12), 5 area default bases from `tripPlan.points` with routeName; `defaultBaseFor`, `normalizeBase` (exact L57–78 coercion), `customBaseId`, `getBase`/`getDayStay`/`selectedStay`/`listBases`, `usedDaysForBase`/`stayFor`, `usedBaseIds`/`inUseBaseCount`/`getBaseCount`/`basesInUse`/`alternateBases`, `stayNoteGroups`/`stayNoteText` (consecutive same-stay → `name N 晚`, ` → `-joined), `getEndpoint`/`getDayRoute`/`dayRouteEndpoints` (day0 from=airport point, last-day to=airport point, day1/2 keywordOnly nav-{index} stops, routeName fallback `routeName||address||name`, isCustom/isChanged per gotchas 9/13/14), `routeSignature`, `affectedRoutes` ({N,N+1}∩[0,days)), mutations `applyStays`/`assign`, `updateBase`, `deleteBase`, `restoreDay`, `createBase` (atomic save-and-apply option), `saveBase`/`saveAsAlternate`, `validateBackup` (all 17 exact messages), `replaceState`/`importState` (whole replace, routeDays by signature diff; stays copied verbatim — no collapse). All committed mutations return `{ok:true, committed:true, state, event, dayIndices, routeDays}`; no-ops return `{ok:true, committed:false, changed:[]}`; errors `{ok:false, error}`.
- `src/domain/storage.ts` (new) — key `hailar-slow-trip-accommodation-v1`, payload byte-compatible `{version:1, bases, stays}`; `readState(storageLike)` never throws (corrupt/missing → defaults; version ignored; invalid bases dropped; `isDefault` stripped via normalizeBase); `writeState(storageLike, state)` → `{ok:true}|{ok:false, error:'保存失败'}`; `ACCOMMODATION_WRITE_FAILURE_STATUS = '当前浏览器未允许保存，住宿安排未改变。'`; injected storage-like (default `window.localStorage` lazily).
- `src/hooks/useAccommodation.tsx` (new) — `AccommodationProvider` (accepts injected `storage` prop; loads on mount via `readState`), `useAccommodation()`. Exposes `{state, actions, lastError, subscribe, onChange}`; actions `createBase(input, {applyToNights})`, `updateBase`, `deleteBase`, `applyStays(dayIndices, baseId)`, `saveAsAlternate`, `restoreDay`, `replaceState`. Persists via `writeState` on every committed mutation; write failure keeps current in-memory state (no rollback), sets `lastError` to the exact status string, returns `{ok:false, error:'保存失败'}` (replaceState additionally `errors:[status]`). Listeners get `{...event, state}`; unsubscribe returned. NOT mounted in App.tsx (parts B/C wire it).
- `tests/accommodation-core.test.ts` (new) — 24 pure tests: normalizeBase cases, defaults derivation, multi-night apply, alternates excluded from count, single-night restore, delete protection exact message, default immutability, update propagation + routeDays, {N,N+1} invalidation sets, dayRouteEndpoints day0/1/6 + area base + missing-stay fallback + gotcha-13 default-on-foreign-night, stay-note grouping (consecutive vs non-consecutive 海拉尔), storage round-trip/byte shape, corrupt+missing+throwing storage → defaults, legacy isDefault/extra-field/version quirk, write-failure shape + status string, replaceState full replace + exact validation errors.

### Gates (exact commands + results, npm cache passed explicitly)

- `npm run typecheck` → pass (tsc --noEmit, 0 errors)
- `npm run build` → pass (tsc + vite build, dist/app.html + assets)
- `npm test` → 44/44 pass (4 legacy cjs-equivalents incl. amap-utils + accommodation-search, 24 new accommodation-core tests, 16 others)
- `npm run test:browser` (20 legacy) → 20/20 pass; legacy files untouched
- `npm run test:app` (24, dev) → 24/24 pass
- `npm run test:app:prod` (24, preview) → 24/24 pass on final run. Two intermittent flakes observed across runs (`route failure marks 路线未更新…`, `no route data keeps reference map…`) — REPRODUCED IDENTICALLY on a clean worktree of `ticket/03-amap-driving` (pre-part A code), so they are pre-existing preview-suite timing flakes, not caused by part A.

### Interface summary for parts B/C

- Provider API (via `useAccommodation()`): `{state, actions, lastError, subscribe(listener)->unsubscribe, onChange=subscribe}`. `state: AccommodationState {version:1, bases: custom[], stays: Record<number,string> overrides}`. Actions return legacy-shaped results: `{ok:true, committed:true, state, event, dayIndices, routeDays, changed?, base?, previousBase?} | {ok:true, committed:false, changed:[]} | {ok:false, error}`; `replaceState` returns `{ok:true,...}|{ok:false, errors:string[], error}`.
- Change events (`AccommodationChangeEvent`): `{type:'assign'|'create'|'update'|'delete'|'restore', dayIndices, routeDays, base?, previousBase?, changed?}` — `routeDays` = {N,N+1}∩days per changed night (update: only when lat/lng changed; delete/create-alternate: []). Listener payload adds `state`.
- Route endpoints (`getDayRoute(state, i)` / `dayRouteEndpoints(i, state)`): `{from, to, via, stops, hasCustomEndpoint, hasChangedEndpoint}`; endpoint `kind:'base'|'point'|'keyword'` (keyword stops lack lat/lng — AMap boundary decides location-vs-keyword). Day 0 from=airport point, last-day to=airport point, days 1–2 carry `keywordOnly` `nav-{index}` scenic stops.
- Route statuses are NOT part of this module: consume `src/domain/routeStates.ts`/`src/hooks/useRouteStates.tsx` (already live) and `routeDays` from change events to mark `stale`/`reference` (legacy assign/replace flows) — the AMap live controller in part C does the `pending→updated→unupdated` cycle.
- Storage codec: `readState/writeState(storageLike)`; key/format byte-compatible with the legacy site (same-origin data loads). Backup import/export UI (part C) uses `validateBackup`/`replaceState`/`getBackup`-equivalent (getBackup builder still to be added in part C alongside backup strings).

### Open risks

- Defaults-only backup restore leaves explicit default stays entries in `stays` (legacy §2.2 copies backup stays verbatim) — selectors resolve them correctly; do not "optimize" by collapsing.
- Default bases have no `createdAt` (legacy shape) — `AccommodationBase.createdAt` is optional; customs always have it.
- `npm run test:app:prod` has intermittent timing flakes in the AMap preview suite (pre-existing; reproduced on ticket-03 tree).
