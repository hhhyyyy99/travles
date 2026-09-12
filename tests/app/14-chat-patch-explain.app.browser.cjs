// Ticket 11 — patch-explain history and long-drive boundary warnings. Runs
// against the real workbench UI with canvas/messages APIs mocked at the route
// level, asserting that impact/conflict chips and split advice are visible in
// chat while the matching leg is marked on the canvas.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-chat-patch-explain'

const tripPayload = {
  id: TRIP_ID,
  title: '呼伦贝尔慢环线',
  startDate: '2026-10-02',
  endDate: '2026-10-03',
  days: 2,
  nights: 1,
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
      theme: '长途驾驶日',
      color: '#c26d4f',
      items: [
        {
          id: 'item-hailar',
          dayId: 'day-1',
          order: 0,
          type: 'attraction',
          title: '海拉尔',
          note: '',
          poi: { amapId: 'B1', name: '海拉尔', lat: 49.2, lng: 119.7, category: '城市', rating: 0, introSummary: '' },
          images: [],
          pending: false,
        },
        {
          id: 'item-manzhouli',
          dayId: 'day-1',
          order: 1,
          type: 'attraction',
          title: '满洲里',
          note: '',
          poi: { amapId: 'B2', name: '满洲里', lat: 49.6, lng: 117.4, category: '城市', rating: 0, introSummary: '' },
          images: [],
          pending: false,
        },
      ],
    },
  ],
  legs: [
    {
      id: 'leg-long',
      fromItemId: 'item-hailar',
      toItemId: 'item-manzhouli',
      mode: 'drive',
      distanceKm: 500,
      durationMin: 361,
      polyline: null,
    },
  ],
}

const explainMeta = {
  round: 'patch-explain',
  impacts: ['D1 需要保留返程缓冲', 'D2 住宿城市需要前移'],
  conflicts: ['10/7 指定海拉尔，与原计划满洲里住宿冲突'],
  chips: [
    { label: '调整整条环线', value: '确认方案：调整整条环线' },
    { label: '保留满洲里', value: '确认方案：保留满洲里' },
  ],
  warnings: [
    {
      kind: 'long-drive',
      title: '长途驾驶警示',
      message: '海拉尔 → 满洲里 预计驾驶 6 小时 1 分钟，超过 6 小时。',
      suggestion: '建议拆成两段，增加中途休息或过夜点，再继续规划。',
      from: '海拉尔',
      to: '满洲里',
      durationMin: 361,
    },
  ],
}

const historyPayload = {
  messages: [
    {
      id: 'u-1',
      tripId: TRIP_ID,
      role: 'user',
      content: '10/7 改住海拉尔，帮我重新安排',
      createdAt: '2026-09-12T01:00:00.000Z',
    },
    {
      id: 'a-1',
      tripId: TRIP_ID,
      role: 'assistant',
      content: '我先复述影响：10/7 改住海拉尔会影响满洲里住宿安排。',
      createdAt: '2026-09-12T01:00:01.000Z',
      meta: explainMeta,
    },
  ],
}

async function mockApi({ page }) {
  await page.route('**/api/trips', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ trips: [tripPayload] }), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/canvas', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(canvasPayload), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/messages', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, body: JSON.stringify(historyPayload), headers: { 'content-type': 'application/json' } })
    }
    return route.fulfill({ status: 405, body: '{}', headers: { 'content-type': 'application/json' } })
  })
}

test('patch-explain details and long-drive warnings render in chat and canvas', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: mockApi,
  })
  try {
    await page.locator('#chat-list').waitFor()
    const bubble = page.locator('[data-chat-message][data-chat-round="patch-explain"]')
    await bubble.waitFor()
    assert.equal(await bubble.locator('[data-chat-patch-explain]').count(), 1)
    assert.equal(await bubble.locator('[data-chat-chip]').count(), 2)
    assert.ok((await bubble.textContent()).includes('影响范围'))
    assert.ok((await bubble.textContent()).includes('住宿城市需要前移'))
    assert.ok((await bubble.textContent()).includes('超过 6 小时'))
    assert.ok((await bubble.textContent()).includes('建议拆成两段'))

    const warning = page.locator('[data-canvas-day="day-1"] [data-leg-warning="leg-long"]')
    await warning.waitFor()
    assert.ok((await warning.textContent()).includes('超长，建议拆分'))
    assert.match(await warning.getAttribute('title'), /超过 6 小时/)
  } finally {
    await close()
  }
})
