import { z } from 'zod'
import { ItemTypeSchema, TripSummarySchema } from './trip.js'

/** A pasted guide takes precedence over its URL, including after a blocked fetch. */
export const GuideParseRequestSchema = z.object({
  text: z.string().trim().min(1).max(20_000).optional(),
  url: z.string().trim().url().max(2_000).optional(),
}).refine((input) => input.text !== undefined || input.url !== undefined, '请提供攻略链接或正文。')
export type GuideParseRequest = z.infer<typeof GuideParseRequestSchema>

const extractionItemSchema = z.object({
  type: ItemTypeSchema,
  title: z.string().trim().min(1).max(80),
  note: z.string().max(500),
  region: z.string().trim().max(80),
})

/** The model extracts names and ordering only; coordinates must come from POI lookup. */
export const GuideExtractionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  destination: z.string().trim().max(120),
  days: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    items: z.array(extractionItemSchema).min(1).max(20),
  })).min(1).max(31),
}).refine((draft) => draft.days.reduce((count, day) => count + day.items.length, 0) <= 100,
  '攻略草稿最多包含 100 个活动。')
export type GuideExtraction = z.infer<typeof GuideExtractionSchema>

export const GuidePoiSchema = z.object({
  name: z.string().trim().min(1).max(160),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  amapId: z.string().max(120),
  address: z.string().max(500),
})

export const GuideDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  destination: z.string().max(120),
  // Day numbers represent source order, not a reservation or a confirmed date.
  dateStatus: z.literal('unspecified'),
  days: z.array(z.object({
    dayNumber: z.number().int().min(1).max(31),
    title: z.string().min(1).max(120),
    items: z.array(extractionItemSchema.extend({
      poi: GuidePoiSchema.nullable(),
      pending: z.boolean(),
    })).min(1).max(20),
  })).min(1).max(31),
  warnings: z.array(z.string().max(300)).max(5),
}).superRefine((draft, ctx) => {
  if (draft.days.reduce((count, day) => count + day.items.length, 0) > 100) {
    ctx.addIssue({ code: 'custom', path: ['days'], message: '攻略草稿最多包含 100 个活动。' })
  }
  draft.days.forEach((day, index) => {
    if (day.dayNumber !== index + 1) {
      ctx.addIssue({ code: 'custom', path: ['days', index, 'dayNumber'], message: '天数必须从 1 开始连续排列。' })
    }
  })
})
export type GuideDraft = z.infer<typeof GuideDraftSchema>

/** A preview keeps this UUID and payload unchanged when retrying confirmation. */
export const GuideImportRequestSchema = z.object({
  draft: GuideDraftSchema,
  title: z.string().trim().min(1).max(100).optional(),
  importId: z.uuid().transform((value) => value.toLowerCase()),
}).strict()
export type GuideImportRequest = z.infer<typeof GuideImportRequestSchema>

export const GuideImportResultSchema = z.object({ trip: TripSummarySchema })
export type GuideImportResult = z.infer<typeof GuideImportResultSchema>

export const GuideSourceSchema = z.object({
  kind: z.enum(['text', 'url']),
  url: z.string().url().optional(),
})

export const GuideTextRequiredSchema = z.object({
  status: z.literal('text_required'),
  code: z.literal('source_unavailable'),
  guidance: z.string(),
})

export const GuideParseErrorSchema = z.object({
  status: z.literal('error'),
  code: z.enum(['model_unconfigured', 'model_unavailable', 'invalid_extraction']),
  error: z.string(),
})

export const GuideParseResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), source: GuideSourceSchema, draft: GuideDraftSchema }),
  GuideTextRequiredSchema,
  GuideParseErrorSchema,
])
export type GuideParseResult = z.infer<typeof GuideParseResultSchema>
