import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  filterRecommendations,
  recommendationCardInput,
  recommendationFilterCounts,
  recommendationMatchesItem,
  recommendationTypeLabel,
  searchRecommendations,
  type RecommendationPoi,
} from '../src/domain/recommendations'
import type { WorkbenchItem } from '../src/domain/workbench'

const pois: RecommendationPoi[] = [
  {
    id: 'a', amapId: 'a', name: '湿地', lat: 50, lng: 120, category: '景点', type: 'attraction', region: '额尔古纳', rating: 4.8, introSummary: '', address: '', images: [],
  },
  {
    id: 'b', amapId: 'b', name: '牧场餐厅', lat: 50.1, lng: 120.1, category: '餐饮', type: 'food', region: '额尔古纳', rating: 4.3, introSummary: '', address: '', images: [],
  },
  {
    id: 'c', amapId: 'c', name: '木刻楞民宿', lat: 50.2, lng: 120.2, category: '住宿', type: 'stay', region: '室韦', rating: 4.5, introSummary: '', address: '', images: [],
  },
]

test('recommendation filters and counts keep region/type semantics stable', () => {
  assert.deepEqual(filterRecommendations(pois, { region: '额尔古纳', type: 'all' }).map((poi) => poi.id), ['a', 'b'])
  assert.deepEqual(filterRecommendations(pois, { region: 'all', type: 'food' }).map((poi) => poi.id), ['b'])
  assert.deepEqual(recommendationFilterCounts(pois), { attraction: 1, food: 1, stay: 1, other: 0 })
  assert.equal(recommendationTypeLabel('attraction'), '游玩')
})

test('a recommendation becomes a normal POI card request for an existing day', () => {
  const input = recommendationCardInput(pois[0]!, 'day-2', 1)
  assert.deepEqual(input, {
    dayId: 'day-2',
    index: 1,
    title: '湿地',
    type: 'attraction',
    note: '',
    poi: { amapId: 'a', name: '湿地', lat: 50, lng: 120, category: '景点', rating: 4.8, introSummary: '' },
    images: [],
  })
})

test('recommendation search surfaces a provider error returned with HTTP 200', async () => {
  const result = await searchRecommendations('trip-1', '湿地', {}, async () =>
    new Response(JSON.stringify({ recommendations: [], error: '推荐点位暂不可用' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  assert.deepEqual(result, { ok: false, error: '推荐点位暂不可用' })
})

test('recommendation identity requires a non-empty provider id before matching', () => {
  const recommendation: RecommendationPoi = { ...pois[0]!, id: '', amapId: '' }
  const item: WorkbenchItem = {
    id: 'item-1',
    dayId: 'day-1',
    order: 0,
    type: 'attraction',
    title: '另一个点位',
    note: '',
    poi: { ...recommendation, name: '另一个点位', lat: 51, lng: 121 },
    images: [],
    pending: false,
  }
  assert.equal(recommendationMatchesItem(recommendation, item), false)
  assert.equal(recommendationMatchesItem(recommendation, { ...item, poi: recommendation }), true)
})
