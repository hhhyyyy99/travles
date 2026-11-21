/**
 * Deterministic guardrails used by the chat route before a planner turn.
 *
 * The model still owns the natural-language explanation, but these checks keep
 * two safety boundaries from depending on a model remembering a hidden rule:
 * date/day contradictions are surfaced before a patch can land, and long
 * stored or cross-day drive estimates are passed back as structured warnings.
 */
import { GeographicCheckSchema, type GeographicCheck } from '@hailar/domain'
import { mapPoiRef } from '../days/repository.js'
import type { DayRow, LegRow, ItemRow, PoiRef } from '../days/types.js'
import { estimateLeg } from '../items-admin/legs.js'
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
 * Identify requests that can rewrite an existing itinerary. The planner is
 * still the source of truth for the final intent, but this conservative
 * classifier keeps ordinary questions on the qa path while putting explicit
 * edits behind the patch-explain confirmation step.
 */
export function isModificationRequest(content: string): boolean {
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text) return false
  return [
    /(?:修改|改一下|改成|改为|改到|更换|换成|替换|重排|重新安排|重新规划|重新生成|再排|再安排|重做|调整|移动|挪到|删除|删掉|取消|去掉|移除|增加|添加|插入|减少|缩短|延长|压缩|优化)/,
    /(?:改住|换住|改航班|换航班|改日期|换酒店|换住宿)/,
    /(?:把|将).{0,48}(?:改|换|调|移|删|加|减|放|住)/,
    /(?:不要|别).{0,32}(?:住|去|保留|安排|经过|停留)/,
  ].some((pattern) => pattern.test(text))
}

/** Requests that carry schedule constraints even when they are not edits. */
export function isScheduleRequest(content: string): boolean {
  const text = typeof content === 'string' ? content.trim() : ''
  return isModificationRequest(text) || /(?:规划|计划|安排|行程|路线|自驾|酒店|住宿|航班|日期|天数|几天|出发|返程|抵达|到达)/.test(text)
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
  const range = readDateRange(text, trip?.startDate?.slice(0, 4))
  const conflicts: TimeConstraintConflict[] = []

  if (range !== null) {
    if (range.reversed) {
      conflicts.push({
        message: `日期范围 ${range.start} 至 ${range.end} 的结束时间早于开始时间，时间约束相互矛盾。`,
        suggestion: '请把结束日期调到开始日期之后，再继续重排。',
      })
    } else if (requestedDays !== null) {
      const span = inclusiveDaySpan(range.start, range.end)
      if (span !== null && requestedDays !== span) {
        conflicts.push({
          message: `你说要安排 ${requestedDays} 天，但 ${range.start} 至 ${range.end} 只有 ${span} 天，时间约束相互矛盾。`,
          suggestion: '请选择调整日期范围，或把行程天数改成与日期一致后再重排。',
        })
      }
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

  conflicts.push(...detectTimeOrderingConflicts(text, trip?.startDate?.slice(0, 4)))
  return dedupeConflicts(conflicts)
}

type ParsedDateRange = {
  start: string
  end: string
  reversed: boolean
}

type TimeMarker = {
  date: string
  minutes: number
  label: string
  kind: 'arrival' | 'departure'
  position: number
}

/**
 * Detect impossible same-day arrival/departure ordering when the user gives
 * explicit times. We only compare adjacent opposing events in the text, so
 * unrelated times in a packing or weather question do not become conflicts.
 */
function detectTimeOrderingConflicts(content: string, yearHint?: string): TimeConstraintConflict[] {
  const markers = readTimeMarkers(content, yearHint)
  const conflicts: TimeConstraintConflict[] = []
  for (let index = 1; index < markers.length; index += 1) {
    const previous = markers[index - 1]
    const current = markers[index]
    if (!previous || !current || previous.date !== current.date || previous.kind === current.kind) continue
    const impossible = previous.minutes >= current.minutes
    if (!impossible) continue
    const first = previous.kind === 'departure' ? '出发' : '抵达'
    const second = current.kind === 'departure' ? '出发' : '抵达'
    conflicts.push({
      message: `${previous.date} 的${first}时间 ${previous.label} 晚于或等于${second}时间 ${current.label}，时间约束相互矛盾。`,
      suggestion: '请调整抵离时间，至少为两段安排出可行的先后顺序。',
    })
  }
  return conflicts
}

function readTimeMarkers(content: string, yearHint?: string): TimeMarker[] {
  const markers: TimeMarker[] = []
  const seen = new Set<string>()
  const addMarker = (
    position: number,
    dateToken: string | undefined,
    timeToken: string,
    eventToken: string,
  ): void => {
    const kind = /到达|抵达|落地|入住/.test(eventToken) ? 'arrival' : 'departure'
    const minutes = parseTime(timeToken)
    if (minutes === null) return
    const date = parseMarkerDate(dateToken, yearHint) ?? dateBefore(content, position, yearHint) ?? '__same-day__'
    const key = `${position}|${kind}|${date}|${minutes}`
    if (seen.has(key)) return
    seen.add(key)
    markers.push({ date, minutes, label: formatClock(minutes), kind, position })
  }

  const timeBeforeEvent = /(?:(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}(?:日|号)?)\s*)?(\d{1,2}[:：]\d{2}|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)\s*(到达|抵达|落地|入住|出发|离开|返程|起飞|赶飞机)/g
  for (const match of content.matchAll(timeBeforeEvent)) {
    const position = match.index ?? 0
    addMarker(position, match[1], match[2] ?? '', match[3] ?? '')
  }

  const eventBeforeTime = /(?:(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}(?:日|号)?)\s*)?(到达|抵达|落地|入住|出发|离开|返程|起飞|赶飞机)\s*(?:时间|于)?\s*(\d{1,2}[:：]\d{2}|凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)/g
  for (const match of content.matchAll(eventBeforeTime)) {
    const position = match.index ?? 0
    addMarker(position, match[1], match[3] ?? '', match[2] ?? '')
  }
  return markers.sort((a, b) => a.position - b.position)
}

function parseTime(value: string): number | null {
  const clock = value.match(/^(\d{1,2})[:：](\d{2})$/)
  if (clock) {
    const hours = Number(clock[1])
    const minutes = Number(clock[2])
    if (hours <= 23 && minutes <= 59) return hours * 60 + minutes
    return null
  }
  const periods: Record<string, number> = {
    凌晨: 3 * 60,
    早上: 8 * 60,
    上午: 9 * 60,
    中午: 12 * 60,
    下午: 15 * 60,
    傍晚: 18 * 60,
    晚上: 20 * 60,
    夜里: 22 * 60,
  }
  return periods[value] ?? null
}

function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function parseMarkerDate(value: string | undefined, yearHint?: string): string | null {
  if (!value) return null
  if (/^\d{4}-/.test(value)) return toIsoDate(value)
  const match = value.match(/^(\d{1,2})(?:月|[./-])(\d{1,2})(?:日|号)?$/)
  if (!match) return null
  return toIsoDate(`${yearHint ?? new Date().getUTCFullYear()}-${match[1]}-${match[2]}`)
}

function dateBefore(content: string, position: number, yearHint?: string): string | null {
  const datePattern = /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}(?:月|[./-])\d{1,2}(?:日|号)?/g
  let found: string | null = null
  for (const match of content.matchAll(datePattern)) {
    if ((match.index ?? 0) >= position) break
    const token = match[0]
    const full = /^\d{4}-/.test(token)
      ? token
      : `${yearHint ?? new Date().getUTCFullYear()}-${token
          .replace(/[日号]/, '')
          .replace('月', '-')
          .replace(/[./-]/, '-')}`
    found = toIsoDate(full) ?? found
  }
  return found
}

function readDateRange(content: string, yearHint?: string): ParsedDateRange | null {
  const iso = content.match(/(\d{4}-\d{1,2}-\d{1,2}).{0,16}?(?:至|到|[-~至到]).{0,16}?(\d{4}-\d{1,2}-\d{1,2})/)
  if (iso) return normalizeDatePair(iso[1], iso[2])
  const short = content.match(/(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?\s*(?:至|到|[-~])\s*(\d{1,2})\s*(?:月|[./-])\s*(\d{1,2})\s*(?:日|号)?/)
  if (short) {
    const year = yearHint ?? String(new Date().getUTCFullYear())
    return normalizeDatePair(`${year}-${short[1]}-${short[2]}`, `${year}-${short[3]}-${short[4]}`)
  }
  return null
}

function normalizeDatePair(first: string | undefined, second: string | undefined): ParsedDateRange | null {
  if (!first || !second) return null
  const a = toIsoDate(first)
  const b = toIsoDate(second)
  if (!a || !b) return null
  return { start: a, end: b, reversed: b < a }
}

export type ItineraryGeography = { checks: GeographicCheck[]; warnings: RoundWarning[] }

/** Convert stored and cross-day drive rows into warnings the round metadata can carry. */
export function longDriveWarnings(legs: LegRow[], items: ItemRow[], days: DayRow[] = []): RoundWarning[] {
  return analyzeItineraryGeography(legs, items, days).warnings
}

export function analyzeItineraryGeography(legs: LegRow[], items: ItemRow[], days: DayRow[]): ItineraryGeography {
  const titles = new Map<string, string>()
  for (const row of Array.isArray(items) ? items : []) {
    const id = text(row?.id)
    if (!id) continue
    titles.set(id, text(row?.title) || id)
  }

  const warnings: RoundWarning[] = []
  const checks: GeographicCheck[] = []
  const storedPairs = new Set<string>()
  for (const leg of Array.isArray(legs) ? legs : []) {
    const fromItemId = text(leg?.from_item_id)
    const toItemId = text(leg?.to_item_id)
    if (fromItemId && toItemId) storedPairs.add(`${fromItemId}|${toItemId}`)
    const mode = text(leg?.mode).toLowerCase()
    if (mode !== '' && !['drive', 'driving', 'car', '驾车', '自驾'].includes(mode)) continue
    const durationMin = number(leg?.duration_min)
    const from = titles.get(fromItemId) || fromItemId || '上一站'
    const to = titles.get(toItemId) || toItemId || '下一站'
    const estimated = leg?.quality !== 'measured' || typeof leg.duration_min !== 'number'
    if (fromItemId && toItemId && leg?.quality !== 'pending' && (durationMin > 0 || (!estimated && leg.duration_min === 0))) {
      const parsed = GeographicCheckSchema.safeParse({ from, to, durationMin, source: 'itinerary', estimated })
      if (parsed.success) checks.push(parsed.data)
    }
    if (durationMin <= LONG_DRIVE_LIMIT_MINUTES) continue
    warnings.push({
      kind: 'long-drive',
      title: '长途驾驶警示',
      message: `${from} → ${to} 预计驾驶 ${formatHours(durationMin)}，超过 6 小时。`,
      suggestion: '建议拆成两段，增加中途休息或过夜点，再继续规划。',
      from,
      to,
      durationMin,
      ...(estimated ? { estimated: true } : {}),
    })
  }
  const crossDayWarnings = crossDayLongDriveWarnings(days, items, storedPairs)
  for (const warning of crossDayWarnings) {
    const parsed = GeographicCheckSchema.safeParse({ ...warning, source: 'itinerary', estimated: true })
    if (parsed.success) checks.push(parsed.data)
  }
  return { checks, warnings: [...warnings, ...crossDayWarnings] }
}

function pairKey(from: string, to: string): string {
  return JSON.stringify([from.trim(), to.trim()])
}

/** Use stored durations for matching model pairs, and otherwise report known long drives. */
export function mergeGeographicChecks(
  itineraryChecks: GeographicCheck[],
  modelChecks: GeographicCheck[],
  routeChecks: GeographicCheck[],
): GeographicCheck[] {
  const routeByPair = new Map(routeChecks.map((check) => [pairKey(check.from, check.to), check]))
  const modelByPair = new Map(modelChecks.map((check) => [pairKey(check.from, check.to), check]))
  for (const key of routeByPair.keys()) modelByPair.delete(key)
  const itinerary = itineraryChecks.filter((check) => {
    const key = pairKey(check.from, check.to)
    if (routeByPair.has(key)) return false
    const matched = modelByPair.delete(key)
    return matched || check.durationMin > LONG_DRIVE_LIMIT_MINUTES
  })
  return [...itinerary, ...routeByPair.values(), ...modelByPair.values()]
}

export function dropSupersededDriveWarnings(warnings: RoundWarning[], checks: GeographicCheck[]): RoundWarning[] {
  const pairs = new Set(checks.map(({ from, to }) => pairKey(from, to)))
  return warnings.filter(({ kind, from, to }) => kind !== 'long-drive' || !from || !to || !pairs.has(pairKey(from, to)))
}

export function reportedDriveWarnings(checks: GeographicCheck[]): RoundWarning[] {
  return checks
    .filter((check) => check.source !== 'itinerary' && check.durationMin > LONG_DRIVE_LIMIT_MINUTES)
    .map(({ from, to, durationMin, source, estimated }) => ({
      kind: 'long-drive',
      title: source === 'amap' ? '长途驾驶提示 · 高德路线' : '长途驾驶提示 · AI 估算',
      message: `${from} → ${to} 预计驾驶 ${formatHours(durationMin)}，超过 6 小时。`,
      suggestion: '请核对实际路况，可考虑拆成两段并安排休息。',
      from,
      to,
      durationMin,
      estimated,
    }))
}

/**
 * Derive a warning for a day boundary when the adjacency-leg pipeline skips
 * cross-day pairs. The estimate is deliberately conservative and labelled as
 * unverified: it is based on POI coordinates, not a road-service response.
 */
export function crossDayLongDriveWarnings(
  days: DayRow[],
  items: ItemRow[],
  storedPairs: ReadonlySet<string> = new Set(),
): RoundWarning[] {
  const orderedDays = (Array.isArray(days) ? days : [])
    .map((row, sourceIndex) => ({ id: text(row?.id), index: integer(row?.idx), sourceIndex }))
    .filter((entry) => entry.id !== '' && entry.index >= 0)
    .sort((a, b) => a.index - b.index || a.sourceIndex - b.sourceIndex || a.id.localeCompare(b.id))
  const itemsByDay = new Map<string, OrderedPoiItem[]>()
  for (const [sourceIndex, row] of (Array.isArray(items) ? items : []).entries()) {
    const id = text(row?.id)
    const dayId = text(row?.day_id)
    if (!id || !dayId) continue
    const entry = {
      id,
      order: number(row?.item_order),
      sourceIndex,
      title: text(row?.title) || id,
      poi: mapPoiRef(row?.poi),
    }
    const bucket = itemsByDay.get(dayId)
    if (bucket) bucket.push(entry)
    else itemsByDay.set(dayId, [entry])
  }
  for (const bucket of itemsByDay.values()) {
    bucket.sort((a, b) => a.order - b.order || a.sourceIndex - b.sourceIndex || a.id.localeCompare(b.id))
  }

  const warnings: RoundWarning[] = []
  for (let index = 0; index + 1 < orderedDays.length; index += 1) {
    const currentDay = orderedDays[index]
    const nextDay = orderedDays[index + 1]
    if (!currentDay || !nextDay || nextDay.index !== currentDay.index + 1) continue
    const from = lastPoi(itemsByDay.get(currentDay.id) ?? [])
    const to = firstPoi(itemsByDay.get(nextDay.id) ?? [])
    if (!from || !to || storedPairs.has(`${from.id}|${to.id}`)) continue
    const estimate = estimateLeg(from.poi, to.poi)
    if (!estimate || estimate.durationMin <= LONG_DRIVE_LIMIT_MINUTES) continue
    warnings.push({
      kind: 'long-drive',
      title: '跨天长途驾驶估算',
      message: `${from.title} → ${to.title}（跨天）按坐标估算驾驶 ${formatHours(estimate.durationMin)}，超过 6 小时。`,
      suggestion: '这是坐标估算，未核实实际路况；建议拆成两段，增加中途休息或过夜点，再继续规划。',
      from: from.title,
      to: to.title,
      durationMin: estimate.durationMin,
      estimated: true,
    })
  }
  return warnings
}

type OrderedPoiItem = {
  id: string
  order: number
  sourceIndex: number
  title: string
  poi: PoiRef | null
}

function firstPoi(items: OrderedPoiItem[]): OrderedPoiItem | null {
  return items.find((item) => item.poi !== null) ?? null
}

function lastPoi(items: OrderedPoiItem[]): OrderedPoiItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item !== undefined && item.poi !== null) return item
  }
  return null
}

export function warningAsText(warning: RoundWarning): string {
  return warning.suggestion ? `${warning.message} ${warning.suggestion}` : warning.message
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

function integer(value: unknown): number {
  const result = Number(value)
  return Number.isInteger(result) && result >= 0 ? result : -1
}

function formatHours(minutes: number): string {
  const roundedMinutes = Math.ceil(minutes)
  const hours = Math.floor(roundedMinutes / 60)
  const rest = roundedMinutes % 60
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
}
