import type { SqlDatabase } from './driver.js'

/** Call on the same transaction connection as the content write. */
export async function recordTripEdit(db: SqlDatabase, tripId: string): Promise<void> {
  await db.run('UPDATE trips SET updated_at = ? WHERE id = ?', [new Date().toISOString(), tripId])
}
