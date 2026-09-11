/**
 * In-memory MessageStoreDriver (ticket 06) — the injected driver for app
 * tests, standing in for SQLite the same way MemoryTripStoreDriver does for
 * trips. Rows are exposed so tests can seed history directly.
 */
import type { MessageRow, MessageStoreDriver } from './types.js'

export class MemoryMessageStoreDriver implements MessageStoreDriver {
  readonly messageRows: MessageRow[] = []

  /** Test seed helper: preload history in one call. */
  seed(rows: MessageRow[]): void {
    this.messageRows.push(...rows)
  }

  async listMessageRows(tripId: string): Promise<MessageRow[]> {
    return this.messageRows.filter((row) => row.trip_id === tripId)
  }

  async appendMessageRow(row: MessageRow): Promise<void> {
    this.messageRows.push(row)
  }
}
