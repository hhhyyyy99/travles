import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../server/src/app.js'
import { createSqliteTripRepository } from '../server/src/trips/factory.js'
import type { SqlDatabase } from '../server/src/db/driver.js'
import { fetchTrips, setTripPinned } from '../src/domain/tripList'

void test('pin and unpin survive reopening SQLite without changing other trip fields', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'trip-pinning-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dbPath = join(dir, 'trips.db')

  async function withApp<T>(
    run: (app: Awaited<ReturnType<typeof createApp>>, db: SqlDatabase) => Promise<T>,
  ) {
    const store = await createSqliteTripRepository(dbPath)
    try {
      return await run(await createApp({ tripRepository: store.repository }), store.db)
    } finally {
      await store.close()
    }
  }

  const id = 'legacy trip'
  const pinPath = `/api/trips/${encodeURIComponent(id)}/pin`
  const initial = await withApp(async (app, db) => {
    for (const [index, tripId] of ['older', id].entries()) {
      await db.run(
        'INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          tripId,
          `测试行程 ${index}`,
          '2026-10-02',
          '2026-10-03',
          `2026-09-0${index + 1}T00:00:00Z`,
          '2026-09-10T00:00:00Z',
        ],
      )
    }
    await db.run(
      'UPDATE trips SET cover_image = ?, status = ?, planning_context = ? WHERE id = ?',
      [
        '/covers/test.jpg',
        'legacy-status',
        JSON.stringify({
          destination: '测试城市',
          originalSentence: '测试行程两日',
          preferences: '慢节奏',
          durationDays: 2,
          dateStatus: 'confirmed',
        }),
        id,
      ],
    )
    const request = (path: string, init?: RequestInit) => app.request(path, init)
    const before = await fetchTrips(request)
    assert.ok(before.ok)
    assert.deepEqual(
      before.data.map((trip) => trip.id),
      ['older', id],
    )
    assert.ok(before.data.every((trip) => !Object.hasOwn(trip, 'isPinned')))

    const invalid = await request(pinPath, {
      method: 'PUT',
      body: JSON.stringify({ isPinned: 'true' }),
    })
    assert.equal(invalid.status, 400)
    const missing = await request('/api/trips/missing/pin', {
      method: 'PUT',
      body: JSON.stringify({ isPinned: true }),
    })
    assert.equal(missing.status, 404)
    assert.deepEqual(await fetchTrips(request), before, 'invalid or missing writes have no effect')

    assert.deepEqual(await setTripPinned(id, true, request), { ok: true, data: null })
    return before.data
  })

  const expected = (isPinned: boolean) => ({
    ok: true,
    data: initial.map((trip) => (trip.id === id ? { ...trip, isPinned } : trip)),
  })
  await withApp(async (app) => {
    const request = (path: string, init?: RequestInit) => app.request(path, init)
    assert.deepEqual(await fetchTrips(request), expected(true))
    assert.deepEqual(await setTripPinned(id, false, request), { ok: true, data: null })
  })
  await withApp(async (app) => {
    assert.deepEqual(await fetchTrips((path, init) => app.request(path, init)), expected(false))
  })
})
