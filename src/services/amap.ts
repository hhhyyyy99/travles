/**
 * AMap SDK boundary (ticket 03) — typed adapter over `window.AMap`.
 *
 * Loader (port of amap-integration.js `loadSDK` :247–263):
 * - reuses an already-present `window.AMap` (test fixture) without injecting;
 * - sets `window._AMapSecurityConfig` before injection;
 * - injects the JS API script once per page (module-level promise);
 * - 20 s load timeout; exact legacy failure strings;
 * - a failed load clears the promise so a retry injects a brand-new script.
 *
 * The typed surface is exactly what the app calls and what the stub fixture
 * (`tests/helpers/amap-stub.cjs`) validates: Map, Driving with BOTH search
 * overloads, LngLat, Polyline, Marker, Pixel, TileLayer.Traffic, ToolBar,
 * Scale, AutoComplete, PlaceSearch, DrivingPolicy.REAL_TRAFFIC.
 */
import type { AmapConfig } from './amapConfig'
import { gcj02ToWgs84LngLat } from '../domain/geo'

export interface AMapLngLat {
  lng: number
  lat: number
  getLng(): number
  getLat(): number
}

export interface AmapPixel {
  x: number
  y: number
}

export type AmapPathPoint = AMapLngLat | [number, number] | { lng: number; lat: number }

export type RouteCallback = (state: string, result?: AmapRouteResult | null) => void

export interface AmapRouteResult {
  routes?: AmapRoute[]
  start?: { name?: string }
  end?: { name?: string }
}

export interface AmapRouteStep {
  path?: AmapPathPoint[]
  tmcs?: Array<{ status?: string; distance?: number; path?: AmapPathPoint[] }>
  road?: string
  instruction?: string
}

export interface AmapRoute {
  distance?: number
  time?: number
  steps?: AmapRouteStep[]
}

/** A route stop: keyword/city, optionally pinned to a GCJ-02 coordinate. */
export interface AmapStopInput {
  keyword: string
  city: string
  location?: AMapLngLat
}

export type AmapStopArgument = AmapStopInput | AMapLngLat

export interface AmapDrivingInstance {
  /** Array overload: all-keyword stops. */
  search(stops: AmapStopInput[], callback: RouteCallback): void
  /** Coordinate overload: origin/destination may be LngLat or keyword; waypoints may be mixed. */
  search(
    origin: AmapStopArgument,
    destination: AmapStopArgument,
    options: { waypoints: AmapStopArgument[] },
    callback: RouteCallback,
  ): void
}

export interface AmapMapInstance {
  add(target: unknown): void
  remove(target: unknown): void
  addControl(control: unknown): void
  setFitView(overlays: unknown[], animate: boolean, padding: number[]): void
  setZoomAndCenter(zoom: number, center: [number, number]): void
  resize?(): void
  destroy(): void
}

export interface AmapTrafficLayer {
  reload(): void
  show(): void
  hide(): void
}

export interface AmapStatic {
  Map: new (
    container: string,
    options: { viewMode: string; center: [number, number]; zoom: number; resizeEnable: boolean },
  ) => AmapMapInstance
  Driving: new (options: { extensions: string; policy: number }) => AmapDrivingInstance
  DrivingPolicy: { REAL_TRAFFIC: number }
  LngLat: new (lng: number, lat: number) => AMapLngLat
  Polyline: new (options: Record<string, unknown>) => unknown
  Marker: new (options: Record<string, unknown>) => unknown
  Pixel: new (x: number, y: number) => AmapPixel
  TileLayer: { Traffic: new (options: { autoRefresh: boolean; interval: number }) => AmapTrafficLayer }
  ToolBar: new (options: { position: string }) => unknown
  Scale: new () => unknown
  AutoComplete: new (options: { input: string; city: string }) => {
    on(event: string, callback: (event: { poi?: { name?: string }; tip?: { name?: string } }) => void): void
  }
  PlaceSearch: new (options: { city: string; citylimit: boolean; pageSize: number }) => AmapPlaceService
  plugin(_name: string, _callback: () => void): void
}

declare global {
  interface Window {
    AMap?: AmapStatic
    _AMapSecurityConfig?: { securityJsCode: string }
  }
}

export const SDK_LOAD_TIMEOUT_MS = 20000

const SDK_PLUGINS = 'AMap.Driving,AMap.ToolBar,AMap.Scale,AMap.AutoComplete,AMap.PlaceSearch'
const SDK_SCRIPT_URL = (config: AmapConfig, callback: string): string =>
  `https://webapi.amap.com/maps?${new URLSearchParams({ v: '2.0', key: config.key, plugin: SDK_PLUGINS, callback })}`

let sdkLoadPromise: Promise<void> | null = null

/** Typed read of the SDK global (the only intentional AMap global). */
export function getAMapStatic(): AmapStatic | null {
  return window.AMap ?? null
}

/**
 * Load the SDK once per page. Resolves immediately when a fixture already
 * installed `window.AMap`; on failure the cached promise is dropped so the
 * next call retries with the same config (legacy `重试加载地图` flow).
 */
export function loadAMapSdk(config: AmapConfig): Promise<void> {
  if (window.AMap?.Driving) return Promise.resolve()
  if (!sdkLoadPromise) {
    sdkLoadPromise = loadAMapSdkImpl(config).catch((error) => {
      sdkLoadPromise = null
      throw error
    })
  }
  return sdkLoadPromise
}

function loadAMapSdkImpl(config: AmapConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    window._AMapSecurityConfig = { securityJsCode: config.securityJsCode }
    const script = document.createElement('script')
    const callback = `tibetAmapReady${Date.now()}`
    let timer = 0
    let finished = false
    const finish = (error?: Error): void => {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      ;(window as unknown as Record<string, unknown>)[callback] = () => {}
      if (error) {
        script.remove()
        reject(error)
      } else {
        resolve()
      }
    }
    timer = window.setTimeout(
      () => finish(new Error('高德加载超时，请检查网络、Key 类型与域名白名单。')),
      SDK_LOAD_TIMEOUT_MS,
    )
    ;(window as unknown as Record<string, unknown>)[callback] = (): void =>
      window.AMap?.Driving ? finish() : finish(new Error('高德插件未就绪，请检查 Key 与安全密钥后刷新页面。'))
    script.onerror = (): void => finish(new Error('无法加载高德地图，请检查网络与域名白名单。'))
    script.src = SDK_SCRIPT_URL(config, callback)
    document.head.append(script)
  })
}

/** Keyword-else-LngLat stop argument (amap-integration.js `stopInput`, :110). */
export function stopInput(stop: AmapStopInput): AmapStopArgument {
  return stop.location ?? { keyword: stop.keyword, city: stop.city }
}

/**
 * Overload picker (amap-integration.js `searchRoute` :108–118): the coordinate
 * overload is used when ANY stop carries a `location`; keyword stops survive
 * inside waypoints as `{keyword, city}` objects.
 */
export function searchRoute(
  driving: AmapDrivingInstance,
  stops: AmapStopInput[],
  callback: RouteCallback,
): void {
  if (!stops.some((stop) => stop.location)) {
    driving.search(stops, callback)
    return
  }
  const origin = stopInput(stops[0]!)
  const destination = stopInput(stops.at(-1)!)
  const waypoints = stops.slice(1, -1).map(stopInput)
  driving.search(origin, destination, { waypoints }, callback)
}

/** Unified lng/lat reader for AMap path points (getLng/getLat-first, legacy :128–136). */
export function pointLngLat(point: AmapPathPoint): [number, number] {
  const asLngLat = point as AMapLngLat
  const asObject = point as { lng?: number; lat?: number }
  const asPair = point as [number, number]
  const lng = asLngLat.getLng?.() ?? asObject.lng ?? asPair[0]
  const lat = asLngLat.getLat?.() ?? asObject.lat ?? asPair[1]
  return [Number(lng), Number(lat)]
}

/**
 * AMap route steps → WGS-84 [lat, lng] pairs for the Leaflet/results boundary
 * (amap-integration.js `routePathWgs84` :130–136).
 */
export function routePathWgs84(route: AmapRoute): [number, number][] {
  return (route.steps ?? [])
    .flatMap((step) => step.path ?? [])
    .map((point) => {
      const [lng, lat] = pointLngLat(point)
      const [wgsLng, wgsLat] = gcj02ToWgs84LngLat(lng, lat)
      return [wgsLat, wgsLng] as [number, number]
    })
    .filter((point) => point.every(Number.isFinite))
}

export interface AmapMapBundle {
  map: AmapMapInstance
  trafficLayer: AmapTrafficLayer
}

/* ------------------------------------------------------------------ *
 * Place search (accommodation-search.js — ticket 05). The typed adapter
 * surface the fixture stubs: PlaceSearch with `{city:'全国', citylimit:false,
 * pageSize:8}`, POIs normalized to WGS-84 [lat, lng] AT THE SERVICE BOUNDARY
 * (results consumed by the app never carry GCJ-02).
 * ------------------------------------------------------------------ */

export const SEARCH_RESULT_LIMIT = 8

export interface AmapPoiLocation {
  lng: number
  lat: number
  getLng?(): number
  getLat?(): number
}

/** Raw AMap POI as returned by PlaceSearch (`poiList.pois`). */
export interface AmapPoi {
  id?: string | number
  name?: string
  address?: string
  pname?: string
  adname?: string
  cityname?: string
  city?: string
  location?: AmapPoiLocation | [number, number]
}

/**
 * Normalized search result model — EXACT legacy shape
 * (accommodation-search.js `normalizePoi`): WGS-84 lat/lng plus the raw
 * GCJ-02 `sourceLocation` for provenance. POIs are always `type:'hotel'`;
 * area results come from the user picking an area from the poi list.
 */
export interface AmapPlaceResult {
  id: string
  name: string
  address: string
  type: 'hotel'
  lat: number
  lng: number
  source: 'amap'
  sourceLocation: { lat: number; lng: number }
  city: string
}

export interface AmapPlaceSearchResult {
  poiList?: { pois?: AmapPoi[] }
  pois?: AmapPoi[]
}

/** The PlaceSearch instance surface the app uses (and the fixture stubs). */
export interface AmapPlaceService {
  search(query: string, callback: (status: string, result?: AmapPlaceSearchResult | null) => void): void
}

/** GCJ-02 → WGS-84 coordinate transform injected at the service boundary. */
export type CoordsTransform = (lng: number, lat: number) => [number, number]

/** Search failure carries the legacy `code` ('empty' | 'unavailable' | 'no-results' | 'network'). */
export interface AmapSearchError extends Error {
  code?: string
}

function number(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function poiCoordinates(location: AmapPoi['location']): { lng: number; lat: number } | null {
  if (!location) return null
  const asLngLat = location as AmapPoiLocation
  const asPair = location as [number, number]
  const lng = number(asLngLat.getLng?.() ?? asLngLat.lng ?? asPair[0])
  const lat = number(asLngLat.getLat?.() ?? asLngLat.lat ?? asPair[1])
  return lng !== null && lat !== null ? { lng, lat } : null
}

/**
 * Single POI normalizer (legacy `normalizePoi`). Falls back to the vendored
 * coordtransform through `gcj02ToWgs84LngLat`; tests inject a transform.
 * Missing name/position or non-finite converted coords → null (never invent).
 */
export function normalizePoi(
  poi: AmapPoi | null | undefined,
  transform: CoordsTransform = gcj02ToWgs84LngLat,
): AmapPlaceResult | null {
  const point = poiCoordinates(poi?.location)
  const name = String(poi?.name || '').trim()
  if (!point || !name) return null
  const converted = transform(point.lng, point.lat)
  const lng = number(converted?.[0])
  const lat = number(converted?.[1])
  if (lng === null || lat === null) return null
  return {
    id: String(poi?.id || `amap-${name}-${point.lng}-${point.lat}`),
    name: name.slice(0, 120),
    address: String(poi?.address || poi?.pname || poi?.adname || '').trim().slice(0, 240),
    type: 'hotel',
    lat,
    lng,
    source: 'amap',
    sourceLocation: { lat: point.lat, lng: point.lng },
    city: String(poi?.cityname || poi?.city || '').trim(),
  }
}

/**
 * PlaceSearch readiness (legacy `placeSearchReady`): resolves immediately
 * when the SDK already carries PlaceSearch; otherwise requests the plugin.
 * Missing SDK/plugin → `{code:'unavailable', message:'高德地点搜索不可用'}`.
 */
export function placeSearchReady(amap: AmapStatic | null | undefined): Promise<AmapStatic> {
  if (amap?.PlaceSearch) return Promise.resolve(amap)
  if (typeof amap?.plugin !== 'function') {
    const error = new Error('高德地点搜索不可用') as AmapSearchError
    error.code = 'unavailable'
    return Promise.reject(error)
  }
  const sdk: AmapStatic = amap
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      if (sdk.PlaceSearch) resolve(sdk)
      else {
        const error = new Error('高德地点搜索插件未就绪') as AmapSearchError
        error.code = 'unavailable'
        reject(error)
      }
    }
    // The plugin callback must not hang the caller forever: settle with the
    // unavailable error if it never fires (offline / partial SDK).
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      const error = new Error('高德地点搜索不可用') as AmapSearchError
      error.code = 'unavailable'
      reject(error)
    }, 8000)
    try {
      sdk.plugin('AMap.PlaceSearch', finish)
    } catch (error) {
      if (!settled) {
        settled = true
        window.clearTimeout(timeout)
        ;(error as AmapSearchError).code = (error as AmapSearchError).code || 'unavailable'
        reject(error as AmapSearchError)
      }
    }
  })
}

export interface SearchPlacesOptions {
  /** PlaceSearch city scope (legacy default `'全国'`). */
  city?: string
  /** SDK instance override (tests inject a fixture AMap). */
  AMap?: AmapStatic | null
  /** Coordinate transform override (tests). */
  transform?: CoordsTransform
}

/**
 * Typed place search (legacy `searchPlaces`): PlaceSearch with
 * `{city:'全国', citylimit:false, pageSize:8}`, results normalized + WGS-84
 * at the boundary, sliced to the result limit. Failures carry exact legacy
 * messages: '请输入住宿名称或区域' (empty), '高德地点搜索不可用' (unavailable),
 * '高德地点搜索失败' with code 'no-results'/'network'.
 */
export function searchPlaces(queryInput: string, options: SearchPlacesOptions = {}): Promise<AmapPlaceResult[]> {
  const query = String(queryInput || '').trim()
  if (!query) {
    const error = new Error('请输入住宿名称或区域') as AmapSearchError
    error.code = 'empty'
    return Promise.reject(error)
  }
  const amap = options.AMap ?? getAMapStatic()
  return placeSearchReady(amap).then(
    (ready) =>
      new Promise<AmapPlaceResult[]>((resolve, reject) => {
        let service: AmapPlaceService
        try {
          service = new ready.PlaceSearch({
            city: options.city ?? '全国',
            citylimit: false,
            pageSize: SEARCH_RESULT_LIMIT,
          })
          service.search(query, (status, result) => {
            if (status !== 'complete') {
              const error = new Error('高德地点搜索失败') as AmapSearchError
              error.code = status === 'no_data' ? 'no-results' : 'network'
              reject(error)
              return
            }
            const pois = result?.poiList?.pois || result?.pois || []
            const normalized = pois
              .map((poi) => normalizePoi(poi, options.transform ?? gcj02ToWgs84LngLat))
              .filter((poi): poi is AmapPlaceResult => Boolean(poi))
              .slice(0, SEARCH_RESULT_LIMIT)
            resolve(normalized)
          })
        } catch (error) {
          ;(error as AmapSearchError).code = (error as AmapSearchError).code || 'network'
          reject(error as AmapSearchError)
        }
      }),
  )
}

/** One-shot map creation (amap-integration.js :279–283). */
export function createAmapMap(amap: AmapStatic, containerId: string): AmapMapBundle {
  const map = new amap.Map(containerId, { viewMode: '2D', center: [119.5, 49.5], zoom: 7, resizeEnable: true })
  map.addControl(new amap.ToolBar({ position: 'RB' }))
  map.addControl(new amap.Scale())
  const trafficLayer = new amap.TileLayer.Traffic({ autoRefresh: true, interval: 180 })
  map.add(trafficLayer)
  return { map, trafficLayer }
}