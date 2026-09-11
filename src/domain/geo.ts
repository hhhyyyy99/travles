/**
 * WGS-84 ↔ GCJ-02 boundary (see architecture note §2 / 00-architecture §7).
 *
 * Persisted itinerary coordinates are WGS-84 [lat, lng]. GCJ-02 is needed only
 * at the AMap edge. The vendored `public/vendor/coordtransform.js` (classic
 * script, loaded in index.html BEFORE the module script) defines the global
 * `coordtransform` with `wgs84togcj02(lng, lat)` / `gcj02towgs84(lng, lat)`
 * returning `[lng, lat]` arrays — exactly the legacy call pattern (trip.js:14).
 */

declare global {
  interface Window {
    coordtransform?: {
      wgs84togcj02(lng: number, lat: number): [number, number]
      gcj02towgs84(lng: number, lat: number): [number, number]
    }
  }
}

/**
 * WGS-84 → GCJ-02 for the AMap edge. Input is [lat, lng] (leaflet order),
 * output is [lng, lat] (AMap order), matching legacy `endpoint()` math
 * (trip.js:14): `coordtransform.wgs84togcj02(lng, lat)`.
 */
export function wgs84ToGcj02LngLat(lat: number, lng: number): [number, number] {
  const transform = window.coordtransform
  if (!transform) {
    throw new Error('coordtransform 未加载：请确认 public/vendor/coordtransform.js 在模块脚本之前加载。')
  }
  const [glng, glat] = transform.wgs84togcj02(lng, lat)
  return [glng, glat]
}

/** GCJ-02 [lng, lat] → WGS-84 [lng, lat] (used by later tickets' search/picker). */
export function gcj02ToWgs84LngLat(lng: number, lat: number): [number, number] {
  const transform = window.coordtransform
  if (!transform) {
    throw new Error('coordtransform 未加载：请确认 public/vendor/coordtransform.js 在模块脚本之前加载。')
  }
  return transform.gcj02towgs84(lng, lat)
}

/** Finite numeric check used by the navigation URL builder (legacy trip.js:32). */
export function hasCoordinates(point: { lat?: number | null; lng?: number | null } | undefined | null): boolean {
  return Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lng))
}

/* ------------------------------------------------------------------ *
 * Duplicate-base radius + haversine (accommodation-search.js:2, `distanceMeters`).
 * ------------------------------------------------------------------ */

/** Same normalized name AND <= this distance in meters -> duplicate candidate. */
export const DUPLICATE_DISTANCE_METERS = 1500

/**
 * Haversine distance in meters between two WGS-84 points
 * (accommodation-search.js `distanceMeters`: radius 6371008.8, `Infinity`
 * when either point lacks finite coordinates).
 */
export function distanceMeters(
  first: { lat?: number | null; lng?: number | null } | null | undefined,
  second: { lat?: number | null; lng?: number | null } | null | undefined,
): number {
  const aLat = Number(first?.lat)
  const aLng = Number(first?.lng)
  const bLat = Number(second?.lat)
  const bLng = Number(second?.lng)
  if (!Number.isFinite(aLat) || !Number.isFinite(aLng) || !Number.isFinite(bLat) || !Number.isFinite(bLng)) {
    return Infinity
  }
  const radius = 6371008.8
  const toRadians = (value: number): number => (value * Math.PI) / 180
  const dLat = toRadians(bLat - aLat)
  const dLng = toRadians(bLng - aLng)
  const latA = toRadians(aLat)
  const latB = toRadians(bLat)
  const haversine = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLng / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(Math.min(1, haversine)))
}

export {}