# 06: 住宿基地管理与默认恢复迁移

**What to build:** 用户能够集中编辑与清理住宿基地，恢复单晚默认住宿，并保持所有相关晚次、摘要和路线一致。

**Blocked by:** 04

Status: resolved

- [x] React 管理界面区分使用中与备选基地，支持修改名称、位置、类型、地址及备注，沿用共享业务状态和 Tailwind 样式。
- [x] 修改共用基地后关联晚次、摘要、地图及相关路线同步更新；位置变化使旧估算失效，失败及乱序规则与手动添加一致。
- [x] 允许删除未使用的自定义基地；使用中基地必须先替换住宿，默认基地保持不可编辑删除的既有保护。
- [x] 支持单晚恢复默认，不误改其他晚次；恢复后的端点、统计和路线状态正确。
- [x] 操作成功后刷新保留；写入失败保留原有效安排并明确提示；键盘焦点和手机操作保持可用。
- [x] 以页面流程迁移现有管理测试，覆盖共用基地编辑、删除保护、备选删除、默认保护和单晚恢复；相关回归、类型检查与构建通过。



---

## Answer

Branch `ticket/06-accommodation-management` (commits 057878e, bc51f06 on merged baseline f464a57).

### Built

- `src/components/AccommodationManager.tsx` (new) — React port of `accommodation-manager.js`: dialog `#accommodation-manager-dialog` split into 正在使用 / 备选基地 / 默认住宿 / 每晚住宿 sections; per-base cards (`data-manager-base`, badge 正在使用/备选/默认住宿, meta `酒店 / 民宿|住宿区域 · address`, 代表位置 lat, lng, notes, 关联晚次 with per-night 恢复默认住宿). Inline editor `#accommodation-manager-editor` (编辑基地名称/编辑类型/编辑详细地址（选填）/编辑备注（选填）/编辑纬度/编辑经度, 保存修改/取消) — same fields and validation as create via domain `updateBase`; in-use delete blocked with the exact legacy message `该基地正在使用，请先替换第 N、M 晚住宿`; default bases have no edit/delete and show `默认住宿不可编辑或删除`; single-night restore removes only that night's override; exact legacy status strings (`修改会同步到所有关联晚次。` / `住宿基地已更新。` / `第 N 晚 · <date> <weekday>已恢复默认住宿。` / `住宿基地“X”已删除。` / `默认住宿不可编辑。`, `data-state` error|ok); confirm before delete like legacy.
- `src/components/AccommodationDialog.tsx` — `管理住宿基地` trigger button (`#accommodation-manager-open`, label matches the legacy entry's title) beside 新增住宿基地; the manager opens with the dialog closed (two modals never stack); `更换住宿` on used cards closes the manager and reopens the accommodation dialog for that night.
- `src/index.css` — port of accommodation-manager.css using the app's `--color-*` tokens + mobile (≤720px) rules.
- No route wiring was needed: the ticket-04 change listeners (`useAmapLive` accommodation subscription) already re-query `routeDays` from `updateBase`'s event (verified by the AMap-stub test asserting the new GCJ-02 endpoints on days {N,N+1}).
- `tests/app/06-manager.app.browser.cjs` (new, 6 tests) — shared-base edit propagates to all nights + stay-note + count + `路线未更新`/legend + reload persistence; AMap-stub re-query with edited coordinates; blocked in-use delete with exact message; restore → 备选 → alternate delete; default immutability + restore touches only that night + survives reload (seeded via evaluate+reload so the init script doesn't re-seed); keyboard/mobile (initial focus on close, editor focus on name, Escape close); write-failure exact string with draft kept and arrangement unchanged.

### Gates (npm cache passed explicitly)

- `npm run typecheck` → pass (0 errors)
- `npm run build` → pass (dist/app.html + assets)
- `npm test` → 44/44
- `npm run test:browser` → 20/20 (legacy untouched)
- `npm run test:app` → 43/43 (37 prior + 6 new)
- `npm run test:app:prod` → 43/43 (preview)

### Notes for ticket 09 (cutover)

- Legacy skins that must be removed/kept in sync at cutover: `accommodation-manager.js` + `accommodation-manager.css` become dead once the React app replaces trip.html — drop the legacy topbar entry `#manage-accommodation` (label 住宿基地) whose React counterpart is the `管理住宿基地` button inside `#accommodation-dialog`.
- React manager DOM ids intentionally reuse the legacy ids (`#accommodation-manager-*`, `data-manager-*`), so the ported manager interactions (`tests/app/06-manager…`) replace the legacy `tests/accommodation-manager.browser.cjs` scenarios 1:1.
- Restore label keeps the legacy quirk of no space before `已恢复默认住宿。` (`第 1 晚 · 10.02 周五已恢复默认住宿。`).
- Window `confirm` is used for delete (legacy behavior) — browser tests accept it via `page.on('dialog')`; if the cutover forbids native dialogs, swap to an in-dialog confirm and update the suite.
