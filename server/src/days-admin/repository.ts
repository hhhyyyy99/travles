/**
 * Days-admin repository (ticket 10) — validation + tolerant mapping over any
 * DaysAdminStoreDriver (spec 测试接缝 #2), mirroring TripRepository /
 * TripContentRepository.
 *
 * Convention (容错读取、永不 throw):
 * - Driver failures surface as {ok:false, error:'保存失败'/'删除失败',
 *   code:'storage'} — never a thrown error out of the repository.
 * - createDay derives `idx` (max + 1) and `date` (latest dated day + 1, or
 *   '' when the trip has no dated days) so callers can add a day with no
 *   payload at all; an explicit `date` must be a real YYYY-MM-DD.
 */
import { randomUUID } from 'node:crypto'
import { isValidDateString } from '../trips/dates.js'
import { projectDayIdentity } from '../days/projections.js'
import type { DayRow } from '../days/types.js'
import type {
  AdminDay,
  DayDeleteResult,
  DayInsert,
  DaysAdminErrorCode,
  DaysAdminStoreDriver,
  DayThemeInput,
  DayThemePatch,
  DayWriteResult,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_THEME_LENGTH = 200
const MAX_COLOR_LENGTH = 32

export class DaysAdminRepository {
  constructor(private readonly driver: DaysAdminStoreDriver) {}

  /** Re-read the authoritative day after schedule synchronization changes idx/date. */
  async getDay(tripId: string, dayId: string): Promise<DayWriteResult> {
    let row: DayRow | null
    try {
      row = await this.driver.getDayRow(dayId)
    } catch {
      return { ok: false, error: '读取日程失败', code: 'storage' }
    }
    if (!row || asText(row.id) !== dayId || asText(row.trip_id) !== tripId) {
      return { ok: false, error: '日程不存在', code: 'not_found' }
    }
    return { ok: true, day: mapAdminDay(row, tripId) }
  }

  /**
   * Append a day to the trip. With no payload the new day lands after the
   * current last day (idx = max+1, date = latest date + 1 calendar day or
   * '' when the trip has no usable dates yet).
   */
  async createDay(
    tripId: string,
    input: { date?: unknown; theme?: unknown; color?: unknown } = {},
  ): Promise<DayWriteResult> {
    let rows: DayRow[]
    try {
      rows = await this.driver.listDayRows(tripId)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    if (!Array.isArray(rows)) rows = []

    let date: string
    if (input.date === undefined) {
      date = nextDateAfter(rows)
    } else if (typeof input.date === 'string' && isValidDateString(input.date)) {
      date = input.date
    } else {
      return { ok: false, error: '日期格式无效（需要 YYYY-MM-DD）', code: 'invalid' }
    }

    const themeResult = readTextField(input.theme, MAX_THEME_LENGTH, '主题')
    if (!themeResult.ok) return themeResult
    const colorResult = readTextField(input.color, MAX_COLOR_LENGTH, '颜色')
    if (!colorResult.ok) return colorResult

    const row: DayInsert = {
      id: randomUUID(),
      tripId,
      idx: nextIndexAfter(rows),
      date,
      theme: themeResult.value,
      color: colorResult.value,
    }
    try {
      await this.driver.insertDayRow(row)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, day: mapAdminDay(row, tripId) }
  }

  /** Update a day's theme and/or color. Unknown day / foreign trip → not_found. */
  async updateDay(tripId: string, dayId: string, patch: DayThemeInput): Promise<DayWriteResult> {
    let row: DayRow | null
    try {
      row = await this.driver.getDayRow(dayId)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    if (!row || asText(row?.id) !== dayId || asText(row?.trip_id) !== tripId) {
      return { ok: false, error: '日程不存在', code: 'not_found' }
    }

    const nextPatch: DayThemePatch = {}
    if (patch.theme !== undefined) {
      const themeResult = readTextField(patch.theme, MAX_THEME_LENGTH, '主题')
      if (!themeResult.ok) return themeResult
      nextPatch.theme = themeResult.value
    }
    if (patch.color !== undefined) {
      const colorResult = readTextField(patch.color, MAX_COLOR_LENGTH, '颜色')
      if (!colorResult.ok) return colorResult
      nextPatch.color = colorResult.value
    }
    if (nextPatch.theme === undefined && nextPatch.color === undefined) {
      return { ok: false, error: '没有可更新的字段', code: 'invalid' }
    }

    try {
      await this.driver.updateDayRow(dayId, nextPatch)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return {
      ok: true,
      day: mapAdminDay({
        ...row,
        theme: nextPatch.theme ?? row.theme,
        color: nextPatch.color ?? row.color,
      }, tripId),
    }
  }

  /**
   * Delete a day together with its items and the legs that reference those
   * items. `removedItems` reports how many cards went away with the day.
   */
  async deleteDay(tripId: string, dayId: string): Promise<DayDeleteResult> {
    let row: DayRow | null
    try {
      row = await this.driver.getDayRow(dayId)
    } catch {
      return { ok: false, error: '删除失败', code: 'storage' }
    }
    if (!row || asText(row?.id) !== dayId || asText(row?.trip_id) !== tripId) {
      return { ok: false, error: '日程不存在', code: 'not_found' }
    }

    let removedItems = 0
    try {
      const itemIds = await this.driver.listItemIdsForDay(dayId)
      removedItems = Array.isArray(itemIds) ? itemIds.length : 0
      await this.driver.deleteLegsForDay(dayId)
      await this.driver.deleteItemsForDay(dayId)
      await this.driver.deleteDayRow(dayId)
    } catch {
      return { ok: false, error: '删除失败', code: 'storage' }
    }
    return { ok: true, removedItems }
  }
}

// ---------------------------------------------------------------------------
// Tolerant helpers (degrade, never throw)
// ---------------------------------------------------------------------------

/** 容错 row → AdminDay (canvas-day shape with an empty items list). */
function mapAdminDay(row: DayInsert | DayRow, tripId: string): AdminDay {
  const source = row as unknown as Record<string, unknown>
  return {
    id: typeof source.id === 'string' ? source.id : '',
    ...projectDayIdentity('tripId' in source ? source.tripId : source.trip_id, source.idx, tripId),
    index: nextIndexFrom(source.idx),
    date: typeof source.date === 'string' ? source.date : '',
    theme: typeof source.theme === 'string' ? source.theme : '',
    color: typeof source.color === 'string' ? source.color : '',
    items: [],
  }
}

function nextIndexAfter(rows: DayRow[]): number {
  let max = -1
  for (const row of rows) {
    max = Math.max(max, nextIndexFrom((row as unknown as Record<string, unknown> | null)?.idx))
  }
  return max + 1
}

function nextIndexFrom(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(num) && num >= 0 ? num : 0
}

/** Latest valid YYYY-MM-DD on the trip + 1 day; '' when no dated day exists. */
function nextDateAfter(rows: DayRow[]): string {
  let max: string | null = null
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown> | null
    const date = typeof record?.date === 'string' ? record.date : ''
    if (isValidDateString(date) && (max === null || date > max)) max = date
  }
  if (max === null) return ''
  const next = new Date(Date.parse(`${max}T00:00:00Z`) + DAY_MS)
  return Number.isFinite(next.getTime()) ? next.toISOString().slice(0, 10) : ''
}

/** Optional string field: absent → '', present-but-not-string / too long → reject. */
function readTextField(
  value: unknown,
  maxLength: number,
  label: string,
): { ok: true; value: string } | { ok: false; error: string; code: DaysAdminErrorCode } {
  if (value === undefined) return { ok: true, value: '' }
  if (typeof value !== 'string') return { ok: false, error: `${label}必须是字符串`, code: 'invalid' }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) return { ok: false, error: `${label}过长（最多 ${maxLength} 字）`, code: 'invalid' }
  return { ok: true, value: trimmed }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
