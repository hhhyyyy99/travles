import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ActivityItemMetadataSchema,
  ActivityItemSchema,
  TripCanvasSchema,
  readActivityItemMetadata,
  type ActivityItem,
  type Day,
  type TripSummary,
} from '@hailar/domain'
import {
  applyItemInsert,
  applyItemMove,
  applyItemPatch,
  applyItemReplace,
  copyWorkbenchItem,
  createWorkbenchDay,
  createWorkbenchItem,
  fetchTripCanvas,
  moveWorkbenchItem,
  updateWorkbenchDay,
  updateWorkbenchItem,
  type WorkbenchItemCreateInput,
  type WorkbenchItemPatch,
} from '../src/domain/workbench'
import { applyAiProposal, createAiProposal, normalizeProposal } from '../src/domain/aiProposals'
import { normalizeAppliedPatch } from '../src/domain/chat'
import type { ApiResult, FetchLike } from '../src/domain/tripList'

const trip: TripSummary = {
  id: 'trip-1', title: 'Trip', startDate: '', endDate: '', days: 0, nights: 0, createdAt: '', updatedAt: '',
}
const item: ActivityItem = {
  id: 'item-1', dayId: 'day-1', order: 0, type: 'traffic', title: '20:00 transfer ¥100',
  note: 'An independent note: 21:00, ¥200', poi: null, images: [], pending: false,
}
const day: Day = { id: 'day-1', index: 0, date: '', theme: '', color: '', items: [item] }
const invalidMetadata = [null, 42, false, {}, [], new Uint8Array([65, 66])]
const metadataCases = [
  {}, { timeRange: '' }, { cost: '' }, { timeRange: '', cost: '' },
  { timeRange: '  22:00 → 次日 02:00 UTC+8\n', cost: '\t估算 USD 20–30 / 人  ' },
  { timeRange: ' ', cost: '\n\t' },
  { timeRange: 'x'.repeat(2001), cost: 'y'.repeat(2001) },
]

test('ActivityItem metadata has no defaults, coercion, text limits or sibling-field coupling', () => {
  assert.deepEqual(ActivityItemSchema.parse(item), item)
  for (const metadata of metadataCases) {
    assert.deepEqual(ActivityItemMetadataSchema.parse(metadata), metadata)
    assert.deepEqual(ActivityItemSchema.parse({ ...item, ...metadata }), { ...item, ...metadata })
    assert.deepEqual(readActivityItemMetadata(metadata), metadata)
  }
  assert.deepEqual(readActivityItemMetadata({ timeRange: undefined, cost: undefined }), {})
  for (const field of ['timeRange', 'cost']) {
    for (const value of invalidMetadata) {
      assert.equal(ActivityItemSchema.safeParse({ ...item, [field]: value }).success, false)
      const sibling = field === 'timeRange' ? { cost: '  valid cost  ' } : { timeRange: '\tvalid time\n' }
      assert.deepEqual(readActivityItemMetadata({ [field]: value, ...sibling }), sibling)
    }
  }
})

test('item create/update API types serialize explicit author text exactly and omit undefined metadata', async () => {
  const input: WorkbenchItemCreateInput = {
    dayId: day.id, title: item.title, timeRange: '  夜间\n次日  ', cost: '',
  }
  const patch: WorkbenchItemPatch = { timeRange: '', cost: '\tEUR 10–20  ' }
  const calls: Array<{ url: string; method?: string; body: unknown }> = []
  const transport: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url, method: init?.method, body })
    return Response.json({ item: { ...item, ...readActivityItemMetadata(body) }, legs: [] })
  }
  const created = await createWorkbenchItem('trip / 1', input, transport)
  assert.deepEqual(created, { ok: true, data: { item: { ...item, timeRange: input.timeRange, cost: '' }, legs: [] } })
  assert.deepEqual(await updateWorkbenchItem('trip / 1', 'item / 1', patch, transport), {
    ok: true, data: { ...item, ...patch },
  })
  assert.deepEqual(await updateWorkbenchItem(trip.id, item.id, { title: 'New title', timeRange: undefined, cost: undefined }, transport), {
    ok: true, data: item,
  }, 'response normalization never copies metadata from a request')
  const oldServer = await createWorkbenchItem(trip.id, input, async () => Response.json({ item, legs: [] }))
  assert.deepEqual(oldServer, { ok: true, data: { item, legs: [] } })
  assert.deepEqual(calls, [
    { url: '/api/trips/trip%20%2F%201/items', method: 'POST', body: input },
    { url: '/api/trips/trip%20%2F%201/items/item%20%2F%201', method: 'PATCH', body: patch },
    { url: '/api/trips/trip-1/items/item-1', method: 'PATCH', body: { title: 'New title' } },
  ])
})

const itemReaders: Record<string, (rawItem: unknown) => Promise<ApiResult<ActivityItem>>> = {
  create: async (rawItem) => {
    const result = await createWorkbenchItem(trip.id, { dayId: day.id, title: item.title }, async () => Response.json({ item: rawItem, legs: [] }))
    return result.ok ? { ok: true, data: result.data.item } : result
  },
  update: (rawItem) => updateWorkbenchItem(trip.id, item.id, {}, async () => Response.json({ item: rawItem })),
  move: async (rawItem) => {
    const result = await moveWorkbenchItem(trip.id, item.id, {}, async () => Response.json({ item: rawItem, legs: [] }))
    return result.ok ? { ok: true, data: result.data.item } : result
  },
  copy: async (rawItem) => {
    const result = await copyWorkbenchItem(trip.id, item.id, {}, async () => Response.json({ item: rawItem, legs: [] }))
    return result.ok ? { ok: true, data: result.data.item } : result
  },
  canvas: async (rawItem) => {
    const result = await fetchTripCanvas(trip.id, async () => Response.json({ trip, days: [{ ...day, items: [rawItem] }], legs: [] }))
    if (!result.ok) return result
    assert.equal(result.data.days[0]?.items.length, 1)
    return { ok: true, data: result.data.days[0]!.items[0]! }
  },
  'day create': async (rawItem) => {
    const result = await createWorkbenchDay(trip.id, {}, async () => Response.json({ day: { ...day, items: [rawItem] } }))
    if (!result.ok) return result
    assert.equal(result.data.items.length, 1)
    return { ok: true, data: result.data.items[0]! }
  },
  'day update': async (rawItem) => {
    const result = await updateWorkbenchDay(trip.id, day.id, {}, async () => Response.json({ day: { ...day, items: [rawItem] } }))
    if (!result.ok) return result
    assert.equal(result.data.items.length, 1)
    return { ok: true, data: result.data.items[0]! }
  },
}

for (const [path, readItem] of Object.entries(itemReaders)) {
  test(`${path} preserves explicit valid metadata, omits malformed siblings independently and never guesses from title/note`, async () => {
    for (const metadata of metadataCases) {
      assert.deepEqual(await readItem({ ...item, ...metadata }), { ok: true, data: { ...item, ...metadata } })
    }
    for (const invalid of invalidMetadata) {
      assert.deepEqual(await readItem({ ...item, timeRange: invalid, cost: '  valid cost\n' }), {
        ok: true, data: { ...item, cost: '  valid cost\n' },
      })
      assert.deepEqual(await readItem({ ...item, timeRange: '\tvalid time  ', cost: invalid }), {
        ok: true, data: { ...item, timeRange: '\tvalid time  ' },
      })
    }
    assert.deepEqual(await readItem({ ...item, timeRange: null, cost: null }), { ok: true, data: item })
  })
}

test('optimistic copy/move/patch and canvas snapshots retain metadata without mutating rollback data', () => {
  const original = [{ ...day, items: [{ ...item, timeRange: '  next day\n', cost: '' }] },
    { ...day, id: 'day-2', index: 1, items: [] }]
  const rollback = structuredClone(original)
  const source = original[0]!.items[0]!
  const temp = { ...source, id: 'pending-copy', dayId: 'day-2', pending: true }
  const copied = applyItemInsert(original, temp, 'day-2')
  const moved = applyItemMove(copied, source.id, 'day-2', 1)
  const patched = applyItemPatch(moved, temp.id, { note: 'Unrelated note change' })
  assert.deepEqual(readActivityItemMetadata(patched[1]!.items[0]), { timeRange: '  next day\n', cost: '' })
  assert.deepEqual(readActivityItemMetadata(patched[1]!.items[1]), { timeRange: '  next day\n', cost: '' })
  const replaced = applyItemReplace(patched, temp.id, { ...source, id: 'new-copy', timeRange: '', cost: '  new cost\n' })
  assert.deepEqual(readActivityItemMetadata(replaced[1]!.items[0]), { timeRange: '', cost: '  new cost\n' })
  assert.equal(replaced[1]!.items[0]!.dayId, 'day-2', 'replacement keeps the optimistic layout')
  // Printing receives this same complete canvas shape; serialization must not strip fields.
  assert.deepEqual(TripCanvasSchema.parse(JSON.parse(JSON.stringify({ days: replaced, legs: [] }))), { days: replaced, legs: [] })
  assert.deepEqual(original, rollback)
})

test('optimistic replacement takes metadata only from the server response, including explicit clears and independent invalid fields', () => {
  const cachedDays = [{ ...day, items: [{ ...item, id: 'pending', timeRange: 'cached time', cost: 'cached cost' }] }]
  for (const metadata of [...metadataCases, { timeRange: null, cost: ' valid\n' }, { timeRange: '\tvalid ', cost: 42 }]) {
    const rawServer = { ...item, id: 'persisted', ...metadata } as ActivityItem
    const replaced = applyItemReplace(cachedDays, 'pending', rawServer)[0]!.items[0]!
    assert.deepEqual(replaced, { ...item, id: 'persisted', ...readActivityItemMetadata(metadata) })
  }
  assert.deepEqual(readActivityItemMetadata(cachedDays[0]!.items[0]), { timeRange: 'cached time', cost: 'cached cost' })
})

test('authoritative update and move responses remove missing/malformed cached metadata after optimistic edits', async () => {
  const cached = [{ ...day, items: [{ ...item, timeRange: 'cached time', cost: 'cached cost' }] },
    { ...day, id: 'day-2', index: 1, items: [] }]
  const optimisticEdit = applyItemPatch(cached, item.id, { note: 'new note' })
  for (const metadata of [{}, { timeRange: null, cost: ' valid cost\n' }, { timeRange: '', cost: 42 }]) {
    const serverItem = { ...item, note: 'new note', ...metadata }
    const response = await updateWorkbenchItem(trip.id, item.id, { note: 'new note' }, async () => Response.json({ item: serverItem }))
    assert.ok(response.ok)
    if (!response.ok) continue
    const reconciled = applyItemReplace(optimisticEdit, item.id, response.data)
    assert.deepEqual(reconciled[0]!.items[0], { ...item, note: 'new note', ...readActivityItemMetadata(metadata) })
    const moved = applyItemMove(cached, item.id, 'day-2', 0)
    const moveResponse = await moveWorkbenchItem(trip.id, item.id, { dayId: 'day-2', index: 0 }, async () => Response.json({
      item: { ...serverItem, dayId: 'day-2' }, legs: [],
    }))
    assert.ok(moveResponse.ok)
    if (!moveResponse.ok) continue
    assert.deepEqual(applyItemReplace(moved, item.id, moveResponse.data.item)[1]!.items[0], {
      ...item, dayId: 'day-2', note: 'new note', ...readActivityItemMetadata(metadata),
    })
  }
  assert.deepEqual(readActivityItemMetadata(cached[0]!.items[0]), { timeRange: 'cached time', cost: 'cached cost' })
})

test('proposal previews and applied patch/chat records preserve explicit metadata without changing opaque patch operations', async () => {
  const baseItem = { itemId: item.id, dayId: day.id, type: item.type, title: item.title }
  const patch = { ops: [{ op: 'update_item', itemId: item.id, timeRange: '', cost: '  ¥100 / 人\n' }] }
  const proposal = {
    id: 'proposal-1', tripId: trip.id, kind: 'parse', title: 'Preview', summary: 'Changes',
    diff: [{ action: 'update', label: 'Change metadata' }], items: [baseItem], patch, createdAt: '',
  }
  for (const metadata of [...metadataCases, { timeRange: null, cost: ' valid\n' }, { timeRange: '\tvalid ', cost: 42 }]) {
    const decoded = normalizeProposal({ ...proposal, items: [{ ...baseItem, ...metadata }] })
    assert.deepEqual(decoded?.items, [{ ...baseItem, ...readActivityItemMetadata(metadata) }])
    assert.deepEqual(decoded?.patch, patch)
  }
  const withMetadata = { ...proposal, items: [{ ...baseItem, timeRange: '', cost: '\tEUR 20  ' }] }
  const created = await createAiProposal(trip.id, { kind: 'parse', text: 'Explicit preview' }, async () => Response.json({ proposal: withMetadata }))
  assert.ok(created.ok)
  if (created.ok) assert.deepEqual(created.data.items, withMetadata.items)
  const record = { summary: 'Applied', patch }
  const applied = await applyAiProposal(trip.id, proposal.id, async () => Response.json({ proposalId: proposal.id, appliedPatch: record }))
  assert.deepEqual(applied, { ok: true, data: { proposalId: proposal.id, appliedPatch: record } })
  assert.deepEqual(normalizeAppliedPatch(record), record)
})
