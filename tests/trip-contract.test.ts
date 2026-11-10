import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ITEM_TYPE_MAP,
  TripCanvasSchema,
  TripSummarySchema,
  DaySchema,
  LegSchema,
} from '@hailar/domain'

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
    durationDays: 5,
    dateStatus: 'confirmed',
    planningContext: {
      destination: '成都',
      durationDays: 5,
      preferences: '美食 慢节奏',
      originalSentence: '成都5天，喜欢美食，节奏轻松',
    },
  }
  assert.equal(TripSummarySchema.safeParse(full).success, true)

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
  assert.equal(TripSummarySchema.safeParse(minimal).success, true)
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

test('ITEM_TYPE_MAP records the issue #4 vocabulary mapping', () => {
  assert.deepEqual(ITEM_TYPE_MAP, {
    attraction: 'attraction',
    traffic: 'transit',
    food: 'dining',
    stay: 'accommodation',
    other: 'note',
  })
})
