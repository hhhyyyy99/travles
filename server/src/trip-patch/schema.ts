/** Server parse/error adapter for the shared `apply_trip_patch` contract. */
import { tripPatchInputSchema } from '@hailar/domain'
import type { TripPatchInput } from '@hailar/domain'

export { patchPoiSchema, tripPatchOpSchema, tripPatchInputSchema } from '@hailar/domain'
export type { TripPatchInput } from '@hailar/domain'

/**
 * Parse a raw tool input through the schema. Returns a readable Chinese
 * error string on failure (fed back to the model for its retry), or the
 * parsed ops.
 */
export function parseTripPatchInput(raw: unknown): { ok: true; value: TripPatchInput } | { ok: false; error: string } {
  const parsed = tripPatchInputSchema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'ops'
  const message = issue ? issue.message : 'patch 结构无效'
  return { ok: false, error: `patch 结构无效：${path} ${message}` }
}
