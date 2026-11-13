/**
 * In-memory ContentStoreDriver (ticket 03) — the injected driver for content
 * unit tests, mirroring MemoryTripStoreDriver. Maps are exposed so tests can
 * seed corrupt rows; `nextWriteError` simulates storage failures.
 */
import { ActivityItemMetadataSchema } from '@hailar/domain'
import type {
  ChecklistRow,
  ChecklistUpsert,
  ContentStoreDriver,
  DayRow,
  ItemRow,
  ItemUpsert,
} from './types.js'

export class MemoryContentStoreDriver implements ContentStoreDriver {
  readonly dayRows = new Map<string, DayRow>()
  readonly itemRows = new Map<string, ItemRow>()
  readonly checklistRows = new Map<string, ChecklistRow>()
  /** When set, the next write operation throws with this error (then clears). */
  nextWriteError: Error | null = null

  private failNextWrite(): void {
    if (this.nextWriteError) {
      const error = this.nextWriteError
      this.nextWriteError = null
      throw error
    }
  }

  async listDayRows(tripId: string): Promise<DayRow[]> {
    return [...this.dayRows.values()].filter((row) => row.trip_id === tripId)
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    return [...this.itemRows.values()].filter((row) => row.trip_id === tripId)
  }

  async listChecklistRows(tripId: string): Promise<ChecklistRow[]> {
    return [...this.checklistRows.values()].filter((row) => row.trip_id === tripId)
  }

  async dayExists(tripId: string, dayId: string): Promise<boolean> {
    const row = this.dayRows.get(dayId)
    return row?.trip_id === tripId
  }

  async upsertItemRow(tripId: string, item: ItemUpsert): Promise<void> {
    const metadata = ActivityItemMetadataSchema.parse(item)
    this.failNextWrite()
    if (!(await this.dayExists(tripId, item.dayId))) {
      throw new Error(`day ${item.dayId} does not belong to trip ${tripId}`)
    }
    const existing = this.itemRows.get(item.id)
    this.itemRows.set(item.id, {
      id: item.id,
      trip_id: tripId,
      day_id: item.dayId,
      item_order: item.itemOrder,
      type: item.type,
      title: item.title,
      note: item.note,
      time_range: metadata.timeRange !== undefined ? metadata.timeRange : existing?.time_range ?? null,
      cost: metadata.cost !== undefined ? metadata.cost : existing?.cost ?? null,
      poi: item.poiJson ?? null,
      images: null,
      pending: item.pending ? 1 : 0,
    })
  }

  async upsertChecklistRow(tripId: string, entry: ChecklistUpsert): Promise<void> {
    this.failNextWrite()
    const existing = this.checklistRows.get(entry.id)
    this.checklistRows.set(entry.id, {
      id: entry.id,
      trip_id: tripId,
      content: entry.content,
      done: entry.done ? 1 : 0,
      created_at: (existing?.created_at as string) ?? new Date().toISOString(),
    })
  }
}
