/**
 * 行程画布 (ticket 04, read-only) — horizontal per-day columns, day headers
 * (date + weekday + per-day accent color + theme) and the four card types
 * with cover image, order number and note; adjacent cards are joined by a
 * transport leg chip ("30.3 千米 · 31 分钟") rendered from server data only.
 * Day management (ticket 10): inline theme edit, day delete (confirm handled
 * by the page), and an append-day button.
 *
 * Ticket 05 (additive): optional `onCardClick` / `highlightItemId` — the
 * map-panel linkage. Clicking a card asks the map to focus its POI; a marker
 * click highlights a card and scrolls its day column into view. Both props
 * are optional so the read-only canvas behavior is unchanged without them.
 *
 * Ticket 09 (additive, all optional): HTML5 drag to reorder within / across
 * days, the card "⋯" menu (上移一位 / 下移一位 / 移动到 / 复制到 / 添加图片 /
 * 编辑备注 / 删除 — the accessible reorder fallback), inline note editing and
 * image-URL adding on the card, a trailing "+" per day column and a toolbar
 * "添加" on the selected card. Page-level handlers stay optimistic and roll
 * back on failure; this component only reports intents.
 */
import { Fragment, useEffect, useState } from 'react'
import { Car, Plus, Trash2, WandSparkles } from 'lucide-react'
import {
  CARD_TYPE_LABEL,
  cardVisual,
  crossDayTransfers,
  dayAccentColor,
  dayDateLabel,
  formatLegDisplayLabel,
  formatLegLabel,
  isLongDriveLeg,
  legQuality,
  legsByPair,
  longDriveWarningText,
  weekdayLabel,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchLeg,
} from '../../domain/workbench'
import type { StashItem } from '../../domain/recommendations'
import EditableTheme from './EditableTheme'
import { CardMenu, DayPickerDialog, type CardMenuAction } from './CardMenu'
import CrossDayDriveWarning from './CrossDayDriveWarning'

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

export type CanvasColumnProps = {
  days: WorkbenchDay[]
  legs: WorkbenchLeg[]
  /** Ticket 10 day management — optional so the read-only usage keeps working. */
  onAddDay?: () => void
  onThemeSave?: (dayId: string, theme: string) => void
  onDeleteDay?: (day: WorkbenchDay) => void
  onOptimizeDay?: (day: WorkbenchDay) => void
  /** Card click → the map focuses the card's POI (ticket 05). */
  onCardClick?: (itemId: string) => void
  /** Highlighted card (marker click / detail card) + scroll into view. */
  highlightItemId?: string | null
  /** Ticket 09 card editing — optional; absent props keep the read-only canvas. */
  onMoveItem?: (itemId: string, toDayId: string, toIndex: number) => void
  onCopyItem?: (itemId: string, toDayId: string, toIndex?: number) => void
  onDeleteItem?: (itemId: string) => void
  onAddCard?: (dayId: string) => void
  onNoteSave?: (itemId: string, note: string) => void
  onImageAdd?: (itemId: string, url: string) => void
  /** Ticket 15: drop a pending recommendation into a day column. */
  onDropStash?: (stash: StashItem, dayId: string, index: number) => void
  /** A mutation or remote snapshot is rebuilding legs; keep the layout stable. */
  syncing?: boolean
}

export default function CanvasColumn({
  days,
  legs,
  onAddDay,
  onThemeSave,
  onDeleteDay,
  onOptimizeDay,
  onCardClick,
  highlightItemId,
  onMoveItem,
  onCopyItem,
  onDeleteItem,
  onAddCard,
  onNoteSave,
  onImageAdd,
  onDropStash,
  syncing = false,
}: CanvasColumnProps) {
  const legLookup = legsByPair(legs)
  const crossDayTransfersForCanvas = crossDayTransfers(days, legs)
  // Cross-column drag state: the id of the card currently being dragged.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // Open "⋯" menu (card id) and the cross-day picker (移动到 / 复制到).
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [picker, setPicker] = useState<{
    mode: 'move' | 'copy'
    itemId: string
    dayId: string
    index: number
  } | null>(null)

  // Marker click → scroll the highlighted card's day column into view.
  useEffect(() => {
    if (!highlightItemId) return
    const behavior: ScrollBehavior =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth'
    for (const day of days) {
      if (!day.items.some((item) => item.id === highlightItemId)) continue
      document
        .querySelector(`[data-canvas-day="${day.id}"]`)
        ?.scrollIntoView({ behavior, inline: 'center', block: 'nearest' })
      document
        .querySelector(`[data-canvas-card="${highlightItemId}"]`)
        ?.scrollIntoView({ behavior, inline: 'nearest', block: 'nearest' })
      return
    }
  }, [highlightItemId, days])

  const handleCardAction = (
    action: CardMenuAction,
    item: WorkbenchItem,
    day: WorkbenchDay,
    index: number,
  ) => {
    setMenuFor(null)
    switch (action) {
      case 'move-up':
        if (index > 0) onMoveItem?.(item.id, day.id, index - 1)
        return
      case 'move-down':
        if (index < day.items.length - 1) onMoveItem?.(item.id, day.id, index + 1)
        return
      case 'move-to':
      case 'copy-to':
        // Keep the card's relative position when the target day is longer.
        setPicker({
          mode: action === 'move-to' ? 'move' : 'copy',
          itemId: item.id,
          dayId: day.id,
          index,
        })
        return
      case 'delete':
        onDeleteItem?.(item.id)
        return
      case 'add-image':
      case 'edit-note':
        // Handled inside the card (inline inputs toggle locally).
        return
    }
  }

  const confirmPicker = (targetDayId: string) => {
    const current = picker
    setPicker(null)
    if (!current) return
    if (current.mode === 'move') {
      onMoveItem?.(current.itemId, targetDayId, current.index)
    } else {
      onCopyItem?.(current.itemId, targetDayId)
    }
  }

  return (
    <div
      id="workbench-canvas"
      className="relative h-full overflow-x-auto overflow-y-hidden bg-paper"
      aria-busy={syncing}
    >
      {syncing && (
        <div
          data-canvas-syncing
          className="pointer-events-none absolute right-[14px] top-[10px] z-[20] inline-flex items-center gap-[5px] rounded-[5px] border border-line bg-white/95 px-[8px] py-[4px] text-[11px] text-muted shadow-sm"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="workbench-spinner h-[11px] w-[11px] rounded-full border-2 border-line border-t-green"
          />
          路线重算中…
        </div>
      )}
      <div className="flex h-full items-stretch gap-[16px] px-[16px] py-[16px]">
        {days.length === 0 && (
          <p
            id="workbench-canvas-empty"
            className="self-center border border-dashed border-line rounded-[8px] px-[28px] py-[36px] text-[13px] text-muted"
          >
            这份行程还没有安排 —— 等圆周帮你规划，或稍后再来看看。
          </p>
        )}
        {days.map((day, index) => {
          const incoming = crossDayTransfersForCanvas.find(
            (candidate) =>
              candidate.toDayId === day.id && candidate.fromDayId === days[index - 1]?.id,
          )
          return (
            <Fragment key={day.id}>
              <DayColumn
                day={day}
                legLookup={legLookup}
                onThemeSave={onThemeSave}
                onDeleteDay={onDeleteDay}
                onOptimizeDay={onOptimizeDay}
                onCardClick={onCardClick}
                highlightItemId={highlightItemId}
                onMoveItem={onMoveItem}
                onDeleteItem={onDeleteItem}
                onAddCard={onAddCard}
                onNoteSave={onNoteSave}
                onImageAdd={onImageAdd}
                onDropStash={onDropStash}
                draggingId={draggingId}
                setDraggingId={setDraggingId}
                menuFor={menuFor}
                setMenuFor={setMenuFor}
                onCardAction={handleCardAction}
                incomingTransfer={incoming}
              />
            </Fragment>
          )
        })}
        {onAddDay && (
          <button
            type="button"
            data-action="add-day"
            onClick={onAddDay}
            className="flex h-[40px] shrink-0 items-center gap-[6px] self-start rounded-[6px] border border-dashed border-line bg-white px-[14px] text-[13px] text-muted hover:border-green hover:text-green transition-colors"
          >
            + 添加天
          </button>
        )}
      </div>
      {picker && (
        <DayPickerDialog
          mode={picker.mode}
          days={days}
          sourceDayId={picker.dayId}
          onConfirm={confirmPicker}
          onCancel={() => setPicker(null)}
        />
      )}
    </div>
  )
}

function DayColumn({
  day,
  legLookup,
  onThemeSave,
  onDeleteDay,
  onOptimizeDay,
  onCardClick,
  highlightItemId,
  onMoveItem,
  onDeleteItem,
  onAddCard,
  onNoteSave,
  onImageAdd,
  onDropStash,
  draggingId,
  setDraggingId,
  menuFor,
  setMenuFor,
  onCardAction,
  incomingTransfer,
}: {
  day: WorkbenchDay
  legLookup: Map<string, WorkbenchLeg>
  onThemeSave?: (dayId: string, theme: string) => void
  onDeleteDay?: (day: WorkbenchDay) => void
  onOptimizeDay?: (day: WorkbenchDay) => void
  onCardClick?: (itemId: string) => void
  highlightItemId?: string | null
  onMoveItem?: (itemId: string, toDayId: string, toIndex: number) => void
  onDeleteItem?: (itemId: string) => void
  onAddCard?: (dayId: string) => void
  onNoteSave?: (itemId: string, note: string) => void
  onImageAdd?: (itemId: string, url: string) => void
  onDropStash?: (stash: StashItem, dayId: string, index: number) => void
  draggingId: string | null
  setDraggingId: (itemId: string | null) => void
  menuFor: string | null
  setMenuFor: (itemId: string | null) => void
  onCardAction: (
    action: CardMenuAction,
    item: WorkbenchItem,
    day: WorkbenchDay,
    index: number,
  ) => void
  incomingTransfer?: ReturnType<typeof crossDayTransfers>[number]
}) {
  const accent = dayAccentColor(day.color, day.index)
  const dateLabel = dayDateLabel(day.date) || `D${day.index + 1}`

  const dropIndexOnCard = (draggedId: string, targetItem: WorkbenchItem): number => {
    const remaining = day.items.filter((item) => item.id !== draggedId)
    const targetPos = remaining.findIndex((item) => item.id === targetItem.id)
    return targetPos === -1 ? remaining.length : targetPos
  }

  const handleDrop = (event: React.DragEvent, targetItem: WorkbenchItem | null) => {
    event.preventDefault()
    // A drop on a card also bubbles to the day container's drop zone — stop
    // it so the move isn't applied twice (card insert + container append).
    event.stopPropagation()
    const stashPayload = event.dataTransfer.getData('application/x-stash')
    if (stashPayload && onDropStash) {
      try {
        const stash = JSON.parse(stashPayload) as StashItem
        if (
          typeof stash?.id === 'string' &&
          stash.id &&
          (stash.poi?.name || (stash.poi === null && stash.title?.trim()))
        ) {
          const index =
            targetItem === null
              ? day.items.length
              : day.items.findIndex((item) => item.id === targetItem.id)
          onDropStash(stash, day.id, index < 0 ? day.items.length : index)
          return
        }
      } catch {
        // Malformed recommendation payloads fall through to card handling.
      }
    }
    const draggedId = draggingId ?? event.dataTransfer.getData('text/plain')
    if (!draggedId || !onMoveItem) return
    const index =
      targetItem === null
        ? day.items.filter((item) => item.id !== draggedId).length
        : dropIndexOnCard(draggedId, targetItem)
    onMoveItem(draggedId, day.id, index)
    setDraggingId(null)
  }

  return (
    <section
      data-canvas-day={day.id}
      className="flex w-[292px] shrink-0 flex-col rounded-[8px] border border-line bg-white"
    >
      <header className="shrink-0 border-b border-line px-[14px] py-[12px]">
        <div className="flex items-center gap-[8px]">
          {/* Day badge: solid accent block with white text (PRD §4.2「天签按日着色」). */}
          <span
            data-day-badge
            data-day-id={day.id}
            className="inline-flex items-center gap-[6px] rounded-[5px] px-[8px] py-[3px] text-[12px] font-[600] leading-none text-white"
            style={{ backgroundColor: accent }}
          >
            {dateLabel}
            <span className="text-[11px] font-[500] opacity-90">{weekdayLabel(day.date)}</span>
          </span>
          <span className="ml-auto text-[11px] text-muted">D{day.index + 1}</span>
          {onOptimizeDay && (
            <button
              type="button"
              data-action="optimize-day"
              data-day-id={day.id}
              title={`优化 ${dateLabel}`}
              aria-label={`优化 ${dateLabel}`}
              onClick={() => onOptimizeDay(day)}
              className="grid h-[22px] w-[22px] place-items-center rounded-[4px] text-muted hover:text-green transition-colors"
            >
              <WandSparkles aria-hidden="true" className="w-[13px]" />
            </button>
          )}
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
        {onThemeSave ? (
          <EditableTheme dayId={day.id} theme={day.theme} onSave={onThemeSave} />
        ) : (
          day.theme && <p className="mt-[6px] text-[13px] font-[550] text-ink">{day.theme}</p>
        )}
      </header>
      <div
        data-day-items={day.id}
        className="flex flex-1 flex-col gap-[10px] overflow-y-auto p-[12px]"
        onDragOver={(event) => {
          if (draggingId || onDropStash) event.preventDefault()
        }}
        onDrop={(event) => handleDrop(event, null)}
      >
        {incomingTransfer && (
          <div data-cross-day-transfer={incomingTransfer.id} className="flex flex-col gap-[6px]">
            <CrossDayLeg transfer={incomingTransfer} />
            {incomingTransfer.longDrive && <CrossDayDriveWarning warning={incomingTransfer} />}
          </div>
        )}
        {day.items.map((item, i) => (
          <div key={item.id} className="flex flex-col gap-[10px]">
            {i > 0 && <LegChip leg={legLookup.get(`${day.items[i - 1]?.id}|${item.id}`) ?? null} />}
            <CanvasCard
              item={item}
              order={i + 1}
              accent={accent}
              onClick={onCardClick ? () => onCardClick(item.id) : undefined}
              highlighted={highlightItemId === item.id}
              draggable={Boolean(onMoveItem)}
              dragging={draggingId === item.id}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', item.id)
                event.dataTransfer.effectAllowed = 'move'
                setDraggingId(item.id)
              }}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(event) => {
                if (draggingId || onDropStash) event.preventDefault()
              }}
              onDrop={(event) => handleDrop(event, item)}
              menuEnabled={Boolean(onMoveItem || onDeleteItem)}
              menuOpen={menuFor === item.id}
              onMenuToggle={() => setMenuFor(menuFor === item.id ? null : item.id)}
              canMoveUp={i > 0}
              canMoveDown={i < day.items.length - 1}
              onCardAction={(action) => onCardAction(action, item, day, i)}
              onNoteSave={onNoteSave ? (note) => onNoteSave(item.id, note) : undefined}
              onImageAdd={onImageAdd ? (url) => onImageAdd(item.id, url) : undefined}
              showAddButton={Boolean(onAddCard) && highlightItemId === item.id}
              onToolbarAdd={onAddCard ? () => onAddCard(day.id) : undefined}
            />
          </div>
        ))}
        {onAddCard && (
          <button
            type="button"
            data-action="add-card"
            data-day-id={day.id}
            onClick={() => onAddCard(day.id)}
            className="flex h-[34px] shrink-0 items-center justify-center gap-[6px] rounded-[6px] border border-dashed border-line text-[12px] text-muted hover:border-green hover:text-green transition-colors"
          >
            <Plus aria-hidden="true" className="w-[13px]" />
            添加卡片
          </button>
        )}
      </div>
    </section>
  )
}

export function CanvasCard({
  item,
  order,
  accent,
  onClick,
  highlighted,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  menuEnabled,
  menuOpen,
  onMenuToggle,
  canMoveUp,
  canMoveDown,
  onCardAction,
  onNoteSave,
  onImageAdd,
  showAddButton,
  onToolbarAdd,
}: {
  item: WorkbenchItem
  order: number
  accent: string
  onClick?: () => void
  highlighted?: boolean
  // Ticket 09 interaction surface — everything optional, list view unaffected.
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (event: React.DragEvent) => void
  onDragEnd?: (event: React.DragEvent) => void
  onDragOver?: (event: React.DragEvent) => void
  onDrop?: (event: React.DragEvent) => void
  menuEnabled?: boolean
  menuOpen?: boolean
  onMenuToggle?: () => void
  canMoveUp?: boolean
  canMoveDown?: boolean
  onCardAction?: (action: CardMenuAction) => void
  onNoteSave?: (note: string) => void
  onImageAdd?: (url: string) => void
  showAddButton?: boolean
  onToolbarAdd?: () => void
}) {
  const visual = VISUAL_CLASSES[cardVisual(item.type)]
  const cover = item.images[0]?.url ?? null
  const isPlainText = item.poi === null && cover === null
  const [noteEditing, setNoteEditing] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  const [imageEditing, setImageEditing] = useState(false)
  const [imageUrl, setImageUrl] = useState('')

  const stopPropagation = (event: React.SyntheticEvent) => event.stopPropagation()

  const startNoteEdit = () => {
    setNoteDraft(item.note)
    setNoteEditing(true)
  }

  const commitNote = () => {
    setNoteEditing(false)
    const next = noteDraft.trim()
    if (onNoteSave && next !== item.note) onNoteSave(next)
  }

  const commitImage = () => {
    const url = imageUrl.trim()
    setImageEditing(false)
    setImageUrl('')
    if (onImageAdd && url) onImageAdd(url)
  }

  return (
    <article
      data-canvas-card={item.id}
      data-card-type={item.type}
      data-card-plain-text={isPlainText || undefined}
      data-card-highlight={highlighted || undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onClick()
        }
      }}
      tabIndex={onClick ? 0 : undefined}
      draggable={draggable || undefined}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={highlighted ? { boxShadow: `0 0 0 2px ${accent}` } : undefined}
      className={`relative overflow-hidden rounded-[6px] border border-line border-l-[3px] bg-white shadow-sm ${visual.bar} ${
        isPlainText ? 'border-dashed' : ''
      } ${onClick ? 'cursor-pointer' : ''} ${dragging ? 'opacity-50' : ''}`}
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
        <span className="ml-auto flex items-center gap-[6px]">
          {item.pending && (
            <span
              data-card-pending={item.id}
              className="rounded-[4px] border border-[#b75342] px-[6px] py-[1px] text-[10px] text-[#b75342]"
            >
              待定
            </span>
          )}
          {menuEnabled && (
            <button
              type="button"
              data-card-menu-button={item.id}
              title="卡片操作"
              aria-label={`卡片操作：${item.title}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen || undefined}
              onClick={(event) => {
                stopPropagation(event)
                onMenuToggle?.()
              }}
              className="grid h-[20px] w-[20px] place-items-center rounded-[4px] text-muted hover:bg-paper hover:text-ink transition-colors"
            >
              ⋯
            </button>
          )}
        </span>
      </div>
      {menuOpen && (
        // Stop card clicks (and drag starts) from fighting the open menu.
        <div onClick={stopPropagation} onDragStart={stopPropagation}>
          <CardMenu
            itemTitle={item.title}
            canMoveUp={canMoveUp !== false}
            canMoveDown={canMoveDown !== false}
            onAction={(action) => {
              if (action === 'edit-note') {
                startNoteEdit()
                onCardAction?.(action)
                return
              }
              if (action === 'add-image') {
                setImageEditing(true)
                onCardAction?.(action)
                return
              }
              onCardAction?.(action)
            }}
            onClose={onMenuToggle ?? (() => {})}
          />
        </div>
      )}
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
        {noteEditing ? (
          <span className="mt-[4px] flex items-center gap-[6px]" onClick={stopPropagation}>
            <input
              data-card-note-input
              type="text"
              value={noteDraft}
              autoFocus
              onChange={(event) => setNoteDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitNote()
                if (event.key === 'Escape') setNoteEditing(false)
              }}
              aria-label="编辑备注"
              placeholder="一句话备注"
              className="h-[26px] min-w-0 flex-1 rounded-[4px] border border-line px-[6px] text-[12px] outline-none focus:border-green"
            />
            <button
              type="button"
              data-action="save-note"
              onClick={commitNote}
              className="h-[26px] shrink-0 rounded-[4px] bg-green px-[8px] text-[11px] text-white"
            >
              保存
            </button>
          </span>
        ) : (
          onNoteSave && (
            <button
              type="button"
              data-card-note-edit
              onClick={(event) => {
                stopPropagation(event)
                startNoteEdit()
              }}
              className={`mt-[4px] block max-w-full truncate text-left text-[12px] leading-[1.6] transition-colors ${
                item.note ? 'text-muted hover:text-ink' : 'text-muted/60 hover:text-ink'
              }`}
              title={item.note ? '编辑备注' : '添加备注'}
            >
              {item.note || '＋ 备注'}
            </button>
          )
        )}
        {imageEditing && (
          <span className="mt-[6px] flex items-center gap-[6px]" onClick={stopPropagation}>
            <input
              data-card-image-input
              type="text"
              value={imageUrl}
              autoFocus
              onChange={(event) => setImageUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitImage()
                if (event.key === 'Escape') setImageEditing(false)
              }}
              aria-label="图片地址"
              placeholder="https://…"
              className="h-[26px] min-w-0 flex-1 rounded-[4px] border border-line px-[6px] text-[12px] outline-none focus:border-green"
            />
            <button
              type="button"
              data-action="confirm-image"
              onClick={commitImage}
              className="h-[26px] shrink-0 rounded-[4px] bg-green px-[8px] text-[11px] text-white"
            >
              添加
            </button>
          </span>
        )}
      </div>
      {showAddButton && onToolbarAdd && (
        <div
          data-card-toolbar
          className="flex items-center gap-[6px] border-t border-line bg-paper px-[10px] py-[6px]"
        >
          <button
            type="button"
            data-action="toolbar-add-card"
            onClick={(event) => {
              stopPropagation(event)
              onToolbarAdd()
            }}
            className="flex h-[24px] items-center gap-[4px] rounded-[4px] border border-line bg-white px-[8px] text-[11px] text-ink hover:border-green transition-colors"
          >
            <Plus aria-hidden="true" className="w-[11px]" />
            添加
          </button>
          <span className="text-[10px] text-muted">在此天新增卡片</span>
        </div>
      )}
    </article>
  )
}

function LegChip({ leg }: { leg: WorkbenchLeg | null }) {
  const label = formatLegLabel(leg)
  if (!leg) return null
  const pending = !label && leg.distanceKm <= 0 && leg.durationMin <= 0
  if (!label && !pending) return null
  const quality = legQuality(leg)
  const estimated = !pending && (quality === 'reference' || quality === 'estimate')
  const longDrive = !pending && isLongDriveLeg(leg)
  const displayLabel = pending ? '路线待查询' : formatLegDisplayLabel(leg)
  return (
    <div
      data-leg-chip={leg.id}
      data-leg-quality={pending ? 'pending' : quality}
      data-leg-warning={longDrive ? leg.id : undefined}
      aria-label={
        pending
          ? '路线待查询'
          : estimated
            ? `预估路线：${displayLabel}`
            : `驾车路线：${displayLabel}`
      }
      title={
        longDrive
          ? longDriveWarningText(leg)
          : pending
            ? '路线待查询'
            : estimated
              ? '直线估算，路线服务返回后会更新'
              : '高德驾车路线'
      }
      className={`flex items-center gap-[6px] rounded-[999px] border px-[10px] py-[3px] text-[11px] ${
        longDrive
          ? 'border-[#b75342]/50 bg-[#fff5f2] text-[#b75342]'
          : 'border-line bg-paper text-muted'
      }`}
    >
      <Car aria-hidden="true" className="w-[12px]" />
      {displayLabel}
      {longDrive && <span data-leg-warning-label>超长，建议拆分</span>}
    </div>
  )
}

export function CrossDayLeg({
  transfer,
}: {
  transfer: ReturnType<typeof crossDayTransfers>[number]
}) {
  const label = formatLegDisplayLabel(transfer.leg)
  const quality = legQuality(transfer.leg)
  const pending = quality === 'pending' || label === ''
  const displayLabel = pending ? '路线待查询' : label
  return (
    <div
      data-cross-day-leg={transfer.id}
      data-leg-quality={quality}
      aria-label={pending ? '跨天路线待查询' : `跨天路线：${displayLabel}`}
      title={
        pending
          ? '跨天起终点缺少可用坐标，路线待查询'
          : quality === 'measured'
            ? '高德驾车路线'
            : '跨天距离与时长为估算，路线服务返回后会更新'
      }
      className={`flex items-center gap-[6px] rounded-[999px] border px-[10px] py-[3px] text-[11px] ${
        transfer.longDrive
          ? 'border-[#b75342]/50 bg-[#fff5f2] text-[#b75342]'
          : 'border-line bg-paper text-muted'
      }`}
    >
      <Car aria-hidden="true" className="w-[12px]" />
      {displayLabel}
      <span className="text-[10px]">{transfer.estimated ? '估算' : '实测'}</span>
    </div>
  )
}
