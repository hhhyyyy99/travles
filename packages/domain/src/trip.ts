/**
 * Shared trip read-model schemas (ticket #4).
 *
 * The single Zod source of truth for the shapes exchanged between the server
 * and the browser: a trip summary, and the canvas read model (Day / Activity
 * item / Leg) that the workbench renders. These schemas deliberately mirror
 * the *existing* persisted and API shapes so they validate real rows and keep
 * every current consumer working. Both server and frontend derive their types
 * from them; the existing tolerant storage and HTTP decoders stay in place.
 *
 * Relationship to the field names proposed in issue #4:
 *   - #4 lists activity types as `attraction|transit|dining|accommodation|note`
 *     and legs as `distanceMeters`/`durationSeconds` with a
 *     `verified|estimated|pending` status. The running system stores
 *     `traffic|stay|attraction|food|other` and legs in `distanceKm`/`durationMin`
 *     with a `reference|estimate|measured|pending` quality, and those values
 *     live in persisted SQLite rows read by 25+ modules. Renaming the stored
 *     vocabulary and units is therefore a breaking, cross-module data/API
 *     migration (it must also rewrite existing rows); it is intentionally not
 *     bundled into this contract slice. `ITEM_TYPE_MAP` records the intended
 *     #4 ⇄ current correspondence so a later migration can be driven from one
 *     place without hunting through consumers.
 *   - `geographicFactCheck` in #4 is still to be designed on top of the
 *     existing warning flow and is not part of this read model yet.
 */
import { z } from 'zod'

/* -------------------------------------------------------------------------- */
/* Trip summary                                                                */
/* -------------------------------------------------------------------------- */

export const TripDateStatusSchema = z.enum(['confirmed', 'unspecified', 'tentative'])
export type TripDateStatus = z.infer<typeof TripDateStatusSchema>

export const TripPlanningContextSchema = z.object({
  destination: z.string(),
  durationDays: z.number(),
  preferences: z.string(),
  originalSentence: z.string(),
  dateStatus: TripDateStatusSchema,
  datePhrase: z.string().optional(),
  // Guide imports retain context without starting an intake conversation.
  source: z.enum(['intake', 'guide']).optional(),
})
export type TripPlanningContext = z.infer<typeof TripPlanningContextSchema>

/**
 * Trip card shape returned by `GET /api/trips`. Optional fields stay optional
 * because older rows and the built-in seed omit them; tolerant readers keep
 * working, they simply don't populate them.
 */
export const TripSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  destination: z.string().optional(),
  startDate: z.string(),
  endDate: z.string(),
  days: z.number(),
  daysCount: z.number().int().positive().optional(),
  nights: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  durationDays: z.number().optional(),
  dateStatus: TripDateStatusSchema.optional(),
  planningContext: TripPlanningContextSchema.optional(),
  coverImage: z.string().optional(),
  isPinned: z.boolean().optional(),
  // Read existing labels without defining a lifecycle or inferring it from dates.
  status: z.string().optional(),
})
export type TripSummary = z.infer<typeof TripSummarySchema>

/** The current Trip wire contract is the summary returned by the trips API. */
export const TripSchema = TripSummarySchema
export type Trip = z.infer<typeof TripSchema>

/* -------------------------------------------------------------------------- */
/* Canvas read model                                                           */
/* -------------------------------------------------------------------------- */

/** Activity types currently persisted (see module note on the #4 mapping). */
export const ItemTypeSchema = z.enum(['traffic', 'stay', 'attraction', 'food', 'other'])
export type ItemType = z.infer<typeof ItemTypeSchema>

/** Intended correspondence between the running vocabulary and issue #4's. */
export const ITEM_TYPE_MAP = {
  attraction: 'attraction',
  traffic: 'transit',
  food: 'dining',
  stay: 'accommodation',
  other: 'note',
} as const satisfies Record<ItemType, string>

/** Provenance of a leg's distance/time. */
export const LegQualitySchema = z.enum(['reference', 'estimate', 'measured', 'pending'])
export type LegQuality = z.infer<typeof LegQualitySchema>

export const PoiRefSchema = z.object({
  amapId: z.string(),
  name: z.string(),
  // Legacy read decoders accept finite coordinates; tools validate bounds.
  lat: z.number(),
  lng: z.number(),
  address: z.string().optional(),
  accommodationBaseId: z.string().optional(),
  accommodationType: z.enum(['area', 'hotel']).optional(),
  accommodationNotes: z.string().optional(),
  accommodationMigrationVersion: z.number().optional(),
  category: z.string(),
  rating: z.number(),
  introSummary: z.string(),
})
export type PoiRef = z.infer<typeof PoiRefSchema>

export const ItemImageSchema = z.object({ url: z.string(), caption: z.string() })
export type ItemImage = z.infer<typeof ItemImageSchema>

/** One canvas card. `poi === null` marks a plain-text card. */
export const ActivityItemSchema = z.object({
  id: z.string(),
  dayId: z.string(),
  order: z.number(),
  type: ItemTypeSchema,
  title: z.string(),
  note: z.string(),
  poi: PoiRefSchema.nullable(),
  images: z.array(ItemImageSchema),
  pending: z.boolean(),
})
export type ActivityItem = z.infer<typeof ActivityItemSchema>

export const DaySchema = z.object({
  id: z.string(),
  // Optional read projections: legacy days retain their existing shape.
  tripId: z.string().optional(),
  dayNumber: z.number().int().positive().optional(),
  index: z.number(),
  date: z.string(),
  // Day metadata is independent of theme and item notes; preserve raw strings.
  title: z.string().optional(),
  note: z.string().optional(),
  theme: z.string(),
  color: z.string(),
  items: z.array(ActivityItemSchema),
})
export type Day = z.infer<typeof DaySchema>

/** Polyline is a list of [lng, lat] pairs, or null when unknown. */
export const LegSchema = z.object({
  id: z.string(),
  fromItemId: z.string(),
  toItemId: z.string(),
  mode: z.string(),
  distanceKm: z.number(),
  durationMin: z.number(),
  polyline: z.array(z.tuple([z.number(), z.number()])).nullable(),
  quality: LegQualitySchema.optional(),
})
export type Leg = z.infer<typeof LegSchema>

export const TripCanvasSchema = z.object({
  days: z.array(DaySchema),
  legs: z.array(LegSchema),
})
export type TripCanvas = z.infer<typeof TripCanvasSchema>
