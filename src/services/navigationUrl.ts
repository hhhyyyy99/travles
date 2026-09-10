/**
 * AMap web-navigation / search URL builders — faithful port of trip.js:6,8–31.
 *
 * Ticket 02 runs with no accommodation, so every day falls back to the search
 * URL (legacy `navigationUrl` returns `searchUrl(d.nav[1])` when the route is
 * absent). The full legacy builder (endpoint gcj02 conversion, via handling)
 * is kept so tickets 03+ can thread the accommodation route through it.
 */
import type { ItineraryDay } from '../domain/types'
import { tripPlan } from '../data/itinerary'
import { wgs84ToGcj02LngLat, hasCoordinates } from '../domain/geo'

export const searchUrl = (name: string): string =>
  `https://uri.amap.com/search?keyword=${encodeURIComponent(name)}&callnative=0`

interface RouteEndpoint {
  lat: number
  lng: number
  name: string
}

interface RouteViaPoint extends RouteEndpoint {
  keywordOnly?: boolean
}

/** Shape of the accommodation day-route consumed by the legacy builder (tickets 03+). */
export interface DayRouteLike {
  hasChangedEndpoint?: boolean
  from?: RouteEndpoint
  to?: RouteEndpoint
  via?: RouteViaPoint[]
}

/** `lng6,lat6,name` — legacy `endpoint()` helper (trip.js:12–16). */
function endpoint(point: RouteEndpoint): string {
  const [lng, lat] = wgs84ToGcj02LngLat(point.lat, point.lng)
  return `${lng.toFixed(6)},${lat.toFixed(6)},${point.name}`
}

export function navigationUrl(day: ItineraryDay, currentLocation = false, route?: DayRouteLike | null): string {
  // Legacy: no accommodation route → plain search fallback on the destination.
  if (!route) return searchUrl(day.nav[1])

  const points = tripPlan.points
  const firstKey = day.points[0]
  const lastKey = day.points[day.points.length - 1]
  const first = firstKey ? points[firstKey] : undefined
  const last = lastKey ? points[lastKey] : undefined
  const legacyFrom: RouteEndpoint = { lat: first?.xy[0] ?? 0, lng: first?.xy[1] ?? 0, name: day.nav[0] }
  const legacyTo: RouteEndpoint = { lat: last?.xy[0] ?? 0, lng: last?.xy[1] ?? 0, name: day.nav[1] }

  const changedEndpoint = Boolean(route.hasChangedEndpoint)
  const from: RouteEndpoint = changedEndpoint && route.from ? route.from : legacyFrom
  const to: RouteEndpoint = changedEndpoint && route.to ? route.to : legacyTo

  const params = new URLSearchParams({
    to: endpoint(to),
    mode: 'car',
    policy: '1',
    src: 'hailar-slow-trip',
    callnative: '1',
  })
  if (!currentLocation) params.set('from', endpoint(from))

  const midKey = day.points[1]
  const mid = midKey ? points[midKey] : undefined
  const viaCandidates: RouteViaPoint[] = changedEndpoint
    ? route.via ?? []
    : day.points.length > 2 && mid
      ? [{ lat: mid.xy[0], lng: mid.xy[1], name: mid.name }]
      : []
  const via = viaCandidates.find((point) => hasCoordinates(point))
  if (via) params.set('via', endpoint(via))

  return `https://uri.amap.com/navigation?${params}`
}

/** Navigation note when the route has more vias than the external link allows (trip.js:35–41). */
export function navigationLimitNote(route?: DayRouteLike | null): string {
  const via = route?.via ?? []
  const notes: string[] = []
  if (via.length > 1) notes.push('外部高德链接最多保留一个途经点；页面路线仍按全部景点顺序查询。')
  const keywordOnly = via.filter((point) => point.keywordOnly || !hasCoordinates(point))
  if (keywordOnly.length) {
    notes.push(
      `${keywordOnly.map((point) => point.name).join('、')}没有使用镇中心坐标，外部链接已省略该途经点，请通过旁边的景点搜索链接确认入口。`,
    )
  }
  return notes.join(' ')
}