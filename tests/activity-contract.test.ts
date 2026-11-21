import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
const { z } = createRequire(new URL('../packages/domain/package.json', import.meta.url))('zod')
import {
  ActivityItemSchema, ActivityTypeSchema, GuideDraftSchema, GuideExtractionSchema,
  ItemTypeInputSchema, ItemTypeSchema, normalizeItemType, proposalToolInputSchema, TripPatchSchema, type ItemTypeInput,
} from '@hailar/domain'
import { fetchTripCanvas, createWorkbenchItem, cardVisual, CARD_TYPE_LABEL } from '../src/domain/workbench'
import { normalizeProposal } from '../src/domain/aiProposals'
import { importGuide, parseGuide } from '../src/domain/guideParsing'

const pairs = [
  ['attraction', 'attraction'], ['transit', 'traffic'], ['dining', 'food'],
  ['accommodation', 'stay'], ['note', 'other'],
] as const
const metadata = { timeRange: ' 次日 01:00 JST\n原文 ', cost: '0' }
const trip = { id: 'trip', title: '行程', startDate: '', endDate: '', days: 1, nights: 0, createdAt: '', updatedAt: '' }
const item = { id: 'item', dayId: 'day', order: 0, type: 'other', title: '标题', note: '备注', poi: null, images: [], pending: false }
const draft = (type: ItemTypeInput) => ({ title: '攻略', destination: '成都', dateStatus: 'unspecified' as const, warnings: [],
  days: [{ dayNumber: 1, title: '第一天', items: [{ type, title: '活动', note: '', region: '', poi: null, pending: true, ...metadata }] }] })

test('shared contracts accept both activity vocabularies while the existing read type stays stable', () => {
  assert.deepEqual(ItemTypeSchema.options, ['traffic', 'stay', 'attraction', 'food', 'other'])
  assert.deepEqual(ActivityTypeSchema.options, ['attraction', 'transit', 'dining', 'accommodation', 'note'])
  for (const [target, legacy] of pairs) {
    for (const type of [target, legacy]) {
      assert.equal(ItemTypeInputSchema.parse(type), type)
      assert.equal(normalizeItemType(type), legacy)
      const patch = { ops: [{ op: 'add_item', itemId: 'item', dayId: 'day', type, title: '活动', ...metadata },
        { op: 'update_item', itemId: 'item', type }] }
      assert.deepEqual(TripPatchSchema.parse(patch), patch, 'model-facing input retains plain JSON Schema')
      const proposal = { kind: 'parse', title: '建议', summary: '说明', diff: [{ action: 'add', label: '新增' }], patch,
        items: [{ itemId: 'item', dayId: 'day', type, title: '活动', ...metadata }] }
      assert.deepEqual(proposalToolInputSchema.parse(proposal), proposal)
      assert.equal(GuideDraftSchema.parse(draft(type)).days[0]?.items[0]?.type, legacy)
    }
    assert.equal(ActivityItemSchema.parse({ ...item, type: legacy, ...metadata }).type, legacy)
    if (target !== legacy) assert.equal(ActivityItemSchema.safeParse({ ...item, type: target }).success, false)
  }
  // AI tool schemas must still be serializable; unsupported Zod transforms would throw here.
  for (const schema of [TripPatchSchema, proposalToolInputSchema]) {
    const json = JSON.stringify(z.toJSONSchema(schema))
    for (const [target, legacy] of pairs) { assert.ok(json.includes(`"${target}"`)); assert.ok(json.includes(`"${legacy}"`)) }
  }
  for (const invalid of [null, undefined, '', 'Dining', ' dining ', 'hotel', 0, {}, [], new String('dining')]) {
    assert.equal(normalizeItemType(invalid), undefined)
    assert.equal(ItemTypeInputSchema.safeParse(invalid).success, false)
  }
  assert.equal(GuideExtractionSchema.safeParse({ title: '攻略', destination: '', days: [{ title: '日', items: [
    { type: 'dining', title: '午餐', note: '', region: '' },
  ] }] }).success, false, 'external extraction vocabulary remains unchanged')
})

test('production canvas and mutation decoders adapt target responses to the existing labels and visuals', async () => {
  for (const [target, legacy] of pairs) {
    const record = { ...item, type: target, ...metadata }
    const canvas = await fetchTripCanvas('trip', async () => Response.json({ trip,
      days: [{ id: 'day', index: 0, date: '', theme: '', color: '', items: [record] }], legs: [] }))
    assert.ok(canvas.ok)
    const decoded = canvas.data.days[0]!.items[0]!
    assert.equal(decoded.type, legacy)
    assert.equal(decoded.timeRange, metadata.timeRange)
    assert.equal(decoded.cost, '0')
    assert.equal(cardVisual(decoded.type), cardVisual(legacy))
    assert.equal(CARD_TYPE_LABEL[decoded.type], CARD_TYPE_LABEL[legacy])
    const created = await createWorkbenchItem('trip', { dayId: 'day', title: '活动', type: target, ...metadata }, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).type, target)
      return Response.json({ item: record, legs: [] })
    })
    assert.ok(created.ok)
    assert.deepEqual(created.data.item, { ...record, type: legacy })
    const badMetadata = await fetchTripCanvas('trip', async () => Response.json({ trip,
      days: [{ id: 'day', items: [{ ...record, timeRange: null, cost: '' }] }] }))
    assert.ok(badMetadata.ok)
    const kept = badMetadata.data.days[0]!.items[0]!
    assert.equal(kept.type, legacy)
    assert.equal(Object.hasOwn(kept, 'timeRange'), false)
    assert.equal(kept.cost, '')
  }
  const canvas = await fetchTripCanvas('trip', async () => Response.json({ trip,
    days: [{ id: 'day', items: [{ ...item, type: 'unknown' }, item] }] }))
  assert.ok(canvas.ok)
  assert.equal(canvas.data.days[0]!.items[0]!.type, 'other')
  assert.equal(Object.hasOwn(canvas.data.days[0]!.items[1]!, 'cost'), false)
})

test('proposal decoder and structured guide preview/confirmation retain metadata while normalizing aliases', async () => {
  for (const [target, legacy] of pairs) {
    const proposal = normalizeProposal({ id: 'proposal', tripId: 'trip', kind: 'parse', title: '建议', summary: '说明',
      createdAt: '', diff: [{ action: 'add', label: '新增' }], patch: { ops: [{ op: 'add_item' }] },
      items: [{ itemId: 'item', dayId: 'day', title: '活动', type: target, ...metadata }] }, 'trip')
    assert.ok(proposal)
    assert.equal(proposal.items?.[0]?.type, legacy)
    assert.equal(proposal.items?.[0]?.cost, '0')
    const preview = await parseGuide({ text: '攻略正文' }, undefined, async () => Response.json({ status: 'ready',
      source: { kind: 'text' }, draft: draft(target) }))
    assert.ok(preview.ok && preview.data.status === 'ready')
    assert.equal(preview.data.draft.days[0]!.items[0]!.type, legacy)
    const imported = await importGuide({ importId: 'b4539f29-fdd4-408a-adce-c1728c51ea4a', draft: draft(target) },
      undefined, async (_url, init) => {
        const submitted = JSON.parse(String(init?.body)).draft.days[0].items[0]
        assert.equal(submitted.type, legacy)
        assert.equal(submitted.timeRange, metadata.timeRange)
        assert.equal(submitted.cost, '0')
        return Response.json({ trip })
      })
    assert.ok(imported.ok)
  }
})
