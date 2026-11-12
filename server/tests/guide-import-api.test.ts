import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { TripCanvasSchema, TripSummarySchema, type GuideDraft } from '@hailar/domain'
import { createApp } from '../src/app.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import { createSqliteWorkbenchStore } from '../src/days/driver-sqlite.js'

const draft: GuideDraft = {
  title: '成都慢游', destination: '成都', dateStatus: 'unspecified', warnings: ['日期待确认'],
  days: [
    { dayNumber: 1, title: '城市漫步', items: [
      { type: 'attraction', title: '人民公园', note: '早上喝茶', region: '成都', pending: false,
        poi: { name: '人民公园', lat: 30.66, lng: 104.06, amapId: 'park-1', address: '成都市' } },
      { type: 'food', title: '街边小吃', note: '店名待定', region: '成都', poi: null, pending: true },
      { type: 'stay', title: '酒店待订', note: '', region: '成都', poi: null, pending: true },
    ] },
    { dayNumber: 2, title: '返程', items: [
      { type: 'traffic', title: '返回市区', note: '留足时间', region: '', poi: null, pending: true },
      { type: 'other', title: '整理照片', note: '', region: '', poi: null, pending: false },
    ] },
  ],
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'guide-import-'))
  const databaseUrl = 'file:' + join(directory, 'trips.sqlite')
  const sqlite = await createSqliteTripRepository(databaseUrl)
  const app = await createApp({ tripRepository: sqlite.repository,
    contentRepository: sqlite.contentRepository, workbenchStore: createSqliteWorkbenchStore(sqlite.db),
    guideImportDatabase: sqlite.db })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = 'http://127.0.0.1:' + address.port
  const request = (path: string, body?: unknown) => fetch(base + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { sqlite, databaseUrl, request, async close() {
    if ('closeAllConnections' in server) server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await sqlite.close()
    await rm(directory, { recursive: true, force: true })
  } }
}

test('guide confirmation atomically creates a readable date-pending canvas without changing existing trips', async () => {
  const f = await fixture()
  try {
    const existingResponse = await f.request('/api/trips', { title: '已有行程', startDate: '2026-10-02', endDate: '2026-10-04' })
    assert.equal(existingResponse.status, 201)
    const existing = await existingResponse.json() as { trip: { id: string } }
    const existingBefore = await (await f.request('/api/trips/' + existing.trip.id)).json()
    const existingCanvas = await (await f.request('/api/trips/' + existing.trip.id + '/canvas')).json()
    const response = await f.request('/api/trips/from-guide', { draft, title: '我的成都行', importId: randomUUID() })
    assert.equal(response.status, 201)
    const { trip: raw } = await response.json() as { trip: unknown }
    const trip = TripSummarySchema.parse(raw)
    assert.equal(trip.title, '我的成都行')
    assert.equal(trip.startDate, '')
    assert.equal(trip.endDate, '')
    assert.equal(trip.dateStatus, 'unspecified')
    assert.equal(trip.planningContext?.source, 'guide')
    assert.equal(trip.durationDays, 2)
    assert.equal(trip.days, 0)
    assert.equal(trip.nights, 0)
    const canvas = TripCanvasSchema.parse(await (await f.request('/api/trips/' + trip.id + '/canvas')).json())
    assert.deepEqual(canvas.days.map((day) => [day.index, day.date, day.theme]), [[0, '', '城市漫步'], [1, '', '返程']])
    assert.deepEqual(canvas.days[0]!.items.map((item) => [item.order, item.type, item.title, item.pending]),
      [[0, 'attraction', '人民公园', false], [1, 'food', '街边小吃', true], [2, 'stay', '酒店待订', true]])
    assert.deepEqual(canvas.days[1]!.items.map((item) => [item.type, item.title, item.pending]),
      [['traffic', '返回市区', true], ['other', '整理照片', false]])
    assert.deepEqual(canvas.days[0]!.items[0]!.poi, { name: '人民公园', lat: 30.66, lng: 104.06,
      amapId: 'park-1', address: '成都市', category: '', rating: 0, introSummary: '' })
    assert.equal(canvas.days[0]!.items[0]!.note, '早上喝茶')
    assert.equal(canvas.days[0]!.items[1]!.poi, null)
    assert.deepEqual(canvas.legs, [])
    const listed = await (await f.request('/api/trips')).json() as { trips: { id: string }[] }
    assert.equal(listed.trips.length, 2)
    assert.ok(listed.trips.some((item) => item.id === trip.id))
    assert.deepEqual(await (await f.request('/api/trips/' + existing.trip.id)).json(), existingBefore)
    assert.deepEqual(await (await f.request('/api/trips/' + existing.trip.id + '/canvas')).json(), existingCanvas)
    const rename = await fetch((await f.request('/api/trips/' + trip.id)).url, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '重命名后' }),
    })
    assert.equal(rename.status, 200)
    const renamed = TripSummarySchema.parse((await rename.json() as { trip: unknown }).trip)
    assert.equal(renamed.dateStatus, 'unspecified')
    assert.equal(renamed.startDate, '')
  } finally { await f.close() }
})

test('invalid confirmation payloads write no trips, days, items or import receipts', async () => {
  const f = await fixture()
  try {
    const tooMany = structuredClone(draft)
    tooMany.days = Array.from({ length: 6 }, (_, index) => ({ dayNumber: index + 1, title: '一天',
      items: Array.from({ length: index === 5 ? 1 : 20 }, () => structuredClone(draft.days[0]!.items[0]!)) }))
    const gap = structuredClone(draft)
    gap.days[1]!.dayNumber = 3
    const duplicateDay = structuredClone(draft)
    duplicateDay.days[1]!.dayNumber = 1
    const invalidPoi = structuredClone(draft)
    invalidPoi.days[0]!.items[0]!.poi!.lat = 91
    const reversed = structuredClone(draft)
    reversed.days.reverse()
    const payloads: unknown[] = [
      null, [], {}, { draft, importId: 'not-a-uuid' }, { draft },
      { draft, importId: randomUUID(), title: '' }, { draft, importId: randomUUID(), title: ' '.repeat(3) },
      { draft, importId: randomUUID(), title: '长'.repeat(101) },
      { draft: tooMany, importId: randomUUID() }, { draft: gap, importId: randomUUID() },
      { draft: duplicateDay, importId: randomUUID() }, { draft: invalidPoi, importId: randomUUID() },
      { draft: reversed, importId: randomUUID() },
      { draft: { ...draft, days: [{ ...draft.days[0], items: [] }] }, importId: randomUUID() },
      { draft: { ...draft, days: [{ ...draft.days[0], items: [{ ...draft.days[0]!.items[0], type: 'unknown' }] }] }, importId: randomUUID() },
      { draft: { ...draft, days: [] }, importId: randomUUID() },
      { draft: { ...draft, dateStatus: 'confirmed' }, importId: randomUUID() },
      { draft, importId: randomUUID(), unexpected: true },
    ]
    for (const payload of payloads) {
      const response = await f.request('/api/trips/from-guide', payload)
      assert.equal(response.status, 400, JSON.stringify(payload))
      assert.equal((await response.json() as { code: string }).code, 'invalid_request')
    }
    const malformed = await fetch((await f.request('/api/trips')).url.replace('/api/trips', '/api/trips/from-guide'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken',
    })
    assert.equal(malformed.status, 400)
    assert.deepEqual(await (await f.request('/api/trips')).json(), { trips: [] })
    for (const table of ['trips', 'days', 'items', 'guide_imports']) {
      const result = await f.sqlite.db.run('SELECT COUNT(*) AS count FROM ' + table)
      assert.equal(result.rows[0]!.count, 0, table)
    }
  } finally { await f.close() }
})

test('exactly 100 activities are importable and an omitted title truncates the source title to 100', async () => {
  const f = await fixture()
  try {
    const largeDraft = structuredClone(draft)
    largeDraft.title = '长'.repeat(120)
    largeDraft.destination = ''
    largeDraft.days = Array.from({ length: 5 }, (_, index) => ({ dayNumber: index + 1, title: '一天',
      items: Array.from({ length: 20 }, () => structuredClone(draft.days[0]!.items[0]!)) }))
    const response = await f.request('/api/trips/from-guide', { draft: largeDraft, importId: randomUUID() })
    assert.equal(response.status, 201)
    const trip = TripSummarySchema.parse((await response.json() as { trip: unknown }).trip)
    assert.equal(trip.title, '长'.repeat(100))
    assert.equal(trip.dateStatus, 'unspecified')
    assert.equal(trip.durationDays, 5)
    const canvas = TripCanvasSchema.parse(await (await f.request('/api/trips/' + trip.id + '/canvas')).json())
    assert.equal(canvas.days.flatMap((day) => day.items).length, 100)
  } finally { await f.close() }
})

test('a persisted import ID returns the same trip across connections and rejects changed payloads', async () => {
  const f = await fixture()
  try {
    const payload = { draft, title: '确认标题', importId: randomUUID() }
    const first = await f.request('/api/trips/from-guide', payload)
    assert.equal(first.status, 201)
    const original = await first.json() as { trip: { id: string } }
    const before = await (await f.request('/api/trips/' + original.trip.id + '/canvas')).json()
    const retry = await f.request('/api/trips/from-guide', payload)
    assert.equal(retry.status, 201)
    assert.deepEqual(await retry.json(), original)

    // A new application and SQLite connection cannot rely on process-local caches.
    const reopened = await createSqliteTripRepository(f.databaseUrl)
    try {
      const app = await createApp({ tripRepository: reopened.repository, guideImportDatabase: reopened.db })
      const replay = await app.request('/api/trips/from-guide', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importId: payload.importId.toUpperCase(), title: payload.title, draft }),
      })
      assert.equal(replay.status, 201)
      assert.deepEqual(await replay.json(), original)
    } finally { await reopened.close() }
    const changedDraft = structuredClone(draft)
    changedDraft.days[0]!.items[0]!.note = '改变的内容'
    for (const changed of [{ ...payload, title: '新标题' }, { ...payload, draft: changedDraft }]) {
      const conflict = await f.request('/api/trips/from-guide', changed)
      assert.equal(conflict.status, 409)
      assert.equal((await conflict.json() as { code: string }).code, 'import_conflict')
    }
    const listed = await (await f.request('/api/trips')).json() as { trips: unknown[] }
    assert.deepEqual(listed.trips, [original.trip])
    assert.deepEqual(await (await f.request('/api/trips/' + original.trip.id + '/canvas')).json(), before)
    const deleted = await fetch((await f.request('/api/trips/' + original.trip.id)).url, { method: 'DELETE' })
    assert.equal(deleted.status, 200)
    const staleRetry = await f.request('/api/trips/from-guide', payload)
    assert.equal(staleRetry.status, 409)
    assert.equal((await staleRetry.json() as { code: string }).code, 'import_conflict')
    assert.deepEqual(await (await f.request('/api/trips')).json(), { trips: [] })
  } finally { await f.close() }
})

test('the default SQLite app mounts guide import for an existing database', async () => {
  const f = await fixture()
  try {
    const existing = await f.request('/api/trips', { title: '旧行程', startDate: '2026-10-02', endDate: '2026-10-04' })
    assert.equal(existing.status, 201)
    const previous = await existing.json()
    await f.sqlite.db.run('DROP TABLE guide_imports')
    const app = await createApp({ databaseUrl: f.databaseUrl, seedBuiltinTrip: false })
    const imported = await app.request('/api/trips/from-guide', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft, importId: randomUUID() }),
    })
    assert.equal(imported.status, 201)
    const trip = TripSummarySchema.parse((await imported.json() as { trip: unknown }).trip)
    assert.equal(trip.title, '成都慢游')
    const list = await (await app.request('/api/trips')).json() as { trips: unknown[] }
    assert.equal(list.trips.length, 2)
    assert.deepEqual(list.trips[0], (previous as { trip: unknown }).trip)
    const canvas = TripCanvasSchema.parse(await (await app.request('/api/trips/' + trip.id + '/canvas')).json())
    assert.equal(canvas.days.length, 2)
  } finally { await f.close() }
})

test('concurrent confirmation requests with one import ID cannot create duplicate trips', async () => {
  const f = await fixture()
  try {
    const payload = { draft, importId: randomUUID() }
    const responses = await Promise.all([
      f.request('/api/trips/from-guide', payload), f.request('/api/trips/from-guide', payload),
    ])
    for (const response of responses) assert.equal(response.status, 201)
    const [first, second] = await Promise.all(responses.map((response) => response.json()))
    assert.deepEqual(first, second)
    assert.equal((await (await f.request('/api/trips')).json() as { trips: unknown[] }).trips.length, 1)
  } finally { await f.close() }
})

test('an item write failure rolls back the entire guide and leaves its import ID available for retry', async () => {
  const f = await fixture()
  try {
    await f.sqlite.db.run("CREATE TRIGGER reject_guide_item BEFORE INSERT ON items WHEN NEW.title = '街边小吃' BEGIN SELECT RAISE(ABORT, 'private-database-detail'); END")
    const payload = { draft, importId: randomUUID() }
    const failed = await f.request('/api/trips/from-guide', payload)
    assert.equal(failed.status, 500)
    assert.deepEqual(await failed.json(), { error: '保存失败，请重试。', code: 'storage_error' })
    assert.deepEqual(await (await f.request('/api/trips')).json(), { trips: [] })
    for (const table of ['trips', 'days', 'items', 'guide_imports']) {
      assert.equal((await f.sqlite.db.run('SELECT COUNT(*) AS count FROM ' + table)).rows[0]!.count, 0, table)
    }
    await f.sqlite.db.run('DROP TRIGGER reject_guide_item')
    const retry = await f.request('/api/trips/from-guide', payload)
    assert.equal(retry.status, 201)
    const { trip } = await retry.json() as { trip: { id: string } }
    const canvas = TripCanvasSchema.parse(await (await f.request('/api/trips/' + trip.id + '/canvas')).json())
    assert.equal(canvas.days.length, 2)
    assert.equal(canvas.days.flatMap((day) => day.items).length, 5)
  } finally { await f.close() }
})
