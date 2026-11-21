// Real Chromium + Vite client imports + production SQLite/Hono HTTP/native SSE.
// API responses, fetch and EventSource are never replaced.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawn } = require('node:child_process')
const path = require('node:path')
const { openApp } = require('../helpers/vite-app.cjs')

const root = path.resolve(__dirname, '../..')
const tripId = 'stash-fields-trip'
const recommendationsPath = `/api/trips/${tripId}/recommendations`
const stashPath = `/api/trips/${tripId}/stash`
const favoritesPath = `/api/trips/${tripId}/favorites`
const aliases = ['tripId', 'title', 'category', 'createdAt']
const rawName = '\t  原始点位名称  \n'
const rawCategory = '\n  自由文本分类  \t'
const rawTime = '\t  not-an-ISO-date  \n'
const longName = '\t' + '旅'.repeat(175) + '\n'
const longCategory = '  ' + '类'.repeat(95) + '\t'
const longTime = '\n ' + 't'.repeat(100) + ' \t'

// Literal contract expectations, independent of the fixture's repository code.
const basePoi = (id, extra = {}) => ({
  id: 'poi-' + id, amapId: '', name: '点位 ' + id, lat: 30.66, lng: 104.06,
  category: '原始分类', type: 'attraction', region: '成都', rating: 4.5,
  introSummary: '独立简介', address: '独立地址', images: [], ...extra,
})
const seedCases = [
  { id: 'raw', poi: basePoi('raw', { name: '原始点位名称', category: '自由文本分类' }), origin: 'favorite', addedAt: 'not-an-ISO-date',
    fields: { tripId, title: rawName, category: rawCategory, createdAt: rawTime } },
  { id: 'long', poi: basePoi('long', { name: '旅'.repeat(160), category: '类'.repeat(80) }), origin: 'recommend', addedAt: 't'.repeat(80),
    fields: { tripId, title: longName, category: longCategory, createdAt: longTime } },
  { id: 'invalid-category', poi: basePoi('invalid-category', { category: '' }), origin: 'recommend', addedAt: '2026-09-02T01:02:03.000Z',
    fields: { tripId, title: '点位 invalid-category', createdAt: '2026-09-02T01:02:03.000Z' } },
  { id: 'null-time', poi: basePoi('null-time', { category: '' }), origin: 'recommend', addedAt: '',
    fields: { tripId, title: '点位 null-time' } },
  { id: 'missing-time', poi: { id: 'poi-missing-time', amapId: '', name: '缺少分类和时间', lat: 30.66, lng: 104.06,
    category: '', type: 'attraction', region: '', rating: 0, introSummary: '', address: '', images: [] },
    origin: 'recommend', addedAt: '', fields: { tripId, title: '缺少分类和时间' } },
  { id: 'blank', poi: basePoi('blank', { category: '' }), origin: 'recommend', addedAt: '',
    fields: { tripId, title: '点位 blank' } },
  { id: 'blob-time', poi: basePoi('blob-time'), origin: 'recommend', addedAt: '',
    fields: { tripId, title: '点位 blob-time', category: '原始分类' } },
]

async function startBackend() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/stash-fields-server.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AMAP_WEB_KEY: '', AMAP_KEY: '', AI_API_KEY: '' },
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

function assertSeedFields(snapshot, label, extraIds = []) {
  assert.deepEqual(snapshot.stash.map((item) => item.id).sort(), [...seedCases.map((item) => item.id), ...extraIds].sort(),
    label + ': invalid JSON/POIs and other trips stay excluded')
  for (const expected of seedCases) {
    const item = snapshot.stash.find((entry) => entry.id === expected.id)
    const fields = Object.fromEntries(aliases.filter((key) => Object.hasOwn(item, key)).map((key) => [key, item[key]]))
    assert.deepEqual(fields, expected.fields, label + ': independently supplied raw aliases for ' + expected.id)
    assert.deepEqual(Object.fromEntries(Object.entries(item).filter(([key]) => !aliases.includes(key))), {
      id: expected.id, poi: expected.poi, origin: expected.origin, addedAt: expected.addedAt,
    }, label + ': unchanged legacy fields and nested POI for ' + expected.id)
  }
}

function waitForSnapshot(page, predicate = () => true) {
  return page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== recommendationsPath || response.request().method() !== 'GET') return false
    return predicate(await response.json())
  })
}

async function readBrowserSnapshot(page) {
  const observed = waitForSnapshot(page)
  const [client, response] = await Promise.all([
    page.evaluate(async (id) => {
      const { fetchRecommendations } = await import('/src/domain/recommendations.ts')
      const result = await fetchRecommendations(id)
      if (!result.ok) throw new Error(result.error)
      return result.data
    }, tripId), observed,
  ])
  assert.equal(response.status(), 200)
  const wire = await response.json()
  assert.deepEqual(wire.pois, wire.recommendations, 'legacy pois aggregate alias is preserved')
  assert.deepEqual(client, { recommendations: wire.recommendations, stash: wire.stash, favorites: wire.favorites },
    'real imported browser client preserves every supplied Stash field')
  return { client, wire }
}

async function browserAddToStash(page, poi, origin = 'recommend') {
  const observed = page.waitForResponse((response) =>
    new URL(response.url()).pathname === stashPath && response.request().method() === 'POST')
  const [client, response] = await Promise.all([
    page.evaluate(async ({ id, poi, origin }) => {
      const { addToStash } = await import('/src/domain/recommendations.ts')
      const result = await addToStash(id, poi, origin)
      if (!result.ok) throw new Error(result.error)
      return result.data
    }, { id: tripId, poi, origin }), observed,
  ])
  assert.equal(response.status(), 201)
  const wire = (await response.json()).item
  assert.deepEqual(client, wire, 'real addToStash decodes the complete immediate HTTP item')
  return client
}

// CDP observes Chromium's native EventSource without substituting its constructor.
function waitForTripEvent(cdp, name, reason) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off('Network.eventSourceMessageReceived', receive)
      reject(new Error('Timed out waiting for native ' + name + ' ' + (reason || '')))
    }, 8000)
    const receive = (event) => {
      if (event.eventName !== name) return
      let data
      try { data = JSON.parse(event.data) } catch { return }
      if (data.tripId !== tripId || (reason && data.reason !== reason)) return
      clearTimeout(timer)
      cdp.off('Network.eventSourceMessageReceived', receive)
      resolve(data)
    }
    cdp.on('Network.eventSourceMessageReceived', receive)
  })
}

function assertSavedItem(item, poi, origin, label) {
  assert.equal(typeof item.id, 'string', label + ': saved ID')
  assert.ok(item.id.length > 0)
  assert.deepEqual(item.poi, poi, label + ': saved normalized POI')
  assert.equal(item.origin, origin)
  assert.equal(item.tripId, tripId)
  assert.equal(item.title, poi.name, label + ': title is the saved normalized name')
  assert.equal(item.category, poi.category, label + ': category is the saved normalized category')
  assert.equal(item.createdAt, item.addedAt, label + ': one saved timestamp feeds both fields')
  assert.ok(Number.isFinite(Date.parse(item.createdAt)), label + ': saved timestamp is valid')
  assert.deepEqual(Object.keys(item).sort(), ['id', 'poi', 'origin', 'addedAt', ...aliases].sort())
}

test('real browser preserves bounded Stash aliases through SQLite reads, normalized adds, duplicates and native SSE App refetches', async () => {
  const backend = await startBackend()
  let app
  let cdp
  try {
    // Dev serves the actual source module even under the suite's preview setting.
    app = await openApp({ mode: 'dev', entry: '/?view=trips', serverPort: backend.port, amapConfig404: true })
    const { page } = app
    await page.locator('#trip-intake-input').waitFor()
    const initial = await readBrowserSnapshot(page)
    assertSeedFields(initial.wire, 'initial HTTP snapshot')
    assertSeedFields(initial.client, 'initial fetchRecommendations result')
    assert.deepEqual(initial.client.favorites, [], 'favorites from another trip are excluded')
    const narrowInitial = await fetch(backend.url + stashPath)
    assert.equal(narrowInitial.status, 200)
    assert.deepEqual((await narrowInitial.json()).stash, initial.wire.stash, 'narrow GET stash uses the same row projection')

    const input = basePoi('new', { name: '\n ' + '新'.repeat(169) + ' \t', category: '\t' + '食'.repeat(88) + '\n',
      title: '未保存的输入标题', createdAt: '伪造的输入时间', tripId: 'stash-fields-other-trip' })
    const savedPoi = basePoi('new', { name: '新'.repeat(160), category: '食'.repeat(80) })
    const added = await browserAddToStash(page, input)
    assertSavedItem(added, savedPoi, 'recommend', 'immediate add')
    const afterAdd = await readBrowserSnapshot(page)
    assertSeedFields(afterAdd.client, 'after normalized add', [added.id])
    assert.deepEqual(afterAdd.client.stash.find((item) => item.id === added.id), added,
      'later GET keeps the immediate saved aliases and creation timestamp')

    const duplicate = await browserAddToStash(page,
      basePoi('new', { name: '同一 POI 的不同请求名称', category: '不同请求分类' }), 'favorite')
    assert.deepEqual(duplicate, added, 'duplicate returns the original snapshot, including aliases, origin and timestamp')
    const afterDuplicate = await readBrowserSnapshot(page)
    assertSeedFields(afterDuplicate.client, 'after duplicate', [added.id])
    assert.deepEqual(afterDuplicate.client.stash.find((item) => item.id === added.id), added)

    cdp = await page.context().newCDPSession(page)
    await cdp.send('Network.enable')
    const ready = waitForTripEvent(cdp, 'ready')
    const mounted = waitForSnapshot(page)
    const [, , mountedResponse] = await Promise.all([
      page.goto(app.url + '/?view=workbench&trip=' + tripId), ready, mounted,
    ])
    assert.equal(mountedResponse.status(), 200)
    assert.deepEqual((await mountedResponse.json()).stash, afterDuplicate.wire.stash)
    await page.locator('[data-action="map-stash-toggle"]').click()
    await page.locator('[data-stash-item="raw"]').waitFor()

    const externalPoi = basePoi('remote', { name: '外部新增的待计划点位', category: '外部原始分类' })
    const addedEvent = waitForTripEvent(cdp, 'trip.updated', 'stash_added')
    const addedRefetch = waitForSnapshot(page, (snapshot) => snapshot.stash.some((item) => item.poi.id === externalPoi.id))
    // Node's HTTP write cannot touch React state. This GET and DOM update must
    // come from the existing App's native SSE subscription and invalidation.
    const [externalResponse, addEvent, refetchedAdd] = await Promise.all([
      fetch(backend.url + stashPath, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ poi: externalPoi, origin: 'recommend' }) }),
      addedEvent, addedRefetch,
    ])
    assert.equal(externalResponse.status, 201)
    assert.equal(addEvent.kind, 'canvas')
    const external = (await externalResponse.json()).item
    assertSavedItem(external, externalPoi, 'recommend', 'external add')
    assert.equal(refetchedAdd.status(), 200)
    const refreshedAdd = await refetchedAdd.json()
    assertSeedFields(refreshedAdd, 'SSE-triggered App add refetch', [added.id, external.id])
    assert.deepEqual(refreshedAdd.stash.find((item) => item.id === external.id), external)
    const externalRow = page.locator(`[data-stash-item="${external.id}"]`)
    await externalRow.waitFor()
    assert.equal(await externalRow.locator('[data-action="stash-select"]').textContent(), externalPoi.name)

    const removedEvent = waitForTripEvent(cdp, 'trip.updated', 'stash_deleted')
    const removedRefetch = waitForSnapshot(page, (snapshot) => !snapshot.stash.some((item) => item.id === external.id))
    const [removedResponse, removeEvent, refetchedRemove] = await Promise.all([
      fetch(backend.url + stashPath + '/' + encodeURIComponent(external.id), { method: 'DELETE' }),
      removedEvent, removedRefetch,
    ])
    assert.equal(removedResponse.status, 200)
    assert.deepEqual(await removedResponse.json(), { ok: true })
    assert.equal(removeEvent.kind, 'canvas')
    assert.ok(removeEvent.revision > addEvent.revision, 'native stream advances on the committed remove')
    assert.equal(refetchedRemove.status(), 200)
    assertSeedFields(await refetchedRemove.json(), 'SSE-triggered App remove refetch', [added.id])
    await externalRow.waitFor({ state: 'detached' })

    const favoritePoi = basePoi('favorite', { name: '收藏的伴随待计划点位', category: '收藏分类' })
    const favoriteEvent = waitForTripEvent(cdp, 'trip.updated', 'favorite_added')
    const favoriteRefetch = waitForSnapshot(page, (snapshot) => snapshot.favorites.some((item) => item.poi.id === favoritePoi.id)
      && snapshot.stash.some((item) => item.poi.id === favoritePoi.id))
    const favoriteWire = page.waitForResponse((response) =>
      new URL(response.url()).pathname === favoritesPath && response.request().method() === 'POST')
    const [favorite, , favoriteSnapshotResponse, favoriteResponse] = await Promise.all([
      page.evaluate(async ({ id, poi }) => {
        const { addFavorite } = await import('/src/domain/recommendations.ts')
        const result = await addFavorite(id, poi)
        if (!result.ok) throw new Error(result.error)
        return result.data
      }, { id: tripId, poi: favoritePoi }), favoriteEvent, favoriteRefetch, favoriteWire,
    ])
    assert.equal(favoriteResponse.status(), 201)
    assert.deepEqual(favorite, (await favoriteResponse.json()).favorite)
    assert.deepEqual(Object.keys(favorite).sort(), ['createdAt', 'id', 'poi'], 'Favorite keeps its existing DTO')
    assert.deepEqual(favorite.poi, favoritePoi)
    assert.ok(Number.isFinite(Date.parse(favorite.createdAt)))
    assert.equal(favoriteSnapshotResponse.status(), 200)
    const withFavorite = await favoriteSnapshotResponse.json()
    assert.deepEqual(withFavorite.favorites, [favorite], 'GET favorites is still a Favorite DTO')
    const companion = withFavorite.stash.find((item) => item.poi.id === favoritePoi.id)
    assert.ok(companion, 'favorite creates a later readable companion Stash item')
    assertSavedItem(companion, favoritePoi, 'favorite', 'favorite companion')
    assertSeedFields(withFavorite, 'favorite companion App refetch', [added.id, companion.id])
    await page.locator(`[data-stash-item="${companion.id}"]`).waitFor()

    const final = await readBrowserSnapshot(page)
    assertSeedFields(final.client, 'final browser client', [added.id, companion.id])
    assert.deepEqual(final.client.stash, withFavorite.stash)
    assert.deepEqual(final.client.favorites, [favorite])
    const narrowFinal = await fetch(backend.url + stashPath)
    assert.equal(narrowFinal.status, 200)
    assert.deepEqual((await narrowFinal.json()).stash, final.client.stash)
    const favoritesFinal = await fetch(backend.url + favoritesPath)
    assert.equal(favoritesFinal.status, 200)
    assert.deepEqual((await favoritesFinal.json()).favorites, [favorite])
  } finally {
    try { await cdp?.detach() } finally {
      try { await app?.close() } finally { await backend.close() }
    }
  }
})
