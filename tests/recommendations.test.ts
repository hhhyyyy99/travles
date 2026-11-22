import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchRecommendations,
  filterRecommendations,
  recommendationCardInput,
  recommendationFilterCounts,
  recommendationMatchesItem,
  recommendationTypeLabel,
  searchRecommendations,
  stashCardInput,
  type RecommendationPoi,
  type StashItem,
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

test('the client keeps explicit text stash content and drops missing or malformed POIs', async () => {
  const text = {
    id: 'text', poi: null, title: '  看日落  ', note: '', category: '  随意  ',
    origin: 'recommend', addedAt: 'old-date', createdAt: 'new-date', tripId: 'trip-text',
  }
  const result = await fetchRecommendations('trip-text', async () => new Response(JSON.stringify({
    stash: [
      text,
      { ...text, id: 'spaces', note: '  ' },
      { ...text, id: 'missing-poi', poi: undefined },
      { ...text, id: 'corrupt-poi', poi: {} },
      { ...text, id: 'missing-title', title: undefined },
      { ...text, id: 'blank-title', title: '  ' },
      { ...text, id: 'legacy-poi', poi: pois[0], title: undefined, category: undefined, note: undefined, createdAt: undefined, tripId: undefined },
    ],
  })))
  assert.ok(result.ok)
  assert.deepEqual(result.data.stash.map((item) => item.id), ['text', 'spaces', 'legacy-poi'])
  assert.deepEqual(result.data.stash[0], text)
  assert.equal(result.data.stash[1]!.note, '  ')
  for (const field of ['title', 'category', 'note', 'createdAt', 'tripId']) {
    assert.equal(field in result.data.stash[2]!, false, `client must not fabricate ${field} for old HTTP payloads`)
  }
})

test('manual stash card conversion keeps authored content and preserves legacy POI defaults', () => {
  const legacy: StashItem = { id: 'old', poi: { ...pois[0]!, address: '原地址' }, origin: 'recommend', addedAt: '' }
  assert.deepEqual(stashCardInput(legacy, 'day-1', 2), recommendationCardInput(legacy.poi!, 'day-1', 2))
  const authored = stashCardInput({ ...legacy, title: '自拟标题', note: '', category: '自由分类' }, 'day-1')
  assert.equal(authored.title, '自拟标题')
  assert.equal(authored.note, '')
  assert.equal(authored.type, 'attraction')
  assert.equal(authored.poi?.name, pois[0]!.name)
  assert.deepEqual(stashCardInput({
    id: 'text', poi: null, title: '  晚上闲逛  ', note: '  ', category: '餐饮', origin: 'recommend', addedAt: '',
  }, 'day-2', 0), {
    dayId: 'day-2', index: 0, title: '  晚上闲逛  ', type: 'other', note: '  ', poi: null, images: [],
  })
})
