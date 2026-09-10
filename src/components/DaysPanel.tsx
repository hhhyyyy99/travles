import { BedDouble, ChevronRight } from 'lucide-react'
import { tripPlan } from '../data/itinerary'

interface DaysPanelProps {
  selectedDay: number
  onSelectDay: (day: number) => void
}

/**
 * 每日行程选择列表 — faithful port of trip.js:165–166 + index.html:15.
 * Each button: class `day-button`, `data-day`, `aria-pressed` (only the
 * selected day), children `.day-num` / `.day-copy` (small date · strong
 * short · em pace) + chevron icon.
 */
export function DaysPanel({ selectedDay, onSelectDay }: DaysPanelProps) {
  return (
    <aside className="days-panel">
      <div className="section-label">
        <h2>这一路</h2>
        <span>01 — 07</span>
      </div>
      <div id="days" aria-label="选择每日行程">
        {tripPlan.days.map((day, index) => (
          <button
            type="button"
            key={day.date}
            className="day-button"
            aria-pressed={index === selectedDay}
            data-day={index}
            onClick={() => onSelectDay(index)}
          >
            <span className="day-num">{String(index + 1).padStart(2, '0')}</span>
            <span className="day-copy">
              <small>
                {day.date} {day.weekday}
              </small>
              <strong>{day.short}</strong>
              <em>{day.pace}</em>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="stay-note">
        <BedDouble aria-hidden="true" />
        <p id="stay-note-text">
          海拉尔 2 晚 → 额尔古纳 1 晚
          <br />
          莫尔道嘎 1 晚 → 黑山头 1 晚 → 满洲里 1 晚
          <small>10/2 · 10/7 · 10/3 · 10/4 · 10/5 · 10/6</small>
        </p>
      </div>
    </aside>
  )
}