// Ticket 06 — AI chat panel (qa round). Runs against the real Vite app with
// the trips/canvas/messages APIs mocked at the route level (Playwright
// directly, no @playwright/test), asserting: history render, send → streamed
// reply, reload → history restored, and stream-error guidance (spec 用户故事
// 25).
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-chat-1'

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

const canvasPayload = { trip: tripPayload, days: [], legs: [] }

const historyPayload = {
  messages: [
    { id: 'm1', tripId: TRIP_ID, role: 'user', content: '十月上旬海拉尔冷不冷？', createdAt: '2026-09-12T01:00:00.000Z' },
    { id: 'm2', tripId: TRIP_ID, role: 'assistant', content: '白天 8 度，早晚 0 度左右，带抓绒。', createdAt: '2026-09-12T01:00:01.000Z' },
  ],
}

function sseBody(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function sseHeaders() {
  return { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
}

/**
 * Mocks the workbench APIs. `options.failChat` makes the POST respond with
 * an in-stream error event instead of a normal qa round.
 */
async function mockChatApi({ page }, { failChat = false } = {}) {
  await page.route('**/api/trips', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify({ trips: [tripPayload] }), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/canvas', (route) =>
    route.fulfill({ status: 200, body: JSON.stringify(canvasPayload), headers: { 'content-type': 'application/json' } }),
  )
  await page.route('**/api/trips/*/messages', (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      return route.fulfill({ status: 200, body: JSON.stringify(historyPayload), headers: { 'content-type': 'application/json' } })
    }
    if (request.method() !== 'POST') {
      return route.fulfill({ status: 405, body: '{}', headers: { 'content-type': 'application/json' } })
    }
    const content = JSON.parse(request.postData() ?? '{}').content ?? ''

    if (failChat) {
      return route.fulfill({
        status: 200,
        headers: sseHeaders(),
        body: sseBody([
          ['start', { round: 'qa' }],
          ['error', { code: 'model_unavailable', message: '无法连接模型服务，请检查网络或服务地址。', guidance: '请确认 AI_BASE_URL 指向的服务可达后重试。' }],
          ['close', {}],
        ]),
      })
    }

    const reply = `收到：「${content}」。这是圆周的回答。`
    return route.fulfill({
      status: 200,
      headers: sseHeaders(),
      body: sseBody([
        ['start', { round: 'qa' }],
        ['delta', { text: `收到：「${content}」。` }],
        ['delta', { text: '这是圆周的回答。' }],
        [
          'done',
          {
            userMessage: { id: `u-${Math.random().toString(36).slice(2, 8)}`, tripId: TRIP_ID, role: 'user', content, createdAt: '2026-09-12T02:00:00.000Z' },
            assistantMessage: { id: `a-${Math.random().toString(36).slice(2, 8)}`, tripId: TRIP_ID, role: 'assistant', content: reply, createdAt: '2026-09-12T02:00:01.000Z' },
          },
        ],
      ]),
    })
  })
}

test('chat history from the server renders on mount (user right, AI left)', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: (ctx) => mockChatApi(ctx),
  })
  try {
    await page.locator('#chat-list').waitFor()
    const messages = page.locator('[data-chat-message]')
    assert.equal(await messages.count(), 2)
    assert.equal(await messages.nth(0).getAttribute('data-chat-role'), 'user')
    assert.ok((await messages.nth(0).textContent()).includes('十月上旬海拉尔冷不冷？'))
    assert.equal(await messages.nth(1).getAttribute('data-chat-role'), 'assistant')
    assert.ok((await messages.nth(1).textContent()).includes('白天 8 度'))
    // No error banner on the happy path.
    assert.equal(await page.locator('#chat-error').count(), 0)
  } finally {
    await close()
  }
})

test('sending a message shows the user bubble, then the streamed AI reply; the input clears', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: (ctx) => mockChatApi(ctx),
  })
  try {
    await page.locator('#chat-input').waitFor()
    await page.locator('#chat-input').fill('莫尔格勒河要预约吗？')
    await page.locator('[data-action="chat-send"]').click()

    // The POST carried the typed content.
    // (Route assertions happen implicitly: the reply text echoes it.)

    await page.locator('text=这是圆周的回答。').waitFor()
    const messages = page.locator('[data-chat-message]')
    assert.equal(await messages.count(), 4, '2 history + 2 new messages')
    const newUser = messages.nth(2)
    assert.equal(await newUser.getAttribute('data-chat-role'), 'user')
    assert.ok((await newUser.textContent()).includes('莫尔格勒河要预约吗？'))
    const newAssistant = messages.nth(3)
    assert.equal(await newAssistant.getAttribute('data-chat-role'), 'assistant')
    assert.ok((await newAssistant.textContent()).includes('这是圆周的回答。'))

    // Input cleared, no banner.
    assert.equal(await page.locator('#chat-input').inputValue(), '')
    assert.equal(await page.locator('#chat-error').count(), 0)
  } finally {
    await close()
  }
})

test('reloading the workbench restores the conversation from the server history', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: (ctx) => mockChatApi(ctx),
  })
  try {
    await page.locator('#chat-list').waitFor()
    await page.reload()
    await page.locator('#chat-list').waitFor()
    const messages = page.locator('[data-chat-message]')
    await messages.nth(1).waitFor()
    assert.equal(await messages.count(), 2, 'history comes back from GET /messages')
    assert.ok((await messages.nth(1).textContent()).includes('白天 8 度'))
  } finally {
    await close()
  }
})

test('a stream error shows a banner with message + guidance instead of a reply', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    setup: (ctx) => mockChatApi(ctx, { failChat: true }),
  })
  try {
    await page.locator('#chat-input').waitFor()
    await page.locator('#chat-input').fill('你好')
    await page.locator('[data-action="chat-send"]').click()

    const banner = page.locator('#chat-error')
    await banner.waitFor()
    assert.ok((await banner.textContent()).includes('无法连接模型服务'))
    assert.ok((await banner.textContent()).includes('请确认 AI_BASE_URL 指向的服务可达后重试。'))
    // The user message stays (optimistic bubble), no assistant reply arrives.
    const messages = page.locator('[data-chat-message]')
    assert.equal(await messages.count(), 3, '2 history + 1 optimistic user message')
    assert.equal(await banner.getAttribute('data-chat-error'), 'model_unavailable')
  } finally {
    await close()
  }
})
