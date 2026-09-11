/**
 * Chat routes (tickets 06/07) — the SSE conversation loop over the four-round
 * protocol (qa baseline; clarify rounds arrive with ticket 07's
 * `emit_round_meta` tool; plan / patch-explain land with tickets 08/11).
 *
 * ## HTTP surface
 * - `GET /api/trips/:id/messages` → `{ messages: ChatMessage[] }` (oldest
 *   first; user + assistant rows only).
 * - `POST /api/trips/:id/messages` body `{ content: string }` → SSE stream
 *   (text/event-stream).
 *
 * ## SSE event schema (ticket 06 + ticket 07 extensions)
 * Every event is `event: <name>\ndata: <JSON>\n\n`. Order for a successful
 * round:
 *
 * 1. `start`  → `{ "round": "<round>" }`
 *    Stream opened, agent run accepted. `round` is the protocol round type
 *    (PRD 附录 B): `"qa"` for plain Q&A, `"clarify"` for a clarify round
 *    (framework first, then one key-variable question with option chips),
 *    `"plan"` / `"patch-explain"` reserved for tickets 08/11. The round is
 *    read from the turn's `emit_round_meta` tool call when that lands before
 *    the first text delta (the instructed pattern); otherwise it defaults to
 *    `"qa"` — the `meta` event below remains the authoritative statement.
 * 2. `delta`  → `{ "text": "<chunk>" }`   (0..n events, agent tokens as they
 *    arrive; the frontend appends them to the streaming assistant bubble)
 * 3. `meta`   → `RoundMetaPayload` (ticket 07, optional — present iff the
 *    model called `emit_round_meta` this turn):
 *
 *        {
 *          "round": "clarify" | "qa" | "plan" | "patch-explain",
 *          "chips"?:    [{ "label": "🚗 自驾/租车自驾", "value": "自驾出行" }, …],
 *          "poiLinks"?: [{ "name": "莫尔格勒河", "lat": 49.4, "lng": 119.7, "amapId"?: "B0…" }, …],
 *          "think"?:    "<reasoning summary for the 思考完成 collapsible>",
 *          "thinkComplete"?: true,
 *          "sources"?:  [{ "title": "…", "url": "…" }, …]
 *        }
 *
 *    Emitted after the deltas, just before `done`. `chips` drive the clarify
 *    option chips (clicking a chip sends `value` as the user's next reply),
 *    `poiLinks` the inline POI links (click → map focus), `think`/`sources`
 *    the collapsible sections (hidden when absent).
 * 4. `done`   → `{ "userMessage": ChatMessage, "assistantMessage": ChatMessage }`
 *    Terminal. Both messages are persisted (messages table, keyed by trip)
 *    and echoed back with their server-side ids/createdAt so the client can
 *    replace its optimistic bubbles. On ticket 07 the assistant message also
 *    carries `think` / `sources` / `meta` (the same RoundMetaPayload), so a
 *    reload restores chips, POI links and collapsibles from history.
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
 * ## Round-metadata emission (tool call, ticket 07)
 * The model is instructed to call the `emit_round_meta` tool once per turn,
 * before writing prose. The route consumes the agent's full stream:
 * `tool-call` chunks (name `emit_round_meta`) decide the `start` round;
 * `tool-result` chunks carry the validated `RoundMetaPayload` echoed in the
 * `meta` event and persisted on the assistant row. This is the same pattern
 * ticket 08's `apply_trip_patch` will build on.
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
import type { RoundMetaPayload } from './round-meta.js'
import { readRoundFromToolArgs } from './round-meta.js'

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
        // Ticket 07: the instructed pattern is tool call first, prose after;
        // allow the loop to come back to the model after the tool executes.
        maxSteps: 5,
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
      let full = ''
      let failed = false
      let streamError: unknown = null
      let started = false
      let round: string | null = null
      // Last validated payload from the turn's emit_round_meta tool result.
      let meta: RoundMetaPayload | null = null

      const writeStart = async (): Promise<void> => {
        started = true
        await stream.writeSSE({ event: 'start', data: JSON.stringify({ round: round ?? 'qa' }) })
      }

      try {
        for await (const chunk of output.fullStream) {
          const type = (chunk as { type?: unknown }).type
          if (type === 'text-delta') {
            const text = (chunk as { payload?: { text?: unknown } }).payload?.text
            if (typeof text !== 'string' || text === '') continue
            if (!started) await writeStart()
            full += text
            await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text }) })
            continue
          }
          if (type === 'tool-call') {
            const payload = (chunk as { payload?: { toolName?: unknown; args?: unknown } }).payload
            if (payload?.toolName !== 'emit_round_meta') continue
            // The instructed pattern puts the tool call before the prose, so
            // the round type can still pin the start event here.
            if (!round && !started) {
              round = readRoundFromToolArgs(payload.args)
            }
            continue
          }
          if (type === 'tool-result') {
            const payload = (chunk as { payload?: { toolName?: unknown; result?: unknown } }).payload
            if (payload?.toolName !== 'emit_round_meta') continue
            const result = payload.result as { ok?: unknown; meta?: unknown } | null | undefined
            if (result && result.ok === true && result.meta && typeof result.meta === 'object') {
              meta = result.meta as RoundMetaPayload
              if (!round || round === 'qa') round = meta.round
            }
            continue
          }
          if (type === 'error') {
            failed = true
            streamError = (chunk as { payload?: { error?: unknown } }).payload?.error ?? 'unknown stream error'
            break
          }
        }
      } catch (error) {
        failed = true
        streamError = error
      }
      if (!started) await writeStart()
      if (failed) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify(classifyModelError(streamError)) })
        await stream.writeSSE({ event: 'close', data: '{}' })
        return
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

      // Ticket 07: persist the round metadata on the assistant row (think /
      // sources / meta columns) and echo it as a `meta` event before done.
      if (meta !== null) {
        await stream.writeSSE({ event: 'meta', data: JSON.stringify(meta) })
      }

      const userSaved = await messages.append(tripId, 'user', content)
      const assistantSaved = await messages.append(tripId, 'assistant', full, {
        ...(meta?.think !== undefined ? { think: meta.think } : {}),
        ...(meta?.sources !== undefined ? { sources: meta.sources } : {}),
        ...(meta !== null ? { meta } : {}),
      })
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
