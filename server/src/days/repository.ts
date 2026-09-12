/**
 * Workbench read repository (ticket 04) — tolerant normalization of raw
 * day/item/leg rows into the canonical TripCanvas shape (spec 测试接缝 #2
 * convention: reads NEVER throw; corrupt rows degrade and get dropped, the
 * same codec convention as src/domain/storage.ts and the trips repository).
 */
import { asText } from '../trips/dates.js'
import type {
  CanvasDay,
  CanvasItem,
  CanvasLeg,
  DayRow,
  ItemImage,
  ItemType,
  ItemRow,
  LegRow,
  LegQuality,
  PoiRef,
  TripCanvas,
  WorkbenchStoreDriver,
} from './types.js'

const ITEM_TYPES: ItemType[] = ['traffic', 'stay', 'attraction', 'food', 'other']

/** Tolerant whole-trip canvas read; a failing driver → empty canvas. */
export async function readTripCanvas(driver: WorkbenchStoreDriver, tripId: string): Promise<TripCanvas> {
  let dayRows: DayRow[]
  let itemRows: ItemRow[]
  let legRows: LegRow[]
  try {
    ;[dayRows, itemRows, legRows] = await Promise.all([
      driver.listDayRows(tripId),
      driver.listItemRows(tripId),
      driver.listLegRows(tripId),
    ])
  } catch {
    return { days: [], legs: [] }
  }
  return assembleCanvas(dayRows, itemRows, legRows)
}

/**
 * Pure assembly (unit-testable): maps rows through tolerant coercion, groups
 * items under their day, and sorts days by idx / items by order. Legs that
 * reference unknown items are dropped.
 */
export function assembleCanvas(dayRows: DayRow[], itemRows: ItemRow[], legRows: LegRow[]): TripCanvas {
  const itemsByDay = new Map<string, CanvasItem[]>()
  const itemIds = new Set<string>()
  for (const row of itemRows) {
    const item = mapItemRow(row)
    if (item === null) continue
    itemIds.add(item.id)
    const bucket = itemsByDay.get(item.dayId)
    if (bucket) bucket.push(item)
    else itemsByDay.set(item.dayId, [item])
  }
  for (const bucket of itemsByDay.values()) {
    bucket.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  }

  const days = dayRows
    .map((row) => mapDayRow(row, itemsByDay.get(asText(row?.id)) ?? []))
    .filter((day): day is CanvasDay => day !== null)
    .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))

  const legs = legRows
    .map((row) => mapLegRow(row))
    .filter((leg): leg is CanvasLeg => leg !== null)
    .filter((leg) => itemIds.has(leg.fromItemId) && itemIds.has(leg.toItemId))

  return { days, legs }
}

/** 容错 day row → CanvasDay; null = unusable row (dropped). */
export function mapDayRow(row: DayRow, items: CanvasItem[]): CanvasDay | null {
  const id = asText(row?.id)
  if (!id) return null
  return {
    id,
    index: asNonNegativeNumber(row?.idx),
    date: asDateString(row?.date),
    theme: asText(row?.theme),
    color: asText(row?.color),
    items,
  }
}

/** 容错 item row → CanvasItem; null = unusable row (dropped). */
export function mapItemRow(row: ItemRow): CanvasItem | null {
  const id = asText(row?.id)
  const dayId = asText(row?.day_id)
  if (!id || !dayId) return null
  const type = asText(row?.type) as ItemType
  return {
    id,
    dayId,
    order: asNonNegativeNumber(row?.item_order),
    type: ITEM_TYPES.includes(type) ? type : 'other',
    title: asText(row?.title),
    note: asText(row?.note),
    poi: mapPoiRef(row?.poi),
    images: mapImages(row?.images),
    pending: row?.pending === true || row?.pending === 1,
  }
}

/** 容错 leg row → CanvasLeg; null = unusable row (dropped). */
export function mapLegRow(row: LegRow): CanvasLeg | null {
  const id = asText(row?.id)
  const fromItemId = asText(row?.from_item_id)
  const toItemId = asText(row?.to_item_id)
  if (!id || !fromItemId || !toItemId) return null
  const distanceKm = asNonNegativeNumber(row?.distance_km)
  const durationMin = asNonNegativeNumber(row?.duration_min)
  const polyline = mapPolyline(row?.polyline)
  return {
    id,
    fromItemId,
    toItemId,
    mode: asText(row?.mode) || 'drive',
    distanceKm,
    durationMin,
    polyline,
    quality: normalizeLegQuality(row?.quality, distanceKm, durationMin, polyline),
  }
}

/** Infer provenance for databases created before `legs.quality` existed. */
export function normalizeLegQuality(
  value: unknown,
  distanceKm: number,
  durationMin: number,
  polyline: [number, number][] | null,
): LegQuality {
  if (value === 'reference' || value === 'estimate' || value === 'measured' || value === 'pending') return value
  if (distanceKm <= 0 && durationMin <= 0) return 'pending'
  return polyline === null ? 'estimate' : 'measured'
}

/**
 * PoiRef JSON column → PoiRef | null. Null means "no POI" — the plain-text
 * card form (无 POI 纯文本卡); corrupt JSON also degrades to null rather
 * than dropping the whole item.
 */
export function mapPoiRef(value: unknown): PoiRef | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const name = asText(record.name)
  if (!name) return null
  const location = record.location !== null && typeof record.location === 'object'
    ? (record.location as Record<string, unknown>)
    : {}
  return {
    amapId: asText(record.amapId),
    name,
    // Workbench writes the canonical flat PoiRef shape. Keep accepting the
    // older nested `location` form so cards created before ticket 09 remain
    // readable after a recommendation is scheduled.
    lat: asFiniteNumber(location.lat ?? record.lat),
    lng: asFiniteNumber(location.lng ?? record.lng),
    ...(asText(record.address) ? { address: asText(record.address) } : {}),
    category: asText(record.category),
    rating: asFiniteNumber(record.rating),
    introSummary: asText(record.introSummary),
  }
}

/** Images JSON column → [{url, caption}]; entries without a URL are dropped. */
export function mapImages(value: unknown): ItemImage[] {
  if (typeof value !== 'string' || value.trim() === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>
      const url = asText(record.url)
      return url ? { url, caption: asText(record.caption) } : null
    })
    .filter((entry): entry is ItemImage => entry !== null)
}

/** Polyline JSON column → [[lng,lat],…]; unusable values → null. */
export function mapPolyline(value: unknown): [number, number][] | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const points: [number, number][] = []
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const lng = Number(entry[0])
    const lat = Number(entry[1])
    if (Number.isFinite(lng) && Number.isFinite(lat)) points.push([lng, lat])
  }
  return points.length > 0 ? points : null
}

function asNonNegativeNumber(value: unknown): number {
  return asFiniteNumber(value)
}

function asFiniteNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

/** Dates degrade to '' when unusable — the canvas renders a bare day column. */
function asDateString(value: unknown): string {
  const text = asText(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : ''
}
