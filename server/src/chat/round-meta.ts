/**
 * Round metadata tool (ticket 07) — the structured half of a chat turn.
 *
 * The planner agent has one dedicated tool, `emit_round_meta`, that the model
 * calls once per turn to emit the structured round payload (round type,
 * clarify option chips, inline POI links, think summary and sources) alongside
 * its streamed prose. The chat route reads the
 * validated tool result off the agent's full stream and:
 *
 *  1. uses `round` to type the `start` SSE event (when the tool call lands
 *     before the first text delta),
 *  2. echoes the whole payload to the client as a `meta` SSE event,
 *  3. persists it on the assistant message (think/sources/meta columns).
 *
 * The shared `@hailar/domain` package defines the schema and payload types.
 * This module keeps the Mastra tool wrapper.
 */
import { createTool } from '@mastra/core/tools'
import {
  normalizeRoundMeta,
  roundMetaInputSchema,
  type EmitRoundMetaResult,
  type RoundMetaPayload,
} from '@hailar/domain'

// Re-export the shared contract so existing `./round-meta.js` importers keep
// working without reaching into the package.
export {
  normalizeRoundMeta,
  readRoundFromToolArgs,
  roundMetaInputSchema,
} from '@hailar/domain'
export type {
  EmitRoundMetaResult,
  RoundMetaPayload,
  RoundOptionChip,
  RoundPoiLink,
  RoundSource,
  RoundWarning,
} from '@hailar/domain'

/**
 * Build the `emit_round_meta` tool. The model calls it once per turn; the
 * execute function just normalizes the (schema-validated) input and returns
 * it, so the chat route can read it back from the stream's tool results.
 */
export function createEmitRoundMetaTool() {
  return createTool({
    id: 'emit_round_meta',
    description:
      '每轮回复必须调用一次：上报本轮回合类型与结构化元数据（澄清选项 chips、patch-explain 的影响/冲突/妥协、边界警示、地理校验、行内地点 POI 链接、思考摘要、来源）。正文之外的所有结构化信息只通过本工具输出，不要写进正文。',
    inputSchema: roundMetaInputSchema,
    execute: async (input): Promise<EmitRoundMetaResult> => {
      const meta: RoundMetaPayload = normalizeRoundMeta(input)
      return { ok: true, meta }
    },
  })
}
