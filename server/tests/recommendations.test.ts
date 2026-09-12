import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from '../src/app.js'
import { MemoryRecommendationsStoreDriver } from '../src/recommendations/driver-memory.js'
import { RecommendationsRepository } from '../src/recommendations/repository.js'
import { searchAmapPoi } from '../src/recommendations/search.js'
import { parseAmapRoute, pendingRoute, refreshTripLegs, routeAmapLeg, RouteLookupCache } from '../src/recommendations/route.js'
import type { RecommendationPoi, RouteLegResult } from '../src/recommendations/types.js'
import { MemoryItemsAdminStoreDriver } from '../src/items-admin/driver-memory.js'
import { createMastra } from '../src/mastra.js'
import { createSearchStayReferenceTool } from '../src/recommendations/tool.js'
import { TripRepository } from '../src/trips/repository.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'

const poi: RecommendationPoi = {
  id: 'poi-river',
  amapId: 'B-river',
  name: '莫尔格勒河景区',
  lat: 49.42,
  lng: 119.85,
  category: '景点',
  type: 'attraction',
  region: '陈巴尔虎旗',
  rating: 4.7,
  introSummary: '沿途草原景观',
  address: '呼伦贝尔市陈巴尔虎旗',
  images: [],
}

async function fixture() {
  const trips = new TripRepository(new MemoryTripStoreDriver())
  const recommendations = new MemoryRecommendationsStoreDriver()
  const app = await createApp({
    tripRepository: trips,
    recommendationsStore: recommendations,
    searchPoi: async ({ query, region, type }): Promise<RecommendationPoi[]> => [{ ...poi, id: `${query || 'all'}-${region || 'all'}-${type || 'all'}` }],
  })
  const response = await app.request('/api/trips', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '推荐 API 测试', startDate: '2026-10-02', endDate: '2026-10-03' }),
  })
  assert.equal(response.status, 201)
  const trip = ((await response.json()) as { trip: { id: string } }).trip
  return { app, trip, recommendations }
}

test('stash and favorites are persisted, deduplicated, and favorites enter the pending pool', async () => {
  const { app, trip } = await fixture()
  const addStash = await app.request(`/api/trips/${trip.id}/stash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi }),
  })
  assert.equal(addStash.status, 201)
  const firstStash = ((await addStash.json()) as { item: { id: string } }).item

  const duplicate = await app.request(`/api/trips/${trip.id}/stash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi: { ...poi, name: '同一个点位的别名' } }),
  })
  assert.equal(duplicate.status, 201)
  assert.equal(((await duplicate.json()) as { item: { id: string } }).item.id, firstStash.id, 'amapId deduplicates stash rows')

  const addFavorite = await app.request(`/api/trips/${trip.id}/favorites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi }),
  })
  assert.equal(addFavorite.status, 201)
  const snapshot = await app.request(`/api/trips/${trip.id}/recommendations`)
  assert.equal(snapshot.status, 200)
  const body = (await snapshot.json()) as { stash: unknown[]; favorites: unknown[]; recommendations: unknown[] }
  assert.equal(body.stash.length, 1)
  assert.equal(body.favorites.length, 1)
  assert.equal(body.recommendations.length, 1)
})

test('removing a favorite removes its favorite-origin stash row but leaves recommendation-origin stash rows', async () => {
  const { app, trip } = await fixture()
  const favorite = await app.request(`/api/trips/${trip.id}/favorites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi }),
  })
  const favoriteId = ((await favorite.json()) as { favorite: { id: string } }).favorite.id
  const removed = await app.request(`/api/trips/${trip.id}/favorites/${favoriteId}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  const snapshot = (await (await app.request(`/api/trips/${trip.id}/recommendations`)).json()) as { stash: unknown[]; favorites: unknown[] }
  assert.equal(snapshot.favorites.length, 0)
  assert.equal(snapshot.stash.length, 0)

  const stash = await app.request(`/api/trips/${trip.id}/stash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi }),
  })
  assert.equal(stash.status, 201)
  const favoriteAgain = await app.request(`/api/trips/${trip.id}/favorites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi }),
  })
  const favoriteAgainId = ((await favoriteAgain.json()) as { favorite: { id: string } }).favorite.id
  await app.request(`/api/trips/${trip.id}/favorites/${favoriteAgainId}`, { method: 'DELETE' })
  const preserved = (await (await app.request(`/api/trips/${trip.id}/recommendations`)).json()) as { stash: unknown[] }
  assert.equal(preserved.stash.length, 1, 'recommendation-origin stash remains after unfavorite')
})

test('search endpoint uses the injected search_poi channel and passes filters', async () => {
  const { app, trip } = await fixture()
  const response = await app.request(`/api/trips/${trip.id}/recommendations/search?query=湿地&region=额尔古纳&type=attraction`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { recommendations: Array<{ id: string }> }
  assert.deepEqual(body.recommendations.map((entry) => entry.id), ['湿地-额尔古纳-attraction'])
})

test('repository drops malformed rows without throwing', async () => {
  const driver = new MemoryRecommendationsStoreDriver()
  driver.stashRows.set('bad', { id: 'bad', trip_id: 'trip', poi: '{bad json', origin: 'recommend', added_at: '' })
  driver.favoriteRows.set('bad-favorite', { id: 'bad-favorite', trip_id: 'trip', poi: null, created_at: '' })
  const snapshot = await new RecommendationsRepository(driver).snapshot('trip')
  assert.deepEqual(snapshot, { stash: [], favorites: [] })
})

test('AMap POI search converts coordinates and keeps web-service rating/photos', async () => {
  const previousKey = process.env.AMAP_WEB_KEY
  const previousFetch = globalThis.fetch
  process.env.AMAP_WEB_KEY = 'test-key'
  let requestUrl = ''
  globalThis.fetch = (async (input) => {
    requestUrl = String(input)
    return new Response(
      JSON.stringify({
        status: '1',
        pois: [
          {
            id: 'B-test',
            name: '测试民宿',
            location: '119.9,49.4',
            type: '住宿服务;民宿',
            adname: '额尔古纳市',
            biz_ext: { rating: '4.8' },
            photos: [{ url: 'https://img.example/stay.jpg', title: '房间' }],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  try {
    const results = await searchAmapPoi({ query: '', type: 'stay' })
    assert.equal(results.length, 1)
    assert.equal(results[0]?.type, 'stay')
    assert.equal(results[0]?.rating, 4.8)
    assert.deepEqual(results[0]?.images, [{ url: 'https://img.example/stay.jpg', caption: '房间' }])
    assert.notDeepEqual([results[0]?.lng, results[0]?.lat], [119.9, 49.4])
    assert.match(requestUrl, /keywords=%E9%85%92%E5%BA%97\+%E6%B0%91%E5%AE%BF\+%E4%BD%8F%E5%AE%BF/)
  } finally {
    if (previousKey === undefined) delete process.env.AMAP_WEB_KEY
    else process.env.AMAP_WEB_KEY = previousKey
    globalThis.fetch = previousFetch
  }
})

test('route parser reads the AMap object-shaped response and keeps pending explicit', () => {
  const route = parseAmapRoute({
    status: '1',
    route: {
      paths: [{
        distance: '12345',
        duration: '3600',
        steps: [{ polyline: '119.9,49.4;119.91,49.41' }],
      }],
    },
  })
  assert.deepEqual(route, {
    status: 'ok',
    source: 'amap',
    distanceKm: 12.3,
    durationMin: 60,
    polyline: [[119.89303871958799, 49.39824893444907], [119.90304600361077, 49.40824923313777]],
  })
  assert.equal(pendingRoute('无 Key').distanceKm, null)
  assert.equal(pendingRoute('无 Key').durationMin, null)
})

test('AMap route adapter converts persisted WGS-84 endpoints at the request boundary', async () => {
  const previousKey = process.env.AMAP_WEB_KEY
  const previousFetch = globalThis.fetch
  process.env.AMAP_WEB_KEY = 'test-key'
  let requestUrl = ''
  globalThis.fetch = (async (input) => {
    requestUrl = String(input)
    return new Response(JSON.stringify({ status: '1', route: { paths: [{ distance: '1000', duration: '600' }] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const result = await routeAmapLeg({ from: { lat: 49.4, lng: 119.9 }, to: { lat: 49.5, lng: 120 } })
    assert.equal(result.status, 'ok')
    const params = new URL(requestUrl).searchParams
    assert.notEqual(params.get('origin'), '119.9,49.4')
    assert.notEqual(params.get('destination'), '120,49.5')
  } finally {
    if (previousKey === undefined) delete process.env.AMAP_WEB_KEY
    else process.env.AMAP_WEB_KEY = previousKey
    globalThis.fetch = previousFetch
  }
})

test('route refresh replaces estimate rows with real metrics and preserves them when pending', async () => {
  const store = new MemoryItemsAdminStoreDriver()
  store.itemRows.set('item-a', {
    id: 'item-a', trip_id: 'trip-route', day_id: 'day-1', item_order: 0, type: 'attraction', title: '起点', note: '',
    poi: JSON.stringify({ name: '起点', lat: 49.4, lng: 119.9 }), images: null, pending: 0,
  })
  store.itemRows.set('item-b', {
    id: 'item-b', trip_id: 'trip-route', day_id: 'day-1', item_order: 1, type: 'attraction', title: '终点', note: '',
    poi: JSON.stringify({ name: '终点', lat: 49.5, lng: 120 }), images: null, pending: 0,
  })
  store.legRows.set('leg-item-a-item-b', {
    id: 'leg-item-a-item-b', trip_id: 'trip-route', from_item_id: 'item-a', to_item_id: 'item-b', mode: 'drive', distance_km: 16.8, duration_min: 17, polyline: null,
  })
  const real: RouteLegResult = {
    status: 'ok', source: 'amap', distanceKm: 21.4, durationMin: 28, polyline: [[119.9, 49.4], [120, 49.5]],
  }
  const refreshed = await refreshTripLegs(store, 'trip-route', async () => real)
  assert.equal(refreshed.ok, true)
  if (refreshed.ok) assert.deepEqual(refreshed.legs[0], { id: 'leg-item-a-item-b', fromItemId: 'item-a', toItemId: 'item-b', mode: 'drive', distanceKm: 21.4, durationMin: 28, polyline: real.polyline, quality: 'measured' })

  const pending = await refreshTripLegs(store, 'trip-route', async () => pendingRoute('未配置'))
  assert.equal(pending.ok, true)
  if (pending.ok) assert.equal(pending.legs[0]?.distanceKm, 21.4)
})

test('route refresh limits provider concurrency and reuses only ordered cached pairs', async () => {
  const store = new MemoryItemsAdminStoreDriver()
  for (let index = 0; index < 7; index += 1) {
    store.itemRows.set(`item-${index}`, {
      id: `item-${index}`,
      trip_id: 'trip-bounded',
      day_id: 'day-1',
      item_order: index,
      type: 'attraction',
      title: `点位 ${index}`,
      note: '',
      poi: JSON.stringify({ name: `点位 ${index}`, lat: 49.4 + index * 0.01, lng: 119.9 + index * 0.01 }),
      images: null,
      pending: 0,
    })
  }
  let active = 0
  let maximumActive = 0
  let calls = 0
  const provider: NonNullable<Parameters<typeof refreshTripLegs>[2]> = async () => {
    calls += 1
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return { status: 'ok', source: 'amap', distanceKm: 10, durationMin: 12, polyline: [[119.9, 49.4], [120, 49.5]] }
  }
  const options = { cache: new RouteLookupCache(), concurrency: 2, lookupTimeoutMs: 100, maxDurationMs: 500 }
  const first = await refreshTripLegs(store, 'trip-bounded', provider, options)
  assert.equal(first.ok, true)
  assert.equal(calls, 6)
  assert.ok(maximumActive <= 2)
  if (first.ok) assert.deepEqual(first.summary, { attempted: 6, updated: 6, pending: 0, truncated: false })

  const second = await refreshTripLegs(store, 'trip-bounded', provider, options)
  assert.equal(second.ok, true)
  assert.equal(calls, 6, 'the same ordered coordinate pairs are served from the cache')
})

test('pending refresh turns a reverse geometry cache into an explicit estimate', async () => {
  const store = new MemoryItemsAdminStoreDriver()
  store.itemRows.set('item-a', {
    id: 'item-a', trip_id: 'trip-reverse', day_id: 'day-1', item_order: 1, type: 'attraction', title: '起点', note: '',
    poi: JSON.stringify({ name: '起点', lat: 49.4, lng: 119.9 }), images: null, pending: 0,
  })
  store.itemRows.set('item-b', {
    id: 'item-b', trip_id: 'trip-reverse', day_id: 'day-1', item_order: 0, type: 'attraction', title: '终点', note: '',
    poi: JSON.stringify({ name: '终点', lat: 49.5, lng: 120 }), images: null, pending: 0,
  })
  // This is the shape ticket 09 produces after moving a measured a→b leg to
  // b→a. A pending provider must not preserve that one-way geometry.
  store.legRows.set('leg-item-a-item-b', {
    id: 'leg-item-a-item-b', trip_id: 'trip-reverse', from_item_id: 'item-a', to_item_id: 'item-b', mode: 'drive',
    distance_km: 99, duration_min: 120, polyline: JSON.stringify([[119.9, 49.4], [120, 49.5]]),
  })
  const refreshed = await refreshTripLegs(store, 'trip-reverse', async () => pendingRoute('未配置'), {
    maxDurationMs: 100,
  })
  assert.equal(refreshed.ok, true)
  if (refreshed.ok) {
    assert.equal(refreshed.legs[0]?.polyline, null)
    assert.notEqual(refreshed.legs[0]?.distanceKm, 99)
    assert.ok((refreshed.legs[0]?.distanceKm ?? 0) > 0)
  }
})

test('route refresh abandons hanging provider pairs within its total budget', async () => {
  const store = new MemoryItemsAdminStoreDriver()
  for (let index = 0; index < 5; index += 1) {
    store.itemRows.set(`item-${index}`, {
      id: `item-${index}`, trip_id: 'trip-timeout', day_id: 'day-1', item_order: index, type: 'attraction', title: `点位 ${index}`, note: '',
      poi: JSON.stringify({ name: `点位 ${index}`, lat: 49.4 + index * 0.01, lng: 119.9 + index * 0.01 }), images: null, pending: 0,
    })
  }
  const started = Date.now()
  const result = await refreshTripLegs(store, 'trip-timeout', async () => new Promise(() => {}), {
    concurrency: 2,
    lookupTimeoutMs: 15,
    maxDurationMs: 35,
  })
  assert.equal(result.ok, true)
  assert.ok(Date.now() - started < 250, 'the whole refresh is bounded even when the provider never resolves')
  if (result.ok) assert.equal(result.summary.truncated, true)
})

test('route refresh API upgrades the shared item-admin leg store', async () => {
  const trips = new TripRepository(new MemoryTripStoreDriver())
  const items = new MemoryItemsAdminStoreDriver()
  const app = await createApp({
    tripRepository: trips,
    itemsAdminStore: items,
    recommendationsStore: new MemoryRecommendationsStoreDriver(),
    routeLegs: async () => ({ status: 'ok', source: 'amap', distanceKm: 8.2, durationMin: 12, polyline: null }),
  })
  const created = await app.request('/api/trips', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '路线刷新 API', startDate: '2026-10-02', endDate: '2026-10-03' }),
  })
  const tripId = ((await created.json()) as { trip: { id: string } }).trip.id
  items.itemRows.set('item-a', {
    id: 'item-a', trip_id: tripId, day_id: 'day-1', item_order: 0, type: 'attraction', title: '起点', note: '',
    poi: JSON.stringify({ name: '起点', lat: 49.4, lng: 119.9 }), images: null, pending: 0,
  })
  items.itemRows.set('item-b', {
    id: 'item-b', trip_id: tripId, day_id: 'day-1', item_order: 1, type: 'attraction', title: '终点', note: '',
    poi: JSON.stringify({ name: '终点', lat: 49.5, lng: 120 }), images: null, pending: 0,
  })
  const response = await app.request(`/api/trips/${tripId}/legs/refresh`, { method: 'POST' })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { legs: Array<{ distanceKm: number; durationMin: number }> }
  assert.deepEqual(body.legs.map((leg) => [leg.distanceKm, leg.durationMin]), [[8.2, 12]])
})

test('stay references reuse search_poi and the planner exposes all route tools', async () => {
  const calls: unknown[] = []
  const stayTool = createSearchStayReferenceTool(async (input) => {
    calls.push(input)
    return [poi]
  })
  assert.ok(stayTool.execute)
  const stayResult = (await stayTool.execute(
    { query: '', region: '室韦' },
    {} as Parameters<NonNullable<typeof stayTool.execute>>[1],
  )) as { ok: boolean; stays: RecommendationPoi[] }
  assert.equal(stayResult.ok, true)
  assert.deepEqual(calls, [{ query: '酒店', region: '室韦', type: 'stay' }])
  if (stayResult.ok) assert.equal(stayResult.stays[0]?.name, poi.name)

  const tools = await createMastra({ searchPoi: async () => [], routeLegs: async () => pendingRoute('test') })
    .getAgent('planner')
    .listTools()
  assert.deepEqual(Object.keys(tools).sort(), [
    'apply_trip_patch',
    'create_trip_proposal',
    'emit_round_meta',
    'read_trip_snapshot',
    'route_legs',
    'search_poi',
    'search_stay_reference',
  ])
})
