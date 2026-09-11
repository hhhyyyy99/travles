# 07: 住宿备份与整体恢复迁移

**What to build:** 用户能导出住宿备份，预览并确认或取消恢复旧版及新版有效备份；恢复结果同步呈现在行程与路线中。

**Blocked by:** 04

Status: resolved

- [x] 提供不依赖尚未迁移管理页面的可访问备份入口，React 界面使用共享住宿状态；导出保持既有版本和数据格式兼容。
- [x] 导入在运行时校验版本、字段、坐标和晚次引用完整性，兼容旧有效备份，不以 TypeScript 静态类型代替校验。
- [x] 导入展示内容预览和整份替换说明，取消不写入，明确确认后整体恢复而非自动合并。
- [x] 无效文件、悬空引用和存储写入失败不破坏当前数据，并显示可理解反馈。
- [x] 恢复后住宿详情、统计、端点及相关路线同步更新，刷新保留；恢复之前的延迟响应不得恢复过期估算。
- [x] 通过页面操作、下载文件和持久化契约验证导出导入往返、旧备份、预览取消、无效拒绝、写入失败与恢复路线；不以旧全局业务对象驱动测试。
- [x] 沿用现有备份浏览器测试场景，相关回归、严格类型检查与生产构建通过。

## Answer

**Built.** Three commits on `ticket/07-accommodation-backup`:

1. `9423508` feat(domain): backup export payload `getBackup`/`backupFor` (part A) — legacy-compatible payload, all 6 overnight nights explicit, no `amapKey`.
2. `aaee9e5` feat(backup): `AccommodationBackupDialog` + shared-dialog entry `#accommodation-backup-open` inside `#accommodation-dialog` (part B) — DOM/aria contract matches legacy `accommodation-backup.js` buildUi; runtime `validateBackup` (versions/fields/coordinates/reference integrity, not TS types); preview + 确认整体替换 vs 取消; exact legacy feedback strings; Blob download `hailar-accommodation-v1-YYYYMMDD.json` (UTC date).
3. `0e43752` test(backup): `tests/app/07-backup.app.browser.cjs` — 7 scenarios (dev + preview): export→import round-trip via real download (`acceptDownloads` helper option) and upload; legacy-format (2-space JSON) import; preview→cancel writes nothing and resets file input; invalid JSON / unsupported version / dangling night reference rejected with exact strings, data intact; storage-write failure (`Storage.prototype.setItem` throws) shows `恢复失败：保存失败` and keeps page state; defaults-only restore returns every day to reference estimates (no stale `路线未更新`). Plus `waitForStatus` helper polling the async import handler (fixes the race reading status right after `setInputFiles`), and the greet status on the legacy open flow in the dialog.

**Commands + results** (all with `PLAYWRIGHT_CHROMIUM_EXECUTABLE=~/Library/Caches/ms-playwright/chromium-1228/.../Google Chrome for Testing`):

- `node --import tsx --test tests/app/07-backup.app.browser.cjs` → 7/7 pass
- `npm run typecheck` → pass
- `npm run build` → pass (dist 465 kB JS / 51.7 kB CSS)
- `npm test` → 46/46 pass
- `npm run test:browser` (legacy suites incl. `tests/accommodation-backup.browser.cjs`) → 20/20 pass
- `npm run test:app` (dev) → 44/44 pass
- `npm run test:app:prod` (preview) → 44/44 pass

**Notes for ticket 09 (integrate/cutover):** `tests/accommodation-backup.browser.cjs` (legacy manager-page suite) still runs green in `test:browser`; the 07 app suite is the migration-proof counterpart and can gate the cutover. `tests/helpers/vite-app.cjs` gained an optional `acceptDownloads` (default false — other suites unaffected). The shared accommodation dialog now hosts the backup entry, so the cutover must keep `#accommodation-backup-open` reachable from `#day-detail [data-accommodation-open]` (the app suite depends on it). Backup payload contract is frozen: `hailar-slow-trip-accommodation`/v1, 6 explicit nights, bases `{id,name,type,lat,lng,address,notes,createdAt}`.
