/**
 * Workbench map drawing (ticket 05) — sits on the existing Leaflet pipeline
 * (`createRouteMap`'s workbench layer groups) instead of starting a new map
 * approach. All geometry math lives in the pure domain module
 * `src/domain/workbenchMap.ts`; this file is the Leaflet boundary.
 */
import L from 'leaflet'
import { escapeHtml } from '../domain/amapUtils'
import { routeTicks, type LatLng, type PoiMarker, type RouteTick } from '../domain/workbenchMap'
import type { RouteMapHandle } from './map'
import { routeMidpoint } from './map'

/** One day's drawable route. */
export interface WorkbenchRouteDay {
  dayId: string
  color: string
  /** Contiguous [lat, lng][] segments (leg polylines / straight-line fallbacks). */
  segments: LatLng[][]
  /** "10.02 周五 76km" midpoint label text. */
  mileageLabel: string
}

/** Chevron tip/wing geometry (km → degrees handled by callers via short segments). */
function chevron(tick: RouteTick): [LatLng, LatLng, LatLng] {
  const [lat, lng] = tick.at
  // A ~300 m long arrow: tip at the tick, wings swept back ±35°.
  const wingDeg = 300 / 111_320 / Math.max(0.2, Math.cos((lat * Math.PI) / 180))
  const back = tick.bearing + 180
  const sweep = 35
  const wingPoint = (offsetDeg: number): LatLng => {
    const rad = (offsetDeg * Math.PI) / 180
    const dy = (wingDeg * Math.cos(rad)) / 2
    const dx = (wingDeg * Math.sin(rad)) / 2
    return [lat + dy, lng + dx]
  }
  return [wingPoint(back - sweep), tick.at, wingPoint(back + sweep)]
}

/**
 * Per-day colored driving routes with a white casing and direction chevrons.
 * Each day's mileage label is rendered persistently at its route midpoint
 * (PRD §4.3「每日路线中点悬浮日程标签」), rather than only on hover.
 */
export function renderWorkbenchRoutes(handle: RouteMapHandle, days: WorkbenchRouteDay[]): void {
  handle.workbenchRouteLayer.clearLayers()
  handle.workbenchLabelLayer.clearLayers()
  for (const day of days) {
    for (const segment of day.segments) {
      if (segment.length < 2) continue
      L.polyline(segment, { color: '#ffffff', weight: 7, opacity: 0.9 }).addTo(handle.workbenchRouteLayer)
      L.polyline(segment, {
        color: day.color,
        weight: 4.5,
        opacity: 0.95,
        className: `wb-route wb-route-${day.dayId}`,
      }).addTo(handle.workbenchRouteLayer)
      for (const tick of routeTicks(segment, 30)) {
        const [wingA, tip, wingB] = chevron(tick)
        L.polyline([wingA, tip, wingB], { color: day.color, weight: 2, opacity: 0.9, interactive: false }).addTo(
          handle.workbenchRouteLayer,
        )
      }
    }
    addMileageLabel(handle, day)
  }
}

/** Persistent per-day mileage label at the route's midpoint (day-color matched). */
function addMileageLabel(handle: RouteMapHandle, day: WorkbenchRouteDay): void {
  const flat = day.segments.flat()
  if (flat.length < 2) return
  L.marker(routeMidpoint(flat), {
    icon: L.divIcon({
      className: 'wb-mileage-label-wrap',
      html: `<span class="wb-mileage-label" data-mileage-day="${day.dayId}" style="--wb-day-color:${day.color}">${escapeHtml(day.mileageLabel)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 14],
    }),
    keyboard: false,
    interactive: false,
    zIndexOffset: 700,
  }).addTo(handle.workbenchLabelLayer)
}

/** One clickable POI marker input (from `poiMarkersForDays` + collision set). */
export type WorkbenchPoiRender = PoiMarker & { hidden?: boolean }

/** POI sequence markers per day; click → the panel scrolls/highlights the canvas card. */
export function renderWorkbenchPois(
  handle: RouteMapHandle,
  pois: WorkbenchPoiRender[],
  onPoiClick: (itemId: string) => void,
): void {
  handle.workbenchPoiLayer.clearLayers()
  for (const poi of pois) {
    const marker = L.marker([poi.lat, poi.lng], {
      icon: L.divIcon({
        className: `wb-poi-marker${poi.hidden ? ' poi-marker-name--hidden-by-collision' : ''}`,
        html: `<span class="wb-poi-marker-dot" data-poi-marker="${poi.itemId}" style="--wb-day-color:${poi.color}">${poi.seq}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
      keyboard: false,
      zIndexOffset: poi.hidden ? 0 : 600,
    })
    if (!poi.hidden) marker.on('click', () => onPoiClick(poi.itemId))
    marker.addTo(handle.workbenchPoiLayer)
  }
}

/** True when the coordinate pair is usable (guards missing / (0,0) placeholders). */
function hasUsableCoords(coords: LatLng): boolean {
  const [lat, lng] = coords
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
}

/**
 * Focus a single POI (canvas card click / marker click detail flow) with a
 * smooth fly-to, honouring reduced-motion. Returns false when the coordinate is
 * unusable so callers can fall back to the whole-trip overview instead of
 * leaving the map on a stale viewport.
 */
export function focusWorkbenchPoi(handle: RouteMapHandle, coords: LatLng, zoom = 13): boolean {
  if (!hasUsableCoords(coords)) return false
  const map = handle.map
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  if (reduceMotion) {
    map.setView(coords, zoom, { animate: false })
    return true
  }
  map.flyTo(coords, zoom, { duration: 0.6 })
  return true
}

/** Fit bounds around arbitrary coordinates (per-day or whole-trip overview). */
export function fitWorkbenchCoordinates(handle: RouteMapHandle, coords: LatLng[]): void {
  if (!coords.length) return
  if (coords.length === 1) {
    handle.map.setView(coords[0]!, 12, { animate: false })
    return
  }
  handle.map.fitBounds(L.latLngBounds(coords), {
    paddingTopLeft: [30, 40],
    paddingBottomRight: [30, 40],
    maxZoom: 12,
    animate: false,
  })
}
