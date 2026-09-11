// Ticket 04 — workbench three-column skeleton + read-only canvas.
// Runs against the real Vite app with the trips/canvas API mocked at the
// route level (Playwright directly, no @playwright/test), asserting:
// canvas rendering from server data, per-column collapse/expand with reload
// persistence, and AI-column drag-resize persistence.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const LAYOUT_KEY = 'journey-workbench-layout-v1'
const TRIP_ID = 'trip-canvas-1'

// One-time layout reset: addInitScript runs before EVERY navigation, so a
// bare removeItem would wipe the persisted layout on each reload. sessionStorage
// survives reloads within the tab, making this guard run only once.
const CLEAR_LAYOUT_INIT = `
  if (!window.sessionStorage.getItem('wb-layout-cleared')) {
    window.localStorage.removeItem('${LAYOUT_KEY}')
    window.sessionStorage.setItem('wb-layout-cleared', '1')
  }
`

// Tiny cover image as a data URI (data URIs never hit the network, so the
// catch-all "abort non-127.0.0.1" route keeps applying).
const COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="%23c26d4f"/></svg>'
const COVER_URI = `data:image/svg+xml;utf8,${COVER_SVG}`

const tripPayload = {
  id: TRIP_ID,
  title: '国庆呼伦贝尔慢环线',
  startDate: '2026-10-02',
  endDate: '2026-10-04',
  days: 3,
  nights: 2,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

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
          note: '15:00 后入住',
          poi: { amapId: 'B1', name: '全季酒店（成吉思汗广场店）', lat: 49.2, lng: 119.7, category: '住宿', rating: 4.8, introSummary: '' },
          images: [{ url: COVER_URI, caption: '' }],
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
          note: '提前 2 天小程序预约限流',
          poi: { amapId: 'B2', name: '莫尔格勒河景区', lat: 49.4, lng: 119.8, category: '景点', rating: 4.7, introSummary: '' },
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
          note: '信号弱，备现金',
          poi: null,
          images: [],
          pending: false,
        },
      ],
    },
  ],
  legs: [
    { id: 'leg-1', fromItemId: 'item-stay', toItemId: 'item-drive', mode: 'drive', distanceKm: 30.3, durationMin: 31 },
    { id: 'leg-2', fromItemId: 'item-drive', toItemId: 'item-view', mode: 'drive', distanceKm: 45, durationMin: 52 },
  ],
}

/** Mocks the trips list + the canvas API for a known trip; unknown trips 404. */
async function mockWorkbenchApi({ page }) {
  await page.route('**/api/trips', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ trips: [tripPayload] }), headers: { 'content-type': 'application/json' } }),
  )
  // Registered after the list handler: Playwright matches routes LIFO, so
  // the canvas route wins for /api/trips/:id/canvas.
  await page.route('**/api/trips/*/canvas', (route) => {
    const url = new URL(route.request().url())
    const tripId = url.pathname.split('/')[3]
    if (tripId !== TRIP_ID) {
      return route.fulfill({ status: 404, body: JSON.stringify({ error: '行程不存在' }), headers: { 'content-type': 'application/json' } })
    }
    return route.fulfill({ status: 200, body: JSON.stringify(canvasPayload), headers: { 'content-type': 'application/json' } })
  })
}

test('clicking a trip row opens the workbench and renders the canvas from server data', async () => {
  const { page, close } = await openApp({ setup: mockWorkbenchApi })
  try {
    await page.locator('#trip-list').waitFor()
    await page.locator(`li[data-trip-id="${TRIP_ID}"]`).click()

    await page.locator('#workbench-topbar').waitFor()
    assert.equal(await page.locator('#workbench-trip-title').textContent(), '国庆呼伦贝尔慢环线')
    assert.equal(await page.locator('#workbench-trip-badge').textContent(), '10.02至10.04 3天2晚')

    // Three columns present.
    assert.ok(await page.locator('#workbench-column-ai').isVisible())
    assert.ok(await page.locator('#workbench-canvas').isVisible())
    assert.ok(await page.locator('#workbench-column-map').isVisible())

    // Day columns with headers: date, weekday, theme.
    const days = page.locator('[data-canvas-day]')
    assert.equal(await days.count(), 2)
    const day1 = page.locator('[data-canvas-day="day-1"]')
    assert.ok((await day1.textContent()).includes('10.02'))
    assert.ok((await day1.textContent()).includes('周五'))
    assert.ok((await day1.textContent()).includes('抵达海拉尔'))
    assert.ok((await page.locator('[data-canvas-day="day-2"]').textContent()).includes('穿越草原'))

    // Cards: all four families render, with order numbers, notes, covers.
    const cards = page.locator('[data-canvas-card]')
    assert.equal(await cards.count(), 4)
    assert.equal(await page.locator('[data-card-type="stay"]').count(), 1)
    assert.equal(await page.locator('[data-card-type="traffic"]').count(), 1)
    assert.equal(await page.locator('[data-card-type="attraction"]').count(), 1)
    assert.equal(await page.locator('[data-card-type="other"]').count(), 1)
    const stayCard = page.locator('[data-canvas-card="item-stay"]')
    assert.ok((await stayCard.textContent()).includes('15:00 后入住'))
    assert.ok((await stayCard.textContent()).includes('全季酒店'))
    await page.locator('[data-canvas-card-cover="item-stay"]').waitFor()
    // The no-POI plain-text form has no cover and no POI line.
    const plainCard = page.locator('[data-canvas-card="item-drive"]')
    assert.equal(await plainCard.getAttribute('data-card-plain-text'), 'true')
    assert.equal(await plainCard.getAttribute('data-canvas-card-cover'), null)
    assert.equal(await plainCard.getAttribute('data-canvas-card-poi'), null)

    // Transport legs between adjacent cards: distance + duration.
    const legs = page.locator('[data-leg-chip]')
    assert.equal(await legs.count(), 2)
    assert.match(await legs.nth(0).textContent(), /30\.3 千米 · 31 分钟/)
    assert.match(await legs.nth(1).textContent(), /45 千米 · 52 分钟/)

    // Back button returns to the trip list.
    await page.locator('#workbench-back').click()
    await page.locator('#trip-list').waitFor()
    assert.equal(await page.locator('#workbench-topbar').count(), 0)
  } finally {
    await close()
  }
})

test('each column collapses/expands independently and the state survives a reload', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: CLEAR_LAYOUT_INIT,
    setup: mockWorkbenchApi,
  })
  try {
    await page.locator('#workbench-topbar').waitFor()

    // Collapse AI.
    await page.locator('[data-action="collapse-ai"]').click()
    assert.equal(await page.locator('#workbench-column-ai').count(), 0)
    assert.ok(await page.locator('#workbench-rail-ai').isVisible())

    // Collapse canvas + map too — everything is a rail now.
    await page.locator('[data-action="collapse-canvas"]').click()
    await page.locator('[data-action="collapse-map"]').click()
    assert.equal(await page.locator('#workbench-canvas').count(), 0)
    assert.equal(await page.locator('#workbench-column-map').count(), 0)
    assert.ok(await page.locator('#workbench-rail-canvas').isVisible())
    assert.ok(await page.locator('#workbench-rail-map').isVisible())

    // Reload — the collapsed state persists (per-trip localStorage).
    await page.reload()
    await page.locator('#workbench-topbar').waitFor()
    assert.ok(await page.locator('#workbench-rail-ai').isVisible())
    assert.ok(await page.locator('#workbench-rail-canvas').isVisible())
    assert.ok(await page.locator('#workbench-rail-map').isVisible())

    // Expand AI again and confirm the state persists after another reload.
    await page.locator('#workbench-rail-ai [data-action="expand"]').click()
    await page.locator('#workbench-column-ai').waitFor()
    await page.reload()
    await page.locator('#workbench-column-ai').waitFor()
    assert.ok(await page.locator('#workbench-rail-canvas').isVisible(), 'canvas stays collapsed')
  } finally {
    await close()
  }
})

test('dragging the AI handle resizes the column and the width persists', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: CLEAR_LAYOUT_INIT,
    setup: mockWorkbenchApi,
  })
  try {
    await page.locator('#workbench-column-ai').waitFor()
    const readWidth = () => page.evaluate(() => document.getElementById('workbench-column-ai')?.getBoundingClientRect().width ?? 0)
    const before = await readWidth()
    assert.ok(before > 100, `AI column should be visible with a real width, got ${before}`)

    const handle = page.locator('#workbench-ai-resize-handle')
    const box = await handle.boundingBox()
    assert.ok(box, 'resize handle rendered')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 5 })
    await page.mouse.up()

    const after = await readWidth()
    assert.ok(after >= before + 60, `expected the AI column to grow, ${before} -> ${after}`)

    // Width persists per trip across a reload.
    await page.reload()
    await page.locator('#workbench-column-ai').waitFor()
    const restored = await readWidth()
    assert.ok(Math.abs(restored - after) < 2, `expected ${after}px after reload, got ${restored}px`)
  } finally {
    await close()
  }
})

test('a canvas API failure surfaces the server error instead of a blank screen', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=trip-unknown`,
    setup: mockWorkbenchApi,
  })
  try {
    await page.locator('#workbench-load-error').waitFor()
    assert.equal(await page.locator('#workbench-load-error').textContent(), '行程不存在')
    assert.equal(await page.locator('[data-canvas-day]').count(), 0)
  } finally {
    await close()
  }
})
