/**
 * In-memory DaysAdminStoreDriver (ticket 10) — the injected write driver for
 * unit/HTTP tests, mirroring MemoryContentStoreDriver. Maps are exposed so
 * tests can seed days/items/legs directly; `nextWriteError` simulates
 * storage failures.
 */
import type { DayRow, ItemRow, LegRow } from '../days/types.js'
import type { DayInsert, DaysAdminStoreDriver, DayThemePatch } from './types.js'
import type { DayScheduleUpdate } from '../trip-events/schedule.js'

export class MemoryDaysAdminStoreDriver implements DaysAdminStoreDriver {
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

  async getDayRow(dayId: string): Promise<DayRow | null> {
    return this.dayRows.get(dayId) ?? null
  }

  async insertDayRow(row: DayInsert): Promise<void> {
    this.failNextWrite()
    this.dayRows.set(row.id, {
      id: row.id,
      trip_id: row.tripId,
      idx: row.idx,
      date: row.date,
      theme: row.theme,
      color: row.color,
      title: row.title ?? null,
      note: row.note ?? null,
    })
  }

  async updateDayRow(dayId: string, patch: DayThemePatch): Promise<void> {
    this.failNextWrite()
    const existing = this.dayRows.get(dayId)
    if (!existing) throw new Error(`day ${dayId} does not exist`)
    this.dayRows.set(dayId, {
      ...existing,
      theme: patch.theme !== undefined ? patch.theme : existing.theme,
      color: patch.color !== undefined ? patch.color : existing.color,
      title: patch.title !== undefined ? patch.title : existing.title,
      note: patch.note !== undefined ? patch.note : existing.note,
    })
  }

  async listItemIdsForDay(dayId: string): Promise<string[]> {
    return [...this.itemRows.values()]
      .filter((row) => row.day_id === dayId)
      .map((row) => (typeof row.id === 'string' ? row.id : ''))
      .filter((id) => id !== '')
  }

  async deleteLegsForDay(dayId: string): Promise<void> {
    this.failNextWrite()
    const itemIds = new Set(await this.listItemIdsForDay(dayId))
    for (const [id, row] of this.legRows) {
      const from = typeof row.from_item_id === 'string' ? row.from_item_id : ''
      const to = typeof row.to_item_id === 'string' ? row.to_item_id : ''
      if (itemIds.has(from) || itemIds.has(to)) this.legRows.delete(id)
    }
  }

  async deleteItemsForDay(dayId: string): Promise<void> {
    this.failNextWrite()
    for (const [id, row] of this.itemRows) {
      if (row.day_id === dayId) this.itemRows.delete(id)
    }
  }

  async deleteDayRow(dayId: string): Promise<void> {
    this.failNextWrite()
    this.dayRows.delete(dayId)
  }

  async updateDaySchedule(tripId: string, updates: DayScheduleUpdate[]): Promise<void> {
    this.failNextWrite()
    const byId = new Map(updates.map((update) => [update.id, update]))
    for (const [id, row] of this.dayRows) {
      if (row.trip_id !== tripId) continue
      const update = byId.get(id)
      if (!update) continue
      this.dayRows.set(id, { ...row, idx: update.idx, date: update.date })
    }
  }
}
