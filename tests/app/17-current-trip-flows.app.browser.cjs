// Current-trip spec coverage: one-sentence intake, automatic first chat,
// server-bound stay edits, and print-time auxiliary refreshes.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-intake-current'

const planningContext = {
  destination: '呼伦贝尔',
  durationDays: 7,
  preferences: '我想去呼伦贝尔 7 天，慢节奏，自驾',
  originalSentence: '我想去呼伦贝尔 7 天，慢节奏，自驾',
  dateStatus: 'unspecified',
}
const trip = {
  id: TRIP_ID,
  title: '呼伦贝尔 · 7日行程',
  startDate: '',
  endDate: '',
  days: 0,
  nights: 0,
  durationDays: 7,
  dateStatus: 'unspecified',
  planningContext,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

function item(id, dayId, order, type, title, poi, note = '') {
  return { id, dayId, order, type, title, note, poi, images: [], pending: false }
}

function json(route, status, body) {
  return route.fulfill({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

function sse(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

test('intake opens the current workbench, sends the sentence once, edits stays on the server, and prints fresh tools data', async () => {
  let currentCanvas = {
    trip,
    days: [
      {
        id: 'day-1', index: 0, date: '', theme: '日期待定', color: '#c26d4f',
        items: [
          item('stay-1', 'day-1', 0, 'stay', '原住宿', { amapId: '', name: '原住宿', lat: 49.2, lng: 119.7, category: '住宿', rating: 0, introSummary: '' }, '晚到联系前台'),
          item('poi-1', 'day-1', 1, 'attraction', '草原景点', { amapId: '', name: '草原景点', lat: 49.3, lng: 119.8, category: '景点', rating: 0, introSummary: '' }),
        ],
      },
    ],
    legs: [{ id: 'leg-stay-poi', fromItemId: 'stay-1', toItemId: 'poi-1', mode: 'drive', distanceKm: 10, durationMin: 12, polyline: [[119.7, 49.2], [119.8, 49.3]], quality: 'reference' }],
  }
  let notesReads = 0
  let checklistReads = 0
  let intakeCalls = 0
  let chatCalls = 0
  let stayPatch = null

  const init = `window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1 }`
  const { page, close } = await openApp({
    entry: '/?view=trips',
    init,
    setup: async ({ page }) => {
      await page.route('**/api/trips', (route) => json(route, 200, { trips: [] }))
      await page.route('**/api/trips/**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        const path = url.pathname
        if (path.endsWith('/intake') && request.method() === 'POST') {
          intakeCalls += 1
          return json(route, 201, { trip, intake: planningContext })
        }
        if (path.endsWith('/canvas') && request.method() === 'GET') return json(route, 200, currentCanvas)
        if (path.endsWith('/messages') && request.method() === 'GET') return json(route, 200, { messages: [] })
        if (path.endsWith('/messages') && request.method() === 'POST') {
          chatCalls += 1
          const body = request.postDataJSON()
          return route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
            body: sse([
              ['start', { round: 'qa' }],
              ['delta', { text: `已收到：${body.content}` }],
              ['meta', { round: 'qa', chips: [{ label: '查看路线', value: '查看路线' }] }],
              ['done', {
                userMessage: { id: 'user-1', tripId: TRIP_ID, role: 'user', content: body.content, createdAt: '2026-09-12T00:01:00.000Z' },
                assistantMessage: { id: 'assistant-1', tripId: TRIP_ID, role: 'assistant', content: `已收到：${body.content}`, createdAt: '2026-09-12T00:01:01.000Z', meta: { round: 'qa', chips: [{ label: '查看路线', value: '查看路线' }] } },
              }],
            ]),
          })
        }
        if (path.endsWith('/notes') && request.method() === 'GET') {
          notesReads += 1
          return json(route, 200, { notes: [{ id: 'note-1', content: `最新便签 ${notesReads}`, createdAt: '', updatedAt: '' }] })
        }
        if (path.endsWith('/checklist') && request.method() === 'GET') {
          checklistReads += 1
          return json(route, 200, { items: [{ id: 'check-1', content: `最新清单 ${checklistReads}`, done: false, createdAt: '' }] })
        }
        if (path.endsWith('/legs/refresh') && request.method() === 'POST') {
          return json(route, 200, { legs: currentCanvas.legs, summary: { attempted: 1, updated: 0, pending: 1, truncated: false } })
        }
        if (path.includes('/items/stay-1') && request.method() === 'PATCH') {
          stayPatch = request.postDataJSON()
          currentCanvas.days[0].items[0] = { ...currentCanvas.days[0].items[0], title: stayPatch.title, note: stayPatch.note, poi: stayPatch.poi }
          return json(route, 200, { item: currentCanvas.days[0].items[0] })
        }
        if (path.endsWith('/events')) {
          return route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: '' })
        }
        return json(route, 404, { error: '未处理请求' })
      })
    },
  })
  try {
    await page.locator('#trip-intake-input').fill(planningContext.originalSentence)
    await page.locator('#trip-intake-submit').click()
    await page.locator('#workbench-topbar').waitFor()
    assert.equal(intakeCalls, 1)
    await page.locator('[data-chat-message][data-chat-role="user"]').filter({ hasText: planningContext.originalSentence }).waitFor()
    assert.equal(chatCalls, 1, 'the intake sentence is sent once to the existing planner')
    assert.match(await page.locator('#workbench-trip-badge').textContent(), /日期待定.*7天6晚/)

    await page.locator('[data-action="edit-workbench-stays"]').click()
    await page.locator('#workbench-stay-editor').waitFor()
    await page.locator('#workbench-stay-title').fill('更新住宿')
    await page.locator('#workbench-stay-address').fill('额尔古纳河畔 18 号')
    await page.locator('#workbench-stay-note').fill('晚到请提前联系')
    await page.locator('#workbench-stay-editor').getByRole('button', { name: '保存住宿' }).click()
    await page.locator('#workbench-stay-editor').waitFor({ state: 'detached' })
    assert.equal(stayPatch.title, '更新住宿')
    assert.equal(stayPatch.poi.address, '额尔古纳河畔 18 号')
    assert.equal(stayPatch.note, '晚到请提前联系')

    await page.locator('#workbench-print').click()
    await page.waitForFunction(() => (window.__printCalls || 0) === 1)
    assert.ok(notesReads >= 2, `print refresh should refetch notes, got ${notesReads}`)
    assert.ok(checklistReads >= 2, `print refresh should refetch checklist, got ${checklistReads}`)
    assert.match(await page.locator('#print-itinerary').textContent(), /呼伦贝尔 · 7日行程/)
    assert.match(await page.locator('#print-itinerary').textContent(), /更新住宿/)
    assert.match(await page.locator('#print-itinerary').textContent(), /最新便签/)
    assert.equal(await page.locator('#print-itinerary button, #print-itinerary input, #print-itinerary select, #print-itinerary textarea').count(), 0)
  } finally {
    await close()
  }
})
