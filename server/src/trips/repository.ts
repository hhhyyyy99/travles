/**
 * Trip repository (ticket 02) — validation + tolerant mapping over any
 * TripStoreDriver (spec 测试接缝 #2).
 *
 * Convention (mirrors src/domain/storage.ts):
 * - Reads NEVER throw: a failing driver, corrupt rows or missing fields
 *   degrade to empty lists / dropped entries / 0-day summaries.
 * - Writes return `{ok:true, trip} | {ok:false, error}` — the HTTP layer
 *   maps that to status codes; driver failures surface as '保存失败' /
 *   '删除失败', mirroring the codec's writeState.
 */
import { randomUUID } from 'node:crypto'
import { asText, asTimestamp, computeDaysNights, isValidDateString } from './dates.js'
import type {
  TripInsertRow,
  TripRow,
  TripStoreDriver,
  TripSummary,
  TripUpdate,
  TripMutationResult,
  TripWriteResult,
  TripPlanningContext,
} from './types.js'
import { parseTripIntake } from './intake.js'

export class TripRepository {
  constructor(private readonly driver: TripStoreDriver) {}

  /** List trips oldest-first. Corrupt rows (no usable id) are dropped. */
  async list(): Promise<TripSummary[]> {
    let rows: TripRow[]
    try {
      rows = await this.driver.listTripRows()
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows
      .map((row) => mapRowToSummary(row))
      .filter((trip): trip is TripSummary => trip !== null)
  }

  /** Single trip or null — never throws. */
  async get(id: string): Promise<TripSummary | null> {
    let row: TripRow | null
    try {
      row = await this.driver.getTripRow(id)
    } catch {
      return null
    }
    return row === null ? null : mapRowToSummary(row)
  }

  /** Create with title + start/end dates; days/nights computed from dates. */
  async create(input: TripUpdate): Promise<TripWriteResult> {
    const titleError = validateTitle(input.title)
    if (titleError) return { ok: false, error: titleError, code: 'invalid' }
    const dateError = validateDateRange(input.startDate, input.endDate)
    if (dateError) return { ok: false, error: dateError, code: 'invalid' }

    const now = new Date().toISOString()
    const row: TripInsertRow = {
      id: randomUUID(),
      title: (input.title as string).trim(),
      start_date: input.startDate as string,
      end_date: input.endDate as string,
      created_at: now,
      updated_at: now,
      planning_context: null,
    }
    try {
      await this.driver.insertTripRow(row)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, trip: mapRowToSummary(row) as TripSummary }
  }

  /** Create a private date-pending draft from one destination/duration sentence. */
  async createFromIntake(input: { sentence?: unknown }): Promise<TripWriteResult> {
    const parsed = parseTripIntake(input.sentence)
    if (!parsed.ok) return { ok: false, error: parsed.error, code: 'invalid' }
    const now = new Date().toISOString()
    const row: TripInsertRow = {
      id: randomUUID(),
      title: parsed.value.title,
      start_date: parsed.value.startDate,
      end_date: parsed.value.endDate,
      planning_context: JSON.stringify(parsed.value.context),
      created_at: now,
      updated_at: now,
    }
    try {
      await this.driver.insertTripRow(row)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, trip: mapRowToSummary(row) as TripSummary }
  }

  /** Rename (title only) — keeps dates. */
  async rename(id: string, title: unknown): Promise<TripWriteResult> {
    return this.update(id, { title })
  }

  /** Partial update (title / startDate / endDate). */
  async update(id: string, patch: TripUpdate): Promise<TripWriteResult> {
    let current: TripRow | null
    try {
      current = await this.driver.getTripRow(id)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    if (current === null) return { ok: false, error: '行程不存在', code: 'not_found' }
    const existing = mapRowToSummary(current)
    if (existing === null) return { ok: false, error: '行程不存在', code: 'not_found' }

    const nextTitle = patch.title === undefined ? existing.title : patch.title
    const titleError = validateTitle(nextTitle)
    if (titleError) return { ok: false, error: titleError, code: 'invalid' }

    const nextStart = patch.startDate === undefined ? existing.startDate : patch.startDate
    const nextEnd = patch.endDate === undefined ? existing.endDate : patch.endDate
    const keepDatePending = Boolean(
      existing.planningContext &&
        patch.startDate === undefined &&
        patch.endDate === undefined &&
        existing.startDate === '' &&
        existing.endDate === '',
    )
    const dateError = keepDatePending ? null : validateDateRange(nextStart, nextEnd)
    if (dateError) return { ok: false, error: dateError, code: 'invalid' }

    const updatedAt = new Date().toISOString()
    const nextPlanningContext = existing.planningContext
      ? isValidDateString(nextStart) && isValidDateString(nextEnd)
        ? { ...existing.planningContext, dateStatus: 'confirmed' as const, datePhrase: `${nextStart} 至 ${nextEnd}` }
        : existing.planningContext
      : undefined
    try {
      const updated = await this.driver.updateTripRow(id, {
        title: (nextTitle as string).trim(),
        startDate: nextStart as string,
        endDate: nextEnd as string,
        updatedAt,
        planningContext: nextPlanningContext ? JSON.stringify(nextPlanningContext) : null,
      })
      if (!updated) return { ok: false, error: '行程不存在', code: 'not_found' }
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }

    return {
      ok: true,
      trip: {
        ...existing,
        title: (nextTitle as string).trim(),
        startDate: nextStart as string,
        endDate: nextEnd as string,
        ...computeDaysNights(nextStart as string, nextEnd as string),
        updatedAt,
        ...(nextPlanningContext
          ? { durationDays: nextPlanningContext.durationDays, dateStatus: nextPlanningContext.dateStatus, planningContext: nextPlanningContext }
          : {}),
      },
    }
  }

  /** Delete; child tables (days/items/…) cascade via FK. */
  async remove(id: string): Promise<TripMutationResult> {
    try {
      const deleted = await this.driver.deleteTripRow(id)
      if (!deleted) return { ok: false, error: '行程不存在', code: 'not_found' }
      return { ok: true }
    } catch {
      return { ok: false, error: '删除失败', code: 'storage' }
    }
  }
}

/** 容错 row → summary mapping; null = unusable row (dropped from lists). */
export function mapRowToSummary(row: TripRow): TripSummary | null {
  const id = asText(row?.id)
  if (!id) return null
  const startDate = asText(row?.start_date)
  const endDate = asText(row?.end_date)
  const context = mapPlanningContext(row?.planning_context)
  return {
    id,
    title: asText(row?.title),
    startDate,
    endDate,
    ...computeDaysNights(startDate, endDate),
    createdAt: asTimestamp(row?.created_at),
    updatedAt: asTimestamp(row?.updated_at),
    ...(context ? { durationDays: context.durationDays, dateStatus: context.dateStatus, planningContext: context } : {}),
  }
}

function mapPlanningContext(value: unknown): TripPlanningContext | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const record = JSON.parse(value) as Record<string, unknown>
    const destination = typeof record.destination === 'string' ? record.destination.trim() : ''
    const originalSentence = typeof record.originalSentence === 'string' ? record.originalSentence.trim() : ''
    const preferences = typeof record.preferences === 'string' ? record.preferences.trim() : ''
    const durationDays = Number(record.durationDays)
    const dateStatus = record.dateStatus
    if (!destination || !originalSentence || !preferences || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 60) return null
    if (dateStatus !== 'confirmed' && dateStatus !== 'unspecified' && dateStatus !== 'tentative') return null
    const datePhrase = typeof record.datePhrase === 'string' && record.datePhrase.trim() ? record.datePhrase.trim() : undefined
    return { destination, durationDays, preferences, originalSentence, dateStatus, ...(datePhrase ? { datePhrase } : {}) }
  } catch {
    return null
  }
}

function validateTitle(title: unknown): string | null {
  if (typeof title !== 'string' || title.trim().length === 0) return '行程标题不能为空'
  if (title.trim().length > 100) return '行程标题过长（最多 100 字）'
  return null
}

function validateDateRange(startDate: unknown, endDate: unknown): string | null {
  if (!isValidDateString(startDate)) return '开始日期无效（需要 YYYY-MM-DD）'
  if (!isValidDateString(endDate)) return '结束日期无效（需要 YYYY-MM-DD）'
  if ((endDate as string) < (startDate as string)) return '结束日期不能早于开始日期'
  return null
}
