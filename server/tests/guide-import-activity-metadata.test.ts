import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TripCanvasSchema, type GuideDraft } from '@hailar/domain'
import { createApp } from '../src/app.js'
import type { SqlDatabase } from '../src/db/driver.js'
import { createSqliteWorkbenchStore } from '../src/days/driver-sqlite.js'
import { importGuide } from '../src/guide-import/repository.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'

// Deliberately retain the field order produced by the pre-metadata draft schema.
const legacyDraft: GuideDraft = {
  title: '成都慢游', destination: '成都', dateStatus: 'unspecified',
  days: [{ dayNumber: 1, title: '城市漫步', items: [
    { type: 'attraction', title: '人民公园', note: '早上喝茶', region: '成都', poi: null, pending: true },
    { type: 'food', title: '街边小吃', note: '店名待定', region: '成都', poi: null, pending: true },
  ] }], warnings: [],
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'guide-item-metadata-'))
  const databaseUrl = 'file:' + join(directory, 'trips.sqlite')
  const sqlite = await createSqliteTripRepository(databaseUrl)
  t.after(async () => {
    await sqlite.close()
    await rm(directory, { recursive: true, force: true })
  })
  const app = await createApp({ tripRepository: sqlite.repository, contentRepository: sqlite.contentRepository,
    workbenchStore: createSqliteWorkbenchStore(sqlite.db), guideImportDatabase: sqlite.db })
  const submit = (body: unknown) => app.request('/api/trips/from-guide', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { sqlite, databaseUrl, app, submit }
}

test('structured guide import stores only explicit metadata strings and returns them through the real SQLite canvas', async (t) => {
  const f = await fixture(t)
  const draft = structuredClone(legacyDraft)
  draft.days[0]!.items = [
    { ...draft.days[0]!.items[0]!, timeRange: '  22:00 → 次日 02:00 UTC+8\n', cost: '\t估算 USD 20–30 / 人  ' },
    { ...draft.days[0]!.items[1]!, timeRange: '', cost: '' },
    { ...draft.days[0]!.items[0]!, timeRange: ' \t\n' },
    { ...draft.days[0]!.items[1]!, cost: 'x'.repeat(2001) },
    { ...draft.days[0]!.items[0]! },
  ]
  const response = await f.submit({ draft, importId: randomUUID() })
  assert.equal(response.status, 201)
  const { trip } = await response.json() as { trip: { id: string } }
  const rows = (await f.sqlite.db.run('SELECT time_range, cost FROM items WHERE trip_id = ? ORDER BY item_order', [trip.id])).rows
  assert.deepEqual(rows, [
    { time_range: '  22:00 → 次日 02:00 UTC+8\n', cost: '\t估算 USD 20–30 / 人  ' },
    { time_range: '', cost: '' },
    { time_range: ' \t\n', cost: null },
    { time_range: null, cost: 'x'.repeat(2001) },
    { time_range: null, cost: null },
  ])
  const canvasResponse = await f.app.request('/api/trips/' + trip.id + '/canvas')
  assert.equal(canvasResponse.status, 200)
  const canvas = TripCanvasSchema.parse(await canvasResponse.json())
  const items = canvas.days[0]!.items
  for (const [index, source] of draft.days[0]!.items.entries()) {
    const stored = items[index]!
    assert.equal(stored.title, source.title)
    assert.equal(stored.note, source.note)
    for (const field of ['timeRange', 'cost'] as const) {
      assert.equal(Object.hasOwn(stored, field), Object.hasOwn(source, field))
      if (Object.hasOwn(source, field)) assert.equal(stored[field], source[field])
    }
  }
  assert.equal(items.length, 5)
})

test('guide metadata participates in the fingerprint, distinguishes omission from empty strings and keeps legacy receipts replayable', async (t) => {
  const f = await fixture(t)
  const input = { draft: legacyDraft, importId: randomUUID() }
  const first = await f.submit(input)
  assert.equal(first.status, 201)
  const original = await first.json() as { trip: { id: string } }
  // This is the old hash algorithm applied to the old, manually ordered shape.
  const legacyHash = createHash('sha256').update(JSON.stringify({ draft: legacyDraft, title: undefined })).digest('hex')
  const receipt = (await f.sqlite.db.run('SELECT payload_hash FROM guide_imports WHERE import_id = ?', [input.importId])).rows[0]
  assert.equal(receipt?.payload_hash, legacyHash, 'missing optional fields must not change an old draft hash')
  const oldImportId = randomUUID()
  await f.sqlite.db.run('INSERT INTO guide_imports (import_id, payload_hash, trip_id) VALUES (?, ?, ?)',
    [oldImportId, legacyHash, 'legacy-trip'])
  await f.sqlite.db.run('INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['legacy-trip', 'Legacy trip', '', '', '', ''])
  const legacyReplay = await f.submit({ draft: legacyDraft, importId: oldImportId })
  assert.equal(legacyReplay.status, 201)
  assert.equal((await legacyReplay.json() as { trip: { id: string } }).trip.id, 'legacy-trip')

  const undefinedDraft = structuredClone(legacyDraft)
  Object.assign(undefinedDraft.days[0]!.items[0]!, { timeRange: undefined, cost: undefined })
  assert.deepEqual(await importGuide(f.sqlite.db, { ...input, draft: undefinedDraft }), original.trip)

  for (const metadata of [
    { timeRange: '' }, { cost: '' }, { timeRange: ' ' }, { cost: '\n' },
    { timeRange: '  next day\n', cost: '  USD 20 / person\n' },
  ]) {
    const changed = structuredClone(legacyDraft)
    Object.assign(changed.days[0]!.items[0]!, metadata)
    const conflict = await f.submit({ ...input, draft: changed })
    assert.equal(conflict.status, 409, JSON.stringify(metadata))
    assert.equal((await conflict.json() as { code: string }).code, 'import_conflict')
  }

  const explicitDraft = structuredClone(legacyDraft)
  Object.assign(explicitDraft.days[0]!.items[0]!, { timeRange: '', cost: '  USD 20 / person\n' })
  const explicitInput = { draft: explicitDraft, importId: randomUUID() }
  const explicit = await f.submit(explicitInput)
  assert.equal(explicit.status, 201)
  const explicitTrip = await explicit.json()
  assert.notEqual((await f.sqlite.db.run('SELECT payload_hash FROM guide_imports WHERE import_id = ?', [explicitInput.importId])).rows[0]?.payload_hash, legacyHash)
  const reopened = await createSqliteTripRepository(f.databaseUrl)
  try {
    assert.deepEqual({ trip: await importGuide(reopened.db, explicitInput) }, explicitTrip)
  } finally { await reopened.close() }
  for (const metadata of [{ timeRange: '', cost: 'USD 20 / person' }, { cost: '  USD 20 / person\n' }, { timeRange: '', cost: '' }]) {
    const changed = structuredClone(legacyDraft)
    Object.assign(changed.days[0]!.items[0]!, metadata)
    assert.equal((await f.submit({ ...explicitInput, draft: changed })).status, 409)
  }
  assert.equal((await f.sqlite.db.run('SELECT COUNT(*) AS count FROM trips')).rows[0]?.count, 3)
  assert.equal((await f.sqlite.db.run('SELECT COUNT(*) AS count FROM items')).rows[0]?.count, 4)
})

test('trusted guide import rejects malformed metadata anywhere in the draft before accessing the database', async () => {
  let databaseCalls = 0
  const guardedDatabase: SqlDatabase = {
    async run() { databaseCalls++; throw new Error('must not reach SQL') },
    async withTransaction() { databaseCalls++; throw new Error('must not begin a transaction') },
    async close() {},
  }
  for (const field of ['timeRange', 'cost']) {
    for (const value of [null, 42, false, {}, [], new Uint8Array([65, 66])]) {
      const draft = structuredClone(legacyDraft)
      Object.assign(draft.days[0]!.items[0]!, { timeRange: 'valid first item', cost: '' })
      Object.assign(draft.days[0]!.items[1]!, { timeRange: 'valid sibling', cost: 'valid sibling', [field]: value })
      await assert.rejects(importGuide(guardedDatabase, { draft, importId: randomUUID() }))
    }
  }
  assert.equal(databaseCalls, 0)
})

test('HTTP guide confirmation rejects non-string metadata without writing any part of a valid preceding item', async (t) => {
  const f = await fixture(t)
  for (const field of ['timeRange', 'cost']) {
    for (const value of [null, 42, false, {}, []]) {
      const draft = structuredClone(legacyDraft)
      Object.assign(draft.days[0]!.items[0]!, { timeRange: 'valid first item', cost: '' })
      Object.assign(draft.days[0]!.items[1]!, { timeRange: 'valid sibling', cost: 'valid sibling', [field]: value })
      const response = await f.submit({ draft, importId: randomUUID() })
      assert.equal(response.status, 400)
      assert.equal((await response.json() as { code: string }).code, 'invalid_request')
    }
  }
  for (const table of ['trips', 'days', 'items', 'guide_imports']) {
    assert.equal((await f.sqlite.db.run('SELECT COUNT(*) AS count FROM ' + table)).rows[0]?.count, 0, table)
  }
})
