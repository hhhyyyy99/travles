/**
 * SQLite MessageStoreDriver (ticket 06) — libsql-backed chat persistence over
 * the same `SqlDatabase` seam as the other drivers. Reads are ordered by
 * created_at then rowid so same-timestamp messages keep insertion order.
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import type { MessageRow, MessageStoreDriver } from './types.js'

export class SqliteMessageStoreDriver implements MessageStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listMessageRows(tripId: string): Promise<MessageRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, role, content, created_at FROM messages WHERE trip_id = ? ORDER BY created_at ASC, rowid ASC',
      [tripId],
    )
    return rows as unknown as MessageRow[]
  }

  async appendMessageRow(row: MessageRow): Promise<void> {
    await this.db.run(
      'INSERT INTO messages (id, trip_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [row.id, row.trip_id, row.role, row.content, row.created_at] as SqlValue[],
    )
  }
}
