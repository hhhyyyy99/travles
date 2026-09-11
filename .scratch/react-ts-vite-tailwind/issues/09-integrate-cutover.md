# 09: 切换正式入口并移除旧实现

**What to build:** 用户从两个原有入口访问同一完整新版旅行手册，开发者获得可复现、可静态部署且通过全部回归的迁移结果。

**Blocked by:** 05, 06, 07, 08

Status: resolved

- [x] 根入口与原旅行页面入口统一进入同一 React 应用，保留原跳转的查询参数及锚点语义；不继续维护两套业务页面。
- [x] 在所有迁移调用方完成后移除临时入口、兼容桥接及无调用的旧业务脚本和样式；SDK 必需全局、第三方样式及预置大型资源可保留。
- [x] 应用业务源码采用严格 TypeScript/TSX 与显式依赖，React 管理页面交互，Tailwind 实际承担应用样式，不保留仅包裹旧脚本的空壳。
- [x] 完整运行既有行为场景的迁移版本及现有纯逻辑测试，不删减或跳过异常用例换取通过；验证搜索、管理、恢复和打印共同使用同一有效住宿安排。
- [x] 独立类型检查与生产构建成功，静态产物可脱离源码服务器运行；生产预览验证两个入口、资源、配置接入及住宿保存后刷新恢复主流程。
- [x] 使用旧格式存储和备份验证升级兼容，核对桌面、手机、键盘操作与 A4 打印，不引入视觉重设计或行程变化。
- [x] 提供依赖安装、Node 要求、开发和启动兼容命令、类型检查、构建、预览、测试及配置文档，说明同源持久化与跨源住宿备份迁移。
- [x] 交付记录包含实际执行命令、结果和外部依赖验证限制，不沿用历史测试通过数量；保留用户既有变更，不自动部署或修改父规格和已完成的历史票。


## Answer (completed)

Cutover done: root `/` and `trip.html` now both enter the same React app (trip.html keeps the redirect stub preserving `?query` + `#hash`), the temporary `app.html` entry and all legacy implementation files (trip-plan.js / road-routes.js / amap-*.js / accommodation*.js|css / trip.css / scripts/serve.cjs / build-road-routes.cjs / root vendor scripts) and the legacy browser suites + helpers are removed. SDK-required assets kept: `public/vendor/coordtransform.js` (classic script loaded by index.html before the module script); npm leaflet + lucide-react replace vendor leaflet/lucide. `npm start` now builds + serves the production bundle (`vite preview`, port 4173); `test:browser`/`test:app` run the app suites through the root entry; README + tests/README rewritten (install, Node, ports, entries, AMap config for dev/prod with `amap-config.example.js` reference, same-origin storage note, test matrix, data compatibility).

Evidence (all in the final integrated tree, branch ticket/09-integrate-cutover):
- typecheck pass; build pass — dist contains `index.html` + `trip.html` + hashed css/js + `vendor/coordtransform.js`.
- `npm test` 56/56 (pure logic; legacy .test.cjs modules fully migrated to .ts equivalents).
- `npm run test:app` 66/66 (dev) and `npm run test:app:prod` 66/66 (production preview) — incl. the new `tests/app/09-cutover.app.browser.cjs` (root render, trip.html query+hash redirect, production entries + hashed assets + vendor script, accommodation save→reload persistence through the root, legacy-format storage renders through the root).
- One flaky assertion hardened in suite 07 (wait for the exact backup status instead of a racy immediate read) — scenario, message and data-intact assertions unchanged.
- External-dependency limitation: live AMap credentials are not available in this environment; the AMap boundary is verified via the provider fixture (tests/helpers/amap-stub.cjs), and the no-config fallback path is covered. Real-credential behavior (tiles, driving, search) requires the user's local `amap-config.js`.

## Review round (post-cutover adversarial review, both reviewers + fixes)

Two read-only reviews ran against the integrated branch (domain fidelity vs legacy worktree + notes; React integration defects). All findings fixed in a single follow-up batch:

- MAJOR — day-detail nav links now pass the accommodation route to `navigationUrl` (no more search-URL fallback for default days); `navigationLimitNote` + `navigation-place-links` (搜索<景点> links) restored for keyword-only vias (DayDetail.tsx).
- MAJOR — route-state writes are now gated by `hasChangedEndpoint` exactly like the legacy (amap-integration.js:175/204/214): unchanged days keep `reference` estimates (`参考里程约 …`) through success AND failure; live panel still reports results/errors; updated/`已更新` only for changed-endpoint days (useAmapLive.tsx).
- MAJOR — `.map-legend` in AMap whole-trip mode now shows 全程参考连线 · 非道路导航 (fit() sets overview before the amap early-return); accommodation changes re-run choose(skipAmap) so the reference map redraws (App.tsx).
- MINOR — backup import: read-in-flight token guard + close bumps the token; placeSearchReady gains an 8s plugin timeout; restoreDay/applyStays no-op results carry the full legacy shape; backup-import route days stay `pending` copy with a connected map (legacy) but re-derive stale/reference without one; connect-flush no longer double-queries the selected day; vite-app.cjs start-failure no longer masks the real error (TDZ fix); tsconfig enables noUnusedLocals/noUnusedParameters (dead code removed).
- Suite updates: locked the previously-flaky 03/04b/06/07/08 assertions to the legacy-faithful expectations above (no test weakened; the two road-name strings use the legacy `→` separator).

Final gates after the review round: typecheck pass; build pass; `npm test` 56/56; `test:app` 66/66 (dev); `test:app:prod` 66/66 (preview).
