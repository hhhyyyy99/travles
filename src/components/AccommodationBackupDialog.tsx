/**
 * 住宿备份 dialog (ticket 07 part B) — faithful React port of
 * accommodation-backup.js `buildUi`/`handleImport`/`confirmImport`/download
 * flow (note D §1.2, note B §2.1/§2.2).
 *
 * Owns the DOM/aria contract byte-identically: `#accommodation-backup-dialog`
 * with `#accommodation-backup-form`, `#accommodation-backup-export`（导出当前备份）,
 * the hidden `#accommodation-backup-file` inside the 选择备份文件 label,
 * `#accommodation-backup-preview`（文件格式 vN，包含 X 个自定义住宿基地和 Y 晚住宿安排。
 * + per-night list + 确认后将整体替换当前住宿安排，不会与现有数据自动合并。）,
 * `#accommodation-backup-status`（role=status aria-live=polite）, 取消 / 确认整体替换.
 *
 * Export serialises the LEGACY backup payload (`getBackup`) and downloads it
 * as `hailar-accommodation-v1-YYYYMMDD.json`（UTC date） via a Blob + anchor.
 * Import validates at runtime through the authoritative `validateBackup`
 * (versions/fields/coordinates/reference integrity — NOT TS types), shows the
 * preview and waits for the explicit 确认整体替换; 取消/Esc/close reset everything
 * and never touch the state. A failed confirm (validation or storage write)
 * keeps the current data intact with the exact legacy feedback strings.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Download, Upload, X } from 'lucide-react'
import { useAccommodation } from '../hooks/useAccommodation'
import { getBackup, listBases, validateBackup, type AccommodationValidationResult } from '../domain/accommodation'
import type { AccommodationBackup } from '../domain/types'

const TONE_ERROR = 'error'

/** `hailar-accommodation-v1-<YYYYMMDD>.json`（UTC date, no dashes — legacy L31–34）. */
export function backupFilename(date = new Date()): string {
  const yyyymmdd = date.toISOString().slice(0, 10).replaceAll('-', '')
  return `hailar-accommodation-v1-${yyyymmdd}.json`
}

interface BackupPreviewProps {
  value: AccommodationBackup
  currentBases: Array<{ id: string; name: string }>
}

/** Legacy renderPreview: current bases overlaid with the backup bases (note D §1.2). */
function BackupPreview({ value, currentBases }: BackupPreviewProps) {
  const bases = new Map(currentBases.map((base) => [base.id, base]))
  value.bases.forEach((base) => bases.set(base.id, base))
  const nights = Object.keys(value.stays)
    .map(Number)
    .sort((left, right) => left - right)
  return (
    <section id="accommodation-backup-preview" className="accommodation-backup-preview">
      <p>
        文件格式 v{value.version}，包含 <strong>{value.bases.length}</strong> 个自定义住宿基地和{' '}
        <strong>{nights.length}</strong> 晚住宿安排。
      </p>
      <ul>
        {nights.map((day) => {
          const stayId = value.stays[day] ?? ''
          const name = bases.get(stayId)?.name || stayId
          return (
            <li key={day}>
              <span>第 {day + 1} 晚</span>
              <strong>{name}</strong>
            </li>
          )
        })}
      </ul>
      <p className="accommodation-backup-warning">确认后将整体替换当前住宿安排，不会与现有数据自动合并。</p>
    </section>
  )
}

export function AccommodationBackupDialog({
  open,
  onRequestClose,
}: {
  open: boolean
  onRequestClose: () => void
}) {
  const { state, actions } = useAccommodation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [pending, setPending] = useState<AccommodationBackup | null>(null)
  const [status, setStatus] = useState('')
  const [tone, setTone] = useState<'normal' | typeof TONE_ERROR>('normal')
  const wasOpenRef = useRef(false)
  /** Import session token — closing/reopening the dialog discards a read in flight. */
  const importTokenRef = useRef(0)

  const setStatusTone = (message: string, nextTone: 'normal' | typeof TONE_ERROR = 'normal'): void => {
    setStatus(message)
    setTone(nextTone)
  }

  // Legacy open flow (accommodation-backup.js open button): greet before showing.
  useEffect(() => {
    if (open && !wasOpenRef.current) setStatusTone('可导出当前安排，或选择备份文件进行预览。')
    wasOpenRef.current = open
  }, [open])

  /** Legacy closeDialog: reset pending/preview/file/confirm, then close. */
  const resetDraft = (): void => {
    setPending(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
    setStatus('')
    setTone('normal')
  }

  const closeDialog = (): void => {
    importTokenRef.current++
    resetDraft()
    onRequestClose()
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal()
      } else {
        dialog.removeAttribute('hidden')
      }
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  const handleExport = (): void => {
    const blob = new Blob([JSON.stringify(getBackup(state), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = backupFilename()
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    setStatusTone('备份文件已导出。')
  }

  const handleImport = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) return
    const session = ++importTokenRef.current
    resetDraft()
    try {
      const validation: AccommodationValidationResult = validateBackup(await file.text())
      if (session !== importTokenRef.current) return // dialog closed while reading
      if (!validation.ok) {
        setStatusTone(`无法导入：${validation.error}`, TONE_ERROR)
        return
      }
      setPending(validation.value)
      setStatusTone('请检查预览，并确认是否替换当前安排。')
    } catch {
      if (session !== importTokenRef.current) return
      setStatusTone('无法读取备份文件，当前安排未改变。', TONE_ERROR)
    }
  }

  const handleConfirm = (): void => {
    if (!pending) return
    const result = actions.replaceState(pending)
    if (!result.ok) {
      setStatusTone(`恢复失败：${result.error || '当前安排未改变。'}`, TONE_ERROR)
      return
    }
    closeDialog()
    setStatusTone('住宿备份已恢复。')
  }

  return (
    <dialog
      ref={dialogRef}
      id="accommodation-backup-dialog"
      aria-labelledby="accommodation-backup-title"
      onCancel={(event) => {
        event.preventDefault()
        closeDialog()
      }}
    >
      <form
        id="accommodation-backup-form"
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        <div className="dialog-heading">
          <h2 id="accommodation-backup-title">住宿备份</h2>
          <button type="button" id="accommodation-backup-close" title="关闭" aria-label="关闭" onClick={closeDialog}>
            <X aria-hidden="true" />
          </button>
        </div>
        <p className="accommodation-backup-intro">备份仅包含自定义住宿基地和每晚住宿选择，不包含地图 Key 或其他应用设置。</p>
        <div className="accommodation-backup-actions">
          <button type="button" id="accommodation-backup-export" onClick={handleExport}>
            <Download aria-hidden="true" />
            导出当前备份
          </button>
          <label className="accommodation-backup-import">
            <Upload aria-hidden="true" />
            选择备份文件
            <input
              ref={fileInputRef}
              id="accommodation-backup-file"
              type="file"
              accept="application/json,.json"
              onChange={handleImport}
            />
          </label>
        </div>
        {pending ? <BackupPreview value={pending} currentBases={listBases(state)} /> : null}
        <p id="accommodation-backup-status" role="status" aria-live="polite" data-tone={tone}>
          {status}
        </p>
        <div className="dialog-actions accommodation-backup-confirm-actions">
          <button type="button" id="accommodation-backup-cancel" onClick={closeDialog}>
            取消
          </button>
          <button type="button" id="accommodation-backup-confirm" disabled={!pending} onClick={handleConfirm}>
            确认整体替换
          </button>
        </div>
      </form>
    </dialog>
  )
}