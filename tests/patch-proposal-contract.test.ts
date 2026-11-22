/** Compatibility coverage for the extracted existing patch/proposal boundaries. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AiProposalSchema,
  TripPatchSchema,
  patchPoiSchema,
  tripPatchInputSchema,
  proposalItemSchema,
  proposalToolInputSchema,
  proposalRequestSchema,
} from '@hailar/domain'
import {
  parseTripPatchInput,
  tripPatchInputSchema as serverPatchSchema,
} from '../server/src/trip-patch/schema'
import {
  parseProposalToolInput,
  proposalToolInputSchema as serverProposalSchema,
  proposalRequestSchema as serverRequestSchema,
} from '../server/src/ai-proposals/schema'
import { normalizeProposal } from '../src/domain/aiProposals'

const poi = {
  name: ' 酒店 ',
  lat: 49.2,
  lng: 119.7,
  address: '地址',
  introSummary: '简介',
  accommodationBaseId: 'base-1',
  accommodationType: 'hotel',
  accommodationNotes: '迁移备注',
  accommodationMigrationVersion: 1,
}

const proposal = {
  kind: 'parse',
  title: ' 解析建议 ',
  summary: ' 建议摘要 ',
  diff: [{ action: 'add', label: ' 新增住宿 ', itemId: ' item-1 ' }],
  items: [{ itemId: ' item-1 ', dayId: ' day-1 ', type: 'stay', title: ' 酒店 ', poi }],
  patch: {
    ops: [
      { op: 'add_day', dayId: ' day-1 ', date: '2026-10-02' },
      { op: 'add_item', itemId: ' item-1 ', dayId: ' day-1 ', type: 'stay', title: ' 酒店 ', poi },
    ],
  },
}

const metadata = { id: 'proposal-1', tripId: 'trip-1', createdAt: '2026-09-12T00:00:00.000Z' }

test('server adapters use the shared validators and retain readable parse errors', () => {
  assert.equal(TripPatchSchema, tripPatchInputSchema)
  assert.equal(serverPatchSchema, tripPatchInputSchema)
  assert.equal(serverProposalSchema, proposalToolInputSchema)
  assert.equal(serverRequestSchema, proposalRequestSchema)
  assert.deepEqual(parseTripPatchInput(proposal.patch), { ok: true, value: tripPatchInputSchema.parse(proposal.patch) })
  assert.deepEqual(parseProposalToolInput(proposal), { ok: true, value: proposalToolInputSchema.parse(proposal) })

  const badPatch = parseTripPatchInput({ ops: [{ op: 'move_item', itemId: 'i' }] })
  assert.equal(badPatch.ok, false)
  if (!badPatch.ok) assert.match(badPatch.error, /^patch 结构无效：ops\.0\.dayId /)
  const badProposal = parseProposalToolInput({ ...proposal, title: ' ' })
  assert.equal(badProposal.ok, false)
  if (!badProposal.ok) assert.match(badProposal.error, /^建议结构无效：title /)
})

test('patch preserves all seven operations, nullable clearing, unknown-field stripping and title whitespace', () => {
  const parsed = TripPatchSchema.parse({
    extra: 'discard',
    ops: [
      { op: 'add_day', dayId: ' d1 ', date: '2026-99-99', extra: true },
      { op: 'update_day', dayId: 'd1', theme: '' },
      { op: 'remove_day', dayId: 'd2' },
      { op: 'add_item', itemId: ' i1 ', dayId: ' d1 ', type: 'traffic', title: ' ', poi: null, legPending: true },
      { op: 'update_item', itemId: 'i1', note: null, poi: null, type: 'stay' },
      { op: 'move_item', itemId: 'i1', dayId: 'd1', order: 0 },
      { op: 'remove_item', itemId: 'i1' },
    ],
  })
  assert.deepEqual(parsed, {
    ops: [
      // The structural date regex intentionally leaves calendar validity to the applier.
      { op: 'add_day', dayId: 'd1', date: '2026-99-99' },
      { op: 'update_day', dayId: 'd1', theme: '' },
      { op: 'remove_day', dayId: 'd2' },
      { op: 'add_item', itemId: 'i1', dayId: 'd1', type: 'traffic', title: ' ', poi: null, legPending: true },
      { op: 'update_item', itemId: 'i1', note: null, poi: null, type: 'stay' },
      { op: 'move_item', itemId: 'i1', dayId: 'd1', order: 0 },
      { op: 'remove_item', itemId: 'i1' },
    ],
  })
  assert.equal(tripPatchInputSchema.safeParse({ ops: [{ op: 'add_day', dayId: 'd', date: '2026-1-1' }] }).success, false)
  assert.equal(tripPatchInputSchema.safeParse({ ops: [{ op: 'add_item', itemId: 'i', dayId: 'd', type: 'food', title: '餐饮', note: null }] }).success, false)
})

test('stash patch operations share strict authored content, raw notes, metadata and compatible target types', () => {
  const patch = {
    ops: [
      { op: 'add_stash', stashId: ' candidate ', title: '  自由活动  ', note: '  备注\n ', category: '  任意分类  ', poi: null, createdAt: 'ignored' },
      { op: 'move_stash_to_day', stashId: ' candidate ', itemId: ' scheduled ', dayId: ' day ', order: 0, type: 'transit', pending: false, legPending: true, timeRange: ' 午后 ', cost: '' },
    ],
  }
  const parsed = TripPatchSchema.parse(patch)
  assert.deepEqual(parsed.ops[0], { op: 'add_stash', stashId: 'candidate', title: '  自由活动  ', note: '  备注\n ', category: '  任意分类  ', poi: null })
  assert.equal(parsed.ops[1]?.op, 'move_stash_to_day')
  assert.deepEqual(parseTripPatchInput(patch), { ok: true, value: { ops: [parsed.ops[0], { ...parsed.ops[1], type: 'traffic' }] } })
  assert.equal(TripPatchSchema.safeParse({ ops: [{ op: 'add_stash', stashId: 's', title: '候选' }] }).success, true)
  assert.equal(TripPatchSchema.safeParse({ ops: [{ op: 'add_stash', stashId: 's', title: 'x'.repeat(80), category: 'x'.repeat(80), note: 'x'.repeat(500) }] }).success, true)
  for (const fields of [
    { title: ' ' }, { title: 'x'.repeat(81) }, { note: null }, { note: 'x'.repeat(501) },
    { category: ' ' }, { category: 'x'.repeat(81) }, { poi: { name: 'fake' } },
  ]) assert.equal(TripPatchSchema.safeParse({ ops: [{ op: 'add_stash', stashId: 's', title: '候选', ...fields }] }).success, false)
  for (const fields of [{ order: -1 }, { order: 0.5 }, { type: 'hotel' }, { timeRange: null }, { cost: null }, { itemId: ' ' }, { stashId: 'x'.repeat(65) }]) {
    assert.equal(TripPatchSchema.safeParse({ ops: [{ op: 'move_stash_to_day', stashId: 's', itemId: 'i', dayId: 'd', ...fields }] }).success, false)
  }
})

test('patch keeps operation count, identifier and order limits while accepting compatible activity names', () => {
  const op = { op: 'remove_item', itemId: 'x'.repeat(64) }
  assert.equal(tripPatchInputSchema.safeParse({ ops: Array(200).fill(op) }).success, true)
  for (const invalid of [
    { ops: [] },
    { ops: Array(201).fill(op) },
    { ops: [{ ...op, itemId: 'x'.repeat(65) }] },
    { ops: [{ ...op, itemId: ' ' }] },
    { ops: [{ op: 'replace_trip' }] },
    { ops: [{ op: 'move_item', itemId: 'i', dayId: 'd', order: -1 }] },
    { ops: [{ op: 'move_item', itemId: 'i', dayId: 'd', order: 0.5 }] },
    { ops: [{ op: 'add_item', itemId: 'i', dayId: 'd', type: 'hotel', title: '酒店' }] },
  ]) assert.equal(tripPatchInputSchema.safeParse(invalid).success, false)
  const alias = { ops: [{ op: 'add_item', itemId: 'i', dayId: 'd', type: 'accommodation', title: '酒店' }] }
  const parsed = parseTripPatchInput(alias)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.value, { ops: [{ ...alias.ops[0], type: 'stay' }] })
})

test('patch and proposal POIs preserve accommodation metadata and all-or-nothing coordinates', () => {
  assert.deepEqual(patchPoiSchema.parse({ ...poi, ignored: true }), poi)
  assert.deepEqual(proposalItemSchema.parse(proposal.items[0]).poi, poi)
  for (const invalid of [
    { name: '酒店', lat: 49.2 },
    { ...poi, lat: 91 },
    { ...poi, lng: -181 },
    { ...poi, rating: 5.1 },
    { ...poi, accommodationMigrationVersion: 0 },
    { ...poi, accommodationMigrationVersion: 1.5 },
    { ...poi, accommodationMigrationVersion: 101 },
    { ...poi, accommodationType: 'stay' },
  ]) {
    assert.equal(patchPoiSchema.safeParse(invalid).success, false)
    assert.equal(proposalItemSchema.safeParse({ ...proposal.items[0], poi: invalid }).success, false)
  }
  assert.equal(proposalItemSchema.safeParse({ ...proposal.items[0], poi: null }).success, true)
  assert.equal(proposalItemSchema.safeParse({ ...proposal.items[0], poi: undefined }).success, true)
})

test('proposal trims preview text while nested patch titles and optional notes keep their existing whitespace', () => {
  const parsed = proposalToolInputSchema.parse({ ...proposal, extra: true })
  assert.equal(parsed.title, '解析建议')
  assert.equal(parsed.summary, '建议摘要')
  assert.equal(parsed.diff[0]?.label, '新增住宿')
  assert.equal(parsed.diff[0]?.itemId, 'item-1')
  assert.equal(parsed.items?.[0]?.title, '酒店')
  const addItem = parsed.patch.ops[1]
  assert.ok(addItem?.op === 'add_item')
  assert.equal(addItem.title, ' 酒店 ')
  assert.equal(addItem.poi?.name, ' 酒店 ')
  assert.deepEqual(AiProposalSchema.parse({ ...proposal, ...metadata }), { ...parsed, ...metadata })
  assert.equal(proposalItemSchema.parse({ ...proposal.items[0], note: ' 备注 ' }).note, ' 备注 ')
  assert.equal(proposalItemSchema.safeParse({ ...proposal.items[0], title: ' ' }).success, false)
})

test('proposal request and tool schemas leave kind-specific requirements to the existing routes/tools', () => {
  assert.deepEqual(proposalRequestSchema.parse({ kind: 'parse', text: ' 攻略 ', extra: true }), { kind: 'parse', text: '攻略' })
  assert.deepEqual(proposalRequestSchema.parse({ kind: 'day-optimize', dayId: ' day-1 ' }), { kind: 'day-optimize', dayId: 'day-1' })
  assert.equal(proposalRequestSchema.safeParse({ kind: 'parse' }).success, true)
  assert.equal(proposalRequestSchema.safeParse({ kind: 'day-optimize' }).success, true)
  assert.equal(proposalRequestSchema.safeParse({ kind: 'optimize', text: 'x'.repeat(20001) }).success, false)
  assert.equal(proposalRequestSchema.safeParse({ kind: 'optimize', dayId: ' ' }).success, false)
  assert.equal(proposalToolInputSchema.safeParse({ ...proposal, items: undefined }).success, true)
  assert.equal(proposalToolInputSchema.safeParse({ ...proposal, kind: 'day-optimize' }).success, true)
  assert.equal(proposalToolInputSchema.safeParse({ ...proposal, diff: [] }).success, false)
  assert.equal(proposalToolInputSchema.safeParse({ ...proposal, diff: Array(101).fill(proposal.diff[0]) }).success, false)
  assert.equal(proposalToolInputSchema.safeParse({ ...proposal, items: Array(201).fill(proposal.items[0]) }).success, false)
})

test('client preview keeps its tolerant patch envelope and filters invalid diff/item rows', () => {
  const raw = {
    ...proposal,
    ...metadata,
    title: ' 预览标题 ',
    summary: ' 预览摘要 ',
    patch: { ops: [{ op: 'add_day' }], ignored: true },
    diff: [...proposal.diff, null, { action: 'invalid', label: '丢弃' }],
    items: [...proposal.items, null, { itemId: 'invalid' }],
  }
  assert.equal(AiProposalSchema.safeParse(raw).success, false)
  const parsed = normalizeProposal(raw, 'trip-1')
  assert.ok(parsed)
  assert.equal(parsed.title, ' 预览标题 ')
  assert.equal(parsed.summary, ' 预览摘要 ')
  assert.equal(parsed.diff.length, 1)
  assert.equal(parsed.items?.length, 1)
  assert.deepEqual(parsed.patch, { ops: [{ op: 'add_day' }] })
  assert.deepEqual(parsed.items?.[0]?.poi, { name: '酒店', lat: 49.2, lng: 119.7 })
  assert.equal(normalizeProposal(raw, 'another-trip'), null)
})
