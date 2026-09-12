/**
 * Workbench canvas read API tests (ticket 04) — drive the REAL app instance
 * (same seam as trips-api.test.ts) with the in-memory workbench store, plus
 * assembly unit coverage for tolerant row mapping and a SQLite read path
 * against rows written directly into a real database file.
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
import { assembleCanvas, mapPoiRef } from '../src/days/repository.js'
import type { TripSummary } from '../src/trips/types.js'

async function createAppWithMemoryStores() {
  const trips = new TripRepository(new MemoryTripStoreDriver())
  const store = new MemoryWorkbenchStoreDriver()
  const app = await createApp({ tripRepository: trips, workbenchStore: store })
  return { app, trips, store }
}

async function createTripViaApi(
  app: Awaited<ReturnType<typeof createApp>>,
  title: string,
  startDate: string,
  endDate: string,
): Promise<TripSummary> {
  const res = await app.request('/api/trips', {
    method: 'POST',
    body: JSON.stringify({ title, startDate, endDate }),
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(res.status, 201)
  return ((await res.json()) as { trip: TripSummary }).trip
}

const POI_JSON = JSON.stringify({
  amapId: 'B0FFG9E8P1',
  name: '莫尔格勒河景区',
  location: { lat: 49.432, lng: 119.762 },
  category: '景点',
  rating: 4.7,
  introSummary: '草原腹地的曲水。',
})
const IMAGES_JSON = JSON.stringify([{ url: 'data:image/svg+xml;utf8,<svg/>', caption: '曲水' }])

function seedRows(tripId: string) {
  return {
    days: [
      { id: 'day-1', trip_id: tripId, idx: 0, date: '2026-10-02', theme: '抵达海拉尔', color: '#c26d4f' },
      { id: 'day-2', trip_id: tripId, idx: 1, date: '2026-10-03', theme: '穿越莫尔格勒河', color: '#3f7d5c' },
    ],
    items: [
      {
        id: 'item-a',
        trip_id: tripId,
        day_id: 'day-1',
        item_order: 0,
        type: 'stay',
        title: '海拉尔全季酒店',
        note: '15:00 后入住',
        poi: POI_JSON,
        images: IMAGES_JSON,
        pending: 1,
      },
      {
        id: 'item-b',
        trip_id: tripId,
        day_id: 'day-1',
        item_order: 1,
        type: 'traffic',
        title: '自驾前往莫尔格勒河',
        note: null,
        poi: null,
        images: null,
        pending: 0,
      },
      {
        id: 'item-c',
        trip_id: tripId,
        day_id: 'day-1',
        item_order: 2,
        type: 'attraction',
        title: '莫尔格勒河景区',
        note: '提前2天小程序预约',
        poi: POI_JSON,
        images: null,
        pending: 0,
      },
      {
        id: 'item-x',
        trip_id: tripId,
        day_id: 'day-2',
        item_order: 0,
        type: 'other',
        title: '自由活动',
        note: null,
        poi: null,
        images: null,
        pending: 0,
      },
      {
        id: 'item-orphan',
        trip_id: tripId,
        day_id: 'day-missing',
        item_order: 9,
        type: 'food',
        title: '孤儿卡（所属天不存在）',
        note: null,
        poi: null,
        images: null,
        pending: 0,
      },
    ],
    legs: [
      {
        id: 'leg-1',
        trip_id: tripId,
        from_item_id: 'item-a',
        to_item_id: 'item-b',
        mode: 'drive',
        distance_km: 30.3,
        duration_min: 31,
        polyline: '[[119.76,49.43],[119.9,49.5]]',
      },
      {
        id: 'leg-broken',
        trip_id: tripId,
        from_item_id: 'item-b',
        to_item_id: 'item-gone',
        mode: 'drive',
        distance_km: 5,
        duration_min: 10,
        polyline: null,
      },
    ],
  }
}

test('GET /api/trips/:id/canvas returns trip + days + legs (404 unknown trip)', async () => {
  const { app, store } = await createAppWithMemoryStores()
  const trip = await createTripViaApi(app, '国庆呼伦贝尔', '2026-10-02', '2026-10-03')
  const rows = seedRows(trip.id)
  store.seed(rows)

  const res = await app.request(`/api/trips/${trip.id}/canvas`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as { trip: TripSummary; days: unknown[]; legs: unknown[] }
  assert.equal(body.trip.id, trip.id)
  assert.equal(body.trip.title, '国庆呼伦贝尔')

  const days = body.days as Array<Record<string, unknown>>
  assert.equal(days.length, 2)
  assert.deepEqual(days[0]?.date, '2026-10-02')
  assert.deepEqual(days[0]?.theme, '抵达海拉尔')
  const items = days[0]?.items as Array<Record<string, unknown>>
  assert.deepEqual(
    items.map((item) => item.title),
    ['海拉尔全季酒店', '自驾前往莫尔格勒河', '莫尔格勒河景区'],
  )
  const stay = items[0] as Record<string, unknown>
  assert.equal(stay.type, 'stay')
  assert.equal(stay.pending, true, 'pending column coerces to boolean')
  const poi = stay.poi as Record<string, unknown>
  assert.equal(poi.name, '莫尔格勒河景区')
  assert.equal((stay.images as Array<Record<string, unknown>>)[0]?.url, 'data:image/svg+xml;utf8,<svg/>')
  const plain = items[1] as Record<string, unknown>
  assert.equal(plain.poi, null, 'no-POI item renders as a plain-text card')

  const legs = body.legs as Array<Record<string, unknown>>
  assert.equal(legs.length, 1, 'legs referencing unknown items are dropped')
  assert.deepEqual(legs[0] && { km: legs[0].distanceKm, min: legs[0].durationMin }, { km: 30.3, min: 31 })
  assert.deepEqual(legs[0]?.fromItemId, 'item-a')
  assert.deepEqual(legs[0]?.toItemId, 'item-b')

  const missing = await app.request('/api/trips/no-such-id/canvas')
  assert.equal(missing.status, 404)
})

test('GET canvas for a trip without days/items returns empty canvas', async () => {
  const { app } = await createAppWithMemoryStores()
  const trip = await createTripViaApi(app, '空白行程', '2026-10-02', '2026-10-03')
  const res = await app.request(`/api/trips/${trip.id}/canvas`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { trip: JSON.parse(JSON.stringify(trip)), days: [], legs: [] })
})

test('assembleCanvas sorts days by idx and items by order, tolerating corrupt rows', () => {
  const tripId = 't1'
  const rows = seedRows(tripId)
  const { days, legs } = assembleCanvas(
    [...rows.days, { id: '', trip_id: tripId, idx: 5, date: null, theme: null, color: null }],
    [...rows.items, { id: 'item-bad', trip_id: tripId, day_id: 'day-1', item_order: 'x', type: 'weird', title: 42, note: null, poi: 'not json', images: null, pending: null }],
    [...rows.legs, { id: '', trip_id: tripId, from_item_id: 'a', to_item_id: 'b', mode: null, distance_km: 1, duration_min: 1, polyline: null }],
  )
  assert.equal(days.length, 2)
  assert.deepEqual(days.map((day) => day.id), ['day-1', 'day-2'])
  const day1 = days[0]
  assert.ok(day1)
  assert.deepEqual(
    day1.items.map((item) => item.id),
    // item-bad's order coerces to 0, so it ties with item-a and falls back to id order
    ['item-a', 'item-bad', 'item-b', 'item-c'],
  )
  const bad = day1.items.find((item) => item.id === 'item-bad')
  assert.deepEqual(bad && { type: bad.type, order: bad.order, poi: bad.poi, pending: bad.pending }, {
    type: 'other',
    order: 0,
    poi: null,
    pending: false,
  })
  assert.equal(legs.length, 1)
})

test('canvas decoder accepts the flat PoiRef written by item-admin and the legacy nested location shape', () => {
  assert.deepEqual(mapPoiRef(JSON.stringify({ name: '平面点位', lat: 49.4, lng: 119.9 })), {
    amapId: '',
    name: '平面点位',
    lat: 49.4,
    lng: 119.9,
    category: '',
    rating: 0,
    introSummary: '',
  })
  assert.equal(mapPoiRef(POI_JSON)?.lat, 49.432)
})

test('canvas reads survive a SQLite database seeded directly (additive module, no schema change)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-canvas-'))
  try {
    const { repository, db } = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
    const created = await repository.create({ title: '库里的行程', startDate: '2026-10-02', endDate: '2026-10-03' })
    if (!created.ok) return assert.fail('trip creation failed')
    const tripId = created.trip.id
    await db.run("INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES ('d1', ?, 0, '2026-10-02', '接机日', '#c26d4f')", [tripId])
    await db.run(
      "INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending) VALUES ('i1', ?, 'd1', 0, 'stay', '全季酒店', NULL, ?, NULL, 1)",
      [tripId, POI_JSON],
    )
    await db.run(
      "INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline) VALUES ('l1', ?, 'i1', 'i1', 'drive', 12.5, 20, NULL)",
      [tripId],
    )

    const app = await createApp({ tripRepository: repository, databaseUrl: `file:${join(dir, 'trips.db')}` })
    const res = await app.request(`/api/trips/${tripId}/canvas`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      days: Array<{ theme: string; items: Array<{ poi: { name: string } | null }> }>
      legs: unknown[]
    }
    assert.equal(body.days[0]?.theme, '接机日')
    assert.equal(body.days[0]?.items[0]?.poi?.name, '莫尔格勒河景区')
    assert.equal(body.legs.length, 1)
    await db.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
