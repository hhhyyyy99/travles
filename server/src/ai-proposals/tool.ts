/** Mastra tool that returns a validated proposal without writing trip data. */
import { createTool } from '@mastra/core/tools'
import { RequestContext } from '@mastra/core/request-context'
import { z } from 'zod'
import { parseProposalToolInput, proposalToolInputSchema } from './schema.js'
import type { ProposalKind, ProposalToolResult } from './types.js'
import { assembleCanvas } from '../days/repository.js'
import type { TripPatchStoreDriver } from '../trip-patch/types.js'
import { mapStashRow } from '../recommendations/repository.js'
import type { StashItem } from '../recommendations/types.js'
import { hashTripSnapshotRows, readTripSnapshotRows } from '../chat/confirmation.js'

export const CREATE_TRIP_PROPOSAL_TOOL_NAME = 'create_trip_proposal'
export const PROPOSAL_TRIP_ID_KEY = 'ai.proposal.tripId'
export const PROPOSAL_KIND_KEY = 'ai.proposal.kind'
export const PROPOSAL_TARGET_DAY_KEY = 'ai.proposal.targetDayId'
export const PROPOSAL_SNAPSHOT_HASH_KEY = 'ai.proposal.snapshotHash'
export const READ_TRIP_SNAPSHOT_TOOL_NAME = 'read_trip_snapshot'

export function createTripProposalTool() {
  return createTool({
    id: CREATE_TRIP_PROPOSAL_TOOL_NAME,
    description:
      '生成一份待确认的行程建议。只返回结构化建议，绝对不要直接修改行程；用户确认后服务端才会应用其中的 patch。parse 用 items 展示解析出的卡片；optimize 可调整已有卡片、用 add_stash 新增候选、用 move_stash_to_day 将候选安排到已有天，diff 的 stashId 引用真实候选 ID。day-optimize 只能重排指定一天的已有卡片。',
    inputSchema: proposalToolInputSchema,
    execute: async (input, context): Promise<ProposalToolResult> => {
      const expectedKind = context.requestContext.get(PROPOSAL_KIND_KEY)
      const targetDayId = context.requestContext.get(PROPOSAL_TARGET_DAY_KEY)
      if (expectedKind !== 'parse' && expectedKind !== 'optimize' && expectedKind !== 'day-optimize') {
        return { ok: false, retryable: false, error: '缺少建议类型上下文，无法生成建议。' }
      }
      const parsed = parseProposalToolInput(input)
      if (!parsed.ok) return { ok: false, retryable: true, error: parsed.error }
      if (parsed.value.kind !== expectedKind) {
        return { ok: false, retryable: true, error: `建议类型必须是 ${expectedKind}。` }
      }
      if (expectedKind === 'parse' && (!parsed.value.items || parsed.value.items.length === 0)) {
        return { ok: false, retryable: true, error: '智能解析建议必须包含至少一条结构化行程项。' }
      }
      if (expectedKind === 'day-optimize') {
        if (typeof targetDayId !== 'string' || targetDayId === '') {
          return { ok: false, retryable: false, error: '缺少目标天，无法生成天级建议。' }
        }
        if (parsed.value.targetDayId !== targetDayId) {
          return { ok: false, retryable: true, error: `天级建议的 targetDayId 必须是 ${targetDayId}。` }
        }
      }
      const snapshotHash = context.requestContext.get(PROPOSAL_SNAPSHOT_HASH_KEY)
      return { ok: true, proposal: parsed.value, ...(typeof snapshotHash === 'string' ? { snapshotHash } : {}) }
    },
  })
}

/** Read-only itinerary context for optimize/day-optimize model turns. */
export function createTripSnapshotTool(options: { resolveStore?: () => Promise<TripPatchStoreDriver> } = {}) {
  return createTool({
    id: READ_TRIP_SNAPSHOT_TOOL_NAME,
    description: '读取当前行程的天、卡片、交通段和候选池 stash（含真实 ID、标题、备注和可空 POI）。优化或分析候选安排前必须调用；不会修改数据。move_stash_to_day 必须使用返回的 stash.id，不能使用 POI ID。',
    inputSchema: z.object({}),
    execute: async (_input, context) => {
      const tripId = context.requestContext.get(PROPOSAL_TRIP_ID_KEY)
      if (typeof tripId !== 'string' || !tripId) return { ok: false, error: '缺少行程上下文。' }
      if (!options.resolveStore) return { ok: false, error: '行程存储不可用。' }
      try {
        const store = await options.resolveStore()
        const rows = await readTripSnapshotRows(store, tripId)
        // Bind the preview to these raw rows, before tolerant mapping can omit
        // corrupt entries or optional fields. Never hash the display projection.
        context.requestContext.set(PROPOSAL_SNAPSHOT_HASH_KEY, hashTripSnapshotRows(rows))
        return {
          ok: true, tripId, ...assembleCanvas(rows.days, rows.items, rows.legs, tripId),
          stash: rows.stash.map((row) => mapStashRow(row, tripId)).filter((item): item is StashItem => item !== null),
        }
      } catch {
        return { ok: false, error: '读取行程失败，请稍后重试。' }
      }
    },
  })
}

/** Narrow helper for route code that receives a generic request context. */
export function makeProposalContext(kind: ProposalKind, tripId: string, targetDayId?: string): RequestContext {
  const context = new RequestContext()
  context.set(PROPOSAL_TRIP_ID_KEY, tripId)
  context.set(PROPOSAL_KIND_KEY, kind)
  if (targetDayId !== undefined) context.set(PROPOSAL_TARGET_DAY_KEY, targetDayId)
  return context
}
