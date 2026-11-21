import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { StashItemSchema, type StashItem } from '@hailar/domain'
import { createApp, type CreateAppOptions } from '../server/src/app.js'
import { createSqliteDatabase, type SqlValue } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../server/src/trips/repository.js'
import { createSqliteRecommendationsStore } from '../server/src/recommendations/driver-sqlite.js'
import { MemoryRecommendationsStoreDriver } from '../server/src/recommendations/driver-memory.js'
import { RecommendationsRepository } from '../server/src/recommendations/repository.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { createSqliteDaysAdminStore } from '../server/src/days-admin/driver-sqlite.js'
import { createSqliteTripPatchStore } from '../server/src/trip-patch/store-sqlite.js'
import { TripEventHub } from '../server/src/trip-events/hub.js'
import { addFavorite, addToStash, fetchRecommendations, removeFavorite, removeFromStash } from '../src/domain/recommendations'
import type { FetchLike } from '../src/domain/tripList'

const poi = { id: 'poi-id', amapId: 'amap-id', name: '原始地点', lat: 30.6, lng: 104.06, category: '风景名胜;公园', type: 'attraction' as const, region: '成都', rating: 4.5, introSummary: '介绍', address: '地址', images: [] }
const fields = ['tripId', 'title', 'category', 'createdAt'] as const
function aliases(item: StashItem) {
  return Object.fromEntries(fields.filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]]))
}
function request(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
}

async function fixture(t: TestContext, plannerModel?: CreateAppOptions['plannerModel']) {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  // A legacy-shaped table lets real SQLite exercise NULL sources which the
  // fresh schema's NOT NULL constraints already prevent. No production migration.
  await db.run('CREATE TABLE stash (id TEXT PRIMARY KEY, trip_id TEXT, poi TEXT, origin TEXT, added_at TEXT)')
  await ensureSchema(db)
  for (const id of ['trip', 'other-trip']) {
    await db.run("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at, cover_image, is_pinned, status) VALUES (?, '行程', '2026-10-02', '2026-10-03', 'created', 'updated', '/cover.jpg', 0, 'draft')", [id])
  }
  const driver = createSqliteRecommendationsStore(db)
  const repository = new RecommendationsRepository(driver)
  const events = new TripEventHub()
  const app = await createApp({ tripRepository: new TripRepository(new SqliteTripStoreDriver(db)),
    recommendationsStore: driver, workbenchStore: createSqliteWorkbenchStore(db), daysAdminStore: createSqliteDaysAdminStore(db),
    tripPatchStore: createSqliteTripPatchStore(db), tripEvents: events, ...(plannerModel ? { plannerModel } : {}),
  })
  const fetchLike: FetchLike = (url, init) => app.request(url, init)
  async function read() {
    const response = await app.request('/api/trips/trip/stash')
    assert.equal(response.status, 200)
    const { stash } = await response.json() as { stash: StashItem[] }
    const result = await fetchRecommendations('trip', fetchLike)
    assert.ok(result.ok)
    assert.deepEqual(result.data.stash, stash)
    assert.deepEqual((await repository.snapshot('trip')).stash, stash)
    return stash
  }
  async function insert(id: string, rawPoi: unknown, time: SqlValue = ' saved creation text ', tripId = 'trip') {
    await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at) VALUES (?, ?, ?, ?, ?)', [id, tripId, JSON.stringify(rawPoi), 'legacy-origin', time])
  }
  async function state() {
    return Promise.all([
      db.run('SELECT * FROM stash ORDER BY id'), db.run('SELECT * FROM favorites ORDER BY id'),
      db.run('SELECT * FROM trips ORDER BY id'), db.run('PRAGMA table_info(stash)'),
      db.run("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"),
    ]).then((results) => results.map((result) => result.rows))
  }
  return { db, driver, repository, events, app, fetchLike, insert, read, state }
}

test('shared Stash aliases are strict optional nonblank strings without trimming, limits or time parsing', () => {
  const old = { id: 'stash-id', poi, origin: 'recommend', addedAt: '' }
  assert.deepEqual(StashItemSchema.parse(old), old)
  for (const key of fields) {
    for (const value of [' raw text \n', '文'.repeat(1000), 'not-an-ISO-date']) {
      assert.equal(StashItemSchema.parse({ ...old, [key]: value })[key], value)
    }
    for (const value of [null, '', ' \t\r\n', '\u3000', 0, true, {}, []]) {
      assert.equal(StashItemSchema.safeParse({ ...old, [key]: value }).success, false, key)
    }
  }
})

test('raw memory driver sources independently omit invalid aliases and never invent a Trip identity or timestamp', async () => {
  class RawDriver extends MemoryRecommendationsStoreDriver {
    override async listStashRows() { return [...this.stashRows.values()] }
  }
  const driver = new RawDriver()
  const repository = new RecommendationsRepository(driver)
  const rawName = '  保存原文  '
  for (const value of [undefined, null, '', ' \n', 1, false, {}, [], new Uint8Array([49])]) {
    driver.stashRows.set('stash-id', { id: 'stash-id', trip_id: value, poi: JSON.stringify({ ...poi, name: rawName, category: value }), origin: 'favorite', added_at: value })
    const [item] = (await repository.snapshot('trip')).stash
    assert.ok(item)
    assert.deepEqual(aliases(item), { title: rawName })
    assert.equal(item.poi.name, '保存原文')
    assert.equal(item.origin, 'favorite')
  }
  driver.stashRows.set('stash-id', { id: 'stash-id', trip_id: 'other-trip', poi: JSON.stringify(poi), origin: 'recommend', added_at: 'saved' })
  assert.deepEqual(aliases((await repository.snapshot('trip')).stash[0]!), { title: poi.name, category: poi.category, createdAt: 'saved' })
  for (const name of [undefined, null, '', ' \n', 123, true]) {
    driver.stashRows.set('stash-id', { id: 'stash-id', trip_id: 'trip', poi: JSON.stringify({ ...poi, name }), origin: 'recommend', added_at: 'saved' })
    assert.deepEqual((await repository.snapshot('trip')).stash, [], 'old invalid-POI drop rule remains')
  }
})

test('SQLite → Hono → client projects raw saved text before legacy trim/truncate and never writes on read', async (t) => {
  const f = await fixture(t)
  const title = ' \t' + '长名称'.repeat(100) + '\n '
  const category = '\n ' + '提供方分类;'.repeat(100) + '  '
  const time = '\t' + '历史时间原文'.repeat(40) + '\n'
  await f.insert('raw', { ...poi, name: title, category }, time)
  await f.insert('other', poi, 'other time', 'other-trip')
  const before = await f.state()
  const [item] = await f.read()
  assert.ok(item)
  assert.deepEqual(aliases(item), { tripId: 'trip', title, category, createdAt: time })
  assert.equal(item.id, 'raw')
  assert.notEqual(item.id, item.poi.id)
  assert.equal(item.poi.name, title.trim().slice(0, 160))
  assert.equal(item.poi.category, category.trim().slice(0, 80))
  assert.equal(item.addedAt, time.trim().slice(0, 80))
  assert.equal(item.origin, 'recommend')
  assert.deepEqual(StashItemSchema.parse(item), item)
  assert.deepEqual(await f.state(), before, 'rows and table definitions are byte-for-byte unchanged by reads')
  assert.equal((await f.app.request('/api/trips/missing/stash')).status, 404)
})

test('SQLite legacy NULL/BLOB times, invalid categories and corrupt JSON preserve existing stash tolerance', async (t) => {
  const f = await fixture(t)
  const bad: SqlValue[] = [null, '', ' \t\n', new Uint8Array([49, 50])]
  for (const [index, time] of bad.entries()) {
    await f.insert('bad-' + index, { ...poi, category: [undefined, null, 123, false][index] }, time)
  }
  await f.insert('empty-category', { ...poi, category: ' \t ' }, 'saved')
  await f.insert('independent', poi, null)
  for (const [id, value] of [['json', '{bad'], ['null', 'null'], ['array', '[]'], ['scalar', '12'], ['bad-name', '{"name":123,"lat":1,"lng":2}'], ['bad-coercion', '{"name":"old","lat":{"toString":0,"valueOf":0},"lng":2}']] as const) {
    await f.db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at) VALUES (?, ?, ?, ?, ?)', [id, 'trip', value, 'recommend', 'saved'])
  }
  const before = await f.state()
  const stash = await f.read()
  assert.equal(stash.length, 6)
  for (const item of stash) {
    assert.equal(item.title, poi.name)
    assert.equal(item.tripId, 'trip')
    if (item.id === 'independent') assert.deepEqual(aliases(item), { tripId: 'trip', title: poi.name, category: poi.category })
    else if (item.id === 'empty-category') assert.deepEqual(aliases(item), { tripId: 'trip', title: poi.name, createdAt: 'saved' })
    else {
      assert.deepEqual(aliases(item), { tripId: 'trip', title: poi.name })
      assert.equal(item.poi.category, '')
      assert.equal(item.addedAt, '')
    }
  }
  assert.deepEqual(await f.state(), before)
})

test('immediate add, duplicate, favorite companion and delete match persisted normalized representation and Trip scope', async (t) => {
  const f = await fixture(t)
  for (const [index, category] of [undefined, null, 123, false, '', ' \n ', '  合法分类'.repeat(40)].entries()) {
    const input = { ...poi, id: 'input-' + index, amapId: 'key-' + index, name: '  ' + '保存名称'.repeat(70) + ' ', category }
    const response = await f.app.request('/api/trips/trip/stash', request('POST', { poi: input }))
    assert.equal(response.status, 201)
    const { item } = await response.json() as { item: StashItem }
    const { rows } = await f.db.run('SELECT * FROM stash WHERE id = ?', [item.id])
    const saved = rows[0]!
    const storedPoi = JSON.parse(saved.poi as string)
    assert.equal(item.tripId, saved.trip_id)
    assert.equal(item.title, storedPoi.name)
    assert.equal(item.createdAt, saved.added_at)
    assert.equal(item.createdAt, item.addedAt)
    if (index === 6) assert.equal(item.category, storedPoi.category)
    else assert.equal(Object.hasOwn(item, 'category'), false, 'normalization to empty category is not a fact')
    assert.deepEqual((await f.read()).find((entry) => entry.id === item.id), item)
    const duplicate = await addToStash('trip', { ...poi, amapId: input.amapId, name: 'different supplied name' }, 'favorite', f.fetchLike)
    assert.ok(duplicate.ok)
    assert.deepEqual(duplicate.data, item, 'dedupe retains original identity, origin and saved source fields')
  }
  const added = await addToStash('other-trip', poi, 'recommend', f.fetchLike)
  assert.ok(added.ok)
  assert.equal(added.data.tripId, 'other-trip')
  const forbiddenDelete = await f.app.request('/api/trips/trip/stash/' + added.data.id, { method: 'DELETE' })
  assert.equal(forbiddenDelete.status, 404)
  const favorite = await addFavorite('trip', { ...poi, amapId: 'favorite-companion' }, f.fetchLike)
  assert.ok(favorite.ok)
  assert.deepEqual(Object.keys(favorite.data).sort(), ['createdAt', 'id', 'poi'])
  const companion = (await f.read()).find((entry) => entry.origin === 'favorite')!
  assert.deepEqual(aliases(companion), { tripId: 'trip', title: poi.name, category: poi.category, createdAt: companion.addedAt })
  assert.ok((await removeFavorite('trip', favorite.data.id, f.fetchLike)).ok)
  assert.equal((await f.read()).some((entry) => entry.id === companion.id), false)
  assert.ok((await removeFromStash('other-trip', added.data.id, f.fetchLike)).ok)
})

// Exercise the existing proposal apply route without a provider/network call.
function parseProposalModel(): CreateAppOptions['plannerModel'] {
  let calls = 0
  return {
    specificationVersion: 'v2', provider: 'test.stash', modelId: 'stash-proposal', supportedUrls: Promise.resolve({}),
    doGenerate: async () => { throw new Error('unused') },
    doStream: async () => {
      const parts = calls++ === 0 ? [
        { type: 'tool-call', toolCallId: 'proposal', toolName: 'create_trip_proposal', input: JSON.stringify({ kind: 'parse', title: '新增一天', summary: '安排', diff: [{ action: 'add', label: '新增一天' }], items: [{ itemId: 'proposal-item', dayId: 'proposal-day', type: 'other', title: '提案活动' }], patch: { ops: [{ op: 'add_day', dayId: 'proposal-day', date: '2026-10-02', theme: '提案主题' }, { op: 'add_item', itemId: 'proposal-item', dayId: 'proposal-day', type: 'other', title: '提案活动' }] } }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ] : [{ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]
      return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
    },
  } as CreateAppOptions['plannerModel']
}

test('existing proposal apply and event refetch keep stash source aliases without adding Stash DTOs to proposals/events', async (t) => {
  const f = await fixture(t, parseProposalModel())
  await f.insert('existing', poi)
  const before = await f.read()
  const stashRowsBefore = (await f.db.run('SELECT * FROM stash')).rows
  const observed: Array<Promise<StashItem[]>> = []
  t.after(f.events.subscribe('trip', (event) => {
    assert.equal('stash' in event, false)
    observed.push(f.read())
  }))
  const preview = await f.app.request('/api/trips/trip/ai/proposals', request('POST', { kind: 'parse', text: '安排一天' }))
  assert.equal(preview.status, 201, await preview.clone().text())
  const { proposal } = await preview.json() as { proposal: { id: string } }
  assert.equal('stash' in proposal, false)
  const applied = await f.app.request('/api/trips/trip/ai/proposals/' + proposal.id + '/apply', request('POST'))
  assert.equal(applied.status, 200, await applied.clone().text())
  assert.equal('stash' in await applied.json(), false)
  assert.deepEqual(await f.read(), before)
  assert.ok(observed.length > 0)
  for (const snapshot of await Promise.all(observed)) assert.deepEqual(snapshot, before)
  assert.deepEqual((await f.db.run('SELECT * FROM stash')).rows, stashRowsBefore)
})
