/**
 * Workbench canvas domain tests (ticket 04) — the fetchTripCanvas codec
 * (injected FetchLike stub) and the pure view helpers the canvas renders
 * (weekday/date labels, leg joining, accent colors, card visuals).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CANVAS_NETWORK_ERROR,
  cardVisual,
  dayAccentColor,
  dayDateLabel,
  fetchTripCanvas,
  formatLegLabel,
  isLongDriveLeg,
  legsByPair,
  weekdayLabel,
  longDriveWarningText,
  type FetchLike,
} from '../src/domain/workbench'

const canvasPayload = {
  trip: { id: 'trip-1', title: '国庆呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-03', days: 2, nights: 1 },
  days: [
    {
      id: 'day-1',
      index: 0,
      date: '2026-10-02',
      theme: '抵达海拉尔',
      color: '#c26d4f',
      items: [
        {
          id: 'item-a',
          dayId: 'day-1',
          order: 0,
          type: 'stay',
          title: '海拉尔全季酒店',
          note: '15:00 后入住',
          poi: { amapId: 'B1', name: '全季酒店', lat: 49.2, lng: 119.7, category: '住宿', rating: 4.8, introSummary: '' },
          images: [{ url: 'https://example.invalid/a.jpg', caption: '' }],
          pending: true,
        },
        {
          id: 'item-b',
          dayId: 'day-1',
          order: 1,
          type: 'traffic',
          title: '自驾前往莫尔格勒河',
          note: '',
          poi: null,
          images: [],
          pending: false,
        },
      ],
    },
    { theme: '坏行 — 没有 id 会被丢弃' },
    null,
  ],
  legs: [
    { id: 'leg-1', fromItemId: 'item-a', toItemId: 'item-b', mode: 'drive', distanceKm: 30.3, durationMin: 31 },
    { id: 'leg-bad', fromItemId: '', toItemId: 'item-b', mode: 'drive', distanceKm: 1, durationMin: 1 },
    null,
  ],
}

function stubFetch(body: unknown, status = 200): FetchLike {
  return async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
}

test('fetchTripCanvas normalizes days/items/legs and drops corrupt entries', async () => {
  const result = await fetchTripCanvas('trip-1', stubFetch(canvasPayload))
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.data.trip.id, 'trip-1')
  assert.equal(result.data.days.length, 1, 'days without an id are dropped')
  const day = result.data.days[0]
  assert.ok(day)
  assert.equal(day.items.length, 2)
  assert.equal(day.items[0]?.pending, true)
  assert.equal(day.items[1]?.poi, null, 'no-POI item survives as a plain-text card')
  assert.equal(result.data.legs.length, 1)
  assert.equal(result.data.legs[0]?.distanceKm, 30.3)
})

test('fetchTripCanvas maps failures to {ok:false, error} and never throws', async () => {
  const network = await fetchTripCanvas('trip-1', async () => {
    throw new Error('down')
  })
  assert.deepEqual(network, { ok: false, error: CANVAS_NETWORK_ERROR })

  const http404 = await fetchTripCanvas('trip-1', stubFetch({ error: '行程不存在' }, 404))
  assert.deepEqual(http404, { ok: false, error: '行程不存在' })

  const garbage = await fetchTripCanvas('trip-1', stubFetch('not json'))
  assert.equal(garbage.ok, false)

  const noTrip = await fetchTripCanvas('trip-1', stubFetch({ days: [], legs: [] }))
  assert.equal(noTrip.ok, false, 'missing trip payload is a parse failure')
})

test('weekdayLabel and dayDateLabel render the day header', () => {
  assert.equal(weekdayLabel('2026-10-02'), '周五')
  assert.equal(weekdayLabel('2026-10-04'), '周日')
  assert.equal(weekdayLabel('10月2号'), '')
  assert.equal(weekdayLabel(''), '')
  assert.equal(dayDateLabel('2026-10-02'), '10.02')
  assert.equal(dayDateLabel('bad'), '')
})

test('legsByPair joins adjacent cards and formatLegLabel formats the chip', () => {
  const map = legsByPair(canvasPayload.legs)
  assert.equal(map.get('item-a|item-b')?.durationMin, 31)
  assert.equal(map.has('|item-b'), false)
  assert.equal(formatLegLabel(map.get('item-a|item-b') ?? null), '30.3 千米 · 31 分钟')
  assert.equal(formatLegLabel(null), '')
  assert.equal(formatLegLabel({ id: 'x', fromItemId: 'a', toItemId: 'b', mode: 'drive', distanceKm: 0, durationMin: 0 }), '')
  assert.equal(
    formatLegLabel({ id: 'x', fromItemId: 'a', toItemId: 'b', mode: 'drive', distanceKm: 12, durationMin: 90 }),
    '12 千米 · 90 分钟',
  )
})

test('legs longer than six hours expose the split warning used by canvas and list views', () => {
  const long = { id: 'long', fromItemId: 'a', toItemId: 'b', mode: 'drive', distanceKm: 420, durationMin: 361 }
  const sixHours = { ...long, id: 'six', durationMin: 360 }
  assert.equal(isLongDriveLeg(long), true)
  assert.equal(isLongDriveLeg(sixHours), false, 'exactly six hours is still within the boundary')
  assert.match(longDriveWarningText(long), /超过 6 小时/)
  assert.equal(longDriveWarningText(null), '')
})

test('dayAccentColor prefers the server color and falls back per index', () => {
  assert.equal(dayAccentColor('#3f7d5c', 0), '#3f7d5c')
  assert.equal(dayAccentColor('', 0), dayAccentColor('#nothex', 0), 'invalid colors both fall back')
  assert.notEqual(dayAccentColor('', 0), dayAccentColor('', 1), 'fallback palette varies by day')
  assert.equal(dayAccentColor('#abc', 2), dayAccentColor('', 2), 'any invalid color falls back the same way')
})

test('cardVisual maps the item vocabulary onto the four card families', () => {
  assert.equal(cardVisual('traffic'), 'traffic')
  assert.equal(cardVisual('stay'), 'stay')
  assert.equal(cardVisual('attraction'), 'attraction')
  assert.equal(cardVisual('food'), 'attraction', 'food shares the 游玩 family, distinct type label')
  assert.equal(cardVisual('other'), 'other')
  assert.equal(cardVisual('weird' as never), 'other')
})
