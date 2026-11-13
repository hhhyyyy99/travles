/**
 * Ticket 13 proposal routes.
 *
 * Generation runs the planner against a read-only `create_trip_proposal`
 * tool. The proposal is kept by id and is applied only by the explicit
 * confirmation endpoint, which delegates to the existing TripPatch validator.
 */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@mastra/core/agent'
import { Hono, type Context } from 'hono'
import { RequestContext } from '@mastra/core/request-context'
import type { AppEnv } from '../app.js'
import { readJsonBody } from '../http/body.js'
import type { TripRepository } from '../trips/repository.js'
import type { TripPatchRecord, TripPatchStoreDriver } from '../trip-patch/types.js'
import { applyTripPatch } from '../trip-patch/apply.js'
import { hashTripSnapshotRows, readTripSnapshotRows } from '../chat/confirmation.js'
import { proposalRequestSchema } from './schema.js'
import {
  CREATE_TRIP_PROPOSAL_TOOL_NAME,
  PROPOSAL_KIND_KEY,
  PROPOSAL_TRIP_ID_KEY,
  PROPOSAL_TARGET_DAY_KEY,
  READ_TRIP_SNAPSHOT_TOOL_NAME,
} from './tool.js'
import type { AiProposal, AiProposalStore, ProposalKind, ProposalToolResult } from './types.js'

export type AiProposalRouteOptions = {
  tripRepository: TripRepository
  planner: Agent
  /** False when no model is configured; dynamic for ticket-12 provider changes. */
  modelConfigured: boolean | (() => boolean | Promise<boolean>)
  memoryConfigured: boolean
  resolveTripPatchStore: () => Promise<TripPatchStoreDriver>
  proposalStore: AiProposalStore
  /** Synchronize trip metadata after an explicitly confirmed proposal apply. */
  onApplied?: (tripId: string, appliedPatch: TripPatchRecord) => Promise<void> | void
}

type ProposalRequest = { kind: ProposalKind; text?: string; dayId?: string }
type ProposalPayload = Omit<AiProposal, 'id' | 'tripId' | 'createdAt'>

export function registerAiProposalRoutes(app: Hono<AppEnv>, options: AiProposalRouteOptions): void {
  const create = async (c: Context<AppEnv>) => {
    const tripId = routeParam(c, 'id')
    if (await options.tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
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
          error: '模型服务未配置，无法生成建议。',
          guidance: '请先在设置中配置模型服务，确认后重试。',
          code: 'model_unconfigured',
        },
        503,
      )
    }
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const request = proposalRequestSchema.safeParse(body)
    if (!request.success) {
      return c.json({ error: proposalRequestError(request.error.issues[0]?.message), code: 'invalid_request' }, 400)
    }
    const input = request.data as ProposalRequest
    if (input.kind === 'parse' && (!input.text || input.text.trim() === '')) {
      return c.json({ error: '请先粘贴攻略文本。', code: 'invalid_request' }, 400)
    }
    if (input.kind === 'day-optimize' && !input.dayId) {
      return c.json({ error: '请选择要优化的日期。', code: 'invalid_request' }, 400)
    }

    const requestContext = new RequestContext()
    requestContext.set(PROPOSAL_TRIP_ID_KEY, tripId)
    requestContext.set(PROPOSAL_KIND_KEY, input.kind)
    if (input.dayId !== undefined) requestContext.set(PROPOSAL_TARGET_DAY_KEY, input.dayId)
    const prompt = buildProposalPrompt(tripId, input)
    let output: Awaited<ReturnType<typeof options.planner.stream>>
    try {
      output = await options.planner.stream(prompt, {
        ...(options.memoryConfigured ? { memory: { thread: `trip-${tripId}`, resource: tripId } } : {}),
        requestContext,
        maxSteps: 8,
      })
    } catch {
      return c.json({ error: '无法启动建议生成。', guidance: '请检查模型服务配置后重试。', code: 'model_unavailable' }, 502)
    }

    let proposalInput: ProposalPayload | null = null
    let proposalSnapshotHash: string | undefined
    let snapshotRead = input.kind === 'parse'
    let proposalBeforeSnapshot = false
    let streamError: unknown = null
    try {
      for await (const chunk of output.fullStream) {
        const type = (chunk as { type?: unknown }).type
        if (type === 'tool-result') {
          const payload = (chunk as { payload?: { toolName?: unknown; result?: unknown } }).payload
          if (payload?.toolName === READ_TRIP_SNAPSHOT_TOOL_NAME) {
            const result = payload.result as { ok?: unknown } | null | undefined
            if (result?.ok === true) snapshotRead = true
            continue
          }
          if (payload?.toolName !== CREATE_TRIP_PROPOSAL_TOOL_NAME) continue
          const result = payload.result as ProposalToolResult | null | undefined
          if (result?.ok === true) {
            if (!snapshotRead) proposalBeforeSnapshot = true
            proposalInput = result.proposal
            proposalSnapshotHash = result.snapshotHash
          }
          else if (result?.ok === false) streamError = result.error
          continue
        }
        if (type === 'error') {
          streamError = (chunk as { payload?: { error?: unknown } }).payload?.error
          break
        }
      }
    } catch (error) {
      streamError = error
    }
    if (output.error && proposalInput === null) streamError = output.error
    if (proposalInput === null) {
      return c.json(
        {
          error: typeof streamError === 'string' && streamError ? streamError : '模型没有返回可确认的结构化建议。',
          guidance: '请重试；如果仍失败，请换一种更具体的说法描述攻略或优化目标。',
          code: 'proposal_invalid',
        },
        422,
      )
    }
    if (proposalBeforeSnapshot || !snapshotRead || (input.kind !== 'parse' && !proposalSnapshotHash)) {
      return c.json(
        {
          error: '路线优化建议未读取当前行程，无法确认建议范围。',
          guidance: '请重试；优化建议需要先读取当前行程后再生成。',
          code: 'proposal_invalid',
        },
        422,
      )
    }

    const scope = await validateProposalScope(tripId, input.kind, input.dayId, proposalInput, options.resolveTripPatchStore)
    if (!scope.ok) {
      return c.json({ error: scope.error, guidance: '建议未写入行程，请重新生成或换一个目标。', code: 'proposal_invalid' }, 422)
    }
    const proposal: AiProposal = {
      id: randomUUID(),
      tripId,
      ...proposalInput,
      createdAt: new Date().toISOString(),
    }
    options.proposalStore.save({ ...proposal, ...(proposalSnapshotHash ? { snapshotHash: proposalSnapshotHash } : {}) })
    return c.json({ proposal }, 201)
  }

  const apply = async (c: Context<AppEnv>) => {
    const tripId = routeParam(c, 'id')
    if (await options.tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
    const proposalId = routeParam(c, 'proposalId')
    const proposal = options.proposalStore.get(tripId, proposalId)
    if (proposal === null) return c.json({ error: '建议不存在或已过期', code: 'proposal_not_found' }, 404)

    const scope = await validateProposalScope(tripId, proposal.kind, proposal.targetDayId, proposal, options.resolveTripPatchStore)
    if (!scope.ok) {
      return c.json({ error: scope.error, guidance: '建议未写入行程，请重新生成。', code: 'proposal_invalid' }, 422)
    }
    if (proposal.kind !== 'parse' && !proposal.snapshotHash) {
      return c.json({ error: '建议缺少行程快照，请重新生成。', code: 'proposal_invalid' }, 422)
    }
    let stale = false
    let result: Awaited<ReturnType<typeof applyTripPatch>>
    try {
      result = await applyTripPatch(await options.resolveTripPatchStore(), tripId, proposal.patch, {
        // The explicit proposal apply route is its confirmation gate. Unlike
        // chat it has no saved chip; bind it to the rows the model actually read
        // and check them within the same transaction as the patch writes.
        beforeApply: async (store) => {
          if (proposal.snapshotHash && hashTripSnapshotRows(await readTripSnapshotRows(store, tripId)) !== proposal.snapshotHash) {
            stale = true
            return { ok: false, code: 'invalid', error: '行程或候选池已发生变化，这份建议已经过期。' }
          }
          const currentScope = await validateProposalScope(tripId, proposal.kind, proposal.targetDayId, proposal, async () => store)
          return currentScope.ok ? { ok: true } : { ok: false, code: 'invalid', error: currentScope.error }
        },
      })
    } catch {
      return c.json({ error: '行程存储不可用，请稍后重试。', guidance: '建议仍保留，请稍后再次确认。', code: 'storage' }, 503)
    }
    if (!result.ok) {
      if (stale) return c.json({ error: result.error, guidance: '建议未写入行程，请基于最新行程重新生成。', code: 'proposal_stale' }, 409)
      const status = result.code === 'not_found' ? 404 : result.code === 'storage' ? 503 : 422
      return c.json({ error: result.error, guidance: '行程未被改动，请修正后重新生成建议。', code: 'patch_invalid' }, status)
    }
    const appliedPatch = { summary: result.summary, stats: result.stats, patch: result.patch }
    try {
      await options.onApplied?.(tripId, appliedPatch)
    } catch {
      // The proposal patch is already committed; a later event/refetch can
      // repair summary metadata if this side effect fails.
    }
    options.proposalStore.remove(tripId, proposalId)
    return c.json({
      proposalId,
      appliedPatch,
    })
  }

  const cancel = async (c: Context<AppEnv>) => {
    const tripId = routeParam(c, 'id')
    options.proposalStore.remove(tripId, routeParam(c, 'proposalId'))
    return c.json({ ok: true })
  }

  app.post('/api/trips/:id/ai/proposals', create)
  app.post('/api/trips/:id/ai/proposals/:proposalId/apply', apply)
  app.delete('/api/trips/:id/ai/proposals/:proposalId', cancel)
}

function buildProposalPrompt(tripId: string, input: ProposalRequest): string {
  if (input.kind === 'parse') {
    return [
      `这是行程 ${tripId} 的智能解析请求。`,
      '请只调用 create_trip_proposal，不要调用 apply_trip_patch，也不要把建议直接写入行程。',
      '把下面攻略拆成按天的结构化行程项；不确定的酒店或地点标记 pending，并在 summary 里说明。',
      `攻略原文：\n${input.text ?? ''}`,
    ].join('\n')
  }
  if (input.kind === 'day-optimize') {
    return [
      `这是行程 ${tripId} 的天级路线优化请求，目标天是 ${input.dayId}。`,
      '先调用 read_trip_snapshot，再只调用 create_trip_proposal；不要调用 apply_trip_patch。',
      `只重排 targetDayId=${input.dayId} 当天已有卡片；patch 只能包含 move_item，不能修改其它天或增删天。`,
      'diff 说明调整前后顺序与节奏取舍。',
    ].join('\n')
  }
  return [
    `这是行程 ${tripId} 的全局路线优化请求。`,
    '先调用 read_trip_snapshot，再只调用 create_trip_proposal；不要调用 apply_trip_patch。',
    '结合当前行程的日期、地点、交通段与节奏，给出可确认的全局路线建议。',
    'patch 可包含必要的 move_item/update_item、add_stash、move_stash_to_day；不能增删日期或删除卡片。',
    'add_stash 需要新的 stashId 和 title，可带 note/category 与可空 poi；暂不排期的想法保留在候选池。',
    'move_stash_to_day 用快照中的真实 stash.id（不是 POI ID）、新的 itemId 和已有 dayId；同一 patch 可先 add_stash 再引用它。',
    '候选安排到日程后会从候选池移除。纯文字候选无坐标时按需要设置 pending/legPending。diff 用 stashId/itemId/toDayId 说明候选与日程变化。',
  ].join('\n')
}

function proposalRequestError(message: string | undefined): string {
  if (message?.includes('Invalid option')) return '建议类型无效。'
  return '建议请求字段无效。'
}

type ScopeResult = { ok: true } | { ok: false; error: string }

function routeParam(c: Context<AppEnv>, key: string): string {
  return c.req.param(key) ?? ''
}

async function validateProposalScope(
  tripId: string,
  kind: ProposalKind,
  targetDayId: string | undefined,
  proposal: Pick<AiProposal, 'kind' | 'patch' | 'targetDayId'>,
  resolveStore: () => Promise<TripPatchStoreDriver>,
): Promise<ScopeResult> {
  if (proposal.kind !== kind) return { ok: false, error: '建议类型与请求不一致。' }
  const ops = proposal.patch.ops
  if (kind === 'parse') {
    if (ops.some((op) => op.op !== 'add_day' && op.op !== 'add_item')) {
      return { ok: false, error: '智能解析建议只能新增日期和行程项。' }
    }
    return { ok: true }
  }
  if (kind === 'optimize') {
    if (ops.some((op) => op.op !== 'move_item' && op.op !== 'update_item' && op.op !== 'add_stash' && op.op !== 'move_stash_to_day')) {
      return { ok: false, error: '路线优化只能调整已有卡片、新增候选或将候选移入日程，不能增删日期或删除卡片。' }
    }
    return { ok: true }
  }
  if (!targetDayId || proposal.targetDayId !== targetDayId) {
    return { ok: false, error: '天级建议目标日期不一致。' }
  }
  let store: TripPatchStoreDriver
  try {
    store = await resolveStore()
    const dayRows = await store.listDayRows(tripId)
    const targetExists = dayRows.some((row) => typeof row?.id === 'string' && row.id === targetDayId)
    if (!targetExists) return { ok: false, error: '目标天不存在，无法生成天级建议。' }
    const itemRows = await store.listItemRows(tripId)
    const targetItems = new Set(
      itemRows.filter((row) => row?.day_id === targetDayId).map((row) => String(row.id)),
    )
    for (const op of ops) {
      if (op.op !== 'move_item' || op.dayId !== targetDayId) {
        return { ok: false, error: '天级魔法棒只能重排目标天的已有卡片。' }
      }
      if (!targetItems.has(op.itemId)) return { ok: false, error: '天级建议引用了目标天之外的卡片。' }
    }
  } catch {
    return { ok: false, error: '无法读取行程，暂时不能生成天级建议。' }
  }
  return { ok: true }
}
