/**
 * 行程画布 (ticket 04, read-only) — horizontal per-day columns, day headers
 * (date + weekday + per-day accent color + theme) and the four card types
 * with cover image, order number and note; adjacent cards are joined by a
 * transport leg chip ("30.3 千米 · 31 分钟") rendered from server data only
 * (recomputation is ticket 09's job).
 */
import { Car } from 'lucide-react'
import {
  CARD_TYPE_LABEL,
  cardVisual,
  dayAccentColor,
  dayDateLabel,
  formatLegLabel,
  legsByPair,
  weekdayLabel,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchLeg,
} from '../../domain/workbench'

const VISUAL_CLASSES = {
  traffic: {
    bar: 'border-l-[#4f6dc2]',
    badge: 'bg-[#4f6dc2]',
  },
  stay: {
    bar: 'border-l-[#3f7d5c]',
    badge: 'bg-[#3f7d5c]',
  },
  attraction: {
    bar: 'border-l-[#c26d4f]',
    badge: 'bg-[#c26d4f]',
  },
  other: {
    bar: 'border-l-[#8a938d]',
    badge: 'bg-[#8a938d]',
  },
} as const

export default function CanvasColumn({ days, legs }: { days: WorkbenchDay[]; legs: WorkbenchLeg[] }) {
  const legLookup = legsByPair(legs)
  return (
    <div id="workbench-canvas" className="h-full overflow-x-auto overflow-y-hidden bg-paper">
      <div className="flex h-full items-stretch gap-[16px] px-[16px] py-[16px]">
        {days.length === 0 && (
          <p
            id="workbench-canvas-empty"
            className="self-center border border-dashed border-line rounded-[8px] px-[28px] py-[36px] text-[13px] text-muted"
          >
            这份行程还没有安排 —— 等圆周帮你规划，或稍后再来看看。
          </p>
        )}
        {days.map((day) => (
          <DayColumn key={day.id} day={day} legLookup={legLookup} />
        ))}
      </div>
    </div>
  )
}

function DayColumn({ day, legLookup }: { day: WorkbenchDay; legLookup: Map<string, WorkbenchLeg> }) {
  const accent = dayAccentColor(day.color, day.index)
  return (
    <section
      data-canvas-day={day.id}
      className="flex w-[292px] shrink-0 flex-col rounded-[8px] border border-line bg-white"
    >
      <header className="shrink-0 border-b border-line px-[14px] py-[12px]">
        <div className="flex items-center gap-[8px]">
          <span
            aria-hidden="true"
            className="inline-block h-[10px] w-[10px] rounded-full"
            style={{ backgroundColor: accent }}
          />
          <span className="text-[14px] font-[600]" style={{ color: accent }}>
            {dayDateLabel(day.date) || `D${day.index + 1}`}
          </span>
          <span className="text-[12px] text-muted">{weekdayLabel(day.date)}</span>
          <span className="ml-auto text-[11px] text-muted">D{day.index + 1}</span>
        </div>
        {day.theme && <p className="mt-[6px] text-[13px] font-[550] text-ink">{day.theme}</p>}
      </header>
      <div className="flex flex-1 flex-col gap-[10px] overflow-y-auto p-[12px]">
        {day.items.map((item, i) => (
          <div key={item.id} className="flex flex-col gap-[10px]">
            {i > 0 && <LegChip leg={legLookup.get(`${day.items[i - 1]?.id}|${item.id}`) ?? null} />}
            <CanvasCard item={item} order={i + 1} accent={accent} />
          </div>
        ))}
      </div>
    </section>
  )
}

function CanvasCard({ item, order, accent }: { item: WorkbenchItem; order: number; accent: string }) {
  const visual = VISUAL_CLASSES[cardVisual(item.type)]
  const cover = item.images[0]?.url ?? null
  const isPlainText = item.poi === null && cover === null
  return (
    <article
      data-canvas-card={item.id}
      data-card-type={item.type}
      data-card-plain-text={isPlainText || undefined}
      className={`overflow-hidden rounded-[6px] border border-line border-l-[3px] bg-white shadow-sm ${visual.bar} ${
        isPlainText ? 'border-dashed' : ''
      }`}
    >
      <div className="flex items-center gap-[8px] px-[10px] pt-[8px]">
        <span
          aria-hidden="true"
          className="grid h-[18px] w-[18px] place-items-center rounded-full text-[10px] font-[600] text-white"
          style={{ backgroundColor: accent }}
        >
          {order}
        </span>
        <span className={`rounded-[4px] px-[6px] py-[1px] text-[10px] text-white ${visual.badge}`}>
          {CARD_TYPE_LABEL[item.type]}
        </span>
        {item.pending && (
          <span className="ml-auto rounded-[4px] border border-[#b75342] px-[6px] py-[1px] text-[10px] text-[#b75342]">
            待定
          </span>
        )}
      </div>
      {cover !== null && (
        <img
          src={cover}
          alt=""
          className="mt-[8px] h-[92px] w-full object-cover"
          data-canvas-card-cover={item.id}
        />
      )}
      <div className="px-[10px] py-[8px]">
        <h3 className="text-[13px] font-[550] text-ink">{item.title}</h3>
        {item.poi !== null && (
          <p className="mt-[2px] text-[11px] text-muted" data-canvas-card-poi={item.id}>
            {item.poi.category ? `${item.poi.category} · ` : ''}
            {item.poi.name}
            {item.poi.rating > 0 ? ` · ${item.poi.rating}分` : ''}
          </p>
        )}
        {item.note && <p className="mt-[4px] text-[12px] text-muted leading-[1.6]">{item.note}</p>}
      </div>
    </article>
  )
}

function LegChip({ leg }: { leg: WorkbenchLeg | null }) {
  const label = formatLegLabel(leg)
  if (!label) return null
  return (
    <div
      data-leg-chip={leg?.id ?? ''}
      className="flex items-center gap-[6px] rounded-[999px] border border-line bg-paper px-[10px] py-[3px] text-[11px] text-muted"
    >
      <Car aria-hidden="true" className="w-[12px]" />
      {label}
    </div>
  )
}
