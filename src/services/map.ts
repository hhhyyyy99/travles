/**
 * Leaflet adapter — the typed boundary between the React app and the map.
 *
 * Port of trip.js:77–138, 194, 255 (map init, layers, static markers,
 * tile-error fallback, ResizeObserver) plus the draw helpers used by the
 * itinerary `choose` / `fit` flows (trip.js:127–150, 173–187).
 *
 * Lifecycle ownership: one `createRouteMap` call per `#route-map` mount; the
 * caller must call `destroy()` on unmount. `map.remove()` deletes the
 * container's `_leaflet_id`, so StrictMode/HMR remounts initialize a fresh map
 * without duplicating layers, markers or listeners.
 */
import L from 'leaflet'
import { tripPlan, POINT_KEYS } from '../data/itinerary'
import { legByDay, roadLines } from '../data/roadRoutes'
import { escapeHtml } from '../domain/amapUtils'
import type { AccommodationBase, LatLng } from '../domain/types'

export interface RouteMapHandle {
  map: L.Map
  tiles: L.TileLayer
  satellite: L.TileLayer
  fullRouteLayer: L.LayerGroup
  timeLabelLayer: L.LayerGroup
  selectedLayer: L.LayerGroup
  /** Custom-base markers (accommodation.js `renderMarkers` L640–647) — re-drawn by the dialog. */
  accommodationMarkers: L.LayerGroup
  /** Workbench panel layers (ticket 05) — per-day routes, mileage labels, POI markers. */
  workbenchRouteLayer: L.LayerGroup
  workbenchLabelLayer: L.LayerGroup
  workbenchPoiLayer: L.LayerGroup
  /** Ticket 15: recommendation POIs shown while the map toggle is on. */
  workbenchRecommendationLayer: L.LayerGroup
  destroy(): void
}

export interface RouteMapOptions {
  /** Static circle-marker click → day (note A §5; airportH/hailar → day 0, nothing → day 6). */
  onDaySelect: (day: number) => void
  /** 3 consecutive tileerrors → true; any tileload → false (trip.js:194). */
  onTileError: (visible: boolean) => void
  /** Render the guide's static trip points (default true; workbench map opts out). */
  staticMarkers?: boolean
  /** Leaflet zoom control (default true; the workbench renders its own). */
  zoomControl?: boolean
  /** Leaflet layers control (default true; the workbench renders its own header). */
  layersControl?: boolean
  /** Initial view (default 海拉尔 49.5, 119.5 @ 7). */
  initialView?: { center: LatLng; zoom: number }
}

/** Static marker key → day index (legacy trip.js:138 hardcoded map). */
const MARKER_DAY: Record<string, number> = {
  airportH: 0,
  hailar: 0,
  morigele: 1,
  erguna: 1,
  mordaoga: 2,
  shiwei: 3,
  heishantou: 3,
  caidaihe: 4,
  manzhouli: 4,
  hulunlake: 5,
}

/**
 * Custom-base circle markers (accommodation.js `renderMarkers` L640–647):
 * radius 7, white stroke, `#8b654f` fill, class `accommodation-marker`, name
 * tooltip above — re-drawn (layer cleared) on every accommodation change.
 */
export function renderAccommodationMarkers(handle: RouteMapHandle, bases: AccommodationBase[]): void {
  handle.accommodationMarkers.clearLayers()
  bases.forEach((base) => {
    L.circleMarker([base.lat, base.lng], {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: '#8b654f',
      fillOpacity: 0.95,
      className: 'accommodation-marker',
    })
      .bindTooltip(escapeHtml(base.name), { direction: 'top' })
      .addTo(handle.accommodationMarkers)
  })
}

export function createRouteMap(container: HTMLElement, options: RouteMapOptions): RouteMapHandle {
  const view = options.initialView ?? { center: [49.5, 119.5] as LatLng, zoom: 7 }
  const map = L.map(container, {
    zoomControl: false,
    scrollWheelZoom: false,
    minZoom: 5,
    maxZoom: 16,
  }).setView(view.center, view.zoom)

  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Routing: OSRM',
    maxZoom: 19,
  }).addTo(map)

  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Imagery © Esri, Maxar, Earthstar Geographics', maxNativeZoom: 17 },
  )

  if (options.layersControl !== false) {
    L.control.layers({ 道路地图: tiles, 卫星地图: satellite }, undefined, { position: 'topright' }).addTo(map)
  }
  if (options.zoomControl !== false) L.control.zoom({ position: 'bottomright' }).addTo(map)

  const fullRouteLayer = L.layerGroup().addTo(map)
  const timeLabelLayer = L.layerGroup().addTo(map)
  const selectedLayer = L.layerGroup().addTo(map)
  const accommodationMarkers = L.layerGroup().addTo(map)
  const workbenchRouteLayer = L.layerGroup().addTo(map)
  const workbenchLabelLayer = L.layerGroup().addTo(map)
  const workbenchPoiLayer = L.layerGroup().addTo(map)
  const workbenchRecommendationLayer = L.layerGroup().addTo(map)

  // Static reference markers, one per point key (trip.js:137–138). The
  // workbench map (ticket 05) renders trip data instead and opts out.
  if (options.staticMarkers !== false) {
    for (const key of POINT_KEYS) {
      const point = tripPlan.points[key]
      if (!point) continue
      L.circleMarker(point.xy, { radius: 6, color: '#fff', weight: 2, fillColor: '#c36a4f', fillOpacity: 1 })
        .addTo(map)
        .bindTooltip(point.name, { permanent: false, direction: 'top' })
        .on('click', () => options.onDaySelect(MARKER_DAY[key] ?? 0))
    }
  }

  // Tile-error fallback: 3 consecutive tileerrors → #map-error, reset on load.
  let tileErrors = 0
  const onTileError = (): void => {
    tileErrors += 1
    if (tileErrors >= 3) options.onTileError(true)
  }
  const onTileLoad = (): void => {
    tileErrors = 0
    options.onTileError(false)
  }
  tiles.on('tileerror', onTileError)
  tiles.on('tileload', onTileLoad)

  const observer = new ResizeObserver(() => {
    map.invalidateSize()
  })
  observer.observe(container)

  let destroyed = false
  return {
    map,
    tiles,
    satellite,
    fullRouteLayer,
    timeLabelLayer,
    selectedLayer,
    accommodationMarkers,
    workbenchRouteLayer,
    workbenchLabelLayer,
    workbenchPoiLayer,
    workbenchRecommendationLayer,
    destroy() {
      if (destroyed) return
      destroyed = true
      tiles.off('tileerror', onTileError)
      tiles.off('tileload', onTileLoad)
      observer.disconnect()
      map.remove()
    },
  }
}

/* ------------------------------------------------------------------ *
 * Pure geometry helpers (accommodation-free reference path; tickets   *
 * 03+ swap `staticRouteGeometry` for the route-state-aware version).  *
 * ------------------------------------------------------------------ */

/** Static leg geometry for a day, as [lat, lng] (legacy `routeGeometry` reference branch). */
export function staticRouteGeometry(dayIndex: number): LatLng[] | null {
  const legIndex = legByDay[dayIndex]
  return legIndex != null ? (roadLines[legIndex] ?? null) : null
}

/** All 7 daily geometries, [lat, lng] each (used by fit/full-route). */
export function allRouteGeometries(): LatLng[][] {
  return tripPlan.days.flatMap((_, index) => {
    const geometry = staticRouteGeometry(index)
    return geometry ? [geometry] : []
  })
}

/** Midpoint of a polyline by cumulative distance (legacy `routeMidpoint`, trip.js:100–108). */
export function routeMidpoint(coords: LatLng[]): LatLng {
  const lengths = coords.slice(1).map((point, i) => L.latLng(coords[i] ?? [0, 0]).distanceTo(point))
  const halfway = lengths.reduce((a, b) => a + b, 0) / 2
  let distance = 0
  for (let i = 0; i < lengths.length; i++) {
    if (distance + (lengths[i] ?? 0) >= halfway) return coords[i] ?? coords[0]!
    distance += lengths[i] ?? 0
  }
  return coords[Math.floor(coords.length / 2)] ?? coords[0]!
}

/* ------------------------------------------------------------------ *
 * Draw helpers (faithful to trip.js:106–138, 175–182, 188).           *
 * ------------------------------------------------------------------ */

/** Selected-day polylines + circle markers (trip.js:177–182). */
export function drawSelectedDay(handle: RouteMapHandle, road: LatLng[] | null, coords: LatLng[]): void {
  handle.selectedLayer.clearLayers()
  if (road) {
    L.polyline(road, { color: '#fff', weight: 9 }).addTo(handle.selectedLayer)
    L.polyline(road, { color: '#1768d1', weight: 6 }).addTo(handle.selectedLayer)
  }
  coords.forEach((point, index) => {
    L.circleMarker(point, {
      radius: 8,
      color: '#fff',
      weight: 3,
      fillColor: index === 0 ? '#236a51' : index === coords.length - 1 ? '#b75342' : '#1768d1',
      fillOpacity: 1,
    }).addTo(handle.selectedLayer)
  })
}

/** Day-level view: drop the full route and focus the day (trip.js:175, 183–185). */
export function focusDay(handle: RouteMapHandle, coords: LatLng[]): void {
  handle.map.removeLayer(handle.fullRouteLayer)
  if (coords.length === 1) {
    handle.map.setView(coords[0] ?? [0, 0], 12, { animate: false })
  } else {
    handle.map.fitBounds(L.latLngBounds(coords), { padding: [60, 65], maxZoom: 11, animate: false })
  }
}

export interface TimeLabelEntry {
  index: number
  title: string
  time: string
  coordinates: LatLng[]
  /** '高德路线' once a live route exists (tickets 03+); reference = '行程预估'. */
  source?: string
}

/** Route-time divIcon labels on the time-label layer (trip.js:110–125, 188). */
export function showTimeLabels(handle: RouteMapHandle, entries: TimeLabelEntry[]): void {
  handle.timeLabelLayer.clearLayers()
  entries.forEach(({ index, title, time, coordinates, source }) => {
    if (!coordinates.length) return
    L.marker(routeMidpoint(coordinates), {
      icon: L.divIcon({
        className: `route-time-marker route-time-${index}`,
        html: `<small>${title}</small><strong>${time}</strong><span>${source ?? '行程预估'}</span>`,
        iconSize: [116, 57],
        iconAnchor: [58, index === 0 || index === 3 ? -12 : 70],
      }),
      keyboard: false,
      interactive: false,
      zIndexOffset: 800,
    }).addTo(handle.timeLabelLayer)
  })
}

/** Whole-trip polylines for every day (trip.js:127–135). */
export function renderFullRoute(handle: RouteMapHandle, geometries: LatLng[][]): void {
  handle.fullRouteLayer.clearLayers()
  geometries.forEach((coords) => {
    L.polyline(coords, { color: '#fff', weight: 8, opacity: 1 }).addTo(handle.fullRouteLayer)
    L.polyline(coords, { color: '#2474db', weight: 5, opacity: 0.85 }).addTo(handle.fullRouteLayer)
  })
}

/** Overview fit: re-add full route, fit bounds with legacy padding (trip.js:139–150). */
export function fitTrip(handle: RouteMapHandle, coords: LatLng[]): void {
  if (!handle.map.hasLayer(handle.fullRouteLayer)) handle.fullRouteLayer.addTo(handle.map)
  if (coords.length) {
    handle.map.fitBounds(L.latLngBounds(coords), {
      paddingTopLeft: [50, 70],
      paddingBottomRight: [50, 65],
      animate: false,
    })
  }
}
