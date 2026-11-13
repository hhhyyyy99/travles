/**
 * TripPatch zod schema (ticket 08) — the validation contract for the
 * `apply_trip_patch` tool input. The schema doubles as the JSON schema the
 * model sees (Mastra derives it from the zod definition), so the .describe()
 * texts below are user-facing prompts in the tool-calling protocol.
 *
 * Design notes:
 * - Ops execute strictly in array order; later ops see earlier ones' effects
 *   (an add_day can be followed by add_item referencing its dayId).
 * - Every op carries caller-generated ids (dayId/itemId) so a single patch
 *   can reference what it creates. Ids are 1..64 chars, trimmed.
 * - `poi` is all-or-nothing: a card either carries usable coordinates
 *   (name + lat + lng) or none (poi omitted/null → plain-text card).
 * - `legPending: true` declares "the legs around this card are 待定" for
 *   cards without coordinates that the user has NOT confirmed as pending —
 *   e.g. pure-text transfer cards. Server reachability validation enforces:
 *   every adjacent pair touched by the patch has coordinates on both ends,
 *   or is flagged 待定 (either endpoint pending or legPending).
 * - Top-level extra fields are dropped, unknown `op` values are rejected by
 *   the discriminated union — the model gets a precise error back and can
 *   retry (the chat route never fails the stream on a rejected patch).
 *
 * Extracted without changing the current API/storage vocabulary or limits.
 */
import { z } from 'zod'
import { ActivityItemMetadataSchema, DaySchema } from './trip.js'

const idField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('由你生成的稳定 id（1-64 字符），同一 patch 内引用新建对象时使用它')

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('日期，YYYY-MM-DD')

export const patchPoiSchema = z.object({
  name: z.string().min(1).max(60).describe('地点名称'),
  lat: z.number().min(-90).max(90).describe('纬度'),
  lng: z.number().min(-180).max(180).describe('经度'),
  amapId: z.string().max(64).optional().describe('高德 POI id（如有）'),
  address: z.string().max(500).optional().describe('地址（如有）'),
  category: z.string().max(30).optional().describe('地点类型，如 景点/酒店/餐饮'),
  rating: z.number().min(0).max(5).optional().describe('评分（如有）'),
  introSummary: z.string().max(1000).optional().describe('地点简介（如有）'),
  accommodationBaseId: z.string().max(200).optional().describe('住宿基地 id（迁移数据内部字段）'),
  accommodationType: z.enum(['area', 'hotel']).optional().describe('住宿基地类型（迁移数据内部字段）'),
  accommodationNotes: z.string().max(2000).optional().describe('住宿基地备注（迁移数据内部字段）'),
  accommodationMigrationVersion: z.number().int().positive().max(100).optional().describe('住宿迁移版本（内部字段）'),
})

const addDayOp = z.object({
  op: z.literal('add_day'),
  dayId: idField.describe('新一天的 id'),
  date: dateField.optional().describe('日期；省略则排在最后一天的次日'),
  title: DaySchema.shape.title.describe('当天标题；省略则不设置，空字符串保留为空'),
  note: DaySchema.shape.note.describe('当天备注；省略则不设置，空字符串保留为空'),
  theme: z.string().max(200).optional().describe('当天主题，如「草原穿越日」'),
})

const updateDayOp = z.object({
  op: z.literal('update_day'),
  dayId: idField.describe('已存在的一天'),
  date: dateField.optional().describe('新的日期'),
  title: DaySchema.shape.title.describe('新的当天标题；省略保留原值，空字符串清空；不接受 null'),
  note: DaySchema.shape.note.describe('新的当天备注；省略保留原值，空字符串清空；不接受 null'),
  theme: z.string().max(200).optional().describe('新的主题'),
})

const removeDayOp = z.object({
  op: z.literal('remove_day'),
  dayId: idField.describe('要删除的一天（其卡片一并删除）'),
})

const addItemOp = z.object({
  ...ActivityItemMetadataSchema.shape,
  op: z.literal('add_item'),
  itemId: idField.describe('新卡片的 id'),
  dayId: idField.describe('放入哪一天（已存在或本 patch 前面刚创建）'),
  order: z.number().int().min(0).optional().describe('当天内的顺序（0 起）；省略则排在末尾'),
  type: z
    .enum(['traffic', 'stay', 'attraction', 'food', 'other'])
    .describe('卡片类型：交通/住宿/游玩/餐饮/其他'),
  title: z.string().min(1).max(80).describe('卡片标题'),
  note: z.string().max(500).optional().describe('备注（时间安排、提示等）'),
  pending: z.boolean().optional().describe('未确认槽位（如未定酒店）必须为 true，并在正文中标注「待定」'),
  poi: patchPoiSchema.nullable().optional().describe('POI 坐标信息；纯文本卡省略'),
  legPending: z
    .boolean()
    .optional()
    .describe('卡片没有坐标且不算待定确认项时（如纯文本赶路卡），置 true 声明相邻交通段为待定'),
})

const updateItemOp = z.object({
  ...ActivityItemMetadataSchema.shape,
  op: z.literal('update_item'),
  itemId: idField.describe('要修改的卡片'),
  title: z.string().min(1).max(80).optional(),
  note: z.string().max(500).nullable().optional().describe('备注；null 表示清空'),
  type: z.enum(['traffic', 'stay', 'attraction', 'food', 'other']).optional(),
  pending: z.boolean().optional(),
  poi: patchPoiSchema.nullable().optional().describe('新的 POI；null 表示清除坐标'),
  legPending: z.boolean().optional(),
})

const moveItemOp = z.object({
  op: z.literal('move_item'),
  itemId: idField.describe('要移动的卡片'),
  dayId: idField.describe('目标天（可与当前相同，表示仅调序）'),
  order: z.number().int().min(0).optional().describe('目标位置（0 起）；省略则排到末尾'),
})

const removeItemOp = z.object({
  op: z.literal('remove_item'),
  itemId: idField.describe('要删除的卡片'),
})

export const tripPatchOpSchema = z.discriminatedUnion('op', [
  addDayOp,
  updateDayOp,
  removeDayOp,
  addItemOp,
  updateItemOp,
  moveItemOp,
  removeItemOp,
])

/** Full `apply_trip_patch` tool input. */
export const tripPatchInputSchema = z.object({
  ops: z
    .array(tripPatchOpSchema)
    .min(1)
    .max(200)
    .describe('按顺序执行的结构化操作列表（对行程的完整 diff）'),
})

/** Issue #4's TripPatch contract uses the existing tool-input shape. */
export const TripPatchSchema = tripPatchInputSchema
export type TripPatch = z.infer<typeof TripPatchSchema>

export type PatchPoiRef = z.infer<typeof patchPoiSchema>
export type TripPatchOp = z.infer<typeof tripPatchOpSchema>
export type TripPatchInput = z.infer<typeof tripPatchInputSchema>
