/**
 * SQLite database seam (ticket 02).
 *
 * The driver is the injectable boundary from the spec's 测试接缝 #2: the
 * repository layer never touches @libsql/client directly, only this minimal
 * `run(sql, args)` surface plus an optional transaction callback. LibSQL is
 * chosen over better-sqlite3 because it
 * ships prebuilt native binaries (no node-gyp / pnpm allowBuilds changes),
 * speaks the local `file:` SQLite dialect we need, and matches the Mastra
 * LibSQL storage ecosystem the spec points at for later tickets ("Mastra
 * memory 存储指向同一库").
 */
import { createClient, type Client } from '@libsql/client'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SqlValue = string | number | bigint | Uint8Array | null

export type SqlRunResult = {
  rows: Record<string, unknown>[]
  rowsAffected: number
}

export interface SqlDatabase {
  run(sql: string, args?: SqlValue[]): Promise<SqlRunResult>
  /** Execute a callback on one libSQL transaction connection. */
  withTransaction?<T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T>
  close(): Promise<void>
}

/** Normalize a raw path or `file:` URL into the URL form libsql expects. */
export function toLibsqlUrl(raw: string): string {
  if (raw.startsWith('file:') || raw.includes('://') || raw === ':memory:') return raw
  return `file:${raw}`
}

/**
 * Open a local SQLite file (or `:memory:`) database. The parent directory of
 * a file database is created if missing so a fresh checkout works on first
 * boot.
 */
export function createSqliteDatabase(rawUrl: string): SqlDatabase {
  const url = toLibsqlUrl(rawUrl)
  if (url.startsWith('file:') && url !== 'file::memory:') {
    const filePath = url.slice('file:'.length)
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })
  }
  const client: Client = createClient({ url })
  const run = async (executor: { execute(statement: { sql: string; args: SqlValue[] }): Promise<{ rows: unknown[]; rowsAffected: number }> }, sql: string, args: SqlValue[] = []): Promise<SqlRunResult> => {
    const result = await executor.execute({ sql, args })
    return { rows: result.rows as Record<string, unknown>[], rowsAffected: result.rowsAffected }
  }
  return {
    run: (sql, args = []) => run(client, sql, args),
    withTransaction: async <T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T> => {
      const transaction = await client.transaction('write')
      const transactionDb: SqlDatabase = {
        run: (sql, args = []) => run(transaction, sql, args),
        close: async () => transaction.close(),
      }
      try {
        const result = await fn(transactionDb)
        await transaction.commit()
        return result
      } catch (error) {
        try {
          await transaction.rollback()
        } catch {
          // connection-level failure — nothing to roll back
        }
        throw error
      } finally {
        transaction.close()
      }
    },
    close: async () => {
      client.close()
    },
  }
}
