import type { RoutePoint, RouteLegResult, RouteLegSearch } from './types.js'
import { mapItemRow, mapLegRow } from '../days/repository.js'
import { projectLegMetrics } from '../days/leg-projections.js'
import type { CanvasItem, CanvasLeg } from '../days/types.js'
import type { ItemsAdminStoreDriver } from '../items-admin/types.js'
import { adjacentTripPairs, estimateLeg, type LegDayOrder } from '../items-admin/legs.js'
import { gcj02ToWgs84LngLat, wgs84ToGcj02LngLat } from './geo.js'

const DEFAULT_LOOKUP_TIMEOUT_MS = 2_500
const DEFAULT_REFRESH_BUDGET_MS = 8_000
const DEFAULT_CONCURRENCY = 4
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1_000
const DEFAULT_CACHE_SIZE = 512

export type RouteRefreshSummary = {
  attempted: number
  updated: number
  pending: number
  truncated: boolean
}

export type RouteRefreshOptions = {
  /** Shared by one app instance so repeated edits reuse successful lookups. */
  cache?: RouteLookupCache
  /** Maximum number of provider requests running at once. */
  concurrency?: number
  /** Per-provider-request wall-clock limit. */
  lookupTimeoutMs?: number
  /** Whole-refresh wall-clock budget; unfinished pairs remain estimates. */
  maxDurationMs?: number
  /** Injectable clock for deterministic repository tests. */
  now?: () => number
}

type CachedRoute = { result: RouteLegResult; expiresAt: number }

/** Internal read metadata, separate from the provider's legacy metric shape. */
type NormalizedRouteResult = RouteLegResult & { metricProjection: ReturnType<typeof projectLegMetrics> }

/** Small TTL/LRU-ish cache for successful ordered route pairs. */
export class RouteLookupCache {
  private readonly entries = new Map<string, CachedRoute>()

  constructor(
    private readonly ttlMs = DEFAULT_CACHE_TTL_MS,
    private readonly maxEntries = DEFAULT_CACHE_SIZE,
  ) {}

  get(key: string, now = Date.now()): RouteLegResult | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now) {
      this.entries.delete(key)
      return null
    }
    // Refresh insertion order on access so the oldest entry is evicted first.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.result
  }

  set(key: string, result: RouteLegResult, now = Date.now()): void {
    // Pending results are deliberately not cached. A missing key or a
    // transient provider failure must not survive a later configuration fix.
    if (result.status !== 'ok') return
    this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (typeof oldest !== 'string') break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { result, expiresAt: now + Math.max(1, this.ttlMs) })
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Server-side driving route adapter. AMap is queried only when a Web Service
 * key is configured; otherwise callers receive an explicit pending result so
 * a straight-line estimate is never presented as measured driving data.
 */
export const routeAmapLeg: RouteLegSearch = async (input) => {
  const from = validPoint(input.from)
  const to = validPoint(input.to)
  if (!from || !to) return pendingRoute('起点或终点坐标无效。')

  const key = process.env.AMAP_WEB_KEY ?? process.env.AMAP_KEY
  if (!key) return pendingRoute('未配置高德 Web 服务 Key，暂不能获取实测路线。')

  const params = new URLSearchParams({
    key,
    origin: formatAmapPoint(from.lng, from.lat),
    destination: formatAmapPoint(to.lng, to.lat),
    strategy: '0',
    extensions: 'all',
  })
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DEFAULT_LOOKUP_TIMEOUT_MS)
    try {
      const response = await fetch(`https://restapi.amap.com/v3/direction/driving?${params.toString()}`, {
        signal: controller.signal,
      })
      if (!response.ok) return pendingRoute('路线服务暂不可用。')
      const payload = (await response.json()) as unknown
      return parseAmapRoute(payload)
    } catch {
      return pendingRoute('路线服务暂不可用。')
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    return pendingRoute('路线服务暂不可用。')
  }
}

function formatAmapPoint(lng: number, lat: number): string {
  const [amapLng, amapLat] = wgs84ToGcj02LngLat(lng, lat)
  return `${amapLng},${amapLat}`
}

/** Normalize one AMap driving response while keeping missing metrics pending. */
export function parseAmapRoute(payload: unknown): RouteLegResult {
  if (payload === null || typeof payload !== 'object') return pendingRoute('路线服务返回数据无效。')
  const record = payload as Record<string, unknown>
  if (record.status !== '1') {
    return pendingRoute('路线服务未返回可用路线。')
  }
  const routeValue = Array.isArray(record.route) ? (record.route as unknown[])[0] : record.route
  if (routeValue === null || typeof routeValue !== 'object') return pendingRoute('路线服务未返回可用路线。')
  const route = routeValue as Record<string, unknown>
  const paths = Array.isArray(route.paths) ? route.paths : []
  const path = paths[0]
  if (path === null || typeof path !== 'object') return pendingRoute('路线服务未返回可用路线。')

  const distanceMeters = finiteNumber((path as Record<string, unknown>).distance)
  const durationSeconds = finiteNumber((path as Record<string, unknown>).duration)
  if (distanceMeters === null || durationSeconds === null || distanceMeters < 0 || durationSeconds < 0) {
    return pendingRoute('路线服务未返回完整距离和时间。')
  }
  const polyline = parsePolyline(path as Record<string, unknown>)
  return {
    status: 'ok',
    source: 'amap',
    distanceKm: Math.round((distanceMeters / 1000) * 10) / 10,
    durationMin: Math.max(0, Math.round(durationSeconds / 60)),
    polyline,
  }
}

function parsePolyline(path: Record<string, unknown>): Array<[number, number]> | null {
  const points: Array<[number, number]> = []
  const steps = Array.isArray(path.steps) ? path.steps : []
  for (const step of steps) {
    if (step === null || typeof step !== 'object') continue
    const polyline = (step as Record<string, unknown>).polyline
    if (typeof polyline !== 'string') continue
    for (const pair of polyline.split(';')) {
      const [lngText, latText] = pair.split(',')
      const lng = Number(lngText)
      const lat = Number(latText)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
      const [wgsLng, wgsLat] = gcj02ToWgs84LngLat(lng, lat)
      if (points.at(-1)?.[0] === wgsLng && points.at(-1)?.[1] === wgsLat) continue
      points.push([wgsLng, wgsLat])
    }
  }
  if (points.length > 0) return points
  const fallback = path.polyline
  if (typeof fallback !== 'string') return null
  for (const pair of fallback.split(';')) {
    const [lngText, latText] = pair.split(',')
    const lng = Number(lngText)
    const lat = Number(latText)
    if (Number.isFinite(lng) && Number.isFinite(lat)) points.push(gcj02ToWgs84LngLat(lng, lat))
  }
  return points.length > 0 ? points : null
}

function validPoint(point: RoutePoint): { lat: number; lng: number } | null {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null
  if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) return null
  if (point.lat === 0 && point.lng === 0) return null
  return { lat: point.lat, lng: point.lng }
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

export function pendingRoute(reason: string): RouteLegResult {
  return {
    status: 'pending',
    source: 'pending',
    distanceKm: null,
    durationMin: null,
    polyline: null,
    reason,
  }
}

/**
 * Re-query every adjacent pair and replace only rows for which the provider
 * returned real metrics. Pending responses retain the existing estimate (or
 * an empty leg), so an unavailable routing service never overwrites usable
 * local state with fabricated numbers.
 */
export async function refreshTripLegs(
  driver: ItemsAdminStoreDriver,
  tripId: string,
  provider: RouteLegSearch = routeAmapLeg,
  options: RouteRefreshOptions = {},
): Promise<{ ok: true; legs: CanvasLeg[]; summary: RouteRefreshSummary } | { ok: false; error: string }> {
  let dayRows: Awaited<ReturnType<ItemsAdminStoreDriver['listDayRows']>>
  let itemRows: Awaited<ReturnType<ItemsAdminStoreDriver['listItemRows']>>
  let legRows: Awaited<ReturnType<ItemsAdminStoreDriver['listLegRows']>>
  try {
    ;[dayRows, itemRows, legRows] = await Promise.all([
      driver.listDayRows(tripId),
      driver.listItemRows(tripId),
      driver.listLegRows(tripId),
    ])
  } catch {
    return { ok: false, error: '读取路线数据失败。' }
  }

  const items = (Array.isArray(itemRows) ? itemRows : [])
    .map(mapItemRow)
    .filter((item): item is CanvasItem => item !== null)
  const previous = (Array.isArray(legRows) ? legRows : [])
    .map(mapLegRow)
    .filter((leg): leg is CanvasLeg => leg !== null)
  const byPair = new Map(previous.map((leg) => [`${leg.fromItemId}|${leg.toItemId}`, leg]))
  const dayOrder: LegDayOrder[] = (Array.isArray(dayRows) ? dayRows : [])
    .map((row) => ({ id: typeof row?.id === 'string' ? row.id : '', index: Number(row?.idx) }))
    .filter((day): day is LegDayOrder => day.id !== '' && Number.isInteger(day.index) && day.index >= 0)
  const pairs = adjacentTripPairs(items, dayOrder).map((pair) => ({
    ...pair,
    old: byPair.get(`${pair.from.id}|${pair.to.id}`),
  }))

  const now = options.now ?? Date.now
  const cache = options.cache ?? new RouteLookupCache()
  const concurrency = clampPositiveInt(options.concurrency, DEFAULT_CONCURRENCY)
  const lookupTimeoutMs = clampPositiveInt(options.lookupTimeoutMs, DEFAULT_LOOKUP_TIMEOUT_MS)
  const maxDurationMs = clampPositiveInt(options.maxDurationMs, DEFAULT_REFRESH_BUDGET_MS)
  const deadline = now() + maxDurationMs
  const resolved: Array<NormalizedRouteResult | null> = Array.from({ length: pairs.length }, () => null)
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      const pair = pairs[index]
      if (!pair) return
      resolved[index] = await lookupRoute(provider, pair.from, pair.to, {
        cache,
        lookupTimeoutMs,
        deadline,
        now,
      })
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pairs.length) }, () => worker()))

  const next: CanvasLeg[] = []
  let updated = 0
  let pending = 0
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]!
    const route = resolved[index] ?? normalizeRouteResult(pendingRoute('路线刷新超时。'))
    if (route.status === 'ok' && route.distanceKm !== null && route.durationMin !== null) {
      updated += 1
      next.push({
        id: `leg-${pair.from.id}-${pair.to.id}`,
        fromItemId: pair.from.id,
        toItemId: pair.to.id,
        mode: 'drive',
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
        polyline: route.polyline,
        quality: 'measured',
        ...route.metricProjection,
      })
      continue
    }
    pending += 1
    next.push(fallbackLeg(pair.from, pair.to, pair.old))
  }

  try {
    await driver.withTransaction(async (transactionDriver) => {
      await transactionDriver.replaceLegs(tripId, next)
    })
  } catch {
    return { ok: false, error: '保存路线失败。' }
  }
  return {
    ok: true,
    legs: next,
    summary: {
      attempted: pairs.length,
      updated,
      pending,
      truncated:
        pairs.some((_, index) => resolved[index] === null) ||
        resolved.some((route) => route?.reason === '路线刷新超时。' || route?.reason === '路线查询超时。'),
    },
  }
}

function fallbackLeg(from: CanvasItem, to: CanvasItem, old: CanvasLeg | undefined): CanvasLeg {
  const estimate = estimateLeg(from.poi, to.poi)
  // Keep a stored leg only when its deterministic id proves it belongs to the
  // same ordered pair. A geometry-bearing leg for the reverse pair is never
  // replayed: one-way road geometry must be looked up in its new direction.
  const expectedId = `leg-${from.id}-${to.id}`
  if (old && old.id === expectedId && (old.distanceKm > 0 || old.durationMin > 0)) {
    return {
      ...old,
      id: expectedId,
      fromItemId: from.id,
      toItemId: to.id,
      mode: old.mode || 'drive',
      distanceKm: old.distanceKm,
      durationMin: old.durationMin,
      polyline: old.polyline,
      quality: old.quality,
    }
  }
  return {
    id: expectedId,
    fromItemId: from.id,
    toItemId: to.id,
    mode: 'drive',
    distanceKm: estimate?.distanceKm ?? 0,
    durationMin: estimate?.durationMin ?? 0,
    polyline: null,
    quality: estimate ? 'estimate' : 'pending',
    ...(estimate ? projectLegMetrics(estimate.distanceKm, estimate.durationMin, 'estimate', null) : {}),
  }
}

async function lookupRoute(
  provider: RouteLegSearch,
  from: CanvasItem,
  to: CanvasItem,
  options: { cache: RouteLookupCache; lookupTimeoutMs: number; deadline: number; now: () => number },
): Promise<NormalizedRouteResult> {
  if (!usablePoi(from) || !usablePoi(to)) return normalizeRouteResult(pendingRoute('起点或终点没有可用坐标。'))
  const key = routeCacheKey(from, to)
  const cached = options.cache.get(key, options.now())
  if (cached) return normalizeRouteResult(cached)
  const remaining = options.deadline - options.now()
  if (remaining <= 0) return normalizeRouteResult(pendingRoute('路线刷新超时。'))
  const timeoutMs = Math.min(options.lookupTimeoutMs, remaining)
  let timedOut = false
  try {
    const result = await withTimeout(
      provider({
        from: { name: from.poi?.name, lat: from.poi?.lat ?? 0, lng: from.poi?.lng ?? 0 },
        to: { name: to.poi?.name, lat: to.poi?.lat ?? 0, lng: to.poi?.lng ?? 0 },
      }),
      timeoutMs,
      () => {
        timedOut = true
      },
    )
    const normalized = normalizeRouteResult(result)
    if (normalized.status === 'ok') {
      // Cache the available source scalars, not the old null→0 coercion. A hit
      // must retain the same per-metric omission as the first response.
      options.cache.set(key, {
        status: normalized.status,
        source: normalized.source,
        distanceKm: result.distanceKm,
        durationMin: result.durationMin,
        polyline: normalized.polyline,
      }, options.now())
    }
    return normalized
  } catch {
    if (timedOut) {
      return normalizeRouteResult(pendingRoute(options.now() >= options.deadline ? '路线刷新超时。' : '路线查询超时。'))
    }
    return normalizeRouteResult(pendingRoute('路线服务暂不可用。'))
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      onTimeout()
      reject(new Error('route lookup timed out'))
    }, Math.max(1, timeoutMs))
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function normalizeRouteResult(value: RouteLegResult): NormalizedRouteResult {
  if (value?.status !== 'ok') return { ...pendingRoute(value?.reason || '路线服务未返回可用路线。'), metricProjection: {} }
  // Capture strict source validity before legacy coercion turns NULL into 0.
  const metricProjection = projectLegMetrics(value.distanceKm, value.durationMin, 'measured', null)
  const distanceKm = finiteNumber(value.distanceKm)
  const durationMin = finiteNumber(value.durationMin)
  if (distanceKm === null || durationMin === null || distanceKm < 0 || durationMin < 0) {
    return { ...pendingRoute('路线服务未返回完整距离和时间。'), metricProjection: {} }
  }
  const polyline = Array.isArray(value.polyline)
    ? value.polyline
        .filter((point): point is [number, number] => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
        .map((point) => [point[0], point[1]] as [number, number])
    : null
  return {
    status: 'ok',
    source: 'amap',
    distanceKm,
    durationMin,
    polyline: polyline && polyline.length >= 2 ? polyline : null,
    metricProjection,
  }
}

function routeCacheKey(from: CanvasItem, to: CanvasItem): string {
  return `${coordinateKey(from.poi)}>${coordinateKey(to.poi)}`
}

function coordinateKey(poi: CanvasItem['poi']): string {
  if (!poi) return 'none'
  return `${roundCoordinate(poi.lat)},${roundCoordinate(poi.lng)}`
}

function roundCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(5) : 'invalid'
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback
}

function usablePoi(item: CanvasItem): boolean {
  const poi = item.poi
  return poi !== null && Number.isFinite(poi.lat) && Number.isFinite(poi.lng) && !(poi.lat === 0 && poi.lng === 0)
}
