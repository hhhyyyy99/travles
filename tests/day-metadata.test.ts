import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Day, TripSummary } from '@hailar/domain'
import { createApp } from '../server/src/app.js'
import { createSqliteDatabase } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { SqliteContentStoreDriver } from '../server/src/content/driver-sqlite.js'
import { TripContentRepository } from '../server/src/content/repository.js'
import type { DayContent } from '../server/src/content/types.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { createSqliteDaysAdminStore } from '../server/src/days-admin/driver-sqlite.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../server/src/trips/repository.js'
import { createSqliteTripPatchStore } from '../server/src/trip-patch/store-sqlite.js'
import { applyTripPatch } from '../server/src/trip-patch/apply.js'
import { synchronizeTripSchedule } from '../server/src/trip-events/schedule.js'
import { TripEventHub } from '../server/src/trip-events/hub.js'
import { seedBuiltinTrip } from '../server/src/seed/seed.js'
import { BUILTIN_TRIP_ID } from '../server/src/seed/builtin-trip-data.js'
import { importGuide } from '../src/domain/guideParsing'
import type { FetchLike } from '../src/domain/tripList'
import { createWorkbenchDay, updateWorkbenchDay, fetchTripCanvas } from '../src/domain/workbench'

async function fixture(t: TestContext) {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  await ensureSchema(db)
  const repository = new TripRepository(new SqliteTripStoreDriver(db))
  const patchStore = createSqliteTripPatchStore(db)
  const events = new TripEventHub()
  const app = await createApp({
    tripRepository: repository,
    contentRepository: new TripContentRepository(new SqliteContentStoreDriver(db)),
    workbenchStore: createSqliteWorkbenchStore(db),
    daysAdminStore: createSqliteDaysAdminStore(db), tripPatchStore: patchStore,
    guideImportDatabase: db, tripEvents: events,
  })
  const fetchLike: FetchLike = (url, init) => app.request(url, init)
  async function trip(id: string) {
    await db.run('INSERT INTO trips (id, title, start_date, end_date, planning_context, cover_image, is_pinned, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, '旅行名称', '2026-10-02', '2026-10-03', JSON.stringify({ destination: '成都', durationDays: 7, preferences: '慢节奏', originalSentence: '成都旅行', dateStatus: 'confirmed' }), '/cover.jpg', 0, '原状态', 'created', 'updated'])
  }
  async function snapshot() {
    return Promise.all(['trips', 'days', 'items', 'legs'].map(async (table) => (await db.run(`SELECT * FROM ${table} ORDER BY id`)).rows))
  }
  async function reads(tripId: string) {
    const before = await snapshot()
    const response = await fetchLike(`/api/trips/${tripId}/days`)
    assert.equal(response.status, 200)
    const content = (await response.json() as { days: DayContent[] }).days
    const raw = await fetchLike(`/api/trips/${tripId}/canvas`)
    assert.equal(raw.status, 200)
    const canvas = await raw.json() as { trip: TripSummary; days: Day[]; legs: unknown[] }
    const client = await fetchTripCanvas(tripId, fetchLike)
    assert.ok(client.ok)
    assert.deepEqual(client.data, canvas)
    assert.deepEqual(content.map(({ id, title, note }) => ({ id, title, note })), canvas.days.map(({ id, title, note }) => ({ id, title, note })))
    assert.deepEqual(await snapshot(), before, 'all read paths leave source storage untouched')
    return { content, ...client.data }
  }
  return { db, repository, patchStore, events, app, fetchLike, trip, reads, snapshot }
}

function assertMetadata(day: Day | DayContent, title: string | undefined, note: string | undefined) {
  assert.equal(day.title, title)
  assert.equal(day.note, note)
  assert.equal(Object.hasOwn(day, 'title'), title !== undefined)
  assert.equal(Object.hasOwn(day, 'note'), note !== undefined)
}

test('real Day create/update clients preserve independent raw metadata through HTTP, SQLite and event refetch', async (t) => {
  const f = await fixture(t)
  await f.trip('owner')
  await f.trip('foreign')
  await f.db.run("INSERT INTO days (id, trip_id, idx, date, theme, color, title, note) VALUES ('foreign-day', 'foreign', 8, '2026-10-03', '别的主题', '', '别的名称', '别的备注')")
  const foreignBefore = await f.reads('foreign')
  const observed: Array<Promise<Awaited<ReturnType<typeof fetchTripCanvas>>>> = []
  t.after(f.events.subscribe('owner', () => observed.push(fetchTripCanvas('owner', f.fetchLike))))
  const created = await createWorkbenchDay('owner', { title: '  独立名称\n', note: '  整日备注\n', theme: '主题', color: '#123456' }, f.fetchLike)
  assert.ok(created.ok)
  const id = created.data.id
  assertMetadata(created.data, '  独立名称\n', '  整日备注\n')
  assert.equal(created.data.theme, '主题')
  assert.deepEqual([created.data.tripId, created.data.index, created.data.dayNumber], ['owner', 0, 1])
  await f.db.run('INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['item', 'owner', id, 9, 'other', '活动名称', '活动备注', 1])
  const itemsBefore = (await f.db.run('SELECT * FROM items')).rows
  for (const [patch, title, note] of [
    [{ title: '  新名称  ' }, '  新名称  ', '  整日备注\n'],
    [{ note: '\n新整日备注  ' }, '  新名称  ', '\n新整日备注  '],
    [{ theme: '新主题', color: '#abcdef' }, '  新名称  ', '\n新整日备注  '],
    [{ title: '' }, '', '\n新整日备注  '],
    [{ note: '' }, '', ''],
  ] as const) {
    const changed = await updateWorkbenchDay('owner', id, patch, f.fetchLike)
    assert.ok(changed.ok)
    assertMetadata(changed.data, title, note)
    assert.deepEqual(changed.data.items, [], 'existing write-response empty items contract remains')
    const refetch = await observed.at(-1)!
    assert.ok(refetch.ok)
    assertMetadata(refetch.data.days[0]!, title, note)
    const readback = await f.reads('owner')
    assertMetadata(readback.days[0]!, title, note)
    assert.deepEqual(readback.days[0]!.items.map((item) => [item.title, item.note, item.dayId, item.order]), [['活动名称', '活动备注', id, 9]])
    assert.deepEqual((await f.db.run('SELECT * FROM items')).rows, itemsBefore)
  }
  assert.equal(observed.length, 6)
  const owner = await f.reads('owner')
  assert.deepEqual([owner.trip.destination, owner.trip.daysCount, owner.trip.coverImage, owner.trip.isPinned, owner.trip.status], ['成都', 2, '/cover.jpg', false, '原状态'])
  assert.deepEqual(await f.reads('foreign'), foreignBefore)
  const rejected = await updateWorkbenchDay('foreign', id, { title: '跨行程覆盖' }, f.fetchLike)
  assert.equal(rejected.ok, false)
  assertMetadata((await f.reads('owner')).days[0]!, '', '')
})

test('HTTP rejects null and other invalid new metadata without partial writes or events', async (t) => {
  const f = await fixture(t)
  await f.trip('strict')
  const created = await createWorkbenchDay('strict', { theme: '原主题', title: '原名称', note: '原备注' }, f.fetchLike)
  assert.ok(created.ok)
  for (const method of ['POST', 'PATCH']) {
    for (const field of ['title', 'note']) {
      for (const value of [null, 12, false, [], {}]) {
        const before = await f.snapshot()
        const revision = f.events.revision('strict')
        const response = await f.fetchLike(`/api/trips/strict/days${method === 'PATCH' ? `/${created.data.id}` : ''}`, {
          method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: '不能部分写入', [field]: value }),
        })
        assert.equal(response.status, 400, `${method} ${field}=${JSON.stringify(value)}`)
        assert.deepEqual(await f.snapshot(), before)
        assert.equal(f.events.revision('strict'), revision)
      }
    }
  }
})

test('existing patches, sparse schedule synchronization and event reads keep metadata and item/leg relationships', async (t) => {
  const f = await fixture(t)
  await f.trip('patch')
  await f.db.run("INSERT INTO days (id, trip_id, idx, date, theme, color, title, note) VALUES ('first', 'patch', 0, '2026-10-02', '原主题', '', '第一日名称', '第一日备注')")
  await f.db.run("INSERT INTO days (id, trip_id, idx, date, theme, color, title, note) VALUES ('sparse', 'patch', 8, '2026-10-03', '原主题', '', '稀疏日名称', '稀疏日备注')")
  for (const [id, order] of [['a', 0], ['b', 1]] as const) {
    await f.db.run('INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'patch', 'sparse', order, 'other', `活动${id}`, '活动备注', 1])
  }
  await f.db.run("INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline) VALUES ('leg-a-b', 'patch', 'a', 'b', 'drive', 5, 10, '[[1,2],[3,4]]')")
  const before = await f.reads('patch')
  assert.deepEqual(before.days.map((day) => day.index), [0, 8])
  const patch = await applyTripPatch(f.patchStore, 'patch', { ops: [
    { op: 'update_day', dayId: 'sparse', date: '2026-10-03', theme: '改后主题' },
    { op: 'add_day', dayId: 'added', date: '2026-10-04', title: '  第三日  ', note: '\n整日说明\n' },
    { op: 'add_item', dayId: 'added', itemId: 'new-item', type: 'other', title: '新活动名称', note: '新活动备注', pending: true },
  ] })
  assert.ok(patch.ok)
  await synchronizeTripSchedule(f.repository, f.patchStore, 'patch')
  f.events.publish('patch', 'canvas', 'ai_patch')
  const after = await f.reads('patch')
  assert.deepEqual(after.days.map(({ id, tripId, index, dayNumber, date }) => [id, tripId, index, dayNumber, date]), [
    ['first', 'patch', 0, 1, '2026-10-02'], ['sparse', 'patch', 1, 2, '2026-10-03'], ['added', 'patch', 2, 3, '2026-10-04'],
  ])
  assertMetadata(after.days[0]!, '第一日名称', '第一日备注')
  assertMetadata(after.days[1]!, '稀疏日名称', '稀疏日备注')
  assertMetadata(after.days[2]!, '  第三日  ', '\n整日说明\n')
  assert.deepEqual(after.days[1]!.items, before.days[1]!.items)
  assert.deepEqual(after.legs.filter((leg) => leg.id === 'leg-a-b'), before.legs)
  assert.ok(after.legs.some((leg) => leg.fromItemId === 'b' && leg.toItemId === 'new-item'), 'existing patch behavior adds the new cross-day adjacency')
  const metaOnly = await applyTripPatch(f.patchStore, 'patch', { ops: [{ op: 'update_day', dayId: 'sparse', note: '' }, { op: 'update_day', dayId: 'added', title: '' }] })
  assert.ok(metaOnly.ok)
  const metadataRead = await f.reads('patch')
  assertMetadata(metadataRead.days[1]!, '稀疏日名称', '')
  assertMetadata(metadataRead.days[2]!, '', '\n整日说明\n')
  assert.deepEqual(metadataRead.days[1]!.items, before.days[1]!.items)
  assert.deepEqual(metadataRead.legs, after.legs)
})

test('legacy seed, guide import and empty creates keep NULL storage and omit independent metadata', async (t) => {
  const f = await fixture(t)
  await seedBuiltinTrip(f.db)
  const seeded = await f.reads(BUILTIN_TRIP_ID)
  assert.ok(seeded.days.some((day) => day.theme && day.items.some((item) => item.note)))
  for (const day of seeded.days) assertMetadata(day, undefined, undefined)
  const imported = await importGuide({ importId: randomUUID(), draft: {
    title: '攻略名称', destination: '成都', dateStatus: 'unspecified', warnings: [],
    days: [{ dayNumber: 1, title: '攻略日标题', items: [{ type: 'other', title: '活动标题', note: '攻略活动备注', region: '成都', pending: true, poi: null }] }],
  } }, undefined, f.fetchLike)
  assert.ok(imported.ok)
  const guide = await f.reads(imported.data.id)
  assert.equal(guide.days[0]!.theme, '攻略日标题')
  assertMetadata(guide.days[0]!, undefined, undefined)
  await f.trip('empty')
  const empty = await createWorkbenchDay('empty', {}, f.fetchLike)
  assert.ok(empty.ok)
  assertMetadata(empty.data, undefined, undefined)
  assert.equal((await f.db.run('SELECT * FROM days WHERE title IS NOT NULL OR note IS NOT NULL')).rows.length, 0)
})

test('corrupt SQLite metadata is omitted independently without losing days, items or legitimate empty text', async (t) => {
  const f = await fixture(t)
  await f.trip('corrupt')
  for (const [id, title, note] of [
    ['bad-title', new Uint8Array([1]), '  有效备注  '],
    ['bad-note', '', new Uint8Array([2])],
    ['legacy', null, null],
  ] as const) {
    await f.db.run('INSERT INTO days (id, trip_id, idx, date, theme, title, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, 'corrupt', 0, '2026-10-02', '旧主题', title, note])
    await f.db.run('INSERT INTO items (id, trip_id, day_id, item_order, type, title, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [`${id}-item`, 'corrupt', id, 0, 'other', '保留活动', '活动备注'])
  }
  const read = await f.reads('corrupt')
  assert.equal(read.days.length, 3)
  assertMetadata(read.days.find((day) => day.id === 'bad-title')!, undefined, '  有效备注  ')
  assertMetadata(read.days.find((day) => day.id === 'bad-note')!, '', undefined)
  assertMetadata(read.days.find((day) => day.id === 'legacy')!, undefined, undefined)
  assert.equal(read.days.flatMap((day) => day.items).length, 3)
  assert.ok(read.days.every((day) => day.items[0]!.note === '活动备注'))
})
