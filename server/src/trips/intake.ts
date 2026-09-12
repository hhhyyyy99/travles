import { isValidDateString } from './dates.js'
import type { TripDateStatus, TripPlanningContext } from './types.js'

export type ParsedTripIntake = {
  title: string
  startDate: string
  endDate: string
  context: TripPlanningContext
}

export type TripIntakeError = { ok: false; error: string } | { ok: true; value: ParsedTripIntake }

const DURATION_PATTERN = /(\d{1,2}|[一二三四五六七八九十百两]+)\s*(?:天|日)/
const FULL_DATE_PATTERN = /(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日?)/g
const SHORT_DATE_PATTERN = /(?:\d{1,2}\s*月\s*\d{1,2}日?|\d{1,2}\s*[/.]\s*\d{1,2})/g
const TENTATIVE_DATE_PATTERN = /国庆|暑假|寒假|周末|下周|本周|月底|月初|\d{1,2}\s*月|[一二三四五六七八九十]+月|\d{1,2}\s*[/.]\s*\d{1,2}/

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

  const fullDateTokens = [...originalSentence.matchAll(FULL_DATE_PATTERN)].map((match) => match[0] ?? '')
  const shortDateTokens = [...originalSentence.matchAll(SHORT_DATE_PATTERN)].map((match) => match[0] ?? '')
  const dates = fullDateTokens.map(normalizeDate).filter(Boolean)
  const validRange = dates.length >= 2 && isValidDateString(dates[0]) && isValidDateString(dates[1]) && dates[1]! >= dates[0]!
  if (validRange) {
    const span = inclusiveDaySpan(dates[0]!, dates[1]!)
    if (span !== durationDays) {
      return { ok: false, error: `你说的是 ${durationDays} 天，但日期范围是 ${span} 天，请确认日期或行程天数。` }
    }
  }
  const dateStatus: TripDateStatus = validRange ? 'confirmed' : fullDateTokens.length > 0 || shortDateTokens.length > 0 || TENTATIVE_DATE_PATTERN.test(originalSentence) ? 'tentative' : 'unspecified'
  const context: TripPlanningContext = {
    destination,
    durationDays,
    preferences: originalSentence,
    originalSentence,
    dateStatus,
    ...(dateStatus !== 'unspecified' ? { datePhrase: extractDatePhrase(originalSentence, [...fullDateTokens, ...shortDateTokens]) } : {}),
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
  return value
    .replace(/^(?:去|到|前往)/, '')
    .replace(/(?:旅游|旅行|游玩|游览|玩)$/, '')
    .replace(/[，,。；;]+$/, '')
    .trim()
    .slice(0, 60)
}

function parseDuration(value: string): number {
  if (/^\d+$/.test(value)) return Number(value)
  const digits: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 两: 2 }
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
  const chinese = value.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?$/)
  if (chinese) return `${chinese[1]}-${chinese[2]!.padStart(2, '0')}-${chinese[3]!.padStart(2, '0')}`
  const parts = value.split(/[-/.]/)
  if (parts.length !== 3) return ''
  return `${parts[0]}-${parts[1]!.padStart(2, '0')}-${parts[2]!.padStart(2, '0')}`
}

function extractDatePhrase(sentence: string, tokens: string[]): string {
  if (tokens.length >= 2) return tokens.slice(0, 2).join(' 至 ')
  const match = sentence.match(TENTATIVE_DATE_PATTERN)
  return match?.[0] ?? ''
}

function inclusiveDaySpan(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1
}
