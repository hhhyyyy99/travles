/**
 * TripPatch contracts (ticket 08) — the structured diff the planner agent
 * writes through `apply_trip_patch`, the ONLY way the model touches trip
 * data (spec Implementation Decisions; PRD §6 `TripPatch { ops: [...] }`).
 *
 * The write path lives in this NEW module on purpose: ticket 09 runs in a
 * parallel worktree over the same content/days-admin repos, so the patch
 * applier carries its own injectable store seam (`TripPatchStoreDriver`)
 * instead of extending those repos. Write calls issued by the applier (for
 * the ticket-09 merger to reconcile):
 *
 * - days:    upsert (id-keyed, explicit idx), delete (cascade items + legs)
 * - items:   upsert (id-keyed, incl. poi JSON + pending), delete
 * - legs:    upsert (adjacency placeholder rows, null distance), delete by item
 *
 * Patch vocabulary (PRD 附录 B plan round; forward-compatible with ticket 11
 * patch-explain — same tool behind a confirm step — and ticket 13 flows):
 *
 *   add_day     { dayId, date?, theme?, title?, note? }
 *   update_day  { dayId, date?, theme?, title?, note? }
 *   remove_day  { dayId }
 *   add_item    { itemId, dayId, order?, type, title, timeRange?, cost?, note?, pending?, poi?, legPending? }
 *   update_item { itemId, title?, timeRange?, cost?, note?, type?, pending?, poi?, legPending? }
 *   move_item   { itemId, dayId, order? }   (cross-day move + reorder)
 *   remove_item { itemId }
 *   add_stash   { stashId, title, note?, category?, poi? }
 *   move_stash_to_day { stashId, itemId, dayId, order?, type?, pending?, legPending?, timeRange?, cost? }
 *
 * `update_item` with type 'stay' covers PRD's UpdateStay; `move_item` with
 * the same dayId covers ReorderItem. Legs are NOT modeled explicitly: the
 * applier derives them from item adjacency (ticket 09 recomputes real
 * distances; this ticket writes placeholder rows with null distance so the
 * canvas stays structure-true without inventing numbers).
 */
import type { ActivityItemMetadata, Day } from '@hailar/domain'
import type { DayRow, ItemRow, LegQuality, LegRow } from '../days/types.js'
import type { DayScheduleUpdate } from '../trip-events/schedule.js'
import type { StashInsert, StashRow } from '../recommendations/types.js'
import type { TripSummary } from '../trips/types.js'

/** One POI reference on a card, derived from the shared patch validator. */
export type { PatchPoiRef } from '@hailar/domain'

export type TripPatchStats = {
  daysAdded: number
  daysUpdated: number
  daysRemoved: number
  itemsAdded: number
  itemsUpdated: number
  itemsRemoved: number
  legsWritten: number
  stashAdded?: number
  stashMoved?: number
}

/** The applied-patch record persisted on the assistant message (messages.applied_patch JSON). */
export type TripPatchRecord = {
  summary: string
  stats: TripPatchStats
  patch: unknown
}

/**
 * One pending patch-explain choice. The snapshot hash binds the user's chip
 * to the itinerary the assistant described; `consumePatchConfirmation` makes
 * the choice single-use even when two requests race.
 */
export type PatchConfirmationRecord = {
  token: string
  snapshotHash: string
  choices: string[]
  createdAt: string
}

/**
 * Upsert payload for one day row (every field server-validated).
 * Only explicitly supplied metadata is written; omission preserves stored values.
 */
export interface TripPatchDayUpsert extends Pick<Day, 'title' | 'note'> {
  id: string
  idx: number
  date: string
  theme: string
}

/** Item upsert: only explicitly supplied metadata is written, preserving omitted stored values. */
export interface TripPatchItemUpsert extends ActivityItemMetadata {
  id: string
  dayId: string
  itemOrder: number
  type: string
  title: string
  note: string
  /** JSON text or null (no POI / plain-text card). */
  poi: string | null
  /** Explicit image JSON for newly scheduled stash POIs; omission preserves existing images. */
  images?: string | null
  pending: boolean
}

/** Upsert payload for one leg row (adjacency placeholder; nulls = 待重算/待定). */
export interface TripPatchLegUpsert {
  id: string
  fromItemId: string
  toItemId: string
  mode: string
  distanceKm: number | null
  durationMin: number | null
  polyline: string | null
  quality?: LegQuality
  verifiedRouteKey?: string
}

/**
 * Write-side store seam for the patch applier (SQLite in production, an
 * in-memory driver in tests). Mirrors the tolerant row convention of the
 * other seams (snake_case rows, values `unknown`), but the write methods
 * take fully validated payloads.
 */
export interface TripPatchStoreDriver {
  /** Read the current Trip through this driver, including on a transaction-scoped instance. */
  getTripSummary?(tripId: string): Promise<TripSummary | null>
  listDayRows(tripId: string): Promise<DayRow[]>
  listItemRows(tripId: string): Promise<ItemRow[]>
  listLegRows(tripId: string): Promise<LegRow[]>
  /** Raw rows, including malformed/legacy metadata, for snapshot hashing. */
  listStashRows(tripId: string): Promise<StashRow[]>
  getStashTripId(stashId: string): Promise<string | null>
  insertStashRow(tripId: string, item: StashInsert): Promise<void>
  deleteStashRow(tripId: string, stashId: string): Promise<boolean>
  /** Return the owning trip for a globally keyed day id, or null when absent. */
  getDayTripId(dayId: string): Promise<string | null>
  /** Return the owning trip for a globally keyed item id, or null when absent. */
  getItemTripId(itemId: string): Promise<string | null>
  /** Run `fn` atomically: all reads/writes use the transaction-scoped driver. */
  withTransaction<T>(fn: (store: TripPatchStoreDriver) => Promise<T>): Promise<T>
  upsertDayRow(tripId: string, day: TripPatchDayUpsert): Promise<void>
  deleteDayRow(tripId: string, dayId: string): Promise<void>
  deleteItemsForDay(tripId: string, dayId: string): Promise<void>
  deleteItemsById(tripId: string, itemIds: string[]): Promise<void>
  upsertItemRow(tripId: string, item: TripPatchItemUpsert): Promise<void>
  upsertLegRow(tripId: string, leg: TripPatchLegUpsert): Promise<void>
  /** Delete every leg that references any of the given items (from OR to). */
  deleteLegsForItems(tripId: string, itemIds: string[]): Promise<void>
  /** Optional schedule repair shared with day-admin writes. */
  updateDaySchedule?(tripId: string, updates: DayScheduleUpdate[]): Promise<void>
  /** Read the unconsumed patch-explain choice for a trip, if one exists. */
  getPatchConfirmation(tripId: string): Promise<PatchConfirmationRecord | null>
  /** Replace the pending choice for a trip; saving a new explanation resets use. */
  savePatchConfirmation(tripId: string, record: PatchConfirmationRecord): Promise<void>
  /** Atomically consume a matching, unconsumed choice. */
  consumePatchConfirmation(tripId: string, token: string, snapshotHash: string): Promise<boolean>
}

/** Machine-readable failure class shared with the other repositories. */
export type TripPatchErrorCode = 'invalid' | 'not_found' | 'storage'

/** Raised by a driver when a globally keyed row belongs to another trip. */
export class TripPatchIdConflictError extends Error {
  constructor(
    public readonly entity: 'day' | 'item' | 'leg' | 'stash',
    public readonly id: string,
    public readonly ownerTripId: string,
  ) {
    super(`${entity} id "${id}" belongs to trip "${ownerTripId}"`)
    this.name = 'TripPatchIdConflictError'
  }
}

export type TripPatchApplyResult =
  | { ok: true; summary: string; stats: TripPatchStats; patch: unknown }
  | { ok: false; error: string; code: TripPatchErrorCode }
