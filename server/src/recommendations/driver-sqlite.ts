import type { SqlDatabase, SqlValue } from '../db/driver.js'
import type {
  FavoriteInsert,
  FavoriteRow,
  RecommendationsStoreDriver,
  StashInsert,
  StashRow,
} from './types.js'

/** SQLite recommendation store over the app's shared database. */
export class SqliteRecommendationsStoreDriver implements RecommendationsStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listStashRows(tripId: string): Promise<StashRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, poi, origin, added_at, title, note, category, created_at FROM stash WHERE trip_id = ? ORDER BY added_at ASC, id ASC',
      [tripId],
    )
    return rows as unknown as StashRow[]
  }

  async insertStashRow(tripId: string, item: StashInsert): Promise<void> {
    await this.db.run(
      'INSERT INTO stash (id, trip_id, poi, origin, added_at, title, note, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [item.id, tripId, item.poi, item.origin, item.addedAt, item.title ?? null, item.note ?? null, item.category ?? null, item.createdAt ?? null] as SqlValue[],
    )
  }

  async deleteStashRow(tripId: string, stashId: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM stash WHERE id = ? AND trip_id = ?', [stashId, tripId] as SqlValue[])
    return result.rowsAffected > 0
  }

  async listFavoriteRows(tripId: string): Promise<FavoriteRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, poi, created_at FROM favorites WHERE trip_id = ? ORDER BY created_at ASC, id ASC',
      [tripId],
    )
    return rows as unknown as FavoriteRow[]
  }

  async insertFavoriteRow(tripId: string, favorite: FavoriteInsert): Promise<void> {
    await this.db.run(
      'INSERT INTO favorites (id, trip_id, poi, created_at) VALUES (?, ?, ?, ?)',
      [favorite.id, tripId, favorite.poi, favorite.createdAt] as SqlValue[],
    )
  }

  async deleteFavoriteRow(tripId: string, favoriteId: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM favorites WHERE id = ? AND trip_id = ?', [favoriteId, tripId] as SqlValue[])
    return result.rowsAffected > 0
  }
}

export function createSqliteRecommendationsStore(db: SqlDatabase): SqliteRecommendationsStoreDriver {
  return new SqliteRecommendationsStoreDriver(db)
}
