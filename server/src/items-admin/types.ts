/**
 * Item-admin write contracts (ticket 09) — card move/copy/create/update/
 * delete with server-side legs recompute, the write counterpart of the
 * read-only days store and the day-admin module (ticket 10).
 *
 * ADDITIVE by design: no schema changes (the days/items/legs tables from
 * ticket 02 carry everything), no imports from the trips module. Raw rows
 * reuse the snake_case shapes from days/types.ts; the write payload carries
 * the JSON-text columns (`poi` / `images`) the content upsert (ticket 03)
 * leaves null, so card copies and POI cards survive round trips.
 *
 * Repository convention (mirrors DaysAdminRepository / TripContentRepository):
 * - Writes return {ok:true, …} | {ok:false, error, code} — the HTTP layer
 *   maps `invalid` → 400, `not_found` → 404, `storage` → 500.
 * - Every layout mutation (move/copy/create/delete) re-derives the trip's
 *   legs via items-admin/legs.ts and replaces them in one driver call, and
 *   the response carries the new leg list so clients update the map without
 *   a second read.
 */
import type { ActivityItemMetadata } from '@hailar/domain'
import type { CanvasItem, CanvasLeg, DayRow, ItemRow, LegRow } from '../days/types.js'
import type { PlannedLeg } from './legs.js'

/** Full item row the driver upserts (poi/images as serialized JSON text). */
export interface ItemFullUpsert extends ActivityItemMetadata {
  id: string
  dayId: string
  itemOrder: number
  type: string
  title: string
  note: string
  poiJson: string | null
  imagesJson: string | null
}

/** Position-only patch (reordering never rewrites title/poi/… columns). */
export interface ItemOrderPatch {
  id: string
  dayId: string
  itemOrder: number
}

/** Write-side driver seam (SQLite in production, in-memory in tests). */
export interface ItemsAdminStoreDriver {
  listDayRows(tripId: string): Promise<DayRow[]>
  listItemRows(tripId: string): Promise<ItemRow[]>
  listLegRows(tripId: string): Promise<LegRow[]>
  dayExists(tripId: string, dayId: string): Promise<boolean>
  getItemRow(itemId: string): Promise<ItemRow | null>
  /** Run a layout mutation atomically; the callback receives the scoped driver. */
  withTransaction<T>(fn: (store: ItemsAdminStoreDriver) => Promise<T>): Promise<T>
  upsertItemFull(tripId: string, item: ItemFullUpsert): Promise<void>
  /** Batch-rewrite day/order columns; rows outside the trip are ignored. */
  updateItemOrders(tripId: string, orders: ItemOrderPatch[]): Promise<void>
  deleteItemRow(tripId: string, itemId: string): Promise<void>
  /** Atomically replace the trip's leg rows with the recomputed set. */
  replaceLegs(tripId: string, legs: PlannedLeg[]): Promise<void>
}

/** Machine-readable failure class shared with the other repositories. */
export type ItemsAdminErrorCode = 'invalid' | 'not_found' | 'storage'

/** Result of a layout mutation: the affected item + the recomputed legs. */
export type ItemMutationResult =
  | { ok: true; item: CanvasItem; legs: CanvasLeg[] }
  | { ok: false; error: string; code: ItemsAdminErrorCode }

/** Result of a field edit (title/note/images); legs are unaffected. */
export type ItemUpdateResult =
  | { ok: true; item: CanvasItem }
  | { ok: false; error: string; code: ItemsAdminErrorCode }

/** Result of a card delete; the response carries the recomputed legs. */
export type ItemDeleteResult =
  | { ok: true; legs: CanvasLeg[] }
  | { ok: false; error: string; code: ItemsAdminErrorCode }

/** Raw move/copy payloads off the request body (values unvalidated). */
export interface ItemMoveInput {
  dayId?: unknown
  index?: unknown
}
