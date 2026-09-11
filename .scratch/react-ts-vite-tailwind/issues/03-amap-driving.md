# 03: 高德自动加载与驾车路线迁移

**What to build:** 用户无需输入凭据即可使用已配置高德地图查看每日与全程驾车路线，加载失败时能重试或继续查看参考地图。

**Blocked by:** 02

Status: resolved

- [x] 封装高德 SDK 的类型及服务边界，复用当前本地配置能力并给出无真实值示例，说明开发及生产配置方式；不提交真实配置。
- [x] 有配置时自动加载，失败使用同一配置重试，不将访客导向凭据填写；缺少配置或服务不可用时保留参考地图与行程。
- [x] 每日与全程路线、距离、时长及交通状态保留既有语义，缺失数据不编造结果，明确经纬度顺序及 WGS-84/GCJ-02 转换边界。
- [x] 查询状态由显式模块与 React 状态联动；过期响应不覆盖最新日期或路线，SDK 必需全局入口之外不新增全局业务耦合。
- [x] 地图、计时器、订阅和异步回调具有失效与清理机制，重复挂载和热更新不会累积实例或重复查询。
- [x] 采用现有可控 provider fixture 验证自动加载、重试、失败、延迟及乱序，夹具仅替代外部服务；保留路线工具纯逻辑测试。
- [x] 已迁移行为回归、严格类型检查及生产构建通过，生产预览验证地图资源及配置接入路径。

## Answer

**Built (all on branch `ticket/03-amap-driving`):**

- `src/services/amap.ts`: typed AMap SDK boundary — `loadAMapSdk` (reuses an already-present `window.AMap` for the fixture; sets `_AMapSecurityConfig`; injects the JS API script once per page via a module-level promise; 20 s timeout; failed load drops the cached promise so `重试加载地图` reinjects with the same config), `searchRoute` overload picker (array overload when NO stop has a `location`; coordinate overload otherwise — keyword stops survive inside waypoints as `{keyword, city}`), `routePathWgs84` (GCJ-02→WGS-84 via the vendored `coordtransform`, [lat,lng] out), `createAmapMap` (one-shot Map + ToolBar/Scale + `TileLayer.Traffic`), `pointLngLat`.
- `src/services/amapConfig.ts`: config discovery — reads `window.TIBET_AMAP_CONFIG` directly (fixture), else injects `/amap-config.js` once; 404/absent → `null` → reference map fallback, never a credential form; never throws.
- `src/domain/amapUtils.ts`: pure port of legacy `amap-utils.js` — `statuses`/`colors` (5 traffic states), `duration` (never invents a missing estimate), `traffic` coverage accounting (未知 swallows unreported distance), `escapeHtml`. New `tests/amap-utils.test.ts` covers them via the tsx glob.
- `src/domain/routeStates.ts`: the single per-day route status machine (`reference → stale → pending → updated | unupdated`) with the token gate (`beginRequest` bumps per-day tokens, `markRouteStatus(..., expectedToken)` discards stale writes), `isStaleStatus`/`isChangedEndpointState`, and exact legacy label builders (`describeRouteEstimate`, `describeDriveText`, `rewriteScheduleRow`, `describeRouteNote`, `legendTextFor`). `stale` status + `changedEndpoint` parameters are the ticket-04 seam (plumbing already in place).
- `src/hooks/useRouteStates.tsx`: React context exposing the single `markRouteStatus`/`beginRequest` writer; `src/hooks/useAmapLive.tsx`: a module-level singleton controller (StrictMode/HMR-safe — map/timers/script injection/queries cannot duplicate) that owns connect/select/overview/refresh/traffic/endpoint-form/retry, per-day `overrides` map (`endpoints`/`routeStops` — the ticket-04 accommodation seam), per-day query tokens, whole-trip 7-leg chained queries, out-of-order protection via `requestId`, and renders the live-panel DOM contract (`#amap-state`, `#live-status/-title/-results`, `#amap-time-badge`, `#overview-times`, `.map-wrap.amap-active`).
- `src/App.tsx`, `src/components/DayDetail.tsx`, `src/components/RoutePanel.tsx`, `src/index.css`, `src/main.tsx`: AMap live layer wired into the app shell (boot on mount, day select → single query + route-state write, fit-map → whole-trip overview, navigation hrefs from resolved GCJ-02 path, reference-map fallback under the AMap canvas).
- `tests/helpers/amap-stub.cjs`: provider-boundary fixture that validates both documented overloads, records every request on `window.routeProvider.requests` (`coordinate`, `origin`, `destination`, `waypoints`, mode/distance/delay) and emits deterministic routes. `tests/helpers/vite-app.cjs`: only addition is the opt-in `amapConfig404` flag (dev serves the gitignored root `amap-config.js`, so the no-config path needs an explicit 404 in dev; preview 404s naturally) — backwards-compatible, used by one scenario.
- `tests/app/03-amap.app.browser.cjs`: 8 scenarios — auto-load + one keyword-waypoint query per daily select + live panel; failure → `路线未更新` then retry-to-updated; no-route keeps reference map + itinerary with no fabricated distance; out-of-order responses (slow A vs fast B, stale A never overrides); fit-map whole-trip seven keyword legs + combined metrics; absent config (reference map only); SDK load failure retries with the same config; StrictMode double-mount produces exactly 1 boot + 1/select + 7 legs (10 total, no duplicates).
- Two test bugs fixed on top of the implementation: (1) the stub records `origin: args[0]` = the WHOLE stops array on the array overload (and `waypoints` = the middle slice), so the assertions read keyword stops from `request.origin` (and check `waypoint instanceof window.AMap.LngLat` inside `page.evaluate`, where `window` exists — serialized copies cannot); (2) the double-mount count assertions captured the count AFTER the click (which pushed the request synchronously), racing itself — now the count is captured BEFORE each click, the suite waits for the landed request, waits for the estimate to settle, then asserts the exact +1; the final `=== 10` check is unchanged. No scenarios were deleted or weakened to stub-contract limits.

**Exact commands + results:**

| command | result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm run build` | pass (vite 8.2.2 — `dist/app.html` 0.49 kB, css 42.84 kB, js 429.64 kB, 1651 modules) |
| `npm test` | 9/9 pass (includes new `tests/amap-utils.test.ts` via tsx glob) |
| `npm run test:browser` (legacy 20) | 20/20 pass — legacy files untouched |
| `npm run test:app` (dev, StrictMode) | 24/24 pass (16 prior + 8 amap) |
| `npm run test:app:prod` (preview, builds first) | 24/24 pass |

**Notes for ticket 04 (drive route states from accommodation changes):**
- The `stale` status, `changedEndpoint` label parameters and the `markRouteStatus(dayIndices, status, details, expectedToken)` token gate are already implemented in `src/domain/routeStates.ts` — ticket 04 only needs to call the writer. The accommodation-free stubs currently pass `details.navigation === undefined` on failure and full details (distance/duration/durationText/coordinates/navigation) on success; a changed-endpoint notification should go through the same writer with the affected day indices.
- `AmapLiveController` (src/hooks/useAmapLive.tsx) is where accommodation drives the live layer: `overrides.set(day, [from, to])` + `query()` (exposed to React as `submitEndpoints`) is the exact seam — `routeStops(day)` rebuilds the segment from the override names plus `d.via`, and `endpoints()` feeds the resolved-navigation names. A confirmed map position on a changed endpoint (a `location` on a stop) flips `searchRoute` to the coordinate overload naturally; the stub validates that shape (LngLat instance required for endpoint overload args).
- Token hand-off: accommodation mutations should mirror the controller's `nextDayToken` pattern — bump the day token (via `beginRequest` or a local counter) before re-querying so any in-flight response captured against an older token is discarded at write time (`markRouteStatus` compares `current.token !== expectedToken`).
- Stub-recorded shapes to assert against (not app shapes): array overload `request.origin` = full stops array (first/last are the endpoints, `waypoints` = middle), `request.destination` = the second positional arg (config/callback — not an endpoint name); coordinate overload `origin`/`destination` = the LngLat/keyword args. Whole-trip overview = 7 chained keyword legs (stub delay 40 ms + 600 ms inter-leg gap, ~2.6 s total; combined metrics are 7 × stub distance/time).
- Test-helper contract: never turn the stub into app logic; the double-mount guarantee rests on the singleton controller + `connect()`'s `loading/connected` guard — a future ticket must keep StrictMode double-mount to 1 boot query or update the `=== 10` assertion intentionally.