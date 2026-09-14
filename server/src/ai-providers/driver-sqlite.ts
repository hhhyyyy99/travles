import type { SqlDatabase } from '../db/driver.js'
import type { AiProviderRow, AiProviderStoreDriver } from './types.js'

/** SQLite driver over the shared application database. */
export class SqliteAiProviderStoreDriver implements AiProviderStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listRows(): Promise<AiProviderRow[]> {
    const result = await this.db.run(
      `SELECT id, name, base_url, api_key, model_id, headers, protocol, thinking, is_default,
        capabilities, last_tested_at, last_error, created_at, updated_at
       FROM ai_providers ORDER BY is_default DESC, updated_at DESC, created_at ASC`,
    )
    return result.rows as AiProviderRow[]
  }

  async getRow(id: string): Promise<AiProviderRow | null> {
    const result = await this.db.run(
      `SELECT id, name, base_url, api_key, model_id, headers, protocol, thinking, is_default,
        capabilities, last_tested_at, last_error, created_at, updated_at
       FROM ai_providers WHERE id = ? LIMIT 1`,
      [id],
    )
    return (result.rows[0] as AiProviderRow | undefined) ?? null
  }

  async insertRow(row: AiProviderRow): Promise<void> {
    await this.db.run(
      `INSERT INTO ai_providers
       (id, name, base_url, api_key, model_id, headers, protocol, thinking, is_default,
        capabilities, last_tested_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.name,
        row.base_url,
        row.api_key,
        row.model_id,
        row.headers,
        row.protocol,
        row.thinking,
        row.is_default,
        row.capabilities,
        row.last_tested_at,
        row.last_error,
        row.created_at,
        row.updated_at,
      ],
    )
  }

  async updateRow(id: string, patch: Partial<AiProviderRow>): Promise<boolean> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return Boolean(await this.getRow(id))
    const fields = entries.map(([key]) => `${key} = ?`).join(', ')
    const args = entries.map(([, value]) => value ?? null)
    const result = await this.db.run(`UPDATE ai_providers SET ${fields} WHERE id = ?`, [...args, id])
    return result.rowsAffected > 0
  }

  async deleteRow(id: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM ai_providers WHERE id = ?', [id])
    return result.rowsAffected > 0
  }

  async setDefault(id: string): Promise<boolean> {
    const existing = await this.getRow(id)
    if (!existing) return false
    await this.db.run('UPDATE ai_providers SET is_default = 0')
    await this.db.run('UPDATE ai_providers SET is_default = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), id])
    return true
  }
}
