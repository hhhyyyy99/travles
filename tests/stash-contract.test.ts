import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FavoriteItemSchema,
  RecommendationOriginSchema,
  RecommendationPoiSchema,
  RecommendationTypeSchema,
  RecommendationsApiSnapshotSchema,
  RecommendationsSnapshotSchema,
  StashItemSchema,
} from '@hailar/domain'
import { MemoryRecommendationsStoreDriver } from '../server/src/recommendations/driver-memory.js'
import { RecommendationsRepository } from '../server/src/recommendations/repository.js'
import { fetchRecommendations } from '../src/domain/recommendations'

// Deliberately use a provider ID, a relative image path, and an empty caption:
// the existing read model does not require UUIDs or absolute image URLs.
const poi = {
  id: 'B-river',
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
  images: [{ url: '/images/river.jpg', caption: '' }],
}

test('stash and favorite schemas parse actual repository writes and decoded storage rows unchanged', async () => {
  const driver = new MemoryRecommendationsStoreDriver()
  const repository = new RecommendationsRepository(driver)
  const stash = await repository.addStash('trip-contract', poi)
  const favorite = await repository.addFavorite('trip-contract', { ...poi, id: 'B-stay', amapId: 'B-stay', type: 'stay' })
  assert.ok(stash.ok)
  assert.ok(favorite.ok)
  assert.deepEqual(StashItemSchema.parse(stash.value), stash.value)
  assert.deepEqual(FavoriteItemSchema.parse(favorite.value), favorite.value)

  const snapshot = await repository.snapshot('trip-contract')
  assert.deepEqual(RecommendationsSnapshotSchema.parse(snapshot), snapshot)
  assert.deepEqual(snapshot.stash.map((item) => item.origin), ['recommend', 'favorite'])
  assert.equal(snapshot.favorites.length, 1)

  const [stored] = await driver.listStashRows('trip-contract')
  assert.ok(stored)
  assert.equal(typeof stored.poi, 'string', 'the driver still persists an opaque JSON string')
  assert.equal(stored.added_at, stash.value.addedAt, 'SQLite column names remain at the storage boundary')
  assert.equal(StashItemSchema.safeParse(stored).success, false, 'schemas describe decoded read models, not database rows')
})

test('legacy repository output accepts finite coordinates, empty metadata and timestamps without imposing new restrictions', async () => {
  const driver = new MemoryRecommendationsStoreDriver()
  const legacyPoi = {
    name: '  旧收藏  ',
    lat: '91.25',
    lng: '-181.5',
    city: '旧地区',
    type: 'historic-category',
    rating: '-2',
    address: '旧地址',
    images: [null, { url: '  legacy-photo  ' }, { url: '' }],
  }
  driver.stashRows.set('legacy-stash', {
    id: 'legacy-stash', trip_id: 'trip-legacy', poi: JSON.stringify(legacyPoi), origin: 'old-origin', added_at: null,
  })
  driver.favoriteRows.set('legacy-favorite', {
    id: 'legacy-favorite', trip_id: 'trip-legacy', poi: JSON.stringify(legacyPoi), created_at: '  legacy-date  ',
  })
  driver.stashRows.set('corrupt', {
    id: 'corrupt', trip_id: 'trip-legacy', poi: '{invalid-json', origin: 'recommend', added_at: '',
  })
  driver.favoriteRows.set('invalid-poi', {
    id: 'invalid-poi', trip_id: 'trip-legacy', poi: JSON.stringify({ name: '缺少经纬度' }), created_at: '',
  })

  const snapshot = await new RecommendationsRepository(driver).snapshot('trip-legacy')
  const expectedPoi = {
    id: 'poi-旧收藏-91.25000--181.50000',
    amapId: '',
    name: '旧收藏',
    lat: 91.25,
    lng: -181.5,
    category: '',
    type: 'attraction',
    region: '旧地区',
    rating: -2,
    introSummary: '旧地址',
    address: '旧地址',
    images: [{ url: 'legacy-photo', caption: '' }],
  }
  assert.deepEqual(snapshot, {
    stash: [{ id: 'legacy-stash', poi: expectedPoi, origin: 'recommend', addedAt: '', tripId: 'trip-legacy', title: '  旧收藏  ' }],
    favorites: [{ id: 'legacy-favorite', poi: expectedPoi, createdAt: 'legacy-date' }],
  })
  assert.deepEqual(RecommendationPoiSchema.parse(snapshot.stash[0]!.poi), expectedPoi)
  assert.deepEqual(RecommendationsSnapshotSchema.parse(snapshot), snapshot)
})

test('frontend snapshot derived from real repository output parses without changing the public payload shape', async () => {
  const repository = new RecommendationsRepository(new MemoryRecommendationsStoreDriver())
  const favorite = await repository.addFavorite('trip-client', poi)
  assert.ok(favorite.ok)
  const snapshot = await repository.snapshot('trip-client')
  const payload = { ...snapshot, recommendations: [favorite.value.poi] }
  const response = await fetchRecommendations('trip-client', async () => new Response(JSON.stringify({
    ...payload,
    pois: payload.recommendations, // Existing server alias is still tolerated by the client.
  }), { headers: { 'content-type': 'application/json' } }))
  assert.ok(response.ok)
  assert.deepEqual(response.data, payload)
  assert.deepEqual(RecommendationsApiSnapshotSchema.parse(response.data), response.data)
  assert.deepEqual(RecommendationsSnapshotSchema.parse(snapshot), snapshot)
  assert.equal(RecommendationsApiSnapshotSchema.safeParse(snapshot).success, false, 'the API read model requires its recommendations list')
})

test('frontend tolerant decoding still produces contract values from incomplete legacy HTTP entries', async () => {
  const legacyPoi = {
    name: '旧点位', lat: '92', lng: '182', city: '旧地区', type: 'legacy',
    images: [{ url: 'relative-photo' }, null],
  }
  const response = await fetchRecommendations('trip-client', async () => new Response(JSON.stringify({
    recommendations: [legacyPoi, null],
    stash: [{ id: 'old-stash', poi: legacyPoi, origin: 'legacy' }, { id: 'broken', poi: null }],
    favorites: [{ id: 'old-favorite', poi: legacyPoi }],
  })))
  assert.ok(response.ok)
  assert.deepEqual(RecommendationsApiSnapshotSchema.parse(response.data), response.data)
  assert.equal(response.data.recommendations.length, 1)
  assert.equal(response.data.stash.length, 1)
  assert.equal(response.data.stash[0]!.origin, 'recommend')
  assert.equal(response.data.stash[0]!.addedAt, '')
  assert.equal(response.data.favorites[0]!.createdAt, '')
  assert.deepEqual(response.data.recommendations[0]!.images, [{ url: 'relative-photo', caption: '' }])
})

test('recommendation contracts reject malformed decoded values rather than coercing raw inputs', () => {
  for (const type of ['attraction', 'food', 'stay', 'other']) {
    assert.equal(RecommendationTypeSchema.safeParse(type).success, true)
    assert.equal(RecommendationPoiSchema.safeParse({ ...poi, type }).success, true)
  }
  for (const origin of ['recommend', 'favorite']) {
    assert.equal(RecommendationOriginSchema.safeParse(origin).success, true)
  }
  for (const invalid of [
    { ...poi, lat: '49.42' },
    { ...poi, lat: Number.NaN },
    { ...poi, lng: Number.POSITIVE_INFINITY },
    { ...poi, rating: null },
    { ...poi, type: 'accommodation' },
    { ...poi, images: [{ url: '/photo.jpg' }] },
  ]) {
    assert.equal(RecommendationPoiSchema.safeParse(invalid).success, false)
  }
  assert.equal(StashItemSchema.safeParse({ id: 's', poi, origin: 'legacy', addedAt: '' }).success, false)
  assert.equal(FavoriteItemSchema.safeParse({ id: 'f', poi }).success, false)
  assert.equal(RecommendationsSnapshotSchema.safeParse({ stash: [], favorites: null }).success, false)
})
