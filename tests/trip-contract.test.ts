import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ITEM_TYPE_MAP,
  TripCanvasSchema,
  TripSummarySchema,
  TripSchema,
  DaySchema,
  LegSchema,
} from '@hailar/domain'
import { mapRowToSummary } from '../server/src/trips/repository.js'
import { assembleCanvas } from '../server/src/days/repository.js'
import { normalizeTrip } from '../src/domain/tripList'
import { fetchTripCanvas } from '../src/domain/workbench'

/**
 * Contract tests for the shared trip read model. Fixtures mirror the real
 * shapes the server emits today (traffic/stay types, km/min legs with an
 * optional quality, nullable poi) so the shared schema is proven to accept
 * persisted data, not a hypothetical shape.
 */

test('trip summary accepts a fully-populated card and the minimal seed shape', () => {
  const full = {
    id: 't1',
    title: '成都 5 日',
    startDate: '2026-10-02',
    endDate: '2026-10-06',
    days: 5,
    nights: 4,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    coverImage: 'https://example.com/chengdu.jpg',
    isPinned: false,
    status: 'source-defined-label',
    durationDays: 5,
    dateStatus: 'confirmed',
    planningContext: {
      destination: '成都',
      durationDays: 5,
      preferences: '美食 慢节奏',
      originalSentence: '成都5天，喜欢美食，节奏轻松',
      dateStatus: 'confirmed',
      datePhrase: '2026-10-02 至 2026-10-06',
    },
  }
  assert.deepEqual(TripSchema.parse(full), full, 'intake date status and phrase survive schema parsing')

  const minimal = {
    id: 't2',
    title: '待定',
    startDate: '',
    endDate: '',
    days: 3,
    nights: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }
  assert.deepEqual(TripSummarySchema.parse(minimal), minimal, 'no presentation defaults are added to legacy trips')
  assert.deepEqual(normalizeTrip(full), full)
  for (const invalid of [{ coverImage: 42 }, { isPinned: 1 }, { status: { label: 'x' } }]) {
    assert.equal(TripSchema.safeParse({ ...minimal, ...invalid }).success, false)
  }
})

test('a canvas with a plain-text card and a measured leg validates', () => {
  const plainCard = {
    id: 'i1',
    dayId: 'd1',
    order: 0,
    type: 'traffic',
    title: '自驾前往莫尔格勒河',
    note: '约 2 小时',
    poi: null,
    images: [],
    pending: false,
  }
  const poiCard = {
    id: 'i2',
    dayId: 'd1',
    order: 1,
    type: 'attraction',
    title: '莫尔格勒河',
    note: '',
    poi: {
      amapId: 'B123',
      name: '莫尔格勒河',
      lat: 49.3,
      lng: 120.1,
      address: '陈巴尔虎旗',
      category: '风景名胜',
      rating: 4.7,
      introSummary: '天下第一曲水',
    },
    images: [{ url: 'https://x/y.jpg', caption: '河湾' }],
    pending: false,
  }
  const day = {
    id: 'd1',
    index: 0,
    date: '2026-10-02',
    theme: '草原穿越日',
    color: '#8a7',
    items: [plainCard, poiCard],
  }
  const leg = {
    id: 'l1',
    fromItemId: 'i1',
    toItemId: 'i2',
    mode: 'driving',
    distanceKm: 33.8,
    durationMin: 34,
    polyline: [
      [49.2, 120.0],
      [49.3, 120.1],
    ],
    quality: 'measured',
  }

  assert.equal(DaySchema.safeParse(day).success, true)
  assert.equal(LegSchema.safeParse(leg).success, true)
  assert.equal(TripCanvasSchema.safeParse({ days: [day], legs: [leg] }).success, true)

  // A leg without a polyline (unknown geometry) is also valid.
  assert.equal(LegSchema.safeParse({ ...leg, polyline: null }).success, true)
})

test('the read model rejects malformed rows', () => {
  assert.equal(DaySchema.safeParse({ id: 'd1' }).success, false)
  assert.equal(
    LegSchema.safeParse({
      id: 'l1',
      fromItemId: 'a',
      toItemId: 'b',
      mode: 'driving',
      distanceKm: 1,
      durationMin: 1,
      polyline: null,
      quality: 'bogus',
    }).success,
    false,
  )
})

test('legacy storage decodes to shared contracts without changing the browser payload', async () => {
  const trip = mapRowToSummary({
    id: 'legacy-trip', title: '旧行程', start_date: '', end_date: '',
    created_at: null, updated_at: null,
    planning_context: JSON.stringify({
      destination: '成都', durationDays: 3, preferences: '慢节奏',
      originalSentence: '成都3天，慢节奏', dateStatus: 'tentative', datePhrase: '下个月',
    }),
  })
  assert.ok(trip)
  assert.deepEqual(TripSchema.parse(trip), trip)
  assert.deepEqual(normalizeTrip(trip), trip)

  const canvas = assembleCanvas(
    [{ id: 'd1', trip_id: trip.id, idx: 0, date: null, theme: null, color: null }],
    ['traffic', 'stay', 'food', 'other', 'attraction'].map((type, index) => ({
      id: `i${index}`, trip_id: trip.id, day_id: 'd1', item_order: index, type,
      title: type, note: null, images: 'invalid json', pending: index === 0 ? 1 : 0,
      // Older recommendation cards used nested location coordinates.
      poi: index === 0 ? JSON.stringify({ name: '成都', location: { lat: 30.67, lng: 104.06 } }) : null,
    })),
    [{ id: 'l1', trip_id: trip.id, from_item_id: 'i0', to_item_id: 'i1',
      mode: 'drive', distance_km: 12.5, duration_min: 20, polyline: null }],
  )
  assert.deepEqual(TripCanvasSchema.parse(canvas), canvas)
  const payload = { trip, ...canvas }
  const browserResult = await fetchTripCanvas(trip.id, async () => Response.json(payload))
  assert.deepEqual(browserResult, { ok: true, data: payload })
  assert.equal(canvas.legs[0]?.quality, 'estimate')

  const legacyPoi = canvas.days[0]?.items[0]?.poi
  assert.ok(legacyPoi)
  legacyPoi.lat = 100
  legacyPoi.lng = 200
  assert.deepEqual(TripCanvasSchema.parse(canvas), canvas, 'read contracts preserve finite legacy coordinates')
  assert.deepEqual(await fetchTripCanvas(trip.id, async () => Response.json({ trip, ...canvas })), {
    ok: true, data: { trip, ...canvas },
  })
})

test('ITEM_TYPE_MAP records the issue #4 vocabulary mapping', () => {
  assert.deepEqual(ITEM_TYPE_MAP, {
    attraction: 'attraction',
    traffic: 'transit',
    food: 'dining',
    stay: 'accommodation',
    other: 'note',
  })
})
