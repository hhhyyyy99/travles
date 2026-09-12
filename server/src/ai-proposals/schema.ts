/** Zod boundary for the model's proposal tool and the HTTP request payload. */
import { z } from 'zod'
import { tripPatchInputSchema } from '../trip-patch/schema.js'

const poiSchema = z
  .object({
    name: z.string().min(1).max(60),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    amapId: z.string().max(64).optional(),
    address: z.string().max(500).optional(),
    category: z.string().max(30).optional(),
    rating: z.number().min(0).max(5).optional(),
    introSummary: z.string().max(1000).optional(),
    accommodationBaseId: z.string().max(200).optional(),
    accommodationType: z.enum(['area', 'hotel']).optional(),
    accommodationNotes: z.string().max(2000).optional(),
    accommodationMigrationVersion: z.number().int().positive().max(100).optional(),
  })
  .nullable()
  .optional()

export const proposalItemSchema = z.object({
  itemId: z.string().trim().min(1).max(64),
  dayId: z.string().trim().min(1).max(64),
  order: z.number().int().min(0).optional(),
  type: z.enum(['traffic', 'stay', 'attraction', 'food', 'other']),
  title: z.string().trim().min(1).max(80),
  note: z.string().max(500).optional(),
  pending: z.boolean().optional(),
  poi: poiSchema,
  legPending: z.boolean().optional(),
})

export const proposalChangeSchema = z.object({
  action: z.enum(['add', 'update', 'move', 'remove']),
  label: z.string().trim().min(1).max(120),
  detail: z.string().max(500).optional(),
  itemId: z.string().trim().min(1).max(64).optional(),
  dayId: z.string().trim().min(1).max(64).optional(),
  fromDayId: z.string().trim().min(1).max(64).optional(),
  toDayId: z.string().trim().min(1).max(64).optional(),
})

export const proposalToolInputSchema = z.object({
  kind: z.enum(['parse', 'optimize', 'day-optimize']),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1000),
  diff: z.array(proposalChangeSchema).min(1).max(100),
  patch: tripPatchInputSchema,
  items: z.array(proposalItemSchema).max(200).optional(),
  targetDayId: z.string().trim().min(1).max(64).optional(),
})

export type ProposalToolInput = z.infer<typeof proposalToolInputSchema>

export const proposalRequestSchema = z.object({
  kind: z.enum(['parse', 'optimize', 'day-optimize']),
  text: z.string().trim().max(20000).optional(),
  dayId: z.string().trim().min(1).max(64).optional(),
})

export function parseProposalToolInput(raw: unknown):
  | { ok: true; value: ProposalToolInput }
  | { ok: false; error: string } {
  const parsed = proposalToolInputSchema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  const issue = parsed.error.issues[0]
  const path = issue && issue.path.length > 0 ? issue.path.join('.') : 'proposal'
  return { ok: false, error: `建议结构无效：${path} ${issue?.message ?? '字段无效'}` }
}
