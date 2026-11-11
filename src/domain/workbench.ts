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

export type {
  ItemType,
  LegQuality,
  PoiRef,
  ItemImage,
  ActivityItem as WorkbenchItem,
  Day as WorkbenchDay,
  Leg as WorkbenchLeg,
} from '@hailar/domain'
import type {
  ItemType,
  LegQuality,
  PoiRef,
  ItemImage,
  ActivityItem as WorkbenchItem,
  Day as WorkbenchDay,
  Leg as WorkbenchLeg,
} from '@hailar/domain'

export type TripCanvasData = {
  trip: TripSummary
  days: WorkbenchDay[]
  legs: WorkbenchLeg[]
}

export type WorkbenchRouteRefreshSummary = {
  attempted: number
  updated: number
  pending: number
  truncated: boolean
}

export const CANVAS_NETWORK_ERROR = '无法连接服务器，请确认后端服务已启动。'

// ---------------------------------------------------------------------------
// Day-management writes (ticket 10) — same result convention as the reads:
// {ok:true,data} | {ok:false,error}, injectable FetchLike, never throws.
// ---------------------------------------------------------------------------

/** Optional payload for creating a day; omitted fields take server defaults. */
export type WorkbenchDayInput = { date?: string; theme?: string; color?: string }

/** Theme (and color) patch for an existing day. */
export type WorkbenchDayPatch = { theme?: string; color?: string }

/** Shared response handling for the three day-admin routes. */
async function dayRequest(
  url: string,
  init: RequestInit,
  fetchLike: FetchLike,
): Promise<ApiResult<unknown>> {
  let response: Response
  try {
    response = await fetchLike(url, init)
  } catch {
    return { ok: false, error: CANVAS_NETWORK_ERROR }
  }
  if (!response.ok) {
    const message = ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error
    return { ok: false, error: typeof message === 'string' && message ? message : `请求失败（HTTP ${response.status}）` }
  }
  const payload = (await response.json().catch(() => null)) as unknown
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '服务器返回的数据无法解析。' }
  return { ok: true, data: payload }
}

/**
 * POST /api/trips/:id/days — append a day (server computes the next date, or
 * '' when the trip has no dated days). Returns the created day with no items.
 */
export async function createWorkbenchDay(
  tripId: string,
  input: WorkbenchDayInput = {},
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<WorkbenchDay>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/days`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
    fetchLike,
  )
  if (!result.ok) return result
  const day = normalizeDay((result.data as { day?: unknown }).day)
  if (day === null) return { ok: false, error: '服务器返回的日程数据无法解析。' }
  return { ok: true, data: day }
}

/** PATCH /api/trips/:id/days/:dayId — update a day's theme (and color). */
export async function updateWorkbenchDay(
  tripId: string,
  dayId: string,
  patch: WorkbenchDayPatch,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<WorkbenchDay>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/days/${encodeURIComponent(dayId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
    fetchLike,
  )
  if (!result.ok) return result
  const day = normalizeDay((result.data as { day?: unknown }).day)
  if (day === null) return { ok: false, error: '服务器返回的日程数据无法解析。' }
  return { ok: true, data: day }
}

/** DELETE /api/trips/:id/days/:dayId — removes the day, its items and legs. */
export async function deleteWorkbenchDay(
  tripId: string,
  dayId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<{ removedItems: number }>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/days/${encodeURIComponent(dayId)}`,
    { method: 'DELETE' },
    fetchLike,
  )
  if (!result.ok) return result
  const removed = (result.data as { removedItems?: unknown }).removedItems
  return { ok: true, data: { removedItems: finiteNumber(removed) } }
}

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

/**
 * POST /api/trips/:id/legs/refresh — best-effort background upgrade of the
 * server's estimate legs. The endpoint may return pending rows when no route
 * provider is configured; callers should keep the current canvas on failure.
 */
export async function refreshWorkbenchLegs(
  tripId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<{ legs: WorkbenchLeg[]; summary: WorkbenchRouteRefreshSummary | null }>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/legs/refresh`,
    { method: 'POST' },
    fetchLike,
  )
  if (!result.ok) return result
  const record = result.data as { legs?: unknown; summary?: unknown }
  if (!Array.isArray(record.legs)) return { ok: false, error: '服务器返回的路线数据无法解析。' }
  const legs = record.legs.map(normalizeLeg).filter((leg): leg is WorkbenchLeg => leg !== null)
  return { ok: true, data: { legs, summary: normalizeRouteRefreshSummary(record.summary) } }
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

/** Normalize legacy payloads where quality was inferred from geometry. */
export function legQuality(leg: WorkbenchLeg | null): LegQuality {
  if (!leg) return 'pending'
  if (leg.quality === 'reference' || leg.quality === 'estimate' || leg.quality === 'measured' || leg.quality === 'pending') {
    return leg.quality
  }
  if (leg.distanceKm <= 0 && leg.durationMin <= 0) return 'pending'
  return leg.polyline === null ? 'estimate' : 'measured'
}

/** Human label shared by canvas/list cards, with approximate provenance. */
export function formatLegDisplayLabel(leg: WorkbenchLeg | null): string {
  const label = formatLegLabel(leg)
  if (!label) return ''
  return legQuality(leg) === 'reference' || legQuality(leg) === 'estimate' ? `约 ${label}` : label
}

/** A drive longer than six hours needs a visible split/overnight warning. */
export const LONG_DRIVE_LIMIT_MINUTES = 6 * 60

export function isLongDriveLeg(leg: WorkbenchLeg | null): boolean {
  return leg !== null && leg.mode === 'drive' && leg.durationMin > LONG_DRIVE_LIMIT_MINUTES
}

export function longDriveWarningText(leg: WorkbenchLeg | null): string {
  if (!isLongDriveLeg(leg)) return ''
  return `驾驶超过 6 小时，建议拆分行程并增加中途休息或过夜点`
}

export type CrossDayDriveWarning = {
  id: string
  fromDayId: string
  toDayId: string
  fromItemId: string
  toItemId: string
  fromTitle: string
  toTitle: string
  distanceKm: number
  durationMin: number
  estimated: true
}

export type CrossDayTransfer = {
  id: string
  fromDayId: string
  toDayId: string
  fromItemId: string
  toItemId: string
  fromTitle: string
  toTitle: string
  distanceKm: number
  durationMin: number
  estimated: boolean
  longDrive: boolean
  leg: WorkbenchLeg
}

/** Resolve the incoming bridge between two consecutive day columns. */
export function crossDayTransfer(
  previousDay: WorkbenchDay,
  day: WorkbenchDay,
  legs: WorkbenchLeg[] = [],
): CrossDayTransfer | null {
  if (!previousDay || !day || day.index !== previousDay.index + 1) return null
  const from = orderedItems(previousDay).at(-1)
  const to = orderedItems(day)[0]
  if (!from || !to) return null
  const stored = legsByPair(legs).get(`${from.id}|${to.id}`)
  const estimate = !stored ? estimateCrossDayLeg(from, to) : null
  const leg = stored ?? {
    id: `leg-${from.id}-${to.id}`,
    fromItemId: from.id,
    toItemId: to.id,
    mode: 'drive',
    distanceKm: estimate?.distanceKm ?? 0,
    durationMin: estimate?.durationMin ?? 0,
    polyline: null,
    quality: estimate ? 'estimate' as const : 'pending' as const,
  }
  return {
    id: `cross-day-${from.id}-${to.id}`,
    fromDayId: previousDay.id,
    toDayId: day.id,
    fromItemId: from.id,
    toItemId: to.id,
    fromTitle: from.title,
    toTitle: to.title,
    distanceKm: leg.distanceKm,
    durationMin: leg.durationMin,
    estimated: legQuality(leg) !== 'measured',
    longDrive: leg.mode === 'drive' && leg.durationMin > LONG_DRIVE_LIMIT_MINUTES,
    leg,
  }
}

function estimateCrossDayLeg(from: WorkbenchItem, to: WorkbenchItem): { distanceKm: number; durationMin: number } | null {
  if (!hasUsablePoi(from) || !hasUsablePoi(to)) return null
  const distanceKm = Math.round(haversineKm([from.poi.lng, from.poi.lat], [to.poi.lng, to.poi.lat]) * 1.2 * 10) / 10
  return distanceKm > 0 ? { distanceKm, durationMin: Math.max(1, Math.round(distanceKm)) } : null
}

/**
 * Find long transfers hidden between day columns. The server intentionally
 * stores legs only within a day, so this projection uses the last POI of one
 * day and the first POI of the next day and labels the result as an estimate.
 */
export function crossDayDriveWarnings(days: WorkbenchDay[]): CrossDayDriveWarning[] {
  return crossDayTransfers(days)
    .filter((transfer) => transfer.longDrive)
    .map((transfer) => ({
      id: transfer.id,
      fromDayId: transfer.fromDayId,
      toDayId: transfer.toDayId,
      fromItemId: transfer.fromItemId,
      toItemId: transfer.toItemId,
      fromTitle: transfer.fromTitle,
      toTitle: transfer.toTitle,
      distanceKm: transfer.distanceKm,
      durationMin: transfer.durationMin,
      estimated: true as const,
    }))
}

/** All visible incoming bridges, including short cross-day transfers. */
export function crossDayTransfers(days: WorkbenchDay[], legs: WorkbenchLeg[] = []): CrossDayTransfer[] {
  const orderedDays = (Array.isArray(days) ? days : [])
    .filter((day) => day && typeof day.id === 'string' && day.id !== '' && Number.isInteger(day.index) && day.index >= 0)
    .slice()
    .sort((a, b) => a.index - b.index || a.id.localeCompare(b.id))
  const transfers: CrossDayTransfer[] = []
  for (let index = 0; index + 1 < orderedDays.length; index += 1) {
    const currentDay = orderedDays[index]
    const nextDay = orderedDays[index + 1]
    if (!currentDay || !nextDay || nextDay.index !== currentDay.index + 1) continue
    const transfer = crossDayTransfer(currentDay, nextDay, legs)
    if (transfer) transfers.push(transfer)
  }
  return transfers
}

type UsablePoiItem = WorkbenchItem & { poi: NonNullable<WorkbenchItem['poi']> }

function hasUsablePoi(item: WorkbenchItem): item is UsablePoiItem {
  const poi = item.poi
  return poi !== null && Number.isFinite(poi.lat) && Number.isFinite(poi.lng) && !(poi.lat === 0 && poi.lng === 0)
}

function orderedItems(day: WorkbenchDay): WorkbenchItem[] {
  return [...day.items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
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
// Card-editing writes (ticket 09) — same result convention as the reads:
// {ok:true,data} | {ok:false,error}, injectable FetchLike, never throws.
// Every layout mutation response carries the recomputed legs so the map
// updates without a second canvas read.
// ---------------------------------------------------------------------------

/** Payload for creating a card (free text: poi omitted/null; POI card: poi set). */
export type WorkbenchItemCreateInput = {
  dayId: string
  title: string
  type?: ItemType
  note?: string
  poi?: PoiRef | null
  images?: ItemImage[]
  index?: number
}

/** Field-edit patch for an existing card. */
export type WorkbenchItemPatch = { title?: string; note?: string; images?: ItemImage[]; poi?: PoiRef | null }

/** Move/copy target: dayId omitted keeps the day; index omitted appends. */
export type WorkbenchItemTarget = { dayId?: string; index?: number }

export type ItemMutationData = { item: WorkbenchItem; legs: WorkbenchLeg[] }

function parseItemMutation(data: unknown): ApiResult<ItemMutationData> {
  const record = (data ?? {}) as { item?: unknown; legs?: unknown }
  const item = normalizeItem(record.item)
  if (item === null) return { ok: false, error: '服务器返回的卡片数据无法解析。' }
  const legs = Array.isArray(record.legs) ? record.legs.map(normalizeLeg).filter((leg): leg is WorkbenchLeg => leg !== null) : []
  return { ok: true, data: { item, legs } }
}

/** POST /api/trips/:id/items — create a card; the server assigns the id. */
export async function createWorkbenchItem(
  tripId: string,
  input: WorkbenchItemCreateInput,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ItemMutationData>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/items`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
    fetchLike,
  )
  if (!result.ok) return result
  return parseItemMutation(result.data)
}

/** POST /api/trips/:id/items/:itemId/move — reorder within / across days. */
export async function moveWorkbenchItem(
  tripId: string,
  itemId: string,
  target: WorkbenchItemTarget,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ItemMutationData>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}/move`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(target),
    },
    fetchLike,
  )
  if (!result.ok) return result
  return parseItemMutation(result.data)
}

/** POST /api/trips/:id/items/:itemId/copy — duplicate into a (new) day. */
export async function copyWorkbenchItem(
  tripId: string,
  itemId: string,
  target: WorkbenchItemTarget,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ItemMutationData>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}/copy`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(target),
    },
    fetchLike,
  )
  if (!result.ok) return result
  return parseItemMutation(result.data)
}

/** PATCH /api/trips/:id/items/:itemId — edit title / note / images. */
export async function updateWorkbenchItem(
  tripId: string,
  itemId: string,
  patch: WorkbenchItemPatch,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<WorkbenchItem>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    },
    fetchLike,
  )
  if (!result.ok) return result
  const item = normalizeItem((result.data as { item?: unknown }).item)
  if (item === null) return { ok: false, error: '服务器返回的卡片数据无法解析。' }
  return { ok: true, data: item }
}

/** DELETE /api/trips/:id/items/:itemId — remove the card. */
export async function deleteWorkbenchItem(
  tripId: string,
  itemId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<{ legs: WorkbenchLeg[] }>> {
  const result = await dayRequest(
    `/api/trips/${encodeURIComponent(tripId)}/items/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
    fetchLike,
  )
  if (!result.ok) return result
  const legs = Array.isArray((result.data as { legs?: unknown }).legs)
    ? ((result.data as { legs: unknown[] }).legs.map(normalizeLeg).filter((leg): leg is WorkbenchLeg => leg !== null))
    : []
  return { ok: true, data: { legs } }
}

// ---------------------------------------------------------------------------
// Pure optimistic-layout helpers (unit-tested) — the server clamps the same
// way, so a successful response needs no second reconciliation.
// ---------------------------------------------------------------------------

/**
 * Pure: move `itemId` to `toDayId` at `toIndex` (final position after
 * removal, clamped) and renumber the affected days 0..n-1. Returns the same
 * array reference when nothing matched.
 */
export function applyItemMove(days: WorkbenchDay[], itemId: string, toDayId: string, toIndex: number): WorkbenchDay[] {
  const moving = days.flatMap((day) => day.items).find((item) => item.id === itemId)
  if (!moving) return days
  return days.map((day) => {
    const without = day.items.filter((item) => item.id !== itemId)
    if (day.id !== toDayId) {
      return without.length === day.items.length
        ? day
        : { ...day, items: without.map((item, order) => ({ ...item, order })) }
    }
    const index = Math.max(0, Math.min(without.length, Number.isInteger(toIndex) ? toIndex : without.length))
    const items = [...without.slice(0, index), { ...moving, dayId: toDayId }, ...without.slice(index)]
    return { ...day, items: items.map((item, order) => ({ ...item, order })) }
  })
}

/**
 * Pure: insert an item (new card / copy) into `dayId` at `index` (clamped;
 * default: end) and renumber that day.
 */
export function applyItemInsert(
  days: WorkbenchDay[],
  item: WorkbenchItem,
  dayId: string,
  index?: number,
): WorkbenchDay[] {
  return days.map((day) => {
    if (day.id !== dayId) return day
    const at = Math.max(0, Math.min(day.items.length, index ?? day.items.length))
    const items = [...day.items.slice(0, at), { ...item, dayId, order: 0 }, ...day.items.slice(at)]
    return { ...day, items: items.map((entry, order) => ({ ...entry, order })) }
  })
}

/** Pure: remove an item and renumber its day; no-op when the id is unknown. */
export function applyItemRemove(days: WorkbenchDay[], itemId: string): WorkbenchDay[] {
  const exists = days.some((day) => day.items.some((item) => item.id === itemId))
  if (!exists) return days
  return days.map((day) => {
    const items = day.items.filter((item) => item.id !== itemId)
    return items.length === day.items.length
      ? day
      : { ...day, items: items.map((item, order) => ({ ...item, order })) }
  })
}

/** Pure: patch one item's fields in place (note / images / title / identity swap). */
export function applyItemPatch(days: WorkbenchDay[], itemId: string, patch: Partial<WorkbenchItem>): WorkbenchDay[] {
  const exists = days.some((day) => day.items.some((item) => item.id === itemId))
  if (!exists) return days
  return days.map((day) => ({
    ...day,
    items: day.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
  }))
}

/** Pure: replace the temp optimistic item with its persisted server version. */
export function applyItemReplace(days: WorkbenchDay[], tempId: string, serverItem: WorkbenchItem): WorkbenchDay[] {
  return applyItemPatch(days, tempId, {
    id: serverItem.id,
    title: serverItem.title,
    note: serverItem.note,
    poi: serverItem.poi,
    images: serverItem.images,
    type: serverItem.type,
    pending: serverItem.pending,
  })
}

/**
 * Pure: AmapPlaceResult (src/services/amap.ts, already WGS-84) → PoiRef for
 * the add-card POI mode. Keeps the structural shape loose so tests can feed
 * fixtures without importing the SDK surface.
 */
export function poiFromPlace(place: {
  id?: string
  name?: string
  lat?: number
  lng?: number
  address?: string
  city?: string
}): PoiRef | null {
  const name = typeof place?.name === 'string' ? place.name.trim() : ''
  if (!name) return null
  const lat = typeof place.lat === 'number' ? place.lat : Number(place.lat)
  const lng = typeof place.lng === 'number' ? place.lng : Number(place.lng)
  return {
    amapId: typeof place.id === 'string' ? place.id : '',
    name,
    lat: Number.isFinite(lat) ? lat : 0,
    lng: Number.isFinite(lng) ? lng : 0,
    ...(typeof place.address === 'string' && place.address.trim() ? { address: place.address.trim() } : {}),
    category: typeof place.city === 'string' ? place.city : '',
    rating: 0,
    introSummary: typeof place.address === 'string' ? place.address : '',
  }
}

/** Pure: a temp id for optimistic copies / adds (replaced on success). */
export function tempItemId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
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
    ...(typeof record.address === 'string' && record.address.trim() ? { address: record.address.trim() } : {}),
    ...(typeof record.accommodationBaseId === 'string' && record.accommodationBaseId.trim()
      ? { accommodationBaseId: record.accommodationBaseId.trim() }
      : {}),
    ...(record.accommodationType === 'area' || record.accommodationType === 'hotel'
      ? { accommodationType: record.accommodationType }
      : {}),
    ...(typeof record.accommodationNotes === 'string' && record.accommodationNotes.trim()
      ? { accommodationNotes: record.accommodationNotes.trim() }
      : {}),
    ...(Number.isInteger(Number(record.accommodationMigrationVersion)) && Number(record.accommodationMigrationVersion) > 0
      ? { accommodationMigrationVersion: Number(record.accommodationMigrationVersion) }
      : {}),
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
  const distanceKm = finiteNumber(record.distanceKm)
  const durationMin = finiteNumber(record.durationMin)
  const polyline = normalizePolyline(record.polyline)
  return {
    id: typeof record.id === 'string' ? record.id : '',
    fromItemId,
    toItemId,
    mode: typeof record.mode === 'string' ? record.mode : 'drive',
    distanceKm,
    durationMin,
    polyline,
    quality: normalizeWorkbenchLegQuality(record.quality, distanceKm, durationMin, polyline),
  }
}

function normalizeWorkbenchLegQuality(
  value: unknown,
  distanceKm: number,
  durationMin: number,
  polyline: [number, number][] | null,
): LegQuality {
  if (value === 'reference' || value === 'estimate' || value === 'measured' || value === 'pending') return value
  if (distanceKm <= 0 && durationMin <= 0) return 'pending'
  return polyline === null ? 'estimate' : 'measured'
}

function normalizeRouteRefreshSummary(value: unknown): WorkbenchRouteRefreshSummary | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return {
    attempted: finiteNumber(record.attempted),
    updated: finiteNumber(record.updated),
    pending: finiteNumber(record.pending),
    truncated: record.truncated === true,
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
