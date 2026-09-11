/**
 * Day-admin write contracts (ticket 10) — create / theme-update / cascade-
 * delete for workbench days, the write counterpart of the read-only
 * server/src/days store (which stays untouched).
 *
 * ADDITIVE by design: no schema changes (the days/items/legs tables from
 * ticket 02 already carry everything), no imports from the trips module.
 * The driver reuses the snake_case `DayRow` shape from days/types.ts so the
 * same tolerant row convention applies (values unknown, corrupt rows
 * representable, reads never throw).
 *
 * Repository convention (mirrors src/domain/storage.ts via TripRepository):
 * - Writes return {ok:true, …} | {ok:false, error, code} — the HTTP layer
 *   maps `invalid` → 400, `not_found` → 404, `storage` → 500.
 * - Deleting a day cascades: its items go with it, and legs that reference
   * those items are removed too (the legs table has no FK on items, so the
   * driver performs the cleanup explicitly).
 */
import type { DayRow } from '../days/types.js'

/** Validated insert payload (every field a server-checked value). */
export interface DayInsert {
  id: string
  tripId: string
  idx: number
  date: string
  theme: string
  color: string
}

/** Theme/color patch; only the fields the caller sent are present. */
export interface DayThemePatch {
  theme?: string
  color?: string
}

/**
 * Raw patch off the request body (values unvalidated); the repository
 * coerces/rejects before anything reaches a driver.
 */
export interface DayThemeInput {
  theme?: unknown
  color?: unknown
}

/** Write-side driver seam (SQLite in production, in-memory in tests). */
export interface DaysAdminStoreDriver {
  listDayRows(tripId: string): Promise<DayRow[]>
  getDayRow(dayId: string): Promise<DayRow | null>
  insertDayRow(row: DayInsert): Promise<void>
  updateDayRow(dayId: string, patch: DayThemePatch): Promise<void>
  /** Item ids currently attached to the day (for the cascade bookkeeping). */
  listItemIdsForDay(dayId: string): Promise<string[]>
  /** Delete legs whose from/to item belongs to the day. */
  deleteLegsForDay(dayId: string): Promise<void>
  /** Delete the day's items. */
  deleteItemsForDay(dayId: string): Promise<void>
  /** Delete the day row itself. */
  deleteDayRow(dayId: string): Promise<void>
}

/** Machine-readable failure class shared with the other repositories. */
export type DaysAdminErrorCode = 'invalid' | 'not_found' | 'storage'

/** The day shape the HTTP layer returns (canvas-day parity, items omitted). */
export interface AdminDay {
  id: string
  index: number
  date: string
  theme: string
  color: string
  items: []
}

export type DayWriteResult =
  | { ok: true; day: AdminDay }
  | { ok: false; error: string; code: DaysAdminErrorCode }

export type DayDeleteResult =
  | { ok: true; removedItems: number }
  | { ok: false; error: string; code: DaysAdminErrorCode }
