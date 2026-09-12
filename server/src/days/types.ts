/**
 * Workbench read contracts (ticket 04) — canonical Day / Item / Leg JSON
 * shapes the canvas renders, plus the injectable read-only driver seam.
 *
 * This module is ADDITIVE on purpose (ticket 03 extends the repo with
 * day/item WRITE APIs in parallel): it never touches
 * server/src/trips/repository.ts or server/src/db/schema.ts. It only issues
 * its own SELECTs through the same SqlDatabase seam that ticket 02 opened,
 * against the tables that schema.ts already created.
 *
 * Canonical shapes (aligned with PRD §6, item vocabulary per ticket 04):
 *
 *   Day  { id, index, date, theme, color, items: Item[] }
 *   Item { id, dayId, order, type: 'traffic'|'stay'|'attraction'|'food'|'other',
 *          title, note, poi: PoiRef | null, images: { url, caption }[], pending }
 *   Leg  { id, fromItemId, toItemId, mode, distanceKm, durationMin, polyline }
 *
 * `poi === null` marks the 无 POI 纯文本卡 (plain-text card). Legs connect
 * adjacent items; the canvas renders a leg chip between the two matching
 * cards. Rows stay snake_case `unknown` (1:1 with the SQLite columns) so the
 * repository can survive corrupt rows (容错读取、永不 throw).
 */

export type ItemType = 'traffic' | 'stay' | 'attraction' | 'food' | 'other'

/** Provenance of the distance/time shown for a leg. */
export type LegQuality = 'reference' | 'estimate' | 'measured' | 'pending'

export type PoiRef = {
  amapId: string
  name: string
  lat: number
  lng: number
  address?: string
  accommodationBaseId?: string
  accommodationType?: 'area' | 'hotel'
  accommodationNotes?: string
  accommodationMigrationVersion?: number
  category: string
  rating: number
  introSummary: string
}

export type ItemImage = { url: string; caption: string }

export type CanvasItem = {
  id: string
  dayId: string
  order: number
  type: ItemType
  title: string
  note: string
  poi: PoiRef | null
  images: ItemImage[]
  pending: boolean
}

export type CanvasDay = {
  id: string
  index: number
  date: string
  theme: string
  color: string
  items: CanvasItem[]
}

export type CanvasLeg = {
  id: string
  fromItemId: string
  toItemId: string
  mode: string
  distanceKm: number
  durationMin: number
  polyline: [number, number][] | null
  /** Optional for old callers; read mappers infer it when storage is blank. */
  quality?: LegQuality
}

export type TripCanvas = {
  days: CanvasDay[]
  legs: CanvasLeg[]
}

/** Raw driver rows (values unknown so corrupt storage can be represented). */
export interface DayRow {
  id: unknown
  trip_id: unknown
  idx: unknown
  date: unknown
  theme: unknown
  color: unknown
}

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

export interface LegRow {
  id: unknown
  trip_id: unknown
  from_item_id: unknown
  to_item_id: unknown
  mode: unknown
  distance_km: unknown
  duration_min: unknown
  polyline: unknown
  quality?: unknown
}

/** Read-only driver seam (SQLite in production, in-memory in tests). */
export interface WorkbenchStoreDriver {
  listDayRows(tripId: string): Promise<DayRow[]>
  listItemRows(tripId: string): Promise<ItemRow[]>
  listLegRows(tripId: string): Promise<LegRow[]>
}
