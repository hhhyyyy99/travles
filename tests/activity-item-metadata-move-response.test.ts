import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { ActivityItem, Day, Leg } from '@hailar/domain'
import { createApp } from '../server/src/app.js'
import { createSqliteDatabase, type SqlValue } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { SqliteContentStoreDriver } from '../server/src/content/driver-sqlite.js'
import { TripContentRepository } from '../server/src/content/repository.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import type { ItemRow } from '../server/src/days/types.js'
import { SqliteItemsAdminStoreDriver } from '../server/src/items-admin/driver-sqlite.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../server/src/trips/repository.js'
import type { FetchLike } from '../src/domain/tripList'
import {
  applyItemReplace,
  fetchTripCanvas,
  moveWorkbenchItem,
  type TripCanvasData,
  type WorkbenchItemTarget,
} from '../src/domain/workbench'

type MetadataField = 'timeRange' | 'cost'
type Metadata = { timeRange?: string; cost?: string }

const columns = { timeRange: 'time_range', cost: 'cost' } as const
const original = {
  title: 'Original activity',
  note: 'Original note',
  timeRange: '  Original time\n',
  cost: '\tOriginal cost  ',
}
const moves = [
  {
    name: 'same-day reorder',
    target: { index: 1 },
    dayId: 'day-1',
    order: 1,
    layout: [
      ['neighbor', 'item', 'tail'],
      ['destination', 'far'],
    ],
    pairs: [
      ['neighbor', 'item'],
      ['item', 'tail'],
      ['destination', 'far'],
      ['tail', 'destination'],
    ],
  },
  {
    name: 'cross-day move',
    target: { dayId: 'day-2', index: 0 },
    dayId: 'day-2',
    order: 0,
    layout: [
      ['neighbor', 'tail'],
      ['item', 'destination', 'far'],
    ],
    pairs: [
      ['neighbor', 'tail'],
      ['item', 'destination'],
      ['destination', 'far'],
      ['tail', 'item'],
    ],
  },
] satisfies Array<{
  name: string
  target: WorkbenchItemTarget
  dayId: string
  order: number
  layout: string[][]
  pairs: [string, string][]
}>
const concurrentChanges = [
  {
    name: 'added from initial NULL',
    initialNull: true,
    sqlValue: '  Concurrent addition\n',
    projected: '  Concurrent addition\n',
  },
  {
    name: 'changed text',
    initialNull: false,
    sqlValue: '\tConcurrent replacement  ',
    projected: '\tConcurrent replacement  ',
  },
  { name: 'empty text', initialNull: false, sqlValue: '', projected: '' },
  // Raw NULL/BLOB are storage compatibility probes, not clears accepted by the API.
  { name: 'raw SQL NULL compatibility', initialNull: false, sqlValue: null, projected: undefined },
  {
    name: 'raw SQL BLOB compatibility',
    initialNull: false,
    sqlValue: new Uint8Array([0, 65, 255]),
    projected: undefined,
  },
] satisfies Array<{
  name: string
  initialNull: boolean
  sqlValue: SqlValue
  projected: string | undefined
}>

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => {
    resolve = fulfill
    reject = fail
  })
  return { promise, resolve, reject }
}

async function fixture(t: TestContext, initial: Metadata, field: MetadataField, value: SqlValue) {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  await ensureSchema(db)
  await db.run(
    'INSERT INTO trips (id, title, start_date, end_date, planning_context, is_pinned, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['trip', 'Trip', '', '', '{}', 0, 'planning', 'created', 'updated'],
  )
  for (const [index, dayId] of ['day-1', 'day-2'].entries()) {
    await db.run(
      'INSERT INTO days (id, trip_id, idx, date, theme, color, title, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [dayId, 'trip', index, '', `Theme ${index}`, '#123456', `Day ${index}`, `Day note ${index}`],
    )
  }
  await db.run(
    'INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, time_range, cost, images, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      'item',
      'trip',
      'day-1',
      0,
      'other',
      original.title,
      original.note,
      initial.timeRange ?? null,
      initial.cost ?? null,
      JSON.stringify([{ url: 'https://example.test/item.jpg', caption: 'Keep subject image' }]),
      0,
    ],
  )
  for (const [id, dayId, order] of [
    ['neighbor', 'day-1', 1],
    ['tail', 'day-1', 2],
    ['destination', 'day-2', 0],
    ['far', 'day-2', 1],
  ] as const) {
    await db.run(
      'INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, time_range, cost, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        id,
        'trip',
        dayId,
        order,
        'other',
        `Keep ${id}`,
        `Keep ${id} note`,
        `  ${id} time\n`,
        `\t${id} cost  `,
        0,
      ],
    )
  }
  for (const [from, to] of [
    ['item', 'neighbor'],
    ['neighbor', 'tail'],
    ['tail', 'destination'],
    ['destination', 'far'],
  ] as const) {
    const measured = from === 'destination'
    await db.run(
      'INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline, quality) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        `leg-${from}-${to}`,
        'trip',
        from,
        to,
        measured ? 'walk' : 'drive',
        measured ? 1.25 : 0,
        measured ? 17 : 0,
        measured
          ? JSON.stringify([
              [120, 30],
              [120.01, 30.01],
            ])
          : null,
        measured ? 'measured' : 'pending',
      ],
    )
  }

  const store = new SqliteItemsAdminStoreDriver(db)
  let loadedRows: ItemRow[] | undefined
  const listItemRows = store.listItemRows.bind(store)
  store.listItemRows = async (tripId) => {
    loadedRows = await listItemRows(tripId)
    return loadedRows
  }
  let injected = false
  const withTransaction = store.withTransaction.bind(store)
  store.withTransaction = async (fn) => {
    assert.equal(injected, false, 'one controlled concurrent update per move')
    const loaded = loadedRows?.find((row) => row.id === 'item')
    assert.ok(loaded, 'the move loaded the actual SQLite subject before beginning its transaction')
    assert.equal(
      loaded.time_range,
      initial.timeRange ?? null,
      'the loaded timeRange is the old SQL value',
    )
    assert.equal(loaded.cost, initial.cost ?? null, 'the loaded cost is the old SQL value')
    const result = await db.run(
      `UPDATE items SET ${columns[field]} = ? WHERE id = ? AND trip_id = ?`,
      [value, 'item', 'trip'],
    )
    assert.equal(result.rowsAffected, 1)
    injected = true
    return withTransaction(fn)
  }
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
    assert.equal(
      Object.hasOwn(record, field),
      Object.hasOwn(expected, field),
      `${context}: ${field} own-property presence`,
    )
    assert.equal(record[field], expected[field], `${context}: ${field} raw author text`)
  }
}

function findItem(days: Day[], id: string): ActivityItem {
  const item = days.flatMap((day) => day.items).find((entry) => entry.id === id)
  assert.ok(item, `activity ${id} remains in the canvas`)
  return item
}

function expectedCanvas(
  before: TripCanvasData,
  move: (typeof moves)[number],
  metadata: Metadata,
): TripCanvasData {
  const days = before.days.map((day, index) => ({
    ...day,
    items: move.layout[index]!.map((id, order) => {
      const item = { ...findItem(before.days, id), dayId: day.id, order }
      if (id === 'item') {
        delete item.timeRange
        delete item.cost
        Object.assign(item, metadata)
      }
      return item
    }),
  }))
  const legs = move.pairs.map(([fromItemId, toItemId]): Leg => {
    const retained = before.legs.find(
      (leg) => leg.fromItemId === fromItemId && leg.toItemId === toItemId,
    )
    return (
      retained ?? {
        id: `leg-${fromItemId}-${toItemId}`,
        fromItemId,
        toItemId,
        mode: 'drive',
        distanceKm: 0,
        durationMin: 0,
        polyline: null,
        quality: 'pending',
        status: 'pending',
      }
    )
  })
  return { ...before, days, legs }
}

for (const move of moves) {
  for (const field of ['timeRange', 'cost'] as const) {
    for (const change of concurrentChanges) {
      void test(`${move.name} POST returns concurrent ${field} ${change.name} and preserves a completed canvas when consumed later`, async (t) => {
        const initial: Metadata = { timeRange: original.timeRange, cost: original.cost }
        if (change.initialNull) delete initial[field]
        const expectedMetadata: Metadata = { ...initial }
        if (change.projected === undefined) delete expectedMetadata[field]
        else expectedMetadata[field] = change.projected
        const f = await fixture(t, initial, field, change.sqlValue)
        const before = await fetchTripCanvas('trip', f.fetchLike)
        assert.ok(before.ok)
        assertMetadata(findItem(before.data.days, 'item'), initial, 'initial canvas')
        assert.equal(f.wasInjected(), false, 'the initial canvas does not trigger the SQL update')
        const expected = expectedCanvas(before.data, move, expectedMetadata)

        const moveReady = deferred<Response>()
        const releaseMove = deferred<void>()
        let moveReturned = false
        let moveCompleted = false
        // This controls FetchLike response consumption; it does not simulate browser/SSE transport timing.
        const gatedFetch: FetchLike = async (url, init) => {
          const isMove = init?.method === 'POST' && String(url).endsWith('/items/item/move')
          let response: Response
          try {
            response = await f.fetchLike(url, init)
          } catch (error) {
            if (isMove) moveReady.reject(error)
            throw error
          }
          if (isMove) {
            moveReady.resolve(response)
            await releaseMove.promise
            moveReturned = true
          }
          return response
        }
        const pendingMove = moveWorkbenchItem('trip', 'item', move.target, gatedFetch).then(
          (result) => {
            moveCompleted = true
            return result
          },
        )
        let freshCanvas: TripCanvasData | undefined
        let wireResponse: Response | undefined
        let moved: Awaited<ReturnType<typeof moveWorkbenchItem>> | undefined
        try {
          const response = await moveReady.promise
          assert.equal(response.status, 200, 'the gate holds an actual successful move response')
          assert.equal(
            f.wasInjected(),
            true,
            'the concurrent SQL update ran after the old items were loaded',
          )
          const { rows } = await f.db.run(
            'SELECT title, note, day_id, item_order, time_range, cost, typeof(time_range) AS time_kind, typeof(cost) AS cost_kind FROM items WHERE id = ?',
            ['item'],
          )
          const stored = rows[0]!
          assert.equal(stored.title, original.title)
          assert.equal(stored.note, original.note)
          assert.equal(stored.day_id, move.dayId)
          assert.equal(stored.item_order, move.order)
          for (const candidate of ['timeRange', 'cost'] as const) {
            const value = candidate === field ? change.sqlValue : (initial[candidate] ?? null)
            const column = columns[candidate]
            const kind = candidate === 'timeRange' ? 'time_kind' : 'cost_kind'
            assert.equal(
              stored[kind],
              value === null ? 'null' : value instanceof Uint8Array ? 'blob' : 'text',
              `SQL ${candidate} storage class`,
            )
            if (value instanceof Uint8Array) {
              const bytes = stored[column]
              assert.ok(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))
              const actual =
                bytes instanceof ArrayBuffer
                  ? new Uint8Array(bytes)
                  : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
              assert.deepEqual(
                Array.from(actual),
                Array.from(value),
                `SQL ${candidate} BLOB bytes remain untouched`,
              )
            } else {
              assert.equal(
                stored[column],
                value,
                `SQL ${candidate} concurrent raw value remains untouched`,
              )
            }
          }

          const fresh = await fetchTripCanvas('trip', gatedFetch)
          assert.ok(fresh.ok)
          freshCanvas = fresh.data
          assertMetadata(
            findItem(freshCanvas.days, 'item'),
            expectedMetadata,
            'fresh canvas decoder',
          )
          assert.deepEqual(
            freshCanvas,
            expected,
            'fresh canvas has the requested layout, retained neighbor metadata, and recomputed/retained legs',
          )
          assert.equal(moveReturned, false, 'the FetchLike gate still holds the POST move Response')
          assert.equal(moveCompleted, false, 'canvas decoding finishes before move decoding')
          assert.equal(
            response.bodyUsed,
            false,
            'the production move client has not consumed the held response',
          )
          wireResponse = response.clone()
        } finally {
          releaseMove.resolve()
          moved = await pendingMove
        }
        assert.ok(wireResponse)
        const wire = (await wireResponse.json()) as {
          item: Record<string, unknown>
          legs: unknown[]
        }
        assertMetadata(wire.item, expectedMetadata, 'actual HTTP POST move wire item')
        assert.equal(wire.item.dayId, move.dayId)
        assert.equal(wire.item.order, move.order)
        assert.deepEqual(
          wire.legs,
          expected.legs,
          'actual HTTP move wire legs preserve the requested layout',
        )
        assert.ok(moved.ok)
        assertMetadata(moved.data.item, expectedMetadata, 'production move decoder')
        assert.deepEqual(
          moved.data.item,
          findItem(expected.days, 'item'),
          'decoded move response has the complete current item and layout',
        )
        assert.deepEqual(
          moved.data.legs,
          expected.legs,
          'decoded move legs retain unaffected measured geometry and metadata',
        )
        assert.ok(freshCanvas)
        const reconciled: TripCanvasData = {
          ...freshCanvas,
          days: applyItemReplace(freshCanvas.days, 'item', moved.data.item),
          legs: moved.data.legs,
        }
        assertMetadata(
          findItem(reconciled.days, 'item'),
          expectedMetadata,
          'final reconciled canvas',
        )
        assert.deepEqual(
          reconciled,
          expected,
          'the delayed authoritative move response preserves the full current client canvas',
        )
        assert.deepEqual(
          reconciled,
          freshCanvas,
          'replacement preserves the already completed canvas including neighbor metadata and legs',
        )
      })
    }
  }
}
