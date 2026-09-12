/**
 * Keep the summary row and day projection coherent after a day-level write.
 * The operation is intentionally storage-agnostic so both the day-admin and
 * TripPatch stores can use it without sharing repository implementations.
 */
import { isValidDateString } from '../trips/dates.js'
import type { TripRepository } from '../trips/repository.js'
import type { TripSummary } from '../trips/types.js'
import type { DayRow } from '../days/types.js'

const DAY_MS = 24 * 60 * 60 * 1000

export type DayScheduleUpdate = { id: string; idx: number; date: string }

export type TripScheduleStore = {
  listDayRows(tripId: string): Promise<DayRow[]>
  updateDaySchedule?: (tripId: string, updates: DayScheduleUpdate[]) => Promise<void>
}

export type ScheduleSyncOptions = {
  /** Rebase fully dated rows from the trip start after a removal/AI patch. */
  compactDates?: boolean
}

/**
 * Reindex days, optionally compact their dates, and refresh the trip range.
 * Undated draft days remain undated and leave the existing trip range alone.
 */
export async function synchronizeTripSchedule(
  tripRepository: TripRepository,
  store: TripScheduleStore,
  tripId: string,
  options: ScheduleSyncOptions = {},
): Promise<TripSummary | null> {
  const trip = await tripRepository.get(tripId)
  if (trip === null) return null

  let rows: DayRow[]
  try {
    rows = await store.listDayRows(tripId)
  } catch {
    return trip
  }
  const ordered = (Array.isArray(rows) ? rows : [])
    .map((row, sourceIndex) => ({ row, sourceIndex, id: asText(row?.id), idx: asIndex(row?.idx), date: asDate(row?.date) }))
    .filter((entry) => entry.id !== '')
    .sort((a, b) => a.idx - b.idx || a.sourceIndex - b.sourceIndex || a.id.localeCompare(b.id))

  const fullyDated = ordered.length > 0 && ordered.every((entry) => entry.date !== '')
  const compactDates = options.compactDates === true && fullyDated
  const baseDate = compactDates
    ? (isValidDateString(trip.startDate) ? trip.startDate : ordered[0]?.date ?? '')
    : ''
  const updates: DayScheduleUpdate[] = ordered.map((entry, index) => ({
    id: entry.id,
    idx: index,
    date: compactDates ? addDays(baseDate, index) : entry.date,
  }))

  if (store.updateDaySchedule && updates.some((update, index) => {
    const entry = ordered[index]
    return entry !== undefined && (entry.idx !== update.idx || entry.date !== update.date)
  })) {
    try {
      await store.updateDaySchedule(tripId, updates)
    } catch {
      // The original write has already succeeded; leave the authoritative
      // row untouched and let a later event/refetch repair the presentation.
      return trip
    }
  }

  if (!fullyDated) return trip
  const startDate = updates[0]?.date ?? ''
  const endDate = updates[updates.length - 1]?.date ?? ''
  if (!isValidDateString(startDate) || !isValidDateString(endDate)) return trip
  const updated = await tripRepository.update(tripId, { startDate, endDate })
  return updated.ok ? updated.trip : trip
}

function addDays(date: string, amount: number): string {
  if (!isValidDateString(date)) return ''
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + amount * DAY_MS)
  return Number.isFinite(next.getTime()) ? next.toISOString().slice(0, 10) : ''
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asDate(value: unknown): string {
  const date = asText(value)
  return isValidDateString(date) ? date : ''
}

function asIndex(value: unknown): number {
  const index = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(index) && index >= 0 ? index : Number.MAX_SAFE_INTEGER
}
