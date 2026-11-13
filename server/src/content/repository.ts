/**
 * Trip content repository (ticket 03) — validation + tolerant mapping over
 * any ContentStoreDriver (spec 测试接缝 #2), mirroring TripRepository.
 *
 * Convention (mirrors src/domain/storage.ts):
 * - Reads NEVER throw: a failing driver or corrupt rows degrade to empty
 *   lists / dropped entries.
 * - Writes return {ok:true} | {ok:false, error, code} — the HTTP layer maps
 *   that to status codes.
 *
 * Idempotency: upserts are keyed by caller-supplied row ids, so repeating
 * the same write (seed re-run, migration re-trigger) updates one row instead
 * of duplicating it. See server/src/seed/builtin-trip-data.ts for the fixed
 * ID scheme.
 */
import { projectDayIdentity } from '../days/projections.js'
import { readDayMetadata } from '../days/metadata.js'
import type {
  ChecklistEntry,
  ChecklistRow,
  ChecklistUpsert,
  ContentErrorCode,
  ContentStoreDriver,
  ContentWriteResult,
  DayContent,
  DayRow,
  ItemContent,
  ItemRow,
  ItemUpsert,
} from './types.js'

/** Hard cap so a hostile payload cannot write unbounded row ids. */
const MAX_ID_LENGTH = 200

export class TripContentRepository {
  constructor(private readonly driver: ContentStoreDriver) {}

  /**
   * Days of a trip with their items attached. Days without a usable id are
   * dropped; items referencing a dropped day are dropped with them; items
   * are ordered by itemOrder then id.
   */
  async listDays(tripId: string): Promise<DayContent[]> {
    let dayRows: DayRow[]
    let itemRows: ItemRow[]
    try {
      ;[dayRows, itemRows] = await Promise.all([this.driver.listDayRows(tripId), this.driver.listItemRows(tripId)])
    } catch {
      return []
    }
    if (!Array.isArray(dayRows)) return []

    const itemsByDay = new Map<string, ItemContent[]>()
    for (const row of Array.isArray(itemRows) ? itemRows : []) {
      const item = mapItemRow(row)
      if (item === null) continue
      const list = itemsByDay.get(item.dayId) ?? []
      list.push(item)
      itemsByDay.set(item.dayId, list)
    }
    for (const list of itemsByDay.values()) {
      list.sort((a, b) => a.itemOrder - b.itemOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    return dayRows
      .map((row) => mapDayRow(row, itemsByDay, tripId))
      .filter((day): day is DayContent => day !== null)
      .sort((a, b) => a.idx - b.idx || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /** Checklist entries of a trip, tolerant like everything here. */
  async listChecklist(tripId: string): Promise<ChecklistEntry[]> {
    let rows: ChecklistRow[]
    try {
      rows = await this.driver.listChecklistRows(tripId)
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows
      .map(mapChecklistRow)
      .filter((entry): entry is ChecklistEntry => entry !== null)
  }

  /**
   * Upsert one item. Fails with not_found when the target day does not
   * belong to the trip (checked before writing so a bad dayId never creates
   * an orphan row).
   */
  async upsertItem(tripId: string, input: Record<string, unknown>): Promise<ContentWriteResult> {
    const item = readItemUpsert(input)
    if (item === null) return { ok: false, error: '条目字段无效（需要 id、dayId、title）', code: 'invalid' }
    let dayExists: boolean
    try {
      dayExists = await this.driver.dayExists(tripId, item.dayId)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    if (!dayExists) return { ok: false, error: '日程不存在', code: 'not_found' }
    try {
      await this.driver.upsertItemRow(tripId, item)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true }
  }

  /** Upsert one checklist entry (idempotent by id). */
  async upsertChecklistEntry(tripId: string, input: Record<string, unknown>): Promise<ContentWriteResult> {
    const entry = readChecklistUpsert(input)
    if (entry === null) return { ok: false, error: '清单条目字段无效（需要 id 与 content）', code: 'invalid' }
    try {
      await this.driver.upsertChecklistRow(tripId, entry)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true }
  }
}

// ---------------------------------------------------------------------------
// Tolerant mapping helpers (corrupt values degrade, never throw)
// ---------------------------------------------------------------------------

function mapDayRow(row: DayRow, itemsByDay: Map<string, ItemContent[]>, tripId: string): DayContent | null {
  const id = asText(row?.id)
  if (!id) return null
  const idxNumber = Number(row?.idx)
  return {
    id,
    ...projectDayIdentity(row?.trip_id, row?.idx, tripId),
    ...readDayMetadata(row),
    idx: Number.isInteger(idxNumber) ? idxNumber : 0,
    date: asText(row?.date),
    theme: asText(row?.theme),
    color: asText(row?.color),
    items: itemsByDay.get(id) ?? [],
  }
}

function mapItemRow(row: ItemRow): ItemContent | null {
  const id = asText(row?.id)
  const dayId = asText(row?.day_id)
  if (!id || !dayId) return null
  const orderNumber = Number(row?.item_order)
  return {
    id,
    dayId,
    itemOrder: Number.isFinite(orderNumber) ? orderNumber : 0,
    type: asText(row?.type) || 'other',
    title: asText(row?.title),
    note: asText(row?.note),
    pending: row?.pending === 1 || row?.pending === true,
    ...(typeof row?.poi === 'string' && row.poi.trim() ? { poi: row.poi } : {}),
  }
}

function mapChecklistRow(row: ChecklistRow): ChecklistEntry | null {
  const id = asText(row?.id)
  if (!id) return null
  return {
    id,
    content: asText(row?.content),
    done: row?.done === 1 || row?.done === true,
    createdAt: asText(row?.created_at),
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return null
  return trimmed
}

/** Tolerant write-side coercion of an item payload; null = reject. */
function readItemUpsert(input: Record<string, unknown>): ItemUpsert | null {
  const id = readId(input.id)
  const dayId = readId(input.dayId)
  if (!id || !dayId) return null
  const orderNumber = Number(input.itemOrder)
  let poiJson: string | null = null
  if (input.poi !== undefined && input.poi !== null) {
    if (typeof input.poi !== 'object' || Array.isArray(input.poi)) return null
    try {
      poiJson = JSON.stringify(input.poi)
    } catch {
      return null
    }
  }
  return {
    id,
    dayId,
    itemOrder: Number.isFinite(orderNumber) ? Math.trunc(orderNumber) : 0,
    type: typeof input.type === 'string' && input.type.trim() ? input.type.trim() : 'other',
    title: typeof input.title === 'string' ? input.title : '',
    note: typeof input.note === 'string' ? input.note : '',
    poiJson,
    pending: input.pending === true || input.pending === 1,
  }
}

function readChecklistUpsert(input: Record<string, unknown>): ChecklistUpsert | null {
  const id = readId(input.id)
  if (!id) return null
  if (typeof input.content !== 'string' || !input.content.trim()) return null
  return { id, content: input.content, done: input.done === true || input.done === 1 }
}

export type { ContentErrorCode }
