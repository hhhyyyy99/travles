/**
 * Round metadata contract (ticket #4, ticket 07 payload).
 *
 * The structured half of one chat turn, emitted by the planner's
 * `emit_round_meta` tool. The server validates tool inputs with this schema;
 * the frontend derives its metadata types from it while retaining its
 * tolerant decoder for existing messages.
 *
 * This schema preserves the existing tool input and persisted metadata. The
 * geographicFactCheck field requested in issue #4 remains to be designed and
 * integrated with the existing warning flow.
 */
import { z } from 'zod'

/** One clickable clarify option (rendered as a chip; clicking sends `value`). */
export const RoundOptionChipSchema = z.object({
  label: z.string().min(1).max(40).describe('选项展示文案，如「🚗 自驾/租车自驾」'),
  value: z.string().min(1).max(200).describe('点击选项后作为用户回复发送的文本'),
})
export type RoundOptionChip = z.infer<typeof RoundOptionChipSchema>

/** A place the model mentions; the client focuses the map on it when clicked. */
export const RoundPoiLinkSchema = z.object({
  name: z.string().min(1).max(60).describe('地名，必须原样出现在回复正文中'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  amapId: z.string().max(64).optional(),
})
export type RoundPoiLink = z.infer<typeof RoundPoiLinkSchema>

/** One citation behind the "来源" collapsible section. */
export const RoundSourceSchema = z.object({
  title: z.string().min(1).max(120),
  url: z.string().min(1).max(500),
})
export type RoundSource = z.infer<typeof RoundSourceSchema>

/** A boundary warning surfaced alongside a round (conflict or long drive). */
export const RoundWarningSchema = z.object({
  kind: z.enum(['time-conflict', 'long-drive']),
  title: z.string().min(1).max(120),
  message: z.string().min(1).max(400),
  suggestion: z.string().max(400).optional(),
  from: z.string().max(120).optional(),
  to: z.string().max(120).optional(),
  durationMin: z.number().finite().min(0).optional(),
  estimated: z.boolean().optional(),
})
export type RoundWarning = z.infer<typeof RoundWarningSchema>

/** Round types of the four-round protocol. */
export const RoundTypeSchema = z.enum(['clarify', 'qa', 'plan', 'patch-explain'])
export type RoundType = z.infer<typeof RoundTypeSchema>

/** Zod schema of the `emit_round_meta` tool input — doubles as the validation contract. */
export const roundMetaInputSchema = z.object({
  round: RoundTypeSchema.describe('本轮对话的回合类型'),
  chips: z.array(RoundOptionChipSchema).max(8).optional().describe('澄清问题的可点选选项；仅在本轮需要用户选择时提供'),
  poiLinks: z
    .array(RoundPoiLinkSchema)
    .max(20)
    .optional()
    .describe('回复中提到的地点（用于行内 POI 链接与地图联动）'),
  think: z.string().max(2000).optional().describe('推理过程摘要，用于「思考完成」折叠区'),
  thinkComplete: z.boolean().optional().describe('思考摘要是否已完整'),
  sources: z.array(RoundSourceSchema).max(10).optional().describe('引用来源，用于「来源」折叠区'),
  impacts: z.array(z.string().min(1).max(300)).max(20).optional().describe('修改将影响的日期或安排，每条一句'),
  conflicts: z.array(z.string().min(1).max(300)).max(12).optional().describe('识别出的冲突；patch-explain 回合必须明确列出'),
  compromises: z.array(z.string().min(1).max(300)).max(12).optional().describe('执行修改后为满足约束做出的妥协说明'),
  warnings: z
    .array(RoundWarningSchema)
    .max(20)
    .optional()
    .describe('边界警示：时间约束冲突或超过 6 小时的驾驶段'),
})
export type RoundMetaInput = z.infer<typeof roundMetaInputSchema>

/** Persisted messages may contain round types introduced by later versions. */
export const RoundMetaPayloadSchema = roundMetaInputSchema.extend({ round: z.string() })
export type RoundMetaPayload = z.infer<typeof RoundMetaPayloadSchema>

export type EmitRoundMetaResult = {
  ok: true
  meta: RoundMetaPayload
}

/** Tolerant normalizer (also used by tests to mirror the tool's output). */
export function normalizeRoundMeta(input: unknown): RoundMetaPayload {
  const parsed = roundMetaInputSchema.safeParse(input)
  if (!parsed.success) {
    return { round: 'qa' }
  }
  const data = parsed.data
  return {
    round: data.round,
    ...(data.chips !== undefined && data.chips.length > 0 ? { chips: data.chips } : {}),
    ...(data.poiLinks !== undefined && data.poiLinks.length > 0 ? { poiLinks: data.poiLinks } : {}),
    ...(data.think !== undefined && data.think !== '' ? { think: data.think } : {}),
    ...(data.thinkComplete !== undefined ? { thinkComplete: data.thinkComplete } : {}),
    ...(data.sources !== undefined && data.sources.length > 0 ? { sources: data.sources } : {}),
    ...(data.impacts !== undefined && data.impacts.length > 0 ? { impacts: data.impacts } : {}),
    ...(data.conflicts !== undefined && data.conflicts.length > 0 ? { conflicts: data.conflicts } : {}),
    ...(data.compromises !== undefined && data.compromises.length > 0 ? { compromises: data.compromises } : {}),
    ...(data.warnings !== undefined && data.warnings.length > 0 ? { warnings: data.warnings } : {}),
  }
}

/**
 * Read the round type off a raw tool-call argument object (best effort, used
 * for the `start` SSE event before the tool result arrives). Returns null
 * unless the args carry a known round string.
 */
export function readRoundFromToolArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const round = (args as { round?: unknown }).round
  if (typeof round !== 'string') return null
  return round === 'clarify' || round === 'plan' || round === 'patch-explain' || round === 'qa' ? round : null
}
