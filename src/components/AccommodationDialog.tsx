/**
 * 住宿 dialog (ticket 04 part B) — faithful React port of accommodation.js
 * `buildDialog`/`renderDialog`/`openDialog`/map-pick flow (note B §3.4–3.6,
 * §6.1–6.5, gotchas 11/12/24/25).
 *
 * Owns the DOM/aria contract byte-identically: `#accommodation-dialog` with
 * `#accommodation-form`, the existing-base list (`data-accommodation-select`),
 * the night checkboxes `input[name="accommodation-nights"]`, the create editor
 * (`#accommodation-new-name/-type/-address/-notes/-lat/-lng`,
 * `#accommodation-pick-map`), `#accommodation-save-option`（仅保存为备选）,
 * `#accommodation-save-apply`（保存并应用）, `#accommodation-restore-night` and
 * the `#accommodation-map-picker` sibling (role=status + tabindex=-1, gotcha 25).
 *
 * The picker runs on the Leaflet reference map (WGS-84): a document-level
 * keydown (Escape cancels dragging the draft, Enter/space confirms the map
 * center when the map container has focus) and the Leaflet click handler both
 * end in `completeMapPick`. `.map-wrap.amap-active` is swapped off through the
 * AMap live seam `useReferenceMapForPicker` and restored when picking ends
 * (note B §5, gotcha 12).
 *
 * Imperative seam for later tickets: the provider context exports
 * `open(dayIndex)` / `prepareNewBase(input)` — the legacy `tibetAccommodation`
 * API surface ticket 05 (search) consumes to prefill the editor and to keep a
 * duplicate-prompt flow (the duplicate dialog itself is ticket 05's scope).
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { Crosshair, Plus, SlidersHorizontal, X } from 'lucide-react'
import type { LeafletMouseEvent } from 'leaflet'
import { useAccommodation } from '../hooks/useAccommodation'
import { useAmapLive } from '../hooks/useAmapLive'
import {
  getBase,
  getDayStay,
  listBases,
  normalizeBase,
  overnightDays,
  validCoordinate,
} from '../domain/accommodation'
import type { AccommodationBaseType } from '../domain/types'
import { ACCOMMODATION_WRITE_FAILURE_STATUS } from '../domain/storage'
import { tripPlan } from '../data/itinerary'
import { renderAccommodationMarkers, type RouteMapHandle } from '../services/map'
import { AccommodationManager } from './AccommodationManager'

export interface AccommodationDialogApi {
  /** Legacy `tibetAccommodation.open(dayIndex)` — day clamps to an overnight day. */
  open(dayIndex?: number): void
  close(): void
  /**
   * Legacy `prepareNewBase(input)` — opens the editor pre-filled with the
   * draft (search flow, ticket 05). Valid coords also fill the lat/lng
   * fields and the summary; invalid ones keep the manual-pick hint.
   */
  prepareNewBase(input: {
    name?: string
    type?: 'hotel' | 'area'
    address?: string
    notes?: string
    lat?: number | string
    lng?: number | string
    locationLabel?: string
  }): { ok: true }
}

const AccommodationDialogContext = createContext<AccommodationDialogApi | null>(null)

/** Access to the dialog's imperative API (ticket 05 search/prefill glue). */
export function useAccommodationDialog(): AccommodationDialogApi {
  const value = useContext(AccommodationDialogContext)
  if (!value) throw new Error('useAccommodationDialog 必须在 AccommodationDialog 内使用')
  return value
}

const kindLabel = (type: AccommodationBaseType): string => (type === 'area' ? '住宿区域' : '酒店 / 民宿')

const dayLabel = (dayIndex: number): string => {
  const day = tripPlan.days[dayIndex]
  return `第 ${dayIndex + 1} 晚 · ${day ? `${day.date} ${day.weekday}` : ''}`
}

interface Draft {
  name: string
  type: 'hotel' | 'area'
  address: string
  notes: string
  lat: string
  lng: string
}

const EMPTY_DRAFT: Draft = { name: '', type: 'hotel', address: '', notes: '', lat: '', lng: '' }

export function AccommodationDialog({ mapHandle }: { mapHandle: RouteMapHandle | null }) {
  const { state, actions } = useAccommodation()
  const amap = useAmapLive()

  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const [open, setOpen] = useState(false)
  const [currentDay, setCurrentDay] = useState(0)
  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null)
  const [checkedNights, setCheckedNights] = useState<number[]>([0])
  const [editorVisible, setEditorVisible] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [locationSummary, setLocationSummary] = useState('尚未在地图上选择位置')
  const [status, setStatus] = useState('')

  const currentDayRef = useRef(currentDay)
  currentDayRef.current = currentDay
  const checkedNightsRef = useRef(checkedNights)
  checkedNightsRef.current = checkedNights
  const restoreAmapRef = useRef(false)

  /* ------------------------------------------------------------------ *
   * Dialog open/close + showModal lifecycle (accommodation.js L421–436).
   * ------------------------------------------------------------------ */
  const openDialog = (dayIndex = 0): void => {
    const day = overnightDays.includes(Number(dayIndex)) ? Number(dayIndex) : (overnightDays[0] ?? 0)
    setCurrentDay(day)
    setSelectedBaseId(getDayStay(state, day)?.id ?? null)
    setCheckedNights([day])
    setDraft(EMPTY_DRAFT)
    setLocationSummary('尚未在地图上选择位置')
    setEditorVisible(false)
    setStatus('')
    setPicking(false)
    setOpen(true)
  }

  const closeDialog = (): void => {
    setPicking(false)
    setOpen(false)
  }

  /** Legacy topbar 住宿基地 entry — the manager opens from this dialog. */
  const openManager = (): void => {
    setOpen(false)
    setEditorVisible(false)
    setManagerOpen(true)
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

  /** Legacy document-level delegation on `[data-accommodation-open]` (L684). */
  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      const target = event.target as Element | null
      const button = target?.closest?.('[data-accommodation-open]')
      if (button) openDialog(Number((button as HTMLElement).dataset.accommodationOpen))
    }
    document.addEventListener('click', onDocumentClick)
    return () => document.removeEventListener('click', onDocumentClick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  /* ------------------------------------------------------------------ *
   * Custom-base markers on the reference map (L640–647 + notify).
   * ------------------------------------------------------------------ */
  useEffect(() => {
    if (!mapHandle) return
    renderAccommodationMarkers(mapHandle, state.bases)
  }, [mapHandle, state])

  /* ------------------------------------------------------------------ *
   * Map-pick flow (L438–493 + document keydown L688–696).
   * ------------------------------------------------------------------ */
  const completeMapPick = (latlng: { lat: number; lng: number }): void => {
    const lat = Number(latlng.lat).toFixed(6)
    const lng = Number(latlng.lng).toFixed(6)
    setDraft((current) => ({ ...current, lat, lng }))
    setLocationSummary(`已选择 ${lat}, ${lng}`)
    setEditorVisible(true)
    setPicking(false)
    setOpen(true)
    if (restoreAmapRef.current) {
      amap.useReferenceMapForPicker(false)
      restoreAmapRef.current = false
    }
    mapHandle?.map.invalidateSize()
    setStatus('位置已选择，填写名称后保存。')
  }

  const cancelMapPick = (): void => {
    setPicking(false)
    if (restoreAmapRef.current) {
      amap.useReferenceMapForPicker(false)
      restoreAmapRef.current = false
    }
    setOpen(true)
    mapHandle?.map.invalidateSize()
    setStatus('已取消地图选点，已保留当前填写内容。')
    window.setTimeout(() => document.getElementById('accommodation-pick-map')?.focus(), 0)
  }

  const startMapPick = (): void => {
    if (!mapHandle) {
      setStatus('地图尚未就绪，暂时无法选择位置。')
      return
    }
    restoreAmapRef.current = Boolean(document.querySelector('.map-wrap.amap-active'))
    if (restoreAmapRef.current) amap.useReferenceMapForPicker(true)
    closeDialog()
    setPicking(true)
  }

  // While picking: Leaflet click completes the pick; container gets
  // tabindex=0 + focus + the crosshair class (legacy startMapPick L462–466).
  const completeMapPickRef = useRef(completeMapPick)
  completeMapPickRef.current = completeMapPick
  const cancelMapPickRef = useRef(cancelMapPick)
  cancelMapPickRef.current = cancelMapPick

  useEffect(() => {
    if (!picking || !mapHandle) return
    const map = mapHandle.map
    const container = map.getContainer()
    const onClick = (event: LeafletMouseEvent): void => {
      completeMapPickRef.current({ lat: event.latlng.lat, lng: event.latlng.lng })
    }
    map.on('click', onClick)
    container.classList.add('accommodation-picking')
    container.setAttribute('tabindex', '0')
    container.focus({ preventScroll: true })
    return () => {
      map.off('click', onClick)
      container.classList.remove('accommodation-picking')
      container.removeAttribute('tabindex')
    }
  }, [picking, mapHandle])

  // Document-level keydown while picking (L688–696): Escape cancels (keeping
  // the draft), Enter/space on the focused map container confirms the center.
  useEffect(() => {
    if (!picking || !mapHandle) return
    const container = mapHandle.map.getContainer()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelMapPickRef.current()
        return
      }
      if ((event.key === 'Enter' || event.key === ' ') && event.target === container) {
        event.preventDefault()
        const center = mapHandle.map.getCenter()
        completeMapPickRef.current({ lat: center.lat, lng: center.lng })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [picking, mapHandle])

  /* ------------------------------------------------------------------ *
   * Night choices + base list (L366–390).
   * ------------------------------------------------------------------ */
  const toggleNight = (index: number): void => {
    setCheckedNights((current) =>
      current.includes(index) ? current.filter((night) => night !== index) : [...current, index],
    )
  }

  const selectBase = (id: string): void => {
    const base = getBase(state, id)
    if (!base) return
    setSelectedBaseId(id)
    setStatus('已选择住宿基地，请选择应用的晚次。')
  }

  const applySelected = (): void => {
    if (!selectedBaseId) return
    const result = actions.applyStays(checkedNightsRef.current, selectedBaseId)
    if (!result.ok) {
      setStatus(result.error === '保存失败' ? ACCOMMODATION_WRITE_FAILURE_STATUS : result.error)
      return
    }
    closeDialog()
  }

  const restoreNight = (): void => {
    const result = actions.restoreDay(currentDayRef.current)
    if (!result.ok) {
      setStatus(result.error === '保存失败' ? ACCOMMODATION_WRITE_FAILURE_STATUS : result.error)
      return
    }
    closeDialog()
  }

  /* ------------------------------------------------------------------ *
   * Create editor + save (L394–419, L495–519, L597–628).
   * ------------------------------------------------------------------ */
  const cancelNew = (): void => {
    setDraft(EMPTY_DRAFT)
    setLocationSummary('尚未在地图上选择位置')
    setEditorVisible(false)
  }

  const addNew = (): void => {
    setSelectedBaseId(null)
    setDraft(EMPTY_DRAFT)
    setLocationSummary('尚未在地图上选择位置')
    setEditorVisible(true)
    setCheckedNights([currentDayRef.current])
    setStatus('填写名称并在地图上确认位置。')
  }

  const prepareNewBase = (input: {
    name?: string
    type?: 'hotel' | 'area'
    address?: string
    notes?: string
    lat?: number | string
    lng?: number | string
    locationLabel?: string
  }): { ok: true } => {
    setSelectedBaseId(null)
    const latValue = String(input.lat ?? '').trim()
    const lngValue = String(input.lng ?? '').trim()
    const lat = latValue === '' ? NaN : Number(latValue)
    const lng = lngValue === '' ? NaN : Number(lngValue)
    if (validCoordinate(lat, lng)) {
      setDraft({
        name: String(input.name || '').trim().slice(0, 120),
        type: input.type === 'area' ? 'area' : 'hotel',
        address: String(input.address || '').trim().slice(0, 240),
        notes: String(input.notes || '').trim().slice(0, 600),
        lat: lat.toFixed(6),
        lng: lng.toFixed(6),
      })
      setLocationSummary(input.locationLabel || `已确认 ${lat.toFixed(6)}, ${lng.toFixed(6)}`)
      setStatus('位置已确认，核对名称后保存。')
    } else {
      setDraft({
        name: String(input.name || '').trim().slice(0, 120),
        type: input.type === 'area' ? 'area' : 'hotel',
        address: String(input.address || '').trim().slice(0, 240),
        notes: String(input.notes || '').trim().slice(0, 600),
        lat: '',
        lng: '',
      })
      setLocationSummary('尚未在地图上选择位置')
      setStatus('填写名称并在地图上确认位置。')
    }
    setEditorVisible(true)
    setCheckedNights([currentDayRef.current])
    return { ok: true }
  }

  const saveNew = (applyToNights: boolean): void => {
    const base = normalizeBase({ ...draft })
    if (!base) {
      setStatus('请填写基地名称，并在地图上确认有效位置。')
      return
    }
    const result = actions.createBase(base, {
      applyToNights: applyToNights ? checkedNightsRef.current : [],
    })
    if (!result.ok) {
      setStatus(result.error === '保存失败' ? ACCOMMODATION_WRITE_FAILURE_STATUS : result.error)
      return
    }
    if (applyToNights) {
      closeDialog()
      setStatus('')
    } else {
      setEditorVisible(false)
      setLocationSummary('尚未在地图上选择位置')
      setStatus('已保存为备选住宿基地。')
    }
  }

  const setDraftField = (field: keyof Draft) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setDraft((current) => ({ ...current, [field]: event.target.value }))
  }

  const api = useMemo<AccommodationDialogApi>(
    () => ({ open: openDialog, close: closeDialog, prepareNewBase }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state],
  )

  const bases = listBases(state)
  const applyDisabled = !selectedBaseId

  return (
    <AccommodationDialogContext.Provider value={api}>
      <dialog
        ref={dialogRef}
        id="accommodation-dialog"
        aria-labelledby="accommodation-dialog-title"
        onCancel={(event) => {
          event.preventDefault()
          setOpen(false)
        }}
      >
        <form id="accommodation-form" onSubmit={(event) => event.preventDefault()}>
          <div className="dialog-heading">
            <h2 id="accommodation-dialog-title">第 {currentDay + 1} 天 · 更换住宿</h2>
            <button type="button" id="accommodation-close" title="关闭" aria-label="关闭" onClick={closeDialog}>
              <X aria-hidden="true" />
            </button>
          </div>
          <p className="accommodation-dialog-intro">自定义基地只保存在当前浏览器。必须确认地图位置后才能保存。</p>
          <section className="accommodation-existing">
            <div className="accommodation-section-heading">
              <h3>已有住宿基地</h3>
              <span id="accommodation-selected-label">
                {selectedBaseId ? `已选择：${getBase(state, selectedBaseId)?.name || ''}` : '先选择一个已有基地，或新增住宿基地。'}
              </span>
            </div>
            <div id="accommodation-base-list">
              {bases.map((base) => {
                const selected = selectedBaseId === base.id
                return (
                  <article
                    key={base.id}
                    className={`accommodation-option${selected ? ' is-selected' : ''}`}
                    data-base-option={base.id}
                  >
                    <div>
                      <strong>{base.name}</strong>
                      <small>
                        {kindLabel(base.type)}
                        {base.isDefault ? ' · 默认住宿' : ''}
                      </small>
                      <p>
                        {base.address ? `${base.address} · ` : ''}
                        {base.lat.toFixed(5)}, {base.lng.toFixed(5)}
                      </p>
                      {base.notes ? <p>{base.notes}</p> : null}
                    </div>
                    <button type="button" data-accommodation-select={base.id} onClick={() => selectBase(base.id)}>
                      {selected ? '已选择' : '选择'}
                    </button>
                  </article>
                )
              })}
            </div>
            <button type="button" id="accommodation-apply-selected" className="accommodation-apply" disabled={applyDisabled} onClick={applySelected}>
              应用到所选晚次
            </button>
          </section>
          <section className="accommodation-nights">
            <fieldset>
              <legend>应用到住宿晚次</legend>
              <div id="accommodation-night-choices" className="accommodation-night-choices">
                {overnightDays.map((index) => {
                  const stay = getDayStay(state, index)
                  return (
                    <label key={index}>
                      <input
                        type="checkbox"
                        name="accommodation-nights"
                        value={index}
                        checked={checkedNights.includes(index)}
                        onChange={() => toggleNight(index)}
                      />
                      {dayLabel(index)}
                      <small>{stay?.name || '未安排'}</small>
                    </label>
                  )
                })}
              </div>
            </fieldset>
            <button type="button" id="accommodation-restore-night" className="accommodation-restore" onClick={restoreNight}>
              恢复本晚默认住宿
            </button>
          </section>
          <div className="accommodation-manager-entry">
            <button type="button" id="accommodation-add-toggle" className="accommodation-add" onClick={addNew}>
              <Plus aria-hidden="true" />
              新增住宿基地
            </button>
            <button type="button" id="accommodation-manager-open" className="accommodation-add" onClick={openManager}>
              <SlidersHorizontal aria-hidden="true" />
              管理住宿基地
            </button>
          </div>
          <section className="accommodation-editor" id="accommodation-editor" hidden={!editorVisible}>
            <div className="accommodation-section-heading">
              <h3>新增住宿基地</h3>
              <button type="button" id="accommodation-cancel-new" onClick={cancelNew}>
                取消
              </button>
            </div>
            <label>
              基地名称
              <input
                id="accommodation-new-name"
                maxLength={120}
                autoComplete="off"
                required
                value={draft.name}
                onChange={setDraftField('name')}
              />
            </label>
            <label>
              类型
              <select id="accommodation-new-type" value={draft.type} onChange={setDraftField('type')}>
                <option value="hotel">酒店 / 民宿</option>
                <option value="area">住宿区域</option>
              </select>
            </label>
            <label>
              详细地址（选填）
              <input id="accommodation-new-address" maxLength={240} autoComplete="street-address" value={draft.address} onChange={setDraftField('address')} />
            </label>
            <label>
              备注（选填）
              <textarea id="accommodation-new-notes" maxLength={600} rows={3} value={draft.notes} onChange={setDraftField('notes')} />
            </label>
            <div className="accommodation-location">
              <div>
                <strong>地图位置</strong>
                <span id="accommodation-location-summary">{locationSummary}</span>
              </div>
              <button type="button" id="accommodation-pick-map" onClick={startMapPick}>
                <Crosshair aria-hidden="true" />
                在地图上选点
              </button>
            </div>
            <div className="accommodation-coordinates">
              <label>
                纬度
                <input id="accommodation-new-lat" inputMode="decimal" readOnly required value={draft.lat} />
              </label>
              <label>
                经度
                <input id="accommodation-new-lng" inputMode="decimal" readOnly required value={draft.lng} />
              </label>
            </div>
            <div className="accommodation-editor-actions">
              <button type="button" id="accommodation-save-option" onClick={() => saveNew(false)}>
                仅保存为备选
              </button>
              <button type="button" id="accommodation-save-apply" onClick={() => saveNew(true)}>
                保存并应用
              </button>
            </div>
          </section>
          <p id="accommodation-dialog-status" role="status" aria-live="polite">
            {status}
          </p>
        </form>
      </dialog>
      <div id="accommodation-map-picker" tabIndex={-1} role="status" hidden={!picking}>
        <span>拖动地图或使用方向键平移，按 Enter 确认地图中心。</span>
        <button type="button" id="accommodation-confirm-pick" onClick={() => completeMapPick({ lat: mapHandle?.map.getCenter().lat ?? 0, lng: mapHandle?.map.getCenter().lng ?? 0 })}>
          使用地图中心位置
        </button>
        <button type="button" id="accommodation-cancel-pick" onClick={cancelMapPick}>
          取消选点
        </button>
      </div>
      <AccommodationManager
        open={managerOpen}
        onClose={() => setManagerOpen(false)}
        onReplace={(night) => {
          setManagerOpen(false)
          openDialog(night)
        }}
      />
    </AccommodationDialogContext.Provider>
  )
}