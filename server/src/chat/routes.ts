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
 * 4. `applied_patch` → `{ "summary", "stats", "patch" }` (ticket 08, optional
 *    — present iff the model's `apply_trip_patch` call succeeded this turn):
 *
 *        {
 *          "summary": "已写入行程：新增 2 天、6 张卡片",
 *          "stats":   { "daysAdded": 2, "itemsAdded": 6, "legsWritten": 3, … },
 *          "patch":   { "ops": [ …the applied TripPatch… ] }
 *        }
 *
 *    Slots where `meta` sits (after deltas, before `done`). The client shows
 *    a "已写入行程" summary card and refetches /canvas so the three columns
 *    and the map redraw live. The same record persists on the assistant
 *    message (`appliedPatch`) for reloads.
 * 5. `done`   → `{ "userMessage": ChatMessage, "assistantMessage": ChatMessage }`
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
 * `meta` event and persisted on the assistant row.
 *
 * ## TripPatch writes (ticket 08)
 * The plan round's `apply_trip_patch` tool executes server-side through the
 * same stream: the route seeds a per-turn `RequestContext` (trip id + retry
 * state) before `planner.stream`, and the tool's execute reads it. A rejected
 * patch returns an error TO THE MODEL (tool result), which retries up to
 * `PATCH_TURN_MAX_ATTEMPTS` total calls; a successful apply is recorded on
 * the turn state, emitted as `applied_patch` and persisted on the assistant
 * message. If every attempt is rejected, the route emits an `error` event
 * (code `patch_invalid`) + `close` instead of `done` and persists nothing —
 * the stream itself never crashes on patch problems.
 *
 * ## Agent memory
 * One memory thread per trip (`thread: trip-<tripId>`, `resource: <tripId>`);
 * with the default wiring the thread lives in the same SQLite database as
 * everything else (see createMastra). Mastra saves the turn into memory; the
 * messages table stays the app-owned display history.
 */
import { streamSSE } from 'hono/streaming'
import type { Hono } from 'hono'
import { RequestContext } from '@mastra/core/request-context'
import type { Agent } from '@mastra/core/agent'
import type { TripRepository } from '../trips/repository.js'
import type { TripPlanningContext, TripSummary } from '../trips/types.js'
import { ChatMessageRepository } from './repository.js'
import type { AppEnv } from '../app.js'
import { readJsonBody } from '../http/body.js'
import type { RoundMetaPayload, RoundWarning } from './round-meta.js'
import { readRoundFromToolArgs } from './round-meta.js'
import { createPatchConfirmation, hashTripSnapshot, readTripSnapshotRows } from './confirmation.js'
import {
  detectTimeConstraintConflicts,
  isModificationRequest,
  isScheduleRequest,
  longDriveWarnings,
  warningAsText,
  type TimeConstraintConflict,
} from './analysis.js'
import {
  PATCH_TRIP_ID_KEY,
  PATCH_TURN_STATE_KEY,
  createPatchTurnState,
} from '../trip-patch/tool.js'
import type { TripPatchRecord, TripPatchStoreDriver } from '../trip-patch/types.js'
import type { TripEventHub } from '../trip-events/hub.js'

export type ChatRouteOptions = {
  tripRepository: TripRepository
  messages: ChatMessageRepository
  planner: Agent
  /** False when no model is configured; dynamic for ticket-12 provider changes. */
  modelConfigured: boolean | (() => boolean | Promise<boolean>)
  /** False when the agent runs without memory (pure injected test setups). */
  memoryConfigured: boolean
  /**
   * Ticket 08: resolves the store `apply_trip_patch` writes through. When
   * absent the tool answers "storage unavailable" instead of writing.
   */
  resolveTripPatchStore?: () => Promise<TripPatchStoreDriver>
  /** Broadcast a committed patch so other workbench tabs refetch the canvas. */
  onTripPatched?: (tripId: string, appliedPatch: TripPatchRecord) => Promise<void> | void
  /** Broadcast persisted chat turns to other tabs showing this trip. */
  events?: TripEventHub
}

/** Total `apply_trip_patch` calls allowed per turn (initial + 2 retries). */
const PATCH_TURN_MAX_ATTEMPTS = 3

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

    let modelConfigured = false
    try {
      modelConfigured = typeof options.modelConfigured === 'function'
        ? await options.modelConfigured()
        : options.modelConfigured
    } catch {
      modelConfigured = false
    }
    if (!modelConfigured) {
      return c.json(
        {
          error: '模型服务未配置，无法开始对话。',
          guidance: '请从行程列表进入「AI 接入设置」，保存并测试一套模型配置后重试；若采用环境变量部署，也可配置 AI_BASE_URL / AI_API_KEY / AI_MODEL。',
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

    const analysis = await analyzeTripTurn(trip, content, options.resolveTripPatchStore)
    const confirmationRequested = isPatchConfirmation(content)
    if (confirmationRequested) {
      if (!analysis.hasExistingPlan) {
        return c.json(
          {
            error: '没有可确认的修改方案，或这项方案已经使用过。',
            guidance: '请先描述要修改的内容，让 AI 分析影响后再点击最新的确认选项。',
            code: 'confirmation_required',
          },
          409,
        )
      }
      const gate = await consumePatchConfirmation(
        options.resolveTripPatchStore,
        trip.id,
        analysis.snapshotHash,
        content,
      )
      if (!gate.ok) return c.json({ error: gate.error, guidance: gate.guidance, code: gate.code }, 409)
    }
    const allowPatchApply =
      analysis.conflicts.length === 0 &&
      !analysis.storeReadFailed &&
      (!analysis.hasExistingPlan || confirmationRequested)

    // Start the agent run before committing to SSE so failures at run
    // construction can still fall back to a plain HTTP error.
    let output: Awaited<ReturnType<typeof planner.stream>>
    // Ticket 08: per-turn RequestContext seeds the apply_trip_patch tool with
    // the trip id and the retry state the route owns (read back after the run).
    const requestContext = new RequestContext()
    const patchTurn = createPatchTurnState(PATCH_TURN_MAX_ATTEMPTS, allowPatchApply)
    if (confirmationRequested && analysis.snapshotHash !== null) {
      const confirmedHash = analysis.snapshotHash
      patchTurn.beforeApply = async (store) => {
        const rows = await readTripSnapshotRows(store, trip.id)
        return hashTripSnapshot(trip, rows.days, rows.items, rows.legs, rows.stash) === confirmedHash
          ? { ok: true }
          : { ok: false, code: 'invalid', error: '行程或候选池已发生变化，这份影响分析已经过期。请重新分析后确认。' }
      }
    }
    requestContext.set(PATCH_TRIP_ID_KEY, trip.id)
    requestContext.set(PATCH_TURN_STATE_KEY, patchTurn)
    // Ticket 13's read_trip_snapshot tool uses the proposal context key. Set
    // it here too so patch-explain turns can inspect the same current canvas
    // without introducing a second snapshot implementation.
    requestContext.set('ai.proposal.tripId', trip.id)
    try {
      output = await planner.stream(buildPlannerPrompt(content, analysis, allowPatchApply), {
        ...(options.memoryConfigured
          ? { memory: { thread: `trip-${trip.id}`, resource: trip.id } }
          : {}),
        requestContext,
        // Ticket 07: tool call first, prose after; ticket 08: leave loop
        // budget for patch validation retries (tool calls, then final prose).
        maxSteps: 8,
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
      const forcedPatchExplain =
        !allowPatchApply &&
        (analysis.conflicts.length > 0 ||
          patchTurn.blockedBeforeConfirmation ||
          (analysis.isModification && analysis.hasExistingPlan))

      const writeStart = async (): Promise<void> => {
        started = true
        await stream.writeSSE({ event: 'start', data: JSON.stringify({ round: round ?? (forcedPatchExplain ? 'patch-explain' : 'qa') }) })
        if (analysis.conflicts.length > 0) {
          const warningText = analysis.conflicts
            .map((conflict) => `⚠️ ${conflict.message} ${conflict.suggestion}`)
            .join('\n')
          full += `${warningText}\n`
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: `${warningText}\n` }) })
        }
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
              if (forcedPatchExplain) round = 'patch-explain'
            }
            continue
          }
          if (type === 'tool-result') {
            const payload = (chunk as { payload?: { toolName?: unknown; result?: unknown } }).payload
            if (payload?.toolName !== 'emit_round_meta') continue
            // (apply_trip_patch results are read from the turn state below —
            // they already did their server-side write when they got here.)
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

      // Keep the boundary warnings visible even when the model omitted the
      // optional fields from emit_round_meta. The itinerary itself stays on
      // the server; only these concise warnings cross the model/UI boundary.
      const postApplyWarnings = patchTurn.applied
        ? await readLongDriveWarnings(options.resolveTripPatchStore, tripId)
        : []
      const boundaryWarnings = dedupeWarnings([
        ...analysis.warnings,
        ...postApplyWarnings,
        ...analysis.conflicts.map(conflictToWarning),
      ])
      const mustExplainPatch = forcedPatchExplain || patchTurn.blockedBeforeConfirmation || round === 'patch-explain'
      const shouldSaveConfirmation =
        analysis.hasExistingPlan &&
        !confirmationRequested &&
        patchTurn.applied === null &&
        !patchTurn.exhausted &&
        mustExplainPatch &&
        analysis.snapshotHash !== null
      if (boundaryWarnings.length > 0 || mustExplainPatch) {
        const nextRound = mustExplainPatch ? 'patch-explain' : round ?? 'qa'
        const current = meta ?? { round: nextRound }
        meta = {
          ...current,
          round: nextRound,
          ...(boundaryWarnings.length > 0
            ? { warnings: dedupeWarnings([...(current.warnings ?? []), ...boundaryWarnings]) }
            : {}),
          ...(analysis.conflicts.length > 0
            ? { conflicts: dedupeStrings([...(current.conflicts ?? []), ...analysis.conflicts.map((conflict) => conflict.message)]) }
            : {}),
          ...(nextRound === 'patch-explain' && (!current.chips || current.chips.length === 0)
            ? {
                chips: [
                  {
                    label: '确认并按这个方案重排',
                    value: '确认方案：按刚才的影响分析执行重排',
                  },
                ],
              }
            : {}),
        }
      }

      // A model can omit the prose version of a deterministic warning. Add
      // the split recommendation to the assistant stream so it is visible in
      // the conversation as well as in the structured warning panel.
      const missingWarningText = boundaryWarnings
        .filter((warning) => !full.includes(warning.message))
        .map(warningAsText)
        .join('\n')
      if (missingWarningText !== '') {
        const suffix = `${full === '' ? '' : '\n\n'}⚠️ ${missingWarningText}\n`
        full += suffix
        await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: suffix }) })
      }

      // Ticket 08: the model kept submitting invalid patches until its retry
      // budget ran out. Nothing was written; answer with an explicit error
      // instead of `done` and persist nothing (never a half-applied turn).
      if (patchTurn.exhausted) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({
            code: 'patch_invalid',
            message: 'AI 提交的行程修改多次未通过服务端校验，本次写入已取消。',
            guidance: '请重试或换个说法描述你的计划；行程数据未被改动，你也可以手动编辑。',
          }),
        })
        await stream.writeSSE({ event: 'close', data: '{}' })
        return
      }

      const completedRound = patchTurn.applied !== null ? 'plan' : round ?? 'qa'
      if (completedRound === 'qa' || completedRound === 'plan') {
        const current = meta ?? { round: completedRound }
        meta = {
          ...current,
          round: completedRound,
          ...(current.chips && current.chips.length > 0 ? {} : { chips: nextStepChips(completedRound) }),
        }
      }

      if (patchTurn.applied !== null) {
        try {
          await options.onTripPatched?.(tripId, patchTurn.applied)
        } catch {
          // The patch itself is already committed. A later event or manual
          // refresh can repair schedule metadata if this side effect fails.
        }
      }

      // Ticket 07: persist the round metadata on the assistant row (think /
      // sources / meta columns) and echo it as a `meta` event before done.
      if (meta !== null) {
        await stream.writeSSE({ event: 'meta', data: JSON.stringify(meta) })
      }

      // Ticket 08: the plan round wrote through apply_trip_patch — echo the
      // applied patch record so the client can show a summary card and
      // refetch /canvas, and persist it on the assistant message.
      if (patchTurn.applied !== null) {
        await stream.writeSSE({ event: 'applied_patch', data: JSON.stringify(patchTurn.applied) })
      }

      const userSaved = await messages.append(tripId, 'user', content)
      const assistantSaved = await messages.append(tripId, 'assistant', full, {
        ...(meta?.think !== undefined ? { think: meta.think } : {}),
        ...(meta?.sources !== undefined ? { sources: meta.sources } : {}),
        ...(meta !== null ? { meta } : {}),
        ...(patchTurn.applied !== null ? { appliedPatch: patchTurn.applied } : {}),
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

      if (shouldSaveConfirmation) {
        try {
          const store = await options.resolveTripPatchStore?.()
          if (!store) throw new Error('patch confirmation store unavailable')
          const choices = (meta?.chips ?? []).map((chip) => chip.value).filter((value) => value.trim() !== '')
          const fallback = '确认方案：按刚才的影响分析执行重排'
          await store.savePatchConfirmation(
            tripId,
            createPatchConfirmation(analysis.snapshotHash!, choices.length > 0 ? choices : [fallback]),
          )
        } catch {
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              code: 'storage',
              message: '修改确认方案保存失败。',
              guidance: '请重新发送修改请求，先让 AI 再次分析影响后重试。',
            }),
          })
          await stream.writeSSE({ event: 'close', data: '{}' })
          return
        }
      }

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({ userMessage: userSaved.message, assistantMessage: assistantSaved.message }),
      })
      options.events?.publish(tripId, 'chat', 'message_created')
    })
  })
}

type TripTurnAnalysis = {
  hasExistingPlan: boolean
  isModification: boolean
  storeReadFailed: boolean
  snapshotHash: string | null
  warnings: RoundWarning[]
  conflicts: TimeConstraintConflict[]
  planningContext?: TripPlanningContext
}

/** Inspect trip rows locally for guardrails and confirmation gating. */
async function analyzeTripTurn(
  trip: TripSummary,
  content: string,
  resolveStore?: () => Promise<TripPatchStoreDriver>,
): Promise<TripTurnAnalysis> {
  // A newly created trip may carry placeholder dates from the create form;
  // only compare against stored trip dates once an actual plan exists.
  const isModification = isModificationRequest(content)
  const scheduleRequest = isScheduleRequest(content)
  const explicitConflicts = scheduleRequest ? detectTimeConstraintConflicts(content) : []
  if (!resolveStore) {
    return {
      hasExistingPlan: false,
      isModification,
      storeReadFailed: false,
      snapshotHash: null,
      warnings: explicitConflicts.map(conflictToWarning),
      conflicts: explicitConflicts,
      planningContext: trip.planningContext,
    }
  }
  try {
    const store = await resolveStore()
    const { days: dayRows, items: itemRows, legs: legRows, stash: stashRows } = await readTripSnapshotRows(store, trip.id)
    const hasDays = dayRows.some((row) => typeof row?.id === 'string' && row.id !== '')
    const hasExistingPlan = hasDays || stashRows.length > 0
    const snapshotHash = hashTripSnapshot(trip, dayRows, itemRows, legRows, stashRows)
    const conflicts = scheduleRequest
      ? hasDays
        ? detectTimeConstraintConflicts(content, trip)
        : explicitConflicts
      : []
    return {
      hasExistingPlan,
      isModification,
      storeReadFailed: false,
      snapshotHash,
      warnings: [...longDriveWarnings(legRows, itemRows, dayRows), ...conflicts.map(conflictToWarning)],
      conflicts,
      planningContext: trip.planningContext,
    }
  } catch {
    return {
      hasExistingPlan: false,
      isModification,
      storeReadFailed: true,
      snapshotHash: null,
      warnings: explicitConflicts.map(conflictToWarning),
      conflicts: explicitConflicts,
      planningContext: trip.planningContext,
    }
  }
}

async function readLongDriveWarnings(
  resolveStore: (() => Promise<TripPatchStoreDriver>) | undefined,
  tripId: string,
): Promise<RoundWarning[]> {
  if (!resolveStore) return []
  try {
    const store = await resolveStore()
    const { days, items, legs } = await readTripSnapshotRows(store, tripId)
    return longDriveWarnings(legs, items, days)
  } catch {
    return []
  }
}

function buildPlannerPrompt(content: string, analysis: TripTurnAnalysis, allowPatchApply: boolean): string {
  const parts = [content]
  if (analysis.planningContext) {
    const context = analysis.planningContext
    parts.push(
      `\n[创建意图上下文]\n目的地：${context.destination}\n行程天数：${context.durationDays} 天\n用户偏好：${context.preferences}\n日期状态：${context.dateStatus}${context.datePhrase ? `（${context.datePhrase}）` : ''}\n请保留这些信息；日期未确认时先澄清日期，不要把占位日期当作已确认。`,
    )
  }
  if (analysis.conflicts.length > 0) {
    parts.push(
      `\n[边界约束]\n${analysis.conflicts.map((conflict) => `${conflict.message} ${conflict.suggestion}`).join('\n')}\n先指出冲突，不得静默选择，也不要调用 apply_trip_patch。`,
    )
  }
  if (analysis.warnings.some((warning) => warning.kind === 'long-drive')) {
    parts.push('\n[路线警示]\n当前行程有超过 6 小时的驾驶段，请在 AI 回复中给出拆分、休息或中途过夜建议。')
  }
  if (!allowPatchApply && analysis.isModification && analysis.hasExistingPlan) {
    parts.push(
      '\n[修改确认协议]\n这是对既有行程的修改请求。先调用 read_trip_snapshot 读取当前安排，再输出 patch-explain，复述变更、影响范围、冲突和解决选项；本轮绝对不要调用 apply_trip_patch。只有用户后续选择以「确认方案」开头的选项后，才可调用 apply_trip_patch。',
    )
  }
  if (allowPatchApply && analysis.isModification && analysis.hasExistingPlan) {
    parts.push(
      '\n[修改已确认]\n用户已确认影响分析中的方案。请输出逐日重排结果，明确列出为满足约束所做的妥协，然后调用 apply_trip_patch。',
    )
  }
  if (analysis.storeReadFailed) {
    parts.push('\n[行程状态暂不可读]\n暂时无法读取既有行程，本轮不要调用 apply_trip_patch；请先告知用户稍后重试。')
  }
  return parts.join('\n')
}

function isPatchConfirmation(content: string): boolean {
  const text = content.trim()
  return /确认方案|确认并执行|按这个(?:方案)?(?:重排|执行)|就按.*(?:重排|调整|执行)|同意.*(?:重排|调整|执行)/.test(text)
}

function nextStepChips(round: 'qa' | 'plan'): { label: string; value: string }[] {
  return round === 'plan'
    ? [
        { label: '查看路线', value: '查看路线' },
        { label: '继续调整计划', value: '继续调整计划' },
      ]
    : [
        { label: '继续完善行程', value: '继续完善行程' },
        { label: '查看路线', value: '查看路线' },
      ]
}

type ConfirmationGateResult =
  | { ok: true }
  | { ok: false; code: 'confirmation_required' | 'confirmation_invalid' | 'confirmation_stale' | 'storage'; error: string; guidance: string }

/** Require an exact, one-use chip from the current itinerary snapshot. */
async function consumePatchConfirmation(
  resolveStore: (() => Promise<TripPatchStoreDriver>) | undefined,
  tripId: string,
  currentSnapshotHash: string | null,
  content: string,
): Promise<ConfirmationGateResult> {
  if (!resolveStore || currentSnapshotHash === null) {
    return {
      ok: false,
      code: 'storage',
      error: '暂时无法验证这项修改确认。',
      guidance: '请稍后重新发送修改请求，让 AI 重新分析当前行程。',
    }
  }

  let store: TripPatchStoreDriver
  let pending: Awaited<ReturnType<TripPatchStoreDriver['getPatchConfirmation']>>
  try {
    store = await resolveStore()
    pending = await store.getPatchConfirmation(tripId)
  } catch {
    return {
      ok: false,
      code: 'storage',
      error: '暂时无法读取修改确认。',
      guidance: '请稍后重新发送修改请求，让 AI 重新分析当前行程。',
    }
  }
  if (pending === null) {
    return {
      ok: false,
      code: 'confirmation_required',
      error: '没有可确认的修改方案，或这项方案已经使用过。',
      guidance: '请先描述要修改的内容，让 AI 分析影响后再点击最新的确认选项。',
    }
  }
  if (!pending.choices.includes(content.trim())) {
    return {
      ok: false,
      code: 'confirmation_invalid',
      error: '确认内容与当前修改方案不匹配。',
      guidance: '请点击当前对话中最新的确认选项；如果行程刚发生变化，请重新发起修改分析。',
    }
  }
  if (pending.snapshotHash !== currentSnapshotHash) {
    return {
      ok: false,
      code: 'confirmation_stale',
      error: '行程已发生变化，这份影响分析已经过期。',
      guidance: '请重新发送修改请求，让 AI 基于最新行程分析影响。',
    }
  }
  try {
    if (await store.consumePatchConfirmation(tripId, pending.token, currentSnapshotHash)) return { ok: true }
  } catch {
    return {
      ok: false,
      code: 'storage',
      error: '修改确认保存失败。',
      guidance: '请稍后重新发送修改请求，让 AI 重新分析当前行程。',
    }
  }
  return {
    ok: false,
    code: 'confirmation_required',
    error: '这项修改确认已经使用过或已失效。',
    guidance: '请重新发起修改分析后再选择方案。',
  }
}

function conflictToWarning(conflict: TimeConstraintConflict): RoundWarning {
  return {
    kind: 'time-conflict',
    title: '时间约束冲突',
    message: conflict.message,
    suggestion: conflict.suggestion,
  }
}

function dedupeWarnings(warnings: RoundWarning[]): RoundWarning[] {
  const seen = new Set<string>()
  return warnings.filter((warning) => {
    const key = `${warning.kind}|${warning.title}|${warning.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim() !== ''))]
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
