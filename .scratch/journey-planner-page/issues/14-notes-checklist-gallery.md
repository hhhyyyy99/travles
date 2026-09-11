# 14: 便签、清单、图库

**What to build:** 画布左侧"工具"入口展开三个停靠面板：便签（自由文本）、清单（待办勾选，延续既有 checklist 能力与迁移数据）、图库（行程相册，聚合卡片图片与手动上传）。数据随行程持久化在服务端。

**Blocked by:** 04, 03。

**Status:** done (implemented on ticket/14-panels)

- [x] 三个面板可展开/收起，数据刷新后仍在
- [x] 清单勾选状态持久化，迁移的既有清单项可见可勾
- [x] 图库聚合展示卡片图片，支持手动上传
- [x] 便签多条管理（增删改）

## Implementation notes (ticket 14)

### API routes (new module `server/src/tools/`, mounted from app.ts with one hunk)

All routes 404 unknown trips (`{error:'行程不存在'}`), 400 invalid payloads, 500 on storage failure — same conventions as the ticket 02/03 routes.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/trips/:id/notes` | — | `{notes: [{id, content, createdAt, updatedAt}]}` |
| POST | `/api/trips/:id/notes` | `{content?}` (may be empty — add, then edit) | 201 `{note}` |
| PATCH | `/api/trips/:id/notes/:noteId` | `{content}` | `{note}` |
| DELETE | `/api/trips/:id/notes/:noteId` | — | `{ok:true}` |
| GET | `/api/trips/:id/checklist` | — | `{items: [{id, content, done, createdAt}]}` (includes migrated `legacy-checklist-*` rows) |
| POST | `/api/trips/:id/checklist` | `{content}` | 201 `{item}` |
| PATCH | `/api/trips/:id/checklist/:entryId` | `{done?}` and/or `{content?}` | `{item}` |
| DELETE | `/api/trips/:id/checklist/:entryId` | — | `{ok:true}` |
| GET | `/api/trips/:id/gallery` | — | `{images: [{id, itemId, url, caption, createdAt}]}` |
| POST | `/api/trips/:id/gallery` | `{url, caption?, itemId?}` | 201 `{image}` |
| DELETE | `/api/trips/:id/gallery/:imageId` | — | `{ok:true}` |

Notes cap 5000 chars, checklist content 500, caption 200, ids/timestamps are generated server-side (`crypto.randomUUID`).

### Gallery storage decision

Manual uploads are stored as **image data URLs in the existing `gallery.url` TEXT column** (schema from ticket 02, unchanged). Rationale: the simplest robust path — no filesystem, no extra table, identical behavior for the SQLite and in-memory drivers, and easy to mock at the route level. Server-side validation (`validateGalleryUrl`): only `data:image/{png,jpeg,jpg,gif,webp,avif,svg+xml};base64` payloads with a **decoded size ≤ 5 MB** (`MAX_UPLOAD_BYTES`) or `http(s)` URLs are accepted; the browser additionally pre-checks file type/size. A later ticket can switch to file/blob storage by changing only the stored URL values. Card images are **aggregated client-side** from the canvas data (`collectCardImages` in `src/domain/tools.ts`, deduplicated by URL) — they are not copied into the gallery table.

### Panel state persistence

The open panel (便签/清单/图库 or none) is remembered per trip in localStorage key **`journey-workbench-tools-v1`** (`src/domain/workbenchTools.ts`, same tolerant codec conventions as ticket 04's layout file but a separate key so the two codecs never fight over one entry).

### UI behavior

A slim "工具" rail on the canvas's left edge (`ToolsRail.tsx`, PRD F11) toggles a 300px docked panel (`ToolsPanel.tsx`) that **squeezes** the canvas horizontally; clicking the active tool or the panel's close button closes it. Checklist toggles are optimistic with rollback on failure; notes save on blur.

### Tests

- `server/tests/tools-repo.test.ts` — repository + memory driver (tolerant reads, validation caps, gallery URL rules).
- `server/tests/tools-api.test.ts` — HTTP via `app.request()` over the seeded SQLite file (CRUD, toggle of migrated rows, 404s, restart persistence).
- `tests/tools.test.ts` — API clients with stubbed fetch + pure helpers.
- `tests/workbench-tools.test.ts` — panel-state codec.
- `tests/app/11-tools.app.browser.cjs` — panels open/close + reload persistence, notes add/edit/delete, checklist toggle of migrated items, gallery card-image aggregation + upload (APIs mocked at route level with mutable in-memory state).

### Notes for ticket 16 (integration/polish)

- app.ts carries exactly one additive hunk for this ticket (imports + `toolsStore?` option + lazy store resolution + `mountToolsRoutes`); no content/trips repository files were touched.
- The tools store is resolved like ticket 04's workbench store: injected driver in tests, else lazily over the same SQLite database (`defaultDatabaseUrl()` / `TRIPS_DB_PATH`).
- Checklist rows are shared with the ticket-03 content module (same `checklist` table, upsert by id) — the legacy migration and this panel operate on the same rows.
- Gallery uploads are inline data URLs (≤5 MB): keep an eye on GET response size if trips accumulate large photos; the switch point is `ToolsRepository.addGalleryImage`/`validateGalleryUrl` plus the client's `fileToDataUrl`.
- The legacy checklist migration (ticket 03) only runs per browser; on fresh browsers the checklist starts empty — the panel handles both.
