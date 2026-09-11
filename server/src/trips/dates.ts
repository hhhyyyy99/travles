/**
 * Trip date helpers (ticket 02). Pure functions, tolerant: unusable dates
 * never throw, they degrade to 0-day summaries so a corrupt row can still be
 * listed (容错读取 convention).
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Strict write-side check: YYYY-MM-DD and a real calendar date. */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const utc = new Date(Date.UTC(year, month - 1, day))
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Inclusive day count from a date range. Invalid or reversed ranges → 0
 * (never throws, never negative).
 */
export function computeDaysNights(
  startDate: string,
  endDate: string,
): { days: number; nights: number } {
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) return { days: 0, nights: 0 }
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { days: 0, nights: 0 }
  const days = Math.round((end - start) / DAY_MS) + 1
  return { days, nights: days - 1 }
}

/** Tolerant read-side coercion: anything non-string degrades to ''. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Tolerant read-side timestamp coercion: ISO strings and epoch numbers kept. */
export function asTimestamp(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString()
  }
  return ''
}
