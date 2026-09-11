/**
 * Tools-panel contracts (ticket 14 — notes / checklist / gallery storage for
 * the dockable canvas-side panels).
 *
 * Mirrors the content seam (server/src/content/types.ts): a low-level
 * injectable driver with snake_case rows mapped 1:1 onto SQLite columns,
 * values `unknown` so corrupt rows are representable, and a tolerant
 * repository layer on top (容错读取、永不 throw).
 *
 * The module is fully self-contained on purpose: app.ts mounts it with a
 * single hunk (parallel tickets 06/10 also edit app.ts), and the checklist
 * SQL here lives alongside the content module's (both upsert by row id into
 * the same `checklist` table, so the ticket-03 migration rows —
 * `legacy-checklist-0..5` — are visible and toggleable here too).
 */

/** Raw notes-table row. */
export interface NoteRow {
  id: unknown
  trip_id: unknown
  content: unknown
  created_at: unknown
  updated_at: unknown
}

/**
 * Checklist rows share the ticket-03 `checklist` table exactly; the shape is
 * redeclared (not imported) so this module stays independent of content.
 */
export interface ChecklistRow {
  id: unknown
  trip_id: unknown
  content: unknown
  done: unknown
  created_at: unknown
}

/** Raw gallery-table row. `url` holds an http(s) URL or an image data URL. */
export interface GalleryRow {
  id: unknown
  trip_id: unknown
  item_id: unknown
  url: unknown
  caption: unknown
  created_at: unknown
}

/** Fully-validated insert payloads (repository generates ids + timestamps). */
export interface NoteInsert {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

export interface ChecklistInsert {
  id: string
  content: string
  done: boolean
  createdAt: string
}

export interface GalleryInsert {
  id: string
  itemId: string | null
  url: string
  caption: string
  createdAt: string
}

/** Sparse update patch; only the listed fields change. */
export interface ChecklistPatch {
  content?: string
  done?: boolean
}

/**
 * Injectable driver seam (SQLite in production, in-memory in tests). Update/
 * delete methods return false when the row is missing — the repository maps
 * that to {ok:false, code:'not_found'}.
 */
export interface ToolsStoreDriver {
  listNoteRows(tripId: string): Promise<NoteRow[]>
  insertNoteRow(tripId: string, note: NoteInsert): Promise<void>
  updateNoteRow(tripId: string, noteId: string, content: string, updatedAt: string): Promise<boolean>
  deleteNoteRow(tripId: string, noteId: string): Promise<boolean>
  listChecklistRows(tripId: string): Promise<ChecklistRow[]>
  insertChecklistRow(tripId: string, entry: ChecklistInsert): Promise<void>
  updateChecklistRow(tripId: string, entryId: string, patch: ChecklistPatch): Promise<boolean>
  deleteChecklistRow(tripId: string, entryId: string): Promise<boolean>
  listGalleryRows(tripId: string): Promise<GalleryRow[]>
  insertGalleryRow(tripId: string, image: GalleryInsert): Promise<void>
  deleteGalleryRow(tripId: string, imageId: string): Promise<boolean>
}

/** Machine-readable failure class shared with the other repositories. */
export type ToolsErrorCode = 'invalid' | 'not_found' | 'storage'

export type ToolsWriteResult = { ok: true } | { ok: false; error: string; code: ToolsErrorCode }

export type ToolsReadResult<T> = { ok: true; value: T } | { ok: false; error: string; code: ToolsErrorCode }

/** Tolerant mapped shapes served over HTTP. */
export interface NoteContent {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

export interface ChecklistEntryContent {
  id: string
  content: string
  done: boolean
  createdAt: string
}

export interface GalleryImageContent {
  id: string
  itemId: string | null
  url: string
  caption: string
  createdAt: string
}
