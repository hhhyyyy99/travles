/**
 * Card-editing write API tests (ticket 09) — repository-level behavior is
 * covered in items-admin-repo.test.ts; here the routes run through the REAL
 * app instance via app.request() over the in-memory drivers: move/copy/
 * create/patch/delete happy paths, validation + not-found errors, storage
 * failure mapping, the system messages recorded into the chat thread, and a
 * SQLite end-to-end round trip that reads the writes back through the canvas
 * API (recomputed legs included).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../src/app.js'
import { TripRepository } from '../src/trips/repository.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { MemoryWorkbenchStoreDriver } from '../src/days/driver-memory.js'
import { MemoryDaysAdminStoreDriver } from '../src/days-admin/driver-memory.js'
import { MemoryItemsAdminStoreDriver } from '../src/items-admin/driver-memory.js'
import type { ItemsAdminStoreDriver } from '../src/items-admin/types.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import type { MessageRow, MessageStoreDriver } from '../src/chat/types.js'
import type { ItemRow } from '../src/days/types.js'
import type { TripSummary } from '../src/trips/types.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'

type AppBundle = Awaited<ReturnType<typeof createAppWithMemoryStores>>

async function createAppWithMemoryStores() {
  const trips = new TripRepository(new MemoryTripStoreDriver())
  const workbench = new MemoryWorkbenchStoreDriver()
  const daysAdmin = new MemoryDaysAdminStoreDriver()
  const itemsAdmin = new MemoryItemsAdminStoreDriver()
  const messages = new MemoryMessageStoreDriver()
  const app = await createApp({
    tripRepository: trips,
    workbenchStore: workbench,
    daysAdminStore: daysAdmin,
    itemsAdminStore: itemsAdmin,
    messageStore: messages,
  })
  return { app, trips, workbench, daysAdmin, itemsAdmin, messages }
}

async function createTripViaApi(app: AppBundle['app'], title = '国庆呼伦贝尔慢环线'): Promise<TripSummary> {
  const res = await app.request('/api/trips', {
    method: 'POST',
    body: JSON.stringify({ title, startDate: '2026-10-02', endDate: '2026-10-04' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { trip: TripSummary }).trip
}

/** Two days; day-1 = [i1 (POI), i2 (POI)], day-2 = [i3]; one stored leg i1→i2. */
function seedCards(bundle: AppBundle, tripId: string): void {
  const { itemsAdmin } = bundle
  itemsAdmin.dayRows.set('day-1', { id: 'day-1', trip_id: tripId, idx: 0, date: '2026-10-02', theme: '抵达', color: '' })
  itemsAdmin.dayRows.set('day-2', { id: 'day-2', trip_id: tripId, idx: 1, date: '2026-10-03', theme: '草原', color: '' })
  const rows = [
    itemRow('i1', 'day-1', 0, { amapId: '', name: '全季酒店', lat: 49.2, lng: 119.7, category: '', rating: 0, introSummary: '' }, tripId),
    itemRow('i2', 'day-1', 1, { amapId: '', name: '莫尔格勒河', lat: 49.42, lng: 119.85, category: '', rating: 0, introSummary: '' }, tripId),
    itemRow('i3', 'day-2', 0, null, tripId),
  ]
  for (const row of rows) itemsAdmin.itemRows.set(row.id as string, row)
  itemsAdmin.legRows.set('leg-i1-i2', {
    id: 'leg-i1-i2',
    trip_id: tripId,
    from_item_id: 'i1',
    to_item_id: 'i2',
    mode: 'drive',
    distance_km: 30.3,
    duration_min: 31,
    polyline: JSON.stringify([
      [119.7, 49.2],
      [119.85, 49.42],
    ]),
  })
}

function itemRow(id: string, dayId: string, order: number, poi: unknown, tripId = 'trip'): ItemRow {
  return {
    id,
    trip_id: tripId,
    day_id: dayId,
    item_order: order,
    type: 'attraction',
    title: `卡片 ${id}`,
    note: null,
    poi: poi === null ? null : JSON.stringify(poi),
    images: null,
    pending: 0,
  }
}

function systemRows(rows: MessageRow[]): MessageRow[] {
  return rows.filter((row) => row.role === 'system')
}

// ---------------------------------------------------------------------------
// HTTP routes via app.request()
// ---------------------------------------------------------------------------

test('POST /items/:id/move reorders and returns the recomputed legs', async () => {
  const bundle = await createAppWithMemoryStores()
  const trip = await createTripViaApi(bundle.app)
  seedCards(bundle, trip.id)

  const res = await bundle.app.request(`/api/trips/${trip.id}/items/i1/move`, {
    method: 'POST',
    body: JSON.stringify({ index: 1 }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { item: { id: string; dayId: string; order: number }; legs: unknown[] }
  assert.equal(body.item.id, 'i1')
  assert.equal(body.item.order, 1)
  assert.equal(body.legs.length, 1, 'day-1 is [i2, i1] → one pair')
  assert.ok(systemRows(bundle.messages.messageRows.filter((row) => row.trip_id === trip.id)).length >= 1)

  // The write driver shows the same layout (order patches persisted).
  const stored = [...bundle.itemsAdmin.itemRows.values()]
    .filter((row) => row.day_id === 'day-1')
    .sort((a, b) => Number(a.item_order) - Number(b.item_order))
  assert.deepEqual(
    stored.map((row) => row.id),
    ['i2', 'i1'],
  )
})

test('POST /items/:id/copy duplicates a card into another day', async () => {
  const bundle = await createAppWithMemoryStores()
  const trip = await createTripViaApi(bundle.app)
  seedCards(bundle, trip.id)

  const res = await bundle.app.request(`/api/trips/${trip.id}/items/i1/copy`, {
    method: 'POST',
    body: JSON.stringify({ dayId: 'day-2' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 201)
  const body = (await res.json()) as { item: { id: string; dayId: string; poi: { name: string } | null } }
  assert.notEqual(body.item.id, 'i1')
  assert.equal(body.item.dayId, 'day-2')
  assert.equal(body.item.poi?.name, '全季酒店', 'POI carries over to the copy')
  assert.equal(bundle.itemsAdmin.itemRows.size, 4)
})

test('POST /items creates free-text and POI cards; DELETE removes them', async () => {
  const bundle = await createAppWithMemoryStores()
  const trip = await createTripViaApi(bundle.app)
  seedCards(bundle, trip.id)

  const createRes = await bundle.app.request(`/api/trips/${trip.id}/items`, {
    method: 'POST',
    body: JSON.stringify({ dayId: 'day-2', title: '自由活动', note: '骑马' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(createRes.status, 201)
  const created = (await createRes.json()) as { item: { id: string; poi: unknown; legs?: unknown } }
  assert.equal(created.item.poi, null)

  const deleteRes = await bundle.app.request(`/api/trips/${trip.id}/items/${created.item.id}`, { method: 'DELETE' })
  assert.equal(deleteRes.status, 200)
  const deleted = (await deleteRes.json()) as { ok: boolean; legs: unknown[] }
  assert.equal(deleted.ok, true)
  assert.ok(Array.isArray(deleted.legs))
  assert.equal(bundle.itemsAdmin.itemRows.size, 3)

  const ghost = await bundle.app.request(`/api/trips/${trip.id}/items/ghost`, { method: 'DELETE' })
  assert.equal(ghost.status, 404)
})

test('PATCH /items/:id edits the one-line note and images', async () => {
  const bundle = await createAppWithMemoryStores()
  const trip = await createTripViaApi(bundle.app)
  seedCards(bundle, trip.id)

  const res = await bundle.app.request(`/api/trips/${trip.id}/items/i3`, {
    method: 'PATCH',
    body: JSON.stringify({ note: '20:00 抵达', images: [{ url: 'https://example.com/x.jpg' }] }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { item: { note: string; images: { url: string }[] } }
  assert.equal(body.item.note, '20:00 抵达')
  assert.deepEqual(body.item.images, [{ url: 'https://example.com/x.jpg', caption: '' }])

  const noFields = await bundle.app.request(`/api/trips/${trip.id}/items/i3`, {
    method: 'PATCH',
    body: JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(noFields.status, 400)
})

test('card routes validate the trip, the body and storage failures', async () => {
  const bundle = await createAppWithMemoryStores()
  const trip = await createTripViaApi(bundle.app)
  seedCards(bundle, trip.id)

  const unknownTrip = await bundle.app.request('/api/trips/ghost/items/i1/move', { method: 'POST', body: '{}' })
  assert.equal(unknownTrip.status, 404)

  const unknownDay = await bundle.app.request(`/api/trips/${trip.id}/items/i1/move`, {
    method: 'POST',
    body: JSON.stringify({ dayId: 'day-x' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(unknownDay.status, 404)

  const badCreate = await bundle.app.request(`/api/trips/${trip.id}/items`, {
    method: 'POST',
    body: JSON.stringify({ dayId: 'day-1' }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(badCreate.status, 400, 'missing title is invalid')

  const badJson = await bundle.app.request(`/api/trips/${trip.id}/items`, {
    method: 'POST',
    body: 'not-json',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(badJson.status, 400)

  bundle.itemsAdmin.nextWriteError = new Error('disk full')
  const storage = await bundle.app.request(`/api/trips/${trip.id}/items/i1/move`, {
    method: 'POST',
    body: JSON.stringify({ index: 1 }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(storage.status, 500)
  assert.equal(((await storage.json()) as { error: string }).error, '保存失败')
})

test('manual edits leave system messages in the chat thread even when chat storage fails', async () => {
  const bundle = await createAppWithMemoryStores()
  const trip = await createTripViaApi(bundle.app)
  seedCards(bundle, trip.id)

  const failingStore: MessageStoreDriver = {
    async listMessageRows() {
      return []
    },
    async appendMessageRow() {
      throw new Error('chat storage down')
    },
  }
  const tolerantApp = await createApp({
    tripRepository: bundle.trips,
    workbenchStore: bundle.workbench,
    daysAdminStore: bundle.daysAdmin,
    itemsAdminStore: bundle.itemsAdmin as ItemsAdminStoreDriver,
    messageStore: failingStore,
  })

  const res = await tolerantApp.request(`/api/trips/${trip.id}/items/i1/move`, {
    method: 'POST',
    body: JSON.stringify({ index: 1 }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 200, 'the edit succeeds even though the chat write failed')

  // With a healthy store the system note lands in the thread.
  const move = await bundle.app.request(`/api/trips/${trip.id}/items/i2/move`, {
    method: 'POST',
    body: JSON.stringify({ index: 0 }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(move.status, 200)
  const systemNotes = systemRows(bundle.messages.messageRows.filter((row) => row.trip_id === trip.id))
  assert.equal(systemNotes.length, 1)
  assert.match(systemNotes[0]!.content, /移动卡片/)
})

// ---------------------------------------------------------------------------
// SQLite end-to-end: writes read back through the canvas API (one shared db)
// ---------------------------------------------------------------------------

test('card edits round-trip through SQLite and recompute legs in the canvas read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'items-admin-'))
  try {
    const dbUrl = `file:${join(dir, 'trips.db')}`
    const { repository, db } = await createSqliteTripRepository(dbUrl)
    const created = await repository.create({ title: '库里的行程', startDate: '2026-10-02', endDate: '2026-10-03' })
    if (!created.ok) return assert.fail('trip creation failed')
    const tripId = created.trip.id

    await db.run('INSERT INTO days (id, trip_id, idx, date, theme) VALUES (?, ?, 0, ?, ?)', [
      'day-1',
      tripId,
      '2026-10-02',
      '抵达',
    ])
    await db.run('INSERT INTO days (id, trip_id, idx, date, theme) VALUES (?, ?, 1, ?, ?)', [
      'day-2',
      tripId,
      '2026-10-03',
      '草原',
    ])
    for (const [id, dayId, order, lng, lat] of [
      ['i1', 'day-1', 0, 119.7, 49.2],
      ['i2', 'day-1', 1, 119.85, 49.42],
      ['i3', 'day-2', 0, null, null],
    ] as [string, string, number, number | null, number | null][]) {
      await db.run(
        'INSERT INTO items (id, trip_id, day_id, item_order, type, title, poi) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, tripId, dayId, order, 'attraction', `卡片 ${id}`, lat === null ? null : JSON.stringify({ name: id, lat, lng, amapId: '', category: '', rating: 0, introSummary: '' })],
      )
    }

    // One stored pair leg (the built-in seed convention) for the reuse rule.
    await db.run(
      "INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline) VALUES ('leg-i1-i2', ?, 'i1', 'i2', 'drive', 30.3, 31, NULL)",
      [tripId],
    )

    // No injected stores: the app resolves the SQLite stores over the shared db.
    const app = await createApp({ tripRepository: repository, databaseUrl: dbUrl })

    // Move i1 after i2 → day-1 = [i2, i1]; the reverse direction gets an
    // explicit estimate until the route refresh provider answers.
    const moveRes = await app.request(`/api/trips/${tripId}/items/i1/move`, {
      method: 'POST',
      body: JSON.stringify({ index: 1 }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(moveRes.status, 200)

    const canvas = (await (await app.request(`/api/trips/${tripId}/canvas`)).json()) as {
      days: { id: string; items: { id: string; order: number }[] }[]
      legs: { fromItemId: string; toItemId: string; distanceKm: number }[]
    }
    const day1 = canvas.days.find((day) => day.id === 'day-1')!
    assert.deepEqual(
      day1.items.map((item) => item.id),
      ['i2', 'i1'],
    )
    assert.deepEqual(
      day1.items.map((item) => item.order),
      [0, 1],
    )
    const pair = canvas.legs.find((leg) => leg.fromItemId === 'i2' && leg.toItemId === 'i1')
    assert.ok(pair, 'the reversed pair leg exists')
    assert.equal(pair.distanceKm, 32.1, 'reverse direction uses its own estimate')

    // A free-text create lands in the canvas read with its POI-less card.
    const createRes = await app.request(`/api/trips/${tripId}/items`, {
      method: 'POST',
      body: JSON.stringify({ dayId: 'day-2', title: '自由活动' }),
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(createRes.status, 201)
    const createdItem = (await createRes.json()) as { item: { id: string } }
    const canvas2 = (await (await app.request(`/api/trips/${tripId}/canvas`)).json()) as {
      days: { id: string; items: { id: string }[] }[]
    }
    const day2 = canvas2.days.find((day) => day.id === 'day-2')!
    assert.deepEqual(
      day2.items.map((item) => item.id),
      ['i3', createdItem.item.id],
    )
    await db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
