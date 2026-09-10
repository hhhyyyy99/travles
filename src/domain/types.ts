/**
 * Shared domain types for the React/TS port (ticket 02).
 *
 * Coordinate conventions (locked in the legacy sources, note A §7):
 * - `points.xy` is [lat, lng] (trip-plan.js).
 * - `road-routes.js` coordinates are [lng, lat] — converted exactly once at
 *   the Leaflet/AMap boundary (legacy trip.js:84).
 */

/** [lat, lng] — leaflet-facing order, used by `tripPlan.points.xy`. */
export type LatLng = [number, number]

/** [lng, lat] — AMap/road-routes order. */
export type LngLat = [number, number]

/** Schedule row: [time, title, detail] — exact legacy tuple (trip-plan.js). */
export type ScheduleRow = [time: string, title: string, detail: string]

export interface ViaPoint {
  keyword: string
  city: string
}

/** 15-field day object; field order matches the legacy literal (note A §2). */
export interface ItineraryDay {
  date: string
  weekday: string
  title: string
  short: string
  drive: string
  stay: string
  alt: string
  pace: string
  /** keys into `TripPlan.points` */
  points: string[]
  /** [fromName, toName] */
  nav: [string, string]
  /** [fromCity, toCity] (always 呼伦贝尔市 today) */
  cities: [string, string]
  /** present only on days 1,3,4,5 */
  via?: ViaPoint[]
  desc: string
  schedule: ScheduleRow[]
  tip: string
}

export interface TripPoint {
  name: string
  xy: LatLng
}

export interface TripEstimate {
  title: string
  time: string
  day: number
}

export interface OverviewStop {
  keyword: string
  city: string
}

export interface TripPlan {
  days: ItineraryDay[]
  points: Record<string, TripPoint>
  estimates: TripEstimate[]
  overviewStops: OverviewStop[]
}

export interface RoadRouteWaypoint {
  coordinates: LngLat
}

export interface RoadRouteLeg {
  /** meters */
  distance: number
  /** seconds */
  duration: number
  coordinates: LngLat[]
  roads: string[]
}

export interface RoadRoutes {
  provider: string
  retrieved: string
  waypoints: RoadRouteWaypoint[]
  legs: RoadRouteLeg[]
}

/** Route statuses of the accommodation/AMap route-state machine (tickets 03+). */
export type RouteStatus = 'reference' | 'stale' | 'pending' | 'unupdated' | 'updated'