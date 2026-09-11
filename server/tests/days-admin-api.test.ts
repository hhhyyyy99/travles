/**
 * Day-admin write API tests (ticket 10) — repository unit coverage over the
 * in-memory driver (create computes next idx/date, theme patch validation,
 * cascade delete) and HTTP tests through the REAL app instance via
 * app.request(), plus a SQLite end-to-end round trip that reads the writes
 * back through the canvas API (shared database, no schema change).
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
import { MemoryWorkbenchStoreDriver } from '../src/days/driver-memory.js'
import { MemoryDaysAdminStoreDriver } from '../src/days-admin/driver-memory.js'
import { DaysAdminRepository } from '../src/days-admin/repository.js'
import type { DaysAdminStoreDriver } from '../src/days-admin/types.js'
import type { TripSummary } from '../src/trips/types.js'

async function createAppWithMemoryStores() {
  const trips = new TripRepository(new MemoryTripStoreDriver())
  const workbench = new MemoryWorkbenchStoreDriver()
  const daysAdmin = new MemoryDaysAdminStoreDriver()
  const app = await createApp({ tripRepository: trips, workbenchStore: workbench, daysAdminStore: daysAdmin })
  return { app, trips, workbench, daysAdmin }
}

async function createTripViaApi(
  app: Awaited<ReturnType<typeof createApp>>,
  title = '国庆呼伦贝尔慢环线',
): Promise<TripSummary> {
  const res = await app.request('/api/trips', {
    method: 'POST',
    body: JSON.stringify({ title, startDate: '2026-10-02', endDate: '2026-10-04' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { trip: TripSummary }).trip
}

function seedTwoDays(driver: DaysAdminStoreDriver | MemoryDaysAdminStoreDriver, tripId: string): void {
  const memory = driver as MemoryDaysAdminStoreDriver
  memory.dayRows.set('day-1', { id: 'day-1', trip_id: tripId, idx: 0, date: '2026-10-02', theme: '抵达海拉尔', color: '#c26d4f' })
  memory.dayRows.set('day-2', { id: 'day-2', trip_id: tripId, idx: 1, date: '2026-10-03', theme: '穿越草原', color: '#3f7d5c' })
}

// ---------------------------------------------------------------------------
// Repository unit coverage (memory driver)
// ---------------------------------------------------------------------------

test('createDay appends after the last day: idx = max+1, date = latest date + 1', async () => {
  const driver = new MemoryDaysAdminStoreDriver()
  seedTwoDays(driver, 't1')
  const repo = new DaysAdminRepository(driver)

  const result = await repo.createDay('t1')
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.day.index, 2)
  assert.equal(result.day.date, '2026-10-04', 'next calendar day after the latest dated day')
  assert.equal(result.day.theme, '')
  assert.equal(result.day.color, '')
  assert.deepEqual(result.day.items, [])
  // The row is actually persisted in the driver.
  const rows = await driver.listDayRows('t1')
  assert.equal(rows.length, 3)
})

test('createDay on a trip without dated days leaves the date empty and restarts the index', async () => {
  const driver = new MemoryDaysAdminStoreDriver()
  driver.dayRows.set('day-x', { id: 'day-x', trip_id: 't1', idx: 'not-a-number', date: '垃圾日期', theme: null, color: null })
  const repo = new DaysAdminRepository(driver)

  const result = await repo.createDay('t1', { theme: '自由活动' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.day.index, 1, 'corrupt idx coerces to 0, so the next index is 1')
  assert.equal(result.day.date, '')
  assert.equal(result.day.theme, '自由活动')
})

test('createDay validates the explicit date and rejects hostile fields', async () => {
  const driver = new MemoryDaysAdminStoreDriver()
  const repo = new DaysAdminRepository(driver)

  const badDate = await repo.createDay('t1', { date: '10月4号' })
  assert.deepEqual(badDate, { ok: false, error: '日期格式无效（需要 YYYY-MM-DD）', code: 'invalid' })

  const fakeDate = await repo.createDay('t1', { date: '2026-02-30' })
  assert.equal(fakeDate.ok, false, 'a real-calendar check applies, not just the shape')

  const badTheme = await repo.createDay('t1', { theme: 42 })
  assert.equal(badTheme.ok, false)

  const longTheme = await repo.createDay('t1', { theme: '长'.repeat(201) })
  assert.equal(longTheme.ok, false)

  const ok = await repo.createDay('t1', { date: '2026-10-10', theme: ' 满洲里 ', color: '#8a5fbf' })
  assert.ok(ok.ok)
  if (!ok.ok) return
  assert.equal(ok.day.theme, '满洲里', 'theme is trimmed')
})

test('updateDay changes only the sent fields and rejects unknown/foreign days', async () => {
  const driver = new MemoryDaysAdminStoreDriver()
  seedTwoDays(driver, 't1')
  const repo = new DaysAdminRepository(driver)

  const result = await repo.updateDay('t1', 'day-1', { theme: '海拉尔集结' })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.day.theme, '海拉尔集结')
  assert.equal(result.day.color, '#c26d4f', 'untouched fields stay')
  assert.equal(result.day.date, '2026-10-02')

  const emptyPatch = await repo.updateDay('t1', 'day-1', {})
  assert.deepEqual(emptyPatch, { ok: false, error: '没有可更新的字段', code: 'invalid' })

  const missing = await repo.updateDay('t1', 'day-404', { theme: 'x' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'not_found')

  const foreign = await repo.updateDay('t2', 'day-1', { theme: 'x' })
  assert.equal(foreign.ok, false, 'a day from another trip is not updatable through t2')
})

test('deleteDay cascades items and legs and reports how many cards went away', async () => {
  const driver = new MemoryDaysAdminStoreDriver()
  seedTwoDays(driver, 't1')
  driver.itemRows.set('item-1', { id: 'item-1', trip_id: 't1', day_id: 'day-1', item_order: 0, type: 'stay', title: '全季', note: null, poi: null, images: null, pending: 0 })
  driver.itemRows.set('item-2', { id: 'item-2', trip_id: 't1', day_id: 'day-1', item_order: 1, type: 'traffic', title: '自驾', note: null, poi: null, images: null, pending: 0 })
  driver.itemRows.set('item-3', { id: 'item-3', trip_id: 't1', day_id: 'day-2', item_order: 0, type: 'other', title: '自由活动', note: null, poi: null, images: null, pending: 0 })
  driver.legRows.set('leg-1', { id: 'leg-1', trip_id: 't1', from_item_id: 'item-1', to_item_id: 'item-2', mode: 'drive', distance_km: 30.3, duration_min: 31, polyline: null })
  driver.legRows.set('leg-cross', { id: 'leg-cross', trip_id: 't1', from_item_id: 'item-2', to_item_id: 'item-3', mode: 'drive', distance_km: 10, duration_min: 10, polyline: null })
  const repo = new DaysAdminRepository(driver)

  const result = await repo.deleteDay('t1', 'day-1')
  assert.deepEqual(result, { ok: true, removedItems: 2 })
  assert.equal(driver.dayRows.has('day-1'), false)
  assert.equal(driver.dayRows.has('day-2'), true, 'the other day stays')
  assert.equal(driver.itemRows.has('item-1'), false)
  assert.equal(driver.itemRows.has('item-2'), false)
  assert.equal(driver.itemRows.has('item-3'), true, "the other day's items stay")
  assert.equal(driver.legRows.size, 0, 'legs touching the deleted items are removed too')

  const missing = await repo.deleteDay('t1', 'day-404')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.equal(missing.code, 'not_found')
})

test('driver failures surface as storage errors instead of throwing', async () => {
  const driver = new MemoryDaysAdminStoreDriver()
  seedTwoDays(driver, 't1')
  const repo = new DaysAdminRepository(driver)

  driver.nextWriteError = new Error('disk full')
  const create = await repo.createDay('t1')
  assert.deepEqual(create, { ok: false, error: '保存失败', code: 'storage' })

  driver.nextWriteError = new Error('disk full')
  const remove = await repo.deleteDay('t1', 'day-1')
  assert.deepEqual(remove, { ok: false, error: '删除失败', code: 'storage' })

  driver.nextWriteError = new Error('disk full')
  const update = await repo.updateDay('t1', 'day-1', { theme: 'x' })
  assert.deepEqual(update, { ok: false, error: '保存失败', code: 'storage' })
})

// ---------------------------------------------------------------------------
// HTTP surface (real app instance, memory stores)
// ---------------------------------------------------------------------------

test('POST /api/trips/:id/days creates a day with the next date', async () => {
  const { app, daysAdmin } = await createAppWithMemoryStores()
  const trip = await createTripViaApi(app)
  seedTwoDays(daysAdmin, trip.id)

  const res = await app.request(`/api/trips/${trip.id}/days`, {
    method: 'POST',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 201)
  const body = (await res.json()) as { day: { id: string; index: number; date: string; theme: string; color: string } }
  assert.equal(body.day.index, 2)
  assert.equal(body.day.date, '2026-10-04')
  assert.ok(body.day.id, 'the server assigns the id')

  // An empty body is also fine (tolerant create).
  const noBody = await app.request(`/api/trips/${trip.id}/days`, { method: 'POST' })
  assert.equal(noBody.status, 201)

  const unknownTrip = await app.request('/api/trips/no-such-id/days', { method: 'POST' })
  assert.equal(unknownTrip.status, 404)

  const badPayload = await app.request(`/api/trips/${trip.id}/days`, {
    method: 'POST',
    body: JSON.stringify({ date: 'bad' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(badPayload.status, 400)
})

test('PATCH /api/trips/:id/days/:dayId updates the theme', async () => {
  const { app, daysAdmin } = await createAppWithMemoryStores()
  const trip = await createTripViaApi(app)
  seedTwoDays(daysAdmin, trip.id)

  const res = await app.request(`/api/trips/${trip.id}/days/day-1`, {
    method: 'PATCH',
    body: JSON.stringify({ theme: '海拉尔集结日' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { day: { theme: string } }
  assert.equal(body.day.theme, '海拉尔集结日')

  const badJson = await app.request(`/api/trips/${trip.id}/days/day-1`, {
    method: 'PATCH',
    body: 'not json',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(badJson.status, 400)

  const unknown = await app.request(`/api/trips/${trip.id}/days/day-404`, {
    method: 'PATCH',
    body: JSON.stringify({ theme: 'x' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(unknown.status, 404)
})

test('DELETE /api/trips/:id/days/:dayId removes the day and its cards', async () => {
  const { app, daysAdmin } = await createAppWithMemoryStores()
  const trip = await createTripViaApi(app)
  seedTwoDays(daysAdmin, trip.id)
  daysAdmin.itemRows.set('item-1', { id: 'item-1', trip_id: trip.id, day_id: 'day-1', item_order: 0, type: 'stay', title: '全季', note: null, poi: null, images: null, pending: 0 })

  const res = await app.request(`/api/trips/${trip.id}/days/day-1`, { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, removedItems: 1 })
  assert.equal(daysAdmin.dayRows.has('day-1'), false)

  const again = await app.request(`/api/trips/${trip.id}/days/day-1`, { method: 'DELETE' })
  assert.equal(again.status, 404)
})

// ---------------------------------------------------------------------------
// SQLite end-to-end: writes read back through the canvas API (one shared db)
// ---------------------------------------------------------------------------

test('day writes round-trip through SQLite and show up in the canvas read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'days-admin-'))
  try {
    const dbUrl = `file:${join(dir, 'trips.db')}`
    const { repository, db } = await createSqliteTripRepository(dbUrl)
    const created = await repository.create({ title: '库里的行程', startDate: '2026-10-02', endDate: '2026-10-03' })
    if (!created.ok) return assert.fail('trip creation failed')
    const tripId = created.trip.id

    // No injected stores: the app resolves the SQLite workbench + admin
    // stores over the same database file.
    const app = await createApp({ tripRepository: repository, databaseUrl: dbUrl })

    const createRes = await app.request(`/api/trips/${tripId}/days`, {
      method: 'POST',
      body: JSON.stringify({ theme: '接机日' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(createRes.status, 201)
    const { day } = (await createRes.json()) as { day: { id: string; date: string; index: number } }
    assert.equal(day.index, 0)
    assert.equal(day.date, '', 'the trip has no dated days yet, so the first day has no date')

    const secondRes = await app.request(`/api/trips/${tripId}/days`, {
      method: 'POST',
      body: JSON.stringify({ date: '2026-10-02', theme: '抵达海拉尔' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(secondRes.status, 201)
    const { day: day2 } = (await secondRes.json()) as { day: { id: string; index: number; date: string } }
    assert.equal(day2.index, 1)
    assert.equal(day2.date, '2026-10-02')

    // Seed one item straight into the shared db (the injected-tripRepository
    // app has no content repository, so the HTTP upsert route is unavailable),
    // then delete day-1 and watch the canvas lose the day and its card.
    await db.run(
      "INSERT INTO items (id, trip_id, day_id, item_order, type, title) VALUES ('item-1', ?, ?, 0, 'stay', '海拉尔全季酒店')",
      [tripId, day.id],
    )

    const canvasBefore = (await (await app.request(`/api/trips/${tripId}/canvas`)).json()) as {
      days: { id: string; items: unknown[] }[]
    }
    assert.equal(canvasBefore.days.length, 2)

    const deleteRes = await app.request(`/api/trips/${tripId}/days/${day.id}`, { method: 'DELETE' })
    assert.equal(deleteRes.status, 200)
    assert.deepEqual(await deleteRes.json(), { ok: true, removedItems: 1 })

    const canvasAfter = (await (await app.request(`/api/trips/${tripId}/canvas`)).json()) as {
      days: { id: string; theme: string; items: unknown[] }[]
    }
    assert.equal(canvasAfter.days.length, 1)
    assert.equal(canvasAfter.days[0]?.id, day2.id)
    assert.equal(canvasAfter.days[0]?.theme, '抵达海拉尔')
    await db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
