/**
 * Workbench map linkage domain tests (ticket 05) — the pure logic that turns
 * canvas Day/Item/Leg data into map drawing inputs: per-day route segments
 * (leg polyline → straight-line fallback), day mileage, the "10.02 周五
 * 76km" label, direction ticks, the POI marker sequence, zoom-dependent
 * collision hiding, and the polyline passthrough in the canvas codec.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchTripCanvas,
  formatLegDisplayLabel,
  legQuality,
  type WorkbenchDay,
  type WorkbenchItem,
  type WorkbenchLeg,
} from '../src/domain/workbench'
import {
  bearingDeg,
  dayFitCoordinates,
  dayItemsInOrder,
  dayMileageKm,
  dayRouteQuality,
  dayRouteSegments,
  formatMileageLabel,
  hiddenByCollision,
  legPolylineLatLng,
  poiMarkersForDays,
  routeTicks,
  tripFitCoordinates,
} from '../src/domain/workbenchMap'
import type { PoiRef } from '../src/domain/workbench'

function poi(overrides: Partial<PoiRef> = {}): PoiRef {
  return { amapId: 'B0', name: '点', lat: 49.2, lng: 119.7, category: '景点', rating: 4.5, introSummary: '', ...overrides }
}

function item(id: string, order: number, overrides: Partial<WorkbenchItem> = {}): WorkbenchItem {
  return {
    id,
    dayId: 'day-1',
    order,
    type: 'attraction',
    title: `点位${order}`,
    note: '',
    poi: null,
    images: [],
    pending: false,
    ...overrides,
  }
}

function day(overrides: Partial<WorkbenchDay> = {}): WorkbenchDay {
  return { id: 'day-1', index: 0, date: '2026-10-02', theme: '抵达', color: '#c26d4f', items: [], ...overrides }
}

function leg(id: string, from: string, to: string, overrides: Partial<WorkbenchLeg> = {}): WorkbenchLeg {
  return { id, fromItemId: from, toItemId: to, mode: 'drive', distanceKm: 10, durationMin: 12, polyline: null, ...overrides }
}

test('legPolylineLatLng converts WGS-84 [lng,lat] to [lat,lng] and rejects degenerate input', () => {
  assert.deepEqual(legPolylineLatLng(leg('l', 'a', 'b', { polyline: [[119.7, 49.2], [119.8, 49.3]] })), [
    [49.2, 119.7],
    [49.3, 119.8],
  ])
  assert.equal(legPolylineLatLng(leg('l', 'a', 'b', { polyline: null })), null)
  assert.equal(legPolylineLatLng(leg('l', 'a', 'b', { polyline: [[119.7, 49.2]] })), null, 'a single point is not a line')
})

test('dayRouteSegments uses the leg polyline and falls back to straight lines', () => {
  const dayData = day({
    items: [
      item('a', 0, { poi: poi({ lat: 49.2, lng: 119.7 }) }),
      item('b', 1, { poi: poi({ lat: 49.3, lng: 119.8 }) }),
      item('c', 2, { poi: poi({ lat: 49.4, lng: 119.9 }) }),
    ],
  })
  const legs = [
    leg('l1', 'a', 'b', { polyline: [[119.7, 49.2], [119.75, 49.25], [119.8, 49.3]] }),
    leg('l2', 'b', 'c', { polyline: null }),
  ]
  const segments = dayRouteSegments(dayData, legs)
  assert.equal(segments.length, 1, 'the pieces join into one continuous path')
  assert.equal(segments[0]!.length, 4, 'polyline geometry is kept, straight fallback appended, shared point deduped')
  assert.deepEqual(segments[0]!.slice(3), [[49.4, 119.9]])
})

test('dayRouteSegments joins leg polylines across cards without POI coordinates', () => {
  const dayData = day({
    items: [
      item('a', 0, { poi: poi({ lat: 49.2, lng: 119.7 }) }),
      item('t', 1, { type: 'traffic', poi: null }),
      item('c', 2, { poi: poi({ lat: 49.42, lng: 119.85 }) }),
    ],
  })
  const legs = [
    leg('l1', 'a', 't', { polyline: [[119.7, 49.2], [119.8, 49.32]] }),
    leg('l2', 't', 'c', { polyline: [[119.8, 49.32], [119.85, 49.42]] }),
  ]
  const segments = dayRouteSegments(dayData, legs)
  assert.equal(segments.length, 1)
  assert.deepEqual(segments[0], [[49.2, 119.7], [49.32, 119.8], [49.42, 119.85]])
})

test('dayRouteSegments breaks the chain when a gap has no geometry', () => {
  const dayData = day({
    items: [
      item('a', 0, { poi: poi({ lat: 49.2, lng: 119.7 }) }),
      item('t', 1, { type: 'traffic', poi: null }),
      item('c', 2, { poi: poi({ lat: 49.4, lng: 119.9 }) }),
    ],
  })
  assert.deepEqual(dayRouteSegments(dayData, [leg('l1', 'a', 't'), leg('l2', 't', 'c')]), [])
})

test('dayItemsInOrder sorts by order', () => {
  const dayData = day({ items: [item('b', 2), item('a', 0), item('c', 1)] })
  assert.deepEqual(dayItemsInOrder(dayData).map((entry) => entry.id), ['a', 'c', 'b'])
})

test('dayMileageKm sums the day leg distances', () => {
  const dayData = day({ items: [item('a', 0), item('b', 1), item('c', 2)] })
  assert.equal(dayMileageKm(dayData, [leg('l1', 'a', 'b', { distanceKm: 30.3 }), leg('l2', 'b', 'c', { distanceKm: 45 })]), 75.3)
})

test('dayRouteQuality distinguishes measured, estimated, and pending map routes', () => {
  const dayData = day({ items: [item('a', 0), item('b', 1)] })
  assert.equal(dayRouteQuality(dayData, [leg('l', 'a', 'b', { polyline: [[119.7, 49.2], [119.8, 49.3]] })]), 'measured')
  assert.equal(dayRouteQuality(dayData, [leg('l', 'a', 'b')]), 'estimate')
  assert.equal(dayRouteQuality(dayData, [leg('l', 'a', 'b', { distanceKm: 0, durationMin: 0 })]), 'pending')
  assert.equal(dayRouteQuality(dayData, []), 'pending')
  assert.equal(dayRouteQuality(dayData, [leg('l', 'a', 'b', { quality: 'reference', polyline: [[119.7, 49.2], [119.8, 49.3]] })]), 'estimate')
  assert.equal(legQuality(leg('l', 'a', 'b', { quality: 'reference' })), 'reference')
})

test('reference and estimated leg labels stay approximate while measured labels do not', () => {
  assert.equal(formatLegDisplayLabel(leg('reference', 'a', 'b', { quality: 'reference', polyline: [[119.7, 49.2], [119.8, 49.3]] })), '约 10 千米 · 12 分钟')
  assert.equal(formatLegDisplayLabel(leg('estimate', 'a', 'b', { quality: 'estimate' })), '约 10 千米 · 12 分钟')
  assert.equal(formatLegDisplayLabel(leg('measured', 'a', 'b', { quality: 'measured', polyline: [[119.7, 49.2], [119.8, 49.3]] })), '10 千米 · 12 分钟')
})

test('formatMileageLabel makes map estimates and pending routes explicit', () => {
  const dayData = day({ date: '2026-10-02', index: 0 })
  assert.equal(formatMileageLabel(dayData, 75.3, 'estimate'), '10.02 周五 约 75km')
  assert.equal(formatMileageLabel(dayData, 0, 'pending'), '10.02 周五 待查询')
})

test('formatMileageLabel matches the canvas day header labels', () => {
  assert.equal(formatMileageLabel(day({ date: '2026-10-02', index: 0 }), 75.3), '10.02 周五 75km')
  assert.equal(formatMileageLabel(day({ date: '2026-10-05', index: 2 }), 185), '10.05 周一 185km')
  assert.equal(formatMileageLabel(day({ date: '', index: 3 }), 0), 'D4 周日 0km'.replace(' 周日', ''), 'blank date falls back to Dn')
})

test('routeTicks spaces ticks along the line with the travel bearing', () => {
  // ~111 km of eastward travel per degree of longitude at the equator.
  const coords: [number, number][] = [[0, 0], [0, 3]]
  const ticks = routeTicks(coords, 100)
  assert.equal(ticks.length, 4)
  for (const tick of ticks) {
    assert.ok(Math.abs(tick.bearing - 90) < 0.5, `eastward bearing, got ${tick.bearing}`)
  }
  assert.equal(routeTicks([coords[0]!], 100).length, 0, 'a single point has no ticks')
  assert.equal(bearingDeg([0, 0], [1, 0]), 0, 'north → 0°')
})

test('poiMarkersForDays emits per-day sequence numbers in item order', () => {
  const days = [
    day({
      id: 'day-1',
      index: 0,
      items: [
        item('a', 0, { poi: poi({ name: '全季酒店' }) }),
        item('traffic', 1),
        item('b', 2, { poi: poi({ name: '莫尔格勒河', lat: 49.4, lng: 119.8 }) }),
      ],
    }),
    day({ id: 'day-2', index: 1, date: '2026-10-03', color: '#3f7d5c', items: [item('c', 0, { dayId: 'day-2', poi: poi({ lat: 49.5, lng: 119.9 }) })] }),
  ]
  const markers = poiMarkersForDays(days)
  assert.deepEqual(
    markers.map((marker) => [marker.itemId, marker.seq]),
    [['a', 1], ['b', 2], ['c', 1]],
    'traffic cards without POI do not consume a sequence number',
  )
  assert.equal(markers[0]!.color, '#c26d4f')
  assert.equal(markers[2]!.color, '#3f7d5c')
})

test('hiddenByCollision hides close markers at low zoom and reveals them when zoomed in', () => {
  const markers = poiMarkersForDays([
    day({
      items: [
        item('close-1', 0, { poi: poi({ lat: 49.2, lng: 119.7 }) }),
        item('close-2', 1, { poi: poi({ lat: 49.201, lng: 119.701 }) }),
        item('far', 2, { poi: poi({ lat: 50.2, lng: 120.7 }) }),
      ],
    }),
  ])
  const lowZoom = hiddenByCollision(markers, 9)
  assert.ok(lowZoom.has('close-2'), 'the later of two overlapping markers is hidden')
  assert.ok(!lowZoom.has('close-1'))
  assert.ok(!lowZoom.has('far'))
  const highZoom = hiddenByCollision(markers, 15)
  assert.equal(highZoom.size, 0, 'zoomed in, every marker is visible')
})

test('fit coordinates cover segments and POIs across days', () => {
  const days = [
    day({ items: [item('a', 0, { poi: poi({ lat: 49.2, lng: 119.7 }) }), item('b', 1, { poi: poi({ lat: 49.3, lng: 119.8 }) })] }),
    day({ id: 'day-2', index: 1, items: [item('c', 0, { dayId: 'day-2', poi: poi({ lat: 49.5, lng: 119.9 }) })] }),
  ]
  const all = tripFitCoordinates(days, [leg('l1', 'a', 'b')])
  assert.deepEqual(all, [[49.2, 119.7], [49.3, 119.8], [49.2, 119.7], [49.3, 119.8], [49.3, 119.8], [49.5, 119.9], [49.5, 119.9]], 'the incoming bridge is included in the next day fit')
  assert.ok(dayFitCoordinates(days[0]!, []).length >= 2)
})

test('incoming cross-day route quality and mileage use a stored bridge', () => {
  const previous = day({
    id: 'day-1',
    index: 0,
    items: [item('from', 0, { poi: poi({ lat: 49.2, lng: 119.7 }) })],
  })
  const current = day({
    id: 'day-2',
    index: 1,
    items: [item('to', 0, { dayId: 'day-2', poi: poi({ lat: 49.3, lng: 119.8 }) })],
  })
  const bridge = leg('bridge', 'from', 'to', {
    distanceKm: 22.2,
    durationMin: 24,
    polyline: [[119.7, 49.2], [119.75, 49.25], [119.8, 49.3]],
    quality: 'reference',
  })
  assert.equal(dayMileageKm(current, [bridge], previous), 22.2)
  assert.equal(dayRouteQuality(current, [bridge], previous), 'estimate')
  assert.deepEqual(dayRouteSegments(current, [bridge], previous), [[
    [49.2, 119.7],
    [49.25, 119.75],
    [49.3, 119.8],
  ]])
})

test('fetchTripCanvas keeps leg polylines and drops corrupt entries', async () => {
  const payload = {
    trip: { id: 'trip-1', title: 't', startDate: '2026-10-02', endDate: '2026-10-03', days: 1, nights: 0 },
    days: [],
    legs: [
      { id: 'l1', fromItemId: 'a', toItemId: 'b', mode: 'drive', distanceKm: 1, durationMin: 2, polyline: [[119.7, 49.2], ['x', 'y'], [119.8, 49.3]] },
      { id: 'l2', fromItemId: 'b', toItemId: 'c', polyline: 'not-a-list' },
    ],
  }
  const response = { ok: true, status: 200, json: async () => payload } as unknown as Response
  const result = await fetchTripCanvas('trip-1', (async () => response) as unknown as typeof fetch)
  assert.ok(result.ok)
  if (!result.ok) return
  assert.deepEqual(result.data.legs[0]?.polyline, [[119.7, 49.2], [119.8, 49.3]], 'non-finite points are dropped')
  assert.equal(result.data.legs[1]?.polyline, null)
})
