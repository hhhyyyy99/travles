// Ticket 07 — 澄清回合 (chips、POI 链接、思考/来源折叠、复制). Runs against
// the real Vite app with the trips/canvas/messages APIs mocked at the route
// level, asserting: persisted clarify rounds render chips + collapsibles from
// history, chip clicks send the chip value as the user's reply, a live
// clarify stream (start → delta → meta → done) renders chips, POI links
// focus the map placeholder, and the copy button copies via the clipboard.
const test = require('node:test')
const assert = require('node:assert/strict')
const { openApp } = require('../helpers/vite-app.cjs')

const TRIP_ID = 'trip-chat-clarify'

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

const CLARIFY_META = {
  round: 'clarify',
  chips: [
    { label: '🚗 自驾/租车自驾', value: '我们自驾出行' },
    { label: '✈️ 飞到当地后租车', value: '飞到海拉尔后租车' },
  ],
  poiLinks: [
    { name: '莫尔格勒河', lat: 49.4072, lng: 119.7478 },
    { name: '额尔古纳', lat: 50.2428, lng: 120.1909 },
  ],
  think: '用户未说明出行方式，这直接影响整体节奏，先澄清它。',
  thinkComplete: true,
  sources: [{ title: '呼伦贝尔自驾攻略', url: 'https://example.com/guide' }],
}

// A persisted clarify round: framework prose (with a POI name to be linked),
// one key-variable question, chips, think + sources.
const clarifyContent =
  '经典环线是海拉尔→**莫尔格勒河**→额尔古纳→满洲里→海拉尔。\n## 关键变量\n出行方式直接影响整体节奏，一次只问一个：\n- 出行方式是哪种？'

const clarifyAssistant = {
  id: 'a-clarify',
  tripId: TRIP_ID,
  role: 'assistant',
  content: clarifyContent,
  createdAt: '2026-09-12T01:00:01.000Z',
  think: CLARIFY_META.think,
  sources: CLARIFY_META.sources,
  meta: CLARIFY_META,
}

const historyPayload = {
  messages: [
    { id: 'm1', tripId: TRIP_ID, role: 'user', content: '我打算去呼伦贝尔玩 7 天', createdAt: '2026-09-12T01:00:00.000Z' },
    clarifyAssistant,
    { id: 'm3', tripId: TRIP_ID, role: 'user', content: '我们自驾出行', createdAt: '2026-09-12T02:00:00.000Z' },
    {
      id: 'a2',
      tripId: TRIP_ID,
      role: 'assistant',
      content: '好的，自驾最灵活。白天 8 度，早晚 0 度左右。',
      createdAt: '2026-09-12T02:00:01.000Z',
      think: null,
      sources: null,
      meta: null,
    },
  ],
}

function sseBody(events) {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}

function sseHeaders() {
  return { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
}

/** Stub the clipboard before app code runs; records the last copied text. */
const clipboardInit = `
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text) => { window.__copiedText = text; return Promise.resolve() } },
  })
`

/**
 * Mocks the workbench APIs. POST /messages answers with a live clarify
 * round: start(clarify) → deltas → meta → done, echoing the sent content.
 */
async function mockChatApi({ page }) {
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
    return route.fulfill({
      status: 200,
      headers: sseHeaders(),
      body: sseBody([
        ['start', { round: 'clarify' }],
        ['delta', { text: `收到：「${content}」。住宿上你想指定酒店吗？` }],
        ['meta', CLARIFY_META],
        [
          'done',
          {
            userMessage: { id: `u-${Math.random().toString(36).slice(2, 8)}`, tripId: TRIP_ID, role: 'user', content, createdAt: '2026-09-12T03:00:00.000Z' },
            assistantMessage: {
              id: `a-${Math.random().toString(36).slice(2, 8)}`,
              tripId: TRIP_ID,
              role: 'assistant',
              content: `收到：「${content}」。住宿上你想指定酒店吗？`,
              createdAt: '2026-09-12T03:00:01.000Z',
              think: CLARIFY_META.think,
              sources: CLARIFY_META.sources,
              meta: CLARIFY_META,
            },
          },
        ],
      ]),
    })
  })
}

test('a persisted clarify round renders framework text, chips and the collapsibles from history', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: clipboardInit,
    setup: (ctx) => mockChatApi(ctx),
  })
  try {
    await page.locator('#chat-list').waitFor()
    const clarifyBubble = page.locator('[data-chat-message][data-chat-round="clarify"]')
    await clarifyBubble.waitFor()
    // Framework text with bold prose; the POI name is an inline link.
    assert.ok((await clarifyBubble.textContent()).includes('经典环线'))
    assert.equal(await clarifyBubble.locator('[data-chat-poi-link="莫尔格勒河"]').count(), 1)
    // Clarify chips are present and clickable.
    assert.equal(await clarifyBubble.locator('[data-chat-chip]').count(), 2)
    // Collapsibles start collapsed and open on click.
    assert.equal(await clarifyBubble.locator('[data-chat-think]').count(), 1)
    assert.equal(await clarifyBubble.locator('[data-chat-think] summary').textContent(), '思考完成')
    assert.equal(await clarifyBubble.locator('[data-chat-sources]').count(), 1)
    await clarifyBubble.locator('[data-chat-think] summary').click()
    assert.ok((await clarifyBubble.locator('[data-chat-think]').textContent()).includes('先澄清它'))
    await clarifyBubble.locator('[data-chat-sources] summary').click()
    assert.ok((await clarifyBubble.locator('[data-chat-sources]').textContent()).includes('呼伦贝尔自驾攻略'))
    // Copy button exists on AI messages.
    assert.ok(await clarifyBubble.locator('[data-action="chat-copy"]').isVisible())
    // A qa-round message has neither chips nor collapsibles (hidden when absent).
    const qaBubble = page.locator('[data-chat-message]').filter({ hasText: '自驾最灵活' })
    assert.ok((await qaBubble.textContent()).includes('自驾最灵活'))
    assert.equal(await qaBubble.locator('[data-chat-chip]').count(), 0)
    assert.equal(await qaBubble.locator('[data-chat-think]').count(), 0)
    assert.equal(await qaBubble.locator('[data-chat-sources]').count(), 0)
  } finally {
    await close()
  }
})

test('clicking a chip sends the chip value as the user reply through the same SSE endpoint', async () => {
  let postedContent = null
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: clipboardInit,
    setup: async (ctx) => {
      await mockChatApi(ctx)
      await ctx.page.route('**/api/trips/*/messages', (route) => {
        const request = route.request()
        if (request.method() === 'POST') postedContent = JSON.parse(request.postData() ?? '{}').content ?? null
        return route.fallback()
      })
    },
  })
  try {
    await page.locator('#chat-list').waitFor()
    const chip = page.locator('[data-chat-chip="我们自驾出行"]')
    await chip.waitFor()
    await chip.click()
    // The POST carried the chip's value, and the optimistic user bubble shows it.
    assert.equal(postedContent, '我们自驾出行')
    await page.locator('[data-chat-message] >> text=住宿上你想指定酒店吗').first().waitFor()
    assert.ok(
      (await page.locator('[data-chat-role="user"]').last().textContent()).includes('我们自驾出行'),
      'the chip value becomes the user message',
    )
    // The live clarify round's meta rode the stream: chips render on the new
    // assistant bubble too.
    assert.ok((await page.locator('[data-chat-chip]').count()) >= 2)
  } finally {
    await close()
  }
})

test('clicking an inline POI link in an AI message focuses the map placeholder', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: clipboardInit,
    setup: (ctx) => mockChatApi(ctx),
  })
  try {
    await page.locator('#chat-list').waitFor()
    const poiLink = page.locator('[data-chat-poi-link="莫尔格勒河"]')
    await poiLink.waitFor()
    assert.equal(await page.locator('#map-focus-target').count(), 0, 'no focus target before the click')
    await poiLink.click()
    const target = page.locator('#map-focus-target')
    await target.waitFor()
    assert.equal(await target.getAttribute('data-map-focus'), '莫尔格勒河')
    assert.equal(await target.getAttribute('data-map-focus-lat'), '49.4072')
    assert.equal(await target.getAttribute('data-map-focus-lng'), '119.7478')
  } finally {
    await close()
  }
})

test('the copy button writes the raw message text to the clipboard', async () => {
  const { page, close } = await openApp({
    entry: `/?view=workbench&trip=${TRIP_ID}`,
    init: clipboardInit,
    setup: (ctx) => mockChatApi(ctx),
  })
  try {
    await page.locator('#chat-list').waitFor()
    const copy = page.locator('[data-chat-message][data-chat-round="clarify"] [data-action="chat-copy"]')
    await copy.waitFor()
    await copy.click()
    await page.locator('text=已复制').waitFor()
    const copied = await page.evaluate(() => window.__copiedText)
    assert.equal(copied, clarifyContent)
  } finally {
    await close()
  }
})
