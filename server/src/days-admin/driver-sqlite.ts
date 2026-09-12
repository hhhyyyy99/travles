/**
 * SQLite DaysAdminStoreDriver (ticket 10) — day writes over the days/items/
 * legs tables that ticket 02's schema already created. Additive by design:
 * no schema changes, no imports from the trips module. Legs have no FK on
 * items, so the cascade deletes them explicitly (before the items go).
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import type { DayRow } from '../days/types.js'
import type { DayInsert, DaysAdminStoreDriver, DayThemePatch } from './types.js'
import type { DayScheduleUpdate } from '../trip-events/schedule.js'

const DAY_COLUMNS = 'id, trip_id, idx, date, theme, color'

export class SqliteDaysAdminStoreDriver implements DaysAdminStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listDayRows(tripId: string): Promise<DayRow[]> {
    const { rows } = await this.db.run(`SELECT ${DAY_COLUMNS} FROM days WHERE trip_id = ?`, [tripId])
    return rows as unknown as DayRow[]
  }

  async getDayRow(dayId: string): Promise<DayRow | null> {
    const { rows } = await this.db.run(`SELECT ${DAY_COLUMNS} FROM days WHERE id = ?`, [dayId])
    return (rows[0] as unknown as DayRow) ?? null
  }

  async insertDayRow(row: DayInsert): Promise<void> {
    await this.db.run(
      'INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES (?, ?, ?, ?, ?, ?)',
      [row.id, row.tripId, row.idx, row.date, row.theme, row.color] as SqlValue[],
    )
  }

  async updateDayRow(dayId: string, patch: DayThemePatch): Promise<void> {
    const sets: string[] = []
    const args: SqlValue[] = []
    if (patch.theme !== undefined) {
      sets.push('theme = ?')
      args.push(patch.theme)
    }
    if (patch.color !== undefined) {
      sets.push('color = ?')
      args.push(patch.color)
    }
    if (sets.length === 0) return
    args.push(dayId)
    await this.db.run(`UPDATE days SET ${sets.join(', ')} WHERE id = ?`, args)
  }

  async listItemIdsForDay(dayId: string): Promise<string[]> {
    const { rows } = await this.db.run('SELECT id FROM items WHERE day_id = ?', [dayId])
    return rows.map((row) => (typeof row.id === 'string' ? row.id : '')).filter((id) => id !== '')
  }

  async deleteLegsForDay(dayId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM legs WHERE from_item_id IN (SELECT id FROM items WHERE day_id = ?)
         OR to_item_id IN (SELECT id FROM items WHERE day_id = ?)`,
      [dayId, dayId] as SqlValue[],
    )
  }

  async deleteItemsForDay(dayId: string): Promise<void> {
    await this.db.run('DELETE FROM items WHERE day_id = ?', [dayId])
  }

  async deleteDayRow(dayId: string): Promise<void> {
    await this.db.run('DELETE FROM days WHERE id = ?', [dayId])
  }

  async updateDaySchedule(tripId: string, updates: DayScheduleUpdate[]): Promise<void> {
    for (const update of updates) {
      await this.db.run('UPDATE days SET idx = ?, date = ? WHERE id = ? AND trip_id = ?', [
        update.idx,
        update.date,
        update.id,
        tripId,
      ] as SqlValue[])
    }
  }
}

/** Factory for the production driver over the shared SqlDatabase instance. */
export function createSqliteDaysAdminStore(db: SqlDatabase): DaysAdminStoreDriver {
  return new SqliteDaysAdminStoreDriver(db)
}
