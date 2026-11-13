import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DaySchema, TripCanvasSchema, TripSchema, type Day, type ItemType, type Leg, type Trip } from '@hailar/domain'
import { createWorkbenchDay, fetchTripCanvas, updateWorkbenchDay, type FetchLike } from '../src/domain/workbench'

const trip: Trip = {
  id: 'trip-legacy',
  title: '旧行程',
  startDate: '',
  endDate: '',
  days: 3,
  nights: 2,
  createdAt: '',
  updatedAt: '',
  destination: '成都',
  daysCount: 3,
  coverImage: 'https://example.com/cover.jpg',
  isPinned: false,
  status: 'source-defined-label',
  durationDays: 3,
  dateStatus: 'tentative',
  planningContext: {
    destination: '成都',
    durationDays: 3,
    preferences: '慢节奏',
    originalSentence: '成都三天，慢节奏',
    dateStatus: 'tentative',
    datePhrase: '下个月',
    source: 'intake',
  },
}

function legacyDay(id: string, index: number): Day {
  const types: ItemType[] = ['traffic', 'stay', 'attraction', 'food', 'other']
  return {
    id,
    index,
    date: '2026-10-02',
    theme: '旧日程',
    color: '#8a7',
    items: types.map((type, position) => ({
      id: `${id}-item-${position}`,
      dayId: id,
      order: position * 2,
      type,
      title: type,
      note: '保留旧卡片',
      poi: null,
      images: [],
      pending: position === 0,
    })),
  }
}

const day = legacyDay('day-legacy', 8)
const leg: Leg = {
  id: 'leg-legacy',
  fromItemId: day.items[0]!.id,
  toItemId: day.items[1]!.id,
  mode: 'drive',
  distanceKm: 12.5,
  durationMin: 20,
  polyline: null,
  quality: 'estimate',
}

// Keep the input values intact, including non-finite numbers, at the decoder seam.
function stubFetch(payload: unknown): FetchLike {
  return async () => {
    const response = new Response(null, { status: 200 })
    response.json = async () => payload
    return response
  }
}

const dayDecoders = [
  {
    name: 'canvas',
    decode: async (value: unknown) => {
      const result = await fetchTripCanvas(trip.id, stubFetch({ trip, days: [value], legs: [leg] }))
      assert.ok(result.ok)
      assert.equal(result.data.days.length, 1)
      return result.data.days[0]
    },
  },
  {
    name: 'create day',
    decode: async (value: unknown) => {
      const result = await createWorkbenchDay(trip.id, {}, stubFetch({ day: value }))
      assert.ok(result.ok)
      return result.data
    },
  },
  {
    name: 'update day',
    decode: async (value: unknown) => {
      const result = await updateWorkbenchDay(trip.id, day.id, { theme: day.theme }, stubFetch({ day: value }))
      assert.ok(result.ok)
      return result.data
    },
  },
]

const invalidTripIds = [null, 42, false, {}, []]
const invalidDayNumbers = [null, '9', true, {}, [], 0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]

test('Day schema preserves legacy shape, items, and activity/leg relationships without adding metadata', () => {
  const canvas = { days: [day], legs: [leg] }
  assert.deepEqual(DaySchema.parse(day), day)
  assert.deepEqual(TripCanvasSchema.parse(canvas), canvas)
  assert.deepEqual(TripSchema.parse(trip), trip, 'earlier Trip optional fields remain part of the shared contract')
})

test('Day schema accepts each optional projection independently without defaults or transforms', () => {
  for (const metadata of [
    { tripId: trip.id },
    { tripId: '' },
    { tripId: ' explicit trip id ' },
    { dayNumber: 1 },
    { dayNumber: 365 },
    { tripId: trip.id, dayNumber: Number.MAX_SAFE_INTEGER },
  ]) {
    const explicit = { ...day, ...metadata }
    assert.deepEqual(DaySchema.parse(explicit), explicit)
  }
})

test('Day schema rejects malformed optional projections even when the other field is valid', () => {
  for (const tripId of invalidTripIds) {
    assert.equal(DaySchema.safeParse({ ...day, tripId, dayNumber: 9 }).success, false, `tripId: ${String(tripId)}`)
  }
  for (const dayNumber of invalidDayNumbers) {
    assert.equal(DaySchema.safeParse({ ...day, tripId: trip.id, dayNumber }).success, false, `dayNumber: ${String(dayNumber)}`)
  }
})

test('schema and canvas client preserve explicit server day numbers across sparse/duplicate indexes', async () => {
  const days = [
    { ...legacyDay('sparse', 12), tripId: trip.id, dayNumber: 3 },
    { ...legacyDay('duplicate-a', 2), tripId: trip.id, dayNumber: 1 },
    { ...legacyDay('duplicate-b', 2), tripId: trip.id, dayNumber: 2 },
    legacyDay('legacy-without-metadata', 27),
  ]
  const canvas = { days, legs: [] }
  assert.deepEqual(TripCanvasSchema.parse(canvas), canvas)
  const result = await fetchTripCanvas(trip.id, stubFetch({ trip, ...canvas }))
  assert.deepEqual(result, { ok: true, data: { trip, ...canvas } })
})

for (const { name, decode } of dayDecoders) {
  test(`${name} client preserves legacy day/items without generating tripId or dayNumber`, async () => {
    assert.deepEqual(await decode(day), day)
  })

  test(`${name} client preserves explicit optional metadata independently and exactly`, async () => {
    for (const metadata of [
      { tripId: 'explicit-server-trip' },
      { tripId: '' },
      { tripId: ' explicit trip id ' },
      { dayNumber: 9 },
      { tripId: trip.id, dayNumber: Number.MAX_SAFE_INTEGER },
    ]) {
      const explicit = { ...day, ...metadata }
      assert.deepEqual(await decode(explicit), explicit)
    }
  })

  test(`${name} client omits each corrupt optional field without losing the other field or legacy content`, async () => {
    for (const tripId of invalidTripIds) {
      assert.deepEqual(await decode({ ...day, tripId, dayNumber: 9 }), { ...day, dayNumber: 9 }, `tripId: ${String(tripId)}`)
    }
    for (const dayNumber of invalidDayNumbers) {
      assert.deepEqual(await decode({ ...day, tripId: trip.id, dayNumber }), { ...day, tripId: trip.id }, `dayNumber: ${String(dayNumber)}`)
    }
    assert.deepEqual(await decode({ ...day, tripId: {}, dayNumber: '9' }), day, 'both invalid fields are omitted')
  })
}

test('canvas client retains earlier Trip metadata and legacy activity/leg links alongside Day projections', async () => {
  const projectedDay = { ...day, tripId: trip.id, dayNumber: 3 }
  const payload = { trip, days: [projectedDay], legs: [leg] }
  assert.deepEqual(await fetchTripCanvas(trip.id, stubFetch(payload)), { ok: true, data: payload })
})
