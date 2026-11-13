// Real Chromium + Vite clients + production SQLite/Hono HTTP/SSE; no API or EventSource mocks.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { openApp } = require('../helpers/vite-app.cjs')

const root = path.resolve(__dirname, '../..')
const tripId = 'leg-metrics-trip'
const dayId = 'leg-metrics-day'
const canvasPath = `/api/trips/${tripId}/canvas`
const dayPath = `/api/trips/${tripId}/days/${dayId}`
const metricFields = ['distanceMeters', 'durationSeconds', 'formattedDistance', 'formattedDuration']
const rawDayTitle = '\t  独立的当天标题  \n'
const rawDayNote = '\n  独立的当天备注\t '
const geometry = [[104.06, 30.66], [104.07, 30.67]]

// Literal expectations from the contract, independent of the fixture/server projection code.
const cases = [
  { id: 'normal', distanceKm: 12.5, durationMin: 23.75, quality: 'measured', geometry: true,
    metrics: { distanceMeters: 12500, durationSeconds: 1425, formattedDistance: '12.5 千米', formattedDuration: '23.75 分钟' } },
  { id: 'fractional', distanceKm: 0.123046875, durationMin: 0.5078125, quality: 'reference',
    metrics: { distanceMeters: 123.046875, durationSeconds: 30.46875, formattedDistance: '0.123046875 千米', formattedDuration: '0.5078125 分钟' } },
  { id: 'zero-measured', distanceKm: 0, durationMin: 0, quality: 'measured',
    metrics: { distanceMeters: 0, durationSeconds: 0, formattedDistance: '0 千米', formattedDuration: '0 分钟' } },
  { id: 'zero-estimate', distanceKm: 0, durationMin: 0, quality: 'estimate',
    metrics: { distanceMeters: 0, durationSeconds: 0, formattedDistance: '0 千米', formattedDuration: '0 分钟' } },
  { id: 'zero-reference', distanceKm: 0, durationMin: 0, quality: 'reference',
    metrics: { distanceMeters: 0, durationSeconds: 0, formattedDistance: '0 千米', formattedDuration: '0 分钟' } },
  { id: 'zero-pending', distanceKm: 0, durationMin: 0, quality: 'pending', metrics: {} },
  { id: 'zero-pending-geometry', distanceKm: 0, durationMin: 0, quality: 'pending', geometry: true, metrics: {} },
  { id: 'zero-legacy', distanceKm: 0, durationMin: 0, quality: 'pending', metrics: {} },
  { id: 'zero-legacy-empty-quality', distanceKm: 0, durationMin: 0, quality: 'pending', metrics: {} },
  { id: 'zero-legacy-geometry', distanceKm: 0, durationMin: 0, quality: 'pending', geometry: true,
    metrics: { distanceMeters: 0, durationSeconds: 0, formattedDistance: '0 千米', formattedDuration: '0 分钟' } },
  { id: 'zero-unknown-quality', distanceKm: 0, durationMin: 0, quality: 'pending', metrics: {} },
  { id: 'null', distanceKm: 0, durationMin: 0, quality: 'pending', metrics: {} },
  { id: 'text', distanceKm: 0, durationMin: 0, quality: 'measured', metrics: {} },
  { id: 'blob', distanceKm: 0, durationMin: 0, quality: 'measured', metrics: {} },
  { id: 'negative', distanceKm: -1.25, durationMin: -2.5, quality: 'measured', metrics: {} },
  { id: 'infinity', distanceKm: 0, durationMin: 0, quality: 'measured', metrics: {} },
  { id: 'overflow', distanceKm: 1e308, durationMin: 1e308, quality: 'measured', metrics: {} },
  { id: 'distance-only', distanceKm: 2.75, durationMin: 0, quality: 'estimate',
    metrics: { distanceMeters: 2750, formattedDistance: '2.75 千米' } },
  { id: 'duration-only', distanceKm: 0, durationMin: 3.125, quality: 'estimate',
    metrics: { durationSeconds: 187.5, formattedDuration: '3.125 分钟' } },
  { id: 'text-distance', distanceKm: 0, durationMin: 4.375, quality: 'measured',
    metrics: { durationSeconds: 262.5, formattedDuration: '4.375 分钟' } },
  { id: 'text-duration', distanceKm: 5.125, durationMin: 0, quality: 'measured',
    metrics: { distanceMeters: 5125, formattedDistance: '5.125 千米' } },
  { id: 'blob-distance', distanceKm: 0, durationMin: 6.25, quality: 'measured',
    metrics: { durationSeconds: 375, formattedDuration: '6.25 分钟' } },
  { id: 'blob-duration', distanceKm: 7.375, durationMin: 0, quality: 'measured',
    metrics: { distanceMeters: 7375, formattedDistance: '7.375 千米' } },
  { id: 'negative-distance', distanceKm: -1, durationMin: 8.5, quality: 'measured',
    metrics: { durationSeconds: 510, formattedDuration: '8.5 分钟' } },
  { id: 'negative-duration', distanceKm: 9.625, durationMin: -1, quality: 'measured',
    metrics: { distanceMeters: 9625, formattedDistance: '9.625 千米' } },
  { id: 'infinite-distance', distanceKm: 0, durationMin: 10.75, quality: 'measured',
    metrics: { durationSeconds: 645, formattedDuration: '10.75 分钟' } },
  { id: 'infinite-duration', distanceKm: 11.875, durationMin: 0, quality: 'measured',
    metrics: { distanceMeters: 11875, formattedDistance: '11.875 千米' } },
  { id: 'overflow-distance', distanceKm: 1e306, durationMin: 12.125, quality: 'measured',
    metrics: { durationSeconds: 727.5, formattedDuration: '12.125 分钟' } },
  { id: 'overflow-duration', distanceKm: 13.25, durationMin: 1e307, quality: 'measured',
    metrics: { distanceMeters: 13250, formattedDistance: '13.25 千米' } },
  { id: 'zero-distance-invalid-duration', distanceKm: 0, durationMin: 0, quality: 'measured',
    metrics: { distanceMeters: 0, formattedDistance: '0 千米' } },
  { id: 'invalid-distance-zero-duration', distanceKm: 0, durationMin: 0, quality: 'measured',
    metrics: { durationSeconds: 0, formattedDuration: '0 分钟' } },
]

async function startBackend() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/leg-metrics-server.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AMAP_WEB_KEY: '', AI_API_KEY: '' },
  })
  let logs = ''
  let exited = false
  const stopped = new Promise((resolve) => {
    child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) })
    child.once('error', () => { exited = true; resolve({ code: null, signal: null }) })
  })
  const close = async () => {
    if (!exited) child.kill('SIGTERM')
    const result = await stopped
    assert.equal(result.code, 0, `Fixture server did not close cleanly: ${JSON.stringify(result)}\n${logs}`)
  }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend startup timeout: ' + logs)), 20000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Backend exited: ' + logs)) })
      child.stdout.on('data', (chunk) => {
        logs += chunk.toString()
        const match = logs.match(/READY (\d+)/)
        if (match) { clearTimeout(timer); resolve(Number(match[1])) }
      })
      child.stderr.on('data', (chunk) => { logs += chunk.toString() })
    })
    return { port, close, url: 'http://127.0.0.1:' + port }
  } catch (error) {
    if (!exited) child.kill('SIGTERM')
    await stopped
    throw error
  }
}

function assertMetrics(canvas, label) {
  assert.equal(canvas.legs.length, cases.length, label + ': every seeded leg survives')
  const legs = new Map(canvas.legs.map((leg) => [leg.id, leg]))
  assert.equal(legs.size, cases.length, label + ': leg IDs stay unique')
  for (const [index, expected] of cases.entries()) {
    const leg = legs.get(expected.id)
    assert.ok(leg, label + ': ' + expected.id)
    const suppliedMetrics = Object.fromEntries(metricFields.filter((key) => Object.hasOwn(leg, key)).map((key) => [key, leg[key]]))
    assert.deepEqual(suppliedMetrics, expected.metrics, label + ': source projections for ' + expected.id)
    assert.deepEqual(Object.fromEntries(Object.entries(leg).filter(([key]) => !metricFields.includes(key))), {
      id: expected.id, fromItemId: `leg-metrics-item-${index}`, toItemId: `leg-metrics-item-${index + 1}`,
      mode: 'drive', distanceKm: expected.distanceKm, durationMin: expected.durationMin,
      polyline: expected.geometry ? geometry : null, quality: expected.quality,
    }, label + ': unchanged legacy fields for ' + expected.id)
  }
}

function assertMetadata(canvas, theme, label) {
  // Existing dated-day writes legitimately refresh updatedAt via schedule synchronization.
  const { updatedAt, ...stableTrip } = canvas.trip
  assert.ok(Number.isFinite(Date.parse(updatedAt)), label + ': valid Trip update timestamp')
  assert.deepEqual(stableTrip, {
    id: tripId, title: 'Leg metrics browser regression', startDate: '2026-10-02', endDate: '2026-10-04',
    days: 3, nights: 2, daysCount: 3, createdAt: '2026-09-01T00:00:00.000Z',
    coverImage: '', isPinned: false, status: '\t  原始行程状态  \n', destination: '成都', durationDays: 9, dateStatus: 'confirmed',
    planningContext: { destination: '成都', durationDays: 9, preferences: '慢游', originalSentence: '成都九天慢游',
      dateStatus: 'confirmed', datePhrase: '2026-10-02 至 2026-10-04' },
  }, label + ': Trip metadata and schedule projections from #15–18')
  assert.equal(canvas.days.length, 3)
  for (const [index, day] of canvas.days.entries()) {
    assert.equal(day.tripId, tripId, label + ': explicit Day trip identity')
    assert.equal(day.dayNumber, index + 1, label + ': explicit Day number')
    assert.equal(day.index, index)
    assert.equal(day.date, ['2026-10-02', '2026-10-03', '2026-10-04'][index])
    assert.equal(day.color, '#3f7d5c')
  }
  const [day, empty, legacy] = canvas.days
  assert.equal(day.id, dayId)
  assert.equal(day.theme, theme)
  assert.equal(day.title, rawDayTitle, label + ': independent raw Day title')
  assert.equal(day.note, rawDayNote, label + ': independent raw Day note')
  assert.equal(day.items.length, cases.length + 1)
  assert.ok(day.items.every((item) => item.note === '活动备注与当天备注独立' && item.poi === null))
  assert.equal(empty.id, 'leg-metrics-empty-day')
  assert.equal(empty.title, '')
  assert.equal(empty.note, '')
  assert.equal(legacy.id, 'leg-metrics-legacy-day')
  assert.equal(Object.hasOwn(legacy, 'title'), false, label + ': absent legacy Day title stays absent')
  assert.equal(Object.hasOwn(legacy, 'note'), false, label + ': absent legacy Day note stays absent')
}

// Observe native EventSource via CDP without replacing EventSource, fetch or API responses.
function waitForTripEvent(cdp, name, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off('Network.eventSourceMessageReceived', receive)
      reject(new Error('Timed out waiting for real ' + name + ' event'))
    }, 8000)
    const receive = (event) => {
      if (event.eventName !== name) return
      let data
      try { data = JSON.parse(event.data) } catch { return }
      if (data.tripId !== tripId || !predicate(data)) return
      clearTimeout(timer)
      cdp.off('Network.eventSourceMessageReceived', receive)
      resolve(data)
    }
    cdp.on('Network.eventSourceMessageReceived', receive)
  })
}

function waitForCanvas(page, theme) {
  return page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== canvasPath || response.request().method() !== 'GET') return false
    if (theme === undefined) return true
    return (await response.json()).days.some((day) => day.id === dayId && day.theme === theme)
  })
}

async function readBrowserCanvas(page) {
  const wireResponse = waitForCanvas(page)
  const [client, response] = await Promise.all([
    page.evaluate(async (id) => {
      const { fetchTripCanvas } = await import('/src/domain/workbench.ts')
      const result = await fetchTripCanvas(id)
      if (!result.ok) throw new Error(result.error)
      return result.data
    }, tripId),
    wireResponse,
  ])
  assert.equal(response.status(), 200)
  const wire = await response.json()
  assert.deepEqual(client, wire, 'the actual browser client preserves the complete source wire canvas')
  return { client, wire }
}

test('real browser keeps optional Leg source metrics and Trip/Day metadata through theme editing and an SSE canvas refetch', async () => {
  const backend = await startBackend()
  let app
  let cdp
  try {
    // Dev mode serves the real client source modules even when the wider suite requests preview mode.
    app = await openApp({ mode: 'dev', entry: '/?view=trips', serverPort: backend.port, amapConfig404: true })
    const { page } = app
    await page.locator('#trip-intake-input').waitFor()
    const initial = await readBrowserCanvas(page)
    assertMetrics(initial.wire, 'raw HTTP canvas')
    assertMetrics(initial.client, 'browser fetchTripCanvas')
    assertMetadata(initial.client, '原始主题', 'initial canvas')

    cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    const ready = waitForTripEvent(cdp, 'ready')
    const initialWorkbench = waitForCanvas(page)
    const [, , initialResponse] = await Promise.all([
      page.goto(app.url + '/?view=workbench&trip=' + tripId), ready, initialWorkbench,
    ])
    assert.equal(initialResponse.status(), 200)
    assert.deepEqual(await initialResponse.json(), initial.wire, 'Workbench starts with the same projected source canvas')
    const dayColumn = page.locator(`[data-canvas-day="${dayId}"]`)
    await dayColumn.getByText('原始主题', { exact: true }).waitFor()
    await dayColumn.locator('[data-action="edit-theme"]').click()
    const themeInput = dayColumn.locator('[data-input="theme-edit"]')
    assert.equal(await themeInput.inputValue(), '原始主题')
    const uiTheme = '界面保存的主题'
    await themeInput.fill(uiTheme)
    const themeSaved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === dayPath && response.request().method() === 'PATCH')
    await themeInput.press('Enter')
    const saved = await themeSaved
    assert.equal(saved.status(), 200)
    assert.deepEqual(saved.request().postDataJSON(), { theme: uiTheme })
    const savedDay = (await saved.json()).day
    assert.equal(savedDay.title, rawDayTitle)
    assert.equal(savedDay.note, rawDayNote)
    await dayColumn.getByText(uiTheme, { exact: true }).waitFor()
    const afterUi = await readBrowserCanvas(page)
    assertMetrics(afterUi.client, 'after existing theme editor save')
    assertMetadata(afterUi.client, uiTheme, 'after existing theme editor save')
    assert.deepEqual(afterUi.wire.legs, initial.wire.legs)

    const externalTheme = '外部更新后通过真实事件同步的主题'
    const updated = waitForTripEvent(cdp, 'trip.updated', (event) => event.kind === 'canvas' && event.reason === 'day_updated')
    const refetched = waitForCanvas(page, externalTheme)
    // An out-of-browser write cannot update this page locally: the native SSE stream must invalidate Workbench.
    const [patched, event, canvasResponse] = await Promise.all([
      fetch(backend.url + dayPath, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: externalTheme }),
      }),
      updated,
      refetched,
    ])
    assert.equal(patched.status, 200)
    assert.equal(event.kind, 'canvas')
    assert.equal(event.reason, 'day_updated')
    assert.equal(canvasResponse.status(), 200)
    const refreshed = await canvasResponse.json()
    assertMetrics(refreshed, 'real SSE-triggered Workbench HTTP refetch')
    assertMetadata(refreshed, externalTheme, 'real SSE-triggered Workbench HTTP refetch')
    assert.deepEqual(refreshed.legs, initial.wire.legs, 'theme invalidation never rewrites Leg values or optional projections')
    await dayColumn.getByText(externalTheme, { exact: true }).waitFor()
    const final = await readBrowserCanvas(page)
    assert.deepEqual(final.wire, refreshed)
    assertMetrics(final.client, 'browser client after committed SSE snapshot')
    assertMetadata(final.client, externalTheme, 'browser client after committed SSE snapshot')
  } finally {
    try { await cdp?.detach() } finally {
      try { await app?.close() } finally { await backend.close() }
    }
  }
})
