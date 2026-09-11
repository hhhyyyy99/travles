import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DUPLICATE_DISTANCE_METERS, distanceMeters } from '../src/domain/geo'
import { findDuplicates } from '../src/domain/accommodation'
import { normalizePoi, searchPlaces, type AmapPlaceService, type AmapStatic } from '../src/services/amap'

// Ticket 05 — exact migration of tests/accommodation-search.test.cjs: same
// scenarios AND same edge cases, importing the TS modules (domain helpers +
// the typed AMap adapter service).

test('normalizes an AMap point to the canonical WGS-84 shape once', () => {
  const result = normalizePoi(
    {
      id: 'poi-1',
      name: '松林小院',
      address: '额尔古纳市河西',
      location: { lng: 119.8, lat: 49.2 },
    },
    (lng, lat) => [lng - 0.01, lat - 0.02],
  )

  assert.deepEqual(result, {
    id: 'poi-1',
    name: '松林小院',
    address: '额尔古纳市河西',
    type: 'hotel',
    lat: 49.18,
    lng: 119.78999999999999,
    source: 'amap',
    sourceLocation: { lat: 49.2, lng: 119.8 },
    city: '',
  })
})

test('same-name bases within the duplicate radius are candidates for reuse', () => {
  const candidate = { name: '松林小院', lat: 49.2, lng: 119.8 }
  const nearby = { id: 'custom-near', name: ' 松林小院 ', lat: 49.2005, lng: 119.8 }
  const farAway = { id: 'custom-far', name: '松林小院', lat: 49.24, lng: 119.8 }

  assert.deepEqual(
    findDuplicates(candidate, [nearby, farAway]).map((base) => base.id),
    ['custom-near'],
  )
  assert.equal(distanceMeters(candidate, farAway) > DUPLICATE_DISTANCE_METERS, true)
})

test('PlaceSearch results are normalized and no-data is surfaced without inventing a position', async () => {
  class PlaceSearch implements AmapPlaceService {
    constructor() {}
    search(query: string, callback: (status: string, result?: unknown) => void): void {
      assert.equal(query, '额尔古纳湿地')
      callback('complete', { poiList: { pois: [{ name: '额尔古纳湿地', location: { lng: 119.9, lat: 50.1 } }] } })
    }
  }
  const [result] = await searchPlaces('额尔古纳湿地', {
    AMap: { PlaceSearch } as unknown as AmapStatic,
    transform: (lng, lat) => [lng - 0.01, lat - 0.01],
  })
  assert.equal(result.name, '额尔古纳湿地')
  assert.equal(result.lat, 50.09)
  assert.equal(result.lng, 119.89)

  class EmptyPlaceSearch implements AmapPlaceService {
    search(_query: string, callback: (status: string, result?: unknown) => void): void {
      callback('no_data', {})
    }
  }
  await assert.rejects(
    searchPlaces('不存在的住宿', { AMap: { PlaceSearch: EmptyPlaceSearch } as unknown as AmapStatic }),
    (error) => (error as { code?: string }).code === 'no-results',
  )
})

test('search remains explicitly unavailable when the AMap plugin is not loaded', async () => {
  await assert.rejects(
    searchPlaces('海拉尔酒店', { AMap: {} as unknown as AmapStatic }),
    (error) => (error as { code?: string }).code === 'unavailable',
  )
})
