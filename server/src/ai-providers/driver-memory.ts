import type { AiProviderRow, AiProviderStoreDriver } from './types.js'

/** Injectable provider store for route/repository tests. */
export class MemoryAiProviderStoreDriver implements AiProviderStoreDriver {
  readonly rows = new Map<string, AiProviderRow>()
  nextWriteError: Error | null = null

  private failNextWrite(): void {
    if (!this.nextWriteError) return
    const error = this.nextWriteError
    this.nextWriteError = null
    throw error
  }

  async listRows(): Promise<AiProviderRow[]> {
    return [...this.rows.values()].map((row) => ({ ...row }))
  }

  async getRow(id: string): Promise<AiProviderRow | null> {
    const row = this.rows.get(id)
    return row ? { ...row } : null
  }

  async insertRow(row: AiProviderRow): Promise<void> {
    this.failNextWrite()
    this.rows.set(row.id, { ...row })
  }

  async updateRow(id: string, patch: Partial<AiProviderRow>): Promise<boolean> {
    this.failNextWrite()
    const row = this.rows.get(id)
    if (!row) return false
    this.rows.set(id, { ...row, ...patch })
    return true
  }

  async deleteRow(id: string): Promise<boolean> {
    this.failNextWrite()
    return this.rows.delete(id)
  }

  async setDefault(id: string): Promise<boolean> {
    this.failNextWrite()
    if (!this.rows.has(id)) return false
    for (const [rowId, row] of this.rows) {
      this.rows.set(rowId, { ...row, is_default: rowId === id ? 1 : 0 })
    }
    return true
  }
}
