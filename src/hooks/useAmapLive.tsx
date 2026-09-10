/**
 * AMap live layer (ticket 03) — port of amap-integration.js as a React context.
 *
 * A single module-level controller (`getAmapLiveController`) owns the SDK
 * instance, map, overlays, timers, query tokens and route-state writes — the
 * same one-shot semantics as the legacy IIFE (map created once inside a
 * closure, only `beforeunload` cleans up). StrictMode double-mounting and HMR
 * of parent modules therefore cannot duplicate maps, listeners, script
 * injection or queries; `loadAMapSdk` additionally guards injection with a
 * module-level promise.
 *
 * The React side only renders the snapshot (`.map-wrap.amap-active`, the live
 * panel DOM contract, `#amap-time-badge`, `#overview-times`) and forwards user
 * actions (`select`/`overview`/`refresh`/traffic/endpoint form/retry).
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { tripPlan } from '../data/itinerary'
import type { RouteStatus } from '../domain/types'
import { colors, duration, traffic } from '../domain/amapUtils'
import {
  ROUTE_OVERVIEW_TIMEOUT_MS,
  ROUTE_QUERY_TIMEOUT_MS,
  ROUTE_REFRESH_INTERVAL_MS,
  type RouteStateDetails,
} from '../domain/routeStates'
import { wgs84ToGcj02LngLat } from '../domain/geo'
import { discoverAmapConfig } from '../services/amapConfig'
import {
  createAmapMap,
  getAMapStatic,
  loadAMapSdk,
  pointLngLat,
  routePathWgs84,
  searchRoute,
  type AmapMapInstance,
  type AmapPathPoint,
  type AmapRoute,
  type AmapRouteResult,
  type AmapStopInput,
  type AmapTrafficLayer,
} from '../services/amap'
import { useRouteStates } from './useRouteStates'

export interface AmapLiveBadge {
  small: string
  strong: string
  span: string
}

export interface AmapLiveSnapshot {
  connected: boolean
  wholeTrip: boolean
  overviewTimesVisible: boolean
  /**
   * Accommodation map-pick mode (accommodation.js `useReferenceMapForPicker`):
   * while true the Leaflet reference map takes the `.map-wrap` and the AMap
   * canvas is hidden — coordinates are picked on the Leaflet map (WGS-84).
   */
  pickMode: boolean
  /** #amap-state text. */
  amapStateText: string
  /** #connect-amap label — null hides the button. */
  connectLabel: string | null
  /** #live-title text. */
  liveTitle: string
  /** #live-status text. */
  liveStatus: string
  trafficChecked: boolean
  trafficDisabled: boolean
  refreshDisabled: boolean
  /** #amap-time-badge content (inside .map-wrap). */
  badge: AmapLiveBadge | null
  /** #live-results metrics. */
  metrics: { durationText: string; distanceKm: string; trafficKnownText: string } | null
  trafficRows: Array<{ status: string; km: string; color: string }>
  resolvedEndpoints: { start: string; end: string } | null
  steps: Array<{ road: string; instruction: string }>
  /** #route-from / #route-to defaults (legacy renderForm). */
  formFrom: string
  formTo: string
}

export interface AmapLiveContextValue extends AmapLiveSnapshot {
  select(day: number): void
  overview(): boolean
  refresh(): void
  setTraffic(checked: boolean): void
  submitEndpoints(from: string, to: string): void
  retry(): void
  /** Swap AMap ↔ reference map for the accommodation map-pick (legacy `tibetAMap.useReferenceMapForPicker`). */
  useReferenceMapForPicker(picking: boolean): boolean
}

const INITIAL_SNAPSHOT: AmapLiveSnapshot = {
  connected: false,
  wholeTrip: false,
  overviewTimesVisible: false,
  pickMode: false,
  amapStateText: '高德未配置 · 当前为参考地图',
  connectLabel: null,
  liveTitle: '高德驾车时间与路况',
  liveStatus: '尚未连接，暂无法获取实时驾驶时间与路况。',
  trafficChecked: false,
  trafficDisabled: true,
  refreshDisabled: true,
  badge: null,
  metrics: null,
  trafficRows: [],
  resolvedEndpoints: null,
  steps: [],
  formFrom: '海拉尔东山机场',
  formTo: '海拉尔市区',
}

const LEGEND_LINE = (color: string, weight: number, path: AmapPathPoint[]): Record<string, unknown> => ({
  path,
  strokeColor: color,
  strokeWeight: weight,
  isOutline: true,
  outlineColor: '#fff',
  borderWeight: 1,
  lineJoin: 'round',
  zIndex: 60,
})

interface RouteStateWiring {
  markRouteStatus(
    dayIndices: number[],
    status: RouteStatus,
    details?: RouteStateDetails,
    expectedToken?: number,
  ): void
  beginRequest(dayIndices: number[]): void
}

class AmapLiveController {
  private snapshot: AmapLiveSnapshot = { ...INITIAL_SNAPSHOT }
  private subscribers = new Set<() => void>()
  private routes: RouteStateWiring | null = null
  private amap: ReturnType<typeof getAMapStatic>
  private map: AmapMapInstance | null = null
  private trafficLayer: AmapTrafficLayer | null = null
  private overlays: unknown[] = []
  private selectedDay = 0
  private wholeTrip = false
  private loading = false
  private connected = false
  private requestId = 0
  private queryTimer = 0
  private refreshTimer = 0
  private dayTokens = new Map<number, number>()
  private overrides = new Map<number, [string, string]>()
  private autoCompleteInstalled = false

  constructor() {
    this.amap = getAMapStatic()
    window.addEventListener('beforeunload', () => {
      window.clearInterval(this.refreshTimer)
      window.clearTimeout(this.queryTimer)
      this.map?.destroy()
    })
  }

  /* ------------------------------------------------------------ *
   * Store access
   * ------------------------------------------------------------ */
  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  getSnapshot(): AmapLiveSnapshot {
    return this.snapshot
  }

  attach(routes: RouteStateWiring): void {
    this.routes = routes
  }

  detach(): void {
    this.routes = null
  }

  private emit(): void {
    this.subscribers.forEach((listener) => listener())
  }

  private patch(patch: Partial<AmapLiveSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.emit()
  }

  private setLiveStatus(message: string): void {
    this.patch({ liveStatus: message })
  }

  /* ------------------------------------------------------------ *
   * Connection lifecycle (amap-integration.js `connect` :264–317)
   * ------------------------------------------------------------ */
  async connect(): Promise<void> {
    if (this.loading || this.connected) return
    this.loading = true
    const config = await discoverAmapConfig()
    if (!config) {
      // Absent config → graceful fallback: reference map + itinerary only.
      this.loading = false
      return
    }
    this.patch({ amapStateText: '正在加载高德地图…' })
    this.setLiveStatus('正在使用默认配置加载地图与路线…')
    try {
      await loadAMapSdk(config)
      const amap = getAMapStatic()
      if (!amap) throw new Error('SDK 已加载但未能初始化，请刷新页面后重新填写凭据。')
      this.amap = amap
      if (!this.map) {
        const { map, trafficLayer } = createAmapMap(amap, 'amap-canvas')
        this.map = map
        this.trafficLayer = trafficLayer
        this.refreshTimer = window.setInterval(() => {
          if (!document.hidden && this.map) this.query()
        }, ROUTE_REFRESH_INTERVAL_MS)
        this.initAutocomplete()
      }
      this.connected = true
      this.patch({
        connected: true,
        amapStateText: '高德地图 · 当前路况',
        connectLabel: null,
        trafficChecked: true,
        trafficDisabled: false,
      })
      this.query()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.patch({ amapStateText: '高德加载失败 · 当前为参考地图', connectLabel: '重试加载地图' })
      this.setLiveStatus(message)
    } finally {
      this.loading = false
    }
  }

  retry(): void {
    void this.connect()
  }

  private initAutocomplete(): void {
    if (!this.amap || this.autoCompleteInstalled) return
    this.autoCompleteInstalled = true
    ;(['route-from', 'route-to'] as const).forEach((id) => {
      const auto = new this.amap!.AutoComplete({ input: id, city: '全国' })
      auto.on('select', (event) => {
        const name = event.poi?.name || event.tip?.name
        if (name) {
          const input = document.getElementById(id) as HTMLInputElement | null
          if (input) input.value = name
        }
      })
    })
  }

  /* ------------------------------------------------------------ *
   * Public actions (window.tibetAMap select/overview + panel)
   * ------------------------------------------------------------ */
  select(day: number): void {
    this.selectedDay = day
    this.wholeTrip = false
    this.patch({ wholeTrip: false, overviewTimesVisible: false, liveTitle: this.liveTitleFor(day, false) })
    if (this.map) this.query()
  }

  overview(): boolean {
    if (!this.map) return false
    this.wholeTrip = true
    this.patch({ wholeTrip: true, overviewTimesVisible: false })
    this.query()
    return true
  }

  refresh(): void {
    this.trafficLayer?.reload()
    this.query()
  }

  setTraffic(checked: boolean): void {
    if (checked) this.trafficLayer?.show()
    else this.trafficLayer?.hide()
    this.patch({ trafficChecked: checked })
  }

  submitEndpoints(from: string, to: string): void {
    this.overrides.set(this.selectedDay, [from.trim(), to.trim()])
    this.wholeTrip = false
    if (this.map) this.query()
  }

  /** accommodation.js picker swap — hides the AMap canvas, shows the Leaflet map (amap-integration.js:380–390). */
  useReferenceMapForPicker(picking: boolean): boolean {
    this.patch({ pickMode: picking })
    return true
  }

  /* ------------------------------------------------------------ *
   * Query building (amap-integration.js `query` :179–244)
   * ------------------------------------------------------------ */
  private liveTitleFor(day: number, wholeTrip: boolean): string {
    return wholeTrip ? '全程路线 · 按当前路况估算' : `${tripPlan.days[day]?.date ?? ''} · 高德驾车路线`
  }

  private endpoints(day = this.selectedDay): [string, string] {
    if (this.overrides.has(day)) return this.overrides.get(day)!
    const d = tripPlan.days[day]
    return d ? d.nav : ['', '']
  }

  private routeStops(dayIndex: number): AmapStopInput[] {
    const d = tripPlan.days[dayIndex]
    if (!d) return []
    let stops: AmapStopInput[]
    if (this.overrides.has(dayIndex)) {
      const names = this.overrides.get(dayIndex)!
      stops = [
        { keyword: names[0], city: d.cities[0] },
        ...(d.via ?? []).map((stop) => ({ ...stop })),
        { keyword: names[1], city: d.cities[1] },
      ]
    } else {
      stops = [
        { keyword: d.nav[0], city: d.cities[0] },
        ...(d.via ?? []).map((stop) => ({ ...stop })),
        { keyword: d.nav[1], city: d.cities[1] },
      ]
    }
    return stops
  }

  private renderForm(): void {
    const names = this.endpoints()
    this.patch({
      liveTitle: this.liveTitleFor(this.selectedDay, this.wholeTrip),
      formFrom: names[0],
      formTo: names[1],
    })
  }

  private clearRoute(): void {
    if (this.overlays.length && this.map) this.map.remove(this.overlays)
    this.overlays = []
    this.patch({
      metrics: null,
      trafficRows: [],
      resolvedEndpoints: null,
      steps: [],
      badge: null,
      overviewTimesVisible: false,
    })
  }

  private line(path: AmapPathPoint[] | undefined, color: string, weight = 6): void {
    if (!Array.isArray(path) || path.length < 2 || !this.amap) return
    this.overlays.push(new this.amap.Polyline(LEGEND_LINE(color, weight, path)))
  }

  private query(done?: (ok: boolean) => void): void {
    if (!this.map) return
    window.clearTimeout(this.queryTimer)
    const version = ++this.requestId
    this.clearRoute()
    this.renderForm()
    this.patch({ refreshDisabled: true })
    const day = tripPlan.days[this.selectedDay]
    if (!day) return
    if (!this.wholeTrip && day.points.length < 2 && !this.overrides.has(this.selectedDay)) {
      // Rest day (single-point day, no override) — amap-integration.js:187–193.
      this.setLiveStatus('今天不安排长途驾驶，以当天实地安排为准。')
      const point = tripPlan.points[day.points[0]!]
      if (point) {
        this.map.setZoomAndCenter(12, wgs84ToGcj02LngLat(point.xy[0], point.xy[1]))
      }
      this.patch({
        badge: { small: '当地休整日', strong: '无长途驾驶', span: '休息日' },
        refreshDisabled: false,
      })
      return
    }
    this.setLiveStatus('正在获取高德路线、预计驾驶时间与路况…')
    const stops = this.wholeTrip
      ? tripPlan.overviewStops.map((stop) => ({ ...stop }))
      : this.routeStops(this.selectedDay)
    const amap = this.amap
    if (!amap) return
    const driving = new amap.Driving({ extensions: 'all', policy: amap.DrivingPolicy.REAL_TRAFFIC })
    const expectedToken = this.wholeTrip ? undefined : this.nextDayToken(this.selectedDay)
    if (!this.wholeTrip) this.routes?.beginRequest([this.selectedDay])
    this.queryTimer = window.setTimeout(() => {
      if (version !== this.requestId) return
      this.requestId++
      this.setLiveStatus('路线查询超时，请刷新重试；暂不显示时间与路况。')
      if (!this.wholeTrip) this.recordDayResult(this.selectedDay, 'unupdated', expectedToken)
      this.patch({ refreshDisabled: false })
      done?.(false)
    }, this.wholeTrip ? ROUTE_OVERVIEW_TIMEOUT_MS : ROUTE_QUERY_TIMEOUT_MS)

    const onResult = (state: string, result?: AmapRouteResult | null): void => {
      if (version !== this.requestId) return
      window.clearTimeout(this.queryTimer)
      this.patch({ refreshDisabled: false })
      if (state !== 'complete' || !result?.routes?.length) {
        this.setLiveStatus('未取得路线。请检查地点名称、Key 服务权限与配额，然后刷新重试。')
        if (!this.wholeTrip) this.recordDayResult(this.selectedDay, 'unupdated', expectedToken)
        done?.(false)
        return
      }
      this.showRoute(result.routes[0]!, result)
      done?.(true)
    }

    if (this.wholeTrip) {
      const planned = tripPlan.days.filter((d) => d.points.length > 1)
      const collected: AmapRoute[] = []
      const next = (index: number): void => {
        if (version !== this.requestId) return
        if (index === planned.length) {
          const combined = collected.reduce<AmapRoute>(
            (total, route) => ({
              distance: (total.distance ?? 0) + (route.distance ?? 0),
              time: (total.time ?? 0) + (route.time ?? 0),
              steps: [...(total.steps ?? []), ...(route.steps ?? [])],
            }),
            { distance: 0, time: 0, steps: [] },
          )
          onResult('complete', { routes: [combined], start: { name: '海拉尔东山机场' }, end: { name: '海拉尔东山机场' } })
          return
        }
        this.setLiveStatus(`正在查询第 ${index + 1}/${planned.length} 段高德路线…`)
        const plannedDay = planned[index]!
        const segment = this.routeStops(tripPlan.days.indexOf(plannedDay))
        try {
          searchRoute(driving, segment, (state, result) => {
            if (version !== this.requestId) return
            if (state !== 'complete' || !result?.routes?.length) {
              onResult(state, result)
              return
            }
            collected.push(result.routes[0]!)
            window.setTimeout(() => next(index + 1), 600)
          })
        } catch {
          onResult('error', null)
        }
      }
      next(0)
    } else {
      try {
        searchRoute(driving, stops, onResult)
      } catch {
        onResult('error', null)
      }
    }
  }

  /** Per-day token for route-state writes (port of the accommodation token map). */
  private nextDayToken(day: number): number {
    const token = (this.dayTokens.get(day) ?? 0) + 1
    this.dayTokens.set(day, token)
    return token
  }

  private recordDayResult(day: number, status: 'updated' | 'unupdated', expectedToken: number | undefined): void {
    this.routes?.markRouteStatus([day], status, { navigation: undefined }, expectedToken)
  }

  /* ------------------------------------------------------------ *
   * Result rendering (amap-integration.js `showRoute` :139–178)
   * ------------------------------------------------------------ */
  private showRoute(route: AmapRoute, result: AmapRouteResult): void {
    const path = (route.steps ?? []).flatMap((step) => step.path ?? [])
    const routeCoordinates = routePathWgs84(route)
    const amap = this.amap
    if (!amap) return
    this.line(path, colors['未知'])
    const trafficResult = traffic(route)
    const queryTime = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const timeText = duration(route.time)
    const whole = this.wholeTrip
    const timeContent = `<small>${whole ? '全程驾驶合计' : '本段预计驾驶'}</small><strong>${timeText}</strong><span>高德估算 · ${queryTime}</span>`
    this.patch({ badge: { small: whole ? '全程驾驶合计' : '本段预计驾驶', strong: timeText, span: `高德估算 · ${queryTime}` } })
    trafficResult.segments.forEach((segment) => {
      this.line(segment.path as AmapPathPoint[] | undefined, colors[segment.status as keyof typeof colors])
    })
    let navigation: { primary: string; current: string } | undefined
    if (path.length) {
      if (!whole) {
        const mid = path[Math.floor(path.length / 2)]!
        this.overlays.push(
          new amap.Marker({
            position: mid,
            anchor: 'bottom-center',
            offset: new amap.Pixel(0, -14),
            content: `<div class="amap-route-time">${timeContent}</div>`,
            zIndex: 200,
          }),
        )
      }
      if (whole) this.patch({ overviewTimesVisible: true })
      this.overlays.push(
        new amap.Marker({
          position: path[0]!,
          anchor: 'center',
          content: '<div class="trip-endpoint trip-endpoint-start" role="img" aria-label="起点" title="起点">起</div>',
          zIndex: 210,
        }),
      )
      this.overlays.push(
        new amap.Marker({
          position: path.at(-1)!,
          anchor: 'center',
          content: '<div class="trip-endpoint trip-endpoint-end" role="img" aria-label="终点" title="终点">终</div>',
          zIndex: 210,
        }),
      )
      if (!whole) navigation = this.navigationHrefs(path)
    }
    this.map?.add(this.overlays)
    if (this.overlays.length) {
      const padding = whole
        ? window.innerWidth < 720
          ? [100, 45, 210, 45]
          : [90, 55, 70, 230]
        : [70, 55, 70, 55]
      this.map?.setFitView(this.overlays, false, padding)
    }
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false })
    this.setLiveStatus(`高德路线查询成功 · ${timestamp}（本地时间）`)
    if (!whole) {
      this.routes?.markRouteStatus(
        [this.selectedDay],
        'updated',
        {
          distance: Number(route.distance),
          duration: Number(route.time),
          durationText: timeText,
          coordinates: routeCoordinates,
          navigation,
        },
        this.dayTokens.get(this.selectedDay),
      )
    }
    const rows = Object.entries(trafficResult.totals).filter(([, distance]) => distance > 0)
    const names = this.endpoints()
    this.patch({
      metrics: {
        durationText: timeText,
        distanceKm: `${(Number(route.distance) / 1000).toFixed(1)} km`,
        trafficKnownText: trafficResult.known ? '已返回分段路况' : '暂无覆盖',
      },
      trafficRows: rows.map(([status, distance]) => ({
        status,
        km: `${(distance / 1000).toFixed(1)} km`,
        color: colors[status as keyof typeof colors],
      })),
      resolvedEndpoints: {
        start: result.start?.name || names[0],
        end: result.end?.name || names[1],
      },
      steps: (route.steps ?? []).map((step) => ({ road: step.road || '连接道路', instruction: step.instruction || '' })),
    })
  }

  /**
   * Patched-navigation equivalents (amap-integration.js:164–169): resolved
   * GCJ-02 path endpoints + form display names, byte-identical URL strings.
   */
  private navigationHrefs(path: AmapPathPoint[]): { primary: string; current: string } {
    const names = this.endpoints()
    const [toLng, toLat] = pointLngLat(path.at(-1)!)
    const [fromLng, fromLat] = pointLngLat(path[0]!)
    const to = `${toLng},${toLat},${names[1]}`
    const from = `${fromLng},${fromLat},${names[0]}`
    const params = (): URLSearchParams => new URLSearchParams({ mode: 'car', policy: '1', callnative: '1', src: 'hailar-slow-trip', to })
    const currentParams = params()
    const primaryParams = params()
    primaryParams.set('from', from)
    return {
      current: `https://uri.amap.com/navigation?${currentParams}`,
      primary: `https://uri.amap.com/navigation?${primaryParams}`,
    }
  }
}

let sharedController: AmapLiveController | null = null

/** Single module instance (StrictMode/HMR guard). */
function getAmapLiveController(): AmapLiveController {
  if (!sharedController) sharedController = new AmapLiveController()
  return sharedController
}

const AmapLiveContext = createContext<AmapLiveContextValue | null>(null)

export function AmapLiveProvider({ children }: { children: ReactNode }) {
  const controllerRef = useRef<AmapLiveController | null>(null)
  if (controllerRef.current === null) controllerRef.current = getAmapLiveController()
  const controller = controllerRef.current
  const routeStates = useRouteStates()

  useEffect(() => {
    controller.attach({ markRouteStatus: routeStates.markRouteStatus, beginRequest: routeStates.beginRequest })
    void controller.connect()
    return () => controller.detach()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const snapshot = useSyncExternalStore(
    (onChange) => controller.subscribe(onChange),
    () => controller.getSnapshot(),
  )

  const value = useMemo<AmapLiveContextValue>(
    () => ({
      ...snapshot,
      select: (day) => controller.select(day),
      overview: () => controller.overview(),
      refresh: () => controller.refresh(),
      setTraffic: (checked) => controller.setTraffic(checked),
      submitEndpoints: (from, to) => controller.submitEndpoints(from, to),
      retry: () => controller.retry(),
      useReferenceMapForPicker: (picking) => controller.useReferenceMapForPicker(picking),
    }),
    [snapshot, controller],
  )

  return <AmapLiveContext.Provider value={value}>{children}</AmapLiveContext.Provider>
}

export function useAmapLive(): AmapLiveContextValue {
  const value = useContext(AmapLiveContext)
  if (!value) throw new Error('useAmapLive 必须在 AmapLiveProvider 内使用')
  return value
}