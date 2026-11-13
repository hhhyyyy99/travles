import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addFavorite,
  addToStash,
  fetchRecommendations,
  searchRecommendations,
  type RecommendationPoi,
  type StashItem,
} from '../src/domain/recommendations'

// Keep legacy coercion and raw nested metadata visible while testing the new
// explicit stash fields through the public HTTP clients.
const rawPoi = {
  name: '  旧点位  ',
  lat: '91.25',
  lng: '-181.5',
  category: '  nested category  ',
  type: 'legacy-type',
  city: '旧地区',
  province: '旧省份',
  rating: '-2',
  address: '旧地址',
  images: [null, { url: '  legacy-photo  ', caption: 17 }, { url: '' }],
  title: 'nested title is not a stash field',
  createdAt: 'nested timestamp is not a stash field',
}

const normalizedPoi: RecommendationPoi = {
  id: 'poi-旧点位-91.25000--181.50000',
  amapId: '',
  name: '旧点位',
  lat: 91.25,
  lng: -181.5,
  category: '  nested category  ',
  type: 'attraction',
  region: '旧地区',
  rating: -2,
  introSummary: '',
  address: '旧地址',
  images: [{ url: '  legacy-photo  ', caption: '' }],
}

const legacyStash = {
  id: '  stash-id  ',
  poi: rawPoi,
  origin: 'favorite',
  addedAt: '  legacy-added-at  ',
}
const normalizedLegacyStash: StashItem = {
  ...legacyStash,
  poi: normalizedPoi,
  origin: 'favorite',
}
const validFields = {
  tripId: 'trip-client',
  title: '  Explicit stash title  ',
  category: '\tExplicit stash category\n',
  createdAt: '  raw non-date timestamp  ',
}
const fieldNames = ['tripId', 'title', 'category', 'createdAt'] as const

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}

const stashReaders: {
  name: string
  read: (item: unknown, tripId?: string) => Promise<StashItem>
}[] = [
  {
    name: 'fetchRecommendations',
    async read(item, tripId = 'trip-client') {
      const result = await fetchRecommendations(tripId, async (url, init) => {
        assert.equal(url, `/api/trips/${encodeURIComponent(tripId)}/recommendations`)
        assert.equal(init, undefined)
        return jsonResponse({ recommendations: [], stash: [item], favorites: [] })
      })
      assert.ok(result.ok)
      assert.equal(result.data.stash.length, 1, 'invalid optional metadata must not drop a valid stash item')
      return result.data.stash[0]!
    },
  },
  {
    name: 'addToStash',
    async read(item, tripId = 'trip-client') {
      const result = await addToStash(tripId, normalizedPoi, 'favorite', async (url, init) => {
        assert.equal(url, `/api/trips/${encodeURIComponent(tripId)}/stash`)
        assert.equal(init?.method, 'POST')
        assert.deepEqual(JSON.parse(String(init?.body)), { poi: normalizedPoi, origin: 'favorite' })
        return jsonResponse({ item })
      })
      assert.ok(result.ok)
      return result.data
    },
  },
]

for (const client of stashReaders) {
  test(`${client.name} preserves explicit raw stash fields independently of nested POI data`, async () => {
    const fields = { ...validFields, tripId: '  trip / raw?  ' }
    const item = await client.read({ ...legacyStash, ...fields }, fields.tripId)
    assert.deepEqual(item, { ...normalizedLegacyStash, ...fields })
    assert.notEqual(item.title, item.poi.name)
    assert.notEqual(item.category, item.poi.category)
  })

  test(`${client.name} preserves long stash strings without truncating or validating timestamp format`, async () => {
    const fields = {
      tripId: `  trip-${'旅'.repeat(4096)}  `,
      title: `\t${'标题'.repeat(4096)}\n`,
      category: `  ${'类别'.repeat(4096)}  `,
      createdAt: `  not-a-date-${'x'.repeat(8192)}  `,
    }
    assert.deepEqual(await client.read({ ...legacyStash, ...fields }, fields.tripId), {
      ...normalizedLegacyStash,
      ...fields,
    })
  })

  for (const field of fieldNames) {
    test(`${client.name} omits invalid ${field} without losing valid sibling fields`, async () => {
      for (const invalid of [undefined, null, '', ' \t\r\n\u00a0 ', 42, false, [], {}]) {
        const expectedFields: Partial<typeof validFields> = { ...validFields }
        delete expectedFields[field]
        assert.deepEqual(await client.read({ ...legacyStash, ...validFields, [field]: invalid }), {
          ...normalizedLegacyStash,
          ...expectedFields,
        }, `${field}=${JSON.stringify(invalid)}`)
      }
    })
  }

  test(`${client.name} leaves missing old-server stash fields absent`, async () => {
    const item = await client.read(legacyStash)
    assert.deepEqual(item, normalizedLegacyStash)
    for (const field of fieldNames) assert.equal(Object.hasOwn(item, field), false, `${field} must not be synthesized`)
  })

  test(`${client.name} drops only tripId when it conflicts with the request context`, async () => {
    const { tripId: _tripId, ...expectedFields } = validFields
    for (const tripId of ['another-trip', ' trip-client ']) {
      assert.deepEqual(await client.read({ ...legacyStash, ...validFields, tripId }), {
        ...normalizedLegacyStash,
        ...expectedFields,
      })
    }
  })

  test(`${client.name} retains legacy defaults for origin and addedAt`, async () => {
    assert.deepEqual(await client.read({ ...legacyStash, origin: 'legacy', addedAt: null, ...validFields }), {
      ...normalizedLegacyStash,
      origin: 'recommend',
      addedAt: '',
      ...validFields,
    })
  })
}

test('fetchRecommendations preserves non-stash decoding and keeps stash fields off FavoriteItem', async () => {
  const result = await fetchRecommendations('trip-client', async () => jsonResponse({
    recommendations: [rawPoi, null, { name: 'invalid POI without coordinates' }],
    stash: [null, { ...legacyStash, id: '' }, { ...legacyStash, poi: null }],
    favorites: [
      { id: 'favorite-raw', poi: rawPoi, ...validFields, createdAt: ' \t ' },
      { id: 'favorite-default', poi: rawPoi, ...validFields, createdAt: 42 },
      null,
      { id: '', poi: rawPoi },
      { id: 'broken', poi: null },
    ],
  }))
  assert.ok(result.ok)
  assert.deepEqual(result.data, {
    recommendations: [normalizedPoi],
    stash: [],
    favorites: [
      { id: 'favorite-raw', poi: normalizedPoi, createdAt: ' \t ' },
      { id: 'favorite-default', poi: normalizedPoi, createdAt: '' },
    ],
  })
})

test('addFavorite keeps its existing timestamp behavior and ignores stash-only fields', async () => {
  for (const createdAt of [' \t ', 42, undefined]) {
    const result = await addFavorite('trip-client', normalizedPoi, async (url, init) => {
      assert.equal(url, '/api/trips/trip-client/favorites')
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), { poi: normalizedPoi })
      return jsonResponse({ favorite: { id: 'favorite-client', poi: rawPoi, ...validFields, createdAt } })
    })
    assert.ok(result.ok)
    assert.deepEqual(result.data, {
      id: 'favorite-client',
      poi: normalizedPoi,
      createdAt: typeof createdAt === 'string' ? createdAt : '',
    })
  }
})

test('searchRecommendations keeps its existing tolerant POI normalization', async () => {
  const result = await searchRecommendations('trip-client', '旧点位', {}, async () => jsonResponse({
    recommendations: [rawPoi, null, { name: 'invalid POI without coordinates' }],
  }))
  assert.deepEqual(result, { ok: true, data: [normalizedPoi] })
})
