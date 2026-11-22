/**
 * In-memory TripPatchStoreDriver (ticket 08) — the injected driver for
 * app/repo tests, mirroring MemoryTripStoreDriver / MemoryMessageStoreDriver.
 * Rows are plain objects shaped like the SQLite rows (snake_case, tolerant
 * `unknown` field values) so read mapping behaves identically.
 */
import { ActivityItemMetadataSchema, normalizeItemType } from '@hailar/domain'
import type { DayRow, ItemRow, LegRow } from '../days/types.js'
import { TripPatchIdConflictError } from './types.js'
import type {
  PatchConfirmationRecord,
  TripPatchDayUpsert,
  TripPatchItemUpsert,
  TripPatchLegUpsert,
  TripPatchStoreDriver,
} from './types.js'
import type { DayScheduleUpdate } from '../trip-events/schedule.js'
import type { StashInsert, StashRow } from '../recommendations/types.js'

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
  readonly stashRows: StashRow[] = []
  readonly patchConfirmations = new Map<string, StoredPatchConfirmation>()
  private transactionTail: Promise<void> = Promise.resolve()

  constructor(readonly getTripSummary?: TripPatchStoreDriver['getTripSummary']) {}

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

  async listStashRows(tripId: string): Promise<StashRow[]> {
    return this.stashRows.filter((row) => row.trip_id === tripId)
  }

  async getStashTripId(stashId: string): Promise<string | null> {
    const owner = this.stashRows.find((row) => row.id === stashId)?.trip_id
    return typeof owner === 'string' ? owner : null
  }

  async insertStashRow(tripId: string, item: StashInsert): Promise<void> {
    const owner = await this.getStashTripId(item.id)
    if (owner !== null) {
      if (owner !== tripId) throw new TripPatchIdConflictError('stash', item.id, owner)
      throw new Error(`stash id "${item.id}" already exists`)
    }
    this.stashRows.push({
      id: item.id,
      trip_id: tripId,
      poi: item.poi,
      origin: item.origin,
      added_at: item.addedAt,
      ...(item.title !== undefined ? { title: item.title } : {}),
      ...(item.note !== undefined ? { note: item.note } : {}),
      ...(item.category !== undefined ? { category: item.category } : {}),
      ...(item.createdAt !== undefined ? { created_at: item.createdAt } : {}),
    })
  }

  async deleteStashRow(tripId: string, stashId: string): Promise<boolean> {
    const index = this.stashRows.findIndex((row) => row.id === stashId && row.trip_id === tripId)
    if (index < 0) return false
    this.stashRows.splice(index, 1)
    return true
  }

  async withTransaction<T>(fn: (store: TripPatchStoreDriver) => Promise<T>): Promise<T> {
    const run = this.transactionTail.then(() => this.executeTransaction(fn))
    this.transactionTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async executeTransaction<T>(fn: (store: TripPatchStoreDriver) => Promise<T>): Promise<T> {
    const days = this.dayRows.map((row) => ({ ...row }))
    const items = this.itemRows.map((row) => ({ ...row }))
    const legs = this.legRows.map((row) => ({ ...row }))
    const stash = this.stashRows.map((row) => ({ ...row }))
    const confirmations = structuredClone(this.patchConfirmations)
    try {
      return await fn(this)
    } catch (error) {
      this.dayRows.splice(0, this.dayRows.length, ...days)
      this.itemRows.splice(0, this.itemRows.length, ...items)
      this.legRows.splice(0, this.legRows.length, ...legs)
      this.stashRows.splice(0, this.stashRows.length, ...stash)
      this.patchConfirmations.clear()
      for (const [tripId, record] of confirmations) this.patchConfirmations.set(tripId, record)
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
      if (day.title !== undefined) existing.title = day.title
      if (day.note !== undefined) existing.note = day.note
      return
    }
    this.dayRows.push({
      id: day.id,
      trip_id: tripId,
      idx: day.idx,
      date: day.date,
      theme: day.theme,
      color: '',
      ...(day.title !== undefined ? { title: day.title } : {}),
      ...(day.note !== undefined ? { note: day.note } : {}),
    })
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
    const metadata = ActivityItemMetadataSchema.parse(item)
    const owner = await this.getItemTripId(item.id)
    if (owner !== null && owner !== tripId)
      throw new TripPatchIdConflictError('item', item.id, owner)
    const dayOwner = await this.getDayTripId(item.dayId)
    if (dayOwner !== null && dayOwner !== tripId)
      throw new TripPatchIdConflictError('day', item.dayId, dayOwner)
    const existing = this.itemRows.find((row) => row.id === item.id && row.trip_id === tripId)
    if (existing) {
      existing.day_id = item.dayId
      existing.item_order = item.itemOrder
      existing.type = normalizeItemType(item.type) ?? item.type
      existing.title = item.title
      existing.note = item.note
      existing.poi = item.poi
      if (item.images !== undefined) existing.images = item.images
      existing.pending = item.pending ? 1 : 0
      if (metadata.timeRange !== undefined) existing.time_range = metadata.timeRange
      if (metadata.cost !== undefined) existing.cost = metadata.cost
      return
    }
    this.itemRows.push({
      id: item.id,
      trip_id: tripId,
      day_id: item.dayId,
      item_order: item.itemOrder,
      type: normalizeItemType(item.type) ?? item.type,
      title: item.title,
      note: item.note,
      poi: item.poi,
      images: item.images ?? null,
      pending: item.pending ? 1 : 0,
      time_range: metadata.timeRange ?? null,
      cost: metadata.cost ?? null,
    })
  }

  async upsertLegRow(tripId: string, leg: TripPatchLegUpsert): Promise<void> {
    const owner = this.legRows.find((row) => row.id === leg.id)?.trip_id
    if (owner !== undefined && owner !== tripId)
      throw new TripPatchIdConflictError('leg', leg.id, owner)
    for (const itemId of [leg.fromItemId, leg.toItemId]) {
      const itemOwner = await this.getItemTripId(itemId)
      if (itemOwner !== null && itemOwner !== tripId)
        throw new TripPatchIdConflictError('item', itemId, itemOwner)
    }
    const existing = this.legRows.find((row) => row.id === leg.id && row.trip_id === tripId)
    if (existing) {
      existing.from_item_id = leg.fromItemId
      existing.to_item_id = leg.toItemId
      existing.mode = leg.mode
      existing.distance_km = leg.distanceKm
      existing.duration_min = leg.durationMin
      existing.polyline = leg.polyline
      existing.quality = legQualityForWrite(
        leg.quality,
        leg.distanceKm,
        leg.durationMin,
        leg.polyline,
      )
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

  async consumePatchConfirmation(
    tripId: string,
    token: string,
    snapshotHash: string,
  ): Promise<boolean> {
    const record = this.patchConfirmations.get(tripId)
    if (
      !record ||
      record.consumedAt ||
      record.token !== token ||
      record.snapshotHash !== snapshotHash
    )
      return false
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
