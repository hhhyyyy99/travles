// Ticket 16 — end-to-end acceptance against a real HTTP/SSE backend:
// two isolated browser contexts converge after canvas and chat writes, a
// reconnect catches up from the server's ready revision, compact tabs preserve
// canvas/map linkage, and a 7-day x 20-card canvas can be dragged while route
// recomputation exposes its busy state.
const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { chromium } = require('playwright')
const { startViteApp } = require('../helpers/vite-app.cjs')

const repoRoot = path.resolve(__dirname, '../..')
const TSX_CLI = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const SERVER_ENTRY = path.join(repoRoot, 'server', 'src', 'index.ts')

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

function waitForHttp(url, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${url}`))
      setTimeout(attempt, 150)
    }
    const attempt = () => {
      const request = http.get(url, (response) => {
        response.resume()
        if (response.statusCode < 500) return resolve()
        retry()
      })
      request.on('error', retry)
      request.setTimeout(2000, () => {
        request.destroy()
        retry()
      })
    }
    attempt()
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Local OpenAI-compatible stand-in; the business server still owns the SSE stream. */
async function startModelStub() {
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk.toString()
    })
    request.on('end', () => {
      let prompt = ''
      try {
        const messages = JSON.parse(body).messages
        const last = Array.isArray(messages) ? messages[messages.length - 1] : null
        prompt = typeof last?.content === 'string' ? last.content : ''
      } catch {
        // The response remains deterministic even if the provider request is malformed.
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-ticket16',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'ticket16-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      response.write(chunk({ role: 'assistant', content: '' }))
      response.write(chunk({ content: `测试服务回复：${prompt}` }))
      response.write(chunk({}, 'stop'))
      response.write('data: [DONE]\n\n')
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

async function startBackend(model) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'journey-ticket16-'))
  const port = await freePort()
  const child = spawn(process.execPath, [TSX_CLI, SERVER_ENTRY], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SERVER_PORT: String(port),
      TRIPS_DB_PATH: path.join(dataDir, 'trips.db'),
      AI_BASE_URL: model.url,
      AI_API_KEY: 'ticket16-test-key',
      AI_MODEL: 'ticket16-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  child.stdout.on('data', (chunk) => (logs += chunk.toString()))
  child.stderr.on('data', (chunk) => (logs += chunk.toString()))
  let exited = false
  const stopped = new Promise((resolve) => {
    child.once('exit', () => {
      exited = true
      resolve()
    })
    child.once('error', () => {
      exited = true
      resolve()
    })
  })
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    await waitForHttp(`${baseUrl}/api/health`)
  } catch (error) {
    if (!exited) child.kill('SIGTERM')
    await stopped
    await rm(dataDir, { recursive: true, force: true })
    throw new Error(`${error.message}\nbackend logs:\n${logs}`)
  }
  return {
    baseUrl,
    port,
    close: async () => {
      if (!exited) child.kill('SIGTERM')
      await stopped
      await rm(dataDir, { recursive: true, force: true })
    },
  }
}

async function api(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers ?? {}) },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${pathname} failed (${response.status}): ${JSON.stringify(body)}`)
  }
  return body
}

function jsonBody(value) {
  return JSON.stringify(value)
}

function dateForDay(index) {
  return new Date(Date.UTC(2026, 9, 2 + index)).toISOString().slice(0, 10)
}

async function createTrip(baseUrl, title, dayCount) {
  const created = await api(baseUrl, '/api/trips', {
    method: 'POST',
    body: jsonBody({ title, startDate: dateForDay(0), endDate: dateForDay(dayCount - 1) }),
  })
  const trip = created.trip
  const days = []
  for (let index = 0; index < dayCount; index += 1) {
    const result = await api(baseUrl, `/api/trips/${trip.id}/days`, {
      method: 'POST',
      body: jsonBody({ date: dateForDay(index), theme: `第 ${index + 1} 天` }),
    })
    days.push(result.day)
  }
  return { ...trip, days }
}

async function createItem(baseUrl, tripId, dayId, input) {
  const result = await api(baseUrl, `/api/trips/${tripId}/items`, {
    method: 'POST',
    body: jsonBody({ dayId, ...input }),
  })
  return result.item
}

async function seedSmallTrip(baseUrl) {
  const trip = await createTrip(baseUrl, 'ticket16 跨端同步', 2)
  const focusItem = await createItem(baseUrl, trip.id, trip.days[0].id, {
    type: 'attraction',
    title: '海拉尔观景点',
    note: '同步前备注',
    poi: {
      amapId: 'ticket16-poi-1',
      name: '海拉尔观景点',
      lat: 49.21,
      lng: 119.76,
      category: '景点',
      rating: 4.8,
      introSummary: '用于验收画布与地图聚焦。',
    },
  })
  await createItem(baseUrl, trip.id, trip.days[0].id, {
    type: 'attraction',
    title: '草原日落点',
    note: '',
    poi: {
      amapId: 'ticket16-poi-2',
      name: '草原日落点',
      lat: 49.32,
      lng: 119.88,
      category: '景点',
      rating: 4.6,
      introSummary: '',
    },
  })
  await createItem(baseUrl, trip.id, trip.days[1].id, {
    type: 'other',
    title: '第二天自由活动',
    note: '',
  })
  return { ...trip, focusItemId: focusItem.id }
}

async function seedLargeTrip(baseUrl) {
  const trip = await createTrip(baseUrl, 'ticket16 大画布性能验收', 7)
  const bulkItems = []
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayId = trip.days[dayIndex].id
    for (let cardIndex = 0; cardIndex < 18; cardIndex += 1) {
      bulkItems.push({
        id: `ticket16-item-${dayIndex}-${cardIndex}`,
        dayId,
        itemOrder: cardIndex,
        type: 'other',
        title: `第 ${dayIndex + 1} 天活动 ${cardIndex + 1}`,
        note: '',
      })
    }
  }
  await api(baseUrl, `/api/trips/${trip.id}/items`, {
    method: 'PUT',
    body: jsonBody({ items: bulkItems }),
  })

  const poiItems = []
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const dayId = trip.days[dayIndex].id
    poiItems.push(
      await createItem(baseUrl, trip.id, dayId, {
        type: 'attraction',
        title: `第 ${dayIndex + 1} 天 POI A`,
        note: '',
        poi: {
          amapId: `ticket16-large-poi-a-${dayIndex}`,
          name: `第 ${dayIndex + 1} 天 POI A`,
          lat: 49.2 + dayIndex * 0.08,
          lng: 119.7 + dayIndex * 0.1,
          category: '景点',
          rating: 4.5,
          introSummary: '',
        },
      }),
      await createItem(baseUrl, trip.id, dayId, {
        type: 'attraction',
        title: `第 ${dayIndex + 1} 天 POI B`,
        note: '',
        poi: {
          amapId: `ticket16-large-poi-b-${dayIndex}`,
          name: `第 ${dayIndex + 1} 天 POI B`,
          lat: 49.23 + dayIndex * 0.08,
          lng: 119.74 + dayIndex * 0.1,
          category: '景点',
          rating: 4.4,
          introSummary: '',
        },
      }),
    )
  }
  return { ...trip, sourceItemId: poiItems[1].id, targetItemId: 'ticket16-item-0-0' }
}

async function preparePage(page, vite, { blockEvents = false, delayMoveTripId = null } = {}) {
  page.setDefaultTimeout(12000)
  await page.route('**/*', (route) =>
    route.request().url().startsWith(vite.url) ? route.continue() : route.abort(),
  )
  let eventAttempts = 0
  let eventsBlocked = blockEvents
  if (blockEvents) {
    await page.route('**/api/trips/*/events', (route) => {
      eventAttempts += 1
      if (eventsBlocked) return route.abort()
      return route.fallback()
    })
  }
  if (delayMoveTripId !== null) {
    await page.route(`**/api/trips/${delayMoveTripId}/items/*/move`, async (route) => {
      const response = await route.fetch()
      await delay(800)
      await route.fulfill({ response })
    })
  }
  return {
    eventAttempts: () => eventAttempts,
    setEventsBlocked: (blocked) => {
      eventsBlocked = blocked
    },
  }
}

async function openPage(browser, vite, tripId, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 900 } })
  const page = await context.newPage()
  const eventControl = await preparePage(page, vite, options)
  await page.goto(`${vite.url}/?view=workbench&trip=${encodeURIComponent(tripId)}`)
  return { context, page, ...eventControl }
}

async function dispatchDrop(page, sourceId, targetId) {
  await page.evaluate(
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

test('ticket 16 real backend/SSE acceptance: sync, reconnect, compact tabs, and large canvas', async () => {
  let model
  let backend
  let vite
  let browser
  const contexts = []
  try {
    model = await startModelStub()
    backend = await startBackend(model)
    const smallTrip = await seedSmallTrip(backend.baseUrl)
    const largeTrip = await seedLargeTrip(backend.baseUrl)
    vite = await startViteApp({ serverPort: backend.port })
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    })

    // Separate browser contexts have independent localStorage/cookies while
    // sharing the same real server and process-local TripEventHub.
    const a = await openPage(browser, vite, smallTrip.id)
    contexts.push(a.context)
    const b = await openPage(browser, vite, smallTrip.id)
    contexts.push(b.context)
    await Promise.all([
      a.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).waitFor(),
      b.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).waitFor(),
    ])
    await b.page.locator('#chat-list').waitFor()

    const remoteNote = 'A 端写入，B 端应在秒级看到'
    await a.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"] [data-card-note-edit]`).click()
    await a.page.locator('[data-card-note-input]').fill(remoteNote)
    await a.page.locator('[data-action="save-note"]').click()
    await b.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).getByText(remoteNote).waitFor()

    await a.page.locator('#chat-input').fill('请给这次验收一句建议')
    await a.page.locator('[data-action="chat-send"]').click()
    await a.page.getByText('测试服务回复：请给这次验收一句建议').waitFor()
    await b.page.getByText('测试服务回复：请给这次验收一句建议').waitFor()
    assert.equal(await a.page.locator('[data-chat-message][data-chat-role="assistant"]').count(), 1, 'local SSE done and chat event refresh do not duplicate the reply')
    assert.equal(await b.page.locator('[data-chat-message][data-chat-role="assistant"]').count(), 1, 'remote chat history contains one persisted reply')

    // Force both EventSource instances in a fresh context to miss the first
    // connection. The server's ready revision on reconnect must trigger a
    // canvas refetch, otherwise this assertion remains on the old note.
    await a.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"] [data-card-note-edit]`).click()
    await a.page.locator('[data-card-note-input]').fill('断线回归的初始备注')
    await a.page.locator('[data-action="save-note"]').click()
    await a.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).getByText('断线回归的初始备注').waitFor()

    const reconnect = await openPage(browser, vite, smallTrip.id, { blockEvents: true })
    contexts.push(reconnect.context)
    await reconnect.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).getByText('断线回归的初始备注').waitFor()
    await delay(250)
    assert.ok(reconnect.eventAttempts() > 0, 'the reconnect fixture observed at least one blocked EventSource request')

    const recoveredNote = '断线期间提交，重连后应补齐'
    await a.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"] [data-card-note-edit]`).click()
    await a.page.locator('[data-card-note-input]').fill(recoveredNote)
    await a.page.locator('[data-action="save-note"]').click()
    await delay(1000)
    assert.ok(
      (await reconnect.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).textContent()).includes('断线回归的初始备注'),
      'the canvas stays stale while every EventSource request is blocked',
    )
    reconnect.setEventsBlocked(false)
    await reconnect.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).getByText(recoveredNote).waitFor({ timeout: 11000 })

    // Compact mode mounts one stateful panel at a time and still lets the
    // canvas card focus the map POI after the map tab is opened.
    const mobile = await openPage(browser, vite, smallTrip.id, { viewport: { width: 800, height: 900 } })
    contexts.push(mobile.context)
    await mobile.page.locator('[data-workbench-mode="tabs"]').waitFor()
    assert.equal(await mobile.page.locator('#workbench-column-ai').count(), 0)
    assert.equal(await mobile.page.locator('#workbench-column-map').count(), 0)
    assert.ok(await mobile.page.locator('#workbench-column-canvas').isVisible())
    await mobile.page.locator('[data-workbench-mobile-tab="chat"]').click()
    assert.ok(await mobile.page.locator('#workbench-column-ai').isVisible())
    assert.equal(await mobile.page.locator('#workbench-column-canvas').count(), 0)
    await mobile.page.locator('[data-workbench-mobile-tab="canvas"]').click()
    await mobile.page.locator(`[data-canvas-card="${smallTrip.focusItemId}"]`).click()
    await mobile.page.locator('[data-workbench-mobile-tab="map"]').click()
    await mobile.page.locator('#workbench-map').waitFor()
    await mobile.page.locator('#workbench-poi-detail').waitFor()
    assert.equal(await mobile.page.locator('[data-poi-detail-name]').textContent(), '海拉尔观景点')
    assert.equal(await mobile.page.locator('[data-map-mode]').getAttribute('data-map-mode'), 'focus')
    assert.match(await mobile.page.locator('[data-reference-disclaimer]').textContent(), /信息仅供参考/)

    // Build the large fixture through the real write API, then drag an item
    // across a 140-card DOM. The delayed response makes the route-loading
    // indicator observable while the server has already recomputed its legs.
    const heavy = await openPage(browser, vite, largeTrip.id, { delayMoveTripId: largeTrip.id })
    contexts.push(heavy.context)
    await heavy.page.locator('#workbench-topbar').waitFor()
    await heavy.page.locator(`[data-canvas-card="${largeTrip.sourceItemId}"]`).waitFor()
    assert.equal(await heavy.page.locator('[data-canvas-day]').count(), 7)
    assert.equal(await heavy.page.locator('[data-canvas-card]').count(), 140)
    await heavy.page.locator('path.wb-route').first().waitFor()

    const moveResponse = heavy.page.waitForResponse(
      (response) => response.request().method() === 'POST' && response.url().includes(`/items/${largeTrip.sourceItemId}/move`),
    )
    const dragStarted = Date.now()
    await dispatchDrop(heavy.page, largeTrip.sourceItemId, largeTrip.targetItemId)
    await heavy.page.locator('[data-canvas-syncing]').waitFor()
    const response = await moveResponse
    const recomputed = await response.json()
    assert.equal(response.status(), 200)
    assert.equal(recomputed.legs.length, 139, 'the backend returned 133 intra-day legs plus 6 consecutive-day bridges')
    await heavy.page.waitForFunction(
      ({ sourceId, targetId }) => {
        const firstDay = document.querySelector('[data-canvas-day]')
        const ids = firstDay ? [...firstDay.querySelectorAll('[data-canvas-card]')].map((node) => node.getAttribute('data-canvas-card')) : []
        return ids[0] === sourceId && ids[1] === targetId
      },
      { sourceId: largeTrip.sourceItemId, targetId: largeTrip.targetItemId },
    )
    await heavy.page.locator('[data-canvas-syncing]').waitFor({ state: 'detached' })
    assert.ok(Date.now() - dragStarted < 5000, 'large-canvas drag settles promptly')
  } finally {
    for (const context of contexts.reverse()) await context.close().catch(() => {})
    await browser?.close().catch(() => {})
    await vite?.close().catch(() => {})
    await backend?.close().catch(() => {})
    await model?.close().catch(() => {})
  }
})
