import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from '../src/app.js'
import { MemoryRecommendationsStoreDriver } from '../src/recommendations/driver-memory.js'
import { RecommendationsRepository } from '../src/recommendations/repository.js'
import type { RecommendationPoi } from '../src/recommendations/types.js'
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
