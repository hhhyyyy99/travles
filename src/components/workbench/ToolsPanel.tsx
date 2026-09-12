/**
 * 工具面板 (ticket 14) — the dockable panel body opened from the tools rail.
 * Docks to the left of the canvas (squeezing it, PRD F11 停靠面板) and hosts:
 * - 便签 notes: multiple free-text notes (add / edit-on-blur / delete)
 * - 清单 checklist: todo checkboxes (add / toggle / delete), server-persisted,
 *   including the ticket-03 migrated `legacy-checklist-*` rows
 * - 图库 gallery: card images aggregated from the canvas + manual uploads
 *   (files are read as data URLs, ≤5MB / image types, stored server-side)
 *
 * All data comes from the tools API; failures surface in a status line and
 * never break the panel.
 */
import { useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Upload } from 'lucide-react'
import {
  addGalleryImage,
  checklistProgressLabel,
  collectCardImages,
  createChecklistEntry,
  createNote,
  deleteChecklistEntry,
  deleteGalleryImage,
  deleteNote,
  fetchChecklist,
  fetchGallery,
  fetchNotes,
  fileToDataUrl,
  toggleChecklistEntry,
  updateNote,
  validateUploadFile,
  type ChecklistItem,
  type GalleryUpload,
  type NoteItem,
} from '../../domain/tools'
import type { ToolPanelId } from '../../domain/workbenchTools'
import type { WorkbenchDay } from '../../domain/workbench'
import { subscribeTripEvents } from '../../domain/tripEvents'

const PANEL_TITLES: Record<ToolPanelId, string> = { notes: '便签', checklist: '清单', gallery: '图库' }
const PANEL_EVENT_REASONS: Record<ToolPanelId, ReadonlySet<string>> = {
  notes: new Set(['note_created', 'note_updated', 'note_deleted']),
  checklist: new Set(['checklist_created', 'checklist_updated', 'checklist_deleted']),
  gallery: new Set(['gallery_added', 'gallery_deleted']),
}

function isPanelUpdate(panel: ToolPanelId, event: { kind: string; reason: string }): boolean {
  return event.kind === 'canvas' && PANEL_EVENT_REASONS[panel].has(event.reason)
}

function mergeById<T extends { id: string }>(items: T[], next: T): T[] {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [...items, next]
  return items.map((item, itemIndex) => (itemIndex === index ? next : item))
}

export default function ToolsPanel({
  tripId,
  panel,
  days,
  onClose,
}: {
  tripId: string
  panel: ToolPanelId
  days: WorkbenchDay[]
  onClose: () => void
}) {
  return (
    <aside
      id="tools-panel"
      data-tools-panel={panel}
      className="flex w-[300px] shrink-0 flex-col border-r border-line bg-white"
    >
      <header className="flex shrink-0 items-center border-b border-line px-[12px] py-[8px] text-[13px] font-[550]">
        {PANEL_TITLES[panel]}
        <button
          type="button"
          data-action="close-tools"
          title="收起工具面板"
          aria-label="收起工具面板"
          onClick={onClose}
          className="ml-auto grid h-[26px] w-[26px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
        >
          ✕
        </button>
      </header>
      {panel === 'notes' && <NotesPanel tripId={tripId} />}
      {panel === 'checklist' && <ChecklistPanel tripId={tripId} />}
      {panel === 'gallery' && <GalleryPanel tripId={tripId} days={days} />}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// 便签
// ---------------------------------------------------------------------------

function NotesPanel({ tripId }: { tripId: string }) {
  const [notes, setNotes] = useState<NoteItem[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const dirtyNoteIds = useRef(new Set<string>())
  const [status, setStatus] = useState<{ kind: 'loading' | 'error' | 'ready'; message?: string }>({
    kind: 'loading',
  })

  useEffect(() => {
    let active = true
    let requestId = 0
    const reload = (): void => {
      const currentRequestId = ++requestId
      void fetchNotes(tripId).then((result) => {
        if (!active || currentRequestId !== requestId) return
        if (result.ok) {
          setNotes(result.data)
          // Keep only drafts the traveler is actively editing. Clean editors
          // derive their value from the refreshed server snapshot below.
          setDrafts((current) => {
            const next = { ...current }
            for (const id of Object.keys(next)) {
              if (!dirtyNoteIds.current.has(id)) delete next[id]
            }
            return next
          })
          setStatus({ kind: 'ready' })
        } else {
          setStatus({ kind: 'error', message: result.error })
        }
      })
    }

    reload()
    const unsubscribe = subscribeTripEvents(tripId, {
      onUpdate: (event) => {
        if (isPanelUpdate('notes', event)) reload()
      },
    })
    return () => {
      active = false
      requestId += 1
      unsubscribe()
    }
  }, [tripId])

  const addNote = async () => {
    const result = await createNote(tripId)
    if (result.ok) setNotes((prev) => mergeById(prev, result.data))
    else setStatus({ kind: 'error', message: result.error })
  }

  const saveNote = async (note: NoteItem, content: string) => {
    if (content === note.content) {
      dirtyNoteIds.current.delete(note.id)
      setDrafts((current) => {
        if (!(note.id in current)) return current
        const next = { ...current }
        delete next[note.id]
        return next
      })
      return
    }
    const result = await updateNote(tripId, note.id, content)
    if (result.ok) {
      dirtyNoteIds.current.delete(note.id)
      setDrafts((current) => {
        if (!(note.id in current)) return current
        const next = { ...current }
        delete next[note.id]
        return next
      })
      setNotes((prev) => mergeById(prev, result.data))
    } else {
      setStatus({ kind: 'error', message: result.error })
    }
  }

  const removeNote = async (noteId: string) => {
    const result = await deleteNote(tripId, noteId)
    if (result.ok) setNotes((prev) => prev.filter((note) => note.id !== noteId))
    else setStatus({ kind: 'error', message: result.error })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center px-[12px] pt-[10px]">
        <button
          type="button"
          data-action="add-note"
          onClick={() => void addNote()}
          className="flex items-center gap-[4px] rounded-[5px] border border-line px-[8px] py-[4px] text-[12px] text-muted hover:border-green hover:text-green transition-colors"
        >
          <Plus aria-hidden="true" className="w-[12px]" />
          新建便签
        </button>
      </div>
      <StatusLine status={status} />
      <div className="flex min-h-0 flex-1 flex-col gap-[10px] overflow-y-auto p-[12px]">
        {notes.map((note) => (
          <div
            key={note.id}
            data-note-id={note.id}
            className="rounded-[6px] border border-line bg-[#fdf6e3] p-[8px]"
          >
            <textarea
              data-note-editor
              value={drafts[note.id] ?? note.content}
              placeholder="写点什么…"
              rows={3}
              onChange={(event) => {
                dirtyNoteIds.current.add(note.id)
                setDrafts((current) => ({ ...current, [note.id]: event.target.value }))
              }}
              onBlur={(event) => void saveNote(note, event.target.value)}
              className="w-full resize-y bg-transparent text-[12px] leading-[1.6] text-ink outline-none"
            />
            <div className="flex items-center">
              <span className="text-[10px] text-muted">失焦自动保存</span>
              <button
                type="button"
                data-action="delete-note"
                title="删除便签"
                aria-label="删除便签"
                onClick={() => void removeNote(note.id)}
                className="ml-auto grid h-[24px] w-[24px] place-items-center rounded-[5px] text-muted hover:text-red transition-colors"
              >
                <Trash2 aria-hidden="true" className="w-[13px]" />
              </button>
            </div>
          </div>
        ))}
        {status.kind === 'ready' && notes.length === 0 && (
          <p className="rounded-[6px] border border-dashed border-line px-[12px] py-[16px] text-[12px] text-muted">
            还没有便签 —— 记下门票号、车牌、叮嘱吧。
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

function ChecklistPanel({ tripId }: { tripId: string }) {
  const [items, setItems] = useState<ChecklistItem[]>([])
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<{ kind: 'loading' | 'error' | 'ready'; message?: string }>({
    kind: 'loading',
  })

  useEffect(() => {
    let active = true
    let requestId = 0
    const reload = (): void => {
      const currentRequestId = ++requestId
      void fetchChecklist(tripId).then((result) => {
        if (!active || currentRequestId !== requestId) return
        if (result.ok) {
          setItems(result.data)
          setStatus({ kind: 'ready' })
        } else {
          setStatus({ kind: 'error', message: result.error })
        }
      })
    }

    reload()
    const unsubscribe = subscribeTripEvents(tripId, {
      onUpdate: (event) => {
        if (isPanelUpdate('checklist', event)) reload()
      },
    })
    return () => {
      active = false
      requestId += 1
      unsubscribe()
    }
  }, [tripId])

  const addEntry = async () => {
    const content = draft.trim()
    if (!content) return
    const result = await createChecklistEntry(tripId, content)
    if (result.ok) {
      setItems((prev) => mergeById(prev, result.data))
      setDraft('')
    } else {
      setStatus({ kind: 'error', message: result.error })
    }
  }

  const toggleEntry = async (item: ChecklistItem) => {
    // Optimistic flip; the server response (or rollback on failure) wins.
    setItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, done: !entry.done } : entry)))
    const result = await toggleChecklistEntry(tripId, item.id, !item.done)
    if (result.ok) {
      setItems((prev) => mergeById(prev, result.data))
    } else {
      // If a remote refresh already supplied a newer value, preserve it. The
      // rollback only applies while the optimistic value is still present.
      setItems((prev) => prev.map((entry) => (entry.id === item.id && entry.done === !item.done ? item : entry)))
      setStatus({ kind: 'error', message: result.error })
    }
  }

  const removeEntry = async (entryId: string) => {
    const result = await deleteChecklistEntry(tripId, entryId)
    if (result.ok) setItems((prev) => prev.filter((entry) => entry.id !== entryId))
    else setStatus({ kind: 'error', message: result.error })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-[6px] px-[12px] pt-[10px]">
        <input
          type="text"
          id="tools-checklist-input"
          value={draft}
          placeholder="添加待办，如：提前 2 天预约莫尔格勒河"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void addEntry()
          }}
          className="min-w-0 flex-1 rounded-[5px] border border-line px-[8px] py-[4px] text-[12px] outline-none focus:border-green"
        />
        <button
          type="button"
          data-action="add-checklist"
          title="添加清单项"
          aria-label="添加清单项"
          onClick={() => void addEntry()}
          className="grid h-[26px] w-[26px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
        >
          <Plus aria-hidden="true" className="w-[13px]" />
        </button>
      </div>
      <StatusLine status={status} />
      <p className="shrink-0 px-[12px] pt-[8px] text-[11px] text-muted" data-checklist-progress>
        {checklistProgressLabel(items)}
      </p>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-[12px]">
        {items.map((item) => (
          <label
            key={item.id}
            data-checklist-id={item.id}
            data-checklist-done={item.done || undefined}
            className="flex items-start gap-[8px] rounded-[6px] px-[4px] py-[6px] hover:bg-paper"
          >
            <input
              type="checkbox"
              data-action="toggle-checklist"
              checked={item.done}
              onChange={() => void toggleEntry(item)}
              className="mt-[2px] h-[14px] w-[14px] accent-[#3f7d5c]"
            />
            <span className={`min-w-0 flex-1 text-[12px] leading-[1.6] ${item.done ? 'text-muted line-through' : 'text-ink'}`}>
              {item.content}
            </span>
            <button
              type="button"
              data-action="delete-checklist"
              title="删除清单项"
              aria-label="删除清单项"
              onClick={(event) => {
                event.preventDefault()
                void removeEntry(item.id)
              }}
              className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-[5px] text-muted hover:text-red transition-colors"
            >
              <Trash2 aria-hidden="true" className="w-[12px]" />
            </button>
          </label>
        ))}
        {status.kind === 'ready' && items.length === 0 && (
          <p className="rounded-[6px] border border-dashed border-line px-[12px] py-[16px] text-[12px] text-muted">
            清单还是空的 —— 证件、预约、装备都可以记在这里。
          </p>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 图库
// ---------------------------------------------------------------------------

function GalleryPanel({ tripId, days }: { tripId: string; days: WorkbenchDay[] }) {
  const [uploads, setUploads] = useState<GalleryUpload[]>([])
  const [status, setStatus] = useState<{ kind: 'loading' | 'error' | 'ready'; message?: string }>({
    kind: 'loading',
  })
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let active = true
    let requestId = 0
    const reload = (): void => {
      const currentRequestId = ++requestId
      void fetchGallery(tripId).then((result) => {
        if (!active || currentRequestId !== requestId) return
        if (result.ok) {
          setUploads(result.data)
          setStatus({ kind: 'ready' })
        } else {
          setStatus({ kind: 'error', message: result.error })
        }
      })
    }

    reload()
    const unsubscribe = subscribeTripEvents(tripId, {
      onUpdate: (event) => {
        if (isPanelUpdate('gallery', event)) reload()
      },
    })
    return () => {
      active = false
      requestId += 1
      unsubscribe()
    }
  }, [tripId])

  const cardImages = collectCardImages(days)

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      const invalid = validateUploadFile(file)
      if (invalid) {
        setStatus({ kind: 'error', message: invalid })
        continue
      }
      try {
        const dataUrl = await fileToDataUrl(file)
        const result = await addGalleryImage(tripId, dataUrl, file.name)
        if (result.ok) setUploads((prev) => mergeById(prev, result.data))
        else setStatus({ kind: 'error', message: result.error })
      } catch {
        setStatus({ kind: 'error', message: '读取图片失败' })
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeUpload = async (imageId: string) => {
    const result = await deleteGalleryImage(tripId, imageId)
    if (result.ok) setUploads((prev) => prev.filter((image) => image.id !== imageId))
    else setStatus({ kind: 'error', message: result.error })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="shrink-0 px-[12px] pt-[10px]">
        <input
          ref={fileInputRef}
          id="tools-gallery-upload"
          type="file"
          accept="image/*"
          multiple
          onChange={(event) => void uploadFiles(event.target.files)}
          className="hidden"
        />
        <button
          type="button"
          data-action="upload-gallery"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-[4px] rounded-[5px] border border-line px-[8px] py-[4px] text-[12px] text-muted hover:border-green hover:text-green transition-colors"
        >
          <Upload aria-hidden="true" className="w-[12px]" />
          上传图片
        </button>
      </div>
      <StatusLine status={status} />
      <GallerySection title="上传的图片" emptyText="还没有手动上传的图片。">
        {uploads.map((image) => (
          <figure key={image.id} data-gallery-upload-id={image.id} className="relative">
            <img src={image.url} alt={image.caption} data-gallery-image={image.id} className="h-[80px] w-full rounded-[6px] border border-line object-cover" />
            {image.caption && <figcaption className="mt-[2px] truncate text-[10px] text-muted">{image.caption}</figcaption>}
            <button
              type="button"
              data-action="delete-gallery"
              title="删除图片"
              aria-label="删除图片"
              onClick={() => void removeUpload(image.id)}
              className="absolute right-[4px] top-[4px] grid h-[20px] w-[20px] place-items-center rounded-[4px] bg-white/85 text-muted hover:text-red transition-colors"
            >
              <Trash2 aria-hidden="true" className="w-[11px]" />
            </button>
          </figure>
        ))}
      </GallerySection>
      <GallerySection
        title="卡片图片"
        emptyText={days.length === 0 ? '画布上还没有带图片的卡片。' : '行程卡片还没有图片。'}
      >
        {cardImages.map((image) => (
          <figure key={image.id}>
            <img
              src={image.url}
              alt={image.caption}
              data-gallery-card-image={image.itemId}
              className="h-[80px] w-full rounded-[6px] border border-line object-cover"
            />
            {image.caption && <figcaption className="mt-[2px] truncate text-[10px] text-muted">{image.caption}</figcaption>}
          </figure>
        ))}
      </GallerySection>
    </div>
  )
}

function GallerySection({ title, emptyText, children }: { title: string; emptyText: string; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : children !== null && children !== undefined
  return (
    <section data-gallery-section className="px-[12px] pb-[12px] pt-[10px]">
      <h3 className="mb-[8px] text-[11px] text-muted">{title}</h3>
      {hasChildren ? (
        <div className="grid grid-cols-2 gap-[8px]">{children}</div>
      ) : (
        <p className="rounded-[6px] border border-dashed border-line px-[10px] py-[12px] text-[11px] text-muted">{emptyText}</p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function StatusLine({
  status,
}: {
  status: { kind: 'loading' | 'error' | 'ready'; message?: string }
}) {
  if (status.kind === 'ready') return null
  return (
    <p
      data-tools-status={status.kind}
      className={`shrink-0 px-[12px] pt-[8px] text-[11px] ${status.kind === 'error' ? 'text-red' : 'text-muted'}`}
    >
      {status.kind === 'loading' ? '加载中…' : status.message}
    </p>
  )
}
