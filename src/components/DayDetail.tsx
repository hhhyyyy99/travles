import { ArrowUpRight, BedDouble, CarFront, LocateFixed, MapPin, Mountain, Navigation, Replace } from 'lucide-react'
import type { ItineraryDay, ScheduleRow } from '../domain/types'
import { legByDay, roadRoutes } from '../data/roadRoutes'
import { navigationLimitNote, navigationUrl, searchUrl } from '../services/navigationUrl'
import { useRouteStates } from '../hooks/useRouteStates'
import { useAccommodation } from '../hooks/useAccommodation'
import { getDayStay, getDayRoute } from '../domain/accommodation'
import { hasCoordinates } from '../domain/geo'
import { routeDisplayNames } from '../domain/routeView'
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
  const { state: accommodationState } = useAccommodation()
  const state = get(index)
  const route = getDayRoute(accommodationState, index)
  const stale = isStaleStatus(state.status)
  const legIndex = legByDay[index]
  // trip.js:51 — `route?.hasChangedEndpoint || stale` drops the static leg for
  // changed-endpoint days (their estimate comes from the live query only).
  const leg = legIndex != null && !route?.hasChangedEndpoint && !stale ? roadRoutes.legs[legIndex] : undefined
  const localDay = day.points.length < 2
  const names = routeDisplayNames(accommodationState, index)
  const fromName = names.from
  const toName = names.to
  const routeDescription = describeRouteEstimate(
    state,
    leg ? { distance: leg.distance, roads: leg.roads } : null,
  )
  // trip.js:54 — the changed-endpoint area suffix 住宿区域按代表位置估算。comes from
  // the accommodation route (threaded only through the stale branch).
  const routeNote = describeRouteNote(state, localDay, route)
  const externalNote = navigationLimitNote(route)
  const primaryHref = state.navigation?.primary ?? navigationUrl(day, false, route)
  const currentHref = state.navigation?.current ?? navigationUrl(day, true, route)
  const placeLinks = (route?.via ?? []).filter((point) => point.keywordOnly || !hasCoordinates(point))

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
      <p className="navigation-note">
        {routeNote}
        {externalNote ? ` ${externalNote}` : ''}
      </p>
      {placeLinks.length > 0 && (
        <p className="navigation-place-links">
          {placeLinks.map((point) => (
            <a key={point.name} href={searchUrl(point.keyword || point.name)} target="_blank" rel="noopener">
              <MapPin aria-hidden="true" />
              搜索{point.name}
              <ArrowUpRight aria-hidden="true" />
            </a>
          ))}
        </p>
      )}
    </div>
  )
}

/**
 * 每日详情卡片 — faithful port of trip.js `detail` (66–76); the drive text and
 * the schedule rows follow the route state (路线未更新 while stale/pending).
 */
function DetailCard({ day, index }: DayDetailProps) {
  const { get } = useRouteStates()
  const { state: accommodationState } = useAccommodation()
  const state = get(index)
  const routeChanged = isStaleStatus(state.status)
  // trip.js:67–75 — stay card surfaces the accommodation stay with the
  // `data-accommodation-open` button (opened by the dialog's document click
  // delegation); the meta line is `住宿区域 · ` prefix + address, else
  // `已确认地图位置`.
  const stay = getDayStay(accommodationState, index)
  const stayName = stay?.name || day.stay
  const stayMeta = stay
    ? `${stay.type === 'area' ? '住宿区域 · ' : ''}${stay.address ? stay.address : '已确认地图位置'}`
    : ''
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
      {stay && (
        <div className="stay-card">
          <div>
            <span className="eyebrow">本晚住宿</span>
            <strong>{stayName}</strong>
            <small>{stayMeta}</small>
            {stay.notes ? <p>{stay.notes}</p> : null}
          </div>
          <button type="button" data-accommodation-open={index}>
            <Replace aria-hidden="true" />
            更换住宿
          </button>
        </div>
      )}
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
        <a href={searchUrl(stay?.name || day.nav[1])} target="_blank" rel="noopener">
          <MapPin aria-hidden="true" />
          高德查看目的地
          <ArrowUpRight aria-hidden="true" />
        </a>
        <a href={searchUrl(stay?.name || day.nav[0])} target="_blank" rel="noopener">
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