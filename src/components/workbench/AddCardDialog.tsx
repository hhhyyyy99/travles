/**
 * 添加卡片弹窗 (ticket 09) — two modes behind one dialog: 搜索 POI (client
 * AMap place search via the existing `searchPlaces` service; results map to
 * PoiRef through workbench.poiFromPlace) and 自由文本 (poi: null plain-text
 * card, spec 用户故事 31). Submitting hands a WorkbenchItemCreateInput to the
 * page, which performs the optimistic create + rollback.
 */
import { useState } from 'react'
import { Search } from 'lucide-react'
import {
  CARD_TYPE_LABEL,
  poiFromPlace,
  type ItemType,
  type WorkbenchDay,
  type WorkbenchItemCreateInput,
  type PoiRef,
} from '../../domain/workbench'
import { searchPlaces, type AmapPlaceResult } from '../../services/amap'

const TYPE_OPTIONS: ItemType[] = ['attraction', 'food', 'stay', 'traffic', 'other']

export default function AddCardDialog({
  days,
  defaultDayId,
  onSubmit,
  onClose,
}: {
  days: WorkbenchDay[]
  defaultDayId: string
  onSubmit: (input: WorkbenchItemCreateInput) => void
  onClose: () => void
}) {
  const [mode, setMode] = useState<'poi' | 'text'>('text')
  const [dayId, setDayId] = useState(defaultDayId)
  const [title, setTitle] = useState('')
  const [type, setType] = useState<ItemType>('attraction')
  const [note, setNote] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AmapPlaceResult[]>([])
  const [selected, setSelected] = useState<PoiRef | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')

  const runSearch = async () => {
    const q = query.trim()
    if (!q || searching) return
    setSearching(true)
    setError('')
    try {
      const places = await searchPlaces(q)
      setResults(places)
      setSelected(null)
      if (places.length === 0) setError('没有找到相关地点，可换一个关键词或改用自由文本。')
    } catch (searchError) {
      setResults([])
      setSelected(null)
      const code = (searchError as { code?: string }).code
      setError(code === 'empty' ? '请输入地点关键词。' : 'POI 搜索不可用，可改用自由文本添加。')
    } finally {
      setSearching(false)
    }
  }

  const submit = () => {
    if (mode === 'poi') {
      if (!selected) {
        setError('请先选择一个搜索结果。')
        return
      }
      onSubmit({ dayId, title: selected.name, type, poi: selected, note: '' })
      return
    }
    const trimmed = title.trim()
    if (!trimmed) {
      setError('请填写卡片标题。')
      return
    }
    onSubmit({ dayId, title: trimmed, type, note: note.trim(), poi: null })
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div
        data-add-card-dialog
        role="dialog"
        aria-modal="true"
        aria-label="添加卡片"
        className="w-[360px] rounded-[8px] border border-line bg-white p-[16px] shadow-lg"
      >
        <div className="flex items-center gap-[8px]">
          <h2 className="text-[14px] font-[600] text-ink">添加卡片</h2>
          <span id="workbench-add-card-modes" className="ml-auto flex items-center gap-[2px] rounded-[6px] border border-line p-[2px]">
            <button
              type="button"
              data-add-mode="text"
              aria-pressed={mode === 'text'}
              onClick={() => {
                setMode('text')
                setError('')
              }}
              className={`h-[24px] rounded-[4px] px-[8px] text-[12px] transition-colors ${
                mode === 'text' ? 'bg-green text-white' : 'text-muted hover:text-ink'
              }`}
            >
              自由文本
            </button>
            <button
              type="button"
              data-add-mode="poi"
              aria-pressed={mode === 'poi'}
              onClick={() => {
                setMode('poi')
                setError('')
              }}
              className={`h-[24px] rounded-[4px] px-[8px] text-[12px] transition-colors ${
                mode === 'poi' ? 'bg-green text-white' : 'text-muted hover:text-ink'
              }`}
            >
              搜索 POI
            </button>
          </span>
        </div>

        <label className="mt-[12px] block text-[12px] text-muted">
          目标日程
          <select
            data-add-day
            value={dayId}
            onChange={(event) => setDayId(event.target.value)}
            className="mt-[4px] h-[32px] w-full rounded-[6px] border border-line bg-white px-[8px] text-[13px] text-ink outline-none focus:border-green"
          >
            {days.map((day) => (
              <option key={day.id} value={day.id}>
                {dayDateLabelOf(day)} {weekdayOf(day)}
              </option>
            ))}
          </select>
        </label>

        {mode === 'text' ? (
          <>
            <label className="mt-[10px] block text-[12px] text-muted">
              标题
              <input
                data-add-title
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="如：自由活动、赶路去额尔古纳"
                className="mt-[4px] h-[32px] w-full rounded-[6px] border border-line px-[8px] text-[13px] outline-none focus:border-green"
              />
            </label>
            <label className="mt-[10px] block text-[12px] text-muted">
              备注（可选）
              <input
                data-add-note
                type="text"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="一句话说明"
                className="mt-[4px] h-[32px] w-full rounded-[6px] border border-line px-[8px] text-[13px] outline-none focus:border-green"
              />
            </label>
          </>
        ) : (
          <>
            <label className="mt-[10px] block text-[12px] text-muted">
              搜索地点
              <span className="mt-[4px] flex gap-[6px]">
                <input
                  data-add-search
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void runSearch()
                    }
                  }}
                  placeholder="地点名称或区域"
                  className="h-[32px] min-w-0 flex-1 rounded-[6px] border border-line px-[8px] text-[13px] outline-none focus:border-green"
                />
                <button
                  type="button"
                  data-action="add-search"
                  onClick={() => void runSearch()}
                  disabled={searching || query.trim() === ''}
                  aria-label="搜索地点"
                  className="grid h-[32px] w-[32px] shrink-0 place-items-center rounded-[6px] bg-green text-white transition-opacity disabled:opacity-40"
                >
                  <Search aria-hidden="true" className="w-[14px]" />
                </button>
              </span>
            </label>
            {results.length > 0 && (
              <div data-add-result className="mt-[8px] flex max-h-[140px] flex-col gap-[4px] overflow-y-auto">
                {results.map((place) => (
                  <button
                    key={place.id}
                    type="button"
                    data-add-result-item={place.id}
                    onClick={() => setSelected(poiFromPlace(place))}
                    className={`rounded-[5px] border px-[8px] py-[5px] text-left text-[12px] transition-colors ${
                      selected?.name === place.name ? 'border-green bg-paper' : 'border-line hover:border-green'
                    }`}
                  >
                    <span className="text-ink">{place.name}</span>
                    {place.address && <span className="ml-[6px] text-muted">{place.address}</span>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <label className="mt-[10px] block text-[12px] text-muted">
          类型
          <select
            data-add-type
            value={type}
            onChange={(event) => setType(event.target.value as ItemType)}
            className="mt-[4px] h-[32px] w-full rounded-[6px] border border-line bg-white px-[8px] text-[13px] text-ink outline-none focus:border-green"
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {CARD_TYPE_LABEL[option]}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p data-add-error role="alert" className="mt-[8px] text-[12px] text-[#b75342]">
            {error}
          </p>
        )}

        <div className="mt-[14px] flex justify-end gap-[8px]">
          <button
            type="button"
            data-action="add-cancel"
            onClick={onClose}
            className="h-[30px] rounded-[5px] border border-line px-[14px] text-[13px] text-muted hover:border-green hover:text-green transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            data-action="add-confirm"
            onClick={submit}
            className="h-[30px] rounded-[5px] bg-green px-[14px] text-[13px] text-white"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}

function dayDateLabelOf(day: WorkbenchDay): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(day.date) ? `${day.date.slice(5, 7)}.${day.date.slice(8, 10)}` : `D${day.index + 1}`
}

function weekdayOf(day: WorkbenchDay): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) return ''
  const utc = Date.parse(`${day.date}T00:00:00Z`)
  if (!Number.isFinite(utc)) return ''
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(utc).getUTCDay()] ?? ''
}
