/**
 * Workbench map linkage — pure logic (ticket 05).
 *
 * Turns the canonical canvas shapes (Day/Item/Leg) into everything the map
 * panel draws: per-day route geometry (leg polyline → WGS-84 [lng,lat] pairs
 * converted to [lat,lng] here at the domain boundary, straight-line fallback
 * when a leg carries no geometry), per-day mileage (sum of the day's leg
 * distances), direction ticks, the ordered POI sequence per day, and the
 * zoom-dependent collision set for POI markers. No Leaflet / React here —
 * see src/services/workbenchMap.ts for the drawing side.
 */

import { crossDayTransfer, dayAccentColor, dayDateLabel, legQuality, legsByPair, weekdayLabel, type WorkbenchDay, type WorkbenchLeg } from './workbench'

export type LatLng = [number, number]

/** One leg's driving geometry as [lat, lng][]; null → caller falls back to a straight line. */
export function legPolylineLatLng(leg: WorkbenchLeg | null): LatLng[] | null {
  if (!leg?.polyline) return null
  const coords = leg.polyline
    .filter((pair) => pair.length >= 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
    .map((pair) => [pair[1]!, pair[0]!] as LatLng)
  return coords.length >= 2 ? coords : null
}

function itemCoords(item: { poi: { lat: number; lng: number } | null }): LatLng | null {
  const poi = item.poi
  if (!poi || !Number.isFinite(poi.lat) || !Number.isFinite(poi.lng)) return null
  if (poi.lat === 0 && poi.lng === 0) return null
  return [poi.lat, poi.lng]
}

/** Items of a day in stable order (order asc, list order as tiebreak). */
export function dayItemsInOrder(day: WorkbenchDay): WorkbenchDay['items'] {
  return [...day.items].sort((a, b) => a.order - b.order)
}

/**
 * Per-day route as contiguous segments. Adjacent items contribute their leg's
 * polyline when present — even across traffic/other cards without POI
 * coordinates (the leg geometry spans them); pairs without geometry fall back
 * to a straight line between the two POIs; a gap without any geometry breaks
 * the chain and starts a new segment.
 */
export function dayRouteSegments(day: WorkbenchDay, legs: WorkbenchLeg[], previousDay?: WorkbenchDay): LatLng[][] {
  const lookup = legsByPair(legs)
  const items = dayItemsInOrder(day)
  const segments: LatLng[][] = []
  let current: LatLng[] | null = null
  const push = (piece: LatLng[]): void => {
    if (!current) {
      current = [...piece]
      segments.push(current)
      return
    }
    for (const point of piece) {
      const last = current[current.length - 1]
      if (!last || last[0] !== point[0] || last[1] !== point[1]) current.push(point)
    }
  }
  const incoming = previousDay ? crossDayTransfer(previousDay, day, legs) : null
  if (incoming && items.length > 0) {
    const geometry = legPolylineLatLng(incoming.leg)
    const previousItems = previousDay ? dayItemsInOrder(previousDay) : []
    const from = previousItems[previousItems.length - 1]
    const fromLL = from ? itemCoords(from) : null
    const toLL = itemCoords(items[0]!)
    if (geometry) push(geometry)
    else if (fromLL && toLL) push([fromLL, toLL])
  }
  for (let i = 1; i < items.length; i++) {
    const from = items[i - 1]
    const to = items[i]
    const leg = lookup.get(`${from?.id}|${to?.id}`) ?? null
    const geometry = legPolylineLatLng(leg)
    if (geometry) {
      push(geometry)
      continue
    }
    const fromLL = from ? itemCoords(from) : null
    const toLL = to ? itemCoords(to) : null
    if (fromLL && toLL) push([fromLL, toLL])
    else current = null
  }
  return segments
}

/** All draw coordinates for a day (segments flattened + POI points) — fit bounds input. */
export function dayFitCoordinates(day: WorkbenchDay, legs: WorkbenchLeg[], previousDay?: WorkbenchDay): LatLng[] {
  const points = dayRouteSegments(day, legs, previousDay).flat()
  for (const item of dayItemsInOrder(day)) {
    const coords = itemCoords(item)
    if (coords) points.push(coords)
  }
  return points
}

/** Whole-trip fit coordinates (every day). */
export function tripFitCoordinates(days: WorkbenchDay[], legs: WorkbenchLeg[]): LatLng[] {
  return days.flatMap((day, index) => dayFitCoordinates(day, legs, days[index - 1]))
}

/** Sum of the leg distances between a day's adjacent items ("日里程"). */
export function dayMileageKm(day: WorkbenchDay, legs: WorkbenchLeg[], previousDay?: WorkbenchDay): number {
  const lookup = legsByPair(legs)
  const items = dayItemsInOrder(day)
  let total = 0
  const incoming = previousDay ? crossDayTransfer(previousDay, day, legs) : null
  if (incoming) total += incoming.distanceKm
  for (let i = 1; i < items.length; i++) {
    const leg = lookup.get(`${items[i - 1]?.id}|${items[i]?.id}`) ?? null
    if (leg) total += leg.distanceKm
  }
  return total
}

export type RouteDisplayQuality = 'measured' | 'estimate' | 'pending'

/**
 * Route quality for map labels. A missing/empty leg remains pending; a leg
 * without geometry is an estimate even when it has usable numeric metrics.
 */
export function dayRouteQuality(day: WorkbenchDay, legs: WorkbenchLeg[], previousDay?: WorkbenchDay): RouteDisplayQuality {
  const lookup = legsByPair(legs)
  const items = dayItemsInOrder(day)
  let estimated = false
  let hasLeg = false
  const incoming = previousDay ? crossDayTransfer(previousDay, day, legs) : null
  if (incoming) {
    if (incoming.distanceKm <= 0 && incoming.durationMin <= 0) return 'pending'
    hasLeg = true
    if (legQuality(incoming.leg) !== 'measured') estimated = true
  }
  for (let i = 1; i < items.length; i += 1) {
    const leg = lookup.get(`${items[i - 1]?.id}|${items[i]?.id}`)
    if (!leg || (leg.distanceKm <= 0 && leg.durationMin <= 0)) return 'pending'
    hasLeg = true
    if (legQuality(leg) !== 'measured') estimated = true
  }
  return !hasLeg ? 'pending' : estimated ? 'estimate' : 'measured'
}

/** "10.02 周五 76km" — same date/weekday labels as the canvas day header. */
export function formatMileageLabel(
  day: Pick<WorkbenchDay, 'date' | 'index'>,
  km: number,
  quality: RouteDisplayQuality = 'measured',
): string {
  const date = dayDateLabel(day.date) || `D${day.index + 1}`
  const weekday = weekdayLabel(day.date)
  const distance = Number.isFinite(km) ? Math.round(km) : 0
  const distanceLabel = quality === 'pending' ? '待查询' : quality === 'estimate' ? `约 ${distance}km` : `${distance}km`
  return `${date}${weekday ? ` ${weekday}` : ''} ${distanceLabel}`
}

/* ------------------------------------------------------------------ *
 * Direction ticks along a route                                       *
 * ------------------------------------------------------------------ */

const EARTH_RADIUS_KM = 6371

function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b[0] - a[0])
  const dLng = toRad(b[1] - a[1])
  const lat1 = toRad(a[0]!)
  const lat2 = toRad(b[0]!)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing a→b in degrees (0 = north, 90 = east). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]))
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]))
  return (Math.atan2(y, x) * 180) / Math.PI
}

export type RouteTick = { at: LatLng; bearing: number }

/**
 * Direction ticks spaced `intervalKm` apart along the polyline, each carrying
 * the local travel bearing — the map draws a chevron per tick.
 */
export function routeTicks(coords: LatLng[], intervalKm: number): RouteTick[] {
  if (coords.length < 2 || !(intervalKm > 0)) return []
  const ticks: RouteTick[] = []
  let carry = 0
  for (let i = 1; i < coords.length; i++) {
    const from = coords[i - 1]!
    const to = coords[i]!
    const span = haversineKm(from, to)
    if (span <= 0) continue
    let offset = carry
    while (offset <= span) {
      const ratio = offset / span
      const at: LatLng = [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio]
      ticks.push({ at, bearing: bearingDeg(from, to) })
      offset += intervalKm
    }
    carry = offset - span
  }
  return ticks
}

/* ------------------------------------------------------------------ *
 * POI markers                                                         *
 * ------------------------------------------------------------------ */

export type PoiMarker = {
  itemId: string
  dayId: string
  dayIndex: number
  /** 1-based position within its day's POI sequence. */
  seq: number
  name: string
  lat: number
  lng: number
  color: string
}

/** POI markers across all days, in day order then item order (per-day seq). */
export function poiMarkersForDays(days: WorkbenchDay[]): PoiMarker[] {
  const markers: PoiMarker[] = []
  for (const day of days) {
    let seq = 0
    for (const item of dayItemsInOrder(day)) {
      const coords = itemCoords(item)
      if (!coords) continue
      seq += 1
      markers.push({
        itemId: item.id,
        dayId: day.id,
        dayIndex: day.index,
        seq,
        name: item.poi?.name ?? item.title,
        lat: coords[0],
        lng: coords[1],
        color: dayAccentColor(day.color, day.index),
      })
    }
  }
  return markers
}

/**
 * Zoom-dependent collision: markers closer than `thresholdPx` to an
 * already-visible (earlier in day/seq order) marker are hidden. Web-Mercator
 * pixel approximation, independent of container size.
 */
export function hiddenByCollision(markers: PoiMarker[], zoom: number, thresholdPx = 26): Set<string> {
  const hidden = new Set<string>()
  if (markers.length < 2) return hidden
  const pixelsPerDeg = (256 * Math.pow(2, zoom)) / 360
  const visible: PoiMarker[] = []
  for (const marker of markers) {
    const latRad = (marker.lat * Math.PI) / 180
    const cos = Math.max(0.05, Math.cos(latRad))
    const collides = visible.some((kept) => {
      const dx = (marker.lng - kept.lng) * pixelsPerDeg
      const dy = (marker.lat - kept.lat) * (pixelsPerDeg / cos)
      return Math.sqrt(dx * dx + dy * dy) < thresholdPx
    })
    if (collides) hidden.add(marker.itemId)
    else visible.push(marker)
  }
  return hidden
}
