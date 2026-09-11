/**
 * Workbench canvas API client + pure view helpers (ticket 04).
 *
 * Same codec convention as src/domain/tripList.ts: tolerant reads that never
 * throw, an injectable FetchLike for Node tests, and `{ok:true,data} |
 * {ok:false,error}` results the caller surfaces verbatim.
 *
 * Canonical read shapes (mirror of server/src/days/types.ts — the server
 * normalizes DB rows into these; the client re-normalizes defensively):
 *
 *   Day  { id, index, date, theme, color, items: Item[] }
 *   Item { id, dayId, order, type: 'traffic'|'stay'|'attraction'|'food'|'other',
 *          title, note, poi: PoiRef | null, images: {url, caption}[], pending }
 *   Leg  { id, fromItemId, toItemId, mode, distanceKm, durationMin, polyline }
 */

import type { ApiResult, FetchLike, TripSummary } from './tripList'
import { defaultFetch, normalizeTrip } from './tripList'

export type ItemType = 'traffic' | 'stay' | 'attraction' | 'food' | 'other'

export type PoiRef = {
  amapId: string
  name: string
  lat: number
  lng: number
  category: string
  rating: number
  introSummary: string
}

export type ItemImage = { url: string; caption: string }

export type WorkbenchItem = {
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

export type WorkbenchDay = {
  id: string
  index: number
  date: string
  theme: string
  color: string
  items: WorkbenchItem[]
}

export type WorkbenchLeg = {
  id: string
  fromItemId: string
  toItemId: string
  mode: string
  distanceKm: number
  durationMin: number
  /** WGS-84 [lng, lat][] driving geometry from the server; null → straight-line fallback. */
  polyline: [number, number][] | null
}

export type TripCanvasData = {
  trip: TripSummary
  days: WorkbenchDay[]
  legs: WorkbenchLeg[]
}

export const CANVAS_NETWORK_ERROR = '无法连接服务器，请确认后端服务已启动。'

/**
 * GET /api/trips/:id/canvas — read-only days/items/legs for the canvas.
 * Never throws; unparseable entries are dropped.
 */
export async function fetchTripCanvas(
  tripId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<TripCanvasData>> {
  let response: Response
  try {
    response = await fetchLike(`/api/trips/${encodeURIComponent(tripId)}/canvas`)
  } catch {
    return { ok: false, error: CANVAS_NETWORK_ERROR }
  }
  if (!response.ok) {
    const message = ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error
    return { ok: false, error: typeof message === 'string' && message ? message : `请求失败（HTTP ${response.status}）` }
  }
  const payload = (await response.json().catch(() => null)) as
    | { trip?: unknown; days?: unknown; legs?: unknown }
    | null
  if (!payload) return { ok: false, error: '服务器返回的数据无法解析。' }
  const trip = normalizeTrip(payload.trip)
  if (trip === null) return { ok: false, error: '服务器返回的行程数据无法解析。' }
  const days = Array.isArray(payload.days) ? payload.days : []
  const legs = Array.isArray(payload.legs) ? payload.legs : []
  return {
    ok: true,
    data: {
      trip,
      days: days.map(normalizeDay).filter((day): day is WorkbenchDay => day !== null),
      legs: legs.map(normalizeLeg).filter((leg): leg is WorkbenchLeg => leg !== null),
    },
  }
}

/** Pure: weekday label ("周五") for a YYYY-MM-DD date; '' when unusable. */
export function weekdayLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  const utc = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(utc)) return ''
  const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return WEEKDAY_LABELS[new Date(utc).getUTCDay()] ?? ''
}

/** Pure: "10.02" short label for day headers; falls back to the raw string. */
export function dayDateLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  return `${date.slice(5, 7)}.${date.slice(8, 10)}`
}

/** Pure: leg lookup by adjacent item pair — "itemA|itemB" → leg | null. */
export function legsByPair(legs: (WorkbenchLeg | null)[]): Map<string, WorkbenchLeg> {
  const map = new Map<string, WorkbenchLeg>()
  for (const leg of legs) {
    if (!leg || !leg.fromItemId || !leg.toItemId) continue
    const key = `${leg.fromItemId}|${leg.toItemId}`
    if (!map.has(key)) map.set(key, leg)
  }
  return map
}

/** Pure: "30.3 千米 · 31 分钟" for a leg chip; segments without data render '—'. */
export function formatLegLabel(leg: WorkbenchLeg | null): string {
  if (!leg || (leg.distanceKm <= 0 && leg.durationMin <= 0)) return ''
  const parts: string[] = []
  if (leg.distanceKm > 0) parts.push(`${trimNumber(leg.distanceKm)} 千米`)
  if (leg.durationMin > 0) parts.push(`${Math.round(leg.durationMin)} 分钟`)
  return parts.join(' · ')
}

/** Per-day accent color with a stable fallback palette (PRD: 多日分色). */
const DAY_COLORS = ['#c26d4f', '#3f7d5c', '#4f6dc2', '#8a5fbf', '#b75342', '#2f7d8a', '#a8791f']

/** Pure: a valid hex color for the day, else the palette pick by day index. */
export function dayAccentColor(color: string, index: number): string {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return color
  const palette = DAY_COLORS[((index % DAY_COLORS.length) + DAY_COLORS.length) % DAY_COLORS.length]
  return palette ?? '#8a938d'
}

/** Pure: card visual family per ticket 04's four card types. */
export function cardVisual(type: ItemType): 'traffic' | 'stay' | 'attraction' | 'other' {
  switch (type) {
    case 'traffic':
      return 'traffic'
    case 'stay':
      return 'stay'
    case 'attraction':
    case 'food':
      return 'attraction'
    default:
      return 'other'
  }
}

export const CARD_TYPE_LABEL: Record<ItemType, string> = {
  traffic: '交通',
  stay: '住宿',
  attraction: '游玩',
  food: '餐饮',
  other: '其他',
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

// ---------------------------------------------------------------------------
// Tolerant normalization (mirror of the server's; guards against a drifted API)
// ---------------------------------------------------------------------------

const ITEM_TYPES: ItemType[] = ['traffic', 'stay', 'attraction', 'food', 'other']

function normalizeDay(value: unknown): WorkbenchDay | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) return null
  const items = Array.isArray(record.items) ? record.items : []
  return {
    id,
    index: finiteNumber(record.index),
    date: typeof record.date === 'string' ? record.date : '',
    theme: typeof record.theme === 'string' ? record.theme : '',
    color: typeof record.color === 'string' ? record.color : '',
    items: items.map(normalizeItem).filter((item): item is WorkbenchItem => item !== null),
  }
}

function normalizeItem(value: unknown): WorkbenchItem | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) return null
  const type = typeof record.type === 'string' ? (record.type as ItemType) : 'other'
  return {
    id,
    dayId: typeof record.dayId === 'string' ? record.dayId : '',
    order: finiteNumber(record.order),
    type: ITEM_TYPES.includes(type) ? type : 'other',
    title: typeof record.title === 'string' ? record.title : '',
    note: typeof record.note === 'string' ? record.note : '',
    poi: normalizePoi(record.poi),
    images: Array.isArray(record.images) ? record.images : [],
    pending: record.pending === true,
  }
}

function normalizePoi(value: unknown): PoiRef | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  if (!name) return null
  return {
    amapId: typeof record.amapId === 'string' ? record.amapId : '',
    name,
    lat: finiteNumber(record.lat),
    lng: finiteNumber(record.lng),
    category: typeof record.category === 'string' ? record.category : '',
    rating: finiteNumber(record.rating),
    introSummary: typeof record.introSummary === 'string' ? record.introSummary : '',
  }
}

function normalizeLeg(value: unknown): WorkbenchLeg | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const fromItemId = typeof record.fromItemId === 'string' ? record.fromItemId : ''
  const toItemId = typeof record.toItemId === 'string' ? record.toItemId : ''
  if (!fromItemId || !toItemId) return null
  return {
    id: typeof record.id === 'string' ? record.id : '',
    fromItemId,
    toItemId,
    mode: typeof record.mode === 'string' ? record.mode : 'drive',
    distanceKm: finiteNumber(record.distanceKm),
    durationMin: finiteNumber(record.durationMin),
    polyline: normalizePolyline(record.polyline),
  }
}

/** [lng, lat][] pairs with finite numbers only; anything else → null (ticket 05). */
function normalizePolyline(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null
  const points: [number, number][] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) continue
    const lng = typeof entry[0] === 'number' ? entry[0] : Number(entry[0])
    const lat = typeof entry[1] === 'number' ? entry[1] : Number(entry[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
    points.push([lng, lat])
  }
  return points.length >= 2 ? points : null
}

function finiteNumber(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}
