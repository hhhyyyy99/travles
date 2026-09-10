import { ArrowUpRight, BedDouble, CarFront, LocateFixed, MapPin, Mountain, Navigation } from 'lucide-react'
import type { ItineraryDay } from '../domain/types'
import { legByDay, roadRoutes } from '../data/roadRoutes'
import { navigationUrl, searchUrl } from '../services/navigationUrl'

interface DayDetailProps {
  day: ItineraryDay
  index: number
}

const STALE_STATUSES = new Set(['stale', 'pending', 'unupdated'])

/**
 * 驾车路线 panel — faithful port of trip.js `navigationPanel` (46–65) with the
 * accommodation-absent fallbacks: route undefined → static leg, status
 * `reference`, endpoint names from `d.nav`, note = the static reference note.
 */
function NavigationPanel({ day, index }: DayDetailProps) {
  // Ticket 02: no accommodation → legacy resolves route=undefined,
  // routeState={status:'reference'}, stale=false and leg=static leg.
  const legIndex = legByDay[index]
  const leg = legIndex != null ? roadRoutes.legs[legIndex] : undefined
  const stale = false
  const localDay = day.points.length < 2
  const roads = leg ? leg.roads.filter((r) => /^[GS]\d/.test(r)).join(' → ') : ''
  const fromName = day.nav[0]
  const toName = day.nav[1]
  const routeDescription =
    stale ? '路线未更新'
      : leg ? `参考里程约 ${(leg.distance / 1000).toFixed(0)} km${roads ? ` · ${roads}` : ''}`
      : '市内目的地 · 以高德实时规划为准'
  const routeNote = localDay
    ? '当天不安排长途驾驶，景区内交通以观光车及酒店接驳为准。'
    : '起终点为区域参考位置，请在高德中确认酒店、景区入口或航站楼。手机可调起高德；当前位置导航需要手机定位。'

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
        <a className="navigation-primary" href={navigationUrl(day)} target="_blank" rel="noopener">
          {localDay ? <MapPin aria-hidden="true" /> : <Navigation aria-hidden="true" />}
          {localDay ? '查看当天住处' : '高德路线规划'}
        </a>
        {!localDay && (
          <a className="navigation-current" href={navigationUrl(day, true)} target="_blank" rel="noopener">
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
 * 每日详情卡片 — faithful port of trip.js `detail` (66–76) with accommodation
 * fallbacks: stay = `d.stay` (no stay-card, no 更换住宿 button), drive text =
 * `d.drive`, schedule untouched, links from `searchUrl`.
 */
function DetailCard({ day, index }: DayDetailProps) {
  const stayName = day.stay
  const driveText = day.drive

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
        {day.schedule.map((row, rowIndex) => (
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