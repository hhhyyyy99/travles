/**
 * SQLite MessageStoreDriver (tickets 06/07) — libsql-backed chat persistence
 * over the same `SqlDatabase` seam as the other drivers. Reads are ordered by
 * created_at then rowid so same-timestamp messages keep insertion order.
 *
 * Ticket 07 also persists the round-metadata columns (think/sources/meta).
 * Pre-ticket-07 databases gain the `meta` column through the tolerant ALTER
 * in db/schema.ts; the SELECT falls back to the narrow column list when it
 * is missing, so reads never fail on an old file.
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import type { MessageRow, MessageStoreDriver } from './types.js'

const INSERT_COLUMNS = 'id, trip_id, role, content, think, sources, meta, created_at'

export class SqliteMessageStoreDriver implements MessageStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listMessageRows(tripId: string): Promise<MessageRow[]> {
    try {
      const { rows } = await this.db.run(
        'SELECT id, trip_id, role, content, think, sources, meta, created_at FROM messages WHERE trip_id = ? ORDER BY created_at ASC, rowid ASC',
        [tripId],
      )
      return rows as unknown as MessageRow[]
    } catch {
      // Older database without the ticket-07 columns — read the base row.
      const { rows } = await this.db.run(
        'SELECT id, trip_id, role, content, created_at FROM messages WHERE trip_id = ? ORDER BY created_at ASC, rowid ASC',
        [tripId],
      )
      return rows as unknown as MessageRow[]
    }
  }

  async appendMessageRow(row: MessageRow): Promise<void> {
    const withMeta = [
      row.id,
      row.trip_id,
      row.role,
      row.content,
      row.think ?? null,
      row.sources ?? null,
      row.meta ?? null,
      row.created_at,
    ] as SqlValue[]
    try {
      await this.db.run(`INSERT INTO messages (${INSERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, withMeta)
    } catch {
      // Older database without the ticket-07 columns — drop the metadata and
      // persist the base row (the conversation is never lost to a schema lag).
      await this.db.run('INSERT INTO messages (id, trip_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', [
        row.id,
        row.trip_id,
        row.role,
        row.content,
        row.created_at,
      ] as SqlValue[])
    }
  }
}
