/**
 * AI chat API client (ticket 06) — the qa-round conversation loop.
 *
 * Same codec convention as src/domain/tripList.ts / workbench.ts: tolerant
 * reads that never throw, an injectable FetchLike for Node tests, and
 * `{ok:true,data} | {ok:false,error}` results the caller surfaces verbatim.
 *
 * ## SSE contract (mirrors server/src/chat/routes.ts)
 * POST /api/trips/:id/messages answers `text/event-stream` with
 * `start {round}` → `delta {text}…` → `done {userMessage, assistantMessage}`,
 * or an in-stream `error {code, message, guidance}` + `close {}` pair.
 * Stream errors are delivered to the caller through the
 * `onError(code, message, guidance)` callback (the spec's 用户故事 25 banner),
 * while transport-level failures resolve as `{ok:false,error}`.
 */

import type { ApiResult, FetchLike } from './tripList'
import { defaultFetch } from './tripList'

/** 'system' rows are the lightweight manual-edit notes from ticket 09. */
export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  tripId: string
  role: ChatRole
  content: string
  createdAt: string
}

export type ChatStreamError = {
  code: string
  message: string
  guidance: string
}

export type SendChatHandlers = {
  /** Called once when the stream opens (round type pinned server-side). */
  onStart?: (round: string) => void
  /** Called for every streamed text chunk. */
  onDelta?: (text: string) => void
  /** Called on an in-stream model/storage error (guidance for the banner). */
  onError?: (error: ChatStreamError) => void
}

export type SendChatResult =
  | { ok: true; userMessage: ChatMessage; assistantMessage: ChatMessage }
  | { ok: false; error: string }

export const CHAT_NETWORK_ERROR = '无法连接服务器，请确认后端服务已启动。'

function normalizeMessage(raw: unknown): ChatMessage | null {
  if (raw === null || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id === '') return null
  const role: ChatRole = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'
  return {
    id: m.id,
    tripId: typeof m.tripId === 'string' ? m.tripId : '',
    role,
    content: typeof m.content === 'string' ? m.content : '',
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
  }
}

/** GET /api/trips/:id/messages — persisted history for this trip (oldest first). */
export async function fetchChatHistory(
  tripId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ChatMessage[]>> {
  let response: Response
  try {
    response = await fetchLike(`/api/trips/${encodeURIComponent(tripId)}/messages`)
  } catch {
    return { ok: false, error: CHAT_NETWORK_ERROR }
  }
  if (!response.ok) {
    const message = ((await response.json().catch(() => null)) as { error?: unknown } | null)?.error
    return { ok: false, error: typeof message === 'string' && message ? message : `请求失败（HTTP ${response.status}）` }
  }
  const payload = (await response.json().catch(() => null)) as { messages?: unknown } | null
  if (!payload || !Array.isArray(payload.messages)) return { ok: false, error: '服务器返回的数据无法解析。' }
  return { ok: true, data: payload.messages.map(normalizeMessage).filter((m): m is ChatMessage => m !== null) }
}

/**
 * POST /api/trips/:id/messages — send one user message and consume the SSE
 * reply stream. Resolves after the stream ends; streamed tokens were already
 * delivered through `handlers.onDelta`.
 */
export async function sendChatMessage(
  tripId: string,
  content: string,
  handlers: SendChatHandlers = {},
  fetchLike: FetchLike = defaultFetch(),
): Promise<SendChatResult> {
  let response: Response
  try {
    response = await fetchLike(`/api/trips/${encodeURIComponent(tripId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch {
    return { ok: false, error: CHAT_NETWORK_ERROR }
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown; guidance?: unknown } | null
    const message = typeof payload?.error === 'string' && payload.error ? payload.error : `请求失败（HTTP ${response.status}）`
    if (payload && typeof payload.guidance === 'string' && payload.guidance) {
      handlers.onError?.({ code: 'http', message, guidance: payload.guidance })
    }
    return { ok: false, error: message }
  }

  const body = response.body
  if (!body) return { ok: false, error: '服务器没有返回对话流。' }

  // Read the SSE body, split it into `event:`/`data:` blocks, dispatch them.
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: SendChatResult = { ok: false, error: '对话流意外结束。' }
  let finished = false

  const dispatch = (block: string): void => {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
      else if (line.startsWith('data:')) data += line.slice('data:'.length).trim()
    }
    if (!data) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (event === 'start' && parsed !== null && typeof parsed === 'object') {
      handlers.onStart?.(typeof (parsed as { round?: unknown }).round === 'string' ? (parsed as { round: string }).round : 'qa')
      return
    }
    if (event === 'delta' && parsed !== null && typeof parsed === 'object') {
      const text = (parsed as { text?: unknown }).text
      if (typeof text === 'string' && text) handlers.onDelta?.(text)
      return
    }
    if (event === 'error' && parsed !== null && typeof parsed === 'object') {
      const e = parsed as Record<string, unknown>
      handlers.onError?.({
        code: typeof e.code === 'string' ? e.code : 'stream',
        message: typeof e.message === 'string' ? e.message : '对话流中断，回复可能不完整。',
        guidance: typeof e.guidance === 'string' ? e.guidance : '请重新发送消息重试。',
      })
      return
    }
    if (event === 'close') {
      finished = true
      return
    }
    if (event === 'done' && parsed !== null && typeof parsed === 'object') {
      const d = parsed as { userMessage?: unknown; assistantMessage?: unknown }
      const userMessage = normalizeMessage(d.userMessage)
      const assistantMessage = normalizeMessage(d.assistantMessage)
      if (userMessage && assistantMessage) {
        result = { ok: true, userMessage, assistantMessage }
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        dispatch(buffer.slice(0, separator))
        buffer = buffer.slice(separator + 2)
        separator = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim()) dispatch(buffer)
  } catch {
    if (!finished) return { ok: false, error: CHAT_NETWORK_ERROR }
  }

  return result
}
