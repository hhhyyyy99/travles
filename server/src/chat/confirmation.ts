/** Durable patch-explain confirmation state and itinerary snapshot hashing. */
import { createHash, randomUUID } from 'node:crypto'
import type { LegRow, DayRow, ItemRow } from '../days/types.js'
import type { TripSummary } from '../trips/types.js'
import type { PatchConfirmationRecord } from '../trip-patch/types.js'

export function createPatchConfirmation(snapshotHash: string, choices: string[]): PatchConfirmationRecord {
  return {
    token: randomUUID(),
    snapshotHash,
    choices: [...new Set(choices.map((choice) => choice.trim()).filter(Boolean))],
    createdAt: new Date().toISOString(),
  }
}

/** Hash only fields that describe the current itinerary, with stable row order. */
export function hashTripSnapshot(
  trip: Pick<TripSummary, 'id' | 'title' | 'startDate' | 'endDate' | 'days' | 'nights'>,
  dayRows: DayRow[],
  itemRows: ItemRow[],
  legRows: LegRow[],
): string {
  const payload = {
    trip: stableValue(trip),
    days: stableRows(dayRows),
    items: stableRows(itemRows),
    legs: stableRows(legRows),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function stableRows(rows: unknown): unknown[] {
  const values = Array.isArray(rows) ? rows.map(stableValue) : []
  return values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  // SQLite can hold blobs in nullable text columns. Include their bytes so
  // even corrupt day metadata changes invalidate an earlier explanation.
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]))
  }
  return value
}
