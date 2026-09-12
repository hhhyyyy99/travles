import type { RoutePoint, RouteLegResult, RouteLegSearch } from './types.js'
import { mapItemRow, mapLegRow } from '../days/repository.js'
import type { CanvasItem, CanvasLeg } from '../days/types.js'
import type { ItemsAdminStoreDriver } from '../items-admin/types.js'
import { gcj02ToWgs84LngLat, wgs84ToGcj02LngLat } from './geo.js'

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
    const response = await fetch(`https://restapi.amap.com/v3/direction/driving?${params.toString()}`)
    if (!response.ok) return pendingRoute('路线服务暂不可用。')
    const payload = (await response.json()) as unknown
    return parseAmapRoute(payload)
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
): Promise<{ ok: true; legs: CanvasLeg[] } | { ok: false; error: string }> {
  let itemRows: Awaited<ReturnType<ItemsAdminStoreDriver['listItemRows']>>
  let legRows: Awaited<ReturnType<ItemsAdminStoreDriver['listLegRows']>>
  try {
    ;[itemRows, legRows] = await Promise.all([driver.listItemRows(tripId), driver.listLegRows(tripId)])
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
  const next: CanvasLeg[] = []
  const byDay = new Map<string, CanvasItem[]>()
  for (const item of items) {
    const bucket = byDay.get(item.dayId)
    if (bucket) bucket.push(item)
    else byDay.set(item.dayId, [item])
  }

  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    for (let index = 1; index < bucket.length; index += 1) {
      const from = bucket[index - 1]!
      const to = bucket[index]!
      const id = `leg-${from.id}-${to.id}`
      const old = byPair.get(`${from.id}|${to.id}`)
      const route = await lookupRoute(provider, from, to)
      if (route.status === 'ok' && route.distanceKm !== null && route.durationMin !== null) {
        next.push({
          id,
          fromItemId: from.id,
          toItemId: to.id,
          mode: 'drive',
          distanceKm: route.distanceKm,
          durationMin: route.durationMin,
          polyline: route.polyline,
        })
      } else {
        next.push({
          id,
          fromItemId: from.id,
          toItemId: to.id,
          mode: old?.mode ?? 'drive',
          distanceKm: old?.distanceKm ?? 0,
          durationMin: old?.durationMin ?? 0,
          polyline: old?.polyline ?? null,
        })
      }
    }
  }

  try {
    await driver.replaceLegs(tripId, next)
  } catch {
    return { ok: false, error: '保存路线失败。' }
  }
  return { ok: true, legs: next }
}

async function lookupRoute(provider: RouteLegSearch, from: CanvasItem, to: CanvasItem): Promise<RouteLegResult> {
  if (!usablePoi(from) || !usablePoi(to)) return pendingRoute('起点或终点没有可用坐标。')
  try {
    return await provider({
      from: { name: from.poi?.name, lat: from.poi?.lat ?? 0, lng: from.poi?.lng ?? 0 },
      to: { name: to.poi?.name, lat: to.poi?.lat ?? 0, lng: to.poi?.lng ?? 0 },
    })
  } catch {
    return pendingRoute('路线服务暂不可用。')
  }
}

function usablePoi(item: CanvasItem): boolean {
  const poi = item.poi
  return poi !== null && Number.isFinite(poi.lat) && Number.isFinite(poi.lng) && !(poi.lat === 0 && poi.lng === 0)
}
