/**
 * SQLite WorkbenchStoreDriver (ticket 04) — read-only SELECTs over the
 * days/items/legs tables that ticket 02's schema already created. Additive by
 * design: no schema changes, no writes, no imports from the trips module.
 */
import type { SqlDatabase } from '../db/driver.js'
import type { DayRow, ItemRow, LegRow, WorkbenchStoreDriver } from './types.js'

export class SqliteWorkbenchStoreDriver implements WorkbenchStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listDayRows(tripId: string): Promise<DayRow[]> {
    const { rows } = await this.db.run('SELECT id, trip_id, idx, date, theme, color, title, note FROM days WHERE trip_id = ?', [
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
      'SELECT id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline, quality FROM legs WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as LegRow[]
  }
}

/**
 * Factory for the production driver over the same SqlDatabase instance the
 * trips repository uses (one file, one connection).
 */
export function createSqliteWorkbenchStore(db: SqlDatabase): WorkbenchStoreDriver {
  return new SqliteWorkbenchStoreDriver(db)
}
