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
import { TripPatchIdConflictError } from './types.js'
import type {
  PatchConfirmationRecord,
  TripPatchDayUpsert,
  TripPatchItemUpsert,
  TripPatchLegUpsert,
  TripPatchStoreDriver,
} from './types.js'
import type { DayScheduleUpdate } from '../trip-events/schedule.js'

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

type StoredPatchConfirmation = PatchConfirmationRecord & { consumedAt?: string }

export class MemoryTripPatchStore implements TripPatchStoreDriver {
  readonly dayRows: StoredDayRow[] = []
  readonly itemRows: StoredItemRow[] = []
  readonly legRows: StoredLegRow[] = []
  readonly patchConfirmations = new Map<string, StoredPatchConfirmation>()

  async listDayRows(tripId: string): Promise<DayRow[]> {
    return this.dayRows.filter((row) => row.trip_id === tripId)
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    return this.itemRows.filter((row) => row.trip_id === tripId)
  }

  async listLegRows(tripId: string): Promise<LegRow[]> {
    return this.legRows.filter((row) => row.trip_id === tripId)
  }

  async getDayTripId(dayId: string): Promise<string | null> {
    return this.dayRows.find((row) => row.id === dayId)?.trip_id ?? null
  }

  async getItemTripId(itemId: string): Promise<string | null> {
    return this.itemRows.find((row) => row.id === itemId)?.trip_id ?? null
  }

  async withTransaction<T>(fn: (store: TripPatchStoreDriver) => Promise<T>): Promise<T> {
    const days = this.dayRows.map((row) => ({ ...row }))
    const items = this.itemRows.map((row) => ({ ...row }))
    const legs = this.legRows.map((row) => ({ ...row }))
    try {
      return await fn(this)
    } catch (error) {
      this.dayRows.splice(0, this.dayRows.length, ...days)
      this.itemRows.splice(0, this.itemRows.length, ...items)
      this.legRows.splice(0, this.legRows.length, ...legs)
      throw error
    }
  }

  async upsertDayRow(tripId: string, day: TripPatchDayUpsert): Promise<void> {
    const owner = await this.getDayTripId(day.id)
    if (owner !== null && owner !== tripId) throw new TripPatchIdConflictError('day', day.id, owner)
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
    const owner = await this.getItemTripId(item.id)
    if (owner !== null && owner !== tripId) throw new TripPatchIdConflictError('item', item.id, owner)
    const dayOwner = await this.getDayTripId(item.dayId)
    if (dayOwner !== null && dayOwner !== tripId) throw new TripPatchIdConflictError('day', item.dayId, dayOwner)
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
    const owner = this.legRows.find((row) => row.id === leg.id)?.trip_id
    if (owner !== undefined && owner !== tripId) throw new TripPatchIdConflictError('leg', leg.id, owner)
    for (const itemId of [leg.fromItemId, leg.toItemId]) {
      const itemOwner = await this.getItemTripId(itemId)
      if (itemOwner !== null && itemOwner !== tripId) throw new TripPatchIdConflictError('item', itemId, itemOwner)
    }
    const existing = this.legRows.find((row) => row.id === leg.id && row.trip_id === tripId)
    if (existing) {
      existing.from_item_id = leg.fromItemId
      existing.to_item_id = leg.toItemId
      existing.mode = leg.mode
      existing.distance_km = leg.distanceKm
      existing.duration_min = leg.durationMin
      existing.polyline = leg.polyline
      existing.quality = legQualityForWrite(leg.quality, leg.distanceKm, leg.durationMin, leg.polyline)
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
      quality: legQualityForWrite(leg.quality, leg.distanceKm, leg.durationMin, leg.polyline),
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

  async updateDaySchedule(tripId: string, updates: DayScheduleUpdate[]): Promise<void> {
    const byId = new Map(updates.map((update) => [update.id, update]))
    for (const row of this.dayRows) {
      if (row.trip_id !== tripId) continue
      const update = byId.get(row.id)
      if (!update) continue
      row.idx = update.idx
      row.date = update.date
    }
  }

  async getPatchConfirmation(tripId: string): Promise<PatchConfirmationRecord | null> {
    const record = this.patchConfirmations.get(tripId)
    if (!record || record.consumedAt) return null
    if (!record.token || !record.snapshotHash || record.choices.length === 0) return null
    return {
      token: record.token,
      snapshotHash: record.snapshotHash,
      choices: [...record.choices],
      createdAt: record.createdAt,
    }
  }

  async savePatchConfirmation(tripId: string, record: PatchConfirmationRecord): Promise<void> {
    this.patchConfirmations.set(tripId, {
      token: record.token,
      snapshotHash: record.snapshotHash,
      choices: [...record.choices],
      createdAt: record.createdAt,
    })
  }

  async consumePatchConfirmation(tripId: string, token: string, snapshotHash: string): Promise<boolean> {
    const record = this.patchConfirmations.get(tripId)
    if (!record || record.consumedAt || record.token !== token || record.snapshotHash !== snapshotHash) return false
    record.consumedAt = new Date().toISOString()
    return true
  }
}

function legQualityForWrite(
  quality: TripPatchLegUpsert['quality'],
  distanceKm: number | null,
  durationMin: number | null,
  polyline: string | null,
): NonNullable<TripPatchLegUpsert['quality']> {
  if (quality) return quality
  if ((distanceKm ?? 0) <= 0 && (durationMin ?? 0) <= 0) return 'pending'
  return polyline === null ? 'estimate' : 'measured'
}
