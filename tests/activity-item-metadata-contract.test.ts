import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ActivityItemSchema, ActivityItemMetadataSchema, GuideDraftSchema, GuideExtractionSchema,
  proposalItemSchema, readActivityItemMetadata, TripPatchSchema,
} from '@hailar/domain'

const item = { id: 'item', dayId: 'day', order: 0, type: 'other', title: '独立活动标题',
  note: '独立活动备注', poi: null, images: [], pending: false }
const metadata = { timeRange: '\t  次日 01:00–03:00 JST\n按现场安排  ', cost: '  ¥100–200 / 人（估算）\n另付停车费\t' }
const draft = (entry: unknown) => ({ title: '原文草稿', destination: '', dateStatus: 'unspecified',
  days: [{ dayNumber: 1, title: '原文第一天', items: [entry] }], warnings: [] })
const guideItem = { type: 'other', title: '活动', note: '独立备注', region: '', poi: null, pending: true }

test('single ActivityItem contract preserves arbitrary author text and explicit empty strings across derived inputs', () => {
  for (const fields of [{}, { timeRange: undefined, cost: undefined }, metadata,
    { timeRange: '', cost: '' }, { timeRange: ' \t\n', cost: '💴'.repeat(2000) }]) {
    const parsed = ActivityItemSchema.parse({ ...item, ...fields })
    assert.deepEqual(parsed, { ...item, ...fields })
    assert.deepEqual(ActivityItemMetadataSchema.parse(fields), fields)
    for (const op of ['add_item', 'update_item']) {
      const patchItem = { op, itemId: 'item', ...(op === 'add_item' ? { dayId: 'day', type: 'other', title: '活动' } : {}), ...fields }
      assert.deepEqual(TripPatchSchema.parse({ ops: [patchItem] }).ops[0], patchItem)
    }
    assert.deepEqual(proposalItemSchema.parse({ itemId: 'item', dayId: 'day', type: 'other', title: '活动', ...fields }),
      { itemId: 'item', dayId: 'day', type: 'other', title: '活动', ...fields })
    assert.deepEqual(GuideDraftSchema.parse(draft({ ...guideItem, ...fields })).days[0]?.items[0], { ...guideItem, ...fields })
  }
  assert.equal(Object.hasOwn(ActivityItemSchema.parse(item), 'timeRange'), false)
  assert.equal(Object.hasOwn(ActivityItemSchema.parse(item), 'cost'), false)
})

test('all strict write contracts reject null/nonstring metadata, while tolerant reads omit each bad sibling independently', () => {
  for (const key of ['timeRange', 'cost']) {
    for (const bad of [null, false, 0, {}, [], new Uint8Array([1])]) {
      const fields = { ...metadata, [key]: bad }
      assert.equal(ActivityItemSchema.safeParse({ ...item, ...fields }).success, false)
      assert.equal(ActivityItemMetadataSchema.safeParse(fields).success, false)
      assert.equal(GuideDraftSchema.safeParse(draft({ ...guideItem, ...fields })).success, false)
      assert.equal(proposalItemSchema.safeParse({ itemId: 'item', dayId: 'day', type: 'other', title: '活动', ...fields }).success, false)
      for (const op of ['add_item', 'update_item']) {
        assert.equal(TripPatchSchema.safeParse({ ops: [{ op, itemId: 'item', dayId: 'day', type: 'other', title: '活动', ...fields }] }).success, false)
      }
      assert.deepEqual(readActivityItemMetadata(fields), key === 'timeRange' ? { cost: metadata.cost } : { timeRange: metadata.timeRange })
    }
  }
  for (const fields of [undefined, null, {}, { title: '08:00', note: '¥100', timeRange: undefined, cost: undefined }]) {
    assert.deepEqual(readActivityItemMetadata(fields), {})
  }
})

test('external guide extraction keeps its established schema and never produces the optional author metadata', () => {
  const extraction = GuideExtractionSchema.parse({ title: '攻略', destination: '成都',
    days: [{ title: '第一天', items: [{ type: 'other', title: '活动', note: '', region: '', ...metadata }] }] })
  assert.deepEqual(extraction.days[0]?.items[0], { type: 'other', title: '活动', note: '', region: '' })
})
