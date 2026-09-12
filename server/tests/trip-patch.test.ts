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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import { applyTripPatch } from '../src/trip-patch/apply.js'
import { mapPoiRef } from '../src/days/repository.js'
import { estimateLeg } from '../src/items-admin/legs.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import { SqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'

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

  assert.deepEqual(mapPoiRef(stay?.poi), {
    amapId: '', name: '全季酒店', lat: 49.2122, lng: 119.7462,
    category: '', rating: 0, introSummary: '',
  })

  const legs = await store.listLegRows(TRIP)
  assert.equal(legs.length, 1)
  assert.equal(legs[0]?.from_item_id, 'item-a')
  assert.equal(legs[0]?.to_item_id, 'item-b')
  assert.ok(Number(legs[0]?.distance_km) > 20)
  assert.ok(Number(legs[0]?.duration_min) > 20)
})

test('canvas POI mapping keeps coordinates from flat item-admin storage', () => {
  assert.deepEqual(mapPoiRef(JSON.stringify({ name: 'API 景点', lat: 49.21, lng: 119.76 })), {
    amapId: '', name: 'API 景点', lat: 49.21, lng: 119.76,
    category: '', rating: 0, introSummary: '',
  })
})

test('patch leg rebuild preserves known routes when a new stop is appended', async () => {
  const store = new MemoryTripPatchStore()
  assert.equal((await applyTripPatch(store, TRIP, planPatch())).ok, true)
  await store.upsertLegRow(TRIP, {
    id: 'leg-item-a-item-b', fromItemId: 'item-a', toItemId: 'item-b', mode: 'drive',
    distanceKm: 35, durationMin: 42, polyline: '[[119.7478,49.4072],[119.7462,49.2122]]',
  })
  const result = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'add_item', itemId: 'item-c', dayId: 'day-1', type: 'food', title: '晚餐',
      poi: poi('晚餐', 49.2, 119.75) }],
  })
  assert.equal(result.ok, true)
  const legs = await store.listLegRows(TRIP)
  const known = legs.find((leg) => leg.from_item_id === 'item-a')
  assert.equal(known?.distance_km, 35)
  assert.equal(known?.duration_min, 42)
  assert.equal(known?.polyline, '[[119.7478,49.4072],[119.7462,49.2122]]')
  assert.ok(Number(legs.find((leg) => leg.to_item_id === 'item-c')?.distance_km) > 0)
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

test('add_item rejects a same-trip id even when the existing card is on another day', async () => {
  const store = new MemoryTripPatchStore()
  const initial = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'd1', date: '2026-10-02' },
      { op: 'add_day', dayId: 'd2', date: '2026-10-03' },
      { op: 'add_item', itemId: 'shared-card', dayId: 'd1', type: 'attraction', title: '第一天', poi: poi('第一天', 1, 1) },
    ],
  })
  assert.equal(initial.ok, true)

  const duplicate = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'add_item', itemId: 'shared-card', dayId: 'd2', type: 'attraction', title: '第二天', poi: poi('第二天', 2, 2) }],
  })
  assert.equal(duplicate.ok, false)
  if (!duplicate.ok) {
    assert.match(duplicate.error, /卡片「shared-card」已存在/)
    assert.equal(duplicate.code, 'invalid')
  }
  const cards = await store.listItemRows(TRIP)
  assert.deepEqual(cards.map((row) => [row.id, row.day_id, row.title]), [['shared-card', 'd1', '第一天']])
})

test('add_day and add_item reject ids owned by another trip before writing', async () => {
  const store = new MemoryTripPatchStore()
  await store.upsertDayRow('other-trip', { id: 'foreign-day', idx: 0, date: '2026-10-02', theme: '' })
  await store.upsertItemRow('other-trip', {
    id: 'foreign-card', dayId: 'foreign-day', itemOrder: 0, type: 'other', title: '别的行程', note: '', poi: null, pending: false,
  })

  const dayCollision = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'add_day', dayId: 'foreign-day', date: '2026-10-02' }],
  })
  assert.equal(dayCollision.ok, false)
  if (!dayCollision.ok) {
    assert.equal(dayCollision.code, 'invalid')
    assert.match(dayCollision.error, /foreign-day.*其他行程冲突/)
  }

  const itemCollision = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'new-day', date: '2026-10-02' },
      { op: 'add_item', itemId: 'foreign-card', dayId: 'new-day', type: 'other', title: '不应覆盖' },
    ],
  })
  assert.equal(itemCollision.ok, false)
  if (!itemCollision.ok) {
    assert.equal(itemCollision.code, 'invalid')
    assert.match(itemCollision.error, /foreign-card.*其他行程冲突/)
  }
  assert.equal((await store.listDayRows(TRIP)).length, 0, 'the rejected patch created no target day')
  assert.deepEqual((await store.listItemRows('other-trip')).map((row) => row.title), ['别的行程'])
})

test('update_item POI changes invalidate every adjacent stored leg touching that card', async () => {
  const store = new MemoryTripPatchStore()
  const initial = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'poi-day', date: '2026-10-02' },
      { op: 'add_item', itemId: 'poi-a', dayId: 'poi-day', type: 'attraction', title: 'A', poi: poi('A', 1, 1) },
      { op: 'add_item', itemId: 'poi-b', dayId: 'poi-day', type: 'attraction', title: 'B', poi: poi('B', 2, 2) },
      { op: 'add_item', itemId: 'poi-c', dayId: 'poi-day', type: 'attraction', title: 'C', poi: poi('C', 3, 3) },
    ],
  })
  assert.equal(initial.ok, true)

  // Give both old pairs values that would be visibly stale after B moves.
  await store.upsertLegRow(TRIP, {
    id: 'leg-poi-a-poi-b', fromItemId: 'poi-a', toItemId: 'poi-b', mode: 'drive',
    distanceKm: 12.3, durationMin: 13, polyline: 'old-a-b',
  })
  await store.upsertLegRow(TRIP, {
    id: 'leg-poi-b-poi-c', fromItemId: 'poi-b', toItemId: 'poi-c', mode: 'drive',
    distanceKm: 45.6, durationMin: 46, polyline: 'old-b-c',
  })

  const updated = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'update_item', itemId: 'poi-b', poi: poi('B-new', 50, 50) }],
  })
  assert.equal(updated.ok, true)
  if (!updated.ok) return
  assert.equal(updated.stats.legsWritten, 2)

  const rows = await store.listItemRows(TRIP)
  const a = mapPoiRef(rows.find((row) => row.id === 'poi-a')?.poi)
  const b = mapPoiRef(rows.find((row) => row.id === 'poi-b')?.poi)
  const c = mapPoiRef(rows.find((row) => row.id === 'poi-c')?.poi)
  const expectedAB = estimateLeg(a, b)
  const expectedBC = estimateLeg(b, c)
  const legs = await store.listLegRows(TRIP)
  const ab = legs.find((leg) => leg.id === 'leg-poi-a-poi-b')
  const bc = legs.find((leg) => leg.id === 'leg-poi-b-poi-c')
  assert.equal(ab?.distance_km, expectedAB?.distanceKm)
  assert.equal(ab?.duration_min, expectedAB?.durationMin)
  assert.equal(ab?.polyline, null)
  assert.equal(bc?.distance_km, expectedBC?.distanceKm)
  assert.equal(bc?.duration_min, expectedBC?.durationMin)
  assert.equal(bc?.polyline, null)
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
      { op: 'add_day', dayId: 'day-2', date: '2026-10-02' },
      { op: 'add_item', itemId: 'a-2', dayId: 'day-2', type: 'attraction', title: '景点', poi: poi('景点', 1, 2) },
      { op: 'add_item', itemId: 't-2', dayId: 'day-2', type: 'traffic', title: '自驾前往恩和', legPending: true },
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

test('positional TripPatch operations persist the final order of neighboring cards', async () => {
  const store = new MemoryTripPatchStore()
  const initial = await applyTripPatch(store, TRIP, {
    ops: [
      { op: 'add_day', dayId: 'ordered-day', date: '2026-10-02' },
      { op: 'add_item', itemId: 'first', dayId: 'ordered-day', type: 'attraction', title: 'First', poi: poi('First', 1, 1) },
      { op: 'add_item', itemId: 'second', dayId: 'ordered-day', type: 'attraction', title: 'Second', poi: poi('Second', 2, 2) },
    ],
  })
  assert.equal(initial.ok, true)

  const moved = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'move_item', itemId: 'second', dayId: 'ordered-day', order: 0 }],
  })
  assert.equal(moved.ok, true)
  assert.deepEqual(
    (await store.listItemRows(TRIP)).sort((a, b) => Number(a.item_order) - Number(b.item_order)).map((row) => [row.id, row.item_order]),
    [['second', 0], ['first', 1]],
  )

  const inserted = await applyTripPatch(store, TRIP, {
    ops: [{ op: 'add_item', itemId: 'middle', dayId: 'ordered-day', type: 'food', title: 'Middle', poi: poi('Middle', 3, 3), order: 1 }],
  })
  assert.equal(inserted.ok, true)
  assert.deepEqual(
    (await store.listItemRows(TRIP)).sort((a, b) => Number(a.item_order) - Number(b.item_order)).map((row) => [row.id, row.item_order]),
    [['second', 0], ['middle', 1], ['first', 2]],
  )
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

test('real SQLite rejects cross-trip ids without changing either trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trip-patch-sqlite-'))
  const sqlite = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
  try {
    const ownerResult = await sqlite.repository.create({ title: '目标行程', startDate: '2026-10-02', endDate: '2026-10-02' })
    const otherResult = await sqlite.repository.create({ title: '已有行程', startDate: '2026-10-02', endDate: '2026-10-02' })
    assert.equal(ownerResult.ok, true)
    assert.equal(otherResult.ok, true)
    if (!ownerResult.ok || !otherResult.ok) return

    await sqlite.db.run(
      "INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES ('foreign-day', ?, 0, '2026-10-02', '', '')",
      [otherResult.trip.id],
    )
    await sqlite.db.run(
      "INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending) VALUES ('foreign-card', ?, 'foreign-day', 0, 'other', '别的行程', '', NULL, NULL, 0)",
      [otherResult.trip.id],
    )

    const result = await applyTripPatch(new SqliteTripPatchStore(sqlite.db), ownerResult.trip.id, {
      ops: [
        { op: 'add_day', dayId: 'owner-day', date: '2026-10-02' },
        { op: 'add_item', itemId: 'foreign-card', dayId: 'owner-day', type: 'other', title: '不应覆盖' },
      ],
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'invalid')
      assert.match(result.error, /foreign-card.*其他行程冲突/)
    }

    const ownerDays = await sqlite.db.run('SELECT id FROM days WHERE trip_id = ?', [ownerResult.trip.id])
    const ownerItems = await sqlite.db.run('SELECT id FROM items WHERE trip_id = ?', [ownerResult.trip.id])
    assert.equal(ownerDays.rows.length, 0, 'preflight collision prevents the target day write')
    assert.equal(ownerItems.rows.length, 0, 'preflight collision prevents the target item write')
    const foreign = await sqlite.db.run('SELECT trip_id, title FROM items WHERE id = ?', ['foreign-card'])
    assert.deepEqual(foreign.rows[0], { trip_id: otherResult.trip.id, title: '别的行程' })
  } finally {
    await sqlite.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('real SQLite rolls back earlier patch writes when a later leg id belongs to another trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trip-patch-sqlite-rollback-'))
  const sqlite = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
  try {
    const ownerResult = await sqlite.repository.create({ title: '目标行程', startDate: '2026-10-02', endDate: '2026-10-02' })
    const otherResult = await sqlite.repository.create({ title: '已有路线', startDate: '2026-10-02', endDate: '2026-10-02' })
    assert.equal(ownerResult.ok, true)
    assert.equal(otherResult.ok, true)
    if (!ownerResult.ok || !otherResult.ok) return

    await sqlite.db.run(
      "INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline) VALUES ('leg-rollback-a-rollback-b', ?, 'ghost-a', 'ghost-b', 'drive', 777, 888, 'old-route')",
      [otherResult.trip.id],
    )

    const result = await applyTripPatch(new SqliteTripPatchStore(sqlite.db), ownerResult.trip.id, {
      ops: [
        { op: 'add_day', dayId: 'rollback-day', date: '2026-10-02' },
        { op: 'add_item', itemId: 'rollback-a', dayId: 'rollback-day', type: 'attraction', title: 'A', poi: poi('A', 1, 1) },
        { op: 'add_item', itemId: 'rollback-b', dayId: 'rollback-day', type: 'attraction', title: 'B', poi: poi('B', 2, 2) },
      ],
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'invalid')
      assert.match(result.error, /leg-rollback-a-rollback-b.*其他行程冲突/)
    }

    const ownerDays = await sqlite.db.run('SELECT id FROM days WHERE trip_id = ?', [ownerResult.trip.id])
    const ownerItems = await sqlite.db.run('SELECT id FROM items WHERE trip_id = ?', [ownerResult.trip.id])
    assert.equal(ownerDays.rows.length, 0, 'the day insert was rolled back')
    assert.equal(ownerItems.rows.length, 0, 'the item inserts were rolled back')
    const oldLeg = await sqlite.db.run('SELECT trip_id, distance_km, duration_min FROM legs WHERE id = ?', ['leg-rollback-a-rollback-b'])
    assert.deepEqual(oldLeg.rows[0], { trip_id: otherResult.trip.id, distance_km: 777, duration_min: 888 })
  } finally {
    await sqlite.close()
    await rm(dir, { recursive: true, force: true })
  }
})
