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

/* ------------------------------------------------------------------ *
 * Accommodation domain (ticket 04 part A) — types only. The state
 * machine lives in src/domain/accommodation.ts; the storage codec in
 * src/domain/storage.ts; the React provider in src/hooks/useAccommodation.tsx.
 * Notes: B-accommodation-core.md §1 (domain model) and §4 (business rules).
 * ------------------------------------------------------------------ */

export type AccommodationBaseType = 'area' | 'hotel'

/**
 * Canonical base shape. Custom bases are produced by `normalizeBase` and
 * always have `isDefault: false` and `createdAt`. Default bases additionally
 * carry a `routeName` (town name used as the AMap keyword) but have no
 * `createdAt`; backup-sourced bases may lack `createdAt`/`isDefault` until
 * normalized (note B §1.3/§1.4, gotcha 7).
 */
export interface AccommodationBase {
  id: string
  name: string
  type: AccommodationBaseType
  /** WGS-84 */
  lat: number
  /** WGS-84 */
  lng: number
  address?: string
  notes?: string
  createdAt?: string
  isDefault: boolean
  /** default bases only: the town/area keyword used for AMap search. */
  routeName?: string
}

/**
 * Single authoritative accommodation state (note B §1.4).
 * `stays` maps overnight day index → base id and holds ONLY overrides:
 * an absent night resolves to its default stay. `bases` holds custom bases
 * only — defaults live in the domain constants.
 */
export interface AccommodationState {
  version: 1
  bases: AccommodationBase[]
  stays: Record<number, string>
}

export type AccommodationChangeType = 'assign' | 'create' | 'update' | 'delete' | 'restore'

/** Change event emitted after every committed mutation (note B §3.1 notify). */
export interface AccommodationChangeEvent {
  type: AccommodationChangeType
  /** affected overnight nights (the changed stay indices). */
  dayIndices: number[]
  /** day indices whose route endpoints changed — `{N, N+1}` per changed night. */
  routeDays: number[]
  base?: AccommodationBase
  previousBase?: AccommodationBase
  changed?: number[]
  /** true for whole-state restore (backup import) — legacy shows pending copy. */
  fromImport?: boolean
}

/** Route endpoint kinds — `kind` is the TS port's discriminator (legacy has no field). */
export type RouteEndpointKind = 'base' | 'point' | 'keyword'

/**
 * One route endpoint (note B §4.4 — from/to/via shapes).
 * - `base`: a stay endpoint, resolved through `getDayStay` (owns id/type/address/isCustom/isChanged);
 * - `point`: real `plan.points` geometry (day 0 from / last-day to / mid-points; may lack id);
 * - `keyword`: keyword-only stop (`nav-{index}` on days 1–2, `keywordOnly: true`, note B gotcha 9)
 *   — never carries coordinates in the domain (AMap resolves them).
 */
export interface RouteEndpoint {
  id?: string
  name: string
  routeName: string
  type?: AccommodationBaseType
  /** WGS-84 — absent only on keyword-only stops. */
  lat?: number
  /** WGS-84 — absent only on keyword-only stops. */
  lng?: number
  address?: string
  isCustom: boolean
  isChanged?: boolean
  keyword?: string
  city?: string
  keywordOnly?: boolean
  kind: RouteEndpointKind
}

/** Route for one day: from → via… → to (note B §1.6). */
export interface AccommodationDayRoute {
  from: RouteEndpoint | null
  to: RouteEndpoint | null
  via: RouteEndpoint[]
  stops: RouteEndpoint[]
  hasCustomEndpoint: boolean
  hasChangedEndpoint: boolean
}

/** Backup-sourced base — the export/import schema (no `isDefault`; `createdAt` optional). */
export interface AccommodationBackupBase {
  id: string
  name: string
  type: AccommodationBaseType
  lat: number
  lng: number
  address?: string
  notes?: string
  createdAt?: string
}

/** Validated backup payload (note B §2.1 / getBackup). */
export interface AccommodationBackup {
  format: 'hailar-slow-trip-accommodation'
  version: 1
  bases: AccommodationBackupBase[]
  stays: Record<number, string>
}