/**
 * Trip content contracts (ticket 03 — days / items / checklist storage for
 * the seeded example trip and the legacy-data migration; the workbench write
 * paths in tickets 04/08 build on this seam).
 *
 * Mirrors the trips seam (src/trips/types.ts): a low-level injectable driver
 * with snake_case rows mapped 1:1 onto SQLite columns, values `unknown` so
 * corrupt rows are representable, and a tolerant repository layer on top
 * (容错读取、永不 throw). `TripStoreDriver` stays trips-only; content storage
 * lives behind its own interface so the two evolve independently.
 */

import type { Day } from '@hailar/domain'

/** Raw days-table row; values unknown so corrupt storage can be represented. */
export interface DayRow {
  id: unknown
  trip_id: unknown
  idx: unknown
  date: unknown
  theme: unknown
  color: unknown
}

/** Raw items-table row. `poi` / `images` stay opaque JSON-text columns. */
export interface ItemRow {
  id: unknown
  trip_id: unknown
  day_id: unknown
  item_order: unknown
  type: unknown
  title: unknown
  note: unknown
  poi: unknown
  images: unknown
  pending: unknown
}

/** Raw checklist-table row. */
export interface ChecklistRow {
  id: unknown
  trip_id: unknown
  content: unknown
  done: unknown
  created_at: unknown
}

/** Upsert payload; every field is a server-validated value (not unknown). */
export interface ItemUpsert {
  id: string
  dayId: string
  itemOrder: number
  type: string
  title: string
  note: string
  poiJson?: string | null
  pending?: boolean
}

export interface ChecklistUpsert {
  id: string
  content: string
  done: boolean
}

export interface ContentStoreDriver {
  listDayRows(tripId: string): Promise<DayRow[]>
  listItemRows(tripId: string): Promise<ItemRow[]>
  listChecklistRows(tripId: string): Promise<ChecklistRow[]>
  /**
   * Upsert an item row. The day must belong to `tripId`; implementations
   * throw (or report via `dayExists`) when it does not — the repository
   * translates that into {ok:false}.
   */
  dayExists(tripId: string, dayId: string): Promise<boolean>
  upsertItemRow(tripId: string, item: ItemUpsert): Promise<void>
  upsertChecklistRow(tripId: string, entry: ChecklistUpsert): Promise<void>
}

/** Machine-readable failure class shared with the trips repository. */
export type ContentErrorCode = 'invalid' | 'not_found' | 'storage'

export type ContentWriteResult = { ok: true } | { ok: false; error: string; code: ContentErrorCode }

/** Tolerant mapped shapes served over HTTP. */
export interface ItemContent {
  id: string
  dayId: string
  itemOrder: number
  type: string
  title: string
  note: string
  pending: boolean
  poi?: unknown
}

export interface DayContent extends Pick<Day, 'tripId' | 'dayNumber'> {
  id: string
  idx: number
  date: string
  theme: string
  color: string
  items: ItemContent[]
}

export interface ChecklistEntry {
  id: string
  content: string
  done: boolean
  createdAt: string
}
