/**
 * SQLite ItemsAdminStoreDriver (ticket 09) — card writes over the days/items/
 * legs tables that ticket 02's schema already created. Additive by design:
 * no schema changes, no imports from the trips module. Order patches never
 * touch the poi/images columns (position-only updates), and the leg
 * replacement is one DELETE + INSERT batch over the trip's rows.
 */
import { isDeepStrictEqual } from 'node:util'
import { readSqliteLegRows } from '../days/driver-sqlite.js'
import { ActivityItemMetadataSchema, normalizeItemType } from '@hailar/domain'
import type { SqlDatabase, SqlValue } from '../db/driver.js'
import { LEG_ROUTE_KEY, type DayRow, type ItemRow, type LegRow } from '../days/types.js'
import { mapItemRow, normalizeLegQuality } from '../days/repository.js'
import { recordTripEdit } from '../db/trip-edit-time.js'
import type { PlannedLeg } from './legs.js'
import type { ItemFullUpsert, ItemOrderPatch, ItemsAdminStoreDriver } from './types.js'

const ITEM_COLUMNS =
  'id, trip_id, day_id, item_order, type, title, note, time_range, cost, poi, images, pending'

export class SqliteItemsAdminStoreDriver implements ItemsAdminStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listDayRows(tripId: string): Promise<DayRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, idx, date, theme, color, title, note FROM days WHERE trip_id = ?',
      [tripId],
    )
    return rows as unknown as DayRow[]
  }

  async listItemRows(tripId: string): Promise<ItemRow[]> {
    const { rows } = await this.db.run(`SELECT ${ITEM_COLUMNS} FROM items WHERE trip_id = ?`, [
      tripId,
    ])
    return rows as unknown as ItemRow[]
  }

  async listLegRows(tripId: string): Promise<LegRow[]> {
    return readSqliteLegRows(this.db, tripId)
  }

  async dayExists(tripId: string, dayId: string): Promise<boolean> {
    const { rows } = await this.db.run('SELECT trip_id FROM days WHERE id = ?', [dayId])
    const row = rows[0] as { trip_id?: unknown } | undefined
    return row?.trip_id === tripId
  }

  async getItemRow(itemId: string): Promise<ItemRow | null> {
    return this.readItemRow(itemId)
  }

  private async readItemRow(itemId: string): Promise<ItemRow | null> {
    const { rows } = await this.db.run(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, [itemId])
    return (rows[0] as unknown as ItemRow) ?? null
  }

  async withTransaction<T>(fn: (store: ItemsAdminStoreDriver) => Promise<T>): Promise<T> {
    if (this.db.withTransaction) {
      return this.db.withTransaction(async (transactionDb) =>
        fn(new SqliteItemsAdminStoreDriver(transactionDb)),
      )
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
        // Connection-level failure — there may be nothing left to roll back.
      }
      throw error
    }
  }

  async upsertItemFull(tripId: string, item: ItemFullUpsert): Promise<void> {
    const metadata = ActivityItemMetadataSchema.parse(item)
    if (!(await this.dayExists(tripId, item.dayId))) {
      throw new Error(`day ${item.dayId} does not belong to trip ${tripId}`)
    }
    const before = await this.readItemRow(item.id)
    const { rows } = await this.db.run(
      `INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, time_range, cost, poi, images, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET
         day_id = excluded.day_id,
         item_order = excluded.item_order,
         type = excluded.type,
         title = excluded.title,
         note = excluded.note,
         poi = excluded.poi,
         images = excluded.images
         ${metadata.timeRange !== undefined ? ', time_range = excluded.time_range' : ''}
         ${metadata.cost !== undefined ? ', cost = excluded.cost' : ''}
       WHERE items.trip_id = excluded.trip_id
       RETURNING ${ITEM_COLUMNS}`,
      [
        item.id,
        tripId,
        item.dayId,
        item.itemOrder,
        normalizeItemType(item.type) ?? item.type,
        item.title,
        item.note,
        metadata.timeRange ?? null,
        metadata.cost ?? null,
        item.poiJson,
        item.imagesJson,
      ] as SqlValue[],
    )
    const after = rows[0] as ItemRow | undefined
    if (!after) throw new Error(`item ${item.id} belongs to another trip`)
    if (!before || !isDeepStrictEqual(mapItemRow(before), mapItemRow(after))) {
      await recordTripEdit(this.db, tripId)
    }
  }

  async updateItemOrders(tripId: string, orders: ItemOrderPatch[]): Promise<void> {
    let changed = false
    for (const patch of orders) {
      const { rowsAffected } = await this.db.run(
        `UPDATE items SET day_id = ?1, item_order = ?2 WHERE id = ?3 AND trip_id = ?4
         AND (day_id IS NOT ?1 OR item_order IS NOT ?2)`,
        [patch.dayId, patch.itemOrder, patch.id, tripId] as SqlValue[],
      )
      changed ||= rowsAffected > 0
    }
    if (changed) await recordTripEdit(this.db, tripId)
  }

  async deleteItemRow(tripId: string, itemId: string): Promise<void> {
    const { rowsAffected } = await this.db.run('DELETE FROM items WHERE id = ? AND trip_id = ?', [
      itemId,
      tripId,
    ] as SqlValue[])
    if (rowsAffected > 0) await recordTripEdit(this.db, tripId)
  }

  async replaceLegs(tripId: string, legs: PlannedLeg[]): Promise<void> {
    await this.db.run('DELETE FROM legs WHERE trip_id = ?', [tripId])
    for (const leg of legs) {
      await this.db.run(
        'INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline, quality, verified_route_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          leg.id,
          tripId,
          leg.fromItemId,
          leg.toItemId,
          leg.mode,
          leg.distanceKm,
          leg.durationMin,
          leg.polyline === null ? null : JSON.stringify(leg.polyline),
          normalizeLegQuality(leg.quality, leg.distanceKm, leg.durationMin, leg.polyline),
          leg[LEG_ROUTE_KEY] ?? null,
        ] as SqlValue[],
      )
    }
  }
}

/** Factory for the production driver over the shared SqlDatabase instance. */
export function createSqliteItemsAdminStore(db: SqlDatabase): ItemsAdminStoreDriver {
  return new SqliteItemsAdminStoreDriver(db)
}
