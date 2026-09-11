/**
 * Chat routes (ticket 06) — the minimal qa-round conversation loop over SSE.
 *
 * ## HTTP surface
 * - `GET /api/trips/:id/messages` → `{ messages: ChatMessage[] }` (oldest
 *   first; user + assistant rows only).
 * - `POST /api/trips/:id/messages` body `{ content: string }` → SSE stream
 *   (text/event-stream).
 *
 * ## SSE event schema (ticket 06; tickets 07/08 extend it)
 * Every event is `event: <name>\ndata: <JSON>\n\n`. Order for a successful
 * qa round:
 *
 * 1. `start`  → `{ "round": "qa" }`
 *    Stream opened, agent run accepted. `round` is the protocol round type
 *    (only `qa` in this ticket).
 * 2. `delta`  → `{ "text": "<chunk>" }`   (0..n events, agent tokens as they
 *    arrive; the frontend appends them to the streaming assistant bubble)
 * 3. `done`   → `{ "userMessage": ChatMessage, "assistantMessage": ChatMessage }`
 *    Terminal. Both messages are persisted (messages table, keyed by trip)
 *    and echoed back with their server-side ids/createdAt so the client can
 *    replace its optimistic bubbles.
 *
 * Error paths:
 * - Before the stream: JSON errors (not SSE) — 400 invalid body, 404 unknown
 *   trip, 503 no model configured (`{ error, guidance }`).
 * - In-stream: `error` event → `{ "code": ..., "message": ..., "guidance": ... }`
 *   followed by `event: close` → `{}`. Codes: `model_auth` (401/403 from the
 *   provider), `model_unavailable` (network/5xx), `stream` (anything else).
 *   Spec 用户故事 25: the guidance tells the user what to check (settings
 *   page arrives with ticket 12).
 *
 * ## Agent memory
 * One memory thread per trip (`thread: trip-<tripId>`, `resource: <tripId>`);
 * with the default wiring the thread lives in the same SQLite database as
 * everything else (see createMastra). Mastra saves the turn into memory; the
 * messages table stays the app-owned display history.
 */
import { streamSSE } from 'hono/streaming'
import type { Hono } from 'hono'
import type { Agent } from '@mastra/core/agent'
import type { TripRepository } from '../trips/repository.js'
import type { TripSummary } from '../trips/types.js'
import { ChatMessageRepository } from './repository.js'
import type { AppEnv } from '../app.js'
import { readJsonBody } from '../http/body.js'

export type ChatRouteOptions = {
  tripRepository: TripRepository
  messages: ChatMessageRepository
  planner: Agent
  /** False when no model is configured (no injection and no AI_* env). */
  modelConfigured: boolean
  /** False when the agent runs without memory (pure injected test setups). */
  memoryConfigured: boolean
}

export function registerChatRoutes(app: Hono<AppEnv>, options: ChatRouteOptions): void {
  const { tripRepository, messages, planner } = options

  const requireTrip = async (id: string): Promise<TripSummary | null> => tripRepository.get(id)

  app.get('/api/trips/:id/messages', async (c) => {
    const trip = await requireTrip(c.req.param('id'))
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    const history = await messages.listByTrip(c.req.param('id'))
    return c.json({ messages: history })
  })

  app.post('/api/trips/:id/messages', async (c) => {
    const trip = await requireTrip(c.req.param('id'))
    if (trip === null) return c.json({ error: '行程不存在' }, 404)

    if (!options.modelConfigured) {
      return c.json(
        {
          error: '模型服务未配置，无法开始对话。',
          guidance: '请先在环境变量中配置 AI_BASE_URL / AI_API_KEY / AI_MODEL（设置页即将到来）。',
        },
        503,
      )
    }

    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const content = body.content
    if (typeof content !== 'string' || content.trim() === '') {
      return c.json({ error: '消息内容不能为空' }, 400)
    }

    // Start the agent run before committing to SSE so failures at run
    // construction can still fall back to a plain HTTP error.
    let output: Awaited<ReturnType<typeof planner.stream>>
    try {
      output = await planner.stream(content, {
        ...(options.memoryConfigured
          ? { memory: { thread: `trip-${trip.id}`, resource: trip.id } }
          : {}),
      })
    } catch {
      return c.json(
        {
          error: '无法启动与模型的对话流。',
          guidance: '请检查模型服务配置后重试。',
        },
        502,
      )
    }

    const tripId = trip.id
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'start', data: JSON.stringify({ round: 'qa' }) })
      let full = ''
      let failed = false
      try {
        for await (const delta of output.textStream) {
          if (typeof delta !== 'string' || delta === '') continue
          full += delta
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: delta }) })
        }
      } catch (error) {
        failed = true
        await stream.writeSSE({ event: 'error', data: JSON.stringify(classifyModelError(error)) })
      }
      // Mastra's loop does not always throw model failures out of the text
      // stream — it records them on the run output instead. Treat a recorded
      // error the same as a thrown one (and never persist a failed turn).
      if (!failed && output.error) {
        failed = true
        await stream.writeSSE({ event: 'error', data: JSON.stringify(classifyModelError(output.error)) })
      }
      if (failed) {
        await stream.writeSSE({ event: 'close', data: '{}' })
        return
      }

      const userSaved = await messages.append(tripId, 'user', content)
      const assistantSaved = await messages.append(tripId, 'assistant', full)
      if (!userSaved.ok || !assistantSaved.ok) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            code: 'storage',
            message: '消息保存失败。',
            guidance: '请稍后刷新重试；对话内容可能未完整保存。',
          }),
        })
        await stream.writeSSE({ event: 'close', data: '{}' })
        return
      }

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ userMessage: userSaved.message, assistantMessage: assistantSaved.message }),
      })
    })
  })
}

/** Map a model-stream failure to an SSE error payload (spec 用户故事 25). */
export function classifyModelError(error: unknown): {
  code: string
  message: string
  guidance: string
} {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const status =
    error !== null && typeof error === 'object'
      ? ((error as { statusCode?: unknown; status?: unknown }).statusCode ??
        (error as { status?: unknown }).status)
      : undefined
  const numericStatus = typeof status === 'number' ? status : Number.NaN

  if (numericStatus === 401 || numericStatus === 403 || /\b40[13]\b|unauthorized|api key|鉴权/i.test(raw)) {
    return {
      code: 'model_auth',
      message: '模型服务鉴权失败，请检查 API Key 是否正确。',
      guidance: '请到设置中核对 API Key 与模型服务地址；确认后重新发送消息。',
    }
  }
  if (Number.isFinite(numericStatus) && numericStatus >= 500) {
    return {
      code: 'model_unavailable',
      message: `模型服务暂时不可用（HTTP ${numericStatus}）。`,
      guidance: '服务可能正在维护，请稍后重试；若持续失败请检查模型服务地址。',
    }
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(raw)) {
    return {
      code: 'model_unavailable',
      message: '无法连接模型服务，请检查网络或服务地址。',
      guidance: '请确认 AI_BASE_URL 指向的服务可达后重试。',
    }
  }
  return {
    code: 'stream',
    message: '对话流中断，回复可能不完整。',
    guidance: '请重新发送消息重试；若持续失败请检查模型服务配置。',
  }
}
