import { createHash, randomUUID } from 'node:crypto'
import { GuideImportRequestSchema, type GuideImportRequest, type TripSummary } from '@hailar/domain'
import type { SqlDatabase } from '../db/driver.js'
import { SqliteTripStoreDriver } from '../trips/driver-sqlite.js'
import { mapRowToSummary } from '../trips/repository.js'
import type { TripInsertRow } from '../trips/types.js'

export class GuideImportConflict extends Error {}

/** Trip, ordered days/items, and the idempotency receipt commit together. */
export async function importGuide(db: SqlDatabase, request: GuideImportRequest): Promise<TripSummary> {
  // Validate here too: callers outside HTTP must never bypass the draft limits.
  const input = GuideImportRequestSchema.parse(request)
  if (!db.withTransaction) throw new Error('Guide import requires a transaction')
  // Zod emits a fixed field order, so JSON object key order cannot alter this hash.
  const payloadHash = createHash('sha256').update(JSON.stringify({ draft: input.draft, title: input.title })).digest('hex')
  return db.withTransaction(async (transaction) => {
    const { rows } = await transaction.run(
      'SELECT payload_hash, trip_id FROM guide_imports WHERE import_id = ?', [input.importId],
    )
    const previous = rows[0]
    if (previous) {
      if (previous.payload_hash !== payloadHash) throw new GuideImportConflict('这份预览已经确认过，但提交内容不同。请重新生成预览后再导入。')
      const row = await new SqliteTripStoreDriver(transaction).getTripRow(String(previous.trip_id))
      const trip = row ? mapRowToSummary(row) : null
      if (!trip) throw new GuideImportConflict('已导入的行程已被删除，请重新生成预览后再导入。')
      return trip
    }

    const now = new Date().toISOString()
    const title = input.title ?? input.draft.title.slice(0, 100)
    const context = {
      destination: input.draft.destination.trim() || title,
      durationDays: input.draft.days.length,
      preferences: '按攻略草稿导入，日期待确认',
      originalSentence: input.draft.title,
      dateStatus: 'unspecified',
      source: 'guide',
    }
    const row: TripInsertRow = {
      id: randomUUID(), title, start_date: '', end_date: '',
      planning_context: JSON.stringify(context), created_at: now, updated_at: now,
    }
    await new SqliteTripStoreDriver(transaction).insertTripRow(row)
    for (const [index, day] of input.draft.days.entries()) {
      const dayId = randomUUID()
      await transaction.run('INSERT INTO days (id, trip_id, idx, date, theme, color) VALUES (?, ?, ?, ?, ?, ?)',
        [dayId, row.id, index, '', day.title, ''])
      for (const [order, item] of day.items.entries()) {
        const poi = item.poi ? { ...item.poi, category: '', rating: 0, introSummary: '' } : null
        await transaction.run(
          'INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending, time_range, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [randomUUID(), row.id, dayId, order, item.type, item.title, item.note,
            poi ? JSON.stringify(poi) : null, '[]', item.pending ? 1 : 0, item.timeRange ?? null, item.cost ?? null],
        )
      }
    }
    await transaction.run('INSERT INTO guide_imports (import_id, payload_hash, trip_id) VALUES (?, ?, ?)',
      [input.importId, payloadHash, row.id])
    const trip = mapRowToSummary(row)
    if (!trip) throw new Error('Imported trip cannot be read')
    return trip
  })
}
