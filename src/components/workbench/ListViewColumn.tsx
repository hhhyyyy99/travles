/**
 * 列表视图 (ticket 10) — the center column's single-day vertical timeline.
 * Date tabs across the top switch days ("10.02 周五", with a "+" tab to
 * append a day); below, one day renders as a vertical timeline: stay rows,
 * transport-leg rows between cards, and item cards reusing the canvas card
 * component so both views stay visually consistent and render the same
 * server data (GET /api/trips/:id/canvas).
 */
import { useEffect, useRef, useState } from 'react'
import { BedDouble, Car, Trash2 } from 'lucide-react'
import {
  dayAccentColor,
  dayDateLabel,
  formatLegLabel,
  legsByPair,
  weekdayLabel,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchLeg,
} from '../../domain/workbench'
import { CanvasCard } from './CanvasColumn'
import EditableTheme from './EditableTheme'

export type ListViewColumnProps = {
  days: WorkbenchDay[]
  legs: WorkbenchLeg[]
  onAddDay?: () => void
  onThemeSave?: (dayId: string, theme: string) => void
  onDeleteDay?: (day: WorkbenchDay) => void
  syncing?: boolean
  onCardClick?: (itemId: string) => void
  highlightItemId?: string | null
}

export default function ListViewColumn({
  days,
  legs,
  onAddDay,
  onThemeSave,
  onDeleteDay,
  syncing = false,
  onCardClick,
  highlightItemId,
}: ListViewColumnProps) {
  const legLookup = legsByPair(legs)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Days seen so far, so a freshly added day can auto-select itself.
  const knownDayIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    const seen = knownDayIds.current
    const fresh = days.find((day) => !seen.has(day.id))
    for (const day of days) seen.add(day.id)
    if (fresh) setSelectedId(fresh.id)
  }, [days])

  useEffect(() => {
    if (!highlightItemId) return
    const containingDay = days.find((day) => day.items.some((item) => item.id === highlightItemId))
    if (containingDay) setSelectedId(containingDay.id)
  }, [days, highlightItemId])

  const selected = days.find((day) => day.id === selectedId) ?? days[0] ?? null

  return (
    <div id="workbench-list" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-paper" aria-busy={syncing}>
      {syncing && (
        <div
          data-list-syncing
          className="pointer-events-none absolute right-[14px] top-[58px] z-[10] inline-flex items-center gap-[5px] rounded-[5px] border border-line bg-white/95 px-[8px] py-[4px] text-[11px] text-muted shadow-sm"
          aria-live="polite"
        >
          <span aria-hidden="true" className="workbench-spinner h-[11px] w-[11px] rounded-full border-2 border-line border-t-green" />
          路线重算中…
        </div>
      )}
      <div
        id="workbench-list-tabs"
        role="tablist"
        aria-label="按天切换列表"
        className="flex shrink-0 items-center gap-[6px] overflow-x-auto border-b border-line bg-white px-[14px] py-[8px]"
      >
        {days.map((day) => {
          const active = day.id === selected?.id
          return (
            <button
              key={day.id}
              type="button"
              role="tab"
              aria-selected={active}
              data-list-tab={day.id}
              onClick={() => setSelectedId(day.id)}
              className={`flex shrink-0 items-center gap-[6px] rounded-[6px] border px-[10px] py-[4px] text-[12px] transition-colors ${
                active ? 'border-green bg-green/10 text-ink' : 'border-line bg-white text-muted hover:text-ink'
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-block h-[8px] w-[8px] rounded-full"
                style={{ backgroundColor: dayAccentColor(day.color, day.index) }}
              />
              {dayDateLabel(day.date) || `D${day.index + 1}`}
              <span className="text-[11px]">{weekdayLabel(day.date) || `D${day.index + 1}`}</span>
            </button>
          )
        })}
        {onAddDay && (
          <button
            type="button"
            data-action="add-day"
            onClick={onAddDay}
            title="添加一天"
            aria-label="添加一天"
            className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-[6px] border border-dashed border-line text-[14px] text-muted hover:border-green hover:text-green transition-colors"
          >
            +
          </button>
        )}
      </div>

      {selected === null ? (
        <p
          id="workbench-list-empty"
          className="m-[16px] self-center border border-dashed border-line rounded-[8px] px-[28px] py-[36px] text-[13px] text-muted"
        >
          这份行程还没有安排 —— 等圆周帮你规划，或稍后再来看看。
        </p>
      ) : (
        <DayTimeline
          day={selected}
          legLookup={legLookup}
          onThemeSave={onThemeSave}
          onDeleteDay={onDeleteDay}
          onCardClick={onCardClick}
          highlightItemId={highlightItemId}
        />
      )}
    </div>
  )
}

function DayTimeline({
  day,
  legLookup,
  onThemeSave,
  onDeleteDay,
  onCardClick,
  highlightItemId,
}: {
  day: WorkbenchDay
  legLookup: Map<string, WorkbenchLeg>
  onThemeSave?: (dayId: string, theme: string) => void
  onDeleteDay?: (day: WorkbenchDay) => void
  onCardClick?: (itemId: string) => void
  highlightItemId?: string | null
}) {
  const accent = dayAccentColor(day.color, day.index)
  const dateLabel = dayDateLabel(day.date) || `D${day.index + 1}`
  return (
    <section
      data-list-day={day.id}
      className="mx-auto my-[16px] flex w-full max-w-[560px] flex-col rounded-[8px] border border-line bg-white"
    >
      <header className="shrink-0 border-b border-line px-[16px] py-[12px]">
        <div className="flex items-center gap-[8px]">
          <span
            aria-hidden="true"
            className="inline-block h-[10px] w-[10px] rounded-full"
            style={{ backgroundColor: accent }}
          />
          <span className="text-[14px] font-[600]" style={{ color: accent }}>
            {dateLabel}
          </span>
          <span className="text-[12px] text-muted">{weekdayLabel(day.date)}</span>
          <span className="text-[11px] text-muted">D{day.index + 1}</span>
          <span className="ml-auto text-[11px] text-muted">{day.items.length} 项</span>
          {onDeleteDay && (
            <button
              type="button"
              data-action="delete-day"
              data-day-id={day.id}
              title={`删除 ${dateLabel}`}
              aria-label={`删除天 ${dateLabel}`}
              onClick={() => onDeleteDay(day)}
              className="grid h-[22px] w-[22px] place-items-center rounded-[4px] text-muted hover:text-[#b75342] transition-colors"
            >
              <Trash2 aria-hidden="true" className="w-[13px]" />
            </button>
          )}
        </div>
        {onThemeSave && <EditableTheme dayId={day.id} theme={day.theme} onSave={onThemeSave} />}
      </header>
      <div className="flex flex-col gap-[12px] p-[14px]">
        {day.items.length === 0 && (
          <p className="py-[12px] text-center text-[12px] text-muted">这一天还没有安排。</p>
        )}
        {day.items.map((item, i) => (
          <div key={item.id} className="flex flex-col gap-[12px]">
            {i > 0 && <LegRow leg={legLookup.get(`${day.items[i - 1]?.id}|${item.id}`) ?? null} />}
            {item.type === 'stay' ? (
              <StayRow
                item={item}
                accent={accent}
                onClick={onCardClick ? () => onCardClick(item.id) : undefined}
                highlighted={highlightItemId === item.id}
              />
            ) : (
              <CanvasCard
                item={item}
                order={i + 1}
                accent={accent}
                onClick={onCardClick ? () => onCardClick(item.id) : undefined}
                highlighted={highlightItemId === item.id}
              />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/** 住宿行 — the stay card's compact list form (bed icon + title + note). */
function StayRow({
  item,
  accent,
  onClick,
  highlighted = false,
}: {
  item: WorkbenchItem
  accent: string
  onClick?: () => void
  highlighted?: boolean
}) {
  const cover = item.images[0]?.url ?? null
  return (
    <article
      data-list-stay={item.id}
      data-card-type={item.type}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onClick()
        }
      }}
      tabIndex={onClick ? 0 : undefined}
      className="flex items-center gap-[10px] overflow-hidden rounded-[6px] border border-line border-l-[3px] bg-white px-[10px] py-[8px] shadow-sm"
      style={{ borderLeftColor: accent, ...(highlighted ? { boxShadow: `0 0 0 2px ${accent}` } : {}) }}
    >
      <span
        aria-hidden="true"
        className="grid h-[24px] w-[24px] shrink-0 place-items-center rounded-full text-white"
        style={{ backgroundColor: accent }}
      >
        <BedDouble className="w-[13px]" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-[550] text-ink">{item.title}</h3>
        {item.poi !== null && (
          <p className="mt-[2px] truncate text-[11px] text-muted">
            {item.poi.category ? `${item.poi.category} · ` : ''}
            {item.poi.name}
          </p>
        )}
        {item.note && <p className="mt-[2px] text-[12px] text-muted leading-[1.6]">{item.note}</p>}
      </div>
      {item.pending && (
        <span className="rounded-[4px] border border-[#b75342] px-[6px] py-[1px] text-[10px] text-[#b75342]">待定</span>
      )}
      {cover !== null && (
        <img src={cover} alt="" className="h-[40px] w-[56px] shrink-0 rounded-[4px] object-cover" />
      )}
    </article>
  )
}

/** 交通段行 — vertical variant of the canvas leg chip. */
function LegRow({ leg }: { leg: WorkbenchLeg | null }) {
  const label = formatLegLabel(leg)
  if (!label) return null
  return (
    <div
      data-list-leg={leg?.id ?? ''}
      className="flex items-center gap-[6px] rounded-[999px] border border-line bg-paper px-[10px] py-[3px] text-[11px] text-muted"
    >
      <Car aria-hidden="true" className="w-[12px]" />
      {label}
    </div>
  )
}
