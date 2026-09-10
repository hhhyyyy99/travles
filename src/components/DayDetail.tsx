import { ArrowUpRight, BedDouble, CarFront, LocateFixed, MapPin, Mountain, Navigation } from 'lucide-react'
import type { ItineraryDay, ScheduleRow } from '../domain/types'
import { legByDay, roadRoutes } from '../data/roadRoutes'
import { navigationUrl, searchUrl } from '../services/navigationUrl'
import { useRouteStates } from '../hooks/useRouteStates'
import {
  describeDriveText,
  describeRouteEstimate,
  describeRouteNote,
  isStaleStatus,
  rewriteScheduleRow,
} from '../domain/routeStates'

interface DayDetailProps {
  day: ItineraryDay
  index: number
}

const STALE_STATUSES = new Set(['stale', 'pending', 'unupdated'])

/**
 * 驾车路线 panel — faithful port of trip.js `navigationPanel` (46–65) driven by
 * the route-state store. Ticket 03 has no accommodation, so endpoints stay at
 * `d.nav` and the static leg stays visible until a live query failure; the
 * label precedence (updated → stale → static leg → urban) is the legacy one.
 */
function NavigationPanel({ day, index }: DayDetailProps) {
  const { get } = useRouteStates()
  const state = get(index)
  const stale = isStaleStatus(state.status)
  const legIndex = legByDay[index]
  const leg = legIndex != null && !stale ? roadRoutes.legs[legIndex] : undefined
  const localDay = day.points.length < 2
  const roads = leg ? leg.roads.filter((r) => /^[GS]\d/.test(r)).join(' → ') : ''
  const fromName = day.nav[0]
  const toName = day.nav[1]
  const routeDescription = describeRouteEstimate(
    state,
    leg ? { distance: leg.distance, roads: leg.roads } : null,
  )
  const routeNote = describeRouteNote(state, localDay)
  const primaryHref = state.navigation?.primary ?? navigationUrl(day)
  const currentHref = state.navigation?.current ?? navigationUrl(day, true)

  return (
    <div className="navigation-panel">
      <div>
        <span className="eyebrow">{stale ? '路线状态' : localDay ? '当地休整日' : '驾车路线'}</span>
        <strong>
          {fromName} → {toName}
        </strong>
        <p className={`route-estimate ${stale ? 'is-stale' : ''}`}>{routeDescription}</p>
      </div>
      <div className="navigation-actions">
        <a className="navigation-primary" href={primaryHref} target="_blank" rel="noopener">
          {localDay ? <MapPin aria-hidden="true" /> : <Navigation aria-hidden="true" />}
          {localDay ? '查看当天住处' : '高德路线规划'}
        </a>
        {!localDay && (
          <a className="navigation-current" href={currentHref} target="_blank" rel="noopener">
            <LocateFixed aria-hidden="true" />
            从当前位置导航
          </a>
        )}
      </div>
      <p className="navigation-note">{routeNote}</p>
    </div>
  )
}

/**
 * 每日详情卡片 — faithful port of trip.js `detail` (66–76); the drive text and
 * the schedule rows follow the route state (路线未更新 while stale/pending).
 */
function DetailCard({ day, index }: DayDetailProps) {
  const { get } = useRouteStates()
  const state = get(index)
  const routeChanged = isStaleStatus(state.status)
  const stayName = day.stay
  const driveText = describeDriveText(state, day.drive)
  const schedule = routeChanged
    ? day.schedule.map((row) => [row[0], row[1], rewriteScheduleRow(row[2], true)] as ScheduleRow)
    : day.schedule

  return (
    <>
      <div className="detail-heading">
        <div>
          <p className="eyebrow">
            DAY {String(index + 1).padStart(2, '0')} / {day.date} {day.weekday}
          </p>
          <h2>{day.title}</h2>
        </div>
        <span className="tag">{day.pace}</span>
      </div>
      <p className="day-desc">{day.desc}</p>
      <div className="day-stats">
        <span>
          <CarFront aria-hidden="true" />
          {driveText}
        </span>
        <span>
          <BedDouble aria-hidden="true" />
          {stayName}
        </span>
        <span>
          <Mountain aria-hidden="true" />
          {day.alt}
        </span>
      </div>
      <div className="timeline">
        {schedule.map((row, rowIndex) => (
          <div className="time-row" key={rowIndex}>
            <time>{row[0]}</time>
            <div>
              <strong>{row[1]}</strong>
              <p>{row[2]}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="day-tip">{day.tip}</p>
      <div className="day-links">
        <a href={searchUrl(day.nav[1])} target="_blank" rel="noopener">
          <MapPin aria-hidden="true" />
          高德查看目的地
          <ArrowUpRight aria-hidden="true" />
        </a>
        <a href={searchUrl(day.nav[0])} target="_blank" rel="noopener">
          查看出发地
          <ArrowUpRight aria-hidden="true" />
        </a>
      </div>
    </>
  )
}

/** Port of `navigationPanel(dayIndex) + detail(day, dayIndex)` (trip.js:172). */
export function DayDetail({ day, index }: DayDetailProps) {
  return (
    <>
      <NavigationPanel day={day} index={index} />
      <DetailCard day={day} index={index} />
    </>
  )
}

export { STALE_STATUSES }