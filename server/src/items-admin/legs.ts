/**
 * Legs recompute (ticket 09) — a pure, unit-testable derivation of the
 * trip's leg rows after any card layout change (drag reorder, 上移/下移,
 * 跨天移动/复制, add, delete).
 *
 * ## Convention (documented for ticket 15's routing tools)
 *
 * - Legs connect **adjacent items within one day** — the same per-day route
 *   model the canvas chips and the map panel draw. Cross-day jumps produce
 *   no leg rows.
 * - **Reuse first:** an already-stored leg for the same ordered (from, to)
 *   item pair keeps its mode/distance/duration/polyline verbatim. A reversed
 *   pair is never replayed: one-way road geometry and driving time can change
 *   with direction, so it falls through to the explicit estimate until the
 *   route provider refreshes it.
 * - **Estimate fallback:** when no stored leg exists for the pair but both
 *   items carry usable POI coordinates, the leg is an estimate: haversine
 *   great-circle distance × 1.2 road factor, ~60 km/h ⇒ duration ≈ 1 minute
 *   per km (minimum 1 minute). `polyline` is null (the canvas/map fall back
 *   to straight-line rendering) and `mode` is 'drive'. Ticket 15's
 *   search/route tools can later upgrade these rows to real AMap routing.
 * - **Unknown coordinates** ⇒ distance 0 / duration 0 / null polyline: the
 *   UI hides an empty leg chip (formatLegLabel) instead of inventing numbers.
 *
 * The recompute never throws: corrupt inputs are filtered by the callers'
 * tolerant row mapping before they reach this module.
 */
import type { CanvasItem, CanvasLeg, PoiRef } from '../days/types.js'

/**
 * A planned leg row ready for storage — structurally the canvas leg shape
 * (deterministic id included), kept as a named alias so driver seams can
 * talk about "the recomputed set" without reaching into the read module.
 */
export type PlannedLeg = CanvasLeg

/** Road-distance inflation over the straight-line estimate. */
const ROAD_FACTOR = 1.2
/** ~60 km/h ⇒ roughly one minute of driving per kilometre. */
const KM_PER_MINUTE = 1
const EARTH_RADIUS_KM = 6371

/**
 * Re-derive the whole trip's legs from the ordered items. `items` may be in
 * any order (grouped per day, sorted by order then id); `previousLegs` is the
 * stored leg list the reuse rules read from. Returns one leg per adjacent
 * pair with deterministic ids (`leg-<fromItemId>-<toItemId>`), ready for
 * `replaceLegs`.
 */
export function recomputeTripLegs(items: CanvasItem[], previousLegs: CanvasLeg[]): CanvasLeg[] {
  const byPair = new Map<string, CanvasLeg>()
  for (const leg of previousLegs) {
    if (!leg.fromItemId || !leg.toItemId) continue
    const key = `${leg.fromItemId}|${leg.toItemId}`
    if (!byPair.has(key)) byPair.set(key, leg)
  }

  const byDay = new Map<string, CanvasItem[]>()
  for (const item of items) {
    if (!item.dayId) continue
    const bucket = byDay.get(item.dayId)
    if (bucket) bucket.push(item)
    else byDay.set(item.dayId, [item])
  }

  const legs: CanvasLeg[] = []
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    for (let i = 1; i < bucket.length; i += 1) {
      const from = bucket[i - 1]!
      const to = bucket[i]!
      legs.push(plannedLegFor(from, to, byPair))
    }
  }
  return legs
}

/** Same-ordered-pair reuse → estimate → empty leg. */
function plannedLegFor(from: CanvasItem, to: CanvasItem, byPair: Map<string, CanvasLeg>): CanvasLeg {
  const id = `leg-${from.id}-${to.id}`
  const same = byPair.get(`${from.id}|${to.id}`)
  if (same) {
    return {
      id,
      fromItemId: from.id,
      toItemId: to.id,
      mode: same.mode,
      distanceKm: same.distanceKm,
      durationMin: same.durationMin,
      polyline: same.polyline,
    }
  }
  const estimate = estimateLeg(from.poi, to.poi)
  if (estimate) {
    return { id, fromItemId: from.id, toItemId: to.id, mode: 'drive', ...estimate, polyline: null }
  }
  return { id, fromItemId: from.id, toItemId: to.id, mode: 'drive', distanceKm: 0, durationMin: 0, polyline: null }
}

/**
 * Straight-line estimate for one pair: null when either side lacks usable
 * coordinates (POI attached with finite, non-degenerate lat/lng).
 */
export function estimateLeg(
  from: PoiRef | null,
  to: PoiRef | null,
): { distanceKm: number; durationMin: number } | null {
  const a = usableCoords(from)
  const b = usableCoords(to)
  if (a === null || b === null) return null
  const distanceKm = Math.round(haversineKm(a, b) * ROAD_FACTOR * 10) / 10
  if (distanceKm <= 0) return null
  return { distanceKm, durationMin: Math.max(1, Math.round(distanceKm * KM_PER_MINUTE)) }
}

/** Great-circle distance between two [lng, lat] points, in kilometres. */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const lat1 = toRad(a[1])
  const lat2 = toRad(b[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** [lng, lat] from a PoiRef; null when missing, non-finite, or 0/0. */
function usableCoords(poi: PoiRef | null): [number, number] | null {
  if (!poi) return null
  const { lat, lng } = poi
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat === 0 && lng === 0) return null
  return [lng, lat]
}
