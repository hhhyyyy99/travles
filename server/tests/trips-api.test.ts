/**
 * Trip CRUD HTTP tests (ticket 02) — drive the REAL app instance with
 * app.request (no internal mocks, same seam as health.test.ts), plus
 * persistence-across-restart against a real SQLite file in a temp dir and a
 * foreign-key cascade check.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import type { TripSummary } from '../src/trips/types.js'

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

async function createTrip(app: Awaited<ReturnType<typeof createApp>>, title: string, startDate: string, endDate: string): Promise<TripSummary> {
  const res = await app.request('/api/trips', jsonRequest('POST', { title, startDate, endDate }))
  assert.equal(res.status, 201)
  const body = (await res.json()) as { trip: TripSummary }
  return body.trip
}

test('GET /api/trips starts empty and lists created trips', async () => {
  const app = await createApp({ tripRepository: new TripRepository(new MemoryTripStoreDriver()) })

  let res = await app.request('/api/trips')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { trips: [] })

  const trip = await createTrip(app, '国庆呼伦贝尔', '2026-10-02', '2026-10-08')
  res = await app.request('/api/trips')
  const body = (await res.json()) as { trips: TripSummary[] }
  assert.equal(body.trips.length, 1)
  assert.deepEqual(body.trips[0], trip)
  assert.equal(body.trips[0]?.days, 7)
  assert.equal(body.trips[0]?.nights, 6)
})

test('POST /api/trips validates the payload', async () => {
  const app = await createApp({ tripRepository: new TripRepository(new MemoryTripStoreDriver()) })

  const blank = await app.request('/api/trips', jsonRequest('POST', { title: '  ', startDate: '2026-10-02', endDate: '2026-10-08' }))
  assert.equal(blank.status, 400)
  assert.equal(((await blank.json()) as { error: string }).error, '行程标题不能为空')

  const badRange = await app.request('/api/trips', jsonRequest('POST', { title: 'x', startDate: '2026-10-08', endDate: '2026-10-02' }))
  assert.equal(badRange.status, 400)
  assert.equal(((await badRange.json()) as { error: string }).error, '结束日期不能早于开始日期')

  const notJson = await app.request('/api/trips', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json' } })
  assert.equal(notJson.status, 400)

  const notObject = await app.request('/api/trips', jsonRequest('POST', ['nope']))
  assert.equal(notObject.status, 400)
})

test('POST /api/trips/intake persists a date-pending sentence without inventing dates', async () => {
  const app = await createApp({ tripRepository: new TripRepository(new MemoryTripStoreDriver()) })
  const response = await app.request('/api/trips/intake', jsonRequest('POST', {
    sentence: '我想去呼伦贝尔 7 天，慢节奏，自驾',
  }))
  assert.equal(response.status, 201)
  const body = (await response.json()) as { trip: TripSummary; intake: TripSummary['planningContext'] }
  assert.equal(body.trip.title, '呼伦贝尔 · 7日行程')
  assert.equal(body.trip.startDate, '')
  assert.equal(body.trip.endDate, '')
  assert.equal(body.trip.days, 0)
  assert.equal(body.trip.durationDays, 7)
  assert.equal(body.trip.dateStatus, 'unspecified')
  assert.deepEqual(body.intake, body.trip.planningContext)
  assert.equal(body.trip.planningContext?.destination, '呼伦贝尔')
  assert.match(body.trip.planningContext?.preferences ?? '', /慢节奏，自驾/)

  const reloaded = await app.request(`/api/trips/${body.trip.id}`)
  assert.equal(((await reloaded.json()) as { trip: TripSummary }).trip.planningContext?.originalSentence, '我想去呼伦贝尔 7 天，慢节奏，自驾')

  const explicit = await app.request('/api/trips/intake', jsonRequest('POST', {
    sentence: '去呼伦贝尔 7 天，2026-10-02 到 2026-10-08，自驾',
  }))
  assert.equal(explicit.status, 201)
  const explicitTrip = ((await explicit.json()) as { trip: TripSummary }).trip
  assert.deepEqual(
    { startDate: explicitTrip.startDate, endDate: explicitTrip.endDate, dateStatus: explicitTrip.dateStatus },
    { startDate: '2026-10-02', endDate: '2026-10-08', dateStatus: 'confirmed' },
  )

  const invalid = await app.request('/api/trips/intake', jsonRequest('POST', { sentence: '我想去呼伦贝尔，慢节奏' }))
  assert.equal(invalid.status, 400)
})

test('GET /api/trips/:id returns the trip or 404', async () => {
  const app = await createApp({ tripRepository: new TripRepository(new MemoryTripStoreDriver()) })
  const trip = await createTrip(app, '环线', '2026-10-02', '2026-10-04')

  const found = await app.request(`/api/trips/${trip.id}`)
  assert.equal(found.status, 200)
  assert.equal(((await found.json()) as { trip: TripSummary }).trip.title, '环线')

  const missing = await app.request('/api/trips/no-such-id')
  assert.equal(missing.status, 404)
  assert.equal(((await missing.json()) as { error: string }).error, '行程不存在')
})

test('PATCH /api/trips/:id renames (and updates dates) or fails with 400/404', async () => {
  const app = await createApp({ tripRepository: new TripRepository(new MemoryTripStoreDriver()) })
  const trip = await createTrip(app, '旧标题', '2026-10-02', '2026-10-08')

  const renamed = await app.request(`/api/trips/${trip.id}`, jsonRequest('PATCH', { title: '新标题' }))
  assert.equal(renamed.status, 200)
  const renamedBody = (await renamed.json()) as { trip: TripSummary }
  assert.equal(renamedBody.trip.title, '新标题')
  assert.equal(renamedBody.trip.days, 7, 'rename keeps the date range')

  const redated = await app.request(`/api/trips/${trip.id}`, jsonRequest('PATCH', { endDate: '2026-10-04' }))
  assert.equal(redated.status, 200)
  assert.equal(((await redated.json()) as { trip: TripSummary }).trip.days, 3)

  const invalid = await app.request(`/api/trips/${trip.id}`, jsonRequest('PATCH', { title: '' }))
  assert.equal(invalid.status, 400)

  const empty = await app.request(`/api/trips/${trip.id}`, jsonRequest('PATCH', {}))
  assert.equal(empty.status, 400)

  const missing = await app.request('/api/trips/no-such-id', jsonRequest('PATCH', { title: 'x' }))
  assert.equal(missing.status, 404)
})

test('DELETE /api/trips/:id removes the trip or 404s', async () => {
  const app = await createApp({ tripRepository: new TripRepository(new MemoryTripStoreDriver()) })
  const trip = await createTrip(app, '要删的', '2026-10-02', '2026-10-03')

  const removed = await app.request(`/api/trips/${trip.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { ok: true })

  assert.equal((await app.request(`/api/trips/${trip.id}`)).status, 404)
  assert.equal((await app.request(`/api/trips/${trip.id}`, { method: 'DELETE' })).status, 404)
  const list = (await (await app.request('/api/trips')).json()) as { trips: TripSummary[] }
  assert.equal(list.trips.length, 0)
})

test('trips survive a restart: two app instances over the same SQLite file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trips-restart-'))
  const dbPath = join(dir, 'trips.db')
  try {
    const first = await createSqliteTripRepository(`file:${dbPath}`)
    const app1 = await createApp({ tripRepository: first.repository })
    const trip = await createTrip(app1, '重启也要在', '2026-10-02', '2026-10-08')
    await first.close()

    // "Restart": a brand-new app/repository opening the same file.
    const app2 = await createApp({ databaseUrl: `file:${dbPath}` })
    const res = await app2.request('/api/trips')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { trips: TripSummary[] }
    assert.equal(body.trips.length, 1)
    assert.equal(body.trips[0]?.id, trip.id)
    assert.equal(body.trips[0]?.title, '重启也要在')
    assert.equal(body.trips[0]?.days, 7)
    assert.equal(body.trips[0]?.nights, 6)

    // Renames made after the restart persist too.
    await app2.request(`/api/trips/${trip.id}`, jsonRequest('PATCH', { title: '重启后改名' }))
    const app3 = await createApp({ databaseUrl: `file:${dbPath}` })
    const again = await app3.request(`/api/trips/${trip.id}`)
    assert.equal(((await again.json()) as { trip: TripSummary }).trip.title, '重启后改名')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleting a trip cascades to its child rows (FK ON DELETE CASCADE)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trips-cascade-'))
  try {
    const { repository, db } = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
    const created = await repository.create({ title: '带子表的行程', startDate: '2026-10-02', endDate: '2026-10-03' })
    if (!created.ok) return assert.fail('trip creation failed')
    await db.run("INSERT INTO days (id, trip_id, idx, date) VALUES ('day-1', ?, 0, '2026-10-02')", [created.trip.id])

    const removed = await repository.remove(created.trip.id)
    assert.deepEqual(removed, { ok: true })
    const days = await db.run('SELECT * FROM days')
    assert.equal(days.rows.length, 0, 'child day rows are gone after the trip is deleted')
    await db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the SQLite repository tolerates corrupt rows written directly to the db', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trips-corrupt-'))
  try {
    const { repository, db } = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
    await db.run("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES ('corrupt', NULL, '10月2号', NULL, '', 1760000000000)")
    await db.run("INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES ('good', '完好', '2026-10-02', '2026-10-08', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z')")

    const trips = await repository.list()
    assert.deepEqual(
      trips.map((trip) => trip.id),
      ['corrupt', 'good'],
    )
    const corrupt = trips.find((trip) => trip.id === 'corrupt')
    assert.deepEqual(corrupt && { title: corrupt.title, days: corrupt.days, nights: corrupt.nights }, { title: '', days: 0, nights: 0 })
    await db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
