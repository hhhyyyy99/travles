// Ticket 09 — card editing: drag reorder, card "⋯" menu (move/copy/delete),
// add free-text card, inline note edit, and optimistic rollback on API
// failure. Runs against the real Vite app with the workbench API mocked at
// the route level; the mock keeps state like a tiny server (moves rewrite
// item orders and recompute legs with the same reuse/estimate convention as
// server/src/items-admin/legs.ts) so the canvas + leg chips + map redraw from
// real projections after every edit.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-edit-1'

const tripPayload = {
  id: TRIP_ID,
  title: '卡片编辑示例行程',
  startDate: '2026-10-02',
  endDate: '2026-10-03',
  days: 2,
  nights: 1,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

// day-1: stay(POI A) → view(POI B); day-2: free(no POI) → pair(POI C).
// The stored leg stay→view (30.3 km / 31 min) pins the refresh flow: a same-day
// reorder gets an ordered estimate immediately, then the route endpoint can
// replace it with measured data.
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
        item('item-stay', 'day-1', 0, { amapId: 'B1', name: '全季酒店', lat: 49.2, lng: 119.7, category: '住宿', rating: 4.8, introSummary: '' }),
        item('item-view', 'day-1', 1, { amapId: 'B2', name: '莫尔格勒河景区', lat: 49.42, lng: 119.85, category: '景点', rating: 4.7, introSummary: '' }),
      ],
    },
    {
      id: 'day-2',
      index: 1,
      date: '2026-10-03',
      theme: '穿越草原',
      color: '#3f7d5c',
      items: [
        item('item-free', 'day-2', 0, null),
        item('item-pair', 'day-2', 1, { amapId: 'B3', name: '呼伦湖东岸', lat: 50.0, lng: 120.0, category: '景点', rating: 4.5, introSummary: '' }),
      ],
    },
  ],
  legs: [
    {
      id: 'leg-item-stay-item-view',
      fromItemId: 'item-stay',
      toItemId: 'item-view',
      mode: 'drive',
      distanceKm: 30.3,
      durationMin: 31,
      polyline: [[119.7, 49.2], [119.8, 49.3], [119.85, 49.42]],
    },
  ],
}

function item(id, dayId, order, poi) {
  return { id, dayId, order, type: poi ? 'attraction' : 'other', title: id.replace('item-', ''), note: '', poi, images: [], pending: false }
}

/** Builds a stateful in-page mock of the item-admin routes (ticket 09). */
function buildMock({ failMoves = false } = {}) {
  const db = JSON.parse(JSON.stringify(canvasPayload))
  const legBook = new Map(db.legs.map((leg) => [`${leg.fromItemId}|${leg.toItemId}`, leg]))
  const calls = { move: 0, copy: 0, create: 0, patch: 0, remove: 0 }
  let copies = 0
  let created = 0

  const findDay = (dayId) => db.days.find((day) => day.id === dayId)
  const renumber = (day) => day.items.forEach((entry, i) => { entry.order = i; entry.dayId = day.id })
  const removeItem = (itemId) => {
    for (const day of db.days) {
      const at = day.items.findIndex((entry) => entry.id === itemId)
      if (at !== -1) {
        day.items.splice(at, 1)
        renumber(day)
        return true
      }
    }
    return false
  }
  const distKm = (a, b) => {
    const toRad = (d) => (d * Math.PI) / 180
    const dLat = toRad(b.lat - a.lat)
    const dLng = toRad(b.lng - a.lng)
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
    return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 1.2 * 10) / 10
  }
  // Same convention as server/src/items-admin/legs.ts (same pair → estimate → 0/0).
  const recomputeLegs = () => {
    const legs = []
    for (const day of db.days) {
      const items = [...day.items].sort((a, b) => a.order - b.order)
      for (let i = 1; i < items.length; i++) {
        const from = items[i - 1]
        const to = items[i]
        const id = `leg-${from.id}-${to.id}`
        const same = legBook.get(`${from.id}|${to.id}`)
        if (same) {
          legs.push({ id, fromItemId: from.id, toItemId: to.id, mode: same.mode, distanceKm: same.distanceKm, durationMin: same.durationMin, polyline: same.polyline })
          continue
        }
        const km = from.poi && to.poi ? distKm(from.poi, to.poi) : 0
        legs.push({ id, fromItemId: from.id, toItemId: to.id, mode: 'drive', distanceKm: km, durationMin: km > 0 ? Math.max(1, Math.round(km)) : 0, polyline: null })
      }
    }
    return legs
  }

  const json = (route, status, body) =>
    route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

  const handle = async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const parts = url.pathname.split('/') // /api/trips/:id/items/...
    const itemId = parts[5]

    if (method === 'POST' && itemId === undefined) {
      // POST /items — create a card.
      calls.create += 1
      const body = request.postDataJSON()
      created += 1
      const created1 = {
        id: `item-new-${created}`,
        dayId: body.dayId,
        order: 0,
        type: body.type || 'other',
        title: body.title,
        note: body.note || '',
        poi: body.poi ?? null,
        images: [],
        pending: false,
      }
      const day = findDay(body.dayId)
      day.items.push(created1)
      renumber(day)
      return json(route, 201, { item: created1, legs: recomputeLegs() })
    }

    if (method === 'POST' && url.pathname.endsWith('/move')) {
      calls.move += 1
      if (failMoves) return json(route, 500, { error: '保存失败' })
      const body = request.postDataJSON()
      const moving = db.days.flatMap((day) => day.items).find((entry) => entry.id === itemId)
      if (!moving) return json(route, 404, { error: '卡片不存在' })
      const targetDayId = body.dayId || moving.dayId
      removeItem(itemId)
      const day = findDay(targetDayId)
      const index = Math.max(0, Math.min(day.items.length, body.index ?? day.items.length))
      day.items.splice(index, 0, moving)
      renumber(day)
      return json(route, 200, { item: moving, legs: recomputeLegs() })
    }

    if (method === 'POST' && url.pathname.endsWith('/copy')) {
      calls.copy += 1
      const body = request.postDataJSON()
      const source = db.days.flatMap((day) => day.items).find((entry) => entry.id === itemId)
      if (!source) return json(route, 404, { error: '卡片不存在' })
      copies += 1
      const copy = { ...JSON.parse(JSON.stringify(source)), id: `item-copy-${copies}`, dayId: body.dayId || source.dayId, pending: false }
      const day = findDay(copy.dayId)
      const index = body.index === undefined ? day.items.length : Math.max(0, Math.min(day.items.length, body.index))
      day.items.splice(index, 0, copy)
      renumber(day)
      return json(route, 201, { item: copy, legs: recomputeLegs() })
    }

    if (method === 'PATCH') {
      calls.patch += 1
      const body = request.postDataJSON()
      const target = db.days.flatMap((day) => day.items).find((entry) => entry.id === itemId)
      if (!target) return json(route, 404, { error: '卡片不存在' })
      if (body.note !== undefined) target.note = body.note
      if (body.images !== undefined) target.images = body.images
      return json(route, 200, { item: target })
    }

    if (method === 'DELETE') {
      calls.remove += 1
      removeItem(itemId)
      return json(route, 200, { ok: true, legs: recomputeLegs() })
    }

    return json(route, 405, { error: 'method not allowed' })
  }

  return { db, calls, handle }
}

/** Mocks trips list, canvas read, chat history and all item-write routes. */
async function mockCardApi(page, options = {}) {
  const mock = buildMock(options)
  await page.route('**/api/trips', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ trips: [tripPayload] }), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/messages', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ messages: [] }), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/canvas', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(mock.db), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/items/*', (route) => mock.handle(route))
  await page.route('**/api/trips/*/items', (route) => mock.handle(route))
  // Registered last so they win over the generic items/* route.
  await page.route('**/api/trips/*/items/*/copy', (route) => mock.handle(route))
  await page.route('**/api/trips/*/items/*/move', (route) => mock.handle(route))
  return mock
}

/** HTML5 drag: dispatch dragstart on the source and drop on the target card. */
function dragCard(page, sourceId, targetId) {
  return page.evaluate(
    ([from, to]) => {
      const source = document.querySelector(`[data-canvas-card="${from}"]`)
      const target = document.querySelector(`[data-canvas-card="${to}"]`)
      if (!source || !target) throw new Error('drag endpoints missing')
      const dataTransfer = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
    },
    [sourceId, targetId],
  )
}

const cardOrder = (page, dayId) =>
  page
    .locator(`[data-canvas-day="${dayId}"] [data-canvas-card]`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-canvas-card')))

test('drag reorders cards within a day and marks the new direction as an estimate', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-stay"]').waitFor()
    assert.deepEqual(await cardOrder(page, 'day-1'), ['item-stay', 'item-view'])
    assert.ok(await page.locator('[data-leg-chip="leg-item-stay-item-view"]').isVisible())

    // Drag the second card onto the first → they swap.
    await dragCard(page, 'item-view', 'item-stay')
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-canvas-day="day-1"] [data-canvas-card]')].map(
          (node) => node.getAttribute('data-canvas-card'),
        ).join(',') === 'item-view,item-stay',
    )

    // The leg chip re-derives from the ordered pair estimate; a real route
    // refresh runs in the background after the item write.
    await page.locator('[data-leg-chip="leg-item-view-item-stay"]').waitFor()
    assert.match(await page.locator('[data-leg-chip="leg-item-view-item-stay"]').textContent(), /32\.1 千米 · 32 分钟/)
    assert.equal(await page.locator('[data-leg-chip="leg-item-view-item-stay"]').getAttribute('data-leg-quality'), 'estimate')
  } finally {
    await close()
  }
})

test('cross-day move via the ⋯ menu relayouts both days and recomputes legs', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-view"]').waitFor()

    await page.locator('[data-card-menu-button="item-view"]').click()
    const menu = page.locator('[data-card-menu]')
    await menu.waitFor()
    assert.ok(await menu.locator('[data-menu-action="move-to"]').isVisible(), '移动到… is offered')
    assert.ok(await menu.locator('[data-menu-action="copy-to"]').isVisible())
    assert.ok(await menu.locator('[data-menu-action="delete"]').isVisible())

    await menu.locator('[data-menu-action="move-to"]').click()
    const picker = page.locator('[data-day-picker]')
    await picker.waitFor()
    await picker.locator('[data-target-day="day-2"]').click()

    // item-view left day-1 and landed in day-2 at its relative position
    // (source index 1 → between item-free and item-pair).
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-canvas-day="day-2"] [data-canvas-card]')].map(
          (node) => node.getAttribute('data-canvas-card'),
        ).join(',') === 'item-free,item-view,item-pair',
    )
    assert.deepEqual(await cardOrder(page, 'day-1'), ['item-stay'])

    // day-1 has a single card (no chip); day-2 gains the estimated pair chip.
    assert.equal(await page.locator('[data-canvas-day="day-1"] [data-leg-chip]').count(), 0)
    await page.locator('[data-leg-chip="leg-item-view-item-pair"]').waitFor()
  } finally {
    await close()
  }
})

test('copy-to duplicates the card into the target day with a fresh id', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-view"]').waitFor()
    await page.locator('[data-card-menu-button="item-view"]').click()
    await page.locator('[data-menu-action="copy-to"]').click()
    await page.locator('[data-day-picker]').locator('[data-target-day="day-2"]').click()

    await page.locator('[data-canvas-card="item-copy-1"]').waitFor()
    assert.deepEqual(await cardOrder(page, 'day-1'), ['item-stay', 'item-view'], 'the source card stays')
    assert.deepEqual(await cardOrder(page, 'day-2'), ['item-free', 'item-pair', 'item-copy-1'])
  } finally {
    await close()
  }
})

test('menu delete removes the card and its leg chip disappears', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-view"]').waitFor()
    assert.ok(await page.locator('[data-leg-chip="leg-item-stay-item-view"]').isVisible())

    await page.locator('[data-card-menu-button="item-view"]').click()
    await page.locator('[data-menu-action="delete"]').click()

    await page.locator('[data-canvas-card="item-view"]').waitFor({ state: 'detached' })
    await page.locator('[data-canvas-day="day-1"] [data-leg-chip]').waitFor({ state: 'detached' })
    assert.deepEqual(await cardOrder(page, 'day-1'), ['item-stay'])
  } finally {
    await close()
  }
})

test('the day column "+" adds a free-text card (poi-less, dashed plain-text card)', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-free"]').waitFor()

    await page.locator('[data-action="add-card"][data-day-id="day-2"]').click()
    const dialog = page.locator('[data-add-card-dialog]')
    await dialog.waitFor()
    // The 自由文本 mode is the default tab; fill title + note and confirm.
    await dialog.locator('[data-add-title]').fill('自驾前往满洲里')
    await dialog.locator('[data-add-note]').fill('下午出发')
    await dialog.locator('[data-action="add-confirm"]').click()

    const created = page.locator('[data-canvas-card="item-new-1"]')
    await created.waitFor()
    assert.equal(await created.getAttribute('data-card-plain-text'), 'true', 'free-text cards are POI-less')
    assert.deepEqual(await cardOrder(page, 'day-2'), ['item-free', 'item-pair', 'item-new-1'])
    assert.match(await created.textContent(), /自驾前往满洲里/)
  } finally {
    await close()
  }
})

test('the selected card toolbar offers 添加 and opens the same dialog for its day', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-stay"]').waitFor()
    await page.locator('[data-canvas-card="item-stay"]').click()

    const toolbar = page.locator('[data-card-toolbar]')
    await toolbar.waitFor()
    await toolbar.locator('[data-action="toolbar-add-card"]').click()

    const dialog = page.locator('[data-add-card-dialog]')
    await dialog.waitFor()
    const selectedDay = await dialog.locator('[data-add-day]').inputValue()
    assert.equal(selectedDay, 'day-1', 'the dialog preselects the selected card’s day')
  } finally {
    await close()
  }
})

test('inline note editing saves the one-line note through PATCH', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-stay"]').waitFor()

    await page.locator('[data-card-note-edit]').first().click()
    const input = page.locator('[data-card-note-input]')
    await input.waitFor()
    await input.fill('20:00 抵达，先取车')
    await page.locator('[data-action="save-note"]').click()

    await page.locator('[data-canvas-card="item-stay"]').waitFor()
    assert.match(await page.locator('[data-canvas-card="item-stay"]').textContent(), /20:00 抵达，先取车/)
  } finally {
    await close()
  }
})

test('menu 添加图片 appends the image URL and the card grows a cover', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page) })
  try {
    await page.locator('[data-canvas-card="item-stay"]').waitFor()

    await page.locator('[data-card-menu-button="item-pair"]').click()
    await page.locator('[data-menu-action="add-image"]').click()
    const input = page.locator('[data-card-image-input]')
    await input.waitFor()
    await input.fill('https://example.com/lake.jpg')
    await page.locator('[data-action="confirm-image"]').click()

    await page.locator('[data-canvas-card-cover="item-pair"]').waitFor()
  } finally {
    await close()
  }
})

test('a failed move rolls the optimistic reorder back and shows the error banner', async () => {
  const { page, close } = await openApp({ entry: `/?view=workbench&trip=${TRIP_ID}`, setup: ({ page }) => mockCardApi(page, { failMoves: true }) })
  try {
    await page.locator('[data-canvas-card="item-stay"]').waitFor()
    assert.deepEqual(await cardOrder(page, 'day-1'), ['item-stay', 'item-view'])

    await dragCard(page, 'item-view', 'item-stay')

    // Rollback: the original order is restored, no card is lost.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-canvas-day="day-1"] [data-canvas-card]')].map(
          (node) => node.getAttribute('data-canvas-card'),
        ).join(',') === 'item-stay,item-view',
    )
    const banner = page.locator('[data-workbench-action-error]')
    await banner.waitFor()
    assert.match(await banner.textContent(), /保存失败/)

    // The menu move path fails the same way and rolls back.
    await page.locator('[data-card-menu-button="item-stay"]').click()
    await page.locator('[data-menu-action="move-down"]').click()
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-canvas-day="day-1"] [data-canvas-card]')].map(
          (node) => node.getAttribute('data-canvas-card'),
        ).join(',') === 'item-stay,item-view',
    )
    assert.deepEqual(await cardOrder(page, 'day-2'), ['item-free', 'item-pair'], 'other days untouched')
  } finally {
    await close()
  }
})
