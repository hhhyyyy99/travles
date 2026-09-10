/**
 * WGS-84 ↔ GCJ-02 boundary (see architecture note §2 / 00-architecture §7).
 *
 * Persisted itinerary coordinates are WGS-84 [lat, lng]. GCJ-02 is needed only
 * at the AMap edge. The vendored `public/vendor/coordtransform.js` (classic
 * script, loaded in app.html BEFORE the module script) defines the global
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

export {}