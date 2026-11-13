// Real Chromium, source-module clients, production Hono/SQLite and native SSE.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { openApp } = require('../helpers/vite-app.cjs')
const root = path.resolve(__dirname, '../..')
const metadata = { timeRange: '\t 次日 01:00 JST\n现场为准 ', cost: ' ¥100–200/人（估算）\n不含停车费\t' }

async function startBackend() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/activity-item-metadata-server.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AMAP_KEY: '', AMAP_WEB_KEY: '', AI_API_KEY: '' },
  })
  let logs = ''
  let exited = false
  const stopped = new Promise((resolve) => {
    child.once('exit', (code) => { exited = true; resolve(code) })
    child.once('error', () => { exited = true; resolve(null) })
  })
  const close = async () => { if (!exited) child.kill('SIGTERM'); assert.equal(await stopped, 0, logs) }
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend timeout: ' + logs)), 20000)
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
function fields(item) {
  return Object.fromEntries(['timeRange', 'cost'].filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]]))
}
function event(cdp, name, tripId, reason) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cdp.off('Network.eventSourceMessageReceived', receive); reject(new Error('Missing native ' + name)) }, 8000)
    const receive = (message) => {
      if (message.eventName !== name) return
      const payload = JSON.parse(message.data)
      if (payload.tripId !== tripId || (reason && payload.reason !== reason)) return
      clearTimeout(timer)
      cdp.off('Network.eventSourceMessageReceived', receive)
      resolve(payload)
    }
    cdp.on('Network.eventSourceMessageReceived', receive)
  })
}

test('real browser round-trips activity author metadata across writes, copy/move, import, proposal apply and SSE snapshots', async () => {
  const backend = await startBackend()
  let app
  let cdp
  try {
    app = await openApp({ mode: 'dev', entry: '/?view=trips', serverPort: backend.port, amapConfig404: true })
    const { page } = app
    await page.locator('#trip-intake-input').waitFor()
    const result = await page.evaluate(async (metadata) => {
      const workbench = await import('/src/domain/workbench.ts')
      const { createTrip } = await import('/src/domain/tripList.ts')
      const unwrap = (result) => { if (!result.ok) throw new Error(result.error); return result.data }
      const trip = unwrap(await createTrip({ title: 'Activity author metadata', startDate: '2026-10-02', endDate: '2026-10-02' }))
      const firstDay = unwrap(await workbench.createWorkbenchDay(trip.id, { theme: '独立日主题', title: '独立日标题', note: '独立日备注' }))
      const secondDay = unwrap(await workbench.createWorkbenchDay(trip.id, { theme: '第二天' }))
      const created = unwrap(await workbench.createWorkbenchItem(trip.id, { dayId: firstDay.id, title: '旧活动标题', note: '独立活动备注', ...metadata })).item
      const old = unwrap(await workbench.createWorkbenchItem(trip.id, { dayId: firstDay.id, title: '旧格式不补造 08:00 ¥100' })).item
      const empty = unwrap(await workbench.createWorkbenchItem(trip.id, { dayId: firstDay.id, title: '显式清空', timeRange: '', cost: '' })).item
      const one = unwrap(await workbench.updateWorkbenchItem(trip.id, created.id, { cost: '' }))
      const whitespace = unwrap(await workbench.updateWorkbenchItem(trip.id, created.id, { timeRange: ' \t\n' }))
      const restored = unwrap(await workbench.updateWorkbenchItem(trip.id, created.id, metadata))
      const titleOnly = unwrap(await workbench.updateWorkbenchItem(trip.id, created.id, { title: '原文仍在', note: '更新独立备注' }))
      const copy = unwrap(await workbench.copyWorkbenchItem(trip.id, created.id, { dayId: secondDay.id })).item
      const emptyCopy = unwrap(await workbench.copyWorkbenchItem(trip.id, empty.id, { dayId: secondDay.id })).item
      const omittedCopy = unwrap(await workbench.copyWorkbenchItem(trip.id, old.id, { dayId: secondDay.id })).item
      const moved = unwrap(await workbench.moveWorkbenchItem(trip.id, created.id, { dayId: secondDay.id, index: 0 })).item
      const canvas = unwrap(await workbench.fetchTripCanvas(trip.id))
      return { trip, firstDay, secondDay, created, old, empty, one, whitespace, restored, titleOnly, copy, emptyCopy, omittedCopy, moved, canvas }
    }, metadata)
    assert.deepEqual(fields(result.created), metadata)
    assert.deepEqual(fields(result.old), {})
    assert.deepEqual(fields(result.empty), { timeRange: '', cost: '' })
    assert.deepEqual(fields(result.one), { timeRange: metadata.timeRange, cost: '' })
    assert.deepEqual(fields(result.whitespace), { timeRange: ' \t\n', cost: '' })
    for (const name of ['restored', 'titleOnly', 'copy', 'moved']) assert.deepEqual(fields(result[name]), metadata, name)
    assert.notEqual(result.copy.id, result.created.id)
    assert.deepEqual(fields(result.emptyCopy), { timeRange: '', cost: '' })
    assert.deepEqual(fields(result.omittedCopy), {})
    assert.equal(result.moved.dayId, result.secondDay.id)
    assert.equal(result.canvas.days[0].title, '独立日标题')
    assert.equal(result.canvas.days[0].note, '独立日备注')
    const tripId = result.trip.id
    const itemId = result.created.id
    const dayId = result.secondDay.id

    // The legacy content writer keeps its per-row commit boundary and rejects a bad item.
    const content = await page.evaluate(async ({ tripId, itemId, dayId }) => {
      const put = async (items) => {
        const response = await fetch(`/api/trips/${tripId}/items`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) })
        return { status: response.status, body: await response.json() }
      }
      const saved = await put([{ id: itemId, dayId, title: 'Content 保存', cost: '  USD 50\n约值  ' }])
      const rejected = await put([{ id: 'committed-row', dayId, title: '前项已保存', timeRange: '' },
        { id: itemId, dayId, title: '坏字段不可静默写入', cost: null }])
      const { fetchTripCanvas } = await import('/src/domain/workbench.ts')
      const canvas = await fetchTripCanvas(tripId)
      if (!canvas.ok) throw new Error(canvas.error)
      return { saved, rejected, canvas: canvas.data, rawDays: await (await fetch(`/api/trips/${tripId}/days`)).json() }
    }, { tripId, itemId, dayId })
    assert.equal(content.saved.status, 200)
    assert.equal(content.rejected.status, 400)
    const contentItem = content.canvas.days.flatMap((day) => day.items).find((item) => item.id === itemId)
    assert.equal(contentItem.title, 'Content 保存')
    assert.deepEqual(fields(contentItem), { timeRange: metadata.timeRange, cost: '  USD 50\n约值  ' })
    assert.ok(content.canvas.days.flatMap((day) => day.items).some((item) => item.id === 'committed-row'))
    assert.deepEqual(fields(content.rawDays.days.flatMap((day) => day.items).find((item) => item.id === itemId)), fields(contentItem))

    const guide = await page.evaluate(async (metadata) => {
      const { importGuide } = await import('/src/domain/guideParsing.ts')
      const input = { importId: 'c913415d-c294-455d-bcf5-8313ae12bf89', draft: { title: '结构化草稿', destination: '成都', dateStatus: 'unspecified', warnings: [],
        days: [{ dayNumber: 1, title: '草稿日主题', items: [{ type: 'other', title: '导入活动', note: '', region: '', poi: null, pending: true, ...metadata }] }] } }
      const saved = await importGuide(input)
      if (!saved.ok) throw new Error(saved.error)
      const again = await importGuide(input)
      const conflict = await importGuide({ ...input, draft: { ...input.draft, days: [{ ...input.draft.days[0], items: [{ ...input.draft.days[0].items[0], cost: '' }] }] } })
      const { fetchTripCanvas } = await import('/src/domain/workbench.ts')
      const canvas = await fetchTripCanvas(saved.data.id)
      if (!canvas.ok) throw new Error(canvas.error)
      return { saved, again, conflict, canvas: canvas.data }
    }, metadata)
    assert.equal(guide.again.ok, true)
    assert.equal(guide.again.data.id, guide.saved.data.id)
    assert.equal(guide.conflict.ok, false)
    assert.equal(guide.conflict.code, 'import_conflict')
    assert.deepEqual(fields(guide.canvas.days[0].items[0]), metadata)

    const proposal = await page.evaluate(async (tripId) => {
      const { createAiProposal, applyAiProposal } = await import('/src/domain/aiProposals.ts')
      const preview = await createAiProposal(tripId, { kind: 'parse', text: '显式结构化提案回归' })
      if (!preview.ok) throw new Error(preview.error)
      const applied = await applyAiProposal(tripId, preview.data.id)
      if (!applied.ok) throw new Error(applied.error)
      const { fetchTripCanvas } = await import('/src/domain/workbench.ts')
      const canvas = await fetchTripCanvas(tripId)
      if (!canvas.ok) throw new Error(canvas.error)
      return { preview: preview.data, applied: applied.data, canvas: canvas.data }
    }, tripId)
    assert.deepEqual(fields(proposal.preview.items[0]), metadata)
    assert.deepEqual(fields(proposal.preview.patch.ops.find((op) => op.op === 'add_item')), metadata)
    assert.deepEqual(fields(proposal.canvas.days.flatMap((day) => day.items).find((item) => item.id === 'proposal-item')), metadata)

    cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    const ready = event(cdp, 'ready', tripId)
    await Promise.all([page.goto(app.url + '/?view=workbench&trip=' + tripId), ready])
    await page.getByText('Content 保存', { exact: true }).first().waitFor()
    const changed = event(cdp, 'trip.updated', tripId, 'item_updated')
    const refetched = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== `/api/trips/${tripId}/canvas` || response.request().method() !== 'GET') return false
      const canvas = await response.json()
      return canvas.days.flatMap((day) => day.items).some((item) => item.id === itemId && item.title === '外部修改自动同步')
    })
    const external = { title: '外部修改自动同步', timeRange: '', cost: '\n EUR 20/人 \t' }
    const [patched, notification, canvasResponse] = await Promise.all([
      fetch(`${backend.url}/api/trips/${tripId}/items/${itemId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(external) }),
      changed, refetched,
    ])
    assert.equal(patched.status, 200)
    assert.equal(notification.kind, 'canvas')
    const latest = (await canvasResponse.json()).days.flatMap((day) => day.items).find((item) => item.id === itemId)
    assert.deepEqual(fields(latest), fields(external))
    await page.getByText(external.title, { exact: true }).first().waitFor()
    const finalCanvas = await page.evaluate(async (tripId) => {
      const { fetchTripCanvas } = await import('/src/domain/workbench.ts')
      const result = await fetchTripCanvas(tripId)
      if (!result.ok) throw new Error(result.error)
      return result.data
    }, tripId)
    assert.deepEqual(fields(finalCanvas.days.flatMap((day) => day.items).find((item) => item.id === itemId)), fields(external))
    assert.equal(await page.locator('#print-itinerary').getByText(external.title, { exact: true }).count(), 1,
      'existing print sheet retains the current canvas snapshot and title behavior')
    assert.equal((await page.locator('#print-itinerary').innerText()).includes(external.cost), false,
      'optional metadata does not add a visible print presentation')
  } finally {
    try { await cdp?.detach() } finally { try { await app?.close() } finally { await backend.close() } }
  }
})
