# 02: 每日行程与参考地图迁移

**What to build:** 用户能够查看完整七天行程、切换每日详情与对应参考地图，并查看全程路线和住宿摘要。

**Blocked by:** 01

Status: resolved

- [x] 保留七天六晚行程、文案、景点顺序、出发准备、导航锚点和原有视觉层次；不重排旅行计划。
- [x] 日期选择、每日详情、默认住宿摘要和全程查看由 React 状态驱动，应用布局使用 Tailwind，行程及路线数据具有明确 TypeScript 类型。
- [x] Leaflet 通过有类型的适配边界管理独立地图容器，日期切换联动标记和参考路线；底图失败时仍显示可用的行程与参考信息。
- [x] 地图实例和事件随挂载清理，开发重复挂载及热更新不产生重复地图或监听器。
- [x] 预置路线、图标、地图样式及相关资源在开发与生产预览中均能加载。
- [x] 浏览器验收每日切换、全程查看和底图失败；核对桌面、手机布局及可访问名称，相关回归、类型检查和构建通过。

## Answer

**Built (all on branch `ticket/02-itinerary-reference-map`):**

- Typed data ports: `src/data/itinerary.ts` (`tripPlan` — 7 days × 15 fields in legacy field order, `points` xy=[lat,lng], `estimates`, `overviewStops`, `POINT_KEYS`, `dayPointCoords`) and `src/data/roadRoutes.ts` (`roadRoutes` waypoints/7 legs [lng,lat], `legByDay` identity map, `roadLines` [lng,lat]→[lat,lng] conversion done once). Shared types in `src/domain/types.ts` with explicit `LatLng`([lat,lng]) / `LngLat`([lng,lat]) orders.
- `src/domain/geo.ts`: typed wrapper over the vendored `coordtransform` global (`wgs84ToGcj02LngLat(lat,lng)→[lng,lat]`, `gcj02ToWgs84LngLat`, `hasCoordinates`). No `escapeHtml` helper needed — React text nodes escape user data (visual output identical, note A gotcha 13).
- `src/services/navigationUrl.ts`: byte-faithful `searchUrl` + `navigationUrl` builder (endpoint gcj02 math `lng6,lat6,name`, to/mode/policy/src/callnative params, from only when `!currentLocation`, one via). Ticket 02 has no accommodation so every day takes the `searchUrl(nav[1])` fallback; the full builder (route param, notice) is in place for tickets 03+.
- `src/services/map.ts`: Leaflet adapter — init on `#route-map` (center [49.5,119.5] zoom 7, zoomControl false, scrollWheelZoom false, minZoom 5, maxZoom 16), OSM + Esri satellite + `L.control.layers` + zoom control, full-route/time-label/selected layer groups, static circle markers (radius 6 #c36a4f, click→day map incl. airportH/hailar→0, nothing→0), tile-error fallback (≥3 consecutive tileerror → `#map-error`, reset on tileload), ResizeObserver→invalidateSize. Draw helpers: `drawSelectedDay` (white 9 + #1768d1 6; circles radius 8 weight 3: first #236a51 / last #b75342 / mid #1768d1), `showTimeLabels` (divIcon 116×57, anchor [58, idx0||3?-12:70], zIndexOffset 800, `<small>title</small><strong>time</strong><span>行程预估</span>`), `renderFullRoute` (white 8 + #2474db 5 opacity .85), `fitTrip`/`focusDay` (pads [60,65] maxZoom 11 / [50,70]+[50,65]). `map.remove()` deletes the container id → StrictMode/HMR remounts are clean (verified: 1 `.leaflet-map-pane` in dev).
- `src/hooks/useRouteMap.ts`: map lifecycle (create once, destroy on unmount, ref-wrapped callbacks, handle sink for App, `tileError` state).
- React sections: `src/App.tsx` (intro/flight, summary strip with `#distance-summary` / `#accommodation-count` static `5`, journey, reason grid, prepare `<details>`×4, sources, footer; `selectedDay`/`overview`/`legend` state; `choose`/`fit` ported imperatively, boot order `choose(0,false); fit()` via `onMapReady`), `src/components/DaysPanel.tsx` (`#days`, `.day-button`/`data-day`/`aria-pressed`/`.day-num`/`.day-copy`, `.stay-note`), `src/components/RoutePanel.tsx` (`.map-wrap` + `#route-map` aria-label + `.map-title` + `#fit-map` + `#map-error` + `.map-legend` + `#overview-times` singleton + `.route-strip` + `#day-detail` aria-live), `src/components/DayDetail.tsx` (navigation panel + detail card with accommodation-absent fallbacks: static leg, `d.stay`, `参考里程约 N km` (+ roads `G332 → S301` pattern), exact notes/strings). Checklist untouched.
- `app.html` now loads `/vendor/coordtransform.js` (classic script) before the module script; `public/vendor/coordtransform.js` = byte-identical copy of `vendor/coordtransform.js`.
- `src/index.css`: `@import "leaflet/dist/leaflet.css"` + `@layer components` port of the legacy map-container overrides (map-wrap heights 375/310/420/430/520 via `:has()`, overlay z 400/410/420, `.route-time-marker`, `#overview-times`, leaflet control/tooltip/layers-图层 overrides, `#days` mobile snap carousel, `.day-button` pressed notch, navigation/day-detail/prepare styles, responsive 720/1050/1500 and print subset). Page-wide shell blocks use Tailwind utilities (as in ticket 01).

**Exact commands + results:**

| command | result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm run build` | pass (vite 8.2.2, `dist/app.html` 0.49 kB, css 38.79 kB, js 409.75 kB; `/vendor/coordtransform.js` copied to dist) |
| `npm test` | 8/8 pass |
| `npm run test:browser` (legacy suites) | 20/20 pass — legacy files untouched |
| `npm run test:app` (dev, StrictMode) | 16/16 pass (8 checklist + 8 itinerary) |
| `npm run test:app:prod` (preview) | 16/16 pass |

New suite `tests/app/02-itinerary.app.browser.cjs`: day-0 initial state + summary; day-2 click → aria-pressed/detail/≥1 polyline; `#overview-times` `data-route-day` jumps; `#fit-map` → 全程 legend + overview re-shown (clicks the visible left edge of the button because the legacy leaflet layers toggle overlaps its centre — reproduced legacy layout); tile-failure → `#map-error` visible with external network aborted and itinerary still interactive; mobile 390×844 switching + no horizontal overflow; keyboard (Tab/Enter) + `:focus-visible` outline; a11y labels.

**Notes for ticket 03 (AMap) / later:**
- `staticRouteGeometry(dayIndex)` in `src/services/map.ts` is the accommodation-free branch of legacy `routeGeometry` — ticket 04 replaces it with the route-state-aware version (changed-endpoint/updated coordinates, `null` when stale).
- Legend variants `高德路线已更新` / `住宿已更换 · 路线未更新` / `市区目的地 · 高德实时规划路线` and the `高德路线` time-label source are resting in `choose`/`showTimeLabels` (map.ts `TimeLabelEntry.source`).
- `choose(day, focus)` has the `focus` param (day buttons/overview-times true, static markers false). Legacy `if (focus) map.removeLayer(fullRouteLayer)` happens inside `focusDay`; `fitTrip` re-adds.
- `#overview-times` is state-driven (`overview` bool) — choose hides it, fit shows it, matching trip.js remove/re-create semantics (gotcha 3).
- `.map-wrap:has(#overview-times)` / `:has(.route-time-marker)` CSS uses `:has()` exactly like trip.css (modern Chrome; ticket 03's `.map-wrap.amap-active` variant not yet added).
- `#map-error` text and 3-consecutive-tileerror logic live in the map factory (`onTileError` callback) — no state duplication.
- `navigationUrl`/`navigationLimitNote` signature accepts the accommodation route; `navigationPlaceLinks` not yet rendered (returns nothing without keyword-only vias).