/**
 * 住宿基地 manager dialog (ticket 06) — faithful React port of
 * accommodation-manager.js: 正在使用 / 备选基地 / 默认住宿 partitions, per-base
 * edit (same fields as create, shared bases propagate to every referencing
 * night through the domain `updateBase`), delete with the legacy in-use block,
 * single-night 恢复默认住宿, and the exact legacy status strings.
 *
 * DOM/aria contract mirrors the legacy manager byte-identically:
 * `#accommodation-manager-dialog` with the sections
 * `#accommodation-manager-used-list` / `-backup-list` / `-default-list` /
 * `-night-list`, cards `data-manager-base="{id}"` (badge 正在使用/备选/
 * 默认住宿, meta `type · address`, 代表位置 lat, lng, notes, 关联晚次 with
 * `data-manager-restore="{index}"` buttons per night), actions
 * `data-manager-edit` / `data-manager-delete` / `data-manager-replace`, the
 * inline editor `#accommodation-manager-editor` (labels 编辑基地名称 / 编辑类型 /
 * 编辑详细地址（选填） / 编辑备注（选填） / 编辑纬度 / 编辑经度, 保存修改 + 取消), and
 * `#accommodation-manager-status` (data-state error|ok).
 *
 * Controlled from the accommodation dialog: the parent closes `#accommodation-dialog`
 * before opening this one, and `onReplace(night)` hands back to it (legacy
 * manager 更换住宿 flow). Route re-query needs no extra wiring here — the
 * ticket-04 change listeners consume the provider events that every action
 * already emits (update with lat/lng change carries {N,N+1} routeDays).
 */
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { useAccommodation } from '../hooks/useAccommodation'
import {
  defaultBases,
  getBase,
  getDayStay,
  listBases,
  overnightDays,
  usedDaysForBase,
} from '../domain/accommodation'
import type { AccommodationBaseType } from '../domain/types'
import { ACCOMMODATION_WRITE_FAILURE_STATUS } from '../domain/storage'
import { tripPlan } from '../data/itinerary'

const kindLabel = (type: AccommodationBaseType): string => (type === 'area' ? '住宿区域' : '酒店 / 民宿')

const dayLabel = (dayIndex: number): string => {
  const day = tripPlan.days[dayIndex]
  return `第 ${dayIndex + 1} 晚 · ${day ? `${day.date} ${day.weekday}` : ''}`
}

interface EditDraft {
  name: string
  type: 'hotel' | 'area'
  address: string
  notes: string
  lat: string
  lng: string
}

export interface AccommodationManagerProps {
  /** Controlled open state — the parent closes the accommodation dialog first. */
  open: boolean
  onClose(): void
  /** Legacy 更换住宿: close the manager and open the accommodation dialog for the night. */
  onReplace(night: number): void
}

export function AccommodationManager({ open, onClose, onReplace }: AccommodationManagerProps) {
  const { state, actions } = useAccommodation()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft>({ name: '', type: 'hotel', address: '', notes: '', lat: '', lng: '' })
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)

  const usedNights = (baseId: string): number[] => usedDaysForBase(state, baseId)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      setEditingId(null)
      setStatus('修改会同步到所有关联晚次。')
      setStatusError(false)
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal()
      } else {
        dialog.removeAttribute('hidden')
      }
      document.getElementById('accommodation-manager-close')?.focus()
    } else if (dialog.open) {
      dialog.close()
    }
  }, [open])

  // Editor focus moves to the name field (legacy showEditor focuses it).
  useEffect(() => {
    if (editingId) document.getElementById('accommodation-manager-edit-name')?.focus()
  }, [editingId])

  const setDraftField = (field: keyof EditDraft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setDraft((current) => ({ ...current, [field]: event.target.value }))
  }

  const showEditor = (id: string): void => {
    const base = getBase(state, id)
    if (!base) return
    if (base.isDefault) {
      setStatus('默认住宿不可编辑。')
      setStatusError(true)
      return
    }
    setEditingId(id)
    setDraft({ name: base.name, type: base.type, address: base.address || '', notes: base.notes || '', lat: String(base.lat), lng: String(base.lng) })
    setStatus(`正在编辑“${base.name}”。`)
    setStatusError(false)
  }

  const hideEditor = (): void => setEditingId(null)

  const saveEditor = (event: FormEvent): void => {
    event.preventDefault()
    if (!editingId) return
    const result = actions.updateBase(editingId, draft)
    if (!result.ok) {
      setStatus(result.error === '保存失败' ? ACCOMMODATION_WRITE_FAILURE_STATUS : result.error)
      setStatusError(true)
      return
    }
    hideEditor()
    setStatus('住宿基地已更新。')
    setStatusError(false)
  }

  const remove = (id: string): void => {
    const base = getBase(state, id)
    if (!base) return
    const result = actions.deleteBase(id)
    if (!result.ok) {
      setStatus(result.error === '保存失败' ? ACCOMMODATION_WRITE_FAILURE_STATUS : result.error)
      setStatusError(true)
      return
    }
    setStatus(`住宿基地“${base.name}”已删除。`)
    setStatusError(false)
  }

  const restore = (index: number): void => {
    const result = actions.restoreDay(index)
    if (!result.ok) {
      setStatus(result.error === '保存失败' ? ACCOMMODATION_WRITE_FAILURE_STATUS : result.error)
      setStatusError(true)
      return
    }
    const label = dayLabel(index)
    setStatus(result.changed?.length ? `${label}已恢复默认住宿。` : `${label}已经是默认住宿。`)
    setStatusError(false)
  }

  const nightActions = (nights: number[]): React.ReactNode[] =>
    nights.map((index) => (
      <li key={index}>
        <span>{dayLabel(index)}</span>
        <button type="button" data-manager-restore={index} onClick={() => restore(index)}>
          恢复默认住宿
        </button>
      </li>
    ))

  const baseMeta = (base: { type: AccommodationBaseType; address?: string }): string => {
    const parts = [kindLabel(base.type)]
    if (base.address) parts.push(base.address)
    return parts.join(' · ')
  }

  const baseCard = (
    base: { id: string; isDefault: boolean; name: string; type: AccommodationBaseType; address?: string; lat: number; lng: number; notes?: string },
    nights: number[],
    actionsNode: React.ReactNode,
  ): React.ReactNode => (
    <article key={base.id} className="accommodation-manager-card" data-manager-base={base.id}>
      <div className="accommodation-manager-card-main">
        <div className="accommodation-manager-card-heading">
          <h4>{base.name}</h4>
          <span>{base.isDefault ? '默认住宿' : nights.length ? '正在使用' : '备选'}</span>
        </div>
        <p className="accommodation-manager-meta">{baseMeta(base)}</p>
        <p className="accommodation-manager-coordinates">
          代表位置 {Number(base.lat).toFixed(5)}, {Number(base.lng).toFixed(5)}
        </p>
        {base.notes ? <p className="accommodation-manager-notes">{base.notes}</p> : null}
        {nights.length ? (
          <div className="accommodation-manager-nights">
            <span>关联晚次</span>
            <ul>{nightActions(nights)}</ul>
          </div>
        ) : (
          <p className="accommodation-manager-unused">尚未安排到任何晚次</p>
        )}
      </div>
      {actionsNode ? <div className="accommodation-manager-actions">{actionsNode}</div> : null}
    </article>
  )

  const bases = listBases(state)
  const customs = bases.filter((base) => !base.isDefault)
  const used = customs.filter((base) => usedNights(base.id).length)
  const backups = customs.filter((base) => !usedNights(base.id).length)
  const defaults = defaultBases.filter((base) => bases.some((item) => item.id === base.id))

  return (
    <dialog
      ref={dialogRef}
      id="accommodation-manager-dialog"
      aria-labelledby="accommodation-manager-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="accommodation-manager-heading">
        <div>
          <p className="eyebrow">ACCOMMODATION BASES</p>
          <h2 id="accommodation-manager-title">住宿基地</h2>
        </div>
        <button type="button" id="accommodation-manager-close" title="关闭" aria-label="关闭" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      <p className="accommodation-manager-intro">管理正在使用的基地和备选基地。默认住宿始终保留，数据只保存在当前浏览器。</p>

      <section className="accommodation-manager-section">
        <div className="accommodation-manager-section-heading">
          <h3>正在使用</h3>
          <span>自定义基地</span>
        </div>
        <div id="accommodation-manager-used-list">
          {used.length ? (
            used.map((base) => {
              const nights = usedNights(base.id)
              const firstNight = nights[0]!
              return baseCard(base, nights, (
                <>
                  <button type="button" data-manager-edit={base.id} onClick={() => showEditor(base.id)}>
                    编辑
                  </button>
                  <button type="button" data-manager-delete={base.id} onClick={() => {
                    if (window.confirm(`删除住宿基地“${base.name}”？`)) remove(base.id)
                  }}>
                    删除
                  </button>
                  <button type="button" data-manager-replace={firstNight} onClick={() => onReplace(firstNight)}>
                    更换住宿
                  </button>
                </>
              ))
            })
          ) : (
            <p className="accommodation-manager-empty">还没有正在使用的自定义基地。</p>
          )}
        </div>
      </section>

      <section className="accommodation-manager-section">
        <div className="accommodation-manager-section-heading">
          <h3>备选基地</h3>
          <span>尚未用于任何晚次</span>
        </div>
        <div id="accommodation-manager-backup-list">
          {backups.length ? (
            backups.map((base) =>
              baseCard(base, [], (
                <>
                  <button type="button" data-manager-edit={base.id} onClick={() => showEditor(base.id)}>
                    编辑
                  </button>
                  <button type="button" data-manager-delete={base.id} onClick={() => {
                    if (window.confirm(`删除住宿基地“${base.name}”？`)) remove(base.id)
                  }}>
                    删除
                  </button>
                </>
              )),
            )
          ) : (
            <p className="accommodation-manager-empty">暂无备选基地。</p>
          )}
        </div>
      </section>

      <section className="accommodation-manager-section">
        <div className="accommodation-manager-section-heading">
          <h3>默认住宿</h3>
          <span>不可编辑或删除</span>
        </div>
        <div id="accommodation-manager-default-list">
          {defaults.map((base) => baseCard(base, usedNights(base.id), <span className="accommodation-manager-immutable">默认住宿不可编辑或删除</span>))}
        </div>
      </section>

      <section className="accommodation-manager-section">
        <div className="accommodation-manager-section-heading">
          <h3>每晚住宿</h3>
          <span>可恢复原有安排</span>
        </div>
        <ul id="accommodation-manager-night-list" className="accommodation-manager-night-list">
          {overnightDays.map((index) => {
            const stay = getDayStay(state, index)
            return (
              <li key={index}>
                <div>
                  <strong>{dayLabel(index)}</strong>
                  <span>{stay?.name || '未安排'}</span>
                </div>
                <button type="button" data-manager-restore={index} onClick={() => restore(index)}>
                  恢复默认住宿
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="accommodation-manager-editor" hidden={!editingId}>
        <div className="accommodation-manager-section-heading">
          <h3>编辑住宿基地</h3>
          <button type="button" id="accommodation-manager-cancel-edit" onClick={hideEditor}>
            取消
          </button>
        </div>
        <form id="accommodation-manager-edit-form" onSubmit={saveEditor}>
          <label>
            编辑基地名称
            <input id="accommodation-manager-edit-name" maxLength={120} autoComplete="off" required value={draft.name} onChange={setDraftField('name')} />
          </label>
          <label>
            编辑类型
            <select id="accommodation-manager-edit-type" value={draft.type} onChange={setDraftField('type')}>
              <option value="hotel">酒店 / 民宿</option>
              <option value="area">住宿区域</option>
            </select>
          </label>
          <label>
            编辑详细地址（选填）
            <input id="accommodation-manager-edit-address" maxLength={240} autoComplete="street-address" value={draft.address} onChange={setDraftField('address')} />
          </label>
          <label>
            编辑备注（选填）
            <textarea id="accommodation-manager-edit-notes" maxLength={600} rows={3} value={draft.notes} onChange={setDraftField('notes')} />
          </label>
          <div className="accommodation-manager-coordinate-grid">
            <label>
              编辑纬度
              <input id="accommodation-manager-edit-lat" type="number" min={-90} max={90} step="any" required value={draft.lat} onChange={setDraftField('lat')} />
            </label>
            <label>
              编辑经度
              <input id="accommodation-manager-edit-lng" type="number" min={-180} max={180} step="any" required value={draft.lng} onChange={setDraftField('lng')} />
            </label>
          </div>
          <div className="accommodation-manager-editor-actions">
            <button type="submit">保存修改</button>
            <button type="button" id="accommodation-manager-cancel-edit-secondary" onClick={hideEditor}>
              取消
            </button>
          </div>
        </form>
      </section>

      <p id="accommodation-manager-status" role="status" aria-live="polite" data-state={statusError ? 'error' : undefined}>
        {status}
      </p>
    </dialog>
  )
}