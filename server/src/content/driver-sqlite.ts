/**
 * SQLite ContentStoreDriver (ticket 03) — libsql-backed days/items/checklist
 * access over the same `SqlDatabase` seam as the trips driver. Upserts are
 * keyed by row id (the idempotency mechanism for the seed + migration).
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import type { ChecklistRow, ChecklistUpsert, ContentStoreDriver, DayRow, ItemRow, ItemUpsert } from './types.js'

export class SqliteContentStoreDriver implements ContentStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listDayRows(tripId: string): Promise<DayRow[]> {
    const { rows } = await this.db.run('SELECT id, trip_id, idx, date, theme, color FROM days WHERE trip_id = ? ORDER BY idx ASC, id ASC', [tripId])
    return rows as unknown as DayRow[]
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, day_id, item_order, type, title, note, poi, images, pending FROM items WHERE trip_id = ? ORDER BY day_id ASC, item_order ASC, id ASC',
      [tripId],
    )
    return rows as unknown as ItemRow[]
  }

  async listChecklistRows(tripId: string): Promise<ChecklistRow[]> {
    const { rows } = await this.db.run('SELECT id, trip_id, content, done, created_at FROM checklist WHERE trip_id = ? ORDER BY created_at ASC, id ASC', [tripId])
    return rows as unknown as ChecklistRow[]
  }

  async dayExists(tripId: string, dayId: string): Promise<boolean> {
    const { rows } = await this.db.run('SELECT id FROM days WHERE id = ? AND trip_id = ?', [dayId, tripId])
    return rows.length > 0
  }

  async upsertItemRow(tripId: string, item: ItemUpsert): Promise<void> {
    await this.db.run(
      `INSERT INTO items (id, trip_id, day_id, item_order, type, title, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         trip_id = excluded.trip_id, day_id = excluded.day_id, item_order = excluded.item_order,
         type = excluded.type, title = excluded.title, note = excluded.note`,
      [item.id, tripId, item.dayId, item.itemOrder, item.type, item.title, item.note] as SqlValue[],
    )
  }

  async upsertChecklistRow(tripId: string, entry: ChecklistUpsert): Promise<void> {
    await this.db.run(
      `INSERT INTO checklist (id, trip_id, content, done, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         trip_id = excluded.trip_id, content = excluded.content, done = excluded.done`,
      [entry.id, tripId, entry.content, entry.done ? 1 : 0, new Date().toISOString()] as SqlValue[],
    )
  }
}
