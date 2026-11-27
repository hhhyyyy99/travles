const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

async function openCanvas(viewport = { width: 1440, height: 900 }) {
  const trip = {
    id: 'zoom-demo',
    title: '画布缩放示例',
    startDate: '2026-10-02',
    endDate: '2026-10-04',
    days: 3,
    nights: 2,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  }
  const days = Array.from({ length: 3 }, (_, index) => {
    const id = `day-${index + 1}`
    return {
      id,
      index,
      date: `2026-10-0${index + 2}`,
      theme: `示例日程 ${index + 1}`,
      items: [
        {
          id: `card-${index + 1}`,
          dayId: id,
          order: 0,
          type: 'attraction',
          title: `示例卡片 ${index + 1}`,
          note: '',
          images: [],
          poi: {
            amapId: `poi-${index + 1}`,
            name: `示例地点 ${index + 1}`,
            lat: 40 + index / 25,
            lng: 116 + index / 25,
          },
        },
      ],
    }
  })
  const writes = []
  const app = await openApp({
    viewport,
    entry: `/?view=workbench&trip=${trip.id}`,
    amapConfig404: true,
    setup: async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.route('**/api/**', (route) => {
        if (route.request().method() !== 'GET') writes.push(route.request().method())
        return route.fulfill({ status: 404, json: {} })
      })
      await page.route('**/api/trips/*/canvas', (route) =>
        route.fulfill({ json: { trip, days, legs: [] } }),
      )
      await page.route('**/api/trips/*/messages', (route) =>
        route.fulfill({ json: { messages: [] } }),
      )
      await page.route('**/api/trips/*/legs/refresh', (route) =>
        route.fulfill({ json: { legs: [] } }),
      )
      await page.route('**/api/trips/*/items/card-1/move', (route) => {
        const body = route.request().postDataJSON()
        writes.push(body)
        const item = { ...days[0].items[0], dayId: body.dayId, order: body.index }
        return route.fulfill({ json: { item, legs: [] } })
      })
    },
  })
  return { ...app, writes }
}

const zoomControls = (page) => {
  const group = page.getByRole('group', { name: '画布缩放' })
  return {
    group,
    plus: group.getByRole('button', { name: '放大画布', exact: true }),
    minus: group.getByRole('button', { name: '缩小画布', exact: true }),
    reset: group.getByRole('button', { name: /^恢复默认画布缩放/ }),
  }
}

async function assertZoom(page, percent) {
  assert.equal(await zoomControls(page).reset.textContent(), `${percent}%`)
  const { width } = await page.locator('[data-canvas-day]').first().boundingBox()
  assert.ok(
    Math.abs(width - (292 * percent) / 100) < 1,
    `unexpected day width at ${percent}%: ${width}`,
  )
}

test('canvas zoom supports pointer, keyboard and limits without changing the list or map', async (t) => {
  const { page, close, writes } = await openCanvas()
  t.after(close)
  const { group, plus, minus, reset } = zoomControls(page)
  const listToggle = page.locator('[data-action="view-list"]')
  const canvasToggle = page.locator('[data-action="view-canvas"]')
  const canvas = page.getByRole('region', { name: '横向行程画布' })
  const map = page.locator('#workbench-map')
  const markers = map.locator('.wb-poi-marker')
  await markers.first().waitFor()
  const mapBefore = await map.boundingBox()
  const markerPositions = () =>
    markers.evaluateAll((elements) => elements.map((marker) => marker.style.transform))
  const markersBefore = await markerPositions()
  const listDay = page.locator('[data-list-day="day-1"]')
  await listToggle.click()
  await page.locator('[data-list-tab="day-1"]').click()
  const listBefore = await listDay.boundingBox()
  await canvasToggle.click()

  await assertZoom(page, 100)
  assert.ok(await reset.isDisabled())
  await plus.click()
  await assertZoom(page, 120)
  await page.keyboard.press('Enter')
  await assertZoom(page, 140)
  assert.ok(await plus.isDisabled())
  await page.keyboard.press('Enter')
  assert.equal(await plus.evaluate((button) => button === document.activeElement), true)
  await assertZoom(page, 140)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await reset.evaluate((button) => button === document.activeElement), true)
  await page.keyboard.press('Space')
  await assertZoom(page, 100)
  await minus.click()
  await assertZoom(page, 80)
  assert.ok(await minus.isDisabled())
  await page.keyboard.press('Enter')
  await assertZoom(page, 80)
  await canvas.press('Equal')
  await assertZoom(page, 100)
  await canvas.press('Shift+Equal')
  await assertZoom(page, 120)
  await canvas.press('Minus')
  await assertZoom(page, 100)
  await canvas.press('Minus')
  await canvas.press('0')
  await assertZoom(page, 100)
  assert.deepEqual(await map.boundingBox(), mapBefore)
  assert.deepEqual(await markerPositions(), markersBefore)

  await plus.click()
  await listToggle.click()
  await page.locator('[data-list-tab="day-1"]').click()
  assert.equal(await group.count(), 0)
  assert.equal(await canvas.count(), 0)
  assert.deepEqual(await listDay.boundingBox(), listBefore)
  assert.deepEqual(writes, [])
})

test('zoomed canvas still scrolls, selects POIs and sends the existing cross-day move', async (t) => {
  const { page, close, writes } = await openCanvas()
  t.after(close)
  await zoomControls(page).plus.click()
  const canvas = page.getByRole('region', { name: '横向行程画布' })
  const firstCard = canvas.locator('[data-canvas-card="card-1"]')
  const nextDay = canvas.locator('[data-canvas-day="day-2"]')
  const nextCard = nextDay.locator('[data-canvas-card="card-2"]')
  const thirdCard = canvas.locator('[data-canvas-card="card-3"]')

  await firstCard.locator('h3').click()
  await page.locator('[data-poi-detail="card-1"]').waitFor()
  assert.equal(await firstCard.getAttribute('data-card-highlight'), 'true')
  assert.deepEqual(writes, [])
  await firstCard.dragTo(nextCard, {
    sourcePosition: { x: 85, y: 48 },
    targetPosition: { x: 85, y: 48 },
  })
  await nextDay.locator('[data-canvas-card="card-1"]').waitFor()
  assert.deepEqual(writes, [{ dayId: 'day-2', index: 0 }])
  await assertZoom(page, 120)
  await page.waitForFunction(() => !document.querySelector('[data-canvas-syncing]'))

  const { x, y, width } = await canvas.boundingBox()
  await page.mouse.move(x + width / 2, y + 30)
  await page.mouse.wheel(750, 0)
  await page.waitForFunction(() => document.getElementById('workbench-canvas').scrollLeft > 0)
  await thirdCard.locator('h3').click()
  await page.locator('[data-poi-detail="card-3"]').waitFor()
})

test('the zoomed card menu opens an unscaled cross-day picker and can move a card', async (t) => {
  const { page, close, writes } = await openCanvas()
  t.after(close)
  const { plus } = zoomControls(page)
  await plus.click()
  await plus.click()
  await assertZoom(page, 140)

  await page.locator('[data-card-menu-button="card-1"]').click()
  const menu = page.getByRole('menu', { name: '卡片操作：示例卡片 1' })
  await menu.getByRole('menuitem', { name: '移动到…' }).click()
  await menu.waitFor({ state: 'hidden' })
  const picker = page.getByRole('dialog', { name: '移动到哪一天' })
  await picker.waitFor()
  assert.equal((await picker.boundingBox()).width, 300, 'the dialog does not zoom with the cards')
  assert.ok(await picker.locator('[data-target-day="day-1"]').isDisabled())
  await page.keyboard.press('Escape')
  await picker.waitFor({ state: 'hidden' })
  assert.deepEqual(writes, [])

  await page.locator('[data-card-menu-button="card-1"]').click()
  await menu.getByRole('menuitem', { name: '移动到…' }).click()
  await picker.locator('[data-target-day="day-3"]').click()
  await picker.waitFor({ state: 'hidden' })
  await page.locator('[data-canvas-day="day-3"] [data-canvas-card="card-1"]').waitFor()
  assert.deepEqual(writes, [{ dayId: 'day-3', index: 0 }])
  await assertZoom(page, 140)
})

test('zoom controls stay reachable at narrow widths while the canvas scrolls independently', async (t) => {
  const { page, close, writes } = await openCanvas({ width: 320, height: 750 })
  t.after(close)
  const { group, plus, minus, reset } = zoomControls(page)
  const canvas = page.getByRole('region', { name: '横向行程画布' })
  await group.waitFor()
  const documentWidth = () => page.evaluate(() => document.documentElement.scrollWidth)
  const widthBefore = await documentWidth()
  await plus.click()
  await plus.click()
  await assertZoom(page, 140)
  assert.equal(await documentWidth(), widthBefore, 'zoom only overflows within the canvas')
  const groupBefore = await group.boundingBox()
  assert.ok(groupBefore.x >= 0 && groupBefore.x + groupBefore.width <= 320)
  assert.ok((await canvas.boundingBox()).height > 150)
  await canvas.focus()
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.getElementById('workbench-canvas').scrollLeft > 0)
  assert.deepEqual(await group.boundingBox(), groupBefore)
  await reset.click()
  await assertZoom(page, 100)
  await minus.click()
  await assertZoom(page, 80)
  assert.deepEqual(writes, [])
})
