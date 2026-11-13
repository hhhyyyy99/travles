import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { hashTripSnapshot } from '../src/chat/confirmation.js'
import type { SqlDatabase } from '../src/db/driver.js'
import { applyTripPatch } from '../src/trip-patch/apply.js'
import { SqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'

async function createFixture(t: TestContext) {
  const sqlite = await createSqliteTripRepository(':memory:')
  t.after(() => sqlite.close())
  const created = await sqlite.repository.create({
    title: '草原行程', startDate: '2026-10-02', endDate: '2026-10-02',
  })
  assert.ok(created.ok)
  return { ...sqlite, trip: created.trip, store: new SqliteTripPatchStore(sqlite.db) }
}

test('SQLite add_day keeps explicit title and note verbatim beside the independent theme', async (t) => {
  const { store, trip } = await createFixture(t)
  const result = await applyTripPatch(store, trip.id, {
    ops: [{
      op: 'add_day', dayId: 'day-1', date: '2026-10-02', theme: '草原穿越',
      title: '  河畔漫游  ', note: '  带上相机\n第二行  ',
    }],
  })
  assert.ok(result.ok, result.ok ? undefined : result.error)
  const [day] = await store.listDayRows(trip.id)
  assert.deepEqual(day, {
    id: 'day-1', trip_id: trip.id, idx: 0, date: '2026-10-02', theme: '草原穿越', color: '',
    title: '  河畔漫游  ', note: '  带上相机\n第二行  ',
  })
})

test('SQLite update_day changes only explicit metadata and supports clearing with empty strings', async (t) => {
  const { store, trip } = await createFixture(t)
  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [{ op: 'add_day', dayId: 'day-1', date: '2026-10-02', theme: '草原', title: '旧标题', note: '旧备注' }],
  })).ok)

  const changedTitle = await applyTripPatch(store, trip.id, {
    ops: [{ op: 'update_day', dayId: 'day-1', title: '  新标题  ' }],
  })
  assert.ok(changedTitle.ok, changedTitle.ok ? undefined : changedTitle.error)
  let [day] = await store.listDayRows(trip.id)
  assert.equal(day?.title, '  新标题  ')
  assert.equal(day?.note, '旧备注')
  assert.equal(day?.theme, '草原')

  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [{ op: 'update_day', dayId: 'day-1', note: '  备忘\n第二行  ' }],
  })).ok)
  ;[day] = await store.listDayRows(trip.id)
  assert.equal(day?.title, '  新标题  ')
  assert.equal(day?.note, '  备忘\n第二行  ')

  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [{ op: 'update_day', dayId: 'day-1', title: '', note: '' }],
  })).ok)
  ;[day] = await store.listDayRows(trip.id)
  assert.equal(day?.title, '')
  assert.equal(day?.note, '')

  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [{ op: 'update_day', dayId: 'day-1', theme: '另一个主题' }],
  })).ok)
  ;[day] = await store.listDayRows(trip.id)
  assert.equal(day?.title, '')
  assert.equal(day?.note, '')
  assert.equal(day?.theme, '另一个主题')
})

test('SQLite add_day omission stays unset without deriving metadata from themes, items, or the trip', async (t) => {
  const { store, trip } = await createFixture(t)
  const result = await applyTripPatch(store, trip.id, {
    ops: [
      { op: 'add_day', dayId: 'unset', date: '2026-10-02', theme: '主题独立' },
      { op: 'add_day', dayId: 'empty', date: '2026-10-03', title: '', note: '' },
      { op: 'add_day', dayId: 'title-only', date: '2026-10-04', title: '只有标题' },
      { op: 'add_day', dayId: 'note-only', date: '2026-10-05', note: '只有备注' },
      { op: 'add_item', itemId: 'item-1', dayId: 'unset', type: 'other', title: '活动标题', note: '活动备注' },
    ],
  })
  assert.ok(result.ok, result.ok ? undefined : result.error)
  const days = await store.listDayRows(trip.id)
  assert.deepEqual(days.map((day) => [day.id, day.title, day.note]), [
    ['unset', null, null],
    ['empty', '', ''],
    ['title-only', '只有标题', null],
    ['note-only', null, '只有备注'],
  ])
  const untouched = days.find((day) => day.id === 'unset')
  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [{ op: 'update_day', dayId: 'unset' }],
  })).ok)
  assert.deepEqual((await store.listDayRows(trip.id)).find((day) => day.id === 'unset'), untouched)
})

test('SQLite day patches reject null and other nonstring metadata atomically', async (t) => {
  const { store, trip } = await createFixture(t)
  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [{ op: 'add_day', dayId: 'day-1', date: '2026-10-02', theme: '旧主题', title: '旧标题', note: '旧备注' }],
  })).ok)
  const before = await store.listDayRows(trip.id)
  for (const op of ['add_day', 'update_day']) {
    for (const field of ['title', 'note']) {
      for (const value of [null, 0, false, {}, []]) {
        const result = await applyTripPatch(store, trip.id, {
          ops: [
            { op: 'update_day', dayId: 'day-1', theme: '不应写入' },
            { op, dayId: op === 'add_day' ? 'rejected-day' : 'day-1', [field]: value },
          ],
        })
        assert.equal(result.ok, false, `${op}.${field} rejects ${JSON.stringify(value)}`)
        if (!result.ok) assert.equal(result.code, 'invalid')
        assert.deepEqual(await store.listDayRows(trip.id), before)
      }
    }
  }
})

test('SQLite stale day projections preserve newer omitted metadata for every update shape', async (t) => {
  const cases = [
    { label: 'theme only', fields: { theme: '新主题' }, title: '并发标题', note: '并发备注' },
    { label: 'date only', fields: { date: '2026-10-03' }, title: '并发标题', note: '并发备注' },
    { label: 'no changed fields', fields: {}, title: '并发标题', note: '并发备注' },
    { label: 'title only', fields: { title: '显式标题' }, title: '显式标题', note: '并发备注' },
    { label: 'note only', fields: { note: '显式备注' }, title: '并发标题', note: '显式备注' },
  ]
  for (const scenario of cases) {
    await t.test(scenario.label, async (t) => {
      const { db, store, trip } = await createFixture(t)
      assert.ok((await applyTripPatch(store, trip.id, {
        ops: [{ op: 'add_day', dayId: 'day-1', date: '2026-10-02', theme: '旧主题', title: '加载时标题', note: '加载时备注' }],
      })).ok)
      const interleavedDb: SqlDatabase = {
        run: (sql, args) => db.run(sql, args),
        close: () => db.close(),
        withTransaction: async (fn) => {
          // A second writer lands after projection reads, before patch writes.
          await db.run('UPDATE days SET title = ?, note = ? WHERE id = ? AND trip_id = ?', [
            '并发标题', '并发备注', 'day-1', trip.id,
          ])
          assert.ok(db.withTransaction)
          return db.withTransaction(fn)
        },
      }
      const result = await applyTripPatch(new SqliteTripPatchStore(interleavedDb), trip.id, {
        ops: [{ op: 'update_day', dayId: 'day-1', ...scenario.fields }],
      })
      assert.ok(result.ok, result.ok ? undefined : result.error)
      const [day] = await store.listDayRows(trip.id)
      assert.equal(day?.title, scenario.title)
      assert.equal(day?.note, scenario.note)
      assert.equal(day?.id, 'day-1')
      assert.equal(day?.trip_id, trip.id)
      assert.equal(day?.idx, 0)
      assert.equal(day?.date, scenario.fields.date ?? '2026-10-02')
      assert.equal(day?.theme, scenario.fields.theme ?? '旧主题')
    })
  }
})

test('SQLite snapshot hashes change for title or note alone, including invalid raw stored metadata', async (t) => {
  const { db, store, trip } = await createFixture(t)
  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [{ op: 'add_day', dayId: 'day-1', date: '2026-10-02' }],
  })).ok)
  const snapshot = async () => hashTripSnapshot(trip,
    await store.listDayRows(trip.id), await store.listItemRows(trip.id), await store.listLegRows(trip.id))
  const hashes = [await snapshot()]
  for (const fields of [{ title: '标题', note: null }, { title: '标题', note: '备注' }, { title: '', note: '备注' }]) {
    await db.run('UPDATE days SET title = ?, note = ? WHERE id = ? AND trip_id = ?', [
      fields.title, fields.note, 'day-1', trip.id,
    ])
    hashes.push(await snapshot())
  }
  // SQLite accepts blobs in a TEXT column; raw values must stay in the hash
  // even though tolerant canvas/projection mapping omits invalid strings.
  await db.run("UPDATE days SET title = x'01' WHERE id = ? AND trip_id = ?", ['day-1', trip.id])
  const [raw] = await store.listDayRows(trip.id)
  assert.ok(raw?.title instanceof ArrayBuffer)
  hashes.push(await snapshot())
  await db.run("UPDATE days SET title = x'03' WHERE id = ? AND trip_id = ?", ['day-1', trip.id])
  hashes.push(await snapshot())
  await db.run("UPDATE days SET note = x'02' WHERE id = ? AND trip_id = ?", ['day-1', trip.id])
  hashes.push(await snapshot())
  assert.equal(new Set(hashes).size, hashes.length)
})

test('SQLite metadata-only patches keep item and leg state, while unrelated item operations preserve day metadata', async (t) => {
  const { store, trip } = await createFixture(t)
  assert.ok((await applyTripPatch(store, trip.id, {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02', title: '第一天标题', note: '第一天备注' },
      { op: 'add_day', dayId: 'day-2', date: '2026-10-03', title: '第二天标题', note: '第二天备注' },
      { op: 'add_item', dayId: 'day-1', itemId: 'a', type: 'attraction', title: 'A', poi: { name: 'A', lat: 1, lng: 1 } },
      { op: 'add_item', dayId: 'day-1', itemId: 'b', type: 'food', title: 'B', poi: { name: 'B', lat: 2, lng: 2 } },
      { op: 'add_item', dayId: 'day-2', itemId: 'c', type: 'other', title: 'C', poi: { name: 'C', lat: 3, lng: 3 } },
    ],
  })).ok)
  const beforeItems = await store.listItemRows(trip.id)
  const beforeLegs = await store.listLegRows(trip.id)
  const updated = await applyTripPatch(store, trip.id, {
    ops: [{ op: 'update_day', dayId: 'day-1', title: '新的整日标题', note: '新的整日备注' }],
  })
  assert.ok(updated.ok, updated.ok ? undefined : updated.error)
  assert.equal(updated.stats.daysUpdated, 1)
  assert.equal(updated.stats.legsWritten, 0)
  assert.deepEqual(await store.listItemRows(trip.id), beforeItems)
  assert.deepEqual(await store.listLegRows(trip.id), beforeLegs)

  const beforeDays = await store.listDayRows(trip.id)
  const operations = [
    { op: 'update_item', itemId: 'a', title: '新的活动标题', note: '新的活动备注' },
    { op: 'add_item', dayId: 'day-1', itemId: 'd', type: 'other', title: '待定活动', note: '活动的备注', pending: true },
    { op: 'move_item', itemId: 'b', dayId: 'day-2', order: 0 },
    { op: 'remove_item', itemId: 'd' },
  ]
  for (const op of operations) {
    const result = await applyTripPatch(store, trip.id, { ops: [op] })
    assert.ok(result.ok, result.ok ? undefined : result.error)
    assert.deepEqual(await store.listDayRows(trip.id), beforeDays)
  }
  const removed = await applyTripPatch(store, trip.id, { ops: [{ op: 'remove_day', dayId: 'day-2' }] })
  assert.ok(removed.ok, removed.ok ? undefined : removed.error)
  assert.deepEqual(await store.listDayRows(trip.id), beforeDays.filter((day) => day.id === 'day-1'))
})
