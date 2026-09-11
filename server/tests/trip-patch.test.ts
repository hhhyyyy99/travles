/**
 * TripPatch pipeline tests (ticket 08) — schema, validation rules and the
 * apply write path over the in-memory store (spec 测试接缝 #2 style: injectable
 * driver, tolerant reads, never throws).
 *
 * Rules covered (spec Implementation Decisions: 日期连续、无重叠住宿、交通段
 * 可达 + referential integrity): dates continuous/non-overlapping, at most
 * one stay per day, adjacency reachability (coordinates or 待定 flags),
 * unknown references rejected, legs rebuilt from item adjacency, patch ops
 * refer to in-patch creations.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import { applyTripPatch } from '../src/trip-patch/apply.js'

const TRIP = 'trip-patch-unit'

const poi = (name: string, lat: number, lng: number) => ({ name, lat, lng })

function planPatch(overrides: { ops?: unknown[] } = {}): unknown {
  return {
    ops: overrides.ops ?? [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02', theme: '草原穿越日' },
      {
        op: 'add_item',
        itemId: 'item-a',
        dayId: 'day-1',
        type: 'attraction',
        title: '莫尔格勒河',
        poi: poi('莫尔格勒河', 49.4072, 119.7478),
      },
      {
        op: 'add_item',
        itemId: 'item-b',
        dayId: 'day-1',
        type: 'stay',
        title: '全季酒店（待定）',
        pending: true,
        poi: poi('全季酒店', 49.2122, 119.7462),
      },
    ],
  }
}

test('valid plan patch applies: days/items/legs rows land, summary and stats report the change', async () => {
  const store = new MemoryTripPatchStore()
  const result = await applyTripPatch(store, TRIP, planPatch())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.summary, '已写入行程：新增 1 天、新增 2 张卡片')
  assert.deepEqual(result.stats, {
    daysAdded: 1,
    daysUpdated: 0,
    daysRemoved: 0,
    itemsAdded: 2,
    itemsUpdated: 0,
    itemsRemoved: 0,
    legsWritten: 1,
  })

  const days = await store.listDayRows(TRIP)
  assert.equal(days.length, 1)
  assert.equal(days[0]?.date, '2026-10-02')

  const items = await store.listItemRows(TRIP)
  assert.equal(items.length, 2)
  const stay = items.find((row) => row.id === 'item-b')
  assert.equal(stay?.pending, 1)
  assert.ok(String(stay?.poi).includes('全季酒店'))

  // Adjacency legs: one placeholder row (null distance — 待重算 by ticket 09).
  const legs = await store.listLegRows(TRIP)
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.from_item_id, 'item-a')
  assert.equal(legs[0]?.to_item_id, 'item-b')
  assert.equal(legs[0]?.distance_km, null)
})

test('two stays on one day are rejected with a readable error, nothing is written', async () => {
  const store = new MemoryTripPatchStore()
  const result = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
      { op: 'add_item', itemId: 's1', dayId: 'day-1', type: 'stay', title: '酒店A', poi: poi('酒店A', 1, 1) },
      { op: 'add_item', itemId: 's2', dayId: 'day-1', type: 'stay', title: '酒店B', poi: poi('酒店B', 2, 2) },
    ],
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /最多一个过夜住宿/)
  assert.match(result.error, /酒店A、酒店B/)
  assert.equal((await store.listDayRows(TRIP)).length, 0, 'rejected patch writes nothing')
})

test('dates must stay continuous and duplicate-free', async () => {
  const store = new MemoryTripPatchStore()
  const gap = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'd1', date: '2026-10-02' },
      { op: 'add_day', dayId: 'd2', date: '2026-10-04' },
    ],
  })
  assert.equal(gap.ok, false)
  if (!gap.ok) assert.match(gap.error, /日期不连续/)

  const duplicate = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'd1', date: '2026-10-02' },
      { op: 'add_day', dayId: 'd2', date: '2026-10-02' },
    ],
  })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) assert.match(duplicate.error, /日期不连续/)
})

test('items must reference existing or in-patch days; ids must be fresh', async () => {
  const store = new MemoryTripPatchStore()
  const unknownDay = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'add_item', itemId: 'x', dayId: 'nope', type: 'other', title: 'x' }],
  })
  assert.equal(unknownDay.ok, false)
  if (!unknownDay.ok) assert.match(unknownDay.error, /天「nope」不存在/)

  const duplicateId = await applyTripPatch(store, TRIP, planPatch())
  assert.equal(duplicateId.ok, true)
  const reAdd = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'add_item', itemId: 'item-a', dayId: 'day-1', type: 'other', title: 'dup' }],
  })
  assert.equal(reAdd.ok, false)
  if (!reAdd.ok) assert.match(reAdd.error, /已存在/)
})

test('reachability: a touched pair without coordinates and without 待定 flags is rejected', async () => {
  const store = new MemoryTripPatchStore()
  const result = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
      { op: 'add_item', itemId: 'a', dayId: 'day-1', type: 'attraction', title: '无坐标景点', poi: poi('无坐标景点', 1, 2) },
      { op: 'add_item', itemId: 'b', dayId: 'day-1', type: 'other', title: '神秘卡' },
    ],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /交通段不可达/)
})

test('reachability: pending or legPending flags make a coordinate-less pair valid', async () => {
  const store = new MemoryTripPatchStore()
  const pending = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
      { op: 'add_item', itemId: 'a', dayId: 'day-1', type: 'attraction', title: '景点', poi: poi('景点', 1, 2) },
      { op: 'add_item', itemId: 'b', dayId: 'day-1', type: 'stay', title: '未定酒店', pending: true },
    ],
  })
  assert.equal(pending.ok, true)

  const legPending = await applyTripPatch(store, 'trip-2', {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
      { op: 'add_item', itemId: 'a', dayId: 'day-1', type: 'attraction', title: '景点', poi: poi('景点', 1, 2) },
      { op: 'add_item', itemId: 't', dayId: 'day-1', type: 'traffic', title: '自驾前往恩和', legPending: true },
    ],
  })
  assert.equal(legPending.ok, true)
})

test('pairs the patch never touched are exempt from reachability (legacy/seed data stays valid)', async () => {
  const store = new MemoryTripPatchStore()
  // Seed a day with two coordinate-less cards through the store directly.
  await store.upsertDayRow(TRIP, { id: 'old-day', idx: 0, date: '2026-10-02', theme: '' })
  await store.upsertItemRow(TRIP, {
    id: 'old-a', dayId: 'old-day', itemOrder: 0, type: 'other', title: '旧卡A', note: '', poi: null, pending: false,
  })
  await store.upsertItemRow(TRIP, {
    id: 'old-b', dayId: 'old-day', itemOrder: 1, type: 'other', title: '旧卡B', note: '', poi: null, pending: false,
  })

  const result = await applyTripPatch(store, TRIP, {
    ops: [
      // appends to the same day but does not touch the old pair (patch legs
      // rebuild only the pairs around patched items — old cards keep no coords)
      { op: 'update_day', dayId: 'old-day', theme: '主题更新' },
      { op: 'update_item', itemId: 'old-a', note: 'note' },
    ],
  })
  assert.equal(result.ok, true)
})

test('remove_item / remove_day cascade legs, move_item re-parents, and orders reindex by sort', async () => {
  const store = new MemoryTripPatchStore()
  assert.equal(
    (await applyTripPatch(store, TRIP, {
      ops: [
        { op: 'add_day', dayId: 'd1', date: '2026-10-02' },
        { op: 'add_day', dayId: 'd2', date: '2026-10-03' },
        { op: 'add_item', itemId: 'i1', dayId: 'd1', type: 'attraction', title: 'A', poi: poi('A', 1, 1) },
        { op: 'add_item', itemId: 'i2', dayId: 'd1', type: 'attraction', title: 'B', poi: poi('B', 2, 2) },
        { op: 'add_item', itemId: 'i3', dayId: 'd2', type: 'stay', title: 'C', poi: poi('C', 3, 3) },
      ],
    })).ok,
    true,
  )

  const move = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'move_item', itemId: 'i2', dayId: 'd2' }],
  })
  assert.equal(move.ok, true)
  const items = await store.listItemRows(TRIP)
  const i2 = items.find((row) => row.id === 'i2')
  assert.equal(i2?.day_id, 'd2')
  // d1 legs rebuilt away (single item left), d2 got a new adjacency leg.
  const legs = await store.listLegRows(TRIP)
  assert.ok(legs.some((leg) => leg.from_item_id === 'i3' && leg.to_item_id === 'i2'))
  assert.ok(!legs.some((leg) => leg.from_item_id === 'i1' && leg.to_item_id === 'i2'))

  const remove = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'remove_item', itemId: 'i2' }],
  })
  assert.equal(remove.ok, true)
  const afterRemove = await store.listItemRows(TRIP)
  assert.ok(!afterRemove.some((row) => row.id === 'i2'))
  const legsAfter = await store.listLegRows(TRIP)
  assert.ok(!legsAfter.some((leg) => leg.to_item_id === 'i2'), 'cascade removed the dangling leg')

  const removeDay = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'remove_day', dayId: 'd1' }],
  })
  assert.equal(removeDay.ok, true)
  assert.equal((await store.listDayRows(TRIP)).length, 1)
  assert.ok(!(await store.listItemRows(TRIP)).some((row) => row.id === 'i1'))
})

test('a malformed patch (bad op / empty ops) is rejected with a schema error', async () => {
  const store = new MemoryTripPatchStore()
  assert.equal((await applyTripPatch(store, TRIP, { ops: [] })).ok, false)
  const bad = await applyTripPatch(store, TRIP, { ops: [{ op: 'teleport' }] })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error, /patch 结构无效/)
  const notAnObject = await applyTripPatch(store, TRIP, 'hello')
  assert.equal(notAnObject.ok, false)
})
