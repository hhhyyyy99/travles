/**
 * AI chat API client (tickets 06/07/08) — the conversation loop over the
 * four-round protocol (qa baseline + clarify rounds + plan round).
 *
 * Same codec convention as src/domain/tripList.ts / workbench.ts: tolerant
 * reads that never throw, an injectable FetchLike for Node tests, and
 * `{ok:true,data} | {ok:false,error}` results the caller surfaces verbatim.
 *
 * ## SSE contract (mirrors server/src/chat/routes.ts)
 * POST /api/trips/:id/messages answers `text/event-stream` with
 * `start {round}` → `delta {text}…` → `meta` (ticket 07, optional — the
 * round's structured payload: chips, poiLinks, think, thinkComplete,
 * sources) → `applied_patch` (ticket 08, optional — the TripPatch the plan
 * round wrote: summary, stats, patch) → `done {userMessage, assistantMessage}`,
 * or an in-stream `error {code, message, guidance}` + `close {}` pair.
 * Unknown events are ignored (forward compatibility with ticket 11), so the
 * parser skips anything it does not recognize. Stream errors are delivered
 * to the caller through the `onError(code, message, guidance)` callback (the
 * spec's 用户故事 25 banner), while transport-level failures resolve as
 * `{ok:false,error}`.
 */

import type { ApiResult, FetchLike } from './tripList'
import { defaultFetch } from './tripList'

/** 'system' rows are the lightweight manual-edit notes from ticket 09. */
export type ChatRole = 'user' | 'assistant' | 'system'

/** One clickable clarify option chip (clicking sends `value` as the reply). */
export type ChatOptionChip = {
  label: string
  value: string
}

/** A place the AI mentioned; clicking focuses the map on it. */
export type ChatPoiLink = {
  name: string
  lat: number
  lng: number
  amapId?: string
}

/** One citation for the 来源 collapsible. */
export type ChatSource = {
  title: string
  url: string
}

export type ChatRoundWarning = {
  kind: 'time-conflict' | 'long-drive'
  title: string
  message: string
  suggestion?: string
  from?: string
  to?: string
  durationMin?: number
  /** True when a warning is based on coordinates rather than a verified route. */
  estimated?: boolean
}

/**
 * Structured round metadata (ticket 07) — the `meta` SSE event payload and
 * the persisted `meta` field of an assistant message. `round` mirrors the
 * protocol round type (PRD 附录 B): `clarify` | `qa` | `plan` |
 * `patch-explain`; `chips` drive the clarify option chips, `poiLinks` the
 * inline POI links, `think`/`thinkComplete` the 思考完成 collapsible and
 * `sources` the 来源 collapsible (both hidden when absent).
 */
export type ChatMessageMeta = {
  round?: string
  chips?: ChatOptionChip[]
  poiLinks?: ChatPoiLink[]
  think?: string
  thinkComplete?: boolean
  sources?: ChatSource[]
  impacts?: string[]
  conflicts?: string[]
  compromises?: string[]
  warnings?: ChatRoundWarning[]
}

/**
 * Structured record of a successful `apply_trip_patch` (ticket 08) — the
 * `applied_patch` SSE event payload and the persisted `appliedPatch` field
 * of an assistant message. `summary` is the human-readable one-liner,
 * `stats` the coarse change counters, `patch` the raw applied TripPatch
 * (kept opaque here — the server owns its schema).
 */
export type AppliedPatchStats = {
  daysAdded?: number
  daysUpdated?: number
  daysRemoved?: number
  itemsAdded?: number
  itemsUpdated?: number
  itemsRemoved?: number
  legsWritten?: number
}

export type AppliedPatchRecord = {
  summary: string
  stats?: AppliedPatchStats
  patch?: unknown
}

export type ChatMessage = {
  id: string
  tripId: string
  role: ChatRole
  content: string
  createdAt: string
  /** Assistant messages: reasoning summary for the 思考完成 collapsible. */
  think?: string | null
  /** Assistant messages: parsed citations for the 来源 collapsible. */
  sources?: ChatSource[] | null
  /** Assistant messages: parsed round metadata (round, chips, poiLinks). */
  meta?: ChatMessageMeta | null
  /** Assistant messages: the applied TripPatch record (plan round, ticket 08). */
  appliedPatch?: AppliedPatchRecord | null
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
  /** Called (ticket 07) when the round's structured metadata arrives. */
  onMeta?: (meta: ChatMessageMeta) => void
  /** Called (ticket 08) when the plan round wrote the trip successfully. */
  onAppliedPatch?: (record: AppliedPatchRecord) => void
  /** Called on an in-stream model/storage error (guidance for the banner). */
  onError?: (error: ChatStreamError) => void
}

export type SendChatResult =
  | { ok: true; userMessage: ChatMessage; assistantMessage: ChatMessage }
  | { ok: false; error: string }

export const CHAT_NETWORK_ERROR = '无法连接服务器，请确认后端服务已启动。'

/** Tolerant normalizer for the meta payload; null unless a round is present. */
export function normalizeChatMeta(raw: unknown): ChatMessageMeta | null {
  if (raw === null || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const round = typeof m.round === 'string' && m.round ? m.round : null
  if (round === null) return null
  const chips: ChatOptionChip[] = []
  if (Array.isArray(m.chips)) {
    for (const entry of m.chips) {
      if (entry === null || typeof entry !== 'object') continue
      const label = (entry as { label?: unknown }).label
      const value = (entry as { value?: unknown }).value
      if (typeof label === 'string' && label && typeof value === 'string' && value) {
        chips.push({ label, value })
      }
    }
  }
  const poiLinks: ChatPoiLink[] = []
  if (Array.isArray(m.poiLinks)) {
    for (const entry of m.poiLinks) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as { name?: unknown; lat?: unknown; lng?: unknown; amapId?: unknown }
      if (
        typeof e.name === 'string' &&
        e.name &&
        typeof e.lat === 'number' &&
        Number.isFinite(e.lat) &&
        typeof e.lng === 'number' &&
        Number.isFinite(e.lng)
      ) {
        poiLinks.push({
          name: e.name,
          lat: e.lat,
          lng: e.lng,
          ...(typeof e.amapId === 'string' && e.amapId ? { amapId: e.amapId } : {}),
        })
      }
    }
  }
  const sources = normalizeSources(m.sources)
  const readTextList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : []
  const warnings: ChatRoundWarning[] = []
  if (Array.isArray(m.warnings)) {
    for (const entry of m.warnings) {
      if (entry === null || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      const kind = item.kind
      const title = item.title
      const message = item.message
      if (
        (kind === 'time-conflict' || kind === 'long-drive') &&
        typeof title === 'string' &&
        title &&
        typeof message === 'string' &&
        message
      ) {
        warnings.push({
          kind,
          title,
          message,
          ...(typeof item.suggestion === 'string' && item.suggestion ? { suggestion: item.suggestion } : {}),
          ...(typeof item.from === 'string' && item.from ? { from: item.from } : {}),
          ...(typeof item.to === 'string' && item.to ? { to: item.to } : {}),
          ...(typeof item.durationMin === 'number' && Number.isFinite(item.durationMin) ? { durationMin: item.durationMin } : {}),
          ...(item.estimated === true ? { estimated: true } : {}),
        })
      }
    }
  }
  return {
    round,
    ...(chips.length > 0 ? { chips } : {}),
    ...(poiLinks.length > 0 ? { poiLinks } : {}),
    ...(typeof m.think === 'string' && m.think ? { think: m.think } : {}),
    ...(typeof m.thinkComplete === 'boolean' ? { thinkComplete: m.thinkComplete } : {}),
    ...(sources !== null ? { sources } : {}),
    ...(readTextList(m.impacts).length > 0 ? { impacts: readTextList(m.impacts) } : {}),
    ...(readTextList(m.conflicts).length > 0 ? { conflicts: readTextList(m.conflicts) } : {}),
    ...(readTextList(m.compromises).length > 0 ? { compromises: readTextList(m.compromises) } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** Tolerant normalizer for the applied-patch record; null unless a summary survives. */
export function normalizeAppliedPatch(raw: unknown): AppliedPatchRecord | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const summary = typeof record.summary === 'string' && record.summary ? record.summary : null
  if (summary === null) return null
  const rawStats = record.stats
  const stats: AppliedPatchStats = {}
  if (rawStats !== null && typeof rawStats === 'object') {
    for (const key of Object.keys(AppliedPatchStatKeys) as (keyof AppliedPatchStats)[]) {
      const value = (rawStats as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value)) stats[key] = value
    }
  }
  return {
    summary,
    ...(Object.keys(stats).length > 0 ? { stats } : {}),
    ...(record.patch !== undefined ? { patch: record.patch } : {}),
  }
}

/** Keys accepted in the stats block (tolerant: unknown keys are dropped). */
const AppliedPatchStatKeys = {
  daysAdded: true,
  daysUpdated: true,
  daysRemoved: true,
  itemsAdded: true,
  itemsUpdated: true,
  itemsRemoved: true,
  legsWritten: true,
} as const

function normalizeSources(raw: unknown): ChatSource[] | null {
  if (!Array.isArray(raw)) return null
  const sources: ChatSource[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const title = (entry as { title?: unknown }).title
    const url = (entry as { url?: unknown }).url
    if (typeof title === 'string' && title && typeof url === 'string' && url) {
      sources.push({ title, url })
    }
  }
  return sources.length > 0 ? sources : null
}

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
    ...(role === 'assistant'
      ? {
          think: typeof m.think === 'string' && m.think ? m.think : null,
          sources: normalizeSources(m.sources),
          meta: normalizeChatMeta(m.meta),
          appliedPatch: normalizeAppliedPatch(m.appliedPatch),
        }
      : {}),
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
    if (event === 'meta' && parsed !== null && typeof parsed === 'object') {
      // Ticket 07: structured round metadata (round/chips/poiLinks/think/
      // sources). Malformed payloads are ignored, not fatal.
      const meta = normalizeChatMeta(parsed)
      if (meta) handlers.onMeta?.(meta)
      return
    }
    if (event === 'applied_patch' && parsed !== null && typeof parsed === 'object') {
      // Ticket 08: the plan round wrote the trip — the client shows a summary
      // card and refetches /canvas. Malformed payloads are ignored, not fatal.
      const record = normalizeAppliedPatch(parsed)
      if (record) handlers.onAppliedPatch?.(record)
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
