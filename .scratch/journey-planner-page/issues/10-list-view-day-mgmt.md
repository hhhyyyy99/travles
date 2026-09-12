# 10: 列表视图与天级管理

**What to build:** 中栏支持画布/列表双视图切换。列表视图：顶部日期 tab 切换天，单日纵向时间线（住宿行、交通段行、卡片）；天签行提供编辑主题入口、增删天。画布视图同步支持天主题编辑与增删天。

**Blocked by:** 04。

**Status:** resolved

- [x] 画布/列表切换，两视图渲染同一份服务端数据
- [x] 列表视图日期 tab 切换、纵向时间线渲染正确
- [x] 天主题可编辑；天可增删（删天有确认，含卡一并删除）
- [x] 两视图切换状态按行程记忆

## Answer

Implemented the list timeline, canvas/list toggle, day theme editing, add and
delete flows, confirmation UI, per-trip view persistence, and incoming
cross-day transfer rows. Final evidence is in the [shared acceptance report](../acceptance.md):
149 frontend and 180 server tests passed, with both dev and preview browser
sweeps at 113/113.

## Implementation notes

### Server (additive module `server/src/days-admin/`)

- `types.ts` — `DaysAdminStoreDriver` write seam (reuses the tolerant
  snake_case `DayRow` from `days/types.ts`), `AdminDay` response shape.
- `repository.ts` — `DaysAdminRepository.createDay / updateDay / deleteDay`;
  same convention as the other repos: `{ok:true,…} | {ok:false,error,code}`,
  driver failures → `storage`, never throws. createDay computes
  `idx = max+1` and `date = latest dated day + 1` (or `''` when the trip has
  no dated days); deleteDay cascades items AND legs touching them.
- `driver-memory.ts` / `driver-sqlite.ts` — in-memory + SQLite drivers over
  the existing days/items/legs tables (no schema changes).

### New API routes (registered in one sectioned hunk in `server/src/app.ts`)

| Route | Purpose |
| --- | --- |
| `POST /api/trips/:id/days` | Create a day (body optional; `{date?,theme?,color?}`); returns `{day}` 201 (canvas-day shape, `items: []`). |
| `PATCH /api/trips/:id/days/:dayId` | Update theme/color; returns `{day}`. |
| `DELETE /api/trips/:id/days/:dayId` | Delete the day with its items + legs; returns `{ok:true, removedItems}`. |

Injection: `createApp({ daysAdminStore })` (memory for tests); default
resolves a SQLite store over the same database the trip repository opens.

### Frontend

- `src/domain/workbench.ts` — `createWorkbenchDay / updateWorkbenchDay /
  deleteWorkbenchDay` (injectable FetchLike, `{ok,…}` results, never throws).
- `src/domain/workbenchLayout.ts` — `TripLayout.view: 'canvas' | 'list'`
  added to the `journey-workbench-layout-v1` codec (+`setWorkbenchView`);
  the center view choice is remembered per trip; old files without the
  field degrade to `canvas`.
- `src/components/workbench/WorkbenchPage.tsx` — 画布/列表 toggle in the
  center toolbar; owns day add/theme-save/delete with optimistic updates
  and rollback on failure (error surfaced via `[data-workbench-action-error]`);
  delete runs through a confirm dialog that names the card count
  (`src/components/workbench/ConfirmDialog.tsx`).
- `src/components/workbench/CanvasColumn.tsx` — day header now has inline
  theme edit + delete; trailing `+ 添加天` button; `CanvasCard` exported for
  reuse.
- `src/components/workbench/ListViewColumn.tsx` (new) — date tabs
  (`[data-list-tab]`, `+` add tab), single-day vertical timeline: 天签行
  (theme edit + delete), 住宿行 (`[data-list-stay]`), 交通段行
  (`[data-list-leg]`), cards reuse the canvas `CanvasCard`.
- `src/components/workbench/EditableTheme.tsx` (new) — shared inline theme
  editor used by both views (Enter saves / Escape cancels).

### Tests

- `server/tests/days-admin-api.test.ts` — repo unit coverage (next idx/date,
  validation, cascade delete, storage failures) + HTTP tests via
  `app.request()` + SQLite round trip read back through the canvas API.
- `tests/workbench-list-view.test.ts` — client codecs + layout view memory.
- `tests/app/11-list-view.app.browser.cjs` — browser suite with stateful
  /api mocks: view toggle + reload memory, tab switching + timeline
  rendering, inline theme edit, day add (next date, auto-select), day
  delete with confirm.
- Existing `tests/workbench-layout.test.ts` literals gained the
  `view: 'canvas'` field (mechanical, no assertions weakened).
