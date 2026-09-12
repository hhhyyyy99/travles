import { isValidDateString } from './dates.js'
import type { TripDateStatus, TripPlanningContext } from './types.js'

export type ParsedTripIntake = {
  title: string
  startDate: string
  endDate: string
  context: TripPlanningContext
}

export type TripIntakeError = { ok: false; error: string } | { ok: true; value: ParsedTripIntake }

const DURATION_PATTERN = /(\d{1,2}|[一二三四五六七八九十百]+)\s*(?:天|日)/
const DATE_PATTERN = /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g
const TENTATIVE_DATE_PATTERN = /国庆|暑假|寒假|周末|下周|本周|月底|月初|\d{1,2}\s*月|[一二三四五六七八九十]+月/

/** Parse only the minimum fields needed to preserve a one-sentence draft. */
export function parseTripIntake(sentence: unknown): TripIntakeError {
  if (typeof sentence !== 'string' || sentence.trim() === '') return { ok: false, error: '请先写一句行程想法。' }
  const originalSentence = sentence.trim()
  const durationMatch = originalSentence.match(DURATION_PATTERN)
  if (!durationMatch) return { ok: false, error: '请在一句话中写明行程天数，例如「7 天」。' }
  const durationDays = parseDuration(durationMatch[1] ?? '')
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 60) {
    return { ok: false, error: '行程天数需要是 1 至 60 天。' }
  }

  const destination = extractDestination(originalSentence, durationMatch.index ?? originalSentence.length)
  if (!destination) return { ok: false, error: '请在一句话中写明目的地。' }

  const dates = [...originalSentence.matchAll(DATE_PATTERN)].map((match) => normalizeDate(match[0] ?? '')).filter(Boolean)
  const validRange = dates.length >= 2 && isValidDateString(dates[0]) && isValidDateString(dates[1]) && dates[1]! >= dates[0]!
  const dateStatus: TripDateStatus = validRange ? 'confirmed' : TENTATIVE_DATE_PATTERN.test(originalSentence) ? 'tentative' : 'unspecified'
  const context: TripPlanningContext = {
    destination,
    durationDays,
    preferences: originalSentence,
    originalSentence,
    dateStatus,
    ...(dateStatus !== 'unspecified' ? { datePhrase: extractDatePhrase(originalSentence, dates) } : {}),
  }
  return {
    ok: true,
    value: {
      title: `${destination} · ${durationDays}日行程`,
      startDate: validRange ? dates[0]! : '',
      endDate: validRange ? dates[1]! : '',
      context,
    },
  }
}

function extractDestination(sentence: string, durationIndex: number): string {
  const beforeDuration = sentence.slice(0, durationIndex)
  const verb = beforeDuration.match(/(?:想去|要去|前往|去|到)\s*([^\s，,。；;]+)/)
  if (verb?.[1]) return cleanDestination(verb[1])
  const direct = beforeDuration.match(/^\s*([^\s，,。；;]+)/)
  return cleanDestination(direct?.[1] ?? '')
}

function cleanDestination(value: string): string {
  return value.replace(/^(?:去|到|前往)/, '').replace(/[，,。；;]+$/, '').trim().slice(0, 60)
}

function parseDuration(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100 }
  if (value === '十') return 10
  if (value.startsWith('十')) return 10 + (digits[value.slice(1)] ?? 0)
  if (value.endsWith('十')) return (digits[value.slice(0, -1)] ?? 0) * 10
  if (value.includes('十')) {
    const [tens, ones] = value.split('十')
    return (digits[tens ?? ''] ?? 0) * 10 + (digits[ones ?? ''] ?? 0)
  }
  return digits[value] ?? 0
}

function normalizeDate(value: string): string {
  const parts = value.split(/[-/.]/)
  if (parts.length !== 3) return ''
  return `${parts[0]}-${parts[1]!.padStart(2, '0')}-${parts[2]!.padStart(2, '0')}`
}

function extractDatePhrase(sentence: string, dates: string[]): string {
  if (dates.length >= 2) return dates.slice(0, 2).join(' 至 ')
  const match = sentence.match(TENTATIVE_DATE_PATTERN)
  return match?.[0] ?? ''
}
