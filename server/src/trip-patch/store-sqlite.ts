/**
 * SQLite TripPatchStoreDriver (ticket 08) — patch writes over the days/
 * items/legs tables that ticket 02's schema already created. Additive by
 * design: no schema changes, no imports from the trips module beyond the
 * date validator. `withTransaction` wraps a batch in BEGIN/COMMIT so a
 * failed patch apply leaves no partial writes behind.
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import type { DayRow, ItemRow, LegRow } from '../days/types.js'
import type {
  TripPatchDayUpsert,
  TripPatchItemUpsert,
  TripPatchLegUpsert,
  TripPatchStoreDriver,
} from './types.js'

export class SqliteTripPatchStore implements TripPatchStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listDayRows(tripId: string): Promise<DayRow[]> {
    const { rows } = await this.db.run('SELECT id, trip_id, idx, date, theme, color FROM days WHERE trip_id = ?', [
      tripId,
    ])
    return rows as unknown as DayRow[]
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, day_id, item_order, type, title, note, poi, images, pending FROM items WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as ItemRow[]
  }

  async listLegRows(tripId: string): Promise<LegRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline FROM legs WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as LegRow[]
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.run('BEGIN IMMEDIATE')
    try {
      const result = await fn()
      await this.db.run('COMMIT')
      return result
    } catch (error) {
      try {
        await this.db.run('ROLLBACK')
      } catch {
        // connection-level failure — nothing to roll back
      }
      throw error
    }
  }

  async upsertDayRow(tripId: string, day: TripPatchDayUpsert): Promise<void> {
    await this.db.run(
      `INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET idx = excluded.idx, date = excluded.date, theme = excluded.theme`,
      [day.id, tripId, day.idx, day.date, day.theme, ''] as SqlValue[],
    )
  }

  async deleteDayRow(tripId: string, dayId: string): Promise<void> {
    await this.db.run('DELETE FROM days WHERE id = ? AND trip_id = ?', [dayId, tripId] as SqlValue[])
  }

  async deleteItemsForDay(tripId: string, dayId: string): Promise<void> {
    await this.db.run('DELETE FROM items WHERE trip_id = ? AND day_id = ?', [tripId, dayId] as SqlValue[])
  }

  async deleteItemsById(tripId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return
    const placeholders = itemIds.map(() => '?').join(', ')
    await this.db.run(`DELETE FROM items WHERE trip_id = ? AND id IN (${placeholders})`, [
      tripId,
      ...itemIds,
    ] as SqlValue[])
  }

  async upsertItemRow(tripId: string, item: TripPatchItemUpsert): Promise<void> {
    await this.db.run(
      `INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         day_id = excluded.day_id, item_order = excluded.item_order, type = excluded.type,
         title = excluded.title, note = excluded.note, poi = excluded.poi, pending = excluded.pending`,
      [
        item.id,
        tripId,
        item.dayId,
        item.itemOrder,
        item.type,
        item.title,
        item.note,
        item.poi,
        null,
        item.pending ? 1 : 0,
      ] as SqlValue[],
    )
  }

  async upsertLegRow(tripId: string, leg: TripPatchLegUpsert): Promise<void> {
    await this.db.run(
      `INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         from_item_id = excluded.from_item_id, to_item_id = excluded.to_item_id, mode = excluded.mode,
         distance_km = excluded.distance_km, duration_min = excluded.duration_min, polyline = excluded.polyline`,
      [
        leg.id,
        tripId,
        leg.fromItemId,
        leg.toItemId,
        leg.mode,
        leg.distanceKm,
        leg.durationMin,
        leg.polyline,
      ] as SqlValue[],
    )
  }

  async deleteLegsForItems(tripId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return
    const placeholders = itemIds.map(() => '?').join(', ')
    await this.db.run(
      `DELETE FROM legs WHERE trip_id = ? AND (from_item_id IN (${placeholders}) OR to_item_id IN (${placeholders}))`,
      [tripId, ...itemIds, ...itemIds] as SqlValue[],
    )
  }
}

/** Factory for the production driver over the shared SqlDatabase instance. */
export function createSqliteTripPatchStore(db: SqlDatabase): TripPatchStoreDriver {
  return new SqliteTripPatchStore(db)
}
