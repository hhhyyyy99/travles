/**
 * 左栏 AI 对话 (tickets 06/07) — the chat loop against the backend planner
 * agent, now rendering the clarify-round protocol:
 *
 * - Framework/prose text renders as a small markdown subset (headings, bold,
 *   lists) with inline POI links; clicking a POI link calls `onFocusPoi` so
 *   the workbench focuses the map (placeholder logs it until ticket 05).
 * - Clarify rounds carry option chips (`meta.chips`); clicking a chip sends
 *   its `value` as the user's reply through the same SSE endpoint.
 * - "思考完成" (think) and "来源" (sources) collapsibles render on assistant
 *   messages when present, hidden otherwise; AI messages have a copy button.
 * - Ticket 08: plan rounds that write through apply_trip_patch surface an
 *   inline "已写入行程" summary card (expandable to the change counters);
 *   onAppliedPatch also calls `onTripPatched` so the workbench refetches
 *   /canvas and the three columns + map redraw live.
 * - History is loaded from GET /api/trips/:id/messages on mount (refresh-safe)
 *   and includes the persisted meta fields; sending POSTs
 *   /api/trips/:id/messages and renders the SSE reply incrementally
 *   (start → delta… → meta → done).
 * - Stream/HTTP errors surface as a banner with per-failure guidance
 *   (spec 用户故事 25); the history stays untouched.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, FileText, ListChecks, MessageCircle, PanelLeftClose, SendHorizontal } from 'lucide-react'
import {
  fetchChatHistory,
  sendChatMessage,
  type AppliedPatchRecord,
  type ChatMessage,
  type ChatMessageMeta,
  type ChatPoiLink,
  type ChatStreamError,
} from '../../domain/chat'
import { parseAssistantContent, type InlineSpan } from '../../domain/chatMarkdown'
import type {
  AiProposalState,
  ProposalKind,
  ProposalRequest,
  AiProposal,
} from '../../domain/aiProposals'

type SendState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'error'; error: ChatStreamError | string }

export default function ChatPanel({
  tripId,
  onCollapse,
  onFocusPoi,
  onTripPatched,
  proposalState,
  onRequestProposal,
  onApplyProposal,
  onCancelProposal,
  onRetryProposal,
}: {
  tripId: string
  onCollapse: () => void
  /** Clicking an inline POI link in an AI message (ticket 07, map linkage). */
  onFocusPoi?: (poi: ChatPoiLink) => void
  /**
   * Ticket 08: the plan round just wrote the trip — the workbench refetches
   * /canvas so the middle column and the map redraw live.
   */
  onTripPatched?: () => void
  /** Ticket 13: preview/apply/cancel controls for AI proposal flows. */
  proposalState?: AiProposalState
  onRequestProposal?: (request: ProposalRequest) => void
  onApplyProposal?: () => void
  onCancelProposal?: () => void
  onRetryProposal?: () => void
}) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sendState, setSendState] = useState<SendState>({ status: 'idle' })
  const [streamText, setStreamText] = useState<string | null>(null)
  const [streamMeta, setStreamMeta] = useState<ChatMessageMeta | null>(null)
  const [streamPatch, setStreamPatch] = useState<AppliedPatchRecord | null>(null)
  // Latest onTripPatched for the async send handler (avoid stale closures).
  const onTripPatchedRef = useRef(onTripPatched)
  onTripPatchedRef.current = onTripPatched
  const listRef = useRef<HTMLDivElement>(null)
  const scrollToEnd = () => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }

  useEffect(() => {
    let cancelled = false
    setHistory([])
    setLoadError(null)
    void fetchChatHistory(tripId).then((result) => {
      if (cancelled) return
      if (result.ok) setHistory(result.data)
      else setLoadError(result.error)
    })
    return () => {
      cancelled = true
    }
  }, [tripId])

  useEffect(scrollToEnd, [history, streamText])

  const sending = sendState.status === 'sending'

  async function handleSend(content: string) {
    const trimmed = content.trim()
    if (trimmed === '' || sending) return
    setInput('')
    setSendState({ status: 'sending' })
    setStreamText('')
    setStreamMeta(null)
    setStreamPatch(null)

    // Optimistic user bubble (id prefixed local-, replaced on done).
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      tripId,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    }
    setHistory((prev) => [...prev, optimistic])

    const result = await sendChatMessage(tripId, trimmed, {
      onDelta: (text) => setStreamText((prev) => (prev ?? '') + text),
      onMeta: (meta) => setStreamMeta((prev) => ({ ...(prev ?? {}), ...meta })),
      onAppliedPatch: (record) => {
        setStreamPatch(record)
        // The trip changed server-side — redraw the canvas + map live.
        onTripPatchedRef.current?.()
      },
      onError: (error) => setSendState({ status: 'error', error }),
    })

    if (result.ok) {
      setHistory((prev) => [
        ...prev.filter((m) => m.id !== optimistic.id),
        result.userMessage,
        result.assistantMessage,
      ])
      setSendState({ status: 'idle' })
    } else {
      setSendState((prev) =>
        prev.status === 'error' ? prev : { status: 'error', error: result.error },
      )
    }
    setStreamText(null)
    setStreamMeta(null)
    setStreamPatch(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-[8px] border-b border-line px-[14px] py-[10px] text-[13px] font-[550]">
        <MessageCircle aria-hidden="true" className="w-[15px] text-green" />
        圆周 AI
        <button
          type="button"
          data-action="collapse-ai"
          title="收起 AI 栏"
          aria-label="收起 AI 栏"
          onClick={onCollapse}
          className="ml-auto grid h-[28px] w-[28px] place-items-center rounded-[5px] border border-line text-muted hover:border-green hover:text-green transition-colors"
        >
          <PanelLeftClose aria-hidden="true" className="w-[14px]" />
        </button>
      </div>

      <div id="chat-list" ref={listRef} className="flex flex-1 flex-col gap-[10px] overflow-y-auto px-[12px] py-[12px]">
        {loadError !== null && (
          <p className="mx-auto my-[12px] text-center text-[13px] leading-[1.8] text-muted">{loadError}</p>
        )}
        {loadError === null && history.length === 0 && streamText === null && (
          <p className="mx-auto my-[12px] text-center text-[13px] leading-[1.8] text-muted">
            和圆周说一句话，一起规划这段旅程。
          </p>
        )}
        {history.map((message) => (
          <ChatBubble key={message.id} message={message} sending={sending} onSend={handleSend} onFocusPoi={onFocusPoi} />
        ))}
        {streamText !== null && (
          <ChatBubble
            message={{ id: 'streaming', tripId, role: 'assistant', content: streamText, createdAt: '' }}
            meta={streamMeta}
            appliedPatch={streamPatch}
            streaming
            sending={sending}
            onSend={handleSend}
            onFocusPoi={onFocusPoi}
          />
        )}
        {proposalState && proposalState.status !== 'idle' && (
          <ProposalReview
            state={proposalState}
            onApply={onApplyProposal}
            onCancel={onCancelProposal}
            onRetry={onRetryProposal}
          />
        )}
      </div>

      {sendState.status === 'error' && <ChatErrorBanner error={sendState.error} />}

      <form
        className="flex items-end gap-[8px] border-t border-line px-[12px] py-[10px]"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSend(input)
        }}
      >
        <textarea
          id="chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={sending ? '圆周正在回复…' : '询问行程、路况、住宿，或粘贴攻略…'}
          disabled={sending}
          aria-label="输入消息"
          rows={2}
          className="min-h-[34px] max-h-[88px] min-w-0 flex-1 resize-y rounded-[6px] border border-line bg-white px-[10px] py-[7px] text-[13px] leading-[1.5] outline-none placeholder:text-muted focus:border-green"
        />
        <div className="flex shrink-0 flex-col gap-[5px]">
          {onRequestProposal && (
            <button
              type="button"
              data-action="ai-parse"
              disabled={sending || proposalState?.status === 'loading' || input.trim() === ''}
              onClick={() => onRequestProposal({ kind: 'parse', text: input.trim() })}
              className="inline-flex h-[28px] items-center justify-center gap-[4px] rounded-[5px] border border-green/40 px-[7px] text-[11px] text-green transition-colors hover:bg-green hover:text-white disabled:opacity-40"
            >
              <FileText aria-hidden="true" className="w-[13px]" />
              智能解析
            </button>
          )}
          <button
            id="chat-send"
            type="submit"
            data-action="chat-send"
            disabled={sending || input.trim() === ''}
            aria-label="发送消息"
            className="grid h-[34px] w-[34px] self-end place-items-center rounded-[6px] bg-green text-white transition-opacity disabled:opacity-40"
          >
            <SendHorizontal aria-hidden="true" className="w-[15px]" />
          </button>
        </div>
      </form>
    </div>
  )
}

function ProposalReview({
  state,
  onApply,
  onCancel,
  onRetry,
}: {
  state: AiProposalState
  onApply?: () => void
  onCancel?: () => void
  onRetry?: () => void
}) {
  if (state.status === 'loading') {
    return (
      <div data-ai-proposal data-ai-proposal-status="loading" className="rounded-[8px] border border-green/30 bg-white px-[10px] py-[9px] text-[12px] text-muted">
        正在生成{proposalKindLabel(state.request.kind)}建议…
      </div>
    )
  }
  if (state.status === 'applied') {
    return (
      <div data-ai-proposal data-ai-proposal-status="applied" className="rounded-[8px] border border-green/30 bg-green/5 px-[10px] py-[9px] text-[12px]">
        <p className="font-[550] text-green">建议已应用</p>
        <p data-ai-proposal-applied className="mt-[3px] text-muted">{state.record.summary}</p>
      </div>
    )
  }
  const proposal = 'proposal' in state ? state.proposal : undefined
  if (state.status === 'error') {
    return (
      <div data-ai-proposal data-ai-proposal-status="error" className="rounded-[8px] border border-[#b75342]/40 bg-[#fdf3f1] px-[10px] py-[9px] text-[12px]">
        <p className="font-[550] text-[#b75342]">建议生成失败</p>
        <p data-ai-proposal-error className="mt-[3px] text-muted">{state.error}</p>
        <div className="mt-[7px] flex gap-[6px]">
          {onRetry && (
            <button type="button" data-ai-proposal-retry onClick={onRetry} className="rounded-[5px] bg-green px-[8px] py-[4px] text-[11px] text-white">
              重试
            </button>
          )}
          {onCancel && (
            <button type="button" data-ai-proposal-cancel onClick={onCancel} className="rounded-[5px] border border-line px-[8px] py-[4px] text-[11px] text-muted">
              取消
            </button>
          )}
        </div>
        {proposal && <ProposalSummary proposal={proposal} />}
      </div>
    )
  }
  if (!proposal) return null
  return (
    <div data-ai-proposal data-ai-proposal-status={state.status} data-ai-proposal-kind={proposal.kind} className="rounded-[8px] border border-green/35 bg-white px-[10px] py-[9px] text-[12px]">
      <div className="flex items-start gap-[7px]">
        <ListChecks aria-hidden="true" className="mt-[2px] w-[14px] shrink-0 text-green" />
        <div className="min-w-0 flex-1">
          <p data-ai-proposal-title className="font-[600] text-ink">{proposal.title}</p>
          <p data-ai-proposal-summary className="mt-[3px] leading-[1.65] text-muted">{proposal.summary}</p>
        </div>
      </div>
      <ProposalSummary proposal={proposal} />
      <div className="mt-[9px] flex gap-[6px]">
        {onApply && (
          <button type="button" data-ai-proposal-confirm onClick={onApply} disabled={state.status === 'applying'} className="rounded-[5px] bg-green px-[9px] py-[5px] text-[11px] text-white disabled:opacity-50">
            {state.status === 'applying' ? '应用中…' : '确认应用'}
          </button>
        )}
        {onCancel && (
          <button type="button" data-ai-proposal-cancel onClick={onCancel} disabled={state.status === 'applying'} className="rounded-[5px] border border-line px-[9px] py-[5px] text-[11px] text-muted disabled:opacity-50">
            取消
          </button>
        )}
      </div>
    </div>
  )
}

function ProposalSummary({ proposal }: { proposal: AiProposal }) {
  return (
    <div data-ai-proposal-diff className="mt-[7px] border-t border-line pt-[6px]">
      <p className="text-[11px] font-[550] text-muted">{proposalKindLabel(proposal.kind)} · {proposal.diff.length} 项变更</p>
      <ul className="mt-[3px] space-y-[2px] text-[11px] text-muted">
        {proposal.diff.slice(0, 8).map((change, index) => (
          <li key={`${change.action}-${change.label}-${index}`} data-ai-proposal-change>
            <span className="text-green">{change.label}</span>
            {change.detail && <span> · {change.detail}</span>}
          </li>
        ))}
      </ul>
      {proposal.items && proposal.items.length > 0 && (
        <p data-ai-proposal-items className="mt-[5px] text-[11px] text-muted">解析出 {proposal.items.length} 个行程项，确认后写入画布。</p>
      )}
    </div>
  )
}

function proposalKindLabel(kind: ProposalKind): string {
  return kind === 'parse' ? '智能解析' : kind === 'day-optimize' ? '天级优化' : '路线优化'
}

function ChatBubble({
  message,
  meta,
  appliedPatch,
  streaming = false,
  sending = false,
  onSend,
  onFocusPoi,
}: {
  message: ChatMessage
  meta?: ChatMessageMeta | null
  /** Live applied-patch record while streaming (persisted one comes via message.appliedPatch). */
  appliedPatch?: AppliedPatchRecord | null
  streaming?: boolean
  sending?: boolean
  onSend: (content: string) => void
  onFocusPoi?: (poi: ChatPoiLink) => void
}) {
  // Ticket 09: manual-edit system notes render as muted center lines — they
  // keep the thread aware of the latest itinerary without mimicking a turn.
  if (message.role === 'system') {
    return (
      <p
        data-chat-message
        data-chat-role="system"
        className="mx-auto max-w-[92%] text-center text-[11px] leading-[1.7] text-muted"
      >
        {message.content}
      </p>
    )
  }
  const isUser = message.role === 'user'
  const roundMeta = meta ?? message.meta ?? null
  const poiLinks = roundMeta?.poiLinks ?? []
  const chips = roundMeta?.chips ?? []
  const think = message.think ?? roundMeta?.think ?? null
  const sources = message.sources ?? roundMeta?.sources ?? null
  const patch = appliedPatch ?? message.appliedPatch ?? null

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          data-chat-message
          data-chat-role={message.role}
          className="max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-green px-[11px] py-[7px] text-[13px] leading-[1.7] text-white"
        >
          {message.content}
        </div>
      </div>
    )
  }

  const blocks = parseAssistantContent(message.content, poiLinks)
  const renderSpans = (spans: InlineSpan[]) => spans.map((span, index) => renderSpan(span, index, onFocusPoi))
  return (
    <div className="flex justify-start">
      <div
        data-chat-message
        data-chat-role={message.role}
        {...(roundMeta?.round ? { 'data-chat-round': roundMeta.round } : {})}
        {...(streaming ? { 'data-chat-streaming': 'true' } : {})}
        className="flex max-w-[85%] flex-col gap-[6px] rounded-[10px] rounded-bl-[3px] border border-line bg-paper px-[11px] py-[7px] text-[13px] leading-[1.7] text-ink"
      >
        {think !== null && !streaming && <ThinkSection think={think} complete={roundMeta?.thinkComplete ?? true} />}
        <div className="whitespace-pre-wrap">
          {blocks.length === 0 && streaming ? <span className="text-muted">思考中…</span> : blocks.map((block, index) => renderBlock(block, index, renderSpans))}
        </div>
        {chips.length > 0 && (
          <div data-chat-chips className="flex flex-wrap gap-[6px]">
            {chips.map((chip) => (
              <button
                key={`${chip.label}:${chip.value}`}
                type="button"
                data-chat-chip={chip.value}
                disabled={sending}
                onClick={() => onSend(chip.value)}
                className="rounded-full border border-green/40 bg-white px-[10px] py-[3px] text-[12px] text-green transition-colors hover:bg-green hover:text-white disabled:opacity-40"
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
        {patch !== null && <AppliedPatchCard record={patch} />}
        {sources !== null && sources.length > 0 && <SourcesSection sources={sources} />}
        {!streaming && <CopyButton content={message.content} />}
      </div>
    </div>
  )
}

/**
 * "已写入行程" 摘要卡（ticket 08）—— renders after the plan round applied a
 * TripPatch; expandable to the coarse change counters. The workbench has
 * already refetched /canvas by the time this renders.
 */
function AppliedPatchCard({ record }: { record: AppliedPatchRecord }) {
  const stats = record.stats ?? {}
  const statEntries: [string, number | undefined][] = [
    ['新增天', stats.daysAdded],
    ['更新天', stats.daysUpdated],
    ['删除天', stats.daysRemoved],
    ['新增卡片', stats.itemsAdded],
    ['更新卡片', stats.itemsUpdated],
    ['删除卡片', stats.itemsRemoved],
    ['交通段', stats.legsWritten],
  ]
  const useful = statEntries.filter(([, value]) => typeof value === 'number' && value !== 0)
  return (
    <details data-chat-applied-patch className="rounded-[6px] border border-green/30 bg-white/70 px-[8px] py-[5px] text-[12px]">
      <summary className="flex cursor-pointer select-none items-center gap-[5px] font-[550] text-green">
        <ListChecks aria-hidden="true" className="w-[13px]" />
        已写入行程
      </summary>
      <p className="mt-[4px] text-muted">{record.summary}</p>
      {useful.length > 0 && (
        <p className="mt-[2px] text-muted">
          {useful.map(([label, value]) => `${label} ${value}`).join(' · ')}
        </p>
      )}
    </details>
  )
}

function renderBlock(
  block: ReturnType<typeof parseAssistantContent>[number],
  index: number,
  renderSpans: (spans: InlineSpan[]) => ReactNode[],
) {
  if (block.kind === 'heading') {
    const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5'
    return (
      <Tag key={index} className="font-[600]">
        {renderSpans(block.spans)}
      </Tag>
    )
  }
  if (block.kind === 'list-item') {
    return (
      <div key={index} className="flex gap-[6px] pl-[2px]">
        <span className="shrink-0 text-muted">{block.marker}</span>
        <span>{renderSpans(block.spans)}</span>
      </div>
    )
  }
  return <p key={index}>{renderSpans(block.spans)}</p>
}

function renderSpan(span: InlineSpan, index: number, onFocusPoi?: (poi: ChatPoiLink) => void) {
  if (span.kind === 'bold') {
    return (
      <strong key={index} className="font-[600]">
        {span.text}
      </strong>
    )
  }
  if (span.kind === 'poi') {
    return (
      <button
        key={index}
        type="button"
        data-chat-poi-link={span.poi.name}
        title="在地图上查看"
        onClick={() => onFocusPoi?.(span.poi)}
        className="text-green underline decoration-green/40 underline-offset-[2px] transition-colors hover:decoration-green"
      >
        {span.text}
      </button>
    )
  }
  return <span key={index}>{span.text}</span>
}

/** "思考完成" 折叠推理段 (spec 用户故事 17); hidden when absent. */
function ThinkSection({ think, complete }: { think: string; complete: boolean }) {
  return (
    <details data-chat-think className="rounded-[6px] bg-white/60 px-[8px] py-[5px] text-[12px] text-muted">
      <summary className="cursor-pointer select-none font-[550] text-ink">
        思考完成{complete ? '' : '（部分）'}
      </summary>
      <p className="mt-[4px] whitespace-pre-wrap leading-[1.7]">{think}</p>
    </details>
  )
}

/** "来源" 折叠引用列表 (spec 用户故事 17); hidden when absent. */
function SourcesSection({ sources }: { sources: NonNullable<ChatMessage['sources']> }) {
  return (
    <details data-chat-sources className="rounded-[6px] bg-white/60 px-[8px] py-[5px] text-[12px]">
      <summary className="cursor-pointer select-none font-[550] text-ink">来源 · {sources.length}</summary>
      <ul className="mt-[4px] space-y-[2px]">
        {sources.map((source) => (
          <li key={source.url}>
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="text-green underline decoration-green/40 underline-offset-[2px]"
            >
              {source.title}
            </a>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** "复制" 按钮 (PRD AI 对话栏) — copies the raw markdown text. */
function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard unavailable (permissions/insecure context) — nothing to do.
    }
  }
  return (
    <button
      type="button"
      data-action="chat-copy"
      title="复制内容"
      aria-label="复制内容"
      onClick={() => void copy()}
      className={`flex items-center gap-[3px] self-start text-[11px] transition-colors ${
        copied ? 'text-green' : 'text-muted hover:text-green'
      }`}
    >
      {copied ? <Check aria-hidden="true" className="w-[12px]" /> : <Copy aria-hidden="true" className="w-[12px]" />}
      {copied ? '已复制' : '复制'}
    </button>
  )
}

/** spec 用户故事 25: 明确的错误说明 + 该去检查什么的指引。 */
function ChatErrorBanner({ error }: { error: ChatStreamError | string }) {
  const message = typeof error === 'string' ? error : error.message
  const guidance = typeof error === 'string' ? '请稍后重试；若持续失败请检查模型服务配置。' : error.guidance
  return (
    <div
      id="chat-error"
      data-chat-error={typeof error === 'string' ? undefined : error.code}
      role="alert"
      className="mx-[12px] mb-[6px] rounded-[6px] border border-red/40 bg-red/5 px-[10px] py-[8px] text-[12px] leading-[1.7] text-red"
    >
      <p className="font-[550]">{message}</p>
      <p className="mt-[2px] text-muted">{guidance}</p>
    </div>
  )
}
