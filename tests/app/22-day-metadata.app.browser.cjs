// Real Chromium + Vite clients + isolated SQLite/HTTP/SSE, with no API or EventSource mocks.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { openApp } = require('../helpers/vite-app.cjs')

const root = path.resolve(__dirname, '../..')
const rawMetadata = { title: '\t  独立的当天标题  \n', note: '\n  独立的当天备注\t ' }

async function startBackend() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/guide-import-server.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AMAP_WEB_KEY: '', AI_API_KEY: '' },
  })
  let logs = ''
  const stopped = new Promise((resolve) => child.once('exit', resolve))
  const close = async () => { child.kill('SIGTERM'); await stopped }
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
  } catch (error) { await close(); throw error }
}

// Observe Chromium's actual EventSource traffic without replacing its implementation.
function waitForTripEvent(cdp, name, tripId, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off('Network.eventSourceMessageReceived', receive)
      reject(new Error(`Timed out waiting for real ${name} event for ${tripId}`))
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

test('real browser preserves Day metadata through client writes, theme editing and an SSE canvas refresh', async () => {
  const backend = await startBackend()
  let app
  try {
    // Source-module imports intentionally run in dev mode, including under APP_MODE=preview.
    app = await openApp({ mode: 'dev', entry: '/?view=trips', serverPort: backend.port, amapConfig404: true })
    const { page } = app
    await page.locator('#trip-intake-input').waitFor()
    const results = await page.evaluate(async (metadata) => {
      const [{ createTrip }, { createWorkbenchDay, updateWorkbenchDay, fetchTripCanvas }] = await Promise.all([
        import('/src/domain/tripList.ts'), import('/src/domain/workbench.ts'),
      ])
      const unwrap = (result) => {
        if (!result.ok) throw new Error(result.error)
        return result.data
      }
      const trip = unwrap(await createTrip({ title: 'Day metadata browser regression', startDate: '2026-10-02', endDate: '2026-10-02' }))
      const created = unwrap(await createWorkbenchDay(trip.id, { ...metadata, theme: '原始主题' }))
      const empty = unwrap(await createWorkbenchDay(trip.id, { title: '', note: '', theme: '空元数据主题' }))
      const omitted = unwrap(await createWorkbenchDay(trip.id, { theme: '旧格式主题' }))
      const cleared = unwrap(await updateWorkbenchDay(trip.id, created.id, { note: '' }))
      const restored = unwrap(await updateWorkbenchDay(trip.id, created.id, { note: metadata.note }))
      const canvas = unwrap(await fetchTripCanvas(trip.id))
      return { trip, created, empty, omitted, cleared, restored, canvas }
    }, rawMetadata)
    const { trip, created, empty, omitted, cleared, restored, canvas } = results
    assert.equal(created.title, rawMetadata.title)
    assert.equal(created.note, rawMetadata.note)
    assert.equal(cleared.title, rawMetadata.title, 'omitting title during note update preserves it')
    assert.equal(cleared.note, '')
    assert.equal(restored.title, rawMetadata.title)
    assert.equal(restored.note, rawMetadata.note)
    assert.equal(empty.title, '')
    assert.equal(empty.note, '')
    assert.equal(Object.hasOwn(omitted, 'title'), false)
    assert.equal(Object.hasOwn(omitted, 'note'), false)
    assert.deepEqual(canvas.days.find((day) => day.id === created.id), restored)
    assert.deepEqual(canvas.days.find((day) => day.id === empty.id), empty)
    assert.deepEqual(canvas.days.find((day) => day.id === omitted.id), omitted)

    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    const ready = waitForTripEvent(cdp, 'ready', trip.id)
    await Promise.all([page.goto(app.url + '/?view=workbench&trip=' + encodeURIComponent(trip.id)), ready])
    const dayColumn = page.locator(`[data-canvas-day="${created.id}"]`)
    await dayColumn.getByText('原始主题', { exact: true }).waitFor()
    await dayColumn.locator('[data-action="edit-theme"]').click()
    const themeInput = dayColumn.locator('[data-input="theme-edit"]')
    assert.equal(await themeInput.inputValue(), '原始主题', 'theme editor starts from theme even with an independent Day title')
    const uiTheme = '界面保存的主题'
    await themeInput.fill(uiTheme)
    const dayPath = `/api/trips/${trip.id}/days/${created.id}`
    const themeSaved = page.waitForResponse((response) =>
      new URL(response.url()).pathname === dayPath && response.request().method() === 'PATCH')
    await themeInput.press('Enter')
    const themeResponse = await themeSaved
    assert.equal(themeResponse.status(), 200)
    assert.deepEqual(themeResponse.request().postDataJSON(), { theme: uiTheme })
    const themeDay = (await themeResponse.json()).day
    assert.equal(themeDay.theme, uiTheme)
    assert.equal(themeDay.title, rawMetadata.title)
    assert.equal(themeDay.note, rawMetadata.note)
    await dayColumn.getByText(uiTheme, { exact: true }).waitFor()

    const external = { title: '', note: '\t  外部保存的日备注  \n', theme: '外部更新后自动同步的主题' }
    const updated = waitForTripEvent(cdp, 'trip.updated', trip.id,
      (event) => event.kind === 'canvas' && event.reason === 'day_updated')
    const refetched = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== `/api/trips/${trip.id}/canvas` || response.request().method() !== 'GET') return false
      const payload = await response.json()
      return payload.days.some((day) => day.id === created.id && day.theme === external.theme)
    })
    // Node writes directly to the isolated backend, so only the real SSE stream can invalidate this page.
    const [patched, event, canvasResponse] = await Promise.all([
      fetch(backend.url + dayPath, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(external),
      }),
      updated,
      refetched,
    ])
    assert.equal(patched.status, 200)
    assert.equal(event.kind, 'canvas')
    const refreshedDay = (await canvasResponse.json()).days.find((day) => day.id === created.id)
    assert.equal(refreshedDay.title, '')
    assert.equal(refreshedDay.note, external.note)
    assert.equal(refreshedDay.theme, external.theme)
    await dayColumn.getByText(external.theme, { exact: true }).waitFor()

    const finalCanvas = await page.evaluate(async (tripId) => {
      const { fetchTripCanvas } = await import('/src/domain/workbench.ts')
      const result = await fetchTripCanvas(tripId)
      if (!result.ok) throw new Error(result.error)
      return result.data
    }, trip.id)
    assert.deepEqual(finalCanvas.days.find((day) => day.id === created.id), refreshedDay,
      'the browser client also keeps the metadata from the committed SSE snapshot')
    const oldDay = finalCanvas.days.find((day) => day.id === omitted.id)
    assert.ok(oldDay)
    assert.equal(Object.hasOwn(oldDay, 'title'), false)
    assert.equal(Object.hasOwn(oldDay, 'note'), false)
  } finally {
    try { await app?.close() } finally { await backend.close() }
  }
})
