/**
 * EditableTheme (ticket 10) — the inline day-theme editor shared by the
 * canvas day header and the list-view day header. Renders the theme text
 * with a pencil entry point; editing swaps in an input (Enter saves,
 * Escape cancels).
 */
import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

export default function EditableTheme({
  dayId,
  theme,
  onSave,
}: {
  dayId: string
  theme: string
  onSave: (dayId: string, theme: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(theme)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(theme)
      // Focus after the input mounts so the click-through doesn't lose it.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [editing, theme])

  if (!editing) {
    return (
      <span className="mt-[6px] flex min-h-[20px] items-center gap-[4px] text-[13px] font-[550] text-ink">
        {theme ? <span className="truncate">{theme}</span> : <span className="text-muted font-[400]">暂无主题</span>}
        <button
          type="button"
          data-action="edit-theme"
          data-day-id={dayId}
          title="编辑天主题"
          aria-label="编辑天主题"
          onClick={() => setEditing(true)}
          className="grid h-[20px] w-[20px] shrink-0 place-items-center rounded-[4px] text-muted hover:border-green hover:text-green transition-colors"
        >
          <Pencil aria-hidden="true" className="w-[12px]" />
        </button>
      </span>
    )
  }

  const save = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== theme) onSave(dayId, next)
  }
  const cancel = () => setEditing(false)

  return (
    <span className="mt-[6px] flex items-center gap-[6px]">
      <input
        ref={inputRef}
        data-input="theme-edit"
        data-day-id={dayId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save()
          if (event.key === 'Escape') cancel()
        }}
        placeholder="这一天的主题"
        aria-label="编辑天主题"
        className="h-[26px] w-[150px] rounded-[5px] border border-line px-[8px] text-[13px] text-ink outline-none focus:border-green"
      />
      <button
        type="button"
        data-action="save-theme"
        data-day-id={dayId}
        onClick={save}
        className="h-[26px] rounded-[5px] bg-green px-[10px] text-[12px] text-white"
      >
        保存
      </button>
      <button
        type="button"
        data-action="cancel-theme"
        onClick={cancel}
        className="h-[26px] rounded-[5px] border border-line px-[10px] text-[12px] text-muted"
      >
        取消
      </button>
    </span>
  )
}
