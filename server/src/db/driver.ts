/**
 * SQLite database seam (ticket 02).
 *
 * The driver is the injectable boundary from the spec's 测试接缝 #2: the
 * repository layer never touches @libsql/client directly, only this minimal
 * `run(sql, args)` surface. LibSQL is chosen over better-sqlite3 because it
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
  return {
    async run(sql, args = []) {
      const result = await client.execute({ sql, args })
      return { rows: result.rows as Record<string, unknown>[], rowsAffected: result.rowsAffected }
    },
    close: async () => {
      client.close()
    },
  }
}
