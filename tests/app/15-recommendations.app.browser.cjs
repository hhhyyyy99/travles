// Ticket 15 — recommendation markers, filters, stash, favorites, and
// scheduling use the same workbench card write path.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-recommendations'
const rec = {
  id: 'poi-meadow',
  amapId: 'B-meadow',
  name: '沿途观景营地',
  lat: 49.3,
  lng: 119.8,
  category: '景点',
  type: 'attraction',
  region: '额尔古纳',
  rating: 4.6,
  introSummary: '适合看日落的草原营地。',
  address: '额尔古纳沿线',
  images: [],
}
const stashItem = { id: 'stash-meadow', poi: rec, origin: 'recommend', addedAt: '2026-09-12T00:00:00.000Z' }
const trip = {
  id: TRIP_ID,
  title: '推荐测试行程',
  startDate: '2026-10-02',
  endDate: '2026-10-03',
  days: 2,
  nights: 1,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}
const canvas = {
  trip,
  days: [
    { id: 'day-1', index: 0, date: '2026-10-02', theme: '抵达', color: '#c26d4f', items: [] },
    { id: 'day-2', index: 1, date: '2026-10-03', theme: '草原', color: '#3f7d5c', items: [] },
  ],
  legs: [],
}

function json(route, status, body) {
  return route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

async function openRecommendations() {
  let stash = [stashItem]
  let favorites = []
  return openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: async ({ page }) => {
      await page.route('**/api/trips/**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const path = url.pathname
        if (path.endsWith('/canvas')) return json(route, 200, { ...canvas, days: canvas.days.map((day) => ({ ...day, items: day.items.slice() })) })
        if (path.endsWith('/messages')) return json(route, 200, { messages: [] })
        if (path.endsWith('/recommendations/search')) return json(route, 200, { recommendations: [rec], pois: [rec] })
        if (path.endsWith('/recommendations')) return json(route, 200, { recommendations: [rec], pois: [rec], stash, favorites })
        if (path.endsWith('/stash') && request.method() === 'POST') {
          stash = [stashItem]
          return json(route, 201, { item: stashItem })
        }
        if (path.includes('/stash/') && request.method() === 'DELETE') {
          stash = []
          return json(route, 200, { ok: true })
        }
        if (path.endsWith('/favorites') && request.method() === 'POST') {
          const favorite = { id: 'favorite-meadow', poi: rec, createdAt: '2026-09-12T00:00:00.000Z' }
          favorites = [favorite]
          return json(route, 201, { favorite })
        }
        if (path.includes('/favorites/') && request.method() === 'DELETE') {
          favorites = []
          return json(route, 200, { ok: true })
        }
        if (path.endsWith('/items') && request.method() === 'POST') {
          const body = JSON.parse(request.postData() || '{}')
          return json(route, 201, {
            item: { id: 'item-meadow', dayId: body.dayId, order: 0, type: body.type || 'attraction', title: body.title, note: body.note || '', poi: body.poi, images: body.images || [], pending: false },
            legs: [],
          })
        }
        return json(route, 404, { error: '未处理请求' })
      })
    },
  })
}

test('recommendations toggle renders markers, filters, and schedules a point into a day', async () => {
  const { page, close } = await openRecommendations()
  try {
    await page.locator('#workbench-map').waitFor()
    await page.locator('[data-action="map-recommend-toggle"]').click()
    await page.locator('[data-recommendation="poi-meadow"]').waitFor()
    assert.equal(await page.locator('[data-recommendation-marker="poi-meadow"]').count(), 1)
    assert.match(await page.locator('[data-recommendation-type="attraction"]').textContent(), /游玩·1/)
    await page.locator('[data-action="recommendation-schedule"]').click()
    await page.locator('[data-canvas-card="item-meadow"]').waitFor()
    assert.equal(await page.locator('[data-canvas-card="item-meadow"]').textContent().then((text) => text.includes('沿途观景营地')), true)
  } finally {
    await close()
  }
})

test('stash panel exposes draggable items and favorite actions', async () => {
  const { page, close } = await openRecommendations()
  try {
    await page.locator('[data-action="map-stash-toggle"]').click()
    await page.locator('[data-stash-item="stash-meadow"]').waitFor()
    assert.equal(await page.locator('[data-stash-item="stash-meadow"]').getAttribute('draggable'), 'true')
    await page.locator('[data-action="map-recommend-toggle"]').click()
    await page.locator('[data-recommendation="poi-meadow"]').waitFor()
    await page.locator('[data-action="recommendation-favorite"]').click()
    assert.equal(await page.locator('[data-action="recommendation-favorite"]').getAttribute('aria-pressed'), 'true')
  } finally {
    await close()
  }
})
