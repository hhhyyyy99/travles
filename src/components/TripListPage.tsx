import { useCallback, useEffect, useState } from 'react'
import { BookOpen, CalendarDays, MapPin, Pencil, Plus, Trash2, X } from 'lucide-react'
import {
  createTrip,
  deleteTrip,
  fetchTrips,
  formatDateBadge,
  formatDuration,
  previewDaysNights,
  renameTrip,
  type TripFormInput,
  type TripSummary,
} from '../domain/tripList'
import { migrateLegacyDataToServer } from '../domain/migration'

/**
 * 行程列表页 (ticket 02) — default view of the app shell. Create / rename /
 * delete through the server API; every row shows the title plus the
 * "10.02至10.08 7天6晚" date-range badge. Opening a trip will navigate to the
 * workbench in ticket 04 — rows are inert until then; the built-in Hailar
 * guide stays reachable via the header button.
 */
export default function TripListPage({ onOpenGuide }: { onOpenGuide: () => void }) {
  const [trips, setTrips] = useState<TripSummary[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<TripFormInput>({ title: '', startDate: '', endDate: '' })
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<TripSummary | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [migrationNote, setMigrationNote] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoadError(null)
    const result = await fetchTrips()
    if (result.ok) setTrips(result.data)
    else setLoadError(result.error)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Ticket 03: a browser with legacy guide data (checklist + accommodation in
  // localStorage) migrates it into the built-in trip on first entry. The
  // migration is idempotent (marker + fixed row ids) and silent on failure —
  // it retries on the next visit, so the note only shows real success.
  useEffect(() => {
    let cancelled = false
    void migrateLegacyDataToServer().then((result) => {
      if (!cancelled && result.status === 'migrated' && result.tripTitle) {
        setMigrationNote(`已把本浏览器的行前清单与住宿安排迁移到「${result.tripTitle}」。`)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setFormError(null)
    setActionError(null)
    if (form.title.trim().length === 0) {
      setFormError('请填写行程标题。')
      return
    }
    setSubmitting(true)
    const result = await createTrip(form)
    setSubmitting(false)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setForm({ title: '', startDate: '', endDate: '' })
    setTrips((prev) => [...(prev ?? []), result.data])
  }

  const startRename = (trip: TripSummary) => {
    setActionError(null)
    setEditingId(trip.id)
    setEditTitle(trip.title)
  }

  const handleRenameSubmit = async (trip: TripSummary) => {
    if (busyId) return
    setActionError(null)
    setBusyId(trip.id)
    const result = await renameTrip(trip.id, editTitle)
    setBusyId(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setEditingId(null)
    setTrips((prev) => (prev ?? []).map((item) => (item.id === trip.id ? result.data : item)))
  }

  const handleDeleteConfirm = async () => {
    const trip = deleting
    if (!trip || busyId) return
    setActionError(null)
    setBusyId(trip.id)
    const result = await deleteTrip(trip.id)
    setBusyId(null)
    setDeleting(null)
    if (!result.ok) {
      setActionError(result.error)
      return
    }
    setTrips((prev) => (prev ?? []).filter((item) => item.id !== trip.id))
  }

  const preview = previewDaysNights(form.startDate, form.endDate)

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="topbar flex h-[76px] items-center justify-between border-b border-line px-[4%] bg-paper max-sm:h-[62px] max-sm:px-[5%]">
        <div className="flex items-center gap-[10px] text-[18px] font-[650]">
          <MapPin aria-hidden="true" className="text-green w-[26px] h-[26px]" />
          草原之间
          <span className="text-[10px] font-[450] text-muted ml-[14px] max-sm:hidden">旅行工作台 / 行程列表</span>
        </div>
        <button
          id="open-guide"
          type="button"
          onClick={onOpenGuide}
          className="flex items-center gap-[7px] border border-line rounded-[5px] px-[14px] h-[38px] text-[13px] hover:border-green hover:text-green transition-colors"
        >
          <BookOpen aria-hidden="true" className="w-[15px]" />
          示例行程 · 呼伦贝尔指南
        </button>
      </header>

      <main className="mx-auto max-w-[1440px] px-[4%] max-sm:px-[5%]">
        <section className="pt-[42px] pb-[30px] max-sm:pt-[28px] max-sm:pb-[22px]">
          <p className="eyebrow text-[11px] text-green font-[650] mb-[10px]">MY TRIPS · 行程管理</p>
          <h1 className="text-[42px] font-[600] leading-[1.3] max-[720px]:text-[34px]">每一次慢慢走的出发。</h1>
          {migrationNote && (
            <p id="migration-status" className="mt-[14px] text-[12px] text-muted border border-line rounded-[5px] bg-white px-[14px] py-[8px] inline-block">
              {migrationNote}
            </p>
          )}
        </section>

        {/* 创建行程 */}
        <form
          id="trip-create-form"
          onSubmit={handleCreate}
          className="border border-line rounded-[8px] bg-white p-[22px] mb-[34px] max-sm:p-[16px]"
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-[14px] items-end max-[860px]:grid-cols-2 max-[480px]:grid-cols-1">
            <label className="block text-[12px] text-muted">
              行程标题
              <input
                id="trip-title-input"
                type="text"
                value={form.title}
                maxLength={100}
                placeholder="例：国庆呼伦贝尔慢环线"
                onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
                className="mt-[6px] w-full h-[40px] border border-line rounded-[5px] px-[12px] text-[14px] text-ink bg-paper focus:outline-none focus:border-green"
              />
            </label>
            <label className="block text-[12px] text-muted">
              开始日期
              <input
                id="trip-start-input"
                type="date"
                value={form.startDate}
                onChange={(event) => setForm((prev) => ({ ...prev, startDate: event.target.value }))}
                className="mt-[6px] block h-[40px] border border-line rounded-[5px] px-[10px] text-[14px] text-ink bg-paper focus:outline-none focus:border-green"
              />
            </label>
            <label className="block text-[12px] text-muted">
              结束日期
              <input
                id="trip-end-input"
                type="date"
                value={form.endDate}
                min={form.startDate || undefined}
                onChange={(event) => setForm((prev) => ({ ...prev, endDate: event.target.value }))}
                className="mt-[6px] block h-[40px] border border-line rounded-[5px] px-[10px] text-[14px] text-ink bg-paper focus:outline-none focus:border-green"
              />
            </label>
            <button
              id="trip-create-submit"
              type="submit"
              disabled={submitting}
              className="h-[40px] px-[18px] rounded-[5px] bg-green text-white text-[13px] font-[550] flex items-center gap-[7px] disabled:opacity-50"
            >
              <Plus aria-hidden="true" className="w-[15px]" />
              {submitting ? '创建中…' : '创建行程'}
            </button>
          </div>
          <div className="mt-[10px] text-[12px] text-muted flex items-center gap-[10px]">
            <CalendarDays aria-hidden="true" className="w-[14px]" />
            {preview.days > 0 ? `共 ${formatDuration(preview.days, preview.nights)}` : '选择起止日期后自动计算天数与晚数'}
            {formError && <span className="text-red">{formError}</span>}
          </div>
        </form>

        {/* 列表 */}
        {loadError && (
          <div id="trip-load-error" className="border border-red text-red rounded-[8px] px-[18px] py-[14px] mb-[22px] text-[13px] flex items-center justify-between gap-[14px]">
            <span>{loadError}</span>
            <button type="button" onClick={() => void reload()} className="border border-red rounded-[5px] px-[12px] h-[32px] shrink-0">
              重试
            </button>
          </div>
        )}
        {actionError && (
          <div id="trip-action-error" className="border border-red text-red rounded-[8px] px-[18px] py-[14px] mb-[22px] text-[13px]">
            {actionError}
          </div>
        )}

        {trips !== null && trips.length === 0 && !loadError && (
          <p id="trip-list-empty" className="text-muted text-[14px] py-[40px] text-center border border-dashed border-line rounded-[8px]">
            还没有行程 —— 从上面创建第一个吧。
          </p>
        )}

        <ul id="trip-list" className="flex flex-col gap-[14px] pb-[60px]">
          {(trips ?? []).map((trip) => (
            <li
              key={trip.id}
              data-trip-id={trip.id}
              className="border border-line rounded-[8px] bg-white px-[22px] py-[18px] flex items-center gap-[18px] max-sm:flex-wrap max-sm:px-[16px] max-sm:py-[14px]"
            >
              {editingId === trip.id ? (
                <form
                  className="flex items-center gap-[10px] flex-1 min-w-0"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void handleRenameSubmit(trip)
                  }}
                >
                  <input
                    id={`trip-rename-input-${trip.id}`}
                    type="text"
                    value={editTitle}
                    maxLength={100}
                    autoFocus
                    onChange={(event) => setEditTitle(event.target.value)}
                    className="flex-1 min-w-0 h-[36px] border border-line rounded-[5px] px-[10px] text-[14px] text-ink bg-paper focus:outline-none focus:border-green"
                  />
                  <button type="submit" disabled={busyId === trip.id} className="h-[36px] px-[14px] rounded-[5px] bg-green text-white text-[12px] font-[550] disabled:opacity-50">
                    保存
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} aria-label="取消重命名" className="h-[36px] px-[12px] border border-line rounded-[5px] text-[12px] text-muted">
                    取消
                  </button>
                </form>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-[17px] font-[600] truncate">{trip.title}</h2>
                    <p className="trip-badge mt-[6px] inline-flex items-center gap-[6px] text-[12px] text-green border border-line rounded-[999px] px-[10px] py-[3px] bg-paper">
                      <CalendarDays aria-hidden="true" className="w-[13px]" />
                      {[formatDateBadge(trip.startDate, trip.endDate), formatDuration(trip.days, trip.nights)].filter(Boolean).join(' ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-action="rename"
                    aria-label={`重命名 ${trip.title}`}
                    onClick={() => startRename(trip)}
                    className="grid h-[34px] w-[34px] place-items-center border border-line rounded-[5px] text-muted hover:text-green hover:border-green transition-colors"
                  >
                    <Pencil aria-hidden="true" className="w-[14px]" />
                  </button>
                  <button
                    type="button"
                    data-action="delete"
                    aria-label={`删除 ${trip.title}`}
                    onClick={() => {
                      setActionError(null)
                      setDeleting(trip)
                    }}
                    className="grid h-[34px] w-[34px] place-items-center border border-line rounded-[5px] text-muted hover:text-red hover:border-red transition-colors"
                  >
                    <Trash2 aria-hidden="true" className="w-[14px]" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      </main>

      {/* 删除确认 —— 不允许静默丢数据 */}
      {deleting && (
        <div className="fixed inset-0 z-[70] grid place-items-center bg-ink/40 px-[16px]" onClick={() => setDeleting(null)}>
          <div
            id="trip-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="trip-delete-title"
            className="w-full max-w-[420px] bg-white border border-line rounded-[8px] p-[24px]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-[12px]">
              <h3 id="trip-delete-title" className="text-[16px] font-[600]">
                删除行程
              </h3>
              <button type="button" aria-label="关闭" onClick={() => setDeleting(null)} className="text-muted">
                <X aria-hidden="true" className="w-[16px]" />
              </button>
            </div>
            <p className="mt-[12px] text-[13px] text-muted leading-[1.8]">
              确定删除行程「{deleting.title}」吗？行程内的天数、清单与笔记会一并删除，删除后无法恢复。
            </p>
            <div className="mt-[20px] flex justify-end gap-[10px]">
              <button type="button" onClick={() => setDeleting(null)} className="h-[36px] px-[16px] border border-line rounded-[5px] text-[13px] text-muted">
                取消
              </button>
              <button
                id="trip-delete-confirm"
                type="button"
                disabled={busyId === deleting.id}
                onClick={() => void handleDeleteConfirm()}
                className="h-[36px] px-[16px] rounded-[5px] bg-red text-white text-[13px] font-[550] disabled:opacity-50"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
