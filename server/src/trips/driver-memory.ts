/**
 * In-memory TripStoreDriver (ticket 02) — the injected driver for repository
 * unit tests, standing in for SQLite the same way the storage codec tests
 * use an in-memory StorageLike.
 *
 * `rows` is deliberately exposed (and values unvalidated) so tests can seed
 * corrupt rows; `nextWriteError` simulates storage failures for the
 * {ok:false} write paths.
 */
import type { TripInsertRow, TripRow, TripStoreDriver } from './types.js'

export class MemoryTripStoreDriver implements TripStoreDriver {
  readonly rows = new Map<string, TripRow>()
  /** When set, the next write operation throws with this error (then clears). */
  nextWriteError: Error | null = null

  private failNextWrite(): void {
    if (this.nextWriteError) {
      const error = this.nextWriteError
      this.nextWriteError = null
      throw error
    }
  }

  async listTripRows(): Promise<TripRow[]> {
    return [...this.rows.values()]
  }

  async getTripRow(id: string): Promise<TripRow | null> {
    return this.rows.get(id) ?? null
  }

  async insertTripRow(row: TripInsertRow): Promise<void> {
    this.failNextWrite()
    this.rows.set(row.id as string, { ...row })
  }

  async updateTripRow(
    id: string,
    patch: { title: string; startDate: string; endDate: string; updatedAt: string; planningContext: string | null },
  ): Promise<boolean> {
    this.failNextWrite()
    const row = this.rows.get(id)
    if (!row) return false
    this.rows.set(id, {
      ...row,
      title: patch.title,
      start_date: patch.startDate,
      end_date: patch.endDate,
      updated_at: patch.updatedAt,
      planning_context: patch.planningContext,
    })
    return true
  }

  async deleteTripRow(id: string): Promise<boolean> {
    this.failNextWrite()
    return this.rows.delete(id)
  }
}
