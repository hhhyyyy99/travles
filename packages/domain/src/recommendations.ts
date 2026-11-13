/**
 * Shared recommendation, stash, and favorite read models.
 *
 * These schemas describe the existing decoded values, not raw SQLite rows or
 * write requests. The tolerant repository and HTTP decoders remain responsible
 * for legacy defaults, coercion, and dropping corrupt entries.
 */
import { z } from 'zod'
import { ItemImageSchema, PoiRefSchema } from './trip.js'

export const RecommendationTypeSchema = z.enum(['attraction', 'food', 'stay', 'other'])
export type RecommendationType = z.infer<typeof RecommendationTypeSchema>

export const RecommendationOriginSchema = z.enum(['recommend', 'favorite'])
export type RecommendationOrigin = z.infer<typeof RecommendationOriginSchema>

/**
 * Keep the frontend's POI metadata, while matching the recommendation decoders:
 * they accept any finite coordinates/rating, empty provider IDs and descriptive
 * strings, and image paths without URL validation.
 */
export const RecommendationPoiSchema = PoiRefSchema.extend({
  id: z.string(),
  type: RecommendationTypeSchema,
  region: z.string(),
  /** Optional provider hierarchy; region remains the existing district label. */
  city: z.string().optional(),
  province: z.string().optional(),
  address: z.string(),
  images: z.array(ItemImageSchema),
})
export type RecommendationPoi = z.infer<typeof RecommendationPoiSchema>

// Check presence without changing the saved text (including surrounding space).
const StashTextSchema = z.string().refine((value) => value.trim().length > 0)

/** Content authored for a stash candidate, independently of any matched POI. */
export const StashContentSchema = z.object({
  title: StashTextSchema.max(80),
  note: z.string().max(500).optional(),
  category: StashTextSchema.max(80).optional(),
  poi: RecommendationPoiSchema.extend({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }).nullable().optional(),
})
export type StashContent = z.infer<typeof StashContentSchema>

export const StashItemSchema = z.object({
  id: z.string(),
  poi: RecommendationPoiSchema.nullable(),
  origin: RecommendationOriginSchema,
  addedAt: z.string(),
  tripId: StashTextSchema.optional(),
  title: StashTextSchema.optional(),
  note: z.string().optional(),
  category: StashTextSchema.optional(),
  createdAt: StashTextSchema.optional(),
})
export type StashItem = z.infer<typeof StashItemSchema>

/** Retain independently valid, explicitly sourced aliases; never infer defaults. */
export function readStashFields(
  value: { tripId?: unknown; title?: unknown; note?: unknown; category?: unknown; createdAt?: unknown },
  expectedTripId?: string,
): Pick<StashItem, 'tripId' | 'title' | 'note' | 'category' | 'createdAt'> {
  const fields: Pick<StashItem, 'tripId' | 'title' | 'note' | 'category' | 'createdAt'> = {}
  for (const key of ['tripId', 'title', 'note', 'category', 'createdAt'] as const) {
    const parsed = StashItemSchema.shape[key].safeParse(value[key])
    if (!parsed.success || parsed.data === undefined) continue
    if (key === 'tripId' && expectedTripId !== undefined && parsed.data !== expectedTripId) continue
    fields[key] = parsed.data
  }
  return fields
}

export const FavoriteItemSchema = z.object({
  id: z.string(),
  poi: RecommendationPoiSchema,
  createdAt: z.string(),
})
export type FavoriteItem = z.infer<typeof FavoriteItemSchema>

/** Repository snapshot; recommendations are assembled separately by the API. */
export const RecommendationsSnapshotSchema = z.object({
  stash: z.array(StashItemSchema),
  favorites: z.array(FavoriteItemSchema),
})
export type RecommendationsSnapshot = z.infer<typeof RecommendationsSnapshotSchema>

/** The frontend read model adds the API's deduplicated recommendations list. */
export const RecommendationsApiSnapshotSchema = RecommendationsSnapshotSchema.extend({
  recommendations: z.array(RecommendationPoiSchema),
})
export type RecommendationsApiSnapshot = z.infer<typeof RecommendationsApiSnapshotSchema>
