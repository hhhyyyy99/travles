import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import { ActivityItemSchema, TripCanvasSchema, type ActivityItem } from '@hailar/domain'
import type { MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'

import { createApp } from '../src/app.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import { MemoryContentStoreDriver } from '../src/content/driver-memory.js'
import { SqliteContentStoreDriver } from '../src/content/driver-sqlite.js'
import { createSqliteDaysAdminStore } from '../src/days-admin/driver-sqlite.js'
import { createSqliteWorkbenchStore } from '../src/days/driver-sqlite.js'
import { createSqliteItemsAdminStore } from '../src/items-admin/driver-sqlite.js'
import { MemoryItemsAdminStoreDriver } from '../src/items-admin/driver-memory.js'
import type { ItemFullUpsert } from '../src/items-admin/types.js'
import { applyTripPatch } from '../src/trip-patch/apply.js'
import { createSqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import type { TripPatchItemUpsert } from '../src/trip-patch/types.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'

// URL imports execute the production browser clients without adding their
// bundler-resolved source graph to the server's NodeNext typecheck.
const [workbench, trips, guides, proposals] = await Promise.all([
  import(new URL('../../src/domain/workbench.ts', import.meta.url).href),
  import(new URL('../../src/domain/tripList.ts', import.meta.url).href),
  import(new URL('../../src/domain/guideParsing.ts', import.meta.url).href),
  import(new URL('../../src/domain/aiProposals.ts', import.meta.url).href),
])

const vocabulary = [
  ['transit', 'traffic'], ['accommodation', 'stay'], ['attraction', 'attraction'],
  ['dining', 'food'], ['note', 'other'],
] as const
const metadata = { timeRange: '  23:00 → 次日 02:00 JST\n现场确认  ', cost: '\t约 ¥80–120 / 人\n另付停车费  ' }
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

async function fixture(t: TestContext, plannerModel?: MastraLanguageModel) {
  const sqlite = await createSqliteTripRepository(':memory:')
  t.after(() => sqlite.close())
  const patchStore = createSqliteTripPatchStore(sqlite.db)
  const app = await createApp({
    tripRepository: sqlite.repository, contentRepository: sqlite.contentRepository,
    workbenchStore: createSqliteWorkbenchStore(sqlite.db),
    daysAdminStore: createSqliteDaysAdminStore(sqlite.db),
    itemsAdminStore: createSqliteItemsAdminStore(sqlite.db), tripPatchStore: patchStore,
    guideImportDatabase: sqlite.db, messageStore: new MemoryMessageStoreDriver(),
    ...(plannerModel ? { plannerModel, plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }) } : {}),
  })
  const fetchLike = async (input: string, init?: RequestInit) => app.request(input, init)
  return { ...sqlite, app, fetchLike, patchStore }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function createTrip(f: Fixture, title = '活动兼容行程'): Promise<string> {
  const result = await trips.createTrip({ title, startDate: '2026-10-02', endDate: '2026-10-03' }, f.fetchLike)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(typeof result.data.id, 'string')
  return result.data.id
}

async function createDay(f: Fixture, tripId: string): Promise<string> {
  const result = await workbench.createWorkbenchDay(tripId, {}, f.fetchLike)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result.data.id
}

async function canvas(f: Fixture, tripId: string) {
  const result = await workbench.fetchTripCanvas(tripId, f.fetchLike)
  assert.equal(result.ok, true, JSON.stringify(result))
  return TripCanvasSchema.parse(result.data)
}

async function createItem(f: Fixture, tripId: string, input: Record<string, unknown>): Promise<ActivityItem> {
  const result = await workbench.createWorkbenchItem(tripId, input, f.fetchLike)
  assert.equal(result.ok, true, JSON.stringify(result))
  return ActivityItemSchema.parse(result.data.item)
}

async function editItem(f: Fixture, tripId: string, id: string, input: Record<string, unknown>): Promise<ActivityItem> {
  const result = await workbench.updateWorkbenchItem(tripId, id, input, f.fetchLike)
  assert.equal(result.ok, true, JSON.stringify(result))
  return ActivityItemSchema.parse(result.data)
}

async function content(f: Fixture, tripId: string) {
  const response = await f.app.request(`/api/trips/${tripId}/days`)
  assert.equal(response.status, 200)
  return await response.json() as { days: { id: string; items: { id: string; type: string; timeRange?: string; cost?: string }[] }[] }
}

function assertMetadata(item: ActivityItem, expected: { timeRange?: string; cost?: string }) {
  for (const key of ['timeRange', 'cost'] as const) {
    assert.equal(Object.hasOwn(item, key), Object.hasOwn(expected, key), `${key} presence`)
    assert.equal(item[key], expected[key], key)
  }
}

test('target vocabulary creates legacy cards through SQLite, Hono and the production client', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const dayId = await createDay(f, tripId)
  for (const [alias, legacy] of vocabulary) {
    const result = await workbench.createWorkbenchItem(tripId,
      { dayId, type: alias, title: `标题 ${alias}`, note: '独立备注', ...metadata },
      async (input: string, init?: RequestInit) => {
        const response = await f.fetchLike(input, init)
        assert.equal(response.status, 201)
        const body = await response.clone().json() as { item: { type: string } }
        assert.equal(body.item.type, legacy, 'the HTTP response itself retains legacy vocabulary')
        return response
      })
    assert.equal(result.ok, true, JSON.stringify(result))
    const item = ActivityItemSchema.parse(result.data.item)
    assert.equal(item.type, legacy, alias)
    assert.equal(item.note, '独立备注')
    assertMetadata(item, metadata)
  }
  const read = await canvas(f, tripId)
  assert.deepEqual(read.days[0]!.items.map((item) => item.type), ['traffic', 'stay', 'attraction', 'food', 'other'])
  assert.deepEqual((await content(f, tripId)).days[0]!.items.map((item) => item.type), ['traffic', 'stay', 'attraction', 'food', 'other'])
  assert.deepEqual((await f.db.run('SELECT type, time_range, cost FROM items ORDER BY item_order')).rows,
    ['traffic', 'stay', 'attraction', 'food', 'other'].map((type) => ({ type, time_range: metadata.timeRange, cost: metadata.cost })))
})

test('metadata survives edits, copy and cross-day moves without extending the item PATCH type contract', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const firstDay = await createDay(f, tripId)
  const secondDay = await createDay(f, tripId)
  const item = await createItem(f, tripId, { dayId: firstDay, type: 'transit', title: '原活动', note: '独立备注', ...metadata })
  const oldShape = await createItem(f, tripId, { dayId: firstDay, type: 'note', title: '没有可选元数据' })
  assertMetadata(oldShape, {})
  const edited = await editItem(f, tripId, item.id, { title: '改过的标题', note: '改过的备注' })
  assert.equal(edited.type, 'traffic')
  assertMetadata(edited, metadata)
  const clearedTime = await editItem(f, tripId, item.id, { timeRange: '' })
  assertMetadata(clearedTime, { timeRange: '', cost: metadata.cost })

  const copiedResult = await workbench.copyWorkbenchItem(tripId, item.id, { dayId: secondDay, index: 0 }, f.fetchLike)
  assert.equal(copiedResult.ok, true, JSON.stringify(copiedResult))
  const copied = ActivityItemSchema.parse(copiedResult.data.item)
  assert.notEqual(copied.id, item.id)
  assert.equal(copied.type, 'traffic')
  assert.equal(copied.note, '改过的备注')
  assertMetadata(copied, { timeRange: '', cost: metadata.cost })
  const movedResult = await workbench.moveWorkbenchItem(tripId, item.id, { dayId: secondDay, index: 0 }, f.fetchLike)
  assert.equal(movedResult.ok, true, JSON.stringify(movedResult))
  assertMetadata(ActivityItemSchema.parse(movedResult.data.item), { timeRange: '', cost: metadata.cost })
  assertMetadata(await editItem(f, tripId, item.id, { cost: '' }), { timeRange: '', cost: '' })

  const typeOnly = await f.app.request(`/api/trips/${tripId}/items/${item.id}`, json('PATCH', { type: 'accommodation' }))
  assert.equal(typeOnly.status, 400, 'item PATCH still accepts only supported edit fields')
  const mixed = await f.app.request(`/api/trips/${tripId}/items/${item.id}`, json('PATCH', { type: 'accommodation', title: '仅标题生效' }))
  assert.equal(mixed.status, 200)
  assert.equal((await mixed.json() as { item: { type: string } }).item.type, 'traffic')
  const read = await canvas(f, tripId)
  assert.deepEqual(read.days.map((day) => day.items.map((entry) => entry.id)), [[oldShape.id], [item.id, copied.id]])
  assertMetadata(read.days[0]!.items[0]!, {})
  assertMetadata(read.days[1]!.items[0]!, { timeRange: '', cost: '' })
  assertMetadata(read.days[1]!.items[1]!, { timeRange: '', cost: metadata.cost })
})

test('content PUT maps aliases to legacy storage and preserves omitted metadata on existing items', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const dayId = await createDay(f, tripId)
  const entries = vocabulary.map(([type], itemOrder) => ({ id: `content-${itemOrder}`, dayId, itemOrder, type, title: `内容 ${type}`, note: '独立备注', ...metadata }))
  assert.equal((await f.app.request(`/api/trips/${tripId}/items`, json('PUT', { items: entries }))).status, 200)
  const update = { id: entries[0]!.id, dayId, itemOrder: 0, type: 'dining', title: '更新为餐饮', note: '更新备注' }
  assert.equal((await f.app.request(`/api/trips/${tripId}/items`, json('PUT', { items: [update] }))).status, 200)
  assertMetadata((await canvas(f, tripId)).days[0]!.items[0]!, metadata)
  assert.equal((await f.app.request(`/api/trips/${tripId}/items`, json('PUT', { items: [{ ...update, timeRange: '' }] }))).status, 200)
  assertMetadata((await canvas(f, tripId)).days[0]!.items[0]!, { timeRange: '', cost: metadata.cost })
  assert.equal((await f.app.request(`/api/trips/${tripId}/items`, json('PUT', { items: [{ ...update, cost: '' }] }))).status, 200)
  assertMetadata((await canvas(f, tripId)).days[0]!.items[0]!, { timeRange: '', cost: '' })
  assert.deepEqual((await content(f, tripId)).days[0]!.items.map((item) => item.type), ['food', 'stay', 'attraction', 'food', 'other'])
  assert.deepEqual((await f.db.run('SELECT type FROM items ORDER BY item_order')).rows.map((row) => row.type), ['food', 'stay', 'attraction', 'food', 'other'])
})

test('TripPatch add and update aliases persist legacy types while omitted metadata survives sibling rewrites', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const result = await applyTripPatch(f.patchStore, tripId, { ops: [
    { op: 'add_day', dayId: 'patch-day' },
    ...vocabulary.map(([type], order) => ({ op: 'add_item', itemId: `patch-${order}`, dayId: 'patch-day', type, title: `补丁 ${type}`, note: '补丁备注', pending: true, ...metadata })),
  ] })
  assert.ok(result.ok, result.ok ? undefined : result.error)
  assert.deepEqual((await canvas(f, tripId)).days[0]!.items.map((item) => item.type), ['traffic', 'stay', 'attraction', 'food', 'other'])
  const updated = await applyTripPatch(f.patchStore, tripId, { ops: [
    { op: 'add_day', dayId: 'patch-second' },
    { op: 'update_item', itemId: 'patch-0', type: 'dining', title: '改为餐饮', timeRange: '' },
    { op: 'update_item', itemId: 'patch-1', type: 'accommodation', cost: '' },
    { op: 'move_item', itemId: 'patch-0', dayId: 'patch-second' },
  ] })
  assert.ok(updated.ok, updated.ok ? undefined : updated.error)
  const items = (await canvas(f, tripId)).days.flatMap((day) => day.items)
  assert.equal(items.find((item) => item.id === 'patch-0')!.type, 'food')
  assertMetadata(items.find((item) => item.id === 'patch-0')!, { timeRange: '', cost: metadata.cost })
  assertMetadata(items.find((item) => item.id === 'patch-1')!, { timeRange: metadata.timeRange, cost: '' })
  for (const id of ['patch-2', 'patch-3', 'patch-4']) assertMetadata(items.find((item) => item.id === id)!, metadata)
  assert.deepEqual((await f.db.run('SELECT id, type FROM items ORDER BY id')).rows, [
    { id: 'patch-0', type: 'food' }, { id: 'patch-1', type: 'stay' }, { id: 'patch-2', type: 'attraction' },
    { id: 'patch-3', type: 'food' }, { id: 'patch-4', type: 'other' },
  ])
})

test('accommodation aliases obey stay uniqueness, including a persisted alias loaded before patch validation', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const dayId = await createDay(f, tripId)
  await f.db.run('INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, pending, time_range, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['old-stay', tripId, dayId, 0, 'accommodation', '已存的住宿别名', '旧备注', 1, metadata.timeRange, metadata.cost])
  const other = await createItem(f, tripId, { dayId, type: 'note', title: '普通卡片' })
  const before = (await f.db.run('SELECT * FROM items ORDER BY id')).rows
  for (const op of [
    { op: 'add_item', itemId: 'duplicate-target', dayId, type: 'accommodation', title: '第二住宿', pending: true },
    { op: 'add_item', itemId: 'duplicate-legacy', dayId, type: 'stay', title: '第二旧住宿', pending: true },
    { op: 'update_item', itemId: other.id, type: 'accommodation' },
  ]) {
    const rejected = await applyTripPatch(f.patchStore, tripId, { ops: [op] })
    assert.equal(rejected.ok, false)
    if (!rejected.ok) assert.match(rejected.error, /最多一个过夜住宿/)
    assert.deepEqual((await f.db.run('SELECT * FROM items ORDER BY id')).rows, before)
  }
  const edited = await editItem(f, tripId, 'old-stay', { poi: { name: '可编辑的住宿位置', lat: 49.2, lng: 119.7 } })
  assert.equal(edited.type, 'stay', 'persisted alias is eligible for the existing stay POI editor')
  assert.equal(edited.poi?.name, '可编辑的住宿位置')
  assertMetadata(edited, metadata)
})

test('accommodation aliases require reachable adjacent legs or an explicit pending flag', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const dayId = await createDay(f, tripId)
  await createItem(f, tripId, { dayId, type: 'attraction', title: '有坐标的景点', poi: { name: '景点', lat: 49.1, lng: 119.2 } })
  const before = (await f.db.run('SELECT * FROM items ORDER BY id')).rows
  const op = { op: 'add_item', itemId: 'alias-stay', dayId, type: 'accommodation', title: '尚无坐标的酒店', ...metadata }
  const rejected = await applyTripPatch(f.patchStore, tripId, { ops: [op] })
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.match(rejected.error, /交通段不可达/)
  assert.deepEqual((await f.db.run('SELECT * FROM items ORDER BY id')).rows, before)
  const pending = await applyTripPatch(f.patchStore, tripId, { ops: [{ ...op, pending: true }] })
  assert.ok(pending.ok, pending.ok ? undefined : pending.error)
  const read = await canvas(f, tripId)
  const stay = read.days[0]!.items.find((item) => item.id === 'alias-stay')!
  assert.equal(stay.type, 'stay')
  assert.equal(stay.pending, true)
  assertMetadata(stay, metadata)
  assert.equal(read.legs.length, 1)
  assert.equal(read.legs[0]!.quality, 'pending')
})

test('null and nonstring metadata reject alias writes through item, content, patch and import boundaries', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const dayId = await createDay(f, tripId)
  const item = await createItem(f, tripId, { dayId, type: 'dining', title: '必须保留的活动', ...metadata })
  const before = (await f.db.run('SELECT * FROM items')).rows
  for (const field of ['timeRange', 'cost']) {
    for (const value of [null, 42, false, {}, []]) {
      const fields = { ...metadata, [field]: value }
      const label = `${field}=${JSON.stringify(value)}`
      const created = await f.app.request(`/api/trips/${tripId}/items`, json('POST', { dayId, type: 'accommodation', title: '不能创建', ...fields }))
      assert.equal(created.status, 400, `POST ${label}`)
      const edited = await f.app.request(`/api/trips/${tripId}/items/${item.id}`, json('PATCH', { title: '不能改名', ...fields }))
      assert.equal(edited.status, 400, `PATCH ${label}`)
      const upserted = await f.app.request(`/api/trips/${tripId}/items`, json('PUT', { items: [{ id: item.id, dayId, type: 'transit', title: '不能覆盖', ...fields }] }))
      assert.equal(upserted.status, 400, `PUT ${label}`)
      for (const op of [
        { op: 'add_item', itemId: 'invalid-new', dayId, type: 'accommodation', title: '不能插入', pending: true, ...fields },
        { op: 'update_item', itemId: item.id, type: 'note', title: '不能更新', ...fields },
      ]) {
        const patched = await applyTripPatch(f.patchStore, tripId, { ops: [
          { op: 'update_item', itemId: item.id, title: '有效前序操作也不能写入' }, op,
        ] })
        assert.equal(patched.ok, false, `${op.op} ${label}`)
        if (!patched.ok) assert.equal(patched.code, 'invalid')
      }
      const imported = await f.app.request('/api/trips/from-guide', json('POST', {
        importId: randomUUID(), draft: guideDraft([{ type: 'dining', ...fields }]),
      }))
      assert.equal(imported.status, 400, `guide ${label}`)
      assert.deepEqual((await f.db.run('SELECT * FROM items')).rows, before, label)
    }
  }
  assert.equal((await f.db.run('SELECT COUNT(*) AS count FROM trips')).rows[0]?.count, 1)
  assert.equal((await f.db.run('SELECT COUNT(*) AS count FROM guide_imports')).rows[0]?.count, 0)
})

test('foreign target days and item ids cannot be used to edit, copy, move or upsert another trip', async (t) => {
  const f = await fixture(t)
  const ownTrip = await createTrip(f, '自己的行程')
  const foreignTrip = await createTrip(f, '另一行程')
  const ownDay = await createDay(f, ownTrip)
  const foreignDay = await createDay(f, foreignTrip)
  const own = await createItem(f, ownTrip, { dayId: ownDay, type: 'transit', title: '自己的活动', ...metadata })
  const foreign = await createItem(f, foreignTrip, { dayId: foreignDay, type: 'accommodation', title: '另一行程住宿', ...metadata })
  const before = (await f.db.run('SELECT * FROM items ORDER BY id')).rows
  for (const [path, method, body] of [
    [`/api/trips/${ownTrip}/items`, 'POST', { dayId: foreignDay, type: 'accommodation', title: '越界创建' }],
    [`/api/trips/${ownTrip}/items/${own.id}/move`, 'POST', { dayId: foreignDay }],
    [`/api/trips/${ownTrip}/items/${own.id}/copy`, 'POST', { dayId: foreignDay }],
    [`/api/trips/${ownTrip}/items/${foreign.id}`, 'PATCH', { cost: '' }],
    [`/api/trips/${ownTrip}/items/${foreign.id}/move`, 'POST', { dayId: ownDay }],
    [`/api/trips/${ownTrip}/items/${foreign.id}/copy`, 'POST', { dayId: ownDay }],
    [`/api/trips/${ownTrip}/items/${foreign.id}`, 'DELETE', {}],
    [`/api/trips/${ownTrip}/items`, 'PUT', { items: [{ id: 'foreign-target', dayId: foreignDay, type: 'note', title: '越界日程' }] }],
  ] as const) {
    const response = await f.app.request(path, json(method, body))
    assert.equal(response.status, 404, `${method} ${path}`)
    assert.deepEqual((await f.db.run('SELECT * FROM items ORDER BY id')).rows, before)
  }
  const conflictingId = await f.app.request(`/api/trips/${ownTrip}/items`, json('PUT', {
    items: [{ id: foreign.id, dayId: ownDay, type: 'dining', title: '不能盗用 ID', cost: '' }],
  }))
  assert.equal(conflictingId.status, 400, 'a globally occupied content id is invalid')
  assert.deepEqual((await f.db.run('SELECT * FROM items ORDER BY id')).rows, before)
  for (const op of [
    { op: 'add_day', dayId: foreignDay },
    { op: 'add_item', itemId: foreign.id, dayId: ownDay, type: 'accommodation', title: '被占用的 ID', pending: true },
    { op: 'add_item', itemId: 'foreign-day-item', dayId: foreignDay, type: 'note', title: '另一行程的日程', pending: true },
    { op: 'move_item', itemId: own.id, dayId: foreignDay },
    { op: 'update_item', itemId: foreign.id, type: 'transit', cost: '' },
  ]) {
    const result = await applyTripPatch(f.patchStore, ownTrip, { ops: [
      { op: 'update_item', itemId: own.id, cost: '前序操作也要回滚' }, op,
    ] })
    assert.equal(result.ok, false, JSON.stringify(op))
    assert.deepEqual((await f.db.run('SELECT * FROM items ORDER BY id')).rows, before)
  }
  assert.deepEqual((await canvas(f, foreignTrip)).days[0]!.items.map((item) => [item.id, item.type]), [[foreign.id, 'stay']])
})

function guideDraft(items: Record<string, unknown>[]) {
  return {
    title: '成都慢游', destination: '成都', dateStatus: 'unspecified',
    days: [{ dayNumber: 1, title: '城市漫步', items: items.map((item, index) => ({
      type: 'other', title: `攻略活动 ${index}`, note: '攻略备注', region: '成都', poi: null, pending: true, ...item,
    })) }], warnings: [],
  }
}

test('structured guide aliases import through the production client and replay with canonical vocabulary', async (t) => {
  const f = await fixture(t)
  const draft = guideDraft(vocabulary.map(([type], index) => ({ type, ...(index === 4 ? {} : metadata) })))
  const importId = randomUUID()
  const imported = await guides.importGuide({ draft, importId }, undefined, f.fetchLike)
  assert.equal(imported.ok, true, JSON.stringify(imported))
  const tripId = imported.data.id as string
  const read = await canvas(f, tripId)
  assert.deepEqual(read.days[0]!.items.map((item) => item.type), ['traffic', 'stay', 'attraction', 'food', 'other'])
  for (const item of read.days[0]!.items.slice(0, 4)) assertMetadata(item, metadata)
  assertMetadata(read.days[0]!.items[4]!, {})
  assert.deepEqual((await f.db.run('SELECT type FROM items ORDER BY item_order')).rows.map((row) => row.type), ['traffic', 'stay', 'attraction', 'food', 'other'])

  // Submit original aliases directly too: client validation must not conceal a
  // server parser which still rejects the target vocabulary.
  const directReplay = await f.app.request('/api/trips/from-guide', json('POST', { draft, importId }))
  assert.equal(directReplay.status, 201)
  assert.equal((await directReplay.json() as { trip: { id: string } }).trip.id, tripId)
  const canonical = guideDraft(vocabulary.map(([, type], index) => ({ type, ...(index === 4 ? {} : metadata) })))
  const canonicalReplay = await guides.importGuide({ draft: canonical, importId }, undefined, f.fetchLike)
  assert.equal(canonicalReplay.ok, true, JSON.stringify(canonicalReplay))
  assert.equal(canonicalReplay.data.id, tripId)
  const changed = structuredClone(canonical)
  Object.assign(changed.days[0]!.items[4]!, { cost: '' })
  const conflict = await f.app.request('/api/trips/from-guide', json('POST', { draft: changed, importId }))
  assert.equal(conflict.status, 409, 'absent metadata and an explicit empty string remain distinct payloads')
  assert.equal((await f.db.run('SELECT COUNT(*) AS count FROM trips')).rows[0]?.count, 1)
  assert.equal((await f.db.run('SELECT COUNT(*) AS count FROM items')).rows[0]?.count, 5)
  assert.equal((await f.db.run('SELECT COUNT(*) AS count FROM guide_imports')).rows[0]?.count, 1)
})

test('pre-alias guide receipts retain their original fingerprint and remain replayable', async (t) => {
  const f = await fixture(t)
  // This field order is the serialized draft used before aliases and optional metadata.
  const legacyDraft = {
    title: '成都慢游', destination: '成都', dateStatus: 'unspecified',
    days: [{ dayNumber: 1, title: '城市漫步', items: [
      { type: 'attraction', title: '人民公园', note: '早上喝茶', region: '成都', poi: null, pending: true },
      { type: 'food', title: '街边小吃', note: '店名待定', region: '成都', poi: null, pending: true },
    ] }], warnings: [],
  }
  const legacyHash = createHash('sha256').update(JSON.stringify({ draft: legacyDraft, title: undefined })).digest('hex')
  const oldTripId = await createTrip(f, '已有导入')
  const oldImportId = randomUUID()
  await f.db.run('INSERT INTO guide_imports (import_id, payload_hash, trip_id) VALUES (?, ?, ?)', [oldImportId, legacyHash, oldTripId])
  const replay = await guides.importGuide({ draft: legacyDraft, importId: oldImportId }, undefined, f.fetchLike)
  assert.equal(replay.ok, true, JSON.stringify(replay))
  assert.equal(replay.data.id, oldTripId)
  const newImportId = randomUUID()
  const imported = await guides.importGuide({ draft: legacyDraft, importId: newImportId }, undefined, f.fetchLike)
  assert.equal(imported.ok, true, JSON.stringify(imported))
  assert.deepEqual((await f.db.run('SELECT payload_hash FROM guide_imports ORDER BY import_id')).rows,
    [{ payload_hash: legacyHash }, { payload_hash: legacyHash }])
  assert.deepEqual((await canvas(f, imported.data.id)).days[0]!.items.map((item) => item.type), ['attraction', 'food'])
})

/** Only the external model is scripted; tool parsing, proposal confirmation,
 * SQLite writes, HTTP responses and frontend decoders all run in production code. */
function proposalModel(input: unknown): MastraLanguageModel {
  let calls = 0
  return {
    specificationVersion: 'v2', provider: 'test.activity-contract', modelId: 'activity-proposal', supportedUrls: Promise.resolve({}),
    doGenerate: async () => { throw new Error('streaming only') },
    doStream: async () => {
      calls += 1
      const parts = calls === 1 ? [
        { type: 'tool-call', toolCallId: 'activity-proposal', toolName: 'create_trip_proposal', input: JSON.stringify(input) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ] : [
        { type: 'text-start', id: 'reply' }, { type: 'text-delta', id: 'reply', delta: '建议已生成。' }, { type: 'text-end', id: 'reply' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
    },
  } as unknown as MastraLanguageModel
}

test('proposal tools normalize alias previews and confirmed patches before real SQLite writes and client readback', async (t) => {
  const items = vocabulary.map(([type], index) => ({ itemId: `proposal-${index}`, dayId: 'proposal-day', type, title: `建议 ${type}`, note: '建议备注', pending: true, ...metadata }))
  const input = {
    kind: 'parse', title: '目标词汇建议', summary: '解析活动并等待确认', diff: [{ action: 'add', label: '新增五类活动' }], items,
    patch: { ops: [{ op: 'add_day', dayId: 'proposal-day' }, ...items.map((item) => ({ op: 'add_item', ...item }))] },
  }
  const f = await fixture(t, proposalModel(input))
  const tripId = await createTrip(f)
  const foreignTrip = await createTrip(f, '其他行程')
  const preview = await proposals.createAiProposal(tripId, { kind: 'parse', text: '交通、酒店、景点、吃饭和备注' }, f.fetchLike)
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.deepEqual(preview.data.items.map((item: { type: string }) => item.type), ['traffic', 'stay', 'attraction', 'food', 'other'])
  assert.deepEqual(preview.data.patch.ops.filter((op: { op: string }) => op.op === 'add_item').map((op: { type: string }) => op.type),
    ['traffic', 'stay', 'attraction', 'food', 'other'])
  for (const item of preview.data.items) {
    assert.equal(item.timeRange, metadata.timeRange)
    assert.equal(item.cost, metadata.cost)
  }
  assert.deepEqual((await canvas(f, tripId)).days, [], 'preview does not mutate the trip')
  const foreignApply = await f.app.request(`/api/trips/${foreignTrip}/ai/proposals/${preview.data.id}/apply`, { method: 'POST' })
  assert.equal(foreignApply.status, 404)
  assert.equal((await f.db.run('SELECT COUNT(*) AS count FROM items')).rows[0]?.count, 0)
  const applied = await proposals.applyAiProposal(tripId, preview.data.id, f.fetchLike)
  assert.equal(applied.ok, true, JSON.stringify(applied))
  const read = await canvas(f, tripId)
  assert.deepEqual(read.days[0]!.items.map((item) => item.type), ['traffic', 'stay', 'attraction', 'food', 'other'])
  for (const item of read.days[0]!.items) assertMetadata(item, metadata)
  assert.deepEqual((await f.db.run('SELECT type FROM items ORDER BY item_order')).rows.map((row) => row.type), ['traffic', 'stay', 'attraction', 'food', 'other'])
  assert.deepEqual((await canvas(f, foreignTrip)).days, [])
})

test('direct memory and SQLite writers normalize aliases, preserve metadata omissions and reject foreign ids and days', async (t) => {
  const f = await fixture(t)
  const ownTrip = await createTrip(f)
  const foreignTrip = await createTrip(f, '其他行程')
  const ownDay = await createDay(f, ownTrip)
  const foreignDay = await createDay(f, foreignTrip)
  const memoryContent = new MemoryContentStoreDriver()
  const memoryAdmin = new MemoryItemsAdminStoreDriver()
  const memoryPatch = new MemoryTripPatchStore()
  for (const [id, tripId] of [[ownDay, ownTrip], [foreignDay, foreignTrip]] as const) {
    const row = { id, trip_id: tripId, idx: 0, date: '', theme: '', color: '' }
    memoryContent.dayRows.set(id, row)
    memoryAdmin.dayRows.set(id, row)
    await memoryPatch.upsertDayRow(tripId, { id, idx: 0, date: '', theme: '' })
  }
  const sqliteContent = new SqliteContentStoreDriver(f.db)
  const sqliteAdmin = createSqliteItemsAdminStore(f.db)
  type DirectItem = ItemFullUpsert & TripPatchItemUpsert
  const writers = [
    { name: 'memory content', write: (tripId: string, item: DirectItem) => memoryContent.upsertItemRow(tripId, item), rows: (tripId: string) => memoryContent.listItemRows(tripId) },
    { name: 'SQLite content', write: (tripId: string, item: DirectItem) => sqliteContent.upsertItemRow(tripId, item), rows: (tripId: string) => sqliteContent.listItemRows(tripId) },
    { name: 'memory item admin', write: (tripId: string, item: DirectItem) => memoryAdmin.upsertItemFull(tripId, item), rows: (tripId: string) => memoryAdmin.listItemRows(tripId) },
    { name: 'SQLite item admin', write: (tripId: string, item: DirectItem) => sqliteAdmin.upsertItemFull(tripId, item), rows: (tripId: string) => sqliteAdmin.listItemRows(tripId) },
    { name: 'memory patch', write: (tripId: string, item: DirectItem) => memoryPatch.upsertItemRow(tripId, item), rows: (tripId: string) => memoryPatch.listItemRows(tripId) },
    { name: 'SQLite patch', write: (tripId: string, item: DirectItem) => f.patchStore.upsertItemRow(tripId, item), rows: (tripId: string) => f.patchStore.listItemRows(tripId) },
  ]
  for (const [writerIndex, writer] of writers.entries()) {
    await t.test(writer.name, async () => {
      const base = { id: `direct-${writerIndex}`, dayId: ownDay, itemOrder: 0, type: 'note', title: '直接写入', note: '独立备注', poiJson: null, imagesJson: null, poi: null, pending: true }
      for (const [alias, legacy] of vocabulary) {
        await writer.write(ownTrip, { ...base, type: alias, ...metadata })
        const saved = (await writer.rows(ownTrip)).find((row) => row.id === base.id)!
        assert.equal(saved.type, legacy, alias)
        assert.equal(saved.time_range, metadata.timeRange)
        assert.equal(saved.cost, metadata.cost)
      }
      await writer.write(ownTrip, { ...base, type: 'meal', title: '只改标题' })
      let saved = (await writer.rows(ownTrip)).find((row) => row.id === base.id)!
      assert.equal(saved.type, 'meal', 'unrecognized legacy strings remain supported by raw storage')
      assert.equal(saved.time_range, metadata.timeRange)
      assert.equal(saved.cost, metadata.cost)
      await writer.write(ownTrip, { ...base, timeRange: '' })
      saved = (await writer.rows(ownTrip)).find((row) => row.id === base.id)!
      assert.equal(saved.time_range, '')
      assert.equal(saved.cost, metadata.cost)
      const foreign = { ...base, id: `foreign-${writerIndex}`, dayId: foreignDay, type: 'accommodation', ...metadata }
      await writer.write(foreignTrip, foreign)
      const ownBefore = structuredClone(await writer.rows(ownTrip))
      const foreignBefore = structuredClone(await writer.rows(foreignTrip))
      await assert.rejects(writer.write(ownTrip, { ...foreign, dayId: ownDay, type: 'dining', cost: '' }))
      await assert.rejects(writer.write(ownTrip, { ...base, id: `bad-day-${writerIndex}`, dayId: foreignDay, type: 'transit' }))
      assert.deepEqual(await writer.rows(ownTrip), ownBefore)
      assert.deepEqual(await writer.rows(foreignTrip), foreignBefore)
    })
  }
})

test('existing alias rows project as legacy while content preserves unknown strings and reads never rewrite rows', async (t) => {
  const f = await fixture(t)
  const tripId = await createTrip(f)
  const dayId = await createDay(f, tripId)
  const storedTypes = ['transit', 'accommodation', 'attraction', 'dining', 'note', 'traffic', 'stay', 'food', 'other', 'meal', 'Dining', ' transit ']
  for (const [index, type] of storedTypes.entries()) {
    await f.db.run('INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, time_range, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [`old-${index}`, tripId, dayId, index, type, `老活动 ${index}`, '老备注', index === 0 ? null : metadata.timeRange, index === 1 ? '' : metadata.cost])
  }
  const before = (await f.db.run('SELECT * FROM items ORDER BY item_order')).rows
  const read = await canvas(f, tripId)
  assert.deepEqual(read.days[0]!.items.map((item) => item.type),
    ['traffic', 'stay', 'attraction', 'food', 'other', 'traffic', 'stay', 'food', 'other', 'other', 'other', 'other'])
  assertMetadata(read.days[0]!.items[0]!, { cost: metadata.cost })
  assertMetadata(read.days[0]!.items[1]!, { timeRange: metadata.timeRange, cost: '' })
  assert.deepEqual((await content(f, tripId)).days[0]!.items.map((item) => item.type),
    ['traffic', 'stay', 'attraction', 'food', 'other', 'traffic', 'stay', 'food', 'other', 'meal', 'Dining', ' transit '])
  assert.deepEqual((await f.db.run('SELECT * FROM items ORDER BY item_order')).rows, before)
})
