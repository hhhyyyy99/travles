/**
 * Card-editing domain tests (ticket 09) — the item-write API client codecs
 * (create/move/copy/update/delete with injected FetchLike stubs, tolerant
 * normalization of the recomputed legs in the response) and the pure
 * optimistic-layout helpers (applyItemMove / applyItemInsert / applyItemRemove
 * / applyItemPatch / applyItemReplace / poiFromPlace).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyItemInsert,
  applyItemMove,
  applyItemPatch,
  applyItemRemove,
  applyItemReplace,
  copyWorkbenchItem,
  createWorkbenchItem,
  deleteWorkbenchItem,
  moveWorkbenchItem,
  poiFromPlace,
  refreshWorkbenchLegs,
  tempItemId,
  updateWorkbenchItem,
  type FetchLike,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchLeg,
} from '../src/domain/workbench'

function stubFetch(
  body: unknown,
  status = 200,
  capture?: { url: string; init?: RequestInit }[],
): FetchLike {
  return async (input, init) => {
    capture?.push({ url: String(input), init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const LEG: WorkbenchLeg = {
  id: 'leg-a-b',
  fromItemId: 'a',
  toItemId: 'b',
  mode: 'drive',
  distanceKm: 30.3,
  durationMin: 31,
  polyline: [
    [119.7, 49.2],
    [119.85, 49.42],
  ],
}

function item(id: string, dayId: string, order: number): WorkbenchItem {
  return {
    id,
    dayId,
    order,
    type: 'attraction',
    title: `卡片 ${id}`,
    note: '',
    poi: null,
    images: [],
    pending: false,
  }
}

function twoDays(): WorkbenchDay[] {
  return [
    { id: 'day-1', index: 0, date: '2026-10-02', theme: '', color: '', items: [item('a', 'day-1', 0), item('b', 'day-1', 1), item('c', 'day-1', 2)] },
    { id: 'day-2', index: 1, date: '2026-10-03', theme: '', color: '', items: [item('d', 'day-2', 0)] },
  ]
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

test('moveWorkbenchItem posts the move and normalizes item + recomputed legs', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const result = await moveWorkbenchItem(
    'trip-1',
    'a',
    { dayId: 'day-2', index: 0 },
    stubFetch({ item: { id: 'a', dayId: 'day-2', order: 0 }, legs: [LEG] }, 200, calls),
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.data.item.id, 'a')
  assert.equal(result.data.item.dayId, 'day-2')
  assert.equal(result.data.legs.length, 1)
  assert.equal(result.data.legs[0]!.distanceKm, 30.3, 'leg normalization keeps the polyline pair')
  assert.equal(calls[0]?.url, '/api/trips/trip-1/items/a/move')
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.equal(String(calls[0]?.init?.body), JSON.stringify({ dayId: 'day-2', index: 0 }))
})

test('copyWorkbenchItem / createWorkbenchItem / updateWorkbenchItem / deleteWorkbenchItem hit their routes', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchLike = stubFetch({ item: { id: 'x', dayId: 'day-2', order: 0 }, legs: [] }, 201, calls)

  const copied = await copyWorkbenchItem('trip-1', 'a', { dayId: 'day-2' }, fetchLike)
  assert.ok(copied.ok)
  const created = await createWorkbenchItem(
    'trip-1',
    { dayId: 'day-2', title: '自由活动', poi: null },
    fetchLike,
  )
  assert.ok(created.ok)
  const updated = await updateWorkbenchItem('trip-1', 'a', { note: '20:00 抵达' }, stubFetch({ item: { id: 'a', note: '20:00 抵达' } }, 200, calls))
  assert.ok(updated.ok)
  if (updated.ok) assert.equal(updated.data.note, '20:00 抵达')
  const deleted = await deleteWorkbenchItem('trip-1', 'a', stubFetch({ ok: true, legs: [LEG] }, 200, calls))
  assert.ok(deleted.ok)
  if (deleted.ok) assert.equal(deleted.data.legs.length, 1)

  assert.deepEqual(
    calls.map((call) => `${call.init?.method} ${call.url}`),
    [
      'POST /api/trips/trip-1/items/a/copy',
      'POST /api/trips/trip-1/items',
      'PATCH /api/trips/trip-1/items/a',
      'DELETE /api/trips/trip-1/items/a',
    ],
  )
})

test('refreshWorkbenchLegs posts the background route upgrade and normalizes its summary', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const result = await refreshWorkbenchLegs(
    'trip-1',
    stubFetch(
      {
        legs: [LEG],
        summary: { attempted: 1, updated: 1, pending: 0, truncated: false },
      },
      200,
      calls,
    ),
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.data.legs[0]?.polyline?.length, 2)
  assert.deepEqual(result.data.summary, { attempted: 1, updated: 1, pending: 0, truncated: false })
  assert.equal(calls[0]?.url, '/api/trips/trip-1/legs/refresh')
  assert.equal(calls[0]?.init?.method, 'POST')
})

test('item client surfaces server errors verbatim and never throws on network loss', async () => {
  const failed = await moveWorkbenchItem('trip-1', 'a', {}, stubFetch({ error: '卡片不存在' }, 404))
  assert.deepEqual(failed, { ok: false, error: '卡片不存在' })

  const down: FetchLike = async () => {
    throw new Error('offline')
  }
  const network = await moveWorkbenchItem('trip-1', 'a', {}, down)
  assert.equal(network.ok, false)
  if (!network.ok) assert.match(network.error, /无法连接服务器/)

  const garbage = await moveWorkbenchItem('trip-1', 'a', {}, stubFetch({ nonsense: true }, 200))
  assert.equal(garbage.ok, false, 'unparseable payloads fail loudly instead of silently dropping')
})

// ---------------------------------------------------------------------------
// Pure optimistic helpers
// ---------------------------------------------------------------------------

test('applyItemMove reorders within a day and across days, renumbering both', () => {
  const sameDay = applyItemMove(twoDays(), 'a', 'day-1', 2)
  assert.deepEqual(
    sameDay[0]!.items.map((entry) => entry.id),
    ['b', 'c', 'a'],
  )
  assert.deepEqual(
    sameDay[0]!.items.map((entry) => entry.order),
    [0, 1, 2],
  )

  const crossDay = applyItemMove(twoDays(), 'b', 'day-2', 0)
  assert.deepEqual(
    crossDay[0]!.items.map((entry) => entry.id),
    ['a', 'c'],
  )
  assert.deepEqual(
    crossDay[1]!.items.map((entry) => entry.id),
    ['b', 'd'],
  )
  assert.deepEqual(
    crossDay[1]!.items.map((entry) => entry.order),
    [0, 1],
  )

  // Out-of-range indexes clamp; unknown ids are a no-op (same reference).
  const days = twoDays()
  const clamped = applyItemMove(days, 'a', 'day-1', 99)
  assert.equal(clamped[0]!.items[clamped[0]!.items.length - 1]!.id, 'a')
  assert.equal(applyItemMove(days, 'ghost', 'day-1', 0), days)
})

test('applyItemInsert / applyItemRemove / applyItemPatch / applyItemReplace behave locally', () => {
  const inserted = applyItemInsert(twoDays(), item('x', 'day-2', 0), 'day-2', 0)
  assert.deepEqual(
    inserted[1]!.items.map((entry) => entry.id),
    ['x', 'd'],
  )
  const appended = applyItemInsert(twoDays(), item('x', 'day-2', 0), 'day-2')
  assert.equal(appended[1]!.items[appended[1]!.items.length - 1]!.id, 'x')

  const removed = applyItemRemove(twoDays(), 'b')
  assert.deepEqual(
    removed[0]!.items.map((entry) => entry.id),
    ['a', 'c'],
  )
  assert.deepEqual(
    removed[0]!.items.map((entry) => entry.order),
    [0, 1],
  )

  const patched = applyItemPatch(twoDays(), 'a', { note: '早点到' })
  assert.equal(patched[0]!.items[0]!.note, '早点到')

  const tempInserted = applyItemInsert(twoDays(), item('pending-1', 'day-2', 0), 'day-2', 0)
  const replaced = applyItemReplace(tempInserted, 'pending-1', item('server-id', 'day-2', 0))
  assert.equal(replaced[1]!.items[0]!.id, 'server-id')
  assert.ok(tempInserted[1]!.items[0]!.id === 'pending-1')
})

test('poiFromPlace maps the AMap search result onto PoiRef and rejects nameless entries', () => {
  const poi = poiFromPlace({ id: 'B0FFG9', name: '莫尔格勒河景区', lat: 49.42, lng: 119.85, address: '呼伦贝尔', city: '呼伦贝尔' })
  assert.deepEqual(poi, {
    amapId: 'B0FFG9',
    name: '莫尔格勒河景区',
    lat: 49.42,
    lng: 119.85,
    category: '呼伦贝尔',
    rating: 0,
    introSummary: '呼伦贝尔',
  })
  assert.equal(poiFromPlace({ name: '  ' }), null)
  assert.equal(poiFromPlace({ name: '无坐标', lat: Number.NaN, lng: 1 })?.lat, 0, 'non-finite coords degrade to 0')
})

test('tempItemId never collides with server ids and is unique per call', () => {
  const a = tempItemId('pending-add')
  const b = tempItemId('pending-add')
  assert.notEqual(a, b)
  assert.match(a, /^pending-add-/)
})
