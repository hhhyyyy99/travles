/**
 * The `apply_trip_patch` tool (ticket 08) — the ONLY way the planner model
 * writes trip data. The tool body runs server-side validation (apply.ts)
 * before any write; its RESULT is what the model sees, so a rejected patch
 * comes back as a readable error the model can fix and retry — the user's
 * stream never fails on a first invalid patch.
 *
 * ## Per-turn context (RequestContext)
 * The chat route creates one `RequestContext` per POST and seeds it with:
 * - `chat.tripId`      — the trip this turn writes into
 * - `chat.patchTurn`   — a `PatchTurnState` object owned by the route
 *
 * The tool reads both from `context.requestContext` (always provided by the
 * Mastra runtime). Retry accounting lives in the turn state: the model may
 * retry a rejected patch up to `maxAttempts` total calls; after that the
 * tool reports `final: true` and flips `exhausted`, and the route answers
 * with an SSE `error` event instead of `done` (nothing is persisted).
 *
 * ## Result shape (tool result → model)
 * - success:  `{ ok: true, summary, stats }`
 * - rejected, retries left: `{ ok: false, retryable: true, error }`
 * - rejected, retries used up: `{ ok: false, retryable: false, final: true, error }`
 */
import { createTool } from '@mastra/core/tools'
import { applyTripPatch } from './apply.js'
import type { TripPatchApplyOptions } from './apply.js'
import { tripPatchInputSchema } from './schema.js'
import type { TripPatchRecord, TripPatchStoreDriver } from './types.js'

export const APPLY_TRIP_PATCH_TOOL_NAME = 'apply_trip_patch'

/** RequestContext keys seeded by the chat route for each turn. */
export const PATCH_TRIP_ID_KEY = 'chat.tripId'
export const PATCH_TURN_STATE_KEY = 'chat.patchTurn'

/** Per-turn retry bookkeeping, owned by the route and mutated by the tool. */
export type PatchTurnState = {
  attempts: number
  maxAttempts: number
  exhausted: boolean
  applied: TripPatchRecord | null
  /** Existing trips require an explicit confirmation chip before writes. */
  allowApply: boolean
  /** A model tried to write before confirmation; keep the turn non-fatal. */
  blockedBeforeConfirmation: boolean
  /** Confirmed snapshot guard; rechecked on the patch's transaction connection. */
  beforeApply?: TripPatchApplyOptions['beforeApply']
}

export function createPatchTurnState(maxAttempts = 3, allowApply = true): PatchTurnState {
  return {
    attempts: 0,
    maxAttempts,
    exhausted: false,
    applied: null,
    allowApply,
    blockedBeforeConfirmation: false,
  }
}

export type ApplyTripPatchToolOptions = {
  /** Lazily resolve the patch store (defaults to the app's SQLite database). */
  resolveStore?: () => Promise<TripPatchStoreDriver>
}

export function createApplyTripPatchTool(options: ApplyTripPatchToolOptions = {}) {
  return createTool({
    id: APPLY_TRIP_PATCH_TOOL_NAME,
    description:
      '把行程修改写入用户行程的唯一工具（结构化 diff，不是整篇覆盖）。ops 按顺序执行；校验失败时工具会把错误返回给你，请根据错误修正后重新调用（最多重试 2 次）。未确认的槽位（如未定酒店）用 pending: true，并在正文中标注「待定」。',
    inputSchema: tripPatchInputSchema,
    execute: async (input, context) => {
      // RequestContext values are runtime-keyed; narrow them here.
      const tripId = context.requestContext.get(PATCH_TRIP_ID_KEY)
      const state = context.requestContext.get(PATCH_TURN_STATE_KEY) as PatchTurnState | null
      if (typeof tripId !== 'string' || tripId === '' || state === null) {
        return { ok: false, retryable: false, error: '缺少行程上下文，无法写入行程。' }
      }
      if (!state.allowApply) {
        state.blockedBeforeConfirmation = true
        return {
          ok: false,
          retryable: false,
          pendingConfirmation: true,
          error: '这是一项会影响既有行程的修改，请先让用户确认影响分析中的方案。',
        }
      }
      state.attempts += 1
      if (!options.resolveStore) {
        return { ok: false, retryable: false, error: '服务器未配置行程存储，无法写入。' }
      }
      let store: TripPatchStoreDriver
      try {
        store = await options.resolveStore()
      } catch {
        return { ok: false, retryable: false, error: '行程存储不可用，请稍后重试。' }
      }
      const result = await applyTripPatch(store, tripId, input, { beforeApply: state.beforeApply })
      if (result.ok) {
        state.applied = { summary: result.summary, stats: result.stats, patch: result.patch }
        return { ok: true, summary: result.summary, stats: result.stats }
      }
      if (state.attempts >= state.maxAttempts) {
        state.exhausted = true
        return { ok: false, retryable: false, final: true, error: `${result.error}（重试次数已用完，本次写入取消。）` }
      }
      return { ok: false, retryable: true, error: `${result.error} 请修正后重新调用 apply_trip_patch。` }
    },
  })
}
