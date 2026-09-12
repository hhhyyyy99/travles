import { useEffect, useMemo, useState } from 'react'
import { BedDouble, X } from 'lucide-react'
import type { PoiRef, WorkbenchDay, WorkbenchItemPatch } from '../../domain/workbench'

export type StayEditorProps = {
  days: WorkbenchDay[]
  onSave: (itemId: string, patch: WorkbenchItemPatch) => Promise<boolean>
  onClose: () => void
}

/** Edit the current trip's stay cards; persistence is delegated to WorkbenchPage. */
export default function StayEditor({ days, onSave, onClose }: StayEditorProps) {
  const stays = useMemo(
    () => days.flatMap((day) => day.items.filter((item) => item.type === 'stay')),
    [days],
  )
  const [selectedId, setSelectedId] = useState(stays[0]?.id ?? '')
  const selected = stays.find((item) => item.id === selectedId) ?? stays[0] ?? null
  const [title, setTitle] = useState('')
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [lat, setLat] = useState('')
  const [lng, setLng] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!selected) return
    setTitle(selected.title)
    setAddress(selected.poi?.address ?? '')
    setNote(selected.note)
    setLat(selected.poi && selected.poi.lat !== 0 ? String(selected.poi.lat) : '')
    setLng(selected.poi && selected.poi.lng !== 0 ? String(selected.poi.lng) : '')
    setError('')
  }, [selected])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!selected || saving) return
    const nextTitle = title.trim()
    if (!nextTitle) {
      setError('住宿名称不能为空。')
      return
    }
    const nextLat = Number(lat)
    const nextLng = Number(lng)
    const previousPoi = selected.poi
    const poi: PoiRef = {
      amapId: previousPoi?.amapId ?? '',
      name: nextTitle,
      lat: Number.isFinite(nextLat) ? nextLat : previousPoi?.lat ?? 0,
      lng: Number.isFinite(nextLng) ? nextLng : previousPoi?.lng ?? 0,
      ...(address.trim() ? { address: address.trim() } : {}),
      ...(previousPoi?.accommodationBaseId ? { accommodationBaseId: previousPoi.accommodationBaseId } : {}),
      ...(previousPoi?.accommodationType ? { accommodationType: previousPoi.accommodationType } : {}),
      ...(previousPoi?.accommodationNotes ? { accommodationNotes: previousPoi.accommodationNotes } : {}),
      ...(previousPoi?.accommodationMigrationVersion
        ? { accommodationMigrationVersion: previousPoi.accommodationMigrationVersion }
        : {}),
      category: previousPoi?.category ?? '住宿',
      rating: previousPoi?.rating ?? 0,
      introSummary: previousPoi?.introSummary ?? '',
    }
    setSaving(true)
    setError('')
    const saved = await onSave(selected.id, { title: nextTitle, note, poi })
    setSaving(false)
    if (saved) onClose()
    else setError('住宿保存失败，请重试。')
  }

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-ink/40 px-[16px]" onClick={onClose}>
      <div
        id="workbench-stay-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workbench-stay-editor-title"
        className="w-full max-w-[520px] rounded-[8px] border border-line bg-white p-[20px] shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-[8px]">
          <BedDouble aria-hidden="true" className="mt-[2px] w-[17px] text-green" />
          <div className="min-w-0 flex-1">
            <h2 id="workbench-stay-editor-title" className="text-[16px] font-[600]">编辑住宿</h2>
            <p className="mt-[3px] text-[12px] text-muted">修改会同步到当前行程的住宿卡片与打印内容。</p>
          </div>
          <button type="button" aria-label="关闭住宿编辑" title="关闭" onClick={onClose} className="grid h-[26px] w-[26px] place-items-center text-muted hover:text-ink">
            <X aria-hidden="true" className="w-[15px]" />
          </button>
        </header>

        {stays.length === 0 ? (
          <p className="mt-[18px] rounded-[6px] border border-dashed border-line px-[12px] py-[14px] text-[12px] text-muted">当前行程还没有住宿卡片。</p>
        ) : (
          <>
            <div className="mt-[16px] flex gap-[6px] overflow-x-auto border-b border-line pb-[8px]">
              {stays.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-stay-editor-item={item.id}
                  aria-pressed={item.id === selected?.id}
                  onClick={() => setSelectedId(item.id)}
                  className={`shrink-0 rounded-[5px] border px-[9px] py-[5px] text-[12px] ${item.id === selected?.id ? 'border-green bg-green/10 text-ink' : 'border-line text-muted'}`}
                >
                  {item.title || '未命名住宿'}
                </button>
              ))}
            </div>
            {selected && (
              <form className="mt-[14px] grid gap-[10px]" onSubmit={save}>
                <label className="block text-[12px] text-muted">
                  住宿名称
                  <input id="workbench-stay-title" data-stay-editor-title value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} className="mt-[5px] h-[36px] w-full rounded-[5px] border border-line bg-paper px-[10px] text-[13px] text-ink focus:border-green focus:outline-none" />
                </label>
                <label className="block text-[12px] text-muted">
                  地址
                  <input id="workbench-stay-address" data-stay-editor-address value={address} maxLength={500} onChange={(event) => setAddress(event.target.value)} className="mt-[5px] h-[36px] w-full rounded-[5px] border border-line bg-paper px-[10px] text-[13px] text-ink focus:border-green focus:outline-none" />
                </label>
                <div className="grid grid-cols-2 gap-[8px]">
                  <label className="block text-[12px] text-muted">
                    纬度
                    <input value={lat} inputMode="decimal" onChange={(event) => setLat(event.target.value)} className="mt-[5px] h-[36px] w-full rounded-[5px] border border-line bg-paper px-[10px] text-[13px] text-ink focus:border-green focus:outline-none" />
                  </label>
                  <label className="block text-[12px] text-muted">
                    经度
                    <input value={lng} inputMode="decimal" onChange={(event) => setLng(event.target.value)} className="mt-[5px] h-[36px] w-full rounded-[5px] border border-line bg-paper px-[10px] text-[13px] text-ink focus:border-green focus:outline-none" />
                  </label>
                </div>
                <label className="block text-[12px] text-muted">
                  住宿备注
                  <textarea id="workbench-stay-note" data-stay-editor-note value={note} maxLength={2000} rows={3} onChange={(event) => setNote(event.target.value)} className="mt-[5px] w-full resize-y rounded-[5px] border border-line bg-paper px-[10px] py-[7px] text-[13px] text-ink focus:border-green focus:outline-none" />
                </label>
                {error && <p data-stay-editor-error className="text-[12px] text-red">{error}</p>}
                <div className="flex justify-end gap-[8px] pt-[4px]">
                  <button type="button" onClick={onClose} className="h-[34px] rounded-[5px] border border-line px-[12px] text-[12px] text-muted">取消</button>
                  <button type="submit" disabled={saving} className="h-[34px] rounded-[5px] bg-green px-[14px] text-[12px] font-[550] text-white disabled:opacity-50">{saving ? '保存中…' : '保存住宿'}</button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  )
}
