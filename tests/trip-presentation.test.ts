import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TripSchema } from '@hailar/domain'
import { createApp } from '../server/src/app.js'
import { createSqliteDatabase } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository, mapRowToSummary } from '../server/src/trips/repository.js'
import { createTrip, createTripFromSentence, fetchTrips, normalizeTrip, renameTrip } from '../src/domain/tripList'
import { fetchTripCanvas } from '../src/domain/workbench'

const legacyRow = {
  id: 'legacy', title: '旧行程', start_date: '2026-10-02', end_date: '2026-10-03',
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
}

function assertPresentationAbsent(trip: object): void {
  for (const key of ['coverImage', 'isPinned', 'status']) assert.equal(Object.hasOwn(trip, key), false, key)
}

test('legacy SQLite trips retain their payload through migration, HTTP and browser readers', async (t) => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  // The actual trips table before this increment, including existing metadata.
  await db.run(`CREATE TABLE trips (
    id TEXT PRIMARY KEY, title TEXT, start_date TEXT, end_date TEXT,
    visibility TEXT NOT NULL DEFAULT 'private', owner TEXT, share_token TEXT,
    planning_context TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`)
  await db.run('INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', Object.values(legacyRow))
  const before = (await db.run('SELECT * FROM trips')).rows[0]
  const migrationError = new Error('schema write unavailable')
  await assert.rejects(ensureSchema({
    ...db,
    run: async (sql, args) => {
      if (sql === 'ALTER TABLE trips ADD COLUMN cover_image TEXT') throw migrationError
      return db.run(sql, args)
    },
  }), migrationError, 'a genuinely missing column cannot be ignored as a duplicate')
  assert.deepEqual((await db.run('SELECT * FROM trips')).rows[0], before)
  await Promise.all([ensureSchema(db), ensureSchema(db)])
  await ensureSchema(db)
  assert.deepEqual((await db.run('SELECT * FROM trips')).rows[0], {
    ...before, cover_image: null, is_pinned: null, status: null,
  }, 'schema initialization is additive and idempotent, with no historical backfill')

  const repository = new TripRepository(new SqliteTripStoreDriver(db))
  const app = await createApp({ tripRepository: repository, workbenchStore: createSqliteWorkbenchStore(db) })
  const fetchLike = (url: string, init?: RequestInit) => app.request(url, init)
  const legacy = mapRowToSummary(legacyRow)
  assert.ok(legacy)
  assertPresentationAbsent(legacy)
  assert.deepEqual(await fetchTrips(fetchLike), { ok: true, data: [legacy] })
  const legacyCanvas = await fetchTripCanvas('legacy', fetchLike)
  assert.equal(legacyCanvas.ok, true)
  if (legacyCanvas.ok) assert.deepEqual(legacyCanvas.data.trip, legacy)

  // These are source-provided opaque labels, not a new product status enum.
  const presentation = { coverImage: '/covers/source.jpg', isPinned: true, status: 'source-defined-label' }
  await db.run('UPDATE trips SET cover_image = ?, is_pinned = ?, status = ? WHERE id = ?', [
    presentation.coverImage, 1, presentation.status, 'legacy',
  ])
  const expected = { ...legacy, ...presentation }
  assert.deepEqual(TripSchema.parse(expected), expected)
  assert.deepEqual(await fetchTrips(fetchLike), { ok: true, data: [expected] })
  const detail = await app.request('/api/trips/legacy')
  assert.equal(detail.status, 200)
  assert.deepEqual((await detail.json() as { trip: unknown }).trip, expected)
  const canvas = await fetchTripCanvas('legacy', fetchLike)
  assert.equal(canvas.ok, true)
  if (canvas.ok) assert.deepEqual(canvas.data.trip, expected)

  // An ordinary write must preserve optional metadata on both response and reload.
  const renamed = await renameTrip('legacy', '新标题', fetchLike)
  assert.equal(renamed.ok, true)
  if (!renamed.ok) return
  assert.deepEqual(renamed.data, { ...expected, title: '新标题', updatedAt: renamed.data.updatedAt })
  assert.deepEqual(await repository.get('legacy'), renamed.data)
  assert.deepEqual((await db.run('SELECT cover_image, is_pinned, status FROM trips')).rows[0], {
    cover_image: presentation.coverImage, is_pinned: 1, status: presentation.status,
  })

  await db.run('UPDATE trips SET is_pinned = 0 WHERE id = ?', ['legacy'])
  const unpinned = await fetchTrips(fetchLike)
  assert.equal(unpinned.ok, true)
  if (unpinned.ok) assert.equal(unpinned.data[0]?.isPinned, false, 'explicit false survives every read boundary')

  await db.run('UPDATE trips SET cover_image = ?, is_pinned = ?, status = ? WHERE id = ?', [
    new Uint8Array([1]), 2, new Uint8Array([2]), 'legacy',
  ])
  const corrupt = await fetchTrips(fetchLike)
  assert.equal(corrupt.ok, true)
  if (corrupt.ok) {
    assert.equal(corrupt.data.length, 1, 'invalid presentation metadata must not hide a usable trip')
    assertPresentationAbsent(corrupt.data[0]!)
    assert.equal(TripSchema.safeParse(corrupt.data[0]).success, true)
  }
})

test('fresh databases and existing creation APIs omit absent presentation metadata', async (t) => {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  await ensureSchema(db)
  const repository = new TripRepository(new SqliteTripStoreDriver(db))
  const app = await createApp({ tripRepository: repository })
  const fetchLike = (url: string, init?: RequestInit) => app.request(url, init)
  const created = await createTrip({ title: '日期明确', startDate: '2026-10-02', endDate: '2026-10-03' }, fetchLike)
  const intake = await createTripFromSentence({ sentence: '成都3天，慢节奏' }, fetchLike)
  for (const result of [created, intake]) {
    assert.equal(result.ok, true)
    if (!result.ok) continue
    assertPresentationAbsent(result.data)
    assert.deepEqual(TripSchema.parse(result.data), result.data)
    assert.deepEqual(await repository.get(result.data.id), result.data)
  }
  assert.deepEqual((await db.run('SELECT cover_image, is_pinned, status FROM trips')).rows, [
    { cover_image: null, is_pinned: null, status: null },
    { cover_image: null, is_pinned: null, status: null },
  ])
})

test('tolerant readers omit bad optional fields individually without coercing or inventing values', () => {
  const legacy = mapRowToSummary(legacyRow)
  assert.ok(legacy)
  assert.deepEqual(mapRowToSummary({ ...legacyRow, cover_image: 42, is_pinned: 'false', status: {} }), legacy)
  assert.deepEqual(normalizeTrip({ ...legacy, coverImage: 42, isPinned: 'false', status: {} }), legacy)
  assert.deepEqual(mapRowToSummary({ ...legacyRow, cover_image: null, is_pinned: null, status: null }), legacy)
  assert.deepEqual(normalizeTrip({ ...legacy, coverImage: null, isPinned: null, status: null }), legacy)
  assert.deepEqual(normalizeTrip({ ...legacy, coverImage: '/cover.jpg', isPinned: 1, status: 'future-label' }), {
    ...legacy, coverImage: '/cover.jpg', status: 'future-label',
  })
  assert.deepEqual(mapRowToSummary({ ...legacyRow, cover_image: '/cover.jpg', is_pinned: -1, status: 'future-label' }), {
    ...legacy, coverImage: '/cover.jpg', status: 'future-label',
  })
})
