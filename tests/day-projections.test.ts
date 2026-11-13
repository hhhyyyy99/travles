import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  DaySchema, TripSchema, type ActivityItem, type Day, type TripPlanningContext,
  type TripSummary, type TripPatchInput,
} from '@hailar/domain'
import { createApp } from '../server/src/app.js'
import { createSqliteDatabase, type SqlDatabase, type SqlValue } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { SqliteContentStoreDriver } from '../server/src/content/driver-sqlite.js'
import { TripContentRepository } from '../server/src/content/repository.js'
import type { DayContent } from '../server/src/content/types.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { createSqliteDaysAdminStore } from '../server/src/days-admin/driver-sqlite.js'
import { DaysAdminRepository } from '../server/src/days-admin/repository.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../server/src/trips/repository.js'
import { createSqliteTripPatchStore } from '../server/src/trip-patch/store-sqlite.js'
import { applyTripPatch } from '../server/src/trip-patch/apply.js'
import { synchronizeTripSchedule } from '../server/src/trip-events/schedule.js'
import { TripEventHub } from '../server/src/trip-events/hub.js'
import { seedBuiltinTrip } from '../server/src/seed/seed.js'
import { BUILTIN_TRIP_ID } from '../server/src/seed/builtin-trip-data.js'
import { createTrip, type FetchLike } from '../src/domain/tripList'
import { importGuide } from '../src/domain/guideParsing'
import {
  createWorkbenchDay as createDay, updateWorkbenchDay as updateDay, fetchTripCanvas,
} from '../src/domain/workbench'

const timestamp = '2026-09-01T00:00:00.000Z'
const planningContext: TripPlanningContext = {
  destination: '成都', durationDays: 7, preferences: '慢节奏',
  originalSentence: '成都7天，慢节奏', dateStatus: 'tentative',
}

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
    daysAdminStore: createSqliteDaysAdminStore(db),
    tripPatchStore: patchStore,
    guideImportDatabase: db,
    tripEvents: events,
  })
  const fetchLike: FetchLike = (url, init) => app.request(url, init)
  return { db, repository, patchStore, events, fetchLike }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

async function sourceSnapshot(db: SqlDatabase) {
  return Promise.all(['trips', 'days', 'items', 'legs', 'guide_imports', 'app_meta'].map(async (table) =>
    (await db.run(`SELECT * FROM ${table} ORDER BY 1`)).rows))
}

async function insertTrip(db: SqlDatabase, id: string, startDate = '', endDate = '') {
  await db.run(
    'INSERT INTO trips (id, title, start_date, end_date, planning_context, cover_image, is_pinned, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, '标题不能作为 Day 投影来源', startDate, endDate, JSON.stringify(planningContext),
      '/source-cover.jpg', 0, 'source-status', timestamp, timestamp],
  )
}

async function insertDay(db: SqlDatabase, tripId: string, id: string, idx: SqlValue, date = '', theme = '原主题', color = '#123456') {
  await db.run('INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES (?, ?, ?, ?, ?, ?)',
    [id, tripId, idx, date, theme, color])
}

async function insertItem(db: SqlDatabase, tripId: string, dayId: string, id: string, order: number) {
  await db.run(
    'INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, images, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, tripId, dayId, order, 'other', `卡片 ${id}`, '原备注', '[{"url":"/source.jpg","caption":"原图"}]', 1],
  )
}

function expectedItem(dayId: string, id: string, order: number): ActivityItem {
  return {
    id, dayId, order, type: 'other', title: `卡片 ${id}`, note: '原备注', poi: null,
    images: [{ url: '/source.jpg', caption: '原图' }], pending: true,
  }
}

/** Exercise both HTTP read models and the actual browser decoder, without changing source rows. */
async function readPaths(f: Fixture, tripId: string) {
  const before = await sourceSnapshot(f.db)
  const contentResponse = await f.fetchLike(`/api/trips/${tripId}/days`)
  assert.equal(contentResponse.status, 200)
  const content = (await contentResponse.json() as { days: DayContent[] }).days
  const canvasResponse = await f.fetchLike(`/api/trips/${tripId}/canvas`)
  assert.equal(canvasResponse.status, 200)
  const raw = await canvasResponse.json() as { trip: TripSummary; days: Day[]; legs: unknown[] }
  const client = await fetchTripCanvas(tripId, f.fetchLike)
  assert.ok(client.ok)
  assert.deepEqual(client.data, raw, 'fetchTripCanvas retains the complete HTTP projections')
  assert.deepEqual(TripSchema.parse(raw.trip), raw.trip)
  for (const day of raw.days) assert.deepEqual(DaySchema.parse(day), day)
  assert.deepEqual(await sourceSnapshot(f.db), before, 'GET /days, GET /canvas and the browser client never mutate SQLite')
  return { content, ...client.data }
}

function assertTripProjections(trip: TripSummary, daysCount: number) {
  assert.equal(trip.destination, '成都')
  assert.equal(trip.daysCount, daysCount)
  assert.equal(trip.durationDays, 7)
  assert.equal(trip.dateStatus, planningContext.dateStatus)
  assert.deepEqual(trip.planningContext, planningContext)
  assert.equal(trip.coverImage, '/source-cover.jpg')
  assert.equal(trip.isPinned, false)
  assert.equal(trip.status, 'source-status')
}

test('real built-in seed rows retain day identity, legacy fields and every item through content, canvas and client reads', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await seedBuiltinTrip(f.db), { seeded: true })
  const sourceDays = (await f.db.run('SELECT * FROM days WHERE trip_id = ? ORDER BY idx', [BUILTIN_TRIP_ID])).rows
  const sourceItems = (await f.db.run('SELECT * FROM items WHERE trip_id = ? ORDER BY day_id, item_order, id', [BUILTIN_TRIP_ID])).rows
  const result = await readPaths(f, BUILTIN_TRIP_ID)
  assert.equal(result.trip.daysCount, 7, 'earlier optional Trip projections survive canvas decoding')
  assert.deepEqual(result.days.map((day) => [day.id, day.tripId, day.index, day.dayNumber, day.date]), [
    ['builtin-day-0', BUILTIN_TRIP_ID, 0, 1, '2026-10-02'],
    ['builtin-day-1', BUILTIN_TRIP_ID, 1, 2, '2026-10-03'],
    ['builtin-day-2', BUILTIN_TRIP_ID, 2, 3, '2026-10-04'],
    ['builtin-day-3', BUILTIN_TRIP_ID, 3, 4, '2026-10-05'],
    ['builtin-day-4', BUILTIN_TRIP_ID, 4, 5, '2026-10-06'],
    ['builtin-day-5', BUILTIN_TRIP_ID, 5, 6, '2026-10-07'],
    ['builtin-day-6', BUILTIN_TRIP_ID, 6, 7, '2026-10-08'],
  ])
  assert.deepEqual(result.content.map((day) => [day.id, day.tripId, day.idx, day.dayNumber, day.date]),
    result.days.map((day) => [day.id, day.tripId, day.index, day.dayNumber, day.date]))
  for (const [index, day] of result.days.entries()) {
    const source = sourceDays[index]!
    assert.equal(day.theme, source.theme)
    assert.equal(day.color, '')
    assert.equal(Object.hasOwn(day, 'idx'), false)
    assert.equal(Object.hasOwn(result.content[index]!, 'index'), false)
    const items = sourceItems.filter((row) => row.day_id === day.id)
    assert.ok(items.length > 0)
    assert.deepEqual(day.items.map((item) => [item.id, item.dayId, item.order, item.title, item.note]),
      items.map((row) => [row.id, row.day_id, row.item_order, row.title, row.note]))
    assert.deepEqual(result.content[index]!.items.map((item) => [item.id, item.dayId, item.itemOrder, item.title, item.note]),
      items.map((row) => [row.id, row.day_id, row.item_order, row.title, row.note]))
  }
})

test('reading sparse and duplicate SQLite indices gives equal dayNumbers without reindexing days or item order', async (t) => {
  const f = await fixture(t)
  const tripId = 'sparse-read'
  await insertTrip(f.db, tripId)
  // Deliberately insert ties out of lexical order; reads retain the old idx/id ordering.
  await insertDay(f.db, tripId, 'day-b', 4, 'legacy date')
  await insertDay(f.db, tripId, 'day-c', 9, '2026-10-09')
  await insertDay(f.db, tripId, 'day-a', 4, '2026-10-04')
  await insertDay(f.db, tripId, 'day-zero', 0)
  await insertItem(f.db, tripId, 'day-a', 'item-z', 7)
  await insertItem(f.db, tripId, 'day-a', 'item-b', 2)
  await insertItem(f.db, tripId, 'day-a', 'item-a', 2)
  await insertTrip(f.db, 'foreign-trip')
  await insertDay(f.db, 'foreign-trip', 'foreign-day', 17, '2026-12-31', '隔离的其他行程', '#fedcba')
  await insertItem(f.db, 'foreign-trip', 'foreign-day', 'foreign-item', 99)
  const before = await sourceSnapshot(f.db)
  const result = await readPaths(f, tripId)
  assertTripProjections(result.trip, 7)
  assert.deepEqual(result.days, [
    { id: 'day-zero', tripId, index: 0, dayNumber: 1, date: '', theme: '原主题', color: '#123456', items: [] },
    { id: 'day-a', tripId, index: 4, dayNumber: 5, date: '2026-10-04', theme: '原主题', color: '#123456',
      items: [expectedItem('day-a', 'item-a', 2), expectedItem('day-a', 'item-b', 2), expectedItem('day-a', 'item-z', 7)] },
    { id: 'day-b', tripId, index: 4, dayNumber: 5, date: '', theme: '原主题', color: '#123456', items: [] },
    { id: 'day-c', tripId, index: 9, dayNumber: 10, date: '2026-10-09', theme: '原主题', color: '#123456', items: [] },
  ])
  assert.deepEqual(result.content.map((day) => [day.id, day.tripId, day.idx, day.dayNumber, day.date]), [
    ['day-zero', tripId, 0, 1, ''], ['day-a', tripId, 4, 5, '2026-10-04'],
    ['day-b', tripId, 4, 5, 'legacy date'], ['day-c', tripId, 9, 10, '2026-10-09'],
  ])
  assert.deepEqual(result.content.find((day) => day.id === 'day-a')!.items.map((item) => [item.id, item.dayId, item.itemOrder]),
    [['item-a', 'day-a', 2], ['item-b', 'day-a', 2], ['item-z', 'day-a', 7]])
  const foreign = await readPaths(f, 'foreign-trip')
  assert.deepEqual(foreign.days, [{
    id: 'foreign-day', tripId: 'foreign-trip', index: 17, dayNumber: 18, date: '2026-12-31',
    theme: '隔离的其他行程', color: '#fedcba', items: [expectedItem('foreign-day', 'foreign-item', 99)],
  }])
  assert.deepEqual(foreign.content.map((day) => [day.id, day.tripId, day.idx, day.dayNumber]),
    [['foreign-day', 'foreign-trip', 17, 18]])
  await readPaths(f, tripId)
  assert.deepEqual(await sourceSnapshot(f.db), before, 'repeated reads preserve sparse/duplicate SQLite source values and the other trip')
})

test('only lawful raw numeric SQLite indices project a safe dayNumber while corrupt indices retain old coercions and items', async (t) => {
  const f = await fixture(t)
  const tripId = 'raw-index-boundaries'
  await insertTrip(f.db, tripId)
  const cases: Array<{
    id: string; raw: SqlValue; contentIdx: number; canvasIndex: number; dayNumber?: number; real?: boolean; infinite?: boolean
  }> = [
    { id: 'zero', raw: 0, contentIdx: 0, canvasIndex: 0, dayNumber: 1 },
    { id: 'numeric-text-affinity', raw: '3', contentIdx: 3, canvasIndex: 3, dayNumber: 4 },
    { id: 'negative', raw: -2, contentIdx: -2, canvasIndex: -2 },
    { id: 'negative-fraction', raw: -1.5, contentIdx: 0, canvasIndex: -1.5 },
    { id: 'fraction', raw: 1.5, contentIdx: 0, canvasIndex: 1.5 },
    { id: 'bad-text', raw: 'bad index', contentIdx: 0, canvasIndex: 0 },
    { id: 'empty-text', raw: '', contentIdx: 0, canvasIndex: 0 },
    { id: 'blank-text', raw: '  ', contentIdx: 0, canvasIndex: 0 },
    { id: 'hex-text', raw: '0x10', contentIdx: 16, canvasIndex: 16 },
    { id: 'blob', raw: new Uint8Array([1, 2]), contentIdx: 0, canvasIndex: 0 },
    { id: 'infinite', raw: '1e999', contentIdx: 0, canvasIndex: 0, infinite: true },
    { id: 'last-safe-successor', raw: 9007199254740990, contentIdx: 9007199254740990, canvasIndex: 9007199254740990, dayNumber: 9007199254740991 },
    { id: 'unsafe-successor', raw: 9007199254740991, contentIdx: 9007199254740991, canvasIndex: 9007199254740991 },
    { id: 'unsafe-real-index', raw: 1e20, contentIdx: 1e20, canvasIndex: 1e20, real: true },
  ]
  for (const item of cases) {
    // libSQL forbids Infinity bind arguments; SQLite can still retain it as a REAL expression.
    if (item.infinite) {
      await f.db.run('INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES (?, ?, 1e999, ?, ?, ?)',
        [item.id, tripId, '2026-10-02', '原主题', '#123456'])
    // Values beyond SQLite's signed integer range remain REAL under INTEGER affinity.
    } else if (item.real) {
      await f.db.run('INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES (?, ?, CAST(? AS REAL), ?, ?, ?)',
        [item.id, tripId, item.raw, '2026-10-02', '原主题', '#123456'])
    } else {
      await insertDay(f.db, tripId, item.id, item.raw, '2026-10-02')
    }
    await insertItem(f.db, tripId, item.id, `item-${item.id}`, 6)
  }
  const storedTypes = (await f.db.run('SELECT id, typeof(idx) AS storage_type FROM days')).rows
  assert.equal(storedTypes.find((row) => row.id === 'numeric-text-affinity')!.storage_type, 'integer')
  assert.equal(storedTypes.find((row) => row.id === 'hex-text')!.storage_type, 'text')
  assert.equal(storedTypes.find((row) => row.id === 'blob')!.storage_type, 'blob')
  assert.equal(storedTypes.find((row) => row.id === 'unsafe-real-index')!.storage_type, 'real')
  const result = await readPaths(f, tripId)
  assert.equal(result.content.length, cases.length)
  assert.equal(result.days.length, cases.length)
  for (const item of cases) {
    const content = result.content.find((day) => day.id === item.id)!
    const day = result.days.find((day) => day.id === item.id)!
    assert.equal(content.idx, item.contentIdx, `${item.id}: legacy content idx`)
    assert.equal(day.index, item.canvasIndex, `${item.id}: legacy canvas index`)
    for (const value of [content, day]) {
      assert.equal(value.tripId, tripId, item.id)
      assert.equal(value.dayNumber, item.dayNumber, item.id)
      assert.equal(Object.hasOwn(value, 'dayNumber'), item.dayNumber !== undefined, `${item.id}: absent means omitted`)
      assert.equal(value.date, '2026-10-02')
      assert.equal(value.theme, '原主题')
      assert.equal(value.color, '#123456')
    }
    assert.deepEqual(day.items, [expectedItem(item.id, `item-${item.id}`, 6)])
    assert.deepEqual(content.items.map((entry) => [entry.id, entry.dayId, entry.itemOrder]), [[`item-${item.id}`, item.id, 6]])
  }
})

test('empty and manual day creation return projections through the actual createDay client', async (t) => {
  const f = await fixture(t)
  const createdTrip = await createTrip({ title: '手动空行程', startDate: '2026-10-02', endDate: '2026-10-02' }, f.fetchLike)
  assert.ok(createdTrip.ok)
  const tripId = createdTrip.data.id
  const empty = await createDay(tripId, {}, f.fetchLike)
  assert.ok(empty.ok)
  assert.deepEqual(empty.data, { id: empty.data.id, tripId, dayNumber: 1, index: 0, date: '', theme: '', color: '', items: [] })
  assert.deepEqual((await readPaths(f, tripId)).days, [empty.data])
  const manual = await createDay(tripId, { date: '2026-10-02', theme: '  自由活动  ', color: '  #abcdef  ' }, f.fetchLike)
  assert.ok(manual.ok)
  assert.deepEqual(manual.data, {
    id: manual.data.id, tripId, dayNumber: 2, index: 1, date: '2026-10-02', theme: '自由活动', color: '#abcdef', items: [],
  })
  assert.deepEqual((await readPaths(f, tripId)).days, [empty.data, manual.data])
})

test('POST and PATCH immediate day responses agree with subsequent synchronized sparse-index reads and keep write items empty', async (t) => {
  for (const operation of ['POST', 'PATCH'] as const) {
    await t.test(operation, async (t) => {
      const f = await fixture(t)
      const tripId = `sparse-${operation}`
      await insertTrip(f.db, tripId, '2026-10-02', '2026-10-08')
      await insertDay(f.db, tripId, 'day-first', 3, '2026-10-04')
      await insertDay(f.db, tripId, 'day-target', 8, '2026-10-08')
      await insertItem(f.db, tripId, 'day-target', 'retained-item', 6)
      const itemsBefore = (await f.db.run('SELECT * FROM items ORDER BY id')).rows
      const observed: Array<ReturnType<typeof readPaths>> = []
      t.after(f.events.subscribe(tripId, () => observed.push(readPaths(f, tripId))))
      let immediateRaw: Day | undefined
      const capture: FetchLike = async (url, init) => {
        const response = await f.fetchLike(url, init)
        immediateRaw = (await response.clone().json() as { day: Day }).day
        return response
      }
      const result = operation === 'POST'
        ? await createDay(tripId, { theme: '新增主题', color: '#abcdef' }, capture)
        : await updateDay(tripId, 'day-target', { theme: '修改主题', color: '#abcdef' }, capture)
      assert.ok(result.ok)
      const expected: Day = {
        id: result.data.id, tripId,
        index: operation === 'POST' ? 2 : 1, dayNumber: operation === 'POST' ? 3 : 2,
        date: operation === 'POST' ? '2026-10-04' : '2026-10-03',
        theme: operation === 'POST' ? '新增主题' : '修改主题', color: '#abcdef', items: [],
      }
      assert.deepEqual(immediateRaw, expected, 'HTTP response must reread index/dayNumber/date after schedule synchronization')
      assert.deepEqual(result.data, expected, 'the real frontend client retains the immediate write projections')
      const readback = await readPaths(f, tripId)
      assert.deepEqual(readback.days.find((day) => day.id === result.data.id), {
        ...expected, items: operation === 'PATCH' ? [expectedItem('day-target', 'retained-item', 6)] : [],
      })
      const content = readback.content.find((day) => day.id === result.data.id)!
      assert.deepEqual([content.tripId, content.idx, content.dayNumber, content.date],
        [expected.tripId, expected.index, expected.dayNumber, expected.date])
      assert.deepEqual(readback.days.map((day) => [day.index, day.dayNumber, day.date]), operation === 'POST'
        ? [[0, 1, '2026-10-02'], [1, 2, '2026-10-03'], [2, 3, '2026-10-04']]
        : [[0, 1, '2026-10-02'], [1, 2, '2026-10-03']])
      assert.deepEqual(readback.days.find((day) => day.id === 'day-target')!.items, [expectedItem('day-target', 'retained-item', 6)])
      assert.deepEqual((await f.db.run('SELECT * FROM items ORDER BY id')).rows, itemsBefore)
      assert.equal(observed.length, 1)
      assert.deepEqual((await observed[0]!).days, readback.days, 'day change event exposes the synchronized projection')
      assert.equal(readback.trip.daysCount, operation === 'POST' ? 3 : 2)
      assert.equal(readback.trip.destination, '成都')
      assert.equal(readback.trip.coverImage, '/source-cover.jpg')
    })
  }
})

test('authoritative day rereads keep SQLite ownership checks and report missing rows or storage errors', async (t) => {
  const f = await fixture(t)
  const tripId = 'reread-failures'
  await insertTrip(f.db, tripId)
  await insertDay(f.db, tripId, 'reread-day', 4, '2026-10-02')
  const store = createSqliteDaysAdminStore(f.db)
  const days = new DaysAdminRepository(store)
  assert.deepEqual(await days.getDay(tripId, 'reread-day'), { ok: true, day: {
    id: 'reread-day', tripId, index: 4, dayNumber: 5, date: '2026-10-02',
    theme: '原主题', color: '#123456', items: [],
  } })
  assert.deepEqual(await days.getDay('foreign-trip', 'reread-day'), { ok: false, error: '日程不存在', code: 'not_found' })
  await f.db.run('DELETE FROM days WHERE id = ?', ['reread-day'])
  assert.deepEqual(await days.getDay(tripId, 'reread-day'), { ok: false, error: '日程不存在', code: 'not_found' })
  // The failure seam changes only the SQLite lookup; the preceding reads/writes use real rows.
  store.getDayRow = async () => { throw new Error('SQLite read unavailable') }
  assert.deepEqual(await days.getDay(tripId, 'reread-day'), { ok: false, error: '读取日程失败', code: 'storage' })
})

test('guide import client creates genuine day ownership and one-based projections that survive HTTP and canvas readback', async (t) => {
  const f = await fixture(t)
  const imported = await importGuide({ importId: randomUUID(), draft: {
    title: '成都攻略', destination: '成都', dateStatus: 'unspecified', warnings: [],
    days: [
      { dayNumber: 1, title: '散步', items: [
        { type: 'other', title: '先散步', note: '原备注', region: '成都', pending: false, poi: null },
        { type: 'food', title: '再吃饭', note: '', region: '成都', pending: true, poi: null },
      ] },
      { dayNumber: 2, title: '休息', items: [
        { type: 'other', title: '自由休息', note: '', region: '成都', pending: false, poi: null },
      ] },
    ],
  } }, undefined, f.fetchLike)
  assert.ok(imported.ok)
  const tripId = imported.data.id
  const result = await readPaths(f, tripId)
  assert.deepEqual(result.trip, imported.data)
  assert.equal(result.trip.destination, '成都')
  assert.equal(result.trip.daysCount, 2)
  assert.equal(result.trip.durationDays, 2)
  assert.equal(result.trip.dateStatus, 'unspecified')
  assert.equal(result.trip.planningContext?.source, 'guide')
  assert.deepEqual(result.days.map((day) => [day.tripId, day.index, day.dayNumber, day.date, day.theme, day.color]),
    [[tripId, 0, 1, '', '散步', ''], [tripId, 1, 2, '', '休息', '']])
  assert.deepEqual(result.content.map((day) => [day.tripId, day.idx, day.dayNumber, day.date, day.theme, day.color]),
    [[tripId, 0, 1, '', '散步', ''], [tripId, 1, 2, '', '休息', '']])
  const first = result.days[0]!
  assert.deepEqual(first.items.map((item) => [item.dayId, item.order, item.type, item.title, item.pending]),
    [[first.id, 0, 'other', '先散步', false], [first.id, 1, 'food', '再吃饭', true]])
  assert.deepEqual(result.content[0]!.items.map((item) => [item.id, item.dayId, item.itemOrder]),
    first.items.map((item) => [item.id, item.dayId, item.order]))
  assert.deepEqual(result.days[1]!.items.map((item) => [item.dayId, item.order, item.title]), [[result.days[1]!.id, 0, '自由休息']])
})

test('actual SQLite TripPatch apply then schedule synchronization and event refetch retain day and Trip projections', async (t) => {
  const f = await fixture(t)
  const tripId = 'patch-event-sequence'
  await insertTrip(f.db, tripId, '2026-10-02', '2026-10-03')
  await insertDay(f.db, tripId, 'patch-first', 0, '2026-10-02')
  await insertDay(f.db, tripId, 'patch-existing', 4, '2026-10-03')
  await insertItem(f.db, tripId, 'patch-existing', 'existing-item', 6)
  const snapshots: Array<ReturnType<typeof readPaths>> = []
  t.after(f.events.subscribe(tripId, () => snapshots.push(readPaths(f, tripId))))
  const patch: TripPatchInput = { ops: [
    { op: 'add_day', dayId: 'patch-added', date: '2026-10-04', theme: '补充一天' },
    { op: 'add_item', dayId: 'patch-added', itemId: 'patch-item', type: 'other', title: '新卡片', pending: true },
  ] }
  assert.ok((await applyTripPatch(f.patchStore, tripId, patch)).ok)
  await synchronizeTripSchedule(f.repository, f.patchStore, tripId)
  f.events.publish(tripId, 'canvas', 'ai_patch')
  const added = await snapshots[0]!
  assert.deepEqual(added.days.map((day) => [day.id, day.tripId, day.index, day.dayNumber, day.date]), [
    ['patch-first', tripId, 0, 1, '2026-10-02'], ['patch-existing', tripId, 1, 2, '2026-10-03'],
    ['patch-added', tripId, 2, 3, '2026-10-04'],
  ])
  assert.deepEqual(added.days[1]!.items, [expectedItem('patch-existing', 'existing-item', 6)])
  assert.deepEqual(added.days[2]!.items.map((item) => [item.id, item.dayId, item.order]), [['patch-item', 'patch-added', 0]])
  assert.equal(added.trip.daysCount, 3)
  assert.equal(added.trip.durationDays, 7)
  assert.equal(added.trip.destination, '成都')
  assert.deepEqual(added.trip.planningContext, {
    ...planningContext, dateStatus: 'confirmed', datePhrase: '2026-10-02 至 2026-10-04',
  })
  assert.equal(added.trip.coverImage, '/source-cover.jpg')
  assert.equal(added.trip.isPinned, false)
  assert.equal(added.trip.status, 'source-status')
  const removed = await applyTripPatch(f.patchStore, tripId, { ops: [{ op: 'remove_day', dayId: 'patch-first' }] })
  assert.ok(removed.ok)
  await synchronizeTripSchedule(f.repository, f.patchStore, tripId, { compactDates: removed.stats.daysRemoved > 0 })
  f.events.publish(tripId, 'canvas', 'ai_patch')
  const compacted = await snapshots[1]!
  assert.deepEqual(compacted.days.map((day) => [day.id, day.tripId, day.index, day.dayNumber, day.date]), [
    ['patch-existing', tripId, 0, 1, '2026-10-02'], ['patch-added', tripId, 1, 2, '2026-10-03'],
  ])
  assert.deepEqual(compacted.content.map((day) => [day.id, day.tripId, day.idx, day.dayNumber, day.date]),
    compacted.days.map((day) => [day.id, day.tripId, day.index, day.dayNumber, day.date]))
  assert.deepEqual(compacted.days.flatMap((day) => day.items.map((item) => [item.id, item.dayId, item.order])),
    [['existing-item', 'patch-existing', 6], ['patch-item', 'patch-added', 0]])
  assert.equal(compacted.trip.daysCount, 2)
  assert.equal(f.events.revision(tripId), 2)
  assert.deepEqual((await readPaths(f, tripId)).days, compacted.days)
})
