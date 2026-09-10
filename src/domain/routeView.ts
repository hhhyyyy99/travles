/**
 * Route-view selectors (ticket 04 part C) — the accommodation ↔ route-state
 * bridge that drives geometry, legend, overview labels and the summary strip.
 *
 * Ports of trip.js `routeGeometry`/`routeIsStale` (:88–99), the `choose`
 * coords source (:173–176), `showTimeLabels` (:110–125), `.map-legend`
 * (:186), `showOverviewTimes` (:151–166) and `updateAccommodationSummary`
 * distance logic (:195–209). Pure functions — no DOM, no React, no hidden
 * state; state objects are passed in.
 *
 * Endpoint source of truth: every selector resolves day-route endpoints
 * through `getDayRoute` (accommodation domain) — nothing here re-derives or
 * duplicates the from/via/to shapes.
 */
import { dayPointCoords, tripPlan } from '../data/itinerary'
import { legByDay, roadLines, roadRoutes } from '../data/roadRoutes'
import { hasCoordinates } from './geo'
import { getDayRoute } from './accommodation'
import { isStaleStatus, legendTextFor, routeStateOrDefault, type RouteState } from './routeStates'
import type { AccommodationState, LatLng, RouteEndpoint } from './types'

/**
 * Per-day route geometry for the Leaflet layers (trip.js:88–95):
 * a changed-endpoint day draws only the AMap-updated WGS-84 `coordinates`
 * once the route is `updated`; otherwise the static reference leg — unless
 * the route is stale/pending/unupdated, in which case the day's polyline
 * is dropped entirely (null).
 */
export function routeGeometry(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
  dayIndex: number,
): LatLng[] | null {
  const route = getDayRoute(state, dayIndex)
  const routeState = routeStateOrDefault(routeStates, dayIndex)
  if (route?.hasChangedEndpoint) {
    return routeState.status === 'updated' &&
      Array.isArray(routeState.coordinates) &&
      routeState.coordinates.length > 1
      ? routeState.coordinates
      : null
  }
  if (isStaleStatus(routeState.status)) return null
  const legIndex = legByDay[dayIndex]
  return legIndex != null ? (roadLines[legIndex] ?? null) : null
}

/** trip.js:96–99 — no geometry, or a stale/not-updated status, means stale. */
export function routeIsStale(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
  dayIndex: number,
): boolean {
  const routeState = routeStateOrDefault(routeStates, dayIndex)
  return !routeGeometry(state, routeStates, dayIndex) || isStaleStatus(routeState.status)
}

/**
 * `choose` endpoint markers (trip.js:173–176): the accommodation route's
 * from/via/to points that carry coordinates; without a route, the day's
 * plan points.
 */
export function routeCoordsForDay(state: AccommodationState, dayIndex: number): LatLng[] {
  const route = getDayRoute(state, dayIndex)
  if (!route) return dayPointCoords(dayIndex)
  return [route.from, ...route.via, route.to]
    .filter((point): point is RouteEndpoint => Boolean(point) && hasCoordinates(point))
    .map((point) => [point.lat!, point.lng!])
}

/** All daily geometries for the full-route layer (trip.js `renderFullRoute`). */
export function allRouteGeometries(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
): LatLng[][] {
  return tripPlan.days.flatMap((_, index) => {
    const geometry = routeGeometry(state, routeStates, index)
    return geometry ? [geometry] : []
  })
}

/**
 * Time-label entry for the selected day (trip.js showTimeLabels :110–125,
 * 188): a changed-endpoint day labels the route with its endpoint names and
 * the AMap duration (高德路线); an unchanged day keeps the static estimate.
 */
export function timeLabelForDay(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
  dayIndex: number,
): { index: number; title: string; time: string; coordinates: LatLng[]; source?: string } | null {
  const geometry = routeGeometry(state, routeStates, dayIndex)
  if (!geometry) return null
  const route = getDayRoute(state, dayIndex)
  const routeState = routeStateOrDefault(routeStates, dayIndex)
  const estimate = tripPlan.estimates[dayIndex]
  const changed = Boolean(route?.hasChangedEndpoint)
  if (changed) {
    return {
      index: dayIndex,
      title: route?.from && route.to ? `${route.from.name} → ${route.to.name}` : estimate?.title ?? '',
      time: routeState.durationText || '已更新',
      coordinates: geometry,
      source: '高德路线',
    }
  }
  return {
    index: dayIndex,
    title: estimate?.title ?? '',
    time: estimate?.time ?? '',
    coordinates: geometry,
  }
}

/**
 * Per-day `#overview-times` labels (trip.js showOverviewTimes :151–166):
 * static estimate normally; a changed-endpoint day shows `路线未更新`/`待查询`
 * while stale and the resolved endpoint names + duration once updated.
 */
export function overviewTimesLabels(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
): Array<{ day: number; title: string; time: string }> {
  return tripPlan.estimates.map((estimate) => {
    const route = getDayRoute(state, estimate.day)
    const routeState = routeStateOrDefault(routeStates, estimate.day)
    const changed = Boolean(route?.hasChangedEndpoint)
    const stale = routeIsStale(state, routeStates, estimate.day)
    if (!changed) {
      return { day: estimate.day, title: estimate.title, time: estimate.time }
    }
    return {
      day: estimate.day,
      title: stale ? '路线未更新' : route?.from && route.to ? `${route.from.name} → ${route.to.name}` : estimate.title,
      time: stale ? '待查询' : routeState.durationText || '已更新',
    }
  })
}

/**
 * `#distance-summary` (trip.js updateAccommodationSummary :195–209): hardcoded
 * `约 1,000–1,100 km` when no endpoint changed; when changed, the sum of the
 * updated days' distances plus the unchanged days' static leg distances —
 * `路线未更新` while any changed day is incomplete.
 */
export function summaryDistance(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
): string {
  let changed = false
  let complete = true
  let total = 0
  tripPlan.days.forEach((_, index) => {
    const route = getDayRoute(state, index)
    const routeState = routeStateOrDefault(routeStates, index)
    if (route?.hasChangedEndpoint) {
      changed = true
      const distance = routeState.distance
      if (routeState.status === 'updated' && typeof distance === 'number' && Number.isFinite(distance)) total += distance
      else complete = false
    } else if (roadRoutes.legs[index]) {
      total += Number(roadRoutes.legs[index].distance) || 0
    }
  })
  return changed ? (complete ? `约 ${Math.round(total / 1000)} km` : '路线未更新') : '约 1,000–1,100 km'
}

/**
 * `.map-legend` selection (trip.js:186) — `roadPresent` + changed-endpoint
 * flag pick the exact legacy variant (routeStates `legendTextFor`).
 */
export function legendForDay(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
  dayIndex: number,
): string {
  return legendTextFor(
    routeGeometry(state, routeStates, dayIndex) !== null,
    Boolean(getDayRoute(state, dayIndex)?.hasChangedEndpoint),
  )
}

/**
 * Navigation-panel display names (trip.js:52): the resolved route names when
 * the day's endpoint changed, else the plan's `nav` labels. (The pre-existing
 * ticket-02/03 suites lock the plan labels for unchanged days.)
 */
export function routeDisplayNames(
  state: AccommodationState,
  dayIndex: number,
): { from: string; to: string } {
  const day = tripPlan.days[dayIndex]
  const fallbackFrom = day?.nav[0] ?? ''
  const fallbackTo = day?.nav[1] ?? ''
  const route = getDayRoute(state, dayIndex)
  if (!route?.hasChangedEndpoint) return { from: fallbackFrom, to: fallbackTo }
  return { from: route.from?.name || fallbackFrom, to: route.to?.name || fallbackTo }
}