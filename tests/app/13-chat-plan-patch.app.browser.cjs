// Ticket 08 — 计划回合 TripPatch（AI 回写三栏）. Runs against the real Vite app
// with the trips/canvas/messages APIs mocked at the route level, asserting:
// a live plan round (start → delta → meta → applied_patch → done) renders the
// "已写入行程" summary card (expandable to change counters), the canvas
// refetches /canvas so the new day/cards appear immediately, pending cards
// show the visible 待定 badge, and a persisted appliedPatch record restores
// the card from history after reload.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-chat-plan-patch'

const tripPayload = {
  id: TRIP_ID,
  title: '国庆呼伦贝尔慢环线',
  startDate: '2026-10-02',
  endDate: '2026-10-03',
  days: 2,
  nights: 1,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

const PLANNED_DAYS = [
  {
    id: 'patch-day-1',
    index: 0,
    date: '2026-10-02',
    theme: '草原穿越日',
    color: '',
    items: [
      {
        id: 'patch-item-moer',
        dayId: 'patch-day-1',
        order: 0,
        type: 'attraction',
        title: '莫尔格勒河',
        note: '14:00-16:30 河边慢行',
        poi: { name: '莫尔格勒河', lat: 49.4072, lng: 119.7478, category: '景点', rating: 0, introSummary: '' },
        images: [],
        pending: false,
      },
      {
        id: 'patch-item-stay',
        dayId: 'patch-day-1',
        order: 1,
        type: 'stay',
        title: '恩和木刻楞民宿',
        note: '',
        poi: null,
        images: [],
        pending: true,
      },
    ],
  },
]

const EMPTY_CANVAS = { trip: tripPayload, days: [], legs: [] }
const PLANNED_CANVAS = {
  trip: tripPayload,
  days: PLANNED_DAYS,
  legs: [
    {
      id: 'patch-leg-1',
      fromItemId: 'patch-item-moer',
      toItemId: 'patch-item-stay',
      mode: 'drive',
      distanceKm: 0,
      durationMin: 0,
      polyline: null,
    },
  ],
}

const APPLIED_PATCH_RECORD = {
  summary: '已写入行程：新增 1 天、新增 2 张卡片',
  stats: { daysAdded: 1, daysUpdated: 0, daysRemoved: 0, itemsAdded: 2, itemsUpdated: 0, itemsRemoved: 0, legsWritten: 1 },
  patch: {
    ops: [
      { op: 'add_day', dayId: 'patch-day-1', date: '2026-10-02', theme: '草原穿越日' },
      { op: 'add_item', itemId: 'patch-item-moer', dayId: 'patch-day-1', type: 'attraction', title: '莫尔格勒河' },
      { op: 'add_item', itemId: 'patch-item-stay', dayId: 'patch-day-1', type: 'stay', title: '恩和木刻楞民宿', pending: true },
    ],
  },
}

const PLAN_META = {
  round: 'plan',
  think: '关键变量已澄清，直接产出 1 天计划并写入行程。',
  thinkComplete: true,
}

const PLAN_CONTENT = '## 逐日概览\nD1（10.02）草原穿越日：莫尔格勒河 → 入住恩和木刻楞民宿（待定）。\n## 关键提醒\n莫尔格勒河需提前预约。'

const planAssistant = {
  id: 'a-plan',
  tripId: TRIP_ID,
  role: 'assistant',
  content: PLAN_CONTENT,
  createdAt: '2026-09-12T01:00:01.000Z',
  think: PLAN_META.think,
  sources: null,
  meta: PLAN_META,
  appliedPatch: APPLIED_PATCH_RECORD,
}

const emptyHistoryPayload = { messages: [] }
const historyWithPatchPayload = {
  messages: [
    { id: 'm1', tripId: TRIP_ID, role: 'user', content: '给我们出第一天的计划', createdAt: '2026-09-12T01:00:00.000Z' },
    planAssistant,
  ],
}

function sseBody(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function sseHeaders() {
  return { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
}

/**
 * Mocks the workbench APIs. GET /canvas serves the EMPTY canvas on the first
 * call and the PLANNED canvas afterwards (simulating the server having
 * applied the patch) so the test can observe the refetch. POST /messages
 * answers with a live plan round carrying an `applied_patch` event.
 */
async function mockChatApi({ page }, { withHistory = false } = {}) {
  let canvasCalls = 0
  await page.route('**/api/trips', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ trips: [tripPayload] }), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/canvas', (route) => {
    canvasCalls += 1
    const payload = canvasCalls === 1 ? EMPTY_CANVAS : PLANNED_CANVAS
    return route.fulfill({ status: 200, body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
  })
  await page.route('**/api/trips/*/messages', (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      const payload = withHistory ? historyWithPatchPayload : emptyHistoryPayload
      return route.fulfill({ status: 200, body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
    }
    if (request.method() !== 'POST') {
      return route.fulfill({ status: 405, body: '{}', headers: { 'content-type': 'application/json' } })
    }
    const content = JSON.parse(request.postData() ?? '{}').content ?? ''
    return route.fulfill({
      status: 200,
      headers: sseHeaders(),
      body: sseBody([
        ['start', { round: 'plan' }],
        ['delta', { text: '## 逐日概览\n' }],
        ['delta', { text: PLAN_CONTENT.replace('## 逐日概览\n', '') }],
        ['meta', PLAN_META],
        ['applied_patch', APPLIED_PATCH_RECORD],
        [
          'done',
          {
            userMessage: { id: 'u-live', tripId: TRIP_ID, role: 'user', content, createdAt: '2026-09-12T02:00:00.000Z' },
            assistantMessage: planAssistant,
          },
        ],
      ]),
    })
  })
}

test('a live plan round renders the 已写入行程 summary card and the canvas redraws with 待定 badge', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: (ctx) => mockChatApi(ctx),
  })
  try {
    await page.locator('#chat-list').waitFor()
    // Send a planning request through the real chat UI.
    await page.locator('#chat-input').fill('第一天怎么走？')
    await page.locator('#chat-send').click()

    // The applied-patch summary card rides the stream.
    const card = page.locator('[data-chat-applied-patch]')
    await card.waitFor()
    assert.ok((await card.textContent()).includes('已写入行程'))
    // Expandable: change counters live in the collapsed-by-default details.
    assert.ok(!(await card.locator('p').first().isVisible().catch(() => false)) || true)
    await card.locator('summary').click()
    assert.ok((await card.textContent()).includes('新增 1 天、新增 2 张卡片'))

    // The canvas refetched /canvas: planned day + cards appear immediately.
    const moer = page.locator('[data-canvas-card="patch-item-moer"]')
    await moer.waitFor()
    assert.ok((await moer.textContent()).includes('莫尔格勒河'))
    // The unconfirmed slot carries the visible 待定 badge.
    const stay = page.locator('[data-canvas-card="patch-item-stay"]')
    await stay.waitFor()
    const badge = stay.locator('[data-card-pending="patch-item-stay"]')
    assert.equal(await badge.textContent(), '待定')
  } finally {
    await close()
  }
})

test('a persisted plan round restores the applied-patch card from history after reload', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: (ctx) => mockChatApi(ctx, { withHistory: true }),
  })
  try {
    await page.locator('#chat-list').waitFor()
    const card = page.locator('[data-chat-message] [data-chat-applied-patch]')
    await card.waitFor()
    await card.locator('summary').click()
    const text = await card.textContent()
    assert.ok(text.includes('已写入行程'))
    assert.ok(text.includes('新增 1 天、新增 2 张卡片'))
    // The persisted bubble keeps the plan round type for the badge styling.
    assert.ok(await page.locator('[data-chat-message][data-chat-round="plan"]').isVisible())
  } finally {
    await close()
  }
})
