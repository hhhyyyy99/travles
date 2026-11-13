/** Server parse/error adapter for the shared `apply_trip_patch` contract. */
import { normalizeItemType, tripPatchInputSchema } from '@hailar/domain'
import type { TripPatchInput } from '@hailar/domain'

export { patchPoiSchema, tripPatchOpSchema, tripPatchInputSchema } from '@hailar/domain'
export type { TripPatchInput } from '@hailar/domain'

/** Keep the shared Mastra schema transform-free; normalize validated inputs here. */
export function normalizeTripPatchTypes(patch: TripPatchInput): TripPatchInput {
  return {
    ...patch,
    ops: patch.ops.map((op) => {
      if (op.op === 'add_item') return { ...op, type: normalizeItemType(op.type) ?? op.type }
      if ((op.op === 'update_item' || op.op === 'move_stash_to_day') && op.type !== undefined) {
        return { ...op, type: normalizeItemType(op.type) ?? op.type }
      }
      return op
    }),
  }
}

/**
 * Parse a raw tool input through the schema. Returns a readable Chinese
 * error string on failure (fed back to the model for its retry), or the
 * parsed ops.
 */
export function parseTripPatchInput(raw: unknown): { ok: true; value: TripPatchInput } | { ok: false; error: string } {
  const parsed = tripPatchInputSchema.safeParse(raw)
  if (parsed.success) return { ok: true, value: normalizeTripPatchTypes(parsed.data) }
  const issue = parsed.error.issues[0]
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'ops'
  const message = issue ? issue.message : 'patch 结构无效'
  return { ok: false, error: `patch 结构无效：${path} ${message}` }
}
