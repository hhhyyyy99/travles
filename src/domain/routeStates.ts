/**
 * Route-state store (ticket 03) — the single per-day route status machine.
 *
 * Port of the `routeStates` Map + `markRouteStatus` writer (accommodation.js
 * :303–352) plus the `routeDescription` / drive-text / note / legend string
 * precedence of trip.js:52–60, 69–73, 186 and amap-integration.js statuses.
 *
 * Lifecycle: `reference → stale → pending → updated | unupdated`.
 * - `pending` on query start (per-day `token` bumped → later writes gate on it);
 * - `updated` with data markers; `unupdated` on service failure;
 * - `stale` arrives with accommodation changes (ticket 04) — the plumbing (token
 *   gate, isStaleStatus, navigation invalidation) is already in place here.
 *
 * Pure functions, no hidden state — records are passed in and replaced.
 */
import type { LatLng, RouteStatus } from './types'

/** Markers attached to a route state (legacy markRouteStatus `details`). */
export interface RouteStateDetails {
  /** meters */
  distance?: number
  /** seconds */
  duration?: number
  durationText?: string
  /** WGS-84 [lat, lng] pairs of the changed-endpoint route. */
  coordinates?: LatLng[]
  /** resolved navigation hrefs after a successful live query. */
  navigation?: { primary: string; current: string } | undefined
}

export interface RouteState extends RouteStateDetails {
  status: RouteStatus
  /** per-day staleness token — incremented on every pending transition. */
  token: number
  requestedAt?: number
  validUntil?: number
}

export const ROUTE_REFRESH_INTERVAL_MS = 180000
export const ROUTE_QUERY_TIMEOUT_MS = 20000
export const ROUTE_OVERVIEW_TIMEOUT_MS = 60000

export function createInitialRouteStates(dayCount: number): Record<number, RouteState> {
  const states: Record<number, RouteState> = {}
  for (let day = 0; day < dayCount; day += 1) states[day] = { status: 'reference', token: 0 }
  return states
}

export function routeStateOrDefault(states: Record<number, RouteState>, day: number): RouteState {
  return states[day] ?? { status: 'reference', token: 0 }
}

export function isStaleStatus(status: RouteStatus): boolean {
  return status === 'stale' || status === 'pending' || status === 'unupdated'
}

export function isChangedEndpointState(state: RouteState): boolean {
  return state.status === 'updated' && Number.isFinite(state.distance)
}

/**
 * Pending transition: clears navigation and bumps the per-day token so any
 * response captured against an older token is rejected at write time.
 */
export function beginRequest(states: Record<number, RouteState>, dayIndices: number[]): Record<number, RouteState> {
  const next = { ...states }
  for (const raw of dayIndices) {
    const day = Number(raw)
    const current = next[day]
    if (!current) continue
    next[day] = {
      ...current,
      status: 'pending',
      token: current.token + 1,
      requestedAt: Date.now(),
      navigation: undefined,
    }
  }
  return next
}

/**
 * Single writer (port of accommodation.js `markRouteStatus` :349–352).
 * When `expectedToken` is given, a write whose day token moved on (a newer
 * query started) is discarded — stale responses never land.
 */
export function markRouteStatus(
  states: Record<number, RouteState>,
  dayIndices: number[],
  status: RouteStatus,
  details: RouteStateDetails = {},
  expectedToken?: number,
): Record<number, RouteState> {
  let changed = false
  const next = { ...states }
  for (const raw of dayIndices) {
    const day = Number(raw)
    const current = next[day]
    if (!current) continue
    if (expectedToken !== undefined && current.token !== expectedToken) continue
    const patch: RouteState = { ...current, ...details, status }
    if (status === 'updated' && patch.validUntil === undefined) {
      patch.validUntil = (patch.requestedAt ?? Date.now()) + ROUTE_REFRESH_INTERVAL_MS
    }
    next[day] = patch
    changed = true
  }
  return changed ? next : states
}

/* ------------------------------------------------------------------ *
 * Label builders — exact legacy strings (trip.js / note A §5 & §7.16). *
 * ------------------------------------------------------------------ */

export interface StaticLegLike {
  /** meters */
  distance: number
  /** road names, filtered to G/S roads at render time. */
  roads: string[]
}

/** `routeDescription` precedence (trip.js:54–55): updated → stale → static leg → urban. */
export function describeRouteEstimate(state: RouteState, leg: StaticLegLike | null): string {
  if (isChangedEndpointState(state)) {
    return `已更新 ${((state.distance ?? 0) / 1000).toFixed(1)} km · ${state.durationText || '驾车时间已更新'}`
  }
  if (isStaleStatus(state.status)) return '路线未更新'
  if (leg) {
    const roads = leg.roads.filter((road) => /^[GS]\d/.test(road)).join(' → ')
    return `参考里程约 ${(leg.distance / 1000).toFixed(0)} km${roads ? ` · ${roads}` : ''}`
  }
  return '市内目的地 · 以高德实时规划为准'
}

/** detail `driveText` (trip.js:69–70). */
export function describeDriveText(state: RouteState, fallback: string): string {
  if (isStaleStatus(state.status)) return '路线未更新'
  if (isChangedEndpointState(state)) {
    return `已更新 ${((state.distance ?? 0) / 1000).toFixed(1)} km · ${state.durationText || '驾车时间已更新'}`
  }
  return fallback
}

/** schedule-row driving-text rewrite (trip.js:73). */
export function rewriteScheduleRow(row: string, routeChanged: boolean): string {
  return routeChanged ? row.replace(/约[^，。]*驾驶/g, '路线未更新，待重新查询') : row
}

/**
 * `routeNote` (trip.js:56–60) — accommodation-absent branch for ticket 03;
 * ticket 04 threads the changed-endpoint area suffix through here.
 */
export function describeRouteNote(state: RouteState, localDay: boolean): string {
  if (isStaleStatus(state.status)) {
    return `住宿端点已变化，${state.status === 'pending' ? '正在重新查询路线。' : '当前没有可用的新路线结果，请连接高德地图后重试。'}`
  }
  if (localDay) return '当天不安排长途驾驶，景区内交通以观光车及酒店接驳为准。'
  return '起终点为区域参考位置，请在高德中确认酒店、景区入口或航站楼。手机可调起高德；当前位置导航需要手机定位。'
}

/** `.map-legend` strings (trip.js:186 + fit). `changedEndpoint` arrives with accommodation (ticket 04). */
export function legendTextFor(roadPresent: boolean, changedEndpoint = false): string {
  if (roadPresent) return changedEndpoint ? '高德路线已更新' : '行程连线示意 · 非道路导航'
  return changedEndpoint ? '住宿已更换 · 路线未更新' : '市区目的地 · 高德实时规划路线'
}