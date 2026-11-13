/** Server parse/error adapter for the shared proposal tool and HTTP contracts. */
import { normalizeItemType, proposalToolInputSchema } from '@hailar/domain'
import { normalizeTripPatchTypes } from '../trip-patch/schema.js'
import type { ProposalToolInput } from '@hailar/domain'

export {
  proposalItemSchema,
  proposalChangeSchema,
  proposalToolInputSchema,
  proposalRequestSchema,
} from '@hailar/domain'
export type { ProposalToolInput } from '@hailar/domain'

export function parseProposalToolInput(raw: unknown):
  | { ok: true; value: ProposalToolInput }
  | { ok: false; error: string } {
  const parsed = proposalToolInputSchema.safeParse(raw)
  if (parsed.success) {
    return {
      ok: true,
      value: {
        ...parsed.data,
        patch: normalizeTripPatchTypes(parsed.data.patch),
        ...(parsed.data.items !== undefined ? {
          items: parsed.data.items.map((item) => ({ ...item, type: normalizeItemType(item.type) ?? item.type })),
        } : {}),
      },
    }
  }
  const issue = parsed.error.issues[0]
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'proposal'
  return { ok: false, error: `建议结构无效：${path} ${issue?.message ?? '字段无效'}` }
}
