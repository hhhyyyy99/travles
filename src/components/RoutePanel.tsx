import { Fragment, type RefObject } from 'react'
import { ArrowRight, Scan } from 'lucide-react'
import { tripPlan } from '../data/itinerary'
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

/**
 * 路线面板 — .map-wrap (Leaflet #route-map + overlays), .route-strip and
 * #day-detail. Faithful port of index.html:16 scaffold + trip.js choose/fit
 * DOM contract (overlays appended to .map-wrap, #overview-times as singleton).
 */
export function RoutePanel({ containerRef, selectedDay, overview, legend, tileError, onFit, onSelectDay }: RoutePanelProps) {
  const day = tripPlan.days[selectedDay] ?? tripPlan.days[0]!

  return (
    <div className="route-panel">
      <div className="map-wrap">
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
        {overview && (
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
      <article id="day-detail" aria-live="polite">
        <DayDetail day={day} index={selectedDay} />
      </article>
    </div>
  )
}