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

export type {
  ItemType,
  LegQuality,
  PoiRef,
  ItemImage,
  ActivityItem as CanvasItem,
  Day as CanvasDay,
  Leg as CanvasLeg,
  TripCanvas,
} from '@hailar/domain'

import type { DayMetadataInput } from './metadata.js'

/** Raw driver rows (values unknown so corrupt storage can be represented). */
export interface DayRow extends DayMetadataInput {
  id: unknown
  trip_id: unknown
  idx: unknown
  date: unknown
  theme: unknown
  color: unknown
}

export interface ActivityItemMetadataRow {
  time_range?: unknown
  cost?: unknown
}

export interface ItemRow extends ActivityItemMetadataRow {
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
