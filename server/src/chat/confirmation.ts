/** Durable patch-explain confirmation state and itinerary snapshot hashing. */
import { createHash, randomUUID } from 'node:crypto'
import type { LegRow, DayRow, ItemRow } from '../days/types.js'
import type { TripSummary } from '../trips/types.js'
import type { PatchConfirmationRecord, TripPatchStoreDriver } from '../trip-patch/types.js'
import type { StashRow } from '../recommendations/types.js'

export function createPatchConfirmation(snapshotHash: string, choices: string[]): PatchConfirmationRecord {
  return {
    token: randomUUID(),
    snapshotHash,
    choices: [...new Set(choices.map((choice) => choice.trim()).filter(Boolean))],
    createdAt: new Date().toISOString(),
  }
}

/** Raw storage rows stay authoritative even when a tolerant view drops bad data. */
export type TripSnapshotRows = { days: DayRow[]; items: ItemRow[]; legs: LegRow[]; stash: StashRow[] }

export async function readTripSnapshotRows(store: TripPatchStoreDriver, tripId: string): Promise<TripSnapshotRows> {
  const [days, items, legs, stash] = await Promise.all([
    store.listDayRows(tripId), store.listItemRows(tripId), store.listLegRows(tripId), store.listStashRows(tripId),
  ])
  if (![days, items, legs, stash].every(Array.isArray)) throw new Error('invalid trip snapshot rows')
  return { days, items, legs, stash }
}

/** Hash every raw itinerary/stash field, including invalid JSON, metadata and blobs. */
export function hashTripSnapshot(
  trip: Pick<TripSummary, 'id' | 'title' | 'startDate' | 'endDate' | 'days' | 'nights'>,
  dayRows: DayRow[],
  itemRows: ItemRow[],
  legRows: LegRow[],
  stashRows: StashRow[] = [],
): string {
  return hashValue({ trip: stableValue(trip), ...snapshotPayload(dayRows, itemRows, legRows, stashRows) })
}

/** Proposal previews bind to the exact rows returned by their snapshot tool. */
export function hashTripSnapshotRows(rows: TripSnapshotRows): string {
  return hashValue(snapshotPayload(rows.days, rows.items, rows.legs, rows.stash))
}

function snapshotPayload(days: DayRow[], items: ItemRow[], legs: LegRow[], stash: StashRow[]) {
  return { days: stableRows(days), items: stableRows(items), legs: stableRows(legs), stash: stableRows(stash) }
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
