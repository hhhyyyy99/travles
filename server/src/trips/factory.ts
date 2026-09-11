/**
 * Factory for the production trip repository: real SQLite file + schema
 * (ticket 02). Tests inject MemoryTripStoreDriver instead; the restart
 * persistence test uses this factory against a temp file.
 */
import { createSqliteDatabase, type SqlDatabase } from '../db/driver.js'
import { ensureSchema } from '../db/schema.js'
import { SqliteTripStoreDriver } from './driver-sqlite.js'
import { TripRepository } from './repository.js'

export type SqliteTripRepository = {
  repository: TripRepository
  db: SqlDatabase
  close(): Promise<void>
}

export async function createSqliteTripRepository(url: string): Promise<SqliteTripRepository> {
  const db = createSqliteDatabase(url)
  await ensureSchema(db)
  return {
    repository: new TripRepository(new SqliteTripStoreDriver(db)),
    db,
    close: () => db.close(),
  }
}
