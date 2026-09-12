/**
 * First-startup seed of the built-in example trip (ticket 03).
 *
 * Idempotency contract:
 * - The gate is a marker row in `app_meta` (key `builtin-trip.hailar-oct7`).
 *   Once written, later startups never recreate the trip or overwrite its
 *   content. They may fill metadata that an older seed left blank on existing
 *   canonical rows, so a user who deleted or renamed the example trip keeps
 *   their choice (no resurrection, no duplicates).
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
  BUILTIN_TRIP_DAY_POINT_KEYS,
  BUILTIN_TRIP_POINTS,
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
    if (marker.rows.length > 0) {
      await repairBuiltinTripMetadata(db)
      return { seeded: false }
    }

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
      for (const [order, [time, title, detail]] of day.schedule.entries()) {
        const pointKey = BUILTIN_TRIP_DAY_POINT_KEYS[dayIndex]?.[order]
        await insertItem(db, {
          id: `builtin-item-${dayIndex}-${order + 1}`,
          dayId,
          tripId: BUILTIN_TRIP_ID,
          itemOrder: order + 1,
          type: classifyScheduleItem(title),
          title: `${time} ${title}`,
          note: detail,
          poi: pointKey ? JSON.stringify(BUILTIN_TRIP_POINTS[pointKey]) : null,
        })
      }
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
        'INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          `builtin-leg-day-${dayIndex}`,
          BUILTIN_TRIP_ID,
          `builtin-item-${dayIndex}-1`,
          `builtin-item-${dayIndex}-2`,
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

/**
 * Upgrade rows written by the original ticket-03 seed without replacing any
 * user content. Missing POIs and leg endpoints are the only fields repaired;
 * rows that a user deleted or changed remain untouched.
 */
async function repairBuiltinTripMetadata(db: SqlDatabase): Promise<void> {
  const trip = await db.run('SELECT id FROM trips WHERE id = ?', [BUILTIN_TRIP_ID])
  if (trip.rows.length === 0) return

  for (const [dayIndex, day] of BUILTIN_TRIP_DAYS.entries()) {
    for (const [pointIndex, pointKey] of (BUILTIN_TRIP_DAY_POINT_KEYS[dayIndex] ?? []).entries()) {
      const itemId = `builtin-item-${dayIndex}-${pointIndex + 1}`
      await db.run(
        "UPDATE items SET poi = ? WHERE id = ? AND trip_id = ? AND COALESCE(TRIM(poi), '') = ''",
        [JSON.stringify(BUILTIN_TRIP_POINTS[pointKey]), itemId, BUILTIN_TRIP_ID] as SqlValue[],
      )

      const title = day.schedule[pointIndex]?.[1]
      if (title) {
        const expectedType = classifyScheduleItem(title)
        const legacyType = expectedType === 'traffic' ? 'transport' : expectedType === 'food' ? 'meal' : 'activity'
        await db.run(
          'UPDATE items SET type = ? WHERE id = ? AND trip_id = ? AND type = ?',
          [expectedType, itemId, BUILTIN_TRIP_ID, legacyType] as SqlValue[],
        )
      }
    }

    await db.run(
      "UPDATE legs SET from_item_id = CASE WHEN COALESCE(TRIM(from_item_id), '') = '' THEN ? ELSE from_item_id END, to_item_id = CASE WHEN COALESCE(TRIM(to_item_id), '') = '' THEN ? ELSE to_item_id END WHERE id = ? AND trip_id = ? AND (COALESCE(TRIM(from_item_id), '') = '' OR COALESCE(TRIM(to_item_id), '') = '')",
      [`builtin-item-${dayIndex}-1`, `builtin-item-${dayIndex}-2`, `builtin-leg-day-${dayIndex}`, BUILTIN_TRIP_ID] as SqlValue[],
    )
  }
}

async function insertItem(
  db: SqlDatabase,
  item: { id: string; dayId: string; tripId: string; itemOrder: number; type: string; title: string; note: string; poi?: string | null },
): Promise<void> {
  await db.run(
    'INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [item.id, item.tripId, item.dayId, item.itemOrder, item.type, item.title, item.note, item.poi ?? null] as SqlValue[],
  )
}
