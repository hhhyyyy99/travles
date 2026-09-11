# 09: 卡片编辑与交通段重算

**What to build:** 用户可以手动编辑行程：拖拽卡片在当天及跨列排序；卡片"⋯"菜单提供上移一位/下移一位/移动到（跨天）/复制到（跨天）/删除；每天列尾"+"与选中卡工具条"添加"新增卡片（支持搜索 POI 或自由文本）；卡片可添加图片、添加一句话备注。所有编辑乐观更新，交通段距离/时长与地图路线自动重算，失败自动回滚并提示；手动改动在会话流中留下轻量系统消息，保证 AI 上下文知晓最新行程。

**Blocked by:** 05。

**Status:** done

- [x] 拖拽排序当天生效，跨天拖拽生效，交通段与地图随之重算
- [x] 卡片菜单五种操作（上移/下移/移动到/复制到/删除）全部可用
- [x] 新增卡片支持 POI 搜索与纯文本两种方式
- [x] 编辑失败自动回滚并提示，无静默丢失
- [x] 手动编辑产生系统消息进入会话（AI 后续回复引用的是最新行程）
- [x] Playwright 测试覆盖拖拽与跨天移动的联动

## Implementation notes (ticket 09)

**Server** — new module `server/src/items-admin/` (repository + memory/SQLite
drivers + pure `legs.ts`), mounted in one additive hunk in `app.ts`:

- `POST /api/trips/:id/items` create (free text `poi:null` or searched POI)
- `POST /api/trips/:id/items/:itemId/move` reorder within / across days
  (`index` = FINAL position after removal, clamped; absent → append)
- `POST /api/trips/:id/items/:itemId/copy` duplicate into a day (new id, POI/images carried)
- `PATCH /api/trips/:id/items/:itemId` edit `title` / `note` / `images`
- `DELETE /api/trips/:id/items/:itemId` remove

Every layout mutation recomputes the whole trip's legs server-side and the
response carries the new legs, so the workbench map updates without a second
canvas read (spec 用户故事 40).

**Legs-recompute convention** (`items-admin/legs.ts`, unit-tested): legs join
adjacent items *within a day* (no cross-day legs). Rules in order: ① reuse a
stored leg for the same ordered pair verbatim; ② reuse a stored reversed-pair
leg's numbers/mode and flip the polyline; ③ estimate — haversine straight
line × 1.2 road factor, ~60 km/h ⇒ `durationMin ≈ km` (min 1), `polyline`
null; ④ no usable POI coords on both sides ⇒ `0/0` + null polyline (the UI
hides an empty chip). Ticket 15's route tools can upgrade estimates in place.

**System messages**: `ChatMessageRepository.recordSystemMessage(tripId, content)`
appends a tolerant, never-throwing `role:'system'` row to the `messages`
table after each successful manual edit; the chat history endpoint and panel
render system rows as muted center lines. Tickets 08/11/13 read these rows
for up-to-date AI context.

**Frontend**: `domain/workbench.ts` adds the item-write client plus pure
optimistic helpers (`applyItemMove/Insert/Remove/Patch/Replace`); every edit
applies locally first, adopts the response legs on success, and restores the
pre-edit snapshot + `[data-workbench-action-error]` banner on failure.
`CanvasColumn` adds HTML5 drag (cards + day drop zones), the ⋯ menu
(`CardMenu.tsx`, the accessible fallback), inline note edit / image-URL add
on the card, per-day trailing "+", and a toolbar "添加" on the selected card
(`AddCardDialog.tsx` — POI mode uses the existing `searchPlaces` service;
when the AMap SDK is unavailable the dialog degrades to free text with a
hint).

**New DOM hooks**: `data-card-menu-button={id}`, `data-card-menu`,
`data-menu-action={move-up|move-down|move-to|copy-to|add-image|edit-note|delete}`,
`data-day-picker` + `data-target-day={dayId}` + `data-action="cancel-day-picker"`,
`data-card-toolbar` + `data-action="toolbar-add-card"`, `data-action="add-card"`
+ `data-day-id` (day trailing "+"), `data-day-items={dayId}` (day drop zone),
`data-card-note-edit` / `data-card-note-input` / `data-action="save-note"`,
`data-card-image-input` / `data-action="confirm-image"`, and the add-card
dialog (`data-add-card-dialog`, `data-add-mode`, `data-add-day`,
`data-add-title`, `data-add-note`, `data-add-type`, `data-add-search`,
`data-action="add-search"`, `data-add-result`, `data-add-result-item`,
`data-action="add-confirm"`, `data-action="add-cancel"`, `data-add-error`).
`data-canvas-card` now also carries `draggable` + HTML5 drag handlers.
