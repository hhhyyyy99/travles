import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { TripSchema, type TripPlanningContext, type TripSummary } from '@hailar/domain'
import { createApp } from '../server/src/app.js'
import { createSqliteDatabase } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../server/src/trips/repository.js'
import { createTrip, createTripFromSentence, fetchTrips, formatTripSchedule, normalizeTrip, renameTrip, type FetchLike } from '../src/domain/tripList'
import { importGuide } from '../src/domain/guideParsing'
import { fetchTripCanvas } from '../src/domain/workbench'

const timestamp = '2026-09-01T00:00:00.000Z'
const context: TripPlanningContext = {
  destination: '成都', durationDays: 7, preferences: '慢节奏',
  originalSentence: '成都7天，慢节奏', dateStatus: 'unspecified',
}

async function fixture(t: TestContext) {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  await ensureSchema(db)
  const repository = new TripRepository(new SqliteTripStoreDriver(db))
  const app = await createApp({ tripRepository: repository, workbenchStore: createSqliteWorkbenchStore(db), guideImportDatabase: db })
  const fetchLike: FetchLike = (url, init) => app.request(url, init)
  return { db, repository, fetchLike }
}

async function assertReadPaths(fetchLike: FetchLike, expected: TripSummary): Promise<void> {
  const detail = await fetchLike(`/api/trips/${expected.id}`)
  assert.equal(detail.status, 200)
  assert.deepEqual((await detail.json() as { trip: unknown }).trip, expected, `${expected.id}: detail`)
  const listed = await fetchTrips(fetchLike)
  assert.equal(listed.ok, true)
  if (listed.ok) assert.deepEqual(listed.data.find((trip) => trip.id === expected.id), expected, `${expected.id}: list client`)
  const canvas = await fetchTripCanvas(expected.id, fetchLike)
  assert.equal(canvas.ok, true)
  if (canvas.ok) assert.deepEqual(canvas.data.trip, expected, `${expected.id}: canvas client`)
  assert.deepEqual(TripSchema.parse(expected), expected)
}

test('SQLite read projections preserve old rows and date/context boundaries through HTTP and browser clients', async (t) => {
  const { db, repository, fetchLike } = await fixture(t)
  const cases: Array<{
    id: string; startDate: string; endDate: string; days: number; daysCount?: number
    storedContext?: string | null; expectedContext?: TripPlanningContext
  }> = [
    { id: 'legacy-dated', startDate: '2026-10-02', endDate: '2026-10-04', days: 3, daysCount: 3 },
    { id: 'legacy-undated', startDate: '', endDate: '', days: 0 },
    { id: 'same-day', startDate: '2026-10-02', endDate: '2026-10-02', days: 1, daysCount: 1 },
    { id: 'cross-year', startDate: '2026-12-31', endDate: '2027-01-01', days: 2, daysCount: 2 },
    { id: 'leap-day', startDate: '2028-02-28', endDate: '2028-03-01', days: 3, daysCount: 3 },
    { id: 'over-60-days', startDate: '2026-01-01', endDate: '2026-03-31', days: 90, daysCount: 90 },
  ]
  for (const dateStatus of ['confirmed', 'unspecified', 'tentative'] as const) {
    const expectedContext = { ...context, dateStatus }
    const storedContext = JSON.stringify(expectedContext)
    cases.push(
      { id: `${dateStatus}-dated`, startDate: '2026-10-02', endDate: '2026-10-04', days: 3, daysCount: 3, storedContext, expectedContext },
      { id: `${dateStatus}-undated`, startDate: '', endDate: '', days: 0,
        ...(dateStatus !== 'confirmed' ? { daysCount: 7 } : {}), storedContext, expectedContext },
    )
  }
  for (const durationDays of [1, 60]) {
    const expectedContext = { ...context, durationDays }
    cases.push({ id: `planned-${durationDays}`, startDate: '', endDate: '', days: 0, daysCount: durationDays,
      storedContext: JSON.stringify(expectedContext), expectedContext })
  }
  // Neither an invalid/partial range nor a corrupt context is a trusted duration.
  for (const [id, startDate, endDate] of [
    ['invalid-date', '2026-02-29', '2026-03-01'],
    ['reversed', '2026-10-04', '2026-10-02'],
    ['partial', '2026-10-02', ''],
  ]) {
    cases.push({ id: id!, startDate: startDate!, endDate: endDate!, days: 0,
      storedContext: JSON.stringify(context), expectedContext: context })
  }
  const badContexts = [
    null, '', '{broken', 'null', '[]', '{}',
    ...[{ destination: 42 }, { destination: '' }, { durationDays: 0 }, { durationDays: 61 },
      { durationDays: 1.5 }, { preferences: '' }, { originalSentence: '' }, { dateStatus: 'unknown' }]
      .map((patch) => JSON.stringify({ ...context, ...patch })),
  ]
  for (const [index, storedContext] of badContexts.entries()) {
    cases.push({ id: `bad-context-${index}`, startDate: '', endDate: '', days: 0, storedContext })
  }
  cases.push({ id: 'dated-bad-context', startDate: '2026-10-02', endDate: '2026-10-04', days: 3, daysCount: 3, storedContext: '{broken' })

  for (const item of cases) {
    await db.run('INSERT INTO trips (id, title, start_date, end_date, planning_context, created_at, updated_at, cover_image, is_pinned, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [item.id, '呼伦贝尔7日（标题不能充当投影来源）', item.startDate, item.endDate,
        item.storedContext ?? null, timestamp, timestamp, '/cover.jpg', 0, 'source-status'])
  }
  const before = (await db.run('SELECT * FROM trips ORDER BY id')).rows
  for (const item of cases) {
    const expected: TripSummary = {
      id: item.id, title: '呼伦贝尔7日（标题不能充当投影来源）', startDate: item.startDate, endDate: item.endDate,
      days: item.days, nights: Math.max(0, item.days - 1), createdAt: timestamp, updatedAt: timestamp,
      coverImage: '/cover.jpg', isPinned: false, status: 'source-status',
      ...(item.daysCount !== undefined ? { daysCount: item.daysCount } : {}),
      ...(item.expectedContext ? { destination: item.expectedContext.destination, durationDays: item.expectedContext.durationDays,
        dateStatus: item.expectedContext.dateStatus, planningContext: item.expectedContext } : {}),
    }
    assert.deepEqual(await repository.get(item.id), expected, item.id)
    await assertReadPaths(fetchLike, expected)
  }
  assert.deepEqual((await db.run('SELECT * FROM trips ORDER BY id')).rows, before, 'reads never backfill or change source rows')

  // SQLite can retain non-text dates even in TEXT columns. Keep the existing
  // tolerant fields without interpreting a corrupt schedule as an undated plan.
  for (const [index, [startDate, endDate, daysCount]] of [
    [null, null, 7], ['', null, 7], ['  ', '', 7],
    [new Uint8Array([1]), new Uint8Array([2]), undefined],
    [new Uint8Array([1]), '', undefined], [42, 42, undefined],
  ].entries()) {
    const id = `date-source-${index}`
    await db.run('INSERT INTO trips (id, title, start_date, end_date, planning_context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, '来源边界', startDate ?? null, endDate ?? null, JSON.stringify(context), timestamp, timestamp])
    const trip = await repository.get(id)
    assert.ok(trip)
    assert.equal(trip.days, 0)
    assert.equal(trip.destination, context.destination)
    assert.deepEqual(trip.planningContext, context)
    assert.equal(trip.daysCount, daysCount, id)
    if (daysCount === undefined) assert.equal(Object.hasOwn(trip, 'daysCount'), false, id)
    await assertReadPaths(fetchLike, trip)
  }
})

test('a real 7-day intake redated to 3 days keeps PATCH, GET, list, canvas and rename projections consistent', async (t) => {
  const { db, repository, fetchLike } = await fixture(t)
  const created = await createTripFromSentence({ sentence: '成都7天，慢节奏' }, fetchLike)
  assert.ok(created.ok)
  const draft = created.data
  assert.equal(draft.destination, '成都')
  assert.equal(draft.daysCount, 7)
  assert.equal(draft.days, 0, 'draft placeholder day count cannot override the plan')
  assert.equal(formatTripSchedule(draft), '日期待定 · 7天6晚')
  await assertReadPaths(fetchLike, draft)
  const renamedDraft = await renameTrip(draft.id, '待定日期草稿', fetchLike)
  assert.ok(renamedDraft.ok)
  assert.equal(renamedDraft.data.daysCount, 7)
  assert.deepEqual(renamedDraft.data.planningContext, draft.planningContext)
  await assertReadPaths(fetchLike, renamedDraft.data)

  await db.run('UPDATE trips SET cover_image = ?, is_pinned = 0, status = ? WHERE id = ?', ['/source.jpg', 'source-label', draft.id])
  const response = await fetchLike(`/api/trips/${draft.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ startDate: '2026-10-02', endDate: '2026-10-04' }),
  })
  assert.equal(response.status, 200)
  const trip = TripSchema.parse((await response.json() as { trip: unknown }).trip)
  assert.equal(trip.daysCount, 3)
  assert.equal(trip.days, 3)
  assert.equal(trip.nights, 2)
  assert.equal(trip.durationDays, 7, 'the original plan remains available unchanged')
  assert.equal(trip.planningContext?.durationDays, 7)
  assert.equal(trip.dateStatus, 'confirmed')
  assert.equal(trip.destination, '成都')
  assert.equal(trip.coverImage, '/source.jpg')
  assert.equal(trip.isPinned, false)
  assert.equal(trip.status, 'source-label')
  assert.equal(formatTripSchedule(trip), '10.02至10.04 3天2晚')
  assert.deepEqual(normalizeTrip(trip), trip, 'browser preserves the immediate PATCH projections')
  assert.deepEqual(await repository.get(draft.id), trip)
  await assertReadPaths(fetchLike, trip)
  const renamed = await renameTrip(draft.id, '三日行', fetchLike)
  assert.ok(renamed.ok)
  assert.deepEqual(renamed.data, { ...trip, title: '三日行', updatedAt: renamed.data.updatedAt })
  await assertReadPaths(fetchLike, renamed.data)
  assert.equal((await db.run('SELECT * FROM days')).rows.length, 0, 'ungenerated canvas days are never counted')
  const stored = (await db.run('SELECT planning_context, cover_image, is_pinned, status FROM trips WHERE id = ?', [draft.id])).rows[0]!
  assert.deepEqual(JSON.parse(String(stored.planning_context)), renamed.data.planningContext)
  assert.deepEqual({ ...stored, planning_context: undefined }, {
    planning_context: undefined, cover_image: '/source.jpg', is_pinned: 0, status: 'source-label',
  })
})

test('existing manual creation and guide import return projections through their actual browser clients', async (t) => {
  const { fetchLike } = await fixture(t)
  const manual = await createTrip({ title: '成都标题不作为目的地', startDate: '2026-01-01', endDate: '2026-03-31' }, fetchLike)
  assert.ok(manual.ok)
  assert.equal(manual.data.daysCount, 90)
  assert.equal(Object.hasOwn(manual.data, 'destination'), false)
  await assertReadPaths(fetchLike, manual.data)
  const guide = await importGuide({ importId: randomUUID(), draft: {
    title: '成都攻略', destination: '成都', dateStatus: 'unspecified', warnings: [],
    days: [{ dayNumber: 1, title: '散步', items: [
      { type: 'other', title: '自由活动', note: '', region: '成都', pending: false, poi: null },
    ] }],
  } }, undefined, fetchLike)
  assert.ok(guide.ok)
  assert.equal(guide.data.destination, '成都')
  assert.equal(guide.data.daysCount, 1)
  assert.equal(guide.data.days, 0)
  await assertReadPaths(fetchLike, guide.data)
})

test('browser normalization keeps only explicit valid projections and omits bad fields independently', () => {
  const legacy: TripSummary = {
    id: 'old-server', title: '成都', startDate: '2026-10-02', endDate: '2026-10-04',
    days: 3, nights: 2, createdAt: timestamp, updatedAt: timestamp, isPinned: false,
    durationDays: 7, dateStatus: context.dateStatus, planningContext: context,
  }
  assert.deepEqual(normalizeTrip(legacy), legacy, 'do not synthesize fields for an old server')
  for (const daysCount of [null, '7', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(normalizeTrip({ ...legacy, destination: '  明确提供  ', daysCount }), {
      ...legacy, destination: '  明确提供  ',
    }, String(daysCount))
  }
  for (const destination of [null, 42, {}]) {
    assert.deepEqual(normalizeTrip({ ...legacy, destination, daysCount: 61 }), { ...legacy, daysCount: 61 })
  }
  assert.deepEqual(normalizeTrip({ ...legacy, destination: null, daysCount: null }), legacy)
  assert.deepEqual(normalizeTrip({ ...legacy, planningContext: null, destination: '', daysCount: 1 }), {
    id: legacy.id, title: legacy.title, startDate: legacy.startDate, endDate: legacy.endDate,
    days: 3, nights: 2, createdAt: timestamp, updatedAt: timestamp, isPinned: false, destination: '', daysCount: 1,
  }, 'explicit valid fields survive independently of optional context')
})
