/**
 * Print-sheet derivations (ticket 08) — pure port of the legacy
 * `accommodation-print.js` (routeInfo L19–54, scheduleFor L56–63,
 * stayMarkup L65–70, render L72–91) on top of the authoritative
 * accommodation/route-state modules. No DOM, no React, no duplicated data
 * copy: the print component maps these values straight into the legacy
 * print markup, and the labels here are the exact legacy strings.
 *
 * Route-label precedence (exact strings, accommodation-print.js L25–46):
 *   1. updated  — status 'updated' + finite distance:
 *      `已更新 N.N km · <durationText|驾车时间已更新>`
 *   2. stale    — status ∈ {stale,pending,unupdated} or changed endpoint:
 *      `路线未更新` + pending/otherwise note (an unupdated route NEVER shows
 *      its old estimate as current — the stale branch wins over the static
 *      leg reference).
 *   3. localDay — day.points.length < 2: `当天不安排长途驾驶`
 *   4. reference — roadRoutes leg → `参考里程约 N km · G.. → S..`,
 *      else day.drive, else `以高德实时规划为准`.
 *   5. area stays/endpoints append `住宿区域按代表位置估算。` to the note.
 */
import { tripPlan } from '../data/itinerary'
import { roadRoutes } from '../data/roadRoutes'
import { getDayRoute, getDayStay, inUseBaseCount, overnightDays } from './accommodation'
import { routeStateOrDefault, type RouteState } from './routeStates'
import type { AccommodationState, ItineraryDay } from './types'

/** Legacy `staleStatuses` set (accommodation-print.js L2). */
const staleStatuses = new Set<RouteState['status']>(['stale', 'pending', 'unupdated'])

export interface PrintRouteInfo {
  from: string
  to: string
  label: string
  note: string
  stale: boolean
  status: string
}

/**
 * Per-day print route block — exact port of `routeInfo`
 * (accommodation-print.js L19–54). Route status semantics reuse the shared
 * domain (`getDayRoute`, `routeStateOrDefault`, `isStaleStatus`); the plan
 * data and static legs come from the same modules the interactive UI uses.
 */
export function printRouteInfo(
  state: AccommodationState,
  routeStates: Record<number, RouteState>,
  dayIndex: number,
): PrintRouteInfo {
  const day: ItineraryDay | undefined = tripPlan.days[dayIndex]
  const route = getDayRoute(state, dayIndex)
  const routeState = routeStateOrDefault(routeStates, dayIndex)
  const updated = routeState.status === 'updated' && Number.isFinite(Number(routeState.distance))
  const changed = Boolean(route?.hasChangedEndpoint)
  const stale = !updated && (staleStatuses.has(routeState.status) || changed)
  const localDay = (day?.points?.length ?? 0) < 2
  const stay = getDayStay(state, dayIndex)
  const from = route?.from?.name || day?.nav?.[0] || ''
  const to = route?.to?.name || day?.nav?.[1] || ''
  let label: string
  let note = ''

  if (updated) {
    const distance = (Number(routeState.distance) / 1000).toFixed(1)
    label = `已更新 ${distance} km · ${String(routeState.durationText ?? '').trim() || '驾车时间已更新'}`
  } else if (stale) {
    label = '路线未更新'
    note =
      routeState.status === 'pending'
        ? '住宿端点已变化，路线正在重新查询。'
        : '住宿端点已变化，当前没有可用的新路线结果，请出发前重新查询。'
  } else if (localDay) {
    label = '当天不安排长途驾驶'
    note = '市内移动以当天安排为准。'
  } else {
    const leg = roadRoutes.legs[dayIndex]
    const roads = leg?.roads?.filter((road) => /^[GS]\d/.test(road)).join(' → ')
    label = leg
      ? `参考里程约 ${(leg.distance / 1000).toFixed(0)} km${roads ? ` · ${roads}` : ''}`
      : String(day?.drive ?? '').trim() || '以高德实时规划为准'
    note = '里程与时间为规划参考，出发前请以实时导航为准。'
  }

  if (stay?.type === 'area' || route?.from?.type === 'area' || route?.to?.type === 'area') {
    note = `${note ? `${note} ` : ''}住宿区域按代表位置估算。`
  }

  return {
    from,
    to,
    label,
    note,
    stale,
    status: updated ? 'updated' : stale ? 'unupdated' : routeState.status,
  }
}

/**
 * Schedule rows for print: while the day's route is stale, each row gains
 * the reminder text (accommodation-print.js `scheduleFor` L56–63).
 */
export function printScheduleRows(
  day: ItineraryDay,
  stale: boolean,
): Array<[time: string, title: string, description: string]> {
  if (!stale) return day.schedule
  return day.schedule.map(([time, title]) => [time, title, '当前住宿端点的路线未更新，出发前请重新查询。'])
}

/** `第 N 晚住宿` label (index + 1), exact legacy wording. */
export function printStayLabel(dayIndex: number): string {
  return `第 ${dayIndex + 1} 晚住宿`
}

export interface PrintSheetSummary {
  /** total overnight nights — always 6 for the shipped plan. */
  nightCount: number
  /** distinct bases actually used by the nights (`getBaseCount`). */
  usedBaseCount: number
  /** any night using an area-typed base → header disclaimer variant. */
  areaUsed: boolean
}

/** Header summary (render L76–79) — all values from the authoritative domain. */
export function printSheetSummary(state: AccommodationState): PrintSheetSummary {
  const stays = overnightDays.map((index) => getDayStay(state, index)).filter((stay) => stay !== null)
  return {
    nightCount: overnightDays.length,
    usedBaseCount: inUseBaseCount(state),
    areaUsed: stays.some((stay) => stay.type === 'area'),
  }
}