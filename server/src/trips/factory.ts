/**
 * Factory for the production trip + content repositories: real SQLite file +
 * schema (ticket 02/03). Tests inject the memory drivers instead; the restart
 * persistence test uses this factory against a temp file.
 */
import { createSqliteDatabase, type SqlDatabase } from '../db/driver.js'
import { ensureSchema } from '../db/schema.js'
import { SqliteContentStoreDriver } from '../content/driver-sqlite.js'
import { TripContentRepository } from '../content/repository.js'
import { SqliteTripStoreDriver } from './driver-sqlite.js'
import { TripRepository } from './repository.js'

export type SqliteTripRepository = {
  repository: TripRepository
  /** Days/items/checklist storage over the same database (ticket 03). */
  contentRepository: TripContentRepository
  db: SqlDatabase
  close(): Promise<void>
}

export async function createSqliteTripRepository(url: string): Promise<SqliteTripRepository> {
  const db = createSqliteDatabase(url)
  await ensureSchema(db)
  return {
    repository: new TripRepository(new SqliteTripStoreDriver(db)),
    contentRepository: new TripContentRepository(new SqliteContentStoreDriver(db)),
    db,
    close: () => db.close(),
  }
}
