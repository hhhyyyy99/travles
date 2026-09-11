/**
 * First-startup seed of the built-in example trip (ticket 03).
 *
 * Idempotency contract:
 * - The gate is a marker row in `app_meta` (key `builtin-trip.hailar-oct7`).
 *   Once written, later startups never touch the trip again — so a user who
 *   deleted or renamed the example trip keeps their choice (no resurrection,
 *   no duplicates).
 * - All rows use the fixed ID scheme from builtin-trip-data.ts, so even a
 *   crash between "trip inserted" and "marker written" self-heals: the next
 *   start deletes the partial trip (FK cascade wipes days/items/legs) and
 *   reseeds it wholesale before writing the marker.
 * - Follows the repo convention 容错读取、永不 throw: a failing seed is
 *   reported as {seeded:false} (with a console.warn), never crashes startup.
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import {
  BUILTIN_TRIP_DAYS,
  BUILTIN_TRIP_ID,
  BUILTIN_TRIP_SEED_MARKER,
  BUILTIN_TRIP_TITLE,
  classifyScheduleItem,
  seedDate,
} from './builtin-trip-data.js'

export type SeedResult = { seeded: boolean }

export async function seedBuiltinTrip(db: SqlDatabase): Promise<SeedResult> {
  try {
    const marker = await db.run('SELECT value FROM app_meta WHERE key = ?', [BUILTIN_TRIP_SEED_MARKER])
    if (marker.rows.length > 0) return { seeded: false }

    const now = new Date().toISOString()
    const start = seedDate(BUILTIN_TRIP_DAYS[0]!.date)
    const end = seedDate(BUILTIN_TRIP_DAYS[BUILTIN_TRIP_DAYS.length - 1]!.date)

    // Replace any partial leftovers from an interrupted seed, then write the
    // full content. foreign_keys=ON (ensureSchema) cascades the delete.
    await db.run('DELETE FROM trips WHERE id = ?', [BUILTIN_TRIP_ID])
    await db.run(
      'INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [BUILTIN_TRIP_ID, BUILTIN_TRIP_TITLE, start, end, now, now] as SqlValue[],
    )

    for (const [dayIndex, day] of BUILTIN_TRIP_DAYS.entries()) {
      const dayId = `builtin-day-${dayIndex}`
      await db.run(
        'INSERT INTO days (id, trip_id, idx, date, theme) VALUES (?, ?, ?, ?, ?)',
        [dayId, BUILTIN_TRIP_ID, dayIndex, seedDate(day.date), day.theme] as SqlValue[],
      )

      // One overview card carrying the guide fields with no dedicated column
      // (route summary, drive estimate, pace, description, tip).
      await insertItem(db, {
        id: `builtin-item-${dayIndex}-0`,
        dayId,
        tripId: BUILTIN_TRIP_ID,
        itemOrder: 0,
        type: 'other',
        title: `当日概览 · ${day.short}`,
        note: `${day.drive}；节奏：${day.pace}。${day.desc}提示：${day.tip}`,
      })
      day.schedule.forEach(([time, title, detail], order) => {
        return insertItem(db, {
          id: `builtin-item-${dayIndex}-${order + 1}`,
          dayId,
          tripId: BUILTIN_TRIP_ID,
          itemOrder: order + 1,
          type: classifyScheduleItem(title),
          title: `${time} ${title}`,
          note: detail,
        })
      })
      if (day.stay) {
        // Fixed stay-item id: the localStorage migration (ticket 03) upserts
        // the same row with the user's actual base name.
        await insertItem(db, {
          id: `builtin-stay-day-${dayIndex}`,
          dayId,
          tripId: BUILTIN_TRIP_ID,
          itemOrder: 100,
          type: 'stay',
          title: day.stay,
          note: day.alt,
        })
      }

      await db.run(
        'INSERT INTO legs (id, trip_id, mode, distance_km, duration_min, polyline) VALUES (?, ?, ?, ?, ?, ?)',
        [
          `builtin-leg-day-${dayIndex}`,
          BUILTIN_TRIP_ID,
          'drive',
          day.leg.distanceKm,
          day.leg.durationMin,
          JSON.stringify(day.leg.coordinates),
        ] as SqlValue[],
      )
    }

    await db.run(
      'INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [BUILTIN_TRIP_SEED_MARKER, now, now] as SqlValue[],
    )
    return { seeded: true }
  } catch (error) {
    console.warn('[seed] 内置示例行程写入失败（下次启动重试）：', error)
    return { seeded: false }
  }
}

async function insertItem(
  db: SqlDatabase,
  item: { id: string; dayId: string; tripId: string; itemOrder: number; type: string; title: string; note: string },
): Promise<void> {
  await db.run(
    'INSERT INTO items (id, trip_id, day_id, item_order, type, title, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [item.id, item.tripId, item.dayId, item.itemOrder, item.type, item.title, item.note] as SqlValue[],
  )
}
