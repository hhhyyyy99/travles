/**
 * 工作台顶栏 (ticket 04) — back entry, trip title and the same date-range
 * badge the trip list uses ("10.02至10.08 7天6晚", reused formatters).
 */
import { ArrowLeft, CalendarDays } from 'lucide-react'
import { formatDateBadge, formatDuration, type TripSummary } from '../../domain/tripList'

export default function WorkbenchTopbar({ trip, onBack }: { trip: TripSummary; onBack: () => void }) {
  const badge = [formatDateBadge(trip.startDate, trip.endDate), formatDuration(trip.days, trip.nights)]
    .filter(Boolean)
    .join(' ')
  return (
    <header
      id="workbench-topbar"
      className="flex h-[60px] shrink-0 items-center gap-[16px] border-b border-line bg-white px-[16px]"
    >
      <button
        id="workbench-back"
        type="button"
        title="返回行程列表"
        aria-label="返回行程列表"
        onClick={onBack}
        className="grid h-[36px] w-[36px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
      >
        <ArrowLeft aria-hidden="true" className="w-[16px]" />
      </button>
      <h1 id="workbench-trip-title" className="text-[17px] font-[600] truncate">
        {trip.title}
      </h1>
      {badge && (
        <span
          id="workbench-trip-badge"
          className="inline-flex shrink-0 items-center gap-[6px] rounded-[999px] border border-line bg-paper px-[10px] py-[3px] text-[12px] text-green"
        >
          <CalendarDays aria-hidden="true" className="w-[13px]" />
          {badge}
        </span>
      )}
    </header>
  )
}
