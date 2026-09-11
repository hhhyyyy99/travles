/**
 * Print sheet (ticket 08) — React rendering of the legacy print markup
 * (accommodation-print.js `render` + `stayMarkup`, L65–91) into the
 * `#print-itinerary` container (hidden on screen, shown under `@media print`
 * by the custom print stylesheet in index.css).
 *
 * Everything here is DERIVED from the single authoritative accommodation
 * state + the route-state store — no duplicate data copy. The legacy DOM
 * contract is preserved: `article.print-day[data-day-index]`,
 * `div.print-route[data-route-status]` (+ `is-stale`), `section.print-stay`
 * with `data-stay-id`, and the header summary strings.
 */
import { tripPlan } from '../data/itinerary'
import { getDayStay } from '../domain/accommodation'
import {
  printRouteInfo,
  printScheduleRows,
  printSheetSummary,
  printStayLabel,
} from '../domain/printItinerary'
import type { RouteState } from '../domain/routeStates'
import type { AccommodationState } from '../domain/types'

const typeLabel = (type: 'area' | 'hotel'): string => (type === 'area' ? '住宿区域' : '酒店 / 民宿')

export function PrintItinerary({
  state,
  routeStates,
}: {
  state: AccommodationState
  routeStates: Record<number, RouteState>
}) {
  const summary = printSheetSummary(state)
  const headerNote = summary.areaUsed
    ? '住宿内容来自当前浏览器的行程安排；住宿区域按代表位置估算。'
    : '住宿内容来自当前浏览器的行程安排。'

  return (
    <div id="print-itinerary">
      <section className="print-sheet-header">
        <p className="eyebrow">TRIP ITINERARY / ACCOMMODATION</p>
        <h1>呼伦贝尔自驾行程</h1>
        <p className="print-sheet-summary">
          {summary.nightCount} 晚 · {summary.usedBaseCount} 处实际使用的住宿基地
        </p>
        <p className="print-sheet-note">{headerNote}</p>
      </section>
      <section className="print-days" aria-label="住宿与每日行程">
        {tripPlan.days.map((day, dayIndex) => {
          const stay = getDayStay(state, dayIndex)
          const route = printRouteInfo(state, routeStates, dayIndex)
          const schedule = printScheduleRows(day, route.stale)
          return (
            <article className="print-day" data-day-index={dayIndex} key={dayIndex}>
              <header className="print-day-heading">
                <div>
                  <p className="eyebrow">
                    DAY {String(dayIndex + 1).padStart(2, '0')} / {day.date} {day.weekday}
                  </p>
                  <h2>{day.title}</h2>
                </div>
                <span className="tag">{day.pace}</span>
              </header>
              <div className={`print-route${route.stale ? ' is-stale' : ''}`} data-route-status={route.status}>
                <span className="print-route-label">路线</span>
                <strong>
                  {route.from} → {route.to}
                </strong>
                <b>{route.label}</b>
                {route.note ? <p>{route.note}</p> : null}
              </div>
              {stay ? (
                <section className="print-stay" data-stay-id={stay.id}>
                  <p className="print-stay-label">{printStayLabel(dayIndex)}</p>
                  <strong>{stay.name || '未命名住宿'}</strong>
                  <span>{typeLabel(stay.type)}</span>
                  {stay.type === 'area' ? <p className="print-stay-disclaimer">住宿区域，路线按代表位置估算。</p> : null}
                  {stay.address ? (
                    <p>
                      <b>地址</b>
                      {stay.address}
                    </p>
                  ) : null}
                  {stay.notes ? (
                    <p>
                      <b>备注</b>
                      {stay.notes}
                    </p>
                  ) : null}
                </section>
              ) : null}
              <p className="print-day-description">{day.desc}</p>
              <div className="print-timeline">
                {schedule.map(([time, title, description], index) => (
                  <div className="print-time-row" key={index}>
                    <time>{time}</time>
                    <div>
                      <strong>{title}</strong>
                      <p>{description}</p>
                    </div>
                  </div>
                ))}
              </div>
              <p className="print-day-tip">{day.tip}</p>
            </article>
          )
        })}
      </section>
    </div>
  )
}