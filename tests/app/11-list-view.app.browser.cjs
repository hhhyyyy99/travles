// Ticket 10 — center-column canvas/list dual view + day management.
// Runs against the real Vite app with the trips/canvas/day-admin APIs mocked
// at the route level (Playwright directly, no @playwright/test), asserting:
// the view toggle with per-trip memory, list-view date tabs + single-day
// timeline (stay rows, leg rows, cards), inline theme editing, and day
// add/delete behind a confirm dialog that names the removed cards.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-list-view-1'

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

const COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="%233f7d5c"/></svg>'
const COVER_URI = `data:image/svg+xml;utf8,${COVER_SVG}`

function freshHarness() {
  // Server-side state the mocks mutate, so a reload re-reads the mutated data
  // the way the real round-trip would. Fresh per test (one browser each).
  return {
    calls: { createDay: [], patchDay: [], deleteDay: [] },
    state: {
      days: [
        {
          id: 'day-1',
          index: 0,
          date: '2026-10-02',
          theme: '抵达海拉尔',
          color: '#c26d4f',
          items: [
            { id: 'item-stay', dayId: 'day-1', order: 0, type: 'stay', title: '海拉尔全季酒店', note: '15:00 后入住', poi: { amapId: 'B1', name: '全季酒店（成吉思汗广场店）', lat: 49.2, lng: 119.7, category: '住宿', rating: 4.8, introSummary: '' }, images: [{ url: COVER_URI, caption: '' }], pending: false },
            { id: 'item-drive', dayId: 'day-1', order: 1, type: 'traffic', title: '自驾前往莫尔格勒河', note: '', poi: null, images: [], pending: false },
            { id: 'item-view', dayId: 'day-1', order: 2, type: 'attraction', title: '莫尔格勒河景区', note: '提前 2 天小程序预约限流', poi: { amapId: 'B2', name: '莫尔格勒河景区', lat: 49.4, lng: 119.8, category: '景点', rating: 4.7, introSummary: '' }, images: [], pending: false },
          ],
        },
        {
          id: 'day-2',
          index: 1,
          date: '2026-10-03',
          theme: '穿越草原',
          color: '#3f7d5c',
          items: [
            { id: 'item-free', dayId: 'day-2', order: 0, type: 'other', title: '草原自由活动', note: '信号弱，备现金', poi: null, images: [], pending: false },
          ],
        },
      ],
      legs: [
        { id: 'leg-1', fromItemId: 'item-stay', toItemId: 'item-drive', mode: 'drive', distanceKm: 30.3, durationMin: 31 },
        { id: 'leg-2', fromItemId: 'item-drive', toItemId: 'item-view', mode: 'drive', distanceKm: 45, durationMin: 52 },
      ],
    },
  }
}

function nextDateAfter(days) {
  let max = null
  for (const day of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.date || '') && (max === null || day.date > max)) max = day.date
  }
  if (max === null) return ''
  const next = new Date(Date.parse(`${max}T00:00:00Z`) + 24 * 60 * 60 * 1000)
  return next.toISOString().slice(0, 10)
}

function jsonResponse(route, status, body) {
  return route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

/** Stateful mocks: canvas reads + the three day-admin writes (ticket 10). */
async function mockWorkbenchApi(harness, { page }) {
  const { state, calls } = harness
  await page.route('**/api/trips', (route) => jsonResponse(route, 200, { trips: [tripPayload] }))
  await page.route('**/api/trips/*/canvas', (route) => {
    const tripId = new URL(route.request().url()).pathname.split('/')[3]
    if (tripId !== TRIP_ID) return jsonResponse(route, 404, { error: '行程不存在' })
    return jsonResponse(route, 200, { trip: tripPayload, days: state.days, legs: state.legs })
  })
  await page.route('**/api/trips/*/days', async (route) => {
    const request = route.request()
    if (request.method() !== 'POST') return route.fallback()
    const tripId = new URL(request.url()).pathname.split('/')[3]
    if (tripId !== TRIP_ID) return jsonResponse(route, 404, { error: '行程不存在' })
    const body = request.postDataJSON() || {}
    const day = {
      id: `day-${state.days.length + 1}`,
      index: state.days.length,
      date: body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : nextDateAfter(state.days),
      theme: typeof body.theme === 'string' ? body.theme : '',
      color: '',
      items: [],
    }
    state.days.push(day)
    calls.createDay.push(body)
    return jsonResponse(route, 201, { day })
  })
  await page.route('**/api/trips/*/days/*', async (route) => {
    const request = route.request()
    // ['', 'api', 'trips', :tripId, 'days', :dayId]
    const segments = new URL(request.url()).pathname.split('/')
    const tripId = segments[3]
    const dayId = segments[5]
    if (tripId !== TRIP_ID) return jsonResponse(route, 404, { error: '行程不存在' })
    const day = state.days.find((entry) => entry.id === dayId)
    if (!day) return jsonResponse(route, 404, { error: '日程不存在' })
    if (request.method() === 'PATCH') {
      const body = request.postDataJSON() || {}
      if (typeof body.theme === 'string') day.theme = body.theme
      if (typeof body.color === 'string') day.color = body.color
      calls.patchDay.push({ dayId, body })
      return jsonResponse(route, 200, { day: { ...day, items: [] } })
    }
    if (request.method() === 'DELETE') {
      const removedItemIds = new Set(day.items.map((item) => item.id))
      state.legs = state.legs.filter((leg) => !removedItemIds.has(leg.fromItemId) && !removedItemIds.has(leg.toItemId))
      state.days = state.days.filter((entry) => entry.id !== dayId)
      calls.deleteDay.push(dayId)
      return jsonResponse(route, 200, { ok: true, removedItems: removedItemIds.size })
    }
    return route.fallback()
  })
}

function openWorkbench() {
  const harness = freshHarness()
  return openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: (options) => mockWorkbenchApi(harness, options) }).then(
    (opened) => ({ ...opened, calls: harness.calls }),
  )
}

test('canvas/list toggle renders the single-day timeline and the choice survives a reload', async () => {
  const { page, close, calls } = await openWorkbench()
  try {
    await page.locator('#workbench-topbar').waitFor()

    // Default view is the canvas; the list view is not mounted.
    assert.ok(await page.locator('#workbench-canvas').isVisible())
    assert.equal(await page.locator('#workbench-list').count(), 0)
    assert.equal(await page.locator('[data-action="view-canvas"]').getAttribute('aria-pressed'), 'true')

    // Switch to the list view — same server data, single-day timeline.
    await page.locator('[data-action="view-list"]').click()
    await page.locator('#workbench-list').waitFor()
    assert.equal(await page.locator('#workbench-canvas').count(), 0)

    // Date tabs across the top: one per day.
    const tabs = page.locator('[data-list-tab]')
    assert.equal(await tabs.count(), 2)
    assert.ok((await tabs.nth(0).textContent()).includes('10.02'))
    assert.ok((await tabs.nth(0).textContent()).includes('周五'))
    assert.ok((await tabs.nth(1).textContent()).includes('10.03'))
    assert.equal(await page.locator('[data-list-tab="day-1"]').getAttribute('aria-selected'), 'true')

    // The first day renders as a vertical timeline: stay row, leg rows, cards.
    const day1 = page.locator('[data-list-day="day-1"]')
    await day1.waitFor()
    assert.ok((await day1.textContent()).includes('抵达海拉尔'))
    assert.ok((await day1.textContent()).includes('D1'))
    const stay = page.locator('[data-list-stay="item-stay"]')
    assert.ok((await stay.textContent()).includes('海拉尔全季酒店'))
    assert.ok((await stay.textContent()).includes('15:00 后入住'))
    const legs = page.locator('[data-list-leg]')
    assert.equal(await legs.count(), 2)
    assert.match(await legs.nth(0).textContent(), /30\.3 千米 · 31 分钟/)
    assert.match(await legs.nth(1).textContent(), /45 千米 · 52 分钟/)
    assert.equal(await page.locator('[data-list-day="day-1"] [data-card-type="traffic"]').count(), 1)
    assert.equal(await page.locator('[data-list-day="day-1"] [data-card-type="attraction"]').count(), 1)

    // Tab switching shows the other day's timeline only.
    await page.locator('[data-list-tab="day-2"]').click()
    assert.equal(await page.locator('[data-list-day="day-2"]').count(), 1)
    assert.ok((await page.locator('[data-list-day="day-2"]').textContent()).includes('草原自由活动'))
    assert.equal(await page.locator('[data-list-day="day-1"]').count(), 0)

    // The view choice is remembered per trip across a reload.
    await page.reload()
    await page.locator('#workbench-list').waitFor()
    assert.equal(await page.locator('#workbench-canvas').count(), 0)

    // And back to the canvas.
    await page.locator('[data-action="view-canvas"]').click()
    await page.locator('#workbench-canvas').waitFor()
    assert.equal(await page.locator('#workbench-list').count(), 0)
    assert.equal(await page.locator('[data-canvas-day]').count(), 2)
  } finally {
    await close()
  }
})

test('the day theme is editable inline from the list view and persists', async () => {
  const { page, close, calls } = await openWorkbench()
  try {
    await page.locator('#workbench-topbar').waitFor()
    await page.locator('[data-action="view-list"]').click()
    await page.locator('[data-list-day="day-1"]').waitFor()

    await page.locator('[data-list-day="day-1"] [data-action="edit-theme"]').click()
    const input = page.locator('[data-input="theme-edit"]')
    await input.waitFor()
    await input.fill('海拉尔集结日')
    await page.locator('[data-action="save-theme"]').click()

    // The optimistic update re-renders the header with the new theme.
    await page.locator('[data-list-day="day-1"]').getByText('海拉尔集结日').waitFor()
    assert.equal(calls.patchDay.length, 1)
    assert.deepEqual(calls.patchDay[0], { dayId: 'day-1', body: { theme: '海拉尔集结日' } })

    // The write went through the mock, so a reload shows the new theme.
    await page.reload()
    await page.locator('[data-list-day="day-1"]').waitFor()
    assert.ok((await page.locator('[data-list-day="day-1"]').textContent()).includes('海拉尔集结日'))

    // Cancel keeps the old theme.
    await page.locator('[data-list-day="day-1"] [data-action="edit-theme"]').click()
    await page.locator('[data-input="theme-edit"]').fill('不该保存的主题')
    await page.locator('[data-action="cancel-theme"]').click()
    assert.equal(await page.locator('[data-input="theme-edit"]').count(), 0)
    assert.ok((await page.locator('[data-list-day="day-1"]').textContent()).includes('海拉尔集结日'))
    assert.equal(calls.patchDay.length, 1, 'cancel never hits the API')
  } finally {
    await close()
  }
})

test('adding a day appends the next date, selects it, and shows up on the canvas', async () => {
  const { page, close, calls } = await openWorkbench()
  try {
    await page.locator('#workbench-topbar').waitFor()
    await page.locator('[data-action="view-list"]').click()
    await page.locator('#workbench-list').waitFor()

    await page.locator('#workbench-list-tabs [data-action="add-day"]').click()
    const newTab = page.locator('[data-list-tab="day-3"]')
    await newTab.waitFor()
    assert.ok((await newTab.textContent()).includes('10.04'), 'the new day lands on the next calendar day')
    assert.equal(await newTab.getAttribute('aria-selected'), 'true', 'the new day is selected right away')
    await page.locator('[data-list-day="day-3"]').waitFor()
    assert.ok((await page.locator('[data-list-day="day-3"]').textContent()).includes('这一天还没有安排'))
    assert.equal(calls.createDay.length, 1)

    // The canvas renders the same (now three-day) server data.
    await page.locator('[data-action="view-canvas"]').click()
    await page.locator('#workbench-canvas').waitFor()
    assert.equal(await page.locator('[data-canvas-day]').count(), 3)
  } finally {
    await close()
  }
})

test('deleting a day asks for confirmation (naming the cards) and then removes it', async () => {
  const { page, close, calls } = await openWorkbench()
  try {
    await page.locator('#workbench-topbar').waitFor()
    assert.equal(await page.locator('[data-canvas-day]').count(), 2)

    // Delete asks first; the confirm text states the cards go with the day.
    await page.locator('[data-canvas-day="day-1"] [data-action="delete-day"]').click()
    const dialog = page.locator('[data-confirm-dialog]')
    await dialog.waitFor()
    assert.ok((await dialog.textContent()).includes('一并删除'))
    assert.ok((await dialog.textContent()).includes('3 张卡片'))

    // Cancel keeps everything.
    await page.locator('[data-action="cancel-delete"]').click()
    assert.equal(await page.locator('[data-confirm-dialog]').count(), 0)
    assert.equal(await page.locator('[data-canvas-day="day-1"]').count(), 1)
    assert.equal(calls.deleteDay.length, 0)

    // Confirm deletes: the day, its cards and its legs all disappear.
    await page.locator('[data-canvas-day="day-1"] [data-action="delete-day"]').click()
    await page.locator('[data-action="confirm-delete"]').click()
    assert.equal(await page.locator('[data-confirm-dialog]').count(), 0)
    assert.equal(await page.locator('[data-canvas-day]').count(), 1)
    assert.equal(await page.locator('[data-canvas-day="day-2"]').count(), 1)
    assert.equal(calls.deleteDay.length, 1)

    // The list view tabs reflect the same server state.
    await page.locator('[data-action="view-list"]').click()
    await page.locator('#workbench-list').waitFor()
    assert.equal(await page.locator('[data-list-tab]').count(), 1)
    assert.equal(await page.locator('[data-list-tab="day-2"]').getAttribute('aria-selected'), 'true')
  } finally {
    await close()
  }
})
