/**
 * In-memory WorkbenchStoreDriver (ticket 04) — the injected driver for
 * app/repository tests, standing in for SQLite the same way
 * MemoryTripStoreDriver does for trips. Rows are exposed so tests can seed
 * realistic (or corrupt) day/item/leg data directly.
 */
import type { DayRow, ItemRow, LegRow, WorkbenchStoreDriver } from './types.js'

export class MemoryWorkbenchStoreDriver implements WorkbenchStoreDriver {
  readonly dayRows: DayRow[] = []
  readonly itemRows: ItemRow[] = []
  readonly legRows: LegRow[] = []

  /** Test seed helper: insert a whole canvas in one call. */
  seed(options: { days?: DayRow[]; items?: ItemRow[]; legs?: LegRow[] }): void {
    this.dayRows.push(...(options.days ?? []))
    this.itemRows.push(...(options.items ?? []))
    this.legRows.push(...(options.legs ?? []))
  }

  async listDayRows(tripId: string): Promise<DayRow[]> {
    return this.dayRows.filter((row) => row.trip_id === tripId)
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    return this.itemRows.filter((row) => row.trip_id === tripId)
  }

  async listLegRows(tripId: string): Promise<LegRow[]> {
    const items = new Map(
      this.itemRows.filter((row) => row.trip_id === tripId).map((row) => [String(row.id), row.poi]),
    )
    return this.legRows
      .filter((row) => row.trip_id === tripId)
      .map((row) => ({
        ...row,
        from_poi: items.get(String(row.from_item_id)),
        to_poi: items.get(String(row.to_item_id)),
      }))
  }
}
