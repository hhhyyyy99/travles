/**
 * 左栏 AI 对话 (ticket 06) — the qa-round chat loop against the backend
 * planner agent.
 *
 * - History is loaded from GET /api/trips/:id/messages on mount (refresh-safe).
 * - Sending POSTs /api/trips/:id/messages and renders the SSE reply
 *   incrementally (start → delta… → done); the optimistic bubbles are
 *   replaced by the persisted server messages when the stream completes.
 * - Stream/HTTP errors surface as a banner with per-failure guidance
 *   (spec 用户故事 25); the history stays untouched.
 *
 * Message styling follows the PRD's AI 对话栏: user messages right-aligned,
 * AI messages left-aligned. Richer rounds (clarify chips, TripPatch cards,
 * markdown) arrive with tickets 07/08.
 */
import { useEffect, useRef, useState } from 'react'
import { MessageCircle, PanelLeftClose, SendHorizontal } from 'lucide-react'
import { fetchChatHistory, sendChatMessage, type ChatMessage, type ChatStreamError } from '../../domain/chat'

type SendState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'error'; error: ChatStreamError | string }

export default function ChatPanel({ tripId, onCollapse }: { tripId: string; onCollapse: () => void }) {
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sendState, setSendState] = useState<SendState>({ status: 'idle' })
  const [streamText, setStreamText] = useState<string | null>(null)
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

  async function handleSend() {
    const content = input.trim()
    if (content === '' || sending) return
    setInput('')
    setSendState({ status: 'sending' })
    setStreamText('')

    // Optimistic user bubble (id prefixed local-, replaced on done).
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      tripId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    }
    setHistory((prev) => [...prev, optimistic])

    const result = await sendChatMessage(tripId, content, {
      onDelta: (text) => setStreamText((prev) => (prev ?? '') + text),
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
          <ChatBubble key={message.id} message={message} />
        ))}
        {streamText !== null && (
          <ChatBubble
            message={{ id: 'streaming', tripId, role: 'assistant', content: streamText, createdAt: '' }}
            streaming
          />
        )}
      </div>

      {sendState.status === 'error' && <ChatErrorBanner error={sendState.error} />}

      <form
        className="flex items-end gap-[8px] border-t border-line px-[12px] py-[10px]"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSend()
        }}
      >
        <input
          id="chat-input"
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={sending ? '圆周正在回复…' : '询问行程、路况、住宿…'}
          disabled={sending}
          aria-label="输入消息"
          className="h-[34px] min-w-0 flex-1 rounded-[6px] border border-line bg-white px-[10px] text-[13px] outline-none placeholder:text-muted focus:border-green"
        />
        <button
          id="chat-send"
          type="submit"
          data-action="chat-send"
          disabled={sending || input.trim() === ''}
          aria-label="发送消息"
          className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[6px] bg-green text-white transition-opacity disabled:opacity-40"
        >
          <SendHorizontal aria-hidden="true" className="w-[15px]" />
        </button>
      </form>
    </div>
  )
}

function ChatBubble({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        data-chat-message
        data-chat-role={message.role}
        {...(streaming ? { 'data-chat-streaming': 'true' } : {})}
        className={
          isUser
            ? 'max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-br-[3px] bg-green px-[11px] py-[7px] text-[13px] leading-[1.7] text-white'
            : 'max-w-[85%] whitespace-pre-wrap rounded-[10px] rounded-bl-[3px] border border-line bg-paper px-[11px] py-[7px] text-[13px] leading-[1.7] text-ink'
        }
      >
        {message.content === '' && streaming ? <span className="text-muted">思考中…</span> : message.content}
      </div>
    </div>
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
