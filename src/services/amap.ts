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
  PlaceSearch: new (options: Record<string, unknown>) => unknown
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

/** One-shot map creation (amap-integration.js :279–283). */
export function createAmapMap(amap: AmapStatic, containerId: string): AmapMapBundle {
  const map = new amap.Map(containerId, { viewMode: '2D', center: [119.5, 49.5], zoom: 7, resizeEnable: true })
  map.addControl(new amap.ToolBar({ position: 'RB' }))
  map.addControl(new amap.Scale())
  const trafficLayer = new amap.TileLayer.Traffic({ autoRefresh: true, interval: 180 })
  map.add(trafficLayer)
  return { map, trafficLayer }
}