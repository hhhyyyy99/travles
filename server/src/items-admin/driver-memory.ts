/**
 * In-memory ItemsAdminStoreDriver (ticket 09) — the injected driver for
 * repository/app tests, mirroring MemoryDaysAdminStoreDriver. Maps are
 * exposed so tests can seed realistic (or corrupt) rows directly;
 * `nextWriteError` simulates storage failures.
 */
import { ActivityItemMetadataSchema, normalizeItemType } from '@hailar/domain'
import { LEG_ROUTE_KEY, type DayRow, type ItemRow, type LegRow } from '../days/types.js'
import { normalizeLegQuality } from '../days/repository.js'
import type { ItemFullUpsert, ItemOrderPatch, ItemsAdminStoreDriver } from './types.js'
import type { PlannedLeg } from './legs.js'

export class MemoryItemsAdminStoreDriver implements ItemsAdminStoreDriver {
  readonly dayRows = new Map<string, DayRow>()
  readonly itemRows = new Map<string, ItemRow>()
  readonly legRows = new Map<string, LegRow>()
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

  async listLegRows(tripId: string): Promise<LegRow[]> {
    return [...this.legRows.values()]
      .filter((row) => row.trip_id === tripId)
      .map((row) => ({
        ...row,
        from_poi: this.itemRows.get(String(row.from_item_id))?.poi,
        to_poi: this.itemRows.get(String(row.to_item_id))?.poi,
      }))
  }

  async dayExists(tripId: string, dayId: string): Promise<boolean> {
    const row = this.dayRows.get(dayId)
    return row?.trip_id === tripId
  }

  async getItemRow(itemId: string): Promise<ItemRow | null> {
    return this.itemRows.get(itemId) ?? null
  }

  async withTransaction<T>(fn: (store: ItemsAdminStoreDriver) => Promise<T>): Promise<T> {
    const days = new Map([...this.dayRows].map(([id, row]) => [id, { ...row }]))
    const items = new Map([...this.itemRows].map(([id, row]) => [id, { ...row }]))
    const legs = new Map([...this.legRows].map(([id, row]) => [id, { ...row }]))
    try {
      return await fn(this)
    } catch (error) {
      this.dayRows.clear()
      this.itemRows.clear()
      this.legRows.clear()
      for (const [id, row] of days) this.dayRows.set(id, row)
      for (const [id, row] of items) this.itemRows.set(id, row)
      for (const [id, row] of legs) this.legRows.set(id, row)
      throw error
    }
  }

  async upsertItemFull(tripId: string, item: ItemFullUpsert): Promise<void> {
    const metadata = ActivityItemMetadataSchema.parse(item)
    this.failNextWrite()
    if (!(await this.dayExists(tripId, item.dayId))) {
      throw new Error(`day ${item.dayId} does not belong to trip ${tripId}`)
    }
    const existing = this.itemRows.get(item.id)
    if (existing && existing.trip_id !== tripId)
      throw new Error(`item ${item.id} belongs to another trip`)
    this.itemRows.set(item.id, {
      id: item.id,
      trip_id: tripId,
      day_id: item.dayId,
      item_order: item.itemOrder,
      type: normalizeItemType(item.type) ?? item.type,
      title: item.title,
      note: item.note,
      time_range:
        metadata.timeRange !== undefined ? metadata.timeRange : (existing?.time_range ?? null),
      cost: metadata.cost !== undefined ? metadata.cost : (existing?.cost ?? null),
      poi: item.poiJson,
      images: item.imagesJson,
      pending: 0,
    })
  }

  async updateItemOrders(tripId: string, orders: ItemOrderPatch[]): Promise<void> {
    this.failNextWrite()
    for (const patch of orders) {
      const row = this.itemRows.get(patch.id)
      if (!row || row.trip_id !== tripId) continue
      this.itemRows.set(patch.id, { ...row, day_id: patch.dayId, item_order: patch.itemOrder })
    }
  }

  async deleteItemRow(tripId: string, itemId: string): Promise<void> {
    this.failNextWrite()
    const row = this.itemRows.get(itemId)
    if (row && row.trip_id === tripId) this.itemRows.delete(itemId)
  }

  async replaceLegs(tripId: string, legs: PlannedLeg[]): Promise<void> {
    this.failNextWrite()
    for (const [id, row] of [...this.legRows]) {
      if (row.trip_id === tripId) this.legRows.delete(id)
    }
    for (const leg of legs) {
      this.legRows.set(leg.id, {
        id: leg.id,
        trip_id: tripId,
        from_item_id: leg.fromItemId,
        to_item_id: leg.toItemId,
        mode: leg.mode,
        distance_km: leg.distanceKm,
        duration_min: leg.durationMin,
        polyline: leg.polyline === null ? null : JSON.stringify(leg.polyline),
        quality: normalizeLegQuality(leg.quality, leg.distanceKm, leg.durationMin, leg.polyline),
        verified_route_key: leg[LEG_ROUTE_KEY] ?? null,
      })
    }
  }
}
