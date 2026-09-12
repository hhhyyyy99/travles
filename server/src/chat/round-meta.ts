/**
 * Round metadata (ticket 07) — the structured half of a chat turn.
 *
 * The planner agent has one dedicated tool, `emit_round_meta`, that the model
 * calls once per turn to emit the structured round payload (round type,
 * clarify option chips, inline POI links, think summary, sources) alongside
 * its streamed prose. The chat route reads the validated tool result off the
 * agent's full stream and:
 *
 *  1. uses `round` to type the `start` SSE event (when the tool call lands
 *     before the first text delta),
 *  2. echoes the whole payload to the client as a `meta` SSE event,
 *  3. persists it on the assistant message (think/sources/meta columns).
 *
 * Tool-call emission (rather than a fenced JSON block parsed from the text)
 * keeps the structured channel separate from the user-visible prose and is
 * the same pattern ticket 08's `apply_trip_patch` will use.
 */
import { z } from 'zod'
import { createTool } from '@mastra/core/tools'

/** One clickable clarify option (rendered as a chip; clicking sends `value`). */
export type RoundOptionChip = {
  label: string
  value: string
}

/** A place the model mentions; the client focuses the map on it when clicked. */
export type RoundPoiLink = {
  name: string
  lat: number
  lng: number
  amapId?: string
}

/** One citation behind the "来源" collapsible section. */
export type RoundSource = {
  title: string
  url: string
}

/** A boundary warning surfaced alongside a round (conflict or long drive). */
export type RoundWarning = {
  kind: 'time-conflict' | 'long-drive'
  title: string
  message: string
  suggestion?: string
  from?: string
  to?: string
  durationMin?: number
  /** True when the warning uses coordinates rather than a verified road route. */
  estimated?: boolean
}

/**
 * Structured payload emitted by `emit_round_meta` (one call per turn).
 *
 * - `round`: the protocol round this turn belongs to (PRD 附录 B). `clarify`
 *   when the turn asks about one key variable with option chips; `qa` for
 *   plain questions. `plan` / `patch-explain` are reserved for tickets 08/11.
 * - `chips`: clickable options for the current clarify question (usually
 *   present only on clarify rounds).
 * - `poiLinks`: places mentioned in the prose; name must appear in the text
 *   so the client can render it as an inline link.
 * - `think` + `thinkComplete`: reasoning summary for the "思考完成" collapsible
 *   (empty/absent → the section is hidden).
 * - `sources`: citations for the "来源" collapsible (absent → hidden).
 * - `impacts`/`conflicts`/`compromises`: structured patch-explain details.
 * - `warnings`: deterministic boundary warnings such as a long drive.
 */
export type RoundMetaPayload = {
  round: string
  chips?: RoundOptionChip[]
  poiLinks?: RoundPoiLink[]
  think?: string
  thinkComplete?: boolean
  sources?: RoundSource[]
  /** Patch-explain impact/conflict details; omitted on ordinary rounds. */
  impacts?: string[]
  conflicts?: string[]
  compromises?: string[]
  warnings?: RoundWarning[]
}

/** Zod schema of the tool input — doubles as the validation contract. */
export const roundMetaInputSchema = z.object({
  round: z.enum(['clarify', 'qa', 'plan', 'patch-explain']).describe('本轮对话的回合类型'),
  chips: z
    .array(
      z.object({
        label: z.string().min(1).max(40).describe('选项展示文案，如「🚗 自驾/租车自驾」'),
        value: z.string().min(1).max(200).describe('点击选项后作为用户回复发送的文本'),
      }),
    )
    .max(8)
    .optional()
    .describe('澄清问题的可点选选项；仅在本轮需要用户选择时提供'),
  poiLinks: z
    .array(
      z.object({
        name: z.string().min(1).max(60).describe('地名，必须原样出现在回复正文中'),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        amapId: z.string().max(64).optional(),
      }),
    )
    .max(20)
    .optional()
    .describe('回复中提到的地点（用于行内 POI 链接与地图联动）'),
  think: z.string().max(2000).optional().describe('推理过程摘要，用于「思考完成」折叠区'),
  thinkComplete: z.boolean().optional().describe('思考摘要是否已完整'),
  sources: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        url: z.string().min(1).max(500),
      }),
    )
    .max(10)
    .optional()
    .describe('引用来源，用于「来源」折叠区'),
  impacts: z
    .array(z.string().min(1).max(300))
    .max(20)
    .optional()
    .describe('修改将影响的日期或安排，每条一句'),
  conflicts: z
    .array(z.string().min(1).max(300))
    .max(12)
    .optional()
    .describe('识别出的冲突；patch-explain 回合必须明确列出'),
  compromises: z
    .array(z.string().min(1).max(300))
    .max(12)
    .optional()
    .describe('执行修改后为满足约束做出的妥协说明'),
  warnings: z
    .array(
      z.object({
        kind: z.enum(['time-conflict', 'long-drive']),
        title: z.string().min(1).max(120),
        message: z.string().min(1).max(400),
        suggestion: z.string().max(400).optional(),
        from: z.string().max(120).optional(),
        to: z.string().max(120).optional(),
        durationMin: z.number().finite().min(0).optional(),
        estimated: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional()
    .describe('边界警示：时间约束冲突或超过 6 小时的驾驶段'),
})

export type EmitRoundMetaResult = {
  ok: true
  meta: RoundMetaPayload
}

/**
 * Build the `emit_round_meta` tool. The model calls it once per turn; the
 * execute function just normalizes the (schema-validated) input and returns
 * it, so the chat route can read it back from the stream's tool results.
 */
export function createEmitRoundMetaTool() {
  return createTool({
    id: 'emit_round_meta',
    description:
      '每轮回复必须调用一次：上报本轮回合类型与结构化元数据（澄清选项 chips、patch-explain 的影响/冲突/妥协、边界警示、行内地点 POI 链接、思考摘要、来源）。正文之外的所有结构化信息只通过本工具输出，不要写进正文。',
    inputSchema: roundMetaInputSchema,
    execute: async (input): Promise<EmitRoundMetaResult> => {
      const meta = normalizeRoundMeta(input)
      return { ok: true, meta }
    },
  })
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
