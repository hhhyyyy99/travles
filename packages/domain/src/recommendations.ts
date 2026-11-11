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
  address: z.string(),
  images: z.array(ItemImageSchema),
})
export type RecommendationPoi = z.infer<typeof RecommendationPoiSchema>

export const StashItemSchema = z.object({
  id: z.string(),
  poi: RecommendationPoiSchema,
  origin: RecommendationOriginSchema,
  addedAt: z.string(),
})
export type StashItem = z.infer<typeof StashItemSchema>

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
