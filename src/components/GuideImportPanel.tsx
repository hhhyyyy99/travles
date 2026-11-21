import { useEffect, useRef, useState } from 'react'
import { ArrowRight, FileText, Link2, LoaderCircle } from 'lucide-react'
import type { GuideDraft, TripSummary } from '@hailar/domain'
import { createGuideImportId, importGuide, parseGuide, type GuideImportInput, type GuideImportSession } from '../domain/guideParsing'

const fieldClass = 'mt-[6px] w-full rounded-[5px] border border-line bg-white px-[12px] py-[10px] text-[14px] text-ink focus-visible:outline-2 focus-visible:outline-green'
const secondaryClass = 'min-h-[44px] rounded-[5px] border border-line px-[16px] text-[13px] text-muted hover:border-green hover:text-green'
const primaryClass = 'inline-flex min-h-[44px] items-center justify-center gap-[8px] rounded-[5px] bg-green px-[18px] text-[13px] font-[550] text-white disabled:opacity-50'
const itemLabels = { attraction: '游玩', traffic: '交通', food: '餐饮', stay: '住宿', other: '便签' }

export default function GuideImportPanel({ onCreated, onOpenSettings, onBusyChange, session, onSessionChange }: {
  onCreated: (trip: TripSummary) => void
  onOpenSettings?: () => void
  onBusyChange: (busy: boolean) => void
  session?: GuideImportSession | null
  onSessionChange: (session: GuideImportSession) => void
}) {
  const [url, setUrl] = useState(session?.url ?? '')
  const [text, setText] = useState(session?.text ?? '')
  const [draft, setDraft] = useState<GuideDraft | null>(session?.draft ?? null)
  const [title, setTitle] = useState(session?.title ?? '')
  const [importId, setImportId] = useState(session?.importId ?? '')
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'importing'>('idle')
  const [error, setError] = useState<{ message: string; settings?: boolean } | null>(null)
  const [guidance, setGuidance] = useState<string | null>(null)
  const [locked, setLocked] = useState(Boolean(session?.confirmation))
  const busy = useRef(false)
  const completed = useRef(false)
  const request = useRef<AbortController | null>(null)
  const confirmation = useRef<GuideImportInput | null>(session?.confirmation ?? null)
  const bodyInput = useRef<HTMLTextAreaElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)

  // Keep this attempt in page memory across settings navigation, without browser storage.
  useEffect(() => { if (!completed.current) onSessionChange({ url, text, draft, title, importId, confirmation: confirmation.current }) }, [url, text, draft, title, importId, locked, onSessionChange])
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => { if (draft) previewHeading.current?.focus() }, [draft])
  useEffect(() => { if (guidance && phase === 'idle' && !draft) bodyInput.current?.focus() }, [guidance, phase, draft])

  function startRequest(nextPhase: 'parsing' | 'importing') {
    const controller = new AbortController()
    request.current = controller
    busy.current = true
    setPhase(nextPhase)
    onBusyChange(true)
    setError(null)
    return controller
  }

  function finishRequest() {
    busy.current = false
    setPhase('idle')
    onBusyChange(false)
  }

  async function handleParse(event: React.FormEvent) {
    event.preventDefault()
    if (busy.current) return
    setError(null)
    if (!text.trim() && !url.trim()) {
      setError({ message: '请粘贴攻略链接或正文。' })
      return
    }
    if (!text.trim()) {
      try {
        if (!['http:', 'https:'].includes(new URL(url.trim()).protocol)) throw new Error('invalid url')
      } catch {
        setError({ message: '请输入以 http:// 或 https:// 开头的完整链接，或直接粘贴正文。' })
        return
      }
    }
    setGuidance(null)
    const controller = startRequest('parsing')
    const result = await parseGuide(text.trim() ? { text: text.trim() } : { url: url.trim() }, controller.signal)
    if (controller.signal.aborted) return
    finishRequest()
    if (!result.ok) {
      setError({ message: result.error, settings: result.code === 'model_unconfigured' })
    } else if (result.data.status === 'text_required') {
      setGuidance(result.data.guidance)
    } else if (result.data.status === 'ready') {
      setDraft(result.data.draft)
      setTitle(result.data.draft.title.slice(0, 100))
      setImportId(createGuideImportId())
      setLocked(false)
      confirmation.current = null
    }
  }

  async function handleImport(event: React.FormEvent) {
    event.preventDefault()
    if (busy.current || !draft) return
    if (!title.trim()) { setError({ message: '请填写行程标题。' }); return }
    // A response can be lost after a committed write. Retry the frozen request.
    confirmation.current ??= { draft, title: title.trim(), importId }
    onSessionChange({ url, text, draft, title, importId, confirmation: confirmation.current })
    setLocked(true)
    const controller = startRequest('importing')
    const result = await importGuide(confirmation.current, controller.signal)
    if (controller.signal.aborted) return
    finishRequest()
    if (!result.ok) { setError({ message: result.error }); return }
    setDraft(null)
    setUrl('')
    setText('')
    confirmation.current = null
    // Navigation unmounts this form in the same batch, so clear the session now.
    completed.current = true
    onSessionChange({ url: '', text: '', draft: null, title: '', importId: '', confirmation: null })
    onCreated(result.data)
  }

  function discard() {
    setDraft(null)
    setError(null)
    setGuidance(null)
    setLocked(false)
    confirmation.current = null
  }

  const errorContent = error && (
    <div id="guide-error" role="alert" className="mt-[12px] rounded-[5px] border border-red/30 bg-white px-[14px] py-[10px] text-[13px] text-red">
      <p>{error.message}</p>
      {error.settings && onOpenSettings && <button type="button" onClick={onOpenSettings} className="mt-[8px] min-h-[44px] underline underline-offset-4">前往 AI 接入设置</button>}
    </div>
  )

  if (!draft) return (
    <form id="guide-parse-form" onSubmit={(event) => void handleParse(event)} noValidate aria-busy={phase === 'parsing'} className="p-[20px] max-sm:p-[14px]">
      <div className="mb-[18px]">
        <h2 className="text-[17px] font-[600]">把攻略整理成自己的行程</h2>
        <p className="mt-[5px] text-[13px] text-muted">粘贴链接或正文，先预览，再决定是否创建。不会改动已有行程。</p>
      </div>
      <fieldset disabled={phase === 'parsing'} className="m-0 min-w-0 border-0 p-0">
        <label htmlFor="guide-url" className="block text-[13px] text-muted">
          <span className="inline-flex items-center gap-[6px]"><Link2 aria-hidden="true" className="w-[15px]" />攻略链接（可选）</span>
        </label>
        <input id="guide-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} maxLength={2000} placeholder="https://…" className={fieldClass} autoComplete="off" aria-describedby="guide-input-help" />
        <label htmlFor="guide-text" className="mt-[16px] block text-[13px] text-muted">
          <span className="inline-flex items-center gap-[6px]"><FileText aria-hidden="true" className="w-[15px]" />攻略正文（可选）</span>
        </label>
        <textarea ref={bodyInput} id="guide-text" value={text} onChange={(event) => setText(event.target.value)} maxLength={20000} rows={5} placeholder="也可以直接粘贴攻略，例如：成都两天，第一天人民公园喝茶、宽窄巷子漫步；第二天游览都江堰。" className={fieldClass + ' min-h-[132px] resize-y'} aria-describedby="guide-input-help" />
        <div id="guide-input-help" className="mt-[6px] flex flex-wrap justify-between gap-[6px] text-[12px] text-muted">
          <span>链接无法读取时可粘贴正文；两者都有时优先解析正文。</span><span>{text.length.toLocaleString()} / 20,000 字</span>
        </div>
      </fieldset>
      {guidance && <p id="guide-fallback" role="status" className="mt-[12px] rounded-[5px] border border-line bg-white px-[14px] py-[10px] text-[13px]">{guidance}</p>}
      {errorContent}
      <div className="mt-[18px] flex flex-wrap items-center gap-[12px]">
        <button id="guide-parse-submit" type="submit" disabled={phase === 'parsing'} className={primaryClass}>
          {phase === 'parsing' ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : <ArrowRight aria-hidden="true" />}
          {phase === 'parsing' ? '正在解析…' : '解析攻略'}
        </button>
        {phase === 'parsing' ? <>
          <span role="status" className="text-[13px] text-muted">正在读取攻略、提取日程并匹配地点，请稍候。</span>
          <button type="button" className={secondaryClass} onClick={() => { request.current?.abort(); finishRequest() }}>取消解析</button>
        </> : <span className="text-[12px] text-muted">解析后保留原文顺序，日期和不明确的地点留待确认。</span>}
      </div>
    </form>
  )

  const itemCount = draft.days.reduce((count, day) => count + day.items.length, 0)
  const pendingCount = draft.days.reduce((count, day) => count + day.items.filter((item) => item.type !== 'other' && item.pending).length, 0)
  return (
    <form id="guide-preview" onSubmit={(event) => void handleImport(event)} aria-busy={phase === 'importing'} className="p-[20px] max-sm:p-[14px]">
      <div className="flex flex-wrap items-start justify-between gap-[12px]">
        <div>
          <h2 ref={previewHeading} tabIndex={-1} className="text-[18px] font-[600] focus:outline-none">攻略草稿预览</h2>
          <p className="mt-[5px] text-[13px] text-muted">{draft.destination || '目的地待确认'} · {draft.days.length} 天 · {itemCount} 个活动 · 日期待定</p>
        </div>
        <span className="rounded-full border border-line bg-white px-[12px] py-[4px] text-[12px] text-green">尚未创建行程</span>
      </div>
      <label htmlFor="guide-trip-title" className="mt-[18px] block text-[13px] text-muted">行程标题</label>
      <input id="guide-trip-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required disabled={locked} className={fieldClass} />
      <div className="mt-[14px] text-[13px] text-muted">
        {pendingCount > 0 && <p>{pendingCount} 个活动的地点待确认，创建后可在工作台补充。</p>}
        {draft.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      </div>
      <div className="mt-[16px] grid max-h-[480px] gap-[18px] overflow-y-auto overscroll-contain rounded-[6px] border border-line bg-white p-[16px] max-sm:p-[12px]" role="region" aria-label="按天排列的攻略草稿" tabIndex={0}>
        {draft.days.map((day) => <section key={day.dayNumber} data-guide-day={day.dayNumber}>
          <h3 className="text-[14px] font-[650]"><span className="mr-[8px] text-green">第 {day.dayNumber} 天</span>{day.title}</h3>
          <ol className="mt-[8px] divide-y divide-line">
            {day.items.map((item, index) => <li key={index} className="flex gap-[10px] py-[10px] text-[13px]">
              <span className="mt-[1px] min-w-[28px] text-[12px] text-muted">{String(index + 1).padStart(2, '0')}</span>
              <div className="min-w-0 flex-1 break-words">
                <div className="flex flex-wrap items-center gap-x-[8px] gap-y-[4px]"><span className="font-[550]">{item.title}</span><span className="text-[11px] text-muted">{itemLabels[item.type]}</span>{item.type !== 'other' && item.pending && <span className="rounded-full bg-paper px-[8px] text-[11px] text-muted">地点待确认</span>}</div>
                {item.note && <p className="mt-[4px] whitespace-pre-wrap text-muted">{item.note}</p>}
                {item.poi ? <p className="mt-[4px] text-[12px] text-green">已定位 · {item.poi.name}{item.poi.address ? ' · ' + item.poi.address : ''}</p> : item.region && <p className="mt-[4px] text-[12px] text-muted">{item.region}</p>}
              </div>
            </li>)}
          </ol>
        </section>)}
      </div>
      {errorContent}
      {locked && error && <p className="mt-[8px] text-[12px] text-muted">可以安全重试，不会重复创建。标题将在创建后继续编辑。</p>}
      <div className="mt-[18px] flex flex-wrap items-center justify-between gap-[12px]">
        <p className="text-[12px] text-muted">确认后创建新行程，并进入工作台继续编辑。</p>
        <div className="flex flex-wrap gap-[10px]">
          <button type="button" disabled={phase === 'importing'} className={secondaryClass} onClick={discard}>放弃草稿</button>
          <button id="guide-import-confirm" type="submit" disabled={phase === 'importing'} className={primaryClass}>
            {phase === 'importing' && <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />}
            {phase === 'importing' ? '正在创建…' : error && locked ? '重试创建行程' : '确认创建行程'}
          </button>
        </div>
      </div>
    </form>
  )
}
