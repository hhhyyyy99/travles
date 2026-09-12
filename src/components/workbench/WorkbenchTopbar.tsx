/**
 * 工作台顶栏 (ticket 04) — back entry, trip title and the same date-range
 * badge the trip list uses ("10.02至10.08 7天6晚", reused formatters).
 */
import { ArrowLeft, BedDouble, CalendarDays, Printer, WandSparkles } from 'lucide-react'
import { formatTripSchedule, type TripSummary } from '../../domain/tripList'

export default function WorkbenchTopbar({
  trip,
  onBack,
  onOptimize,
  optimizing = false,
  onPrint,
  onOpenStays,
}: {
  trip: TripSummary
  onBack: () => void
  onOptimize?: () => void
  optimizing?: boolean
  onPrint?: () => void
  onOpenStays?: () => void
}) {
  const badge = formatTripSchedule(trip)
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
      {onOptimize && (
        <button
          type="button"
          data-action="route-optimize"
          title="生成路线优化建议"
          aria-label="生成路线优化建议"
          disabled={optimizing}
          onClick={onOptimize}
          className="ml-auto inline-flex h-[30px] items-center gap-[5px] rounded-[5px] border border-green/40 px-[9px] text-[12px] text-green transition-colors hover:bg-green hover:text-white disabled:opacity-50"
        >
          <WandSparkles aria-hidden="true" className="w-[13px]" />
          {optimizing ? '生成中…' : '路线优化'}
        </button>
      )}
      {onPrint && (
        <button
          type="button"
          id="workbench-print"
          data-action="print-workbench"
          title="打印当前行程"
          aria-label="打印当前行程"
          onClick={onPrint}
          className="grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line text-muted transition-colors hover:border-green hover:text-green"
        >
          <Printer aria-hidden="true" className="w-[14px]" />
        </button>
      )}
      {onOpenStays && (
        <button
          type="button"
          data-action="edit-workbench-stays"
          title="编辑当前行程住宿"
          aria-label="编辑当前行程住宿"
          onClick={onOpenStays}
          className="grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line text-muted transition-colors hover:border-green hover:text-green"
        >
          <BedDouble aria-hidden="true" className="w-[14px]" />
        </button>
      )}
    </header>
  )
}
