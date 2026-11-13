import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { RequestContext } from '@mastra/core/request-context'
import { noopObserve } from '@mastra/core/tools'
import { TripCanvasSchema } from '@hailar/domain'

import { hashTripSnapshot } from '../src/chat/confirmation.js'
import { readTripCanvas } from '../src/days/repository.js'
import type { SqlDatabase } from '../src/db/driver.js'
import { createTripSnapshotTool, PROPOSAL_TRIP_ID_KEY } from '../src/ai-proposals/tool.js'
import { applyTripPatch } from '../src/trip-patch/apply.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import { SqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'
import type { TripPatchItemUpsert, TripPatchStoreDriver } from '../src/trip-patch/types.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'

async function createFixture(t: TestContext, backend: 'SQLite' | 'memory' = 'SQLite') {
  const sqlite = await createSqliteTripRepository(':memory:')
  t.after(() => sqlite.close())
  const created = await sqlite.repository.create({ title: '活动说明', startDate: '2026-10-02', endDate: '2026-10-03' })
  assert.ok(created.ok)
  const store = backend === 'SQLite' ? new SqliteTripPatchStore(sqlite.db) : new MemoryTripPatchStore()
  return { ...sqlite, trip: created.trip, store }
}

async function seedItems(store: TripPatchStoreDriver, tripId: string) {
  const result = await applyTripPatch(store, tripId, {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
      { op: 'add_day', dayId: 'day-2', date: '2026-10-03' },
      ...['a', 'b', 'c'].map((id, index) => ({
        op: 'add_item', itemId: id, dayId: index === 2 ? 'day-2' : 'day-1', type: 'other', title: id,
        note: `备注-${id}`, timeRange: `加载时段-${id}`, cost: `加载费用-${id}`,
        poi: { name: id, lat: 49 + index / 10, lng: 119 + index / 10 },
      })),
    ],
  })
  assert.ok(result.ok, result.ok ? undefined : result.error)
}

for (const backend of ['SQLite', 'memory'] as const) {
  test(`${backend} item patches preserve literal, empty, omitted and undefined metadata independently`, async (t) => {
    const { store, trip } = await createFixture(t, backend)
    const result = await applyTripPatch(store, trip.id, {
      ops: [
        { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
        ...[
          { itemId: 'literal', timeRange: '  次日 01:00—03:00 JST\n另约  ', cost: '  ¥ 80–120 / 人\n估算  ' },
          { itemId: 'empty', timeRange: '', cost: '' },
          { itemId: 'omitted' },
          { itemId: 'undefined', timeRange: undefined, cost: undefined },
          { itemId: 'time-only', timeRange: '早上' },
          { itemId: 'cost-only', cost: '免费' },
        ].map((fields) => ({ op: 'add_item', dayId: 'day-1', type: 'other', title: '09:00 标题 ¥999', note: '备注不提供默认', pending: true, ...fields })),
      ],
    })
    assert.ok(result.ok, result.ok ? undefined : result.error)
    const rows = await store.listItemRows(trip.id)
    assert.deepEqual(rows.map((row) => [row.id, row.time_range, row.cost]), [
      ['literal', '  次日 01:00—03:00 JST\n另约  ', '  ¥ 80–120 / 人\n估算  '],
      ['empty', '', ''], ['omitted', null, null], ['undefined', null, null],
      ['time-only', '早上', null], ['cost-only', null, '免费'],
    ])
    const items = (await readTripCanvas(store, trip.id)).days[0]!.items
    assert.equal(items[0]?.timeRange, rows[0]?.time_range)
    assert.equal(items[0]?.cost, rows[0]?.cost)
    assert.equal(items[1]?.timeRange, '')
    assert.equal(items[1]?.cost, '')
    for (const id of ['omitted', 'undefined']) {
      const item = items.find((item) => item.id === id)!
      assert.equal(Object.hasOwn(item, 'timeRange'), false)
      assert.equal(Object.hasOwn(item, 'cost'), false)
    }

    assert.ok((await applyTripPatch(store, trip.id, { ops: [{ op: 'update_item', itemId: 'literal', timeRange: '', cost: undefined }] })).ok)
    let literal = (await store.listItemRows(trip.id)).find((row) => row.id === 'literal')!
    assert.equal(literal.time_range, '')
    assert.equal(literal.cost, '  ¥ 80–120 / 人\n估算  ')
    assert.ok((await applyTripPatch(store, trip.id, { ops: [{ op: 'update_item', itemId: 'literal', timeRange: undefined, cost: '' }] })).ok)
    literal = (await store.listItemRows(trip.id)).find((row) => row.id === 'literal')!
    assert.equal(literal.time_range, '')
    assert.equal(literal.cost, '')
  })

  test(`${backend} metadata-only patches keep route legs and the existing note:null clearing behavior`, async (t) => {
    const { store, trip } = await createFixture(t, backend)
    await seedItems(store, trip.id)
    const beforeItems = structuredClone(await store.listItemRows(trip.id))
    const beforeLegs = structuredClone(await store.listLegRows(trip.id))
    const result = await applyTripPatch(store, trip.id, { ops: [{ op: 'update_item', itemId: 'a', timeRange: ' 下午\n再定 ', cost: '' }] })
    assert.ok(result.ok, result.ok ? undefined : result.error)
    assert.equal(result.stats.itemsUpdated, 1)
    assert.equal(result.stats.legsWritten, 0)
    assert.deepEqual(await store.listLegRows(trip.id), beforeLegs)
    assert.deepEqual(await store.listItemRows(trip.id), beforeItems.map((row) => row.id === 'a' ? { ...row, time_range: ' 下午\n再定 ', cost: '' } : row))
    assert.ok((await applyTripPatch(store, trip.id, { ops: [{ op: 'update_item', itemId: 'a', title: '新标题', note: null }] })).ok)
    const item = (await store.listItemRows(trip.id)).find((row) => row.id === 'a')!
    assert.equal(item.note, '')
    assert.equal(item.time_range, ' 下午\n再定 ')
    assert.equal(item.cost, '')
    assert.deepEqual(await store.listLegRows(trip.id), beforeLegs)
  })

  test(`${backend} direct apply rejects bad metadata before any operation writes`, async (t) => {
    const { store, trip } = await createFixture(t, backend)
    await seedItems(store, trip.id)
    const before = structuredClone({ days: await store.listDayRows(trip.id), items: await store.listItemRows(trip.id), legs: await store.listLegRows(trip.id) })
    for (const op of ['add_item', 'update_item']) {
      for (const field of ['timeRange', 'cost']) {
        for (const value of [null, 0, false, {}, [], new Uint8Array([1])]) {
          const result = await applyTripPatch(store, trip.id, {
            ops: [
              { op: 'update_day', dayId: 'day-1', theme: '不能先写入' },
              { op, itemId: op === 'add_item' ? 'rejected' : 'a', dayId: 'day-1', type: 'other', title: '不能写入', pending: true, [field]: value },
            ],
          })
          assert.equal(result.ok, false, `${op}.${field}: ${JSON.stringify(value)}`)
          if (!result.ok) assert.equal(result.code, 'invalid')
          assert.deepEqual({ days: await store.listDayRows(trip.id), items: await store.listItemRows(trip.id), legs: await store.listLegRows(trip.id) }, before)
        }
      }
    }
  })

  test(`${backend} trusted item upserts validate before inserting or changing any item fields`, async (t) => {
    const { store, trip } = await createFixture(t, backend)
    await seedItems(store, trip.id)
    const before = structuredClone(await store.listItemRows(trip.id))
    const base: TripPatchItemUpsert = { id: 'a', dayId: 'day-1', itemOrder: 0, type: 'other', title: '不能写入', note: '不能写入', poi: null, pending: true }
    for (const id of ['a', 'new']) {
      for (const field of ['timeRange', 'cost']) {
        for (const value of [null, 1, true, {}, [], new Uint8Array([2])]) {
          const input = { ...base, id, timeRange: '合法兄弟字段', cost: '合法兄弟字段', [field]: value } as TripPatchItemUpsert
          await assert.rejects(store.upsertItemRow(trip.id, input))
          assert.deepEqual(await store.listItemRows(trip.id), before)
        }
      }
    }
    await store.upsertItemRow(trip.id, { ...base, title: '已更新', timeRange: undefined, cost: '  新费用  ' })
    const item = (await store.listItemRows(trip.id)).find((row) => row.id === 'a')!
    assert.equal(item.title, '已更新')
    assert.equal(item.time_range, '加载时段-a')
    assert.equal(item.cost, '  新费用  ')
  })
}

const concurrencyCases = [
  { label: 'title and note', ops: [{ op: 'update_item', itemId: 'a', title: '显式标题', note: '显式备注' }] },
  { label: 'undefined metadata', ops: [{ op: 'update_item', itemId: 'a', timeRange: undefined, cost: undefined }] },
  { label: 'time only', ops: [{ op: 'update_item', itemId: 'a', timeRange: '显式时段' }], timeRange: '显式时段' },
  { label: 'cost only', ops: [{ op: 'update_item', itemId: 'a', cost: '' }], cost: '' },
  { label: 'POI change and sibling rewrite', ops: [{ op: 'update_item', itemId: 'a', poi: { name: 'A2', lat: 50, lng: 120 } }] },
  { label: 'same day reorder', ops: [{ op: 'move_item', itemId: 'b', dayId: 'day-1', order: 0 }] },
  { label: 'cross day move and both day siblings', ops: [{ op: 'move_item', itemId: 'a', dayId: 'day-2', order: 0 }] },
  { label: 'insertion rewrites existing neighbors', ops: [{ op: 'add_item', itemId: 'new', dayId: 'day-1', order: 1, type: 'other', title: '新项', pending: true }] },
  { label: 'removal rewrites surviving neighbors', ops: [{ op: 'remove_item', itemId: 'b' }] },
  { label: 'day removal rewrites surviving day', ops: [{ op: 'remove_day', dayId: 'day-2' }] },
  { label: 'multiple explicit edits and movement', ops: [{ op: 'update_item', itemId: 'a', timeRange: '显式时段' }, { op: 'update_item', itemId: 'a', cost: '' }, { op: 'move_item', itemId: 'a', dayId: 'day-2', order: 0 }], timeRange: '显式时段', cost: '' },
]

for (const backend of ['SQLite', 'memory'] as const) {
  for (const timing of ['before transaction', 'at upsert'] as const) {
    test(`${backend} stale item projections preserve concurrent metadata ${timing}`, async (t) => {
      for (const scenario of concurrencyCases) {
        await t.test(scenario.label, async (t) => {
          const { db, store, trip } = await createFixture(t, backend)
          await seedItems(store, trip.id)
          const mutate = async () => {
            if (store instanceof MemoryTripPatchStore) {
              for (const row of store.itemRows) {
                row.time_range = `并发时段-${row.id}`
                row.cost = `并发费用-${row.id}`
              }
            } else {
              await db.run("UPDATE items SET time_range = '并发时段-' || id, cost = '并发费用-' || id WHERE trip_id = ?", [trip.id])
            }
          }
          let interleaved = false
          const originalUpsert = store.upsertItemRow.bind(store)
          store.upsertItemRow = async (tripId, item) => {
            if (timing === 'at upsert' && !interleaved) { interleaved = true; await mutate() }
            return originalUpsert(tripId, item)
          }
          const originalTransaction = store.withTransaction.bind(store)
          store.withTransaction = async (fn) => {
            if (timing === 'before transaction') { interleaved = true; await mutate() }
            return originalTransaction(fn)
          }
          // SQLite's transaction constructs its own driver; intercept that connection
          // to place the second writer at the first individual item INSERT as well.
          let applyStore: TripPatchStoreDriver = store
          if (backend === 'SQLite' && timing === 'at upsert') {
            const wrapDb = (connection: SqlDatabase): SqlDatabase => ({
              close: () => connection.close(),
              run: async (sql, args) => {
                if (/INSERT INTO items/.test(sql) && !interleaved) {
                  interleaved = true
                  await connection.run("UPDATE items SET time_range = '并发时段-' || id, cost = '并发费用-' || id WHERE trip_id = ?", [trip.id])
                }
                return connection.run(sql, args)
              },
              withTransaction: connection.withTransaction ? (fn) => connection.withTransaction!((transaction) => fn(wrapDb(transaction))) : undefined,
            })
            applyStore = new SqliteTripPatchStore(wrapDb(db))
          }
          const result = await applyTripPatch(applyStore, trip.id, { ops: scenario.ops })
          assert.ok(result.ok, result.ok ? undefined : result.error)
          assert.equal(interleaved, true, 'the concurrent write must occur before an item is persisted')
          for (const row of await store.listItemRows(trip.id)) {
            if (row.id === 'new') {
              assert.equal(row.time_range, null)
              assert.equal(row.cost, null)
              continue
            }
            assert.equal(row.time_range, row.id === 'a' ? scenario.timeRange ?? `并发时段-${row.id}` : `并发时段-${row.id}`)
            assert.equal(row.cost, row.id === 'a' ? scenario.cost ?? `并发费用-${row.id}` : `并发费用-${row.id}`)
          }
        })
      }
    })
  }
}

test('SQLite raw metadata and BLOB byte changes remain in snapshot hashes while tolerant reads omit only invalid fields', async (t) => {
  const { db, store, trip } = await createFixture(t)
  await seedItems(store, trip.id)
  const snapshot = async () => hashTripSnapshot(trip, await store.listDayRows(trip.id), await store.listItemRows(trip.id), await store.listLegRows(trip.id))
  const hashes = [await snapshot()]
  for (const field of ['time_range', 'cost']) {
    for (const value of ['  原文\n', '', null]) {
      await db.run(`UPDATE items SET ${field} = ? WHERE id = ?`, [value, 'a'])
      hashes.push(await snapshot())
    }
    for (const bytes of ['01', '03']) {
      await db.run(`UPDATE items SET ${field} = x'${bytes}' WHERE id = ?`, ['a'])
      const row = (await store.listItemRows(trip.id)).find((row) => row.id === 'a')!
      assert.ok(row[field === 'time_range' ? 'time_range' : 'cost'] instanceof ArrayBuffer)
      hashes.push(await snapshot())
    }
  }
  assert.equal(new Set(hashes).size, hashes.length)
  await db.run("UPDATE items SET time_range = x'05', cost = '  合法费用  ' WHERE id = ?", ['a'])
  const before = await store.listItemRows(trip.id)
  const canvas = await readTripCanvas(store, trip.id)
  const item = canvas.days[0]!.items.find((item) => item.id === 'a')!
  assert.equal(Object.hasOwn(item, 'timeRange'), false)
  assert.equal(item.cost, '  合法费用  ')
  assert.deepEqual(await store.listItemRows(trip.id), before, 'tolerant reads never repair stored metadata')
  const updated = await applyTripPatch(store, trip.id, { ops: [{ op: 'move_item', itemId: 'b', dayId: 'day-1', order: 0 }] })
  assert.ok(updated.ok, updated.ok ? undefined : updated.error)
  const after = (await store.listItemRows(trip.id)).find((row) => row.id === 'a')!
  assert.deepEqual(after.time_range, before.find((row) => row.id === 'a')!.time_range)
  assert.equal(after.cost, '  合法费用  ')
})

test('proposal snapshot tool carries valid item metadata from the raw patch store', async (t) => {
  const { store, trip } = await createFixture(t)
  await seedItems(store, trip.id)
  const context = new RequestContext()
  context.set(PROPOSAL_TRIP_ID_KEY, trip.id)
  const tool = createTripSnapshotTool({ resolveStore: async () => store })
  assert.ok(tool.execute)
  const result = await tool.execute({}, { requestContext: context, observe: noopObserve })
  assert.ok(result && typeof result === 'object' && 'ok' in result && result.ok)
  const canvas = TripCanvasSchema.parse(result)
  const item = canvas.days[0]!.items[0]!
  assert.equal(item.timeRange, '加载时段-a')
  assert.equal(item.cost, '加载费用-a')
})
