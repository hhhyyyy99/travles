/**
 * In-memory TripPatchStoreDriver (ticket 08) — the injected driver for
 * app/repo tests, mirroring MemoryTripStoreDriver / MemoryMessageStoreDriver.
 * Rows are plain objects shaped like the SQLite rows (snake_case, tolerant
 * `unknown` field values) so read mapping behaves identically.
 */
import type {
  DayRow,
  ItemRow,
  LegRow,
} from '../days/types.js'
import type {
  TripPatchDayUpsert,
  TripPatchItemUpsert,
  TripPatchLegUpsert,
  TripPatchStoreDriver,
} from './types.js'

interface StoredDayRow extends DayRow {
  id: string
  trip_id: string
  idx: number
  date: string
  theme: string
  color: string
}

interface StoredItemRow extends ItemRow {
  id: string
  trip_id: string
  day_id: string
  item_order: number
  type: string
  title: string
  note: string
  poi: string | null
  images: string | null
  pending: number
}

interface StoredLegRow extends LegRow {
  id: string
  trip_id: string
  from_item_id: string
  to_item_id: string
  mode: string
  distance_km: number | null
  duration_min: number | null
  polyline: string | null
}

export class MemoryTripPatchStore implements TripPatchStoreDriver {
  readonly dayRows: StoredDayRow[] = []
  readonly itemRows: StoredItemRow[] = []
  readonly legRows: StoredLegRow[] = []

  async listDayRows(tripId: string): Promise<DayRow[]> {
    return this.dayRows.filter((row) => row.trip_id === tripId)
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    return this.itemRows.filter((row) => row.trip_id === tripId)
  }

  async listLegRows(tripId: string): Promise<LegRow[]> {
    return this.legRows.filter((row) => row.trip_id === tripId)
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  async upsertDayRow(tripId: string, day: TripPatchDayUpsert): Promise<void> {
    const existing = this.dayRows.find((row) => row.id === day.id && row.trip_id === tripId)
    if (existing) {
      existing.idx = day.idx
      existing.date = day.date
      existing.theme = day.theme
      return
    }
    this.dayRows.push({ id: day.id, trip_id: tripId, idx: day.idx, date: day.date, theme: day.theme, color: '' })
  }

  async deleteDayRow(tripId: string, dayId: string): Promise<void> {
    const index = this.dayRows.findIndex((row) => row.id === dayId && row.trip_id === tripId)
    if (index >= 0) this.dayRows.splice(index, 1)
  }

  async deleteItemsForDay(tripId: string, dayId: string): Promise<void> {
    for (let i = this.itemRows.length - 1; i >= 0; i -= 1) {
      const row = this.itemRows[i]
      if (row && row.trip_id === tripId && row.day_id === dayId) this.itemRows.splice(i, 1)
    }
  }

  async deleteItemsById(tripId: string, itemIds: string[]): Promise<void> {
    const ids = new Set(itemIds)
    for (let i = this.itemRows.length - 1; i >= 0; i -= 1) {
      const row = this.itemRows[i]
      if (row && row.trip_id === tripId && ids.has(row.id)) this.itemRows.splice(i, 1)
    }
  }

  async upsertItemRow(tripId: string, item: TripPatchItemUpsert): Promise<void> {
    const existing = this.itemRows.find((row) => row.id === item.id && row.trip_id === tripId)
    if (existing) {
      existing.day_id = item.dayId
      existing.item_order = item.itemOrder
      existing.type = item.type
      existing.title = item.title
      existing.note = item.note
      existing.poi = item.poi
      existing.pending = item.pending ? 1 : 0
      return
    }
    this.itemRows.push({
      id: item.id,
      trip_id: tripId,
      day_id: item.dayId,
      item_order: item.itemOrder,
      type: item.type,
      title: item.title,
      note: item.note,
      poi: item.poi,
      images: null,
      pending: item.pending ? 1 : 0,
    })
  }

  async upsertLegRow(tripId: string, leg: TripPatchLegUpsert): Promise<void> {
    const existing = this.legRows.find((row) => row.id === leg.id && row.trip_id === tripId)
    if (existing) {
      existing.from_item_id = leg.fromItemId
      existing.to_item_id = leg.toItemId
      existing.mode = leg.mode
      existing.distance_km = leg.distanceKm
      existing.duration_min = leg.durationMin
      existing.polyline = leg.polyline
      return
    }
    this.legRows.push({
      id: leg.id,
      trip_id: tripId,
      from_item_id: leg.fromItemId,
      to_item_id: leg.toItemId,
      mode: leg.mode,
      distance_km: leg.distanceKm,
      duration_min: leg.durationMin,
      polyline: leg.polyline,
    })
  }

  async deleteLegsForItems(tripId: string, itemIds: string[]): Promise<void> {
    const ids = new Set(itemIds)
    for (let i = this.legRows.length - 1; i >= 0; i -= 1) {
      const row = this.legRows[i]
      if (row && row.trip_id === tripId && (ids.has(row.from_item_id) || ids.has(row.to_item_id))) {
        this.legRows.splice(i, 1)
      }
    }
  }
}
