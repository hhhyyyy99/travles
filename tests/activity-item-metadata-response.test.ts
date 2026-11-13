import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { ActivityItem, Day } from '@hailar/domain'
import { createApp } from '../server/src/app.js'
import { createSqliteDatabase, type SqlDatabase, type SqlValue } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { SqliteContentStoreDriver } from '../server/src/content/driver-sqlite.js'
import { TripContentRepository } from '../server/src/content/repository.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { SqliteItemsAdminStoreDriver } from '../server/src/items-admin/driver-sqlite.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../server/src/trips/repository.js'
import type { FetchLike } from '../src/domain/tripList'
import {
  applyItemReplace,
  fetchTripCanvas,
  updateWorkbenchItem,
  type WorkbenchItemPatch,
} from '../src/domain/workbench'

type MetadataField = 'timeRange' | 'cost'
type Metadata = { timeRange?: string; cost?: string }

const columns = { timeRange: 'time_range', cost: 'cost' } as const
const original = { title: 'Original activity', note: 'Original note', timeRange: '  Original time\n', cost: '\tOriginal cost  ' }
const patches = [
  { name: 'title-only', patch: { title: 'Changed activity' }, untouched: ['timeRange', 'cost'] },
  { name: 'note-only', patch: { note: 'Changed note' }, untouched: ['timeRange', 'cost'] },
  { name: 'timeRange-only', patch: { timeRange: '  Author time\n' }, untouched: ['cost'] },
  { name: 'cost-only', patch: { cost: '\tAuthor cost  ' }, untouched: ['timeRange'] },
] satisfies Array<{ name: string; patch: WorkbenchItemPatch; untouched: MetadataField[] }>
const concurrentChanges = [
  { name: 'added from initial NULL', initialNull: true, sqlValue: '  Concurrent addition\n', projected: '  Concurrent addition\n' },
  { name: 'changed text', initialNull: false, sqlValue: '\tConcurrent replacement  ', projected: '\tConcurrent replacement  ' },
  { name: 'empty text', initialNull: false, sqlValue: '', projected: '' },
  { name: 'raw NULL', initialNull: false, sqlValue: null, projected: undefined },
  { name: 'raw BLOB', initialNull: false, sqlValue: new Uint8Array([0, 65, 255]), projected: undefined },
] satisfies Array<{ name: string; initialNull: boolean; sqlValue: SqlValue; projected: string | undefined }>

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}

/** The real SQLite read supplies the old row; a separate SQL write wins before PATCH starts its transaction. */
class ConcurrentMetadataStore extends SqliteItemsAdminStoreDriver {
  private injected = false

  constructor(db: SqlDatabase, private readonly concurrentUpdate: () => Promise<void>) {
    super(db)
  }

  override async getItemRow(itemId: string) {
    const row = await super.getItemRow(itemId)
    if (!this.injected && itemId === 'item') {
      this.injected = true
      await this.concurrentUpdate()
    }
    return row
  }
}

async function fixture(t: TestContext, initial: Metadata, field: MetadataField, value: SqlValue) {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  await ensureSchema(db)
  await db.run('INSERT INTO trips (id, title, start_date, end_date, planning_context, is_pinned, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['trip', 'Trip', '', '', '{}', 0, 'planning', 'created', 'updated'])
  await db.run("INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES ('day', 'trip', 0, '', 'Day theme', '#123456')")
  await db.run('INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, time_range, cost, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['item', 'trip', 'day', 0, 'other', original.title, original.note, initial.timeRange ?? null, initial.cost ?? null, 0])
  await db.run("INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, time_range, cost, pending) VALUES ('neighbor', 'trip', 'day', 1, 'other', 'Keep neighbor', 'Keep note', 'Neighbor time', 'Neighbor cost', 0)")
  let injected = false
  const store = new ConcurrentMetadataStore(db, async () => {
    const result = await db.run(`UPDATE items SET ${columns[field]} = ? WHERE id = ? AND trip_id = ?`, [value, 'item', 'trip'])
    assert.equal(result.rowsAffected, 1)
    injected = true
  })
  const app = await createApp({
    tripRepository: new TripRepository(new SqliteTripStoreDriver(db)),
    contentRepository: new TripContentRepository(new SqliteContentStoreDriver(db)),
    workbenchStore: createSqliteWorkbenchStore(db),
    itemsAdminStore: store,
  })
  const fetchLike: FetchLike = async (url, init) => app.request(url, init)
  return { db, fetchLike, wasInjected: () => injected }
}

function assertMetadata(item: object, expected: Metadata, context: string) {
  const record = item as Record<string, unknown>
  for (const field of ['timeRange', 'cost'] as const) {
    assert.equal(Object.hasOwn(record, field), Object.hasOwn(expected, field), `${context}: ${field} own-property presence`)
    assert.equal(record[field], expected[field], `${context}: ${field} raw author text`)
  }
}

function subject(days: Day[]): ActivityItem {
  const item = days.flatMap((day) => day.items).find((entry) => entry.id === 'item')
  assert.ok(item, 'the activity remains in the canvas')
  return item
}

for (const { name, patch, untouched } of patches) {
  for (const field of untouched) {
    for (const change of concurrentChanges) {
      test(`${name} PATCH returns concurrent untouched ${field} ${change.name} and preserves a completed canvas when consumed later`, async (t) => {
        const initial: Metadata = { timeRange: original.timeRange, cost: original.cost }
        if (change.initialNull) delete initial[field]
        const expected: Metadata = { ...initial, ...patch }
        if (change.projected === undefined) delete expected[field]
        else expected[field] = change.projected
        // The expected optional-field shape is independent of title/note patch keys.
        const expectedMetadata: Metadata = {}
        if (expected.timeRange !== undefined) expectedMetadata.timeRange = expected.timeRange
        if (expected.cost !== undefined) expectedMetadata.cost = expected.cost
        const f = await fixture(t, initial, field, change.sqlValue)
        const before = await fetchTripCanvas('trip', f.fetchLike)
        assert.ok(before.ok)
        assertMetadata(subject(before.data.days), initial, 'initial canvas')
        const neighborBefore = before.data.days[0]!.items.find((item) => item.id === 'neighbor')

        const patchReady = deferred<Response>()
        const releasePatch = deferred<void>()
        let patchReturned = false
        let patchCompleted = false
        // This models a controlled client response order, not browser transport or SSE timing.
        const gatedFetch: FetchLike = async (url, init) => {
          let response: Response
          try {
            response = await f.fetchLike(url, init)
          } catch (error) {
            patchReady.reject(error)
            throw error
          }
          if (init?.method === 'PATCH') {
            patchReady.resolve(response)
            await releasePatch.promise
            patchReturned = true
          }
          return response
        }
        const pendingPatch = updateWorkbenchItem('trip', 'item', patch, gatedFetch).then((result) => {
          patchCompleted = true
          return result
        })
        let freshDays: Day[] = []
        let response: Response | undefined
        let wireResponse: Response | undefined
        let updated: Awaited<ReturnType<typeof updateWorkbenchItem>> | undefined
        try {
          response = await patchReady.promise
          assert.equal(response.status, 200)
          assert.equal(f.wasInjected(), true, 'the concurrent SQL write occurred after the initial item read')
          const { rows } = await f.db.run('SELECT title, note, time_range, cost, typeof(time_range) AS time_kind, typeof(cost) AS cost_kind FROM items WHERE id = ?', ['item'])
          const stored = rows[0]!
          assert.equal(stored.title, patch.title ?? original.title)
          assert.equal(stored.note, patch.note ?? original.note)
          for (const candidate of ['timeRange', 'cost'] as const) {
            const value = candidate === field ? change.sqlValue : patch[candidate] ?? initial[candidate] ?? null
            const column = columns[candidate]
            const kind = candidate === 'timeRange' ? 'time_kind' : 'cost_kind'
            assert.equal(stored[kind], value === null ? 'null' : value instanceof Uint8Array ? 'blob' : 'text', `SQL ${candidate} storage class`)
            if (value instanceof Uint8Array) {
              const bytes = stored[column]
              assert.ok(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))
              const actual = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
              assert.deepEqual(Array.from(actual), Array.from(value), `SQL ${candidate} BLOB bytes remain untouched`)
            } else {
              assert.equal(stored[column], value, `SQL ${candidate} preserves the selective write result`)
            }
          }

          const fresh = await fetchTripCanvas('trip', gatedFetch)
          assert.ok(fresh.ok)
          freshDays = fresh.data.days
          assertMetadata(subject(freshDays), expectedMetadata, 'fresh canvas decoder')
          assert.equal(patchReturned, false, 'the FetchLike gate still holds the PATCH Response')
          assert.equal(patchCompleted, false, 'canvas decoding finishes before PATCH decoding')
          assert.equal(response.bodyUsed, false, 'the production PATCH client has not consumed the held response')
          wireResponse = response.clone()
        } finally {
          releasePatch.resolve()
          updated = await pendingPatch
        }
        assert.ok(wireResponse)
        const wire = await wireResponse.json() as { item: Record<string, unknown> }
        assertMetadata(wire.item, expectedMetadata, 'actual HTTP PATCH wire item')
        assert.equal(wire.item.title, patch.title ?? original.title)
        assert.equal(wire.item.note, patch.note ?? original.note)
        assert.ok(updated.ok)
        assertMetadata(updated.data, expectedMetadata, 'production PATCH decoder')
        const reconciled = applyItemReplace(freshDays, 'item', updated.data)
        assertMetadata(subject(reconciled), expectedMetadata, 'final reconciled canvas')
        assert.deepEqual(reconciled, freshDays, 'the delayed authoritative response preserves the already completed fresh canvas')
        assert.deepEqual(reconciled[0]!.items.find((item) => item.id === 'neighbor'), neighborBefore)
      })
    }
  }
}
