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
    const { rows } = await this.db.run(
      'SELECT id, trip_id, idx, date, theme, color, title, note FROM days WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as DayRow[]
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, day_id, item_order, type, title, note, time_range, cost, poi, images, pending FROM items WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as ItemRow[]
  }

  async listLegRows(tripId: string): Promise<LegRow[]> {
    return readSqliteLegRows(this.db, tripId)
  }
}

/**
 * Factory for the production driver over the same SqlDatabase instance the
 * trips repository uses (one file, one connection).
 */
export function createSqliteWorkbenchStore(db: SqlDatabase): WorkbenchStoreDriver {
  return new SqliteWorkbenchStoreDriver(db)
}

/** Read verification proof and live endpoint locations in one statement. */
export async function readSqliteLegRows(db: SqlDatabase, tripId: string): Promise<LegRow[]> {
  const { rows } = await db.run(
    `SELECT l.*, src.poi AS from_poi, dst.poi AS to_poi FROM legs l
     LEFT JOIN items src ON src.id = l.from_item_id AND src.trip_id = l.trip_id
     LEFT JOIN items dst ON dst.id = l.to_item_id AND dst.trip_id = l.trip_id
     WHERE l.trip_id = ?`,
    [tripId],
  )
  return rows as unknown as LegRow[]
}
