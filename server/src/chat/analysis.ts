/**
 * Deterministic guardrails used by the chat route before a planner turn.
 *
 * The model still owns the natural-language explanation, but these checks keep
 * two safety boundaries from depending on a model remembering a hidden rule:
 * date/day contradictions are surfaced before a patch can land, and long
 * stored drive legs are passed back as structured warnings.
 */
import type { LegRow, ItemRow } from '../days/types.js'
import type { RoundWarning } from './round-meta.js'

export const LONG_DRIVE_LIMIT_MINUTES = 6 * 60

export type TimeConstraintConflict = {
  message: string
  suggestion: string
}

type TripDateShape = {
  startDate?: string
  endDate?: string
  days?: number
}

/**
 * Find the date-span contradiction called out in the PRD. The parser accepts
 * both `10/2-10/5` and `10月2日到10月5日`, plus an explicit `7天` statement.
 * It intentionally returns no result when a date cannot be understood.
 */
export function detectTimeConstraintConflicts(
  content: string,
  trip: TripDateShape | null = null,
): TimeConstraintConflict[] {
  const text = typeof content === 'string' ? content : ''
  const requestedDays = firstNumber(text.match(/(?:共|玩|计划|安排|行程)?\s*(\d{1,2})\s*天/))
  const range = readDateRange(text)
  const conflicts: TimeConstraintConflict[] = []

  if (requestedDays !== null && range !== null) {
    const span = inclusiveDaySpan(range[0], range[1])
    if (span !== null && requestedDays !== span) {
      conflicts.push({
        message: `你说要安排 ${requestedDays} 天，但 ${range[0]} 至 ${range[1]} 只有 ${span} 天，时间约束相互矛盾。`,
        suggestion: '请选择调整日期范围，或把行程天数改成与日期一致后再重排。',
      })
    }
  }

  if (trip?.startDate && trip.endDate && requestedDays !== null) {
    const span = inclusiveDaySpan(trip.startDate, trip.endDate)
    if (span !== null && requestedDays !== span) {
      conflicts.push({
        message: `当前行程日期 ${trip.startDate} 至 ${trip.endDate} 是 ${span} 天，但本次要求 ${requestedDays} 天，不能静默选择其中一个。`,
        suggestion: '请确认是延长日期，还是缩短行程天数。',
      })
    }
  }

  if (trip?.days !== undefined && Number.isFinite(trip.days) && requestedDays !== null && trip.days !== requestedDays) {
    conflicts.push({
      message: `当前计划有 ${trip.days} 天，本次要求 ${requestedDays} 天，日期与天数需要先对齐。`,
      suggestion: '请选择保留当前天数，或确认按新的天数重排。',
    })
  }

  return dedupeConflicts(conflicts)
}

/** Convert stored leg rows into warnings the round metadata can carry. */
export function longDriveWarnings(legs: LegRow[], items: ItemRow[]): RoundWarning[] {
  const titles = new Map<string, string>()
  for (const row of Array.isArray(items) ? items : []) {
    const id = text(row?.id)
    if (!id) continue
    titles.set(id, text(row?.title) || id)
  }

  const warnings: RoundWarning[] = []
  for (const leg of Array.isArray(legs) ? legs : []) {
    if (text(leg?.mode) !== '' && text(leg?.mode) !== 'drive') continue
    const durationMin = number(leg?.duration_min)
    if (durationMin <= LONG_DRIVE_LIMIT_MINUTES) continue
    const from = titles.get(text(leg?.from_item_id)) || text(leg?.from_item_id) || '上一站'
    const to = titles.get(text(leg?.to_item_id)) || text(leg?.to_item_id) || '下一站'
    warnings.push({
      kind: 'long-drive',
      title: '长途驾驶警示',
      message: `${from} → ${to} 预计驾驶 ${formatHours(durationMin)}，超过 6 小时。`,
      suggestion: '建议拆成两段，增加中途休息或过夜点，再继续规划。',
      from,
      to,
      durationMin,
    })
  }
  return warnings
}

export function warningAsText(warning: RoundWarning): string {
  return warning.suggestion ? `${warning.message} ${warning.suggestion}` : warning.message
}

function readDateRange(content: string): [string, string] | null {
  const iso = content.match(/(\d{4}-\d{1,2}-\d{1,2}).{0,16}?(?:至|到|[-~至到]).{0,16}?(\d{4}-\d{1,2}-\d{1,2})/)
  if (iso) return normalizeDatePair(iso[1], iso[2])
  const short = content.match(/(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?\s*(?:至|到|[-~])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?/)
  if (short) {
    const year = new Date().getUTCFullYear()
    return normalizeDatePair(`${year}-${short[1]}-${short[2]}`, `${year}-${short[3]}-${short[4]}`)
  }
  return null
}

function normalizeDatePair(first: string | undefined, second: string | undefined): [string, string] | null {
  if (!first || !second) return null
  const a = toIsoDate(first)
  const b = toIsoDate(second)
  if (!a || !b) return null
  return a <= b ? [a, b] : [b, a]
}

function toIsoDate(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.toISOString().slice(0, 10)
}

function inclusiveDaySpan(first: string, second: string): number | null {
  const a = Date.parse(`${first}T00:00:00Z`)
  const b = Date.parse(`${second}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return Math.round((b - a) / 86_400_000) + 1
}

function firstNumber(match: RegExpMatchArray | null): number | null {
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

function dedupeConflicts(conflicts: TimeConstraintConflict[]): TimeConstraintConflict[] {
  const seen = new Set<string>()
  return conflicts.filter((conflict) => {
    if (seen.has(conflict.message)) return false
    seen.add(conflict.message)
    return true
  })
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(result) && result >= 0 ? result : 0
}

function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}
