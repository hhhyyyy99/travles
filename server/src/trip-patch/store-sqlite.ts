/**
 * SQLite TripPatchStoreDriver (ticket 08) — patch writes over the days/
 * items/legs tables that ticket 02's schema already created. Additive by
 * design: no schema changes, no imports from the trips module beyond the
 * date validator. `withTransaction` uses the libSQL transaction connection
 * when available, so a failed patch apply leaves no partial writes behind.
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
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

export class SqliteTripPatchStore implements TripPatchStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listDayRows(tripId: string): Promise<DayRow[]> {
    const { rows } = await this.db.run('SELECT id, trip_id, idx, date, theme, color FROM days WHERE trip_id = ?', [
      tripId,
    ])
    return rows as unknown as DayRow[]
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, day_id, item_order, type, title, note, poi, images, pending FROM items WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as ItemRow[]
  }

  async listLegRows(tripId: string): Promise<LegRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline FROM legs WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as LegRow[]
  }

  async getDayTripId(dayId: string): Promise<string | null> {
    return this.ownerTripId('days', dayId)
  }

  async getItemTripId(itemId: string): Promise<string | null> {
    return this.ownerTripId('items', itemId)
  }

  async withTransaction<T>(fn: (store: TripPatchStoreDriver) => Promise<T>): Promise<T> {
    if (this.db.withTransaction) {
      return this.db.withTransaction(async (transactionDb) => fn(new SqliteTripPatchStore(transactionDb)))
    }
    await this.db.run('BEGIN IMMEDIATE')
    try {
      const result = await fn(this)
      await this.db.run('COMMIT')
      return result
    } catch (error) {
      try {
        await this.db.run('ROLLBACK')
      } catch {
        // connection-level failure — nothing to roll back
      }
      throw error
    }
  }

  async upsertDayRow(tripId: string, day: TripPatchDayUpsert): Promise<void> {
    await this.assertNoForeignOwner('days', day.id, 'day', tripId)
    await this.db.run(
      `INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET idx = excluded.idx, date = excluded.date, theme = excluded.theme
       WHERE days.trip_id = excluded.trip_id`,
      [day.id, tripId, day.idx, day.date, day.theme, ''] as SqlValue[],
    )
    await this.assertCurrentOwner('days', day.id, 'day', tripId)
  }

  async deleteDayRow(tripId: string, dayId: string): Promise<void> {
    await this.db.run('DELETE FROM days WHERE id = ? AND trip_id = ?', [dayId, tripId] as SqlValue[])
  }

  async deleteItemsForDay(tripId: string, dayId: string): Promise<void> {
    await this.db.run('DELETE FROM items WHERE trip_id = ? AND day_id = ?', [tripId, dayId] as SqlValue[])
  }

  async deleteItemsById(tripId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return
    const placeholders = itemIds.map(() => '?').join(', ')
    await this.db.run(`DELETE FROM items WHERE trip_id = ? AND id IN (${placeholders})`, [
      tripId,
      ...itemIds,
    ] as SqlValue[])
  }

  async upsertItemRow(tripId: string, item: TripPatchItemUpsert): Promise<void> {
    await this.assertNoForeignOwner('items', item.id, 'item', tripId)
    await this.assertNoForeignOwner('days', item.dayId, 'day', tripId)
    await this.db.run(
      `INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         day_id = excluded.day_id, item_order = excluded.item_order, type = excluded.type,
         title = excluded.title, note = excluded.note, poi = excluded.poi, pending = excluded.pending
       WHERE items.trip_id = excluded.trip_id`,
      [
        item.id,
        tripId,
        item.dayId,
        item.itemOrder,
        item.type,
        item.title,
        item.note,
        item.poi,
        null,
        item.pending ? 1 : 0,
      ] as SqlValue[],
    )
    await this.assertCurrentOwner('items', item.id, 'item', tripId)
  }

  async upsertLegRow(tripId: string, leg: TripPatchLegUpsert): Promise<void> {
    await this.assertNoForeignOwner('legs', leg.id, 'leg', tripId)
    await this.assertNoForeignOwner('items', leg.fromItemId, 'item', tripId)
    await this.assertNoForeignOwner('items', leg.toItemId, 'item', tripId)
    await this.db.run(
      `INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         from_item_id = excluded.from_item_id, to_item_id = excluded.to_item_id, mode = excluded.mode,
         distance_km = excluded.distance_km, duration_min = excluded.duration_min, polyline = excluded.polyline
       WHERE legs.trip_id = excluded.trip_id`,
      [
        leg.id,
        tripId,
        leg.fromItemId,
        leg.toItemId,
        leg.mode,
        leg.distanceKm,
        leg.durationMin,
        leg.polyline,
      ] as SqlValue[],
    )
    await this.assertCurrentOwner('legs', leg.id, 'leg', tripId)
  }

  async deleteLegsForItems(tripId: string, itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) return
    const placeholders = itemIds.map(() => '?').join(', ')
    await this.db.run(
      `DELETE FROM legs WHERE trip_id = ? AND (from_item_id IN (${placeholders}) OR to_item_id IN (${placeholders}))`,
      [tripId, ...itemIds, ...itemIds] as SqlValue[],
    )
  }

  async updateDaySchedule(tripId: string, updates: DayScheduleUpdate[]): Promise<void> {
    for (const update of updates) {
      await this.db.run('UPDATE days SET idx = ?, date = ? WHERE id = ? AND trip_id = ?', [
        update.idx,
        update.date,
        update.id,
        tripId,
      ] as SqlValue[])
    }
  }

  async getPatchConfirmation(tripId: string): Promise<PatchConfirmationRecord | null> {
    const { rows } = await this.db.run(
      'SELECT token, snapshot_hash, choices, created_at FROM patch_confirmations WHERE trip_id = ? AND consumed_at IS NULL',
      [tripId],
    )
    const row = rows[0]
    if (!row || typeof row.token !== 'string' || typeof row.snapshot_hash !== 'string' || typeof row.created_at !== 'string') {
      return null
    }
    let choices: unknown
    try {
      choices = JSON.parse(typeof row.choices === 'string' ? row.choices : '')
    } catch {
      return null
    }
    if (!Array.isArray(choices)) return null
    const normalized = choices.filter((choice): choice is string => typeof choice === 'string' && choice.trim() !== '')
    if (normalized.length === 0) return null
    return {
      token: row.token,
      snapshotHash: row.snapshot_hash,
      choices: normalized,
      createdAt: row.created_at,
    }
  }

  async savePatchConfirmation(tripId: string, record: PatchConfirmationRecord): Promise<void> {
    await this.db.run(
      `INSERT INTO patch_confirmations (trip_id, token, snapshot_hash, choices, created_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(trip_id) DO UPDATE SET
         token = excluded.token,
         snapshot_hash = excluded.snapshot_hash,
         choices = excluded.choices,
         created_at = excluded.created_at,
         consumed_at = NULL`,
      [tripId, record.token, record.snapshotHash, JSON.stringify(record.choices), record.createdAt] as SqlValue[],
    )
  }

  async consumePatchConfirmation(tripId: string, token: string, snapshotHash: string): Promise<boolean> {
    const result = await this.db.run(
      'UPDATE patch_confirmations SET consumed_at = ? WHERE trip_id = ? AND token = ? AND snapshot_hash = ? AND consumed_at IS NULL',
      [new Date().toISOString(), tripId, token, snapshotHash] as SqlValue[],
    )
    return result.rowsAffected > 0
  }

  private async ownerTripId(table: 'days' | 'items' | 'legs', id: string): Promise<string | null> {
    const { rows } = await this.db.run(`SELECT trip_id FROM ${table} WHERE id = ?`, [id])
    const owner = rows[0]?.trip_id
    return typeof owner === 'string' ? owner : null
  }

  private async assertNoForeignOwner(
    table: 'days' | 'items' | 'legs',
    id: string,
    entity: 'day' | 'item' | 'leg',
    tripId: string,
  ): Promise<void> {
    const owner = await this.ownerTripId(table, id)
    if (owner !== null && owner !== tripId) throw new TripPatchIdConflictError(entity, id, owner)
  }

  private async assertCurrentOwner(
    table: 'days' | 'items' | 'legs',
    id: string,
    entity: 'day' | 'item' | 'leg',
    tripId: string,
  ): Promise<void> {
    const owner = await this.ownerTripId(table, id)
    if (owner !== tripId) {
      if (owner !== null) throw new TripPatchIdConflictError(entity, id, owner)
      throw new Error(`upserted ${entity} row "${id}" disappeared`)
    }
  }
}

/** Factory for the production driver over the shared SqlDatabase instance. */
export function createSqliteTripPatchStore(db: SqlDatabase): TripPatchStoreDriver {
  return new SqliteTripPatchStore(db)
}
