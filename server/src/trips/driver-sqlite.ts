/**
 * SQLite TripStoreDriver (ticket 02) — libsql-backed implementation of the
 * injectable driver seam. Only the trips table is touched; child tables
 * cascade through foreign keys.
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import type { TripInsertRow, TripRow, TripStoreDriver } from './types.js'

export class SqliteTripStoreDriver implements TripStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listTripRows(): Promise<TripRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, title, start_date, end_date, planning_context, cover_image, is_pinned, status, created_at, updated_at FROM trips ORDER BY created_at ASC, id ASC',
    )
    return rows as unknown as TripRow[]
  }

  async getTripRow(id: string): Promise<TripRow | null> {
    const { rows } = await this.db.run(
      'SELECT id, title, start_date, end_date, planning_context, cover_image, is_pinned, status, created_at, updated_at FROM trips WHERE id = ?',
      [id],
    )
    return (rows[0] as TripRow | undefined) ?? null
  }

  async insertTripRow(row: TripInsertRow): Promise<void> {
    await this.db.run(
      'INSERT INTO trips (id, title, start_date, end_date, planning_context, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.title,
        row.start_date,
        row.end_date,
        row.planning_context ?? null,
        row.created_at,
        row.updated_at,
      ] as SqlValue[],
    )
  }

  async updateTripRow(
    id: string,
    patch: {
      title: string
      startDate: string
      endDate: string
      updatedAt: string
      planningContext: string | null
    },
  ): Promise<boolean> {
    const { rowsAffected } = await this.db.run(
      'UPDATE trips SET title = ?, start_date = ?, end_date = ?, planning_context = ?, updated_at = ? WHERE id = ?',
      [patch.title, patch.startDate, patch.endDate, patch.planningContext, patch.updatedAt, id],
    )
    return rowsAffected > 0
  }

  async deleteTripRow(id: string): Promise<boolean> {
    const { rowsAffected } = await this.db.run('DELETE FROM trips WHERE id = ?', [id])
    return rowsAffected > 0
  }
}
