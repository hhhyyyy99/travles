/**
 * Built-in trip seed tests (ticket 03) — idempotency (marker row + fixed
 * ids), content consistency with the guide data, self-healing after an
 * interrupted seed, and the never-throw convention.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSqliteTripRepository } from '../src/trips/factory.js'
import { createApp } from '../src/app.js'
import { createSqliteWorkbenchStore } from '../src/days/driver-sqlite.js'
import { seedBuiltinTrip } from '../src/seed/seed.js'
import {
  BUILTIN_TRIP_DAYS,
  BUILTIN_TRIP_ID,
  BUILTIN_TRIP_SEED_MARKER,
  BUILTIN_TRIP_TITLE,
  seedDate,
} from '../src/seed/builtin-trip-data.js'
import type { SqlDatabase } from '../src/db/driver.js'

/** Expected item count: 1 overview + schedule rows + 1 stay per overnight day. */
const EXPECTED_DAYS = BUILTIN_TRIP_DAYS.length
const EXPECTED_ITEMS =
  BUILTIN_TRIP_DAYS.length +
  BUILTIN_TRIP_DAYS.reduce((sum, day) => sum + day.schedule.length, 0) +
  BUILTIN_TRIP_DAYS.filter((day) => day.stay !== null).length

async function setup(): Promise<{ db: SqlDatabase; dir: string; close(): Promise<void>; repository: Awaited<ReturnType<typeof createSqliteTripRepository>>['repository'] }> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-builtin-'))
  const sqlite = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
  return { db: sqlite.db, dir, close: sqlite.close, repository: sqlite.repository }
}

test('seeds the built-in trip once; repeated startups are no-ops', async () => {
  const { db, dir, close } = await setup()
  try {
    assert.deepEqual(await seedBuiltinTrip(db), { seeded: true })
    const counts = async (table: string) =>
      (await db.run(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]?.n
    assert.equal(await counts('trips'), 1)
    assert.equal(await counts('days'), EXPECTED_DAYS)
    assert.equal(await counts('items'), EXPECTED_ITEMS)
    assert.equal(await counts('legs'), EXPECTED_DAYS)

    assert.deepEqual(await seedBuiltinTrip(db), { seeded: false })
    assert.equal(await counts('trips'), 1, 'no duplicate trip after a second startup')
    assert.equal(await counts('days'), EXPECTED_DAYS)
    assert.equal(await counts('items'), EXPECTED_ITEMS)

    const marker = await db.run('SELECT value FROM app_meta WHERE key = ?', [BUILTIN_TRIP_SEED_MARKER])
    assert.equal(marker.rows.length, 1, 'seed marker row written')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('seeded content matches the guide data (days, items, stay, leg)', async () => {
  const { db, dir, close } = await setup()
  try {
    await seedBuiltinTrip(db)

    const trip = (await db.run('SELECT id, title, start_date, end_date FROM trips')).rows[0]
    assert.equal(trip?.id, BUILTIN_TRIP_ID)
    assert.equal(trip?.title, BUILTIN_TRIP_TITLE)
    assert.equal(trip?.start_date, seedDate(BUILTIN_TRIP_DAYS[0]!.date))
    assert.equal(trip?.end_date, seedDate(BUILTIN_TRIP_DAYS[BUILTIN_TRIP_DAYS.length - 1]!.date))

    const days = await db.run('SELECT id, idx, date, theme FROM days ORDER BY idx ASC')
    assert.equal(days.rows.length, EXPECTED_DAYS)
    assert.deepEqual(days.rows.map((row) => row.theme), BUILTIN_TRIP_DAYS.map((day) => day.theme))
    assert.equal(days.rows[0]?.date, '2026-10-02')
    assert.equal(days.rows[0]?.id, 'builtin-day-0')

    // Overview item carries the fields with no dedicated column.
    const overview = await db.run("SELECT title, note, type FROM items WHERE id = 'builtin-item-0-0'")
    assert.equal(overview.rows[0]?.type, 'other')
    assert.match(overview.rows[0]?.title as string, /当日概览 · 机场 → 海拉尔/)
    assert.match(overview.rows[0]?.note as string, /落地休息/)

    // Schedule rows keep time + detail and get a deterministic type.
    const scheduleItem = await db.run("SELECT title, note, type FROM items WHERE id = 'builtin-item-0-2'")
    assert.equal(scheduleItem.rows[0]?.title, '21:00 取车后去市区')
    assert.equal(scheduleItem.rows[0]?.type, 'traffic')
    const mealItem = await db.run("SELECT type FROM items WHERE id = 'builtin-item-4-4'")
    assert.equal(mealItem.rows[0]?.type, 'food')

    // Stay items exist per overnight day with the fixed migration-facing id.
    const stay = await db.run("SELECT title, note, item_order, type FROM items WHERE id = 'builtin-stay-day-0'")
    assert.equal(stay.rows[0]?.title, '海拉尔 · 第 1 晚')
    assert.equal(stay.rows[0]?.type, 'stay')
    assert.equal(stay.rows[0]?.item_order, 100)
    const stayCount = await db.run("SELECT COUNT(*) AS n FROM items WHERE id LIKE 'builtin-stay-day-%'")
    assert.equal(stayCount.rows[0]?.n, BUILTIN_TRIP_DAYS.filter((day) => day.stay !== null).length)
    const lastDayStay = await db.run("SELECT COUNT(*) AS n FROM items WHERE id = 'builtin-stay-day-6'")
    assert.equal(lastDayStay.rows[0]?.n, 0, 'the return day has no overnight, so no stay item')

    const leg = await db.run('SELECT distance_km, duration_min, polyline FROM legs WHERE id = ?', ['builtin-leg-day-1'])
    assert.equal(leg.rows[0]?.distance_km, 150)
    assert.equal(leg.rows[0]?.duration_min, 165)
    assert.deepEqual(JSON.parse(leg.rows[0]?.polyline as string), BUILTIN_TRIP_DAYS[1]!.leg.coordinates)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('seeded canvas exposes guide POIs and one linked route per day', async () => {
  const { db, dir, close, repository } = await setup()
  try {
    await seedBuiltinTrip(db)
    const app = await createApp({
      tripRepository: repository,
      workbenchStore: createSqliteWorkbenchStore(db),
    })
    const response = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/canvas`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      days: Array<{ id: string; items: Array<{ id: string; poi: { lat: number; lng: number } | null }> }>
      legs: Array<{ fromItemId: string; toItemId: string; polyline: Array<[number, number]> | null }>
    }
    assert.equal(body.days.length, EXPECTED_DAYS)
    for (const day of body.days) {
      const poiItems = day.items.filter((item) => item.poi !== null)
      assert.ok(poiItems.length >= 2)
      assert.ok(poiItems.every((item) => Number.isFinite(item.poi?.lat) && Number.isFinite(item.poi?.lng)))
    }
    assert.equal(body.legs.length, EXPECTED_DAYS)
    for (const day of body.days) {
      const dayItemIds = day.items.map((item) => item.id)
      const dailyLegs = body.legs.filter((leg) => dayItemIds.includes(leg.fromItemId) && dayItemIds.includes(leg.toItemId))
      assert.equal(dailyLegs.length, 1)
      const dailyLeg = dailyLegs[0]
      assert.ok(dailyLeg)
      const pairIndex = dayItemIds.findIndex((id, index) => id === dailyLeg?.fromItemId && dayItemIds[index + 1] === dailyLeg?.toItemId)
      assert.ok(pairIndex >= 0, `daily route for ${day.id} must connect adjacent cards`)
    }
    assert.ok(body.legs.every((leg) => (leg.polyline?.length ?? 0) >= 2))
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('seed metadata repair fills only missing canonical fields and preserves user edits', async () => {
  const { db, dir, close } = await setup()
  try {
    await seedBuiltinTrip(db)
    await db.run(
      "UPDATE items SET title = ?, note = ?, type = ?, poi = NULL WHERE id = 'builtin-item-1-1'",
      ['用户改过的出发卡片', '用户自己的备注', 'other'],
    )
    await db.run(
      "UPDATE legs SET from_item_id = NULL, to_item_id = ? WHERE id = 'builtin-leg-day-1'",
      ['用户自定义终点'],
    )

    assert.deepEqual(await seedBuiltinTrip(db), { seeded: false })
    const item = await db.run("SELECT title, note, type, poi FROM items WHERE id = 'builtin-item-1-1'")
    assert.equal(item.rows[0]?.title, '用户改过的出发卡片')
    assert.equal(item.rows[0]?.note, '用户自己的备注')
    assert.equal(item.rows[0]?.type, 'other')
    assert.ok(typeof item.rows[0]?.poi === 'string' && item.rows[0]?.poi !== '')
    const leg = await db.run("SELECT from_item_id, to_item_id FROM legs WHERE id = 'builtin-leg-day-1'")
    assert.deepEqual(
      { from: leg.rows[0]?.from_item_id, to: leg.rows[0]?.to_item_id },
      { from: 'builtin-item-1-1', to: '用户自定义终点' },
    )
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('an interrupted seed (trip written, marker missing) self-heals on the next start', async () => {
  const { db, dir, close } = await setup()
  try {
    await seedBuiltinTrip(db)
    // Simulate a torn seed: marker lost + junk rows from a half-finished run.
    await db.run('DELETE FROM app_meta WHERE key = ?', [BUILTIN_TRIP_SEED_MARKER])
    await db.run("DELETE FROM items WHERE id = 'builtin-item-0-1'")
    await db.run(
      "INSERT INTO items (id, trip_id, day_id, item_order, type, title, note) VALUES ('builtin-item-9-9', ?, 'builtin-day-0', 99, 'other', '半途残留', '')",
      [BUILTIN_TRIP_ID],
    )

    assert.deepEqual(await seedBuiltinTrip(db), { seeded: true })
    const items = await db.run('SELECT COUNT(*) AS n FROM items')
    assert.equal(items.rows[0]?.n, EXPECTED_ITEMS, 'partial content is replaced wholesale, junk removed')
    const junk = await db.run("SELECT COUNT(*) AS n FROM items WHERE id = 'builtin-item-9-9'")
    assert.equal(junk.rows[0]?.n, 0)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a user-deleted example trip stays deleted once the marker exists', async () => {
  const { db, dir, close } = await setup()
  try {
    await seedBuiltinTrip(db)
    await db.run('DELETE FROM trips WHERE id = ?', [BUILTIN_TRIP_ID])

    assert.deepEqual(await seedBuiltinTrip(db), { seeded: false })
    const trips = await db.run('SELECT COUNT(*) AS n FROM trips')
    assert.equal(trips.rows[0]?.n, 0, 'no resurrection on restart')
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing database never throws out of seedBuiltinTrip', async () => {
  const failing: SqlDatabase = {
    run: async () => {
      throw new Error('disk on fire')
    },
    close: async () => {},
  }
  await assert.doesNotReject(seedBuiltinTrip(failing))
  assert.deepEqual(await seedBuiltinTrip(failing), { seeded: false })
})
