// Ticket 05 — workbench map panel + canvas linkage.
// Runs against the real Vite app with the trips/canvas API mocked at the
// route level (Playwright directly, no @playwright/test); external tiles are
// aborted by the helper (real Leaflet runs, the tile-error banner is expected).
// Asserts: per-day colored routes + hover mileage labels, POI sequence
// markers with zoom-dependent collision hiding, canvas card click → map
// focus + detail card (carousel/favorite/link), marker click → canvas
// scroll + highlight, and the 总览/按日 view dropdown + map controls.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-map-1'

const COVER_1 = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="%23c26d4f"/></svg>'
const COVER_2 = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="%233f7d5c"/></svg>'
const uri = (svg) => `data:image/svg+xml;utf8,${svg}`

const tripPayload = {
  id: TRIP_ID,
  title: '地图联动示例行程',
  startDate: '2026-10-02',
  endDate: '2026-10-03',
  days: 2,
  nights: 1,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

// item-pair-1/-2 sit ~3 km apart: hidden by collision at overview zoom,
// revealed after zooming in (unit tests pin the pure math).
const canvasPayload = {
  trip: tripPayload,
  days: [
    {
      id: 'day-1',
      index: 0,
      date: '2026-10-02',
      theme: '抵达海拉尔',
      color: '#c26d4f',
      items: [
        {
          id: 'item-stay',
          dayId: 'day-1',
          order: 0,
          type: 'stay',
          title: '海拉尔全季酒店',
          note: '',
          poi: { amapId: 'B1', name: '全季酒店（成吉思汗广场店）', lat: 49.2, lng: 119.7, category: '住宿', rating: 4.8, introSummary: '市中心酒店，步行可达成吉思汗广场。' },
          images: [{ url: uri(COVER_1), caption: '外观' }, { url: uri(COVER_2), caption: '房间' }],
          pending: false,
        },
        {
          id: 'item-drive',
          dayId: 'day-1',
          order: 1,
          type: 'traffic',
          title: '自驾前往莫尔格勒河',
          note: '',
          poi: null,
          images: [],
          pending: false,
        },
        {
          id: 'item-view',
          dayId: 'day-1',
          order: 2,
          type: 'attraction',
          title: '莫尔格勒河景区',
          note: '',
          poi: { amapId: 'B2', name: '莫尔格勒河景区', lat: 49.42, lng: 119.85, category: '景点', rating: 4.7, introSummary: '天下第一曲水，适合傍晚拍日落。' },
          images: [],
          pending: false,
        },
      ],
    },
    {
      id: 'day-2',
      index: 1,
      date: '2026-10-03',
      theme: '穿越草原',
      color: '#3f7d5c',
      items: [
        {
          id: 'item-free',
          dayId: 'day-2',
          order: 0,
          type: 'other',
          title: '草原自由活动',
          note: '',
          poi: null,
          images: [],
          pending: false,
        },
        {
          id: 'item-pair-1',
          dayId: 'day-2',
          order: 1,
          type: 'attraction',
          title: '呼伦湖东岸',
          note: '',
          poi: { amapId: 'B3', name: '呼伦湖东岸观景点', lat: 50.0, lng: 120.0, category: '景点', rating: 4.5, introSummary: '' },
          images: [],
          pending: false,
        },
        {
          id: 'item-pair-2',
          dayId: 'day-2',
          order: 2,
          type: 'attraction',
          title: '呼伦湖观鸟台',
          note: '',
          poi: { amapId: 'B4', name: '呼伦湖观鸟台', lat: 50.03, lng: 120.03, category: '景点', rating: 4.4, introSummary: '' },
          images: [],
          pending: false,
        },
      ],
    },
  ],
  legs: [
    {
      id: 'leg-1', fromItemId: 'item-stay', toItemId: 'item-drive', mode: 'drive', distanceKm: 30.3, durationMin: 31,
      polyline: [[119.7, 49.2], [119.75, 49.28], [119.8, 49.32]],
    },
    {
      id: 'leg-2', fromItemId: 'item-drive', toItemId: 'item-view', mode: 'drive', distanceKm: 45, durationMin: 52,
      polyline: [[119.8, 49.32], [119.83, 49.4], [119.85, 49.42]],
    },
    {
      id: 'leg-3', fromItemId: 'item-pair-1', toItemId: 'item-pair-2', mode: 'drive', distanceKm: 4.2, durationMin: 8,
      polyline: [[120.0, 50.0], [120.03, 50.03]],
    },
  ],
}

/** Mocks the trips list + the canvas API; unknown trips 404. */
async function mockWorkbenchApi({ page }) {
  await page.route('**/api/trips', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ trips: [tripPayload] }), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/canvas', (route) => {
    const url = new URL(route.request().url())
    const tripId = url.pathname.split('/')[3]
    if (tripId !== TRIP_ID) {
      return route.fulfill({ status: 404, body: JSON.stringify({ error: '行程不存在' }), headers: { 'content-type': 'application/json' } })
    }
    return route.fulfill({ status: 200, body: JSON.stringify(canvasPayload), headers: { 'content-type': 'application/json' } })
  })
}

async function openWorkbench() {
  return openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: mockWorkbenchApi })
}

test('the map panel renders per-day colored routes and shows the day mileage label on route hover', async () => {
  const { page, close } = await openWorkbench()
  try {
    await page.locator('#workbench-map').waitFor()
    // One colored polyline per continuous day path (day 1 joins both legs
    // across the traffic card; day 2's free card splits its pair off).
    await page.locator('path.wb-route-day-1').first().waitFor()
    assert.equal(await page.locator('path.wb-route-day-1').count(), 1)
    assert.equal(await page.locator('path.wb-route-day-2').count(), 1)

    // Hover a day-1 route → floating mileage label "10.02 周五 75km" (30.3+45).
    await page.evaluate(() => {
      document.querySelector('path.wb-route-day-1')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const label = page.locator('.wb-mileage-label')
    await label.waitFor()
    assert.match(await label.textContent(), /10\.02 周五 75km/)
    assert.equal(await label.getAttribute('data-mileage-day'), 'day-1')
    const color = await label.evaluate((el) => getComputedStyle(el).backgroundColor)
    assert.equal(color, 'rgb(194, 109, 79)', 'label color matches the canvas day accent')

    // Leaving the route hides the label again.
    await page.evaluate(() => {
      document.querySelector('path.wb-route-day-1')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    await page.locator('.wb-mileage-label').waitFor({ state: 'detached' })
  } finally {
    await close()
  }
})

test('clicking a canvas card focuses the POI, opens the detail card, and closing returns to overview', async () => {
  const { page, close } = await openWorkbench()
  try {
    await page.locator('#workbench-map').waitFor()
    await page.locator('path.wb-route-day-1').first().waitFor()
    assert.equal(await page.locator('#workbench-map-view-toggle').textContent(), '总览 ▾')

    await page.locator('[data-canvas-card="item-view"]').click()

    const detail = page.locator('#workbench-poi-detail')
    await detail.waitFor()
    assert.equal(await page.locator('[data-poi-detail="item-view"]').count(), 1)
    assert.equal(await page.locator('[data-poi-detail-name]').textContent(), '莫尔格勒河景区')
    assert.match(await page.locator('[data-poi-detail-rating]').textContent(), /4\.7/)
    assert.equal(await page.locator('[data-poi-detail-category]').textContent(), '景点')
    assert.equal(await page.locator('[data-poi-detail-intro]').textContent(), '天下第一曲水，适合傍晚拍日落。')
    // 了解更多 → AMap search deep link via the navigationUrl service.
    const href = await page.locator('[data-poi-detail-link]').getAttribute('href')
    assert.ok(href.startsWith('https://uri.amap.com/search?keyword='), `unexpected link ${href}`)
    assert.equal(await page.getAttribute('#workbench-column-map [data-map-mode]', 'data-map-mode'), 'focus')

    // Favorite is a local stub toggle for now (real favorites = ticket 15).
    const favorite = page.locator('[data-action="poi-favorite"]')
    assert.equal(await favorite.getAttribute('aria-pressed'), 'false')
    await favorite.click()
    assert.equal(await favorite.getAttribute('aria-pressed'), 'true')
    assert.match(await favorite.textContent(), /已收藏/)

    // Close → the detail card is gone and the panel is back in overview mode.
    await page.locator('[data-action="poi-detail-close"]').click()
    await detail.waitFor({ state: 'detached' })
    assert.equal(await page.getAttribute('#workbench-column-map [data-map-mode]', 'data-map-mode'), 'overview')
  } finally {
    await close()
  }
})

test('the detail card carries an image carousel with paging', async () => {
  const { page, close } = await openWorkbench()
  try {
    await page.locator('#workbench-map').waitFor()
    await page.locator('path.wb-route-day-1').first().waitFor()
    await page.locator('[data-canvas-card="item-stay"]').click()
    await page.locator('#workbench-poi-detail').waitFor()

    assert.equal(await page.locator('[data-poi-detail-name]').textContent(), '全季酒店（成吉思汗广场店）')
    assert.equal(await page.locator('[data-poi-carousel-counter]').textContent(), '1/2')
    await page.locator('[data-action="carousel-next"]').click()
    assert.equal(await page.locator('[data-poi-carousel-counter]').textContent(), '2/2')
    await page.locator('[data-action="carousel-prev"]').click()
    assert.equal(await page.locator('[data-poi-carousel-counter]').textContent(), '1/2')
  } finally {
    await close()
  }
})

test('clicking a map marker highlights the canvas card, scrolls to its day, and opens the detail card', async () => {
  const { page, close } = await openWorkbench()
  try {
    await page.locator('#workbench-map').waitFor()
    await page.locator('path.wb-route-day-1').first().waitFor()

    // POI sequence markers per day, day-1 order: stay=1, view=2.
    assert.equal(await page.locator('[data-poi-marker="item-stay"]').count(), 1)
    assert.equal(await page.locator('[data-poi-marker="item-view"]').count(), 1)
    assert.equal(await page.locator('[data-poi-marker="item-view"]').textContent(), '2')

    // The canvas starts scrolled to the left; marker click must bring day 1's
    // card into view and highlight it.
    await page.locator('.wb-poi-marker [data-poi-marker]').first().waitFor({ state: 'visible' })
    await page.locator('.wb-poi-marker [data-poi-marker="item-view"]').click()

    await page.locator('#workbench-poi-detail').waitFor()
    assert.equal(await page.locator('[data-poi-detail="item-view"]').count(), 1)
    const card = page.locator('[data-canvas-card="item-view"]')
    await card.waitFor()
    assert.equal(await card.getAttribute('data-card-highlight'), 'true', 'canvas card is highlighted')

    // The highlighted card actually scrolled into the canvas viewport.
    const inView = await page.evaluate(() => {
      const canvas = document.getElementById('workbench-canvas')
      const card = document.querySelector('[data-canvas-card="item-view"]')
      if (!canvas || !card) return false
      const c = canvas.getBoundingClientRect()
      const r = card.getBoundingClientRect()
      return r.left >= c.left - 1 && r.right <= c.right + 1
    })
    assert.ok(inView, 'the highlighted card is scrolled into the canvas viewport')
  } finally {
    await close()
  }
})

test('POI markers hide by collision at overview zoom and reappear after zooming in', async () => {
  const { page, close } = await openWorkbench()
  try {
    await page.locator('#workbench-map').waitFor()
    await page.locator('path.wb-route-day-2').first().waitFor()

    // Overview: the ~3 km pair collapses — the later marker is hidden
    // (visibility:hidden, so wait on attachment rather than visibility).
    const hiddenMarker = page.locator('.wb-poi-marker.poi-marker-name--hidden-by-collision [data-poi-marker]')
    await hiddenMarker.first().waitFor({ state: 'attached' })
    const hiddenId = await hiddenMarker.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-poi-marker')))
    assert.deepEqual(hiddenId, ['item-pair-2'], 'only the second marker of the pair is hidden')
    assert.ok(await page.locator('.wb-poi-marker [data-poi-marker="item-pair-1"]').isVisible())

    // Zoom in three levels (zoomend recomputes collisions) → both visible.
    for (let i = 0; i < 3; i++) await page.locator('[data-action="map-zoom-in"]').click()
    await page.waitForFunction(() => document.querySelectorAll('.poi-marker-name--hidden-by-collision').length === 0)
    assert.ok(await page.locator('.wb-poi-marker [data-poi-marker="item-pair-2"]').isVisible())

    // The 全图总览 control re-fits (collision hiding kicks back in).
    await page.locator('[data-action="map-overview"]').click()
    await page.locator('.wb-poi-marker.poi-marker-name--hidden-by-collision').first().waitFor({ state: 'attached' })
  } finally {
    await close()
  }
})

test('the top-right view dropdown switches between 总览 and per-day views', async () => {
  const { page, close } = await openWorkbench()
  try {
    await page.locator('#workbench-map').waitFor()
    await page.locator('path.wb-route-day-1').first().waitFor()

    await page.locator('[data-action="map-view-toggle"]').click()
    const menu = page.locator('#workbench-map-view-menu')
    await menu.waitFor()
    const options = page.locator('[data-map-view-option]')
    assert.equal(await options.count(), 3, '总览 + two days')

    await page.locator('[data-map-view-option="day-2"]').click()
    await menu.waitFor({ state: 'detached' })
    assert.match(await page.locator('#workbench-map-view-toggle').textContent(), /10\.03/)

    // Back to 总览 via the dropdown and via the overview control.
    await page.locator('[data-action="map-view-toggle"]').click()
    await page.locator('[data-map-view-option="overview"]').click()
    assert.equal(await page.locator('#workbench-map-view-toggle').textContent(), '总览 ▾')

    // Zoom controls + 我的位置 stub respond without breaking the panel.
    await page.locator('[data-action="map-zoom-in"]').click()
    await page.locator('[data-action="map-zoom-out"]').click()
    await page.locator('[data-action="map-locate"]').click() // stub, must not throw
    assert.ok(await page.locator('#workbench-map').isVisible())
  } finally {
    await close()
  }
})
