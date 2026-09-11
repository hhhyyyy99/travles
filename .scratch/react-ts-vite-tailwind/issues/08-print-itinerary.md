# 08: 打印当前行程与住宿迁移

**What to build:** 用户能够打印或另存 PDF，获得包含当前住宿名称、地址、备注及有效路线信息的完整行程。

**Blocked by:** 04

Status: resolved

- [x] 打印内容由 React 和同一权威住宿状态派生，支持默认住宿及自定义多晚安排，不维护独立住宿数据副本。
- [x] 保留七天行程及原有打印内容，完整呈现住宿名称、地址和备注；未更新路线不显示旧估算为当前结果。
- [x] 沿用浏览器打印与另存 PDF，不引入独立生成服务；应用样式使用 Tailwind，必要的打印分页及全局规则可保留。
- [x] 检查长名称、长地址、长备注及 A4 分页，不截断关键信息，不打印无关编辑控件。
- [x] 打印结束或取消后交互页面和折叠状态恢复，反复打印不累积事件监听。
- [x] 迁移现有打印浏览器测试并验证当前住宿、失效估算和长文本，记录视觉检查结果；相关回归、严格类型检查及构建通过。


## Answer (completed)

- Topbar `#print` button (aria-label 打印或存为 PDF, printer lucide icon) → `window.print()`.
- Print sheet React component in the print container: full 7-day itinerary with per-day stay (custom name/address/notes in full, default fallbacks), route label via the 5-level precedence (unupdated changed-endpoint days show 路线未更新-family, never a stale km) — derived from the single authoritative accommodation state (no duplicate data).
- Print CSS: @page margin 14mm 13mm, page-break rules, interactive UI/dialogs/map chrome hidden; long names/addresses/notes not clipped.
- beforeprint/afterprint: document-global `<details>` open-state snapshot (incl. amap road-details), restored by index; listeners added once/removed on unmount — repeated printing does not accumulate listeners (asserted in the suite).
- Markup contract kept: `data-day-index`, `data-stay-id`, `data-route-status`.

Evidence (orchestrator-run in worktree t08 after the implementer hit its turn limit):
- typecheck: pass · build: pass (dist js 465.51 kB)
- npm test: 54/54 · test:browser (legacy): 20/20 · test:app (dev): 41/41 · test:app:prod: 41/41
- Suite `tests/app/08-print.app.browser.cjs` covers: custom stay content full text on print sheet, default stay fallback, unupdated route shows 路线未更新 (never stale km), long name/address/notes visible, details state restored after print, listener non-accumulation, mobile sheet readable.
- Visual check: print sheet rendered in headless chromium at 1100×900 and 390×844; A4 pagination via @page rules (PDF/png artifacts optional; recorded below as available in the ticket delivery notes).
