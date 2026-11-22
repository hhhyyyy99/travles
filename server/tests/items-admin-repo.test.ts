/**
 * Items-admin repository unit tests (ticket 09) — move/copy/create/update/
 * delete over the in-memory driver, plus the pure legs-recompute rules
 * (same-pair reuse, direction-safe estimates for reordered pairs, haversine
 * × 1.2 estimates, empty 0/0 legs for unknown coordinates).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryItemsAdminStoreDriver } from '../src/items-admin/driver-memory.js'
import { ItemsAdminRepository } from '../src/items-admin/repository.js'
import {
  adjacentTripPairs,
  estimateLeg,
  haversineKm,
  recomputeTripLegs,
} from '../src/items-admin/legs.js'
import type { CanvasItem, CanvasLeg, ItemRow, LegRow, PoiRef } from '../src/days/types.js'

const TRIP = 't1'

function poi(lng: number, lat: number, name = '点'): PoiRef {
  return { amapId: '', name, lat, lng, category: '', rating: 0, introSummary: '' }
}

function item(
  id: string,
  dayId: string,
  order: number,
  extra: Partial<CanvasItem> = {},
): CanvasItem {
  return {
    id,
    dayId,
    order,
    type: 'attraction',
    title: `卡片 ${id}`,
    note: '',
    poi: null,
    images: [],
    pending: false,
    ...extra,
  }
}

function legRow(id: string, from: string, to: string, extra: Partial<LegRow> = {}): LegRow {
  return {
    id,
    trip_id: TRIP,
    from_item_id: from,
    to_item_id: to,
    mode: 'drive',
    distance_km: 30.3,
    duration_min: 31,
    polyline: JSON.stringify([
      [119.7, 49.2],
      [119.85, 49.42],
    ]),
    ...extra,
  }
}

/** Two days: day-1 = [i1 (POI 49.2/119.7), i2 (POI 49.42/119.85), i3], day-2 = [i4, i5]. */
function seedDriver(
  driver: MemoryItemsAdminStoreDriver,
  legs: LegRow[] = [legRow('leg-seed', 'i1', 'i2')],
): void {
  driver.dayRows.set('day-1', {
    id: 'day-1',
    trip_id: TRIP,
    idx: 0,
    date: '2026-10-02',
    theme: '抵达',
    color: '',
  })
  driver.dayRows.set('day-2', {
    id: 'day-2',
    trip_id: TRIP,
    idx: 1,
    date: '2026-10-03',
    theme: '草原',
    color: '',
  })
  const rows: ItemRow[] = [
    itemRow('i1', 'day-1', 0, poi(119.7, 49.2)),
    itemRow('i2', 'day-1', 1, poi(119.85, 49.42)),
    itemRow('i3', 'day-1', 2),
    itemRow('i4', 'day-2', 0),
    itemRow('i5', 'day-2', 1),
  ]
  for (const row of rows) driver.itemRows.set(row.id as string, row)
  for (const leg of legs) driver.legRows.set(leg.id as string, leg)
}

function itemRow(
  id: string,
  dayId: string,
  order: number,
  poiValue: PoiRef | null = null,
): ItemRow {
  return {
    id,
    trip_id: TRIP,
    day_id: dayId,
    item_order: order,
    type: 'attraction',
    title: `卡片 ${id}`,
    note: null,
    poi: poiValue === null ? null : JSON.stringify(poiValue),
    images: null,
    pending: 0,
  }
}

function driverItems(driver: MemoryItemsAdminStoreDriver): CanvasItem[] {
  return [...driver.itemRows.values()]
    .map((row) => row)
    .sort((a, b) => Number(a.item_order) - Number(b.item_order))
    .map((row) => ({
      id: row.id as string,
      dayId: row.day_id as string,
      order: Number(row.item_order),
      type: 'other' as const,
      title: row.title as string,
      note: '',
      poi: null,
      images: [],
      pending: false,
    }))
}

// ---------------------------------------------------------------------------
// Pure legs recompute
// ---------------------------------------------------------------------------

void test('recomputeTripLegs reuses a stored same-direction pair verbatim', () => {
  const stored: CanvasLeg[] = [
    {
      id: 'leg-old',
      fromItemId: 'a',
      toItemId: 'b',
      mode: 'drive',
      distanceKm: 30.3,
      durationMin: 31,
      polyline: [
        [119.7, 49.2],
        [119.85, 49.42],
      ],
    },
  ]
  const legs = recomputeTripLegs([item('a', 'd', 0), item('b', 'd', 1)], stored)
  assert.equal(legs.length, 1)
  assert.equal(legs[0]!.id, 'leg-a-b')
  assert.equal(legs[0]!.distanceKm, 30.3)
  assert.equal(legs[0]!.durationMin, 31)
  assert.deepEqual(legs[0]!.polyline, [
    [119.7, 49.2],
    [119.85, 49.42],
  ])
})

void test('recomputeTripLegs estimates a reversed pair instead of replaying one-way geometry', () => {
  const stored: CanvasLeg[] = [
    {
      id: 'leg-old',
      fromItemId: 'b',
      toItemId: 'a',
      mode: 'drive',
      distanceKm: 30.3,
      durationMin: 31,
      polyline: [
        [119.7, 49.2],
        [120, 49.3],
        [119.85, 49.42],
      ],
    },
  ]
  const legs = recomputeTripLegs(
    [item('a', 'd', 0, { poi: poi(119.7, 49.2) }), item('b', 'd', 1, { poi: poi(119.85, 49.42) })],
    stored,
  )
  assert.equal(legs.length, 1)
  assert.equal(legs[0]!.distanceKm, 32.1, 'the ordered pair gets a straight-line estimate')
  assert.equal(legs[0]!.durationMin, 32)
  assert.equal(legs[0]!.polyline, null, 'one-way geometry is never reversed into the new direction')
})

void test('recomputeTripLegs estimates unknown pairs (haversine × 1.2, ~60 km/h) and empties impossible ones', () => {
  // ~29 km straight line between the two seed POIs → × 1.2 road factor.
  const estimated = estimateLeg(poi(119.7, 49.2), poi(119.85, 49.42))
  assert.ok(estimated !== null)
  assert.ok(
    estimated.distanceKm > 25 && estimated.distanceKm < 40,
    `unexpected estimate ${estimated.distanceKm}`,
  )
  assert.equal(estimated.durationMin, Math.max(1, Math.round(estimated.distanceKm)))

  // No coordinates on either side → the empty leg the UI hides.
  const legs = recomputeTripLegs([item('a', 'd', 0), item('b', 'd', 1)], [])
  assert.deepEqual(legs[0], {
    id: 'leg-a-b',
    fromItemId: 'a',
    toItemId: 'b',
    mode: 'drive',
    distanceKm: 0,
    durationMin: 0,
    polyline: null,
    quality: 'pending',
  })
})

void test('haversineKm matches the known Hailar–Ergun distance ballpark', () => {
  const km = haversineKm([119.766, 49.212], [120.183, 50.243])
  assert.ok(km > 110 && km < 130, `unexpected distance ${km}`)
})

void test('recomputeTripLegs keeps callers without day order on same-day pairs', () => {
  const legs = recomputeTripLegs(
    [item('a', 'd1', 0), item('b', 'd1', 1), item('c', 'd2', 0, { poi: poi(119.7, 49.2) })],
    [],
  )
  assert.equal(legs.length, 1, 'single-item day d2 produces no leg')
  assert.equal(legs[0]!.fromItemId, 'a')
  assert.equal(legs[0]!.toItemId, 'b')
})

void test('authoritative day order adds exact bridges and skips empty-day gaps', () => {
  const items = [item('a', 'd1', 0), item('b', 'd1', 1), item('c', 'd3', 0), item('d', 'd4', 0)]
  const dayOrder = [
    { id: 'd1', index: 0 },
    { id: 'd2', index: 1 },
    { id: 'd3', index: 2 },
    { id: 'd4', index: 3 },
  ]
  const pairs = adjacentTripPairs(items, dayOrder)
  assert.deepEqual(
    pairs.map((pair) => [pair.from.id, pair.to.id]),
    [
      ['a', 'b'],
      ['c', 'd'],
    ],
  )
  assert.deepEqual(
    recomputeTripLegs(items, [], dayOrder).map((leg) => [leg.fromItemId, leg.toItemId]),
    [
      ['a', 'b'],
      ['c', 'd'],
    ],
  )
})

// ---------------------------------------------------------------------------
// Repository coverage (memory driver)
// ---------------------------------------------------------------------------

void test('moveItem reorders within a day: renumbers orders and recomputes legs with reuse', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)

  const result = await repo.moveItem(TRIP, 'i1', { index: 1 })
  assert.ok(result.ok)
  if (!result.ok) return

  // day-1 becomes [i2, i1, i3] with orders 0,1,2.
  const day1 = driverItems(driver).filter((entry) => entry.dayId === 'day-1')
  assert.deepEqual(
    day1.map((entry) => entry.id),
    ['i2', 'i1', 'i3'],
  )
  assert.deepEqual(
    day1.map((entry) => entry.order),
    [0, 1, 2],
  )

  // Legs: day-1 pairs i2→i1 (direction-safe estimate) and i1→i3
  // (no coords → 0/0), day-2's i4→i5, and the incoming day-2 bridge i3→i4.
  assert.equal(result.legs.length, 4)
  const reversed = result.legs.find((leg) => leg.fromItemId === 'i2' && leg.toItemId === 'i1')
  assert.ok(reversed)
  assert.equal(reversed.distanceKm, 32.1, 'the reversed pair gets its own estimate')
  assert.equal(reversed.durationMin, 32)
  assert.equal(reversed.polyline, null, 'one-way geometry is not replayed')
  const tail = result.legs.find((leg) => leg.fromItemId === 'i1' && leg.toItemId === 'i3')
  assert.ok(tail)
  assert.equal(tail.distanceKm, 0)
  assert.equal(tail.polyline, null)
  assert.equal(
    result.legs.find((leg) => leg.fromItemId === 'i3' && leg.toItemId === 'i4')?.quality,
    'pending',
  )
})

void test('moveItem crosses days, renumbers both, and estimates the new adjacent pairs', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)

  const result = await repo.moveItem(TRIP, 'i1', { dayId: 'day-2', index: 0 })
  assert.ok(result.ok)
  if (!result.ok) return

  const rows = driverItems(driver)
  assert.deepEqual(
    rows.filter((entry) => entry.dayId === 'day-1').map((entry) => entry.id),
    ['i2', 'i3'],
  )
  assert.deepEqual(
    rows.filter((entry) => entry.dayId === 'day-2').map((entry) => entry.id),
    ['i1', 'i4', 'i5'],
  )
  assert.equal(result.legs.length, 4, 'same-day pairs plus the incoming day-2 boundary')
  assert.ok(result.legs.some((leg) => leg.fromItemId === 'i2' && leg.toItemId === 'i3'))
  assert.ok(result.legs.some((leg) => leg.fromItemId === 'i3' && leg.toItemId === 'i1'))
  assert.ok(result.legs.some((leg) => leg.fromItemId === 'i1' && leg.toItemId === 'i4'))
  assert.ok(result.legs.some((leg) => leg.fromItemId === 'i4' && leg.toItemId === 'i5'))
  assert.equal(result.item.id, 'i1')
  assert.equal(result.item.dayId, 'day-2')
  assert.equal(result.item.order, 0, 'the response carries the moved item with its new order')
})

void test('moveItem rejects unknown items and days; a missing index appends at the end', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)

  const badItem = await repo.moveItem(TRIP, 'ghost', {})
  assert.deepEqual(badItem, { ok: false, error: '卡片不存在', code: 'not_found' })

  const badDay = await repo.moveItem(TRIP, 'i1', { dayId: 'day-x' })
  assert.deepEqual(badDay, { ok: false, error: '日程不存在', code: 'not_found' })

  const append = await repo.moveItem(TRIP, 'i1', {})
  assert.ok(append.ok)
  const day1 = driverItems(driver).filter((entry) => entry.dayId === 'day-1')
  assert.equal(day1[day1.length - 1]!.id, 'i1')
})

void test('copyItem duplicates the card with a fresh id, POI and images intact', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  driver.itemRows.set('i1', {
    ...driver.itemRows.get('i1')!,
    images: JSON.stringify([{ url: 'https://example.com/a.jpg', caption: '外观' }]),
  })
  const repo = new ItemsAdminRepository(driver)

  const result = await repo.copyItem(TRIP, 'i1', { dayId: 'day-2', index: 0 })
  assert.ok(result.ok)
  if (!result.ok) return

  assert.notEqual(result.item.id, 'i1')
  assert.match(result.item.id, /^item-/)
  assert.equal(result.item.dayId, 'day-2')
  assert.equal(result.item.poi?.name, '点')
  assert.deepEqual(result.item.images, [{ url: 'https://example.com/a.jpg', caption: '外观' }])

  const rows = driverItems(driver)
  assert.equal(rows.length, 6, 'copy adds a row')
  const day2 = rows.filter((entry) => entry.dayId === 'day-2')
  assert.deepEqual(
    day2.map((entry) => entry.id),
    [result.item.id, 'i4', 'i5'],
  )
})

void test('createItem adds a free-text or POI card at the requested index', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)

  const freeText = await repo.createItem(TRIP, {
    dayId: 'day-2',
    title: '  自由活动  ',
    note: '草原骑马',
  })
  assert.ok(freeText.ok)
  if (freeText.ok) {
    assert.equal(freeText.item.poi, null, 'free-text cards carry no POI')
    assert.equal(freeText.item.note, '草原骑马')
    assert.equal(freeText.item.type, 'other')
  }

  const poiCard = await repo.createItem(TRIP, {
    dayId: 'day-2',
    title: '莫尔格勒河',
    type: 'attraction',
    poi: { name: '莫尔格勒河', lat: 49.35, lng: 119.62, category: '景点' },
    images: [{ url: 'https://example.com/p.jpg' }],
    index: 0,
  })
  assert.ok(poiCard.ok)
  if (poiCard.ok) {
    assert.equal(poiCard.item.type, 'attraction')
    assert.equal(poiCard.item.poi?.lng, 119.62)
    assert.deepEqual(poiCard.item.images, [{ url: 'https://example.com/p.jpg', caption: '' }])
  }

  const rows = driverItems(driver).filter((entry) => entry.dayId === 'day-2')
  assert.equal(rows[0]!.id, poiCard.ok ? poiCard.item.id : '')
  assert.equal(rows.length, 4)

  const legs = await repo.createItem(TRIP, { dayId: 'day-x', title: '无处安放' })
  assert.deepEqual(legs, { ok: false, error: '日程不存在', code: 'not_found' })
  const noTitle = await repo.createItem(TRIP, { dayId: 'day-1', title: '   ' })
  assert.equal(noTitle.ok, false)
  if (!noTitle.ok) assert.equal(noTitle.code, 'invalid')
  const badPoi = await repo.createItem(TRIP, { dayId: 'day-1', title: 'x', poi: 'not-an-object' })
  assert.equal(badPoi.ok, false)
  const badImages = await repo.createItem(TRIP, { dayId: 'day-1', title: 'x', images: 'nope' })
  assert.equal(badImages.ok, false)
})

void test('updateItem edits note/images in place and leaves positions untouched', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)

  const result = await repo.updateItem(TRIP, 'i3', {
    note: '20:00 抵达',
    images: [{ url: 'https://example.com/n.jpg', caption: '新图' }],
  })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.item.note, '20:00 抵达')
  assert.deepEqual(result.item.images, [{ url: 'https://example.com/n.jpg', caption: '新图' }])

  const row = driver.itemRows.get('i3')!
  assert.equal(row.note, '20:00 抵达')
  assert.equal(row.images, JSON.stringify([{ url: 'https://example.com/n.jpg', caption: '新图' }]))
  assert.equal(row.day_id, 'day-1', 'position untouched')
  assert.equal(Number(row.item_order), 2)
  assert.equal(driver.legRows.size, 1, 'no leg recompute on field edits')

  const badImages = await repo.updateItem(TRIP, 'i3', { images: 'nope' })
  assert.equal(badImages.ok, false)
  const ghost = await repo.updateItem(TRIP, 'ghost', { note: 'x' })
  assert.deepEqual(ghost, { ok: false, error: '卡片不存在', code: 'not_found' })
})

void test('deleteItem removes the card, closes the gap, and recomputes legs', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)

  const result = await repo.deleteItem(TRIP, 'i2')
  assert.ok(result.ok)
  if (!result.ok) return

  const day1 = driverItems(driver).filter((entry) => entry.dayId === 'day-1')
  assert.deepEqual(
    day1.map((entry) => entry.id),
    ['i1', 'i3'],
  )
  assert.deepEqual(
    day1.map((entry) => entry.order),
    [0, 1],
  )
  assert.equal(result.legs.length, 3, 'day-1 pair i1→i3 + incoming bridge + day-2 pair i4→i5')
  assert.ok(result.legs.some((leg) => leg.fromItemId === 'i1' && leg.toItemId === 'i3'))
  assert.ok(result.legs.some((leg) => leg.fromItemId === 'i3' && leg.toItemId === 'i4'))

  const ghost = await repo.deleteItem(TRIP, 'i2')
  assert.deepEqual(ghost, { ok: false, error: '卡片不存在', code: 'not_found' })
})

void test('driver write failures surface as storage errors instead of throwing', async () => {
  const driver = new MemoryItemsAdminStoreDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)

  driver.nextWriteError = new Error('disk full')
  const move = await repo.moveItem(TRIP, 'i1', { index: 1 })
  assert.equal(move.ok, false)
  if (!move.ok) assert.equal(move.code, 'storage')
  // The failed mutation left the stored layout untouched.
  const day1 = driverItems(driver).filter((entry) => entry.dayId === 'day-1')
  assert.deepEqual(
    day1.map((entry) => entry.id),
    ['i1', 'i2', 'i3'],
  )

  driver.nextWriteError = new Error('disk full')
  const del = await repo.deleteItem(TRIP, 'i2')
  assert.equal(del.ok, false)
  if (!del.ok) assert.equal(del.error, '删除失败')
})

void test('layout writes roll back cards and orders when the legs write fails late', async () => {
  class FailLegReplacementDriver extends MemoryItemsAdminStoreDriver {
    override async replaceLegs(): Promise<void> {
      throw new Error('route write failed')
    }
  }

  const driver = new FailLegReplacementDriver()
  seedDriver(driver)
  const repo = new ItemsAdminRepository(driver)
  const beforeItems = [...driver.itemRows.entries()].map(([id, row]) => [id, { ...row }])
  const beforeLegs = [...driver.legRows.entries()].map(([id, row]) => [id, { ...row }])

  const result = await repo.createItem(TRIP, { dayId: 'day-1', title: '不应留下的卡片' })
  assert.deepEqual(result, { ok: false, error: '保存失败', code: 'storage' })
  assert.deepEqual([...driver.itemRows.entries()], beforeItems, 'the card upsert is rolled back')
  assert.deepEqual([...driver.legRows.entries()], beforeLegs, 'the existing legs are rolled back')
})
