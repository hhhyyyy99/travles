/**
 * 卡片操作菜单 (ticket 09) — the card "⋯" menu: 上移一位 / 下移一位 /
 * 移动到（跨天）/ 复制到（跨天）/ 添加图片 / 编辑备注 / 删除, plus the
 * cross-day picker dialog the 移动到 / 复制到 entries open. The menu is the
 * accessible fallback for the drag-to-reorder path (spec 用户故事 30).
 */
import { useEffect, useRef } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  ImagePlus,
  PencilLine,
  SquareArrowOutUpRight,
  Trash2,
} from 'lucide-react'
import { dayDateLabel, weekdayLabel, type WorkbenchDay } from '../../domain/workbench'

/** Menu actions; move-to / copy-to open the day picker in the canvas column. */
export type CardMenuAction = 'move-up' | 'move-down' | 'move-to' | 'copy-to' | 'add-image' | 'edit-note' | 'delete'

export function CardMenu({
  itemTitle,
  canMoveUp,
  canMoveDown,
  onAction,
  onClose,
}: {
  itemTitle: string
  canMoveUp: boolean
  canMoveDown: boolean
  onAction: (action: CardMenuAction) => void
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)

  // Click-outside + Escape close the menu (keyboard accessible fallback).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const items: Array<{ action: CardMenuAction; label: string; icon: React.ReactNode; disabled?: boolean; danger?: boolean }> = [
    { action: 'move-up', label: '上移一位', icon: <ArrowUp aria-hidden="true" className="w-[13px]" />, disabled: !canMoveUp },
    { action: 'move-down', label: '下移一位', icon: <ArrowDown aria-hidden="true" className="w-[13px]" />, disabled: !canMoveDown },
    { action: 'move-to', label: '移动到…', icon: <SquareArrowOutUpRight aria-hidden="true" className="w-[13px]" /> },
    { action: 'copy-to', label: '复制到…', icon: <Copy aria-hidden="true" className="w-[13px]" /> },
    { action: 'add-image', label: '添加图片', icon: <ImagePlus aria-hidden="true" className="w-[13px]" /> },
    { action: 'edit-note', label: '编辑备注', icon: <PencilLine aria-hidden="true" className="w-[13px]" /> },
    { action: 'delete', label: '删除', icon: <Trash2 aria-hidden="true" className="w-[13px]" />, danger: true },
  ]

  return (
    <div
      ref={rootRef}
      data-card-menu
      role="menu"
      aria-label={`卡片操作：${itemTitle}`}
      className="absolute right-[8px] top-[28px] z-30 w-[132px] rounded-[6px] border border-line bg-white py-[4px] shadow-lg"
    >
      {items.map((entry) => (
        <button
          key={entry.action}
          type="button"
          role="menuitem"
          data-menu-action={entry.action}
          disabled={entry.disabled === true}
          onClick={() => onAction(entry.action)}
          className={`flex w-full items-center gap-[8px] px-[10px] py-[6px] text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
            entry.danger ? 'text-[#b75342] hover:bg-[#fdf3f1]' : 'text-ink hover:bg-paper'
          }`}
        >
          {entry.icon}
          {entry.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 跨天选择弹窗 — pick the target day for 移动到 / 复制到. Confirms with the
 * chosen day's id; the caller decides the insertion index.
 */
export function DayPickerDialog({
  mode,
  days,
  sourceDayId,
  onConfirm,
  onCancel,
}: {
  mode: 'move' | 'copy'
  days: WorkbenchDay[]
  sourceDayId: string
  onConfirm: (dayId: string) => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div
        data-day-picker
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'move' ? '移动到哪一天' : '复制到哪一天'}
        className="w-[300px] rounded-[8px] border border-line bg-white p-[16px] shadow-lg"
      >
        <h2 className="text-[14px] font-[600] text-ink">{mode === 'move' ? '移动到…' : '复制到…'}</h2>
        <div className="mt-[10px] flex max-h-[260px] flex-col gap-[6px] overflow-y-auto">
          {days.map((day) => {
            const label = dayDateLabel(day.date) || `D${day.index + 1}`
            return (
              <button
                key={day.id}
                type="button"
                data-target-day={day.id}
                disabled={mode === 'move' && day.id === sourceDayId}
                onClick={() => onConfirm(day.id)}
                className="flex items-center justify-between rounded-[5px] border border-line px-[10px] py-[7px] text-left text-[12px] text-ink transition-colors hover:border-green disabled:cursor-not-allowed disabled:opacity-35"
              >
                <span>
                  {label} {weekdayLabel(day.date)}
                </span>
                <span className="text-muted">
                  {day.theme || `${day.items.length} 张卡片`}
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-[12px] flex justify-end">
          <button
            type="button"
            data-action="cancel-day-picker"
            onClick={onCancel}
            className="h-[28px] rounded-[5px] border border-line px-[12px] text-[12px] text-muted hover:border-green hover:text-green transition-colors"
          >
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
