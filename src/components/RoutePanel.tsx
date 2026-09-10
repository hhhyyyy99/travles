import { Fragment, useRef, type FormEvent, type RefObject } from 'react'
import { ArrowRight, RefreshCw, Scan } from 'lucide-react'
import { tripPlan } from '../data/itinerary'
import { useAmapLive } from '../hooks/useAmapLive'
import { DayDetail } from './DayDetail'

export interface RoutePanelProps {
  /** React ref bound to the #route-map container (owned by App's map hook). */
  containerRef: RefObject<HTMLDivElement | null>
  selectedDay: number
  /** true while the whole-trip overview (#overview-times) is shown. */
  overview: boolean
  /** legend text rendered after the .line-sample swatch. */
  legend: string
  /** tile-error fallback visible. */
  tileError: boolean
  /** #fit-map click → whole-trip view, and day selection from the list. */
  onFit: () => void
  onSelectDay: (day: number) => void
}

const ROUTE_STRIP_STOPS = [
  '海拉尔机场',
  '海拉尔',
  '莫尔格勒河',
  '额尔古纳',
  '莫尔道嘎',
  '室韦',
  '黑山头',
  '186彩带河',
  '满洲里',
  '呼伦湖',
  '海拉尔',
  '海拉尔机场',
]

/** 本地候选（未连接高德时的兜底）— amap-integration.js:22–30. */
const SUGGESTION_LIST = (() => {
  const seen = new Set<string>()
  const items: string[] = []
  ;(tripPlan.overviewStops || []).forEach((stop) => {
    if (stop?.keyword && !seen.has(stop.keyword)) {
      seen.add(stop.keyword)
      items.push(stop.keyword)
    }
  })
  ;[
    '海拉尔站',
    '海拉尔东山机场',
    '呼伦贝尔大草原',
    '呼和诺尔草原',
    '额尔古纳湿地景区',
    '额尔古纳市',
    '莫尔道嘎国家森林公园',
    '室韦口岸',
    '黑山头镇',
    '186彩带河景区',
    '满洲里国门景区',
    '满洲里套娃广场',
    '呼伦湖旅游景区',
  ].forEach((keyword) => {
    if (!seen.has(keyword)) {
      seen.add(keyword)
      items.push(keyword)
    }
  })
  return items
})()

/**
 * 路线面板 — .route-panel (.trip-map-toolbar + .map-wrap + .route-strip +
 * .amap-live + #day-detail). Faithful port of the index.html:16 scaffold and
 * the amap-integration injected panels (note C §7): the map-wrap toggles
 * `.amap-active` when the AMap canvas controls the view, `#amap-time-badge`
 * and `#overview-times` live inside .map-wrap, and the live section mirrors
 * the legacy DOM/aria contract byte-identical.
 */
export function RoutePanel({ containerRef, selectedDay, overview, legend, tileError, onFit, onSelectDay }: RoutePanelProps) {
  const amap = useAmapLive()
  const day = tripPlan.days[selectedDay] ?? tripPlan.days[0]!
  const fromRef = useRef<HTMLInputElement | null>(null)
  const toRef = useRef<HTMLInputElement | null>(null)
  const formKey = `${selectedDay}-${amap.formFrom}-${amap.formTo}`

  const submitEndpoints = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    amap.submitEndpoints(fromRef.current?.value ?? '', toRef.current?.value ?? '')
  }

  // While AMap controls the view its whole-trip result drives #overview-times;
  // otherwise the reference (Leaflet) overview flag does (ticket 02).
  const showOverviewTimes = amap.connected ? amap.overviewTimesVisible : overview

  return (
    <div className="route-panel">
      <div className="trip-map-toolbar">
        <span id="amap-state" role="status">
          {amap.amapStateText}
        </span>
        <div>
          <label>
            <input
              id="traffic-toggle"
              type="checkbox"
              checked={amap.trafficChecked}
              disabled={amap.trafficDisabled}
              onChange={(event) => amap.setTraffic(event.target.checked)}
            />
            实时路况
          </label>
          <button
            id="amap-refresh"
            type="button"
            title="刷新路线时间与路况"
            aria-label="刷新路线时间与路况"
            disabled={amap.refreshDisabled}
            onClick={amap.refresh}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className={`map-wrap${amap.connected ? ' amap-active' : ''}`}>
        <div id="amap-canvas" aria-label="高德地图与实时交通" hidden={!amap.connected} />
        <div id="route-map" ref={containerRef} aria-label="海拉尔出发呼伦贝尔环线自驾路线地图" />
        <div className="map-title">
          <span>THE SLOW ROUTE</span>
          <strong>从草原，到边境之城</strong>
        </div>
        <button type="button" className="fit-map" id="fit-map" title="查看全程" aria-label="查看全程" onClick={onFit}>
          <Scan aria-hidden="true" />
        </button>
        <div id="map-error" hidden={!tileError}>
          底图暂不可用，地点与路线示意仍可查看。
        </div>
        <div className="map-legend">
          <span className="line-sample" />
          {legend}
        </div>
        {amap.badge && (
          <div id="amap-time-badge" className="map-time-badge">
            <small>{amap.badge.small}</small>
            <strong>{amap.badge.strong}</strong>
            <span>{amap.badge.span}</span>
          </div>
        )}
        {showOverviewTimes && (
          <div id="overview-times">
            {tripPlan.estimates.map((estimate) => (
              <button
                key={estimate.day}
                data-route-day={estimate.day}
                onClick={() => onSelectDay(estimate.day)}
              >
                <span>{estimate.title}</span>
                <strong>{estimate.time}</strong>
              </button>
            ))}
            <small>行程预估 · 点击查看路段</small>
          </div>
        )}
      </div>
      <div className="route-strip">
        {ROUTE_STRIP_STOPS.map((stop, index) => (
          <Fragment key={index}>
            {index > 0 && <ArrowRight aria-hidden="true" />}
            <span>{stop}</span>
          </Fragment>
        ))}
      </div>
      <datalist id="place-suggestions">
        {SUGGESTION_LIST.map((keyword) => (
          <option key={keyword} value={keyword} />
        ))}
      </datalist>
      <section className="amap-live" aria-label="高德路线与路况">
        <div className="live-header">
          <h2 id="live-title">{amap.liveTitle}</h2>
          {amap.connectLabel !== null && (
            <button type="button" id="connect-amap" onClick={amap.retry}>
              {amap.connectLabel}
            </button>
          )}
        </div>
        <p id="live-status" role="status">
          {amap.liveStatus}
        </p>
        <form id="route-endpoints" hidden={!amap.connected || amap.wholeTrip} onSubmit={submitEndpoints}>
          <label>
            出发地
            <input
              key={formKey}
              id="route-from"
              ref={fromRef}
              defaultValue={amap.formFrom}
              required
              maxLength={120}
              autoComplete="off"
              list={amap.connected ? undefined : 'place-suggestions'}
            />
          </label>
          <label>
            目的地
            <input
              key={formKey}
              id="route-to"
              ref={toRef}
              defaultValue={amap.formTo}
              required
              maxLength={120}
              autoComplete="off"
              list={amap.connected ? undefined : 'place-suggestions'}
            />
          </label>
          <button type="submit">规划路线</button>
        </form>
        <div id="live-results">
          {amap.metrics && (
            <div className="live-metrics">
              <div>
                <span>预计驾驶</span>
                <strong>{amap.metrics.durationText}</strong>
              </div>
              <div>
                <span>路线距离</span>
                <strong>{amap.metrics.distanceKm}</strong>
              </div>
              <div>
                <span>路况数据</span>
                <strong>{amap.metrics.trafficKnownText}</strong>
              </div>
            </div>
          )}
          {amap.trafficRows.length > 0 && (
            <div className="traffic-summary">
              {amap.trafficRows.map((row) => (
                <span key={row.status}>
                  <b style={{ background: row.color }} />
                  {row.status} {row.km}
                </span>
              ))}
            </div>
          )}
          {amap.resolvedEndpoints && (
            <p className="resolved-endpoints">
              {amap.resolvedEndpoints.start} → {amap.resolvedEndpoints.end}。请核对具体入口；可修改上方酒店或航站楼名称重新规划。
            </p>
          )}
          {amap.steps.length > 0 && (
            <details className="road-details">
              <summary>沿途道路与转向</summary>
              <ol>
                {amap.steps.map((step, index) => (
                  <li key={index}>
                    <strong>{step.road}</strong>
                    <span>{step.instruction}</span>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
        <p className="traffic-disclaimer">当前路况不代表 10 月出发当天；无覆盖路段标为未知。驾驶时间不含游览、休息、停车与景区排队。</p>
      </section>
      <article id="day-detail" aria-live="polite">
        <DayDetail day={day} index={selectedDay} />
      </article>
    </div>
  )
}