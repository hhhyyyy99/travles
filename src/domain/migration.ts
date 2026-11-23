/**
 * Legacy localStorage → server migration (ticket 03).
 *
 * When a browser that used the old guide (checklist + accommodation keys in
 * localStorage) first enters the trip-list page, its data is migrated into
 * the built-in example trip on the server. Design:
 *
 * - Idempotency (coordinated by convention, tickets 04/08 must not collide):
 *   * a localStorage marker key (SERVER_MIGRATION_MARKER_KEY) is written only
 *     after a fully successful migration, so each browser migrates once and
 *     later edits on the server are never clobbered by stale local data;
 *   * every migrated row carries a fixed id — stay items reuse the seeded
 *     `builtin-stay-day-<n>` ids, checklist rows use `legacy-checklist-<i>` —
 *     and the server upserts by id, so even repeated triggers never duplicate
 *     rows (server/src/seed/builtin-trip-data.ts documents the scheme).
 * - Corrupt JSON degrades exactly like the codecs: readState/loadChecklist
 *   never throw and return defaults, so a corrupt browser profile migrates
 *   as "nothing to migrate" instead of failing.
 * - Everything is `{status}`-reporting and never throws: failures (server
 *   down, trip deleted, write rejected) leave the marker untouched so the
 *   next entry retries.
 *
 * The target trip is the built-in example (`builtin-hailar-oct7`, seeded by
 * the server on first startup). If it is absent the migration reports
 * 'trip-missing' without setting the marker.
 */
import { tripPlan } from '../data/itinerary'
import { defaultStorage, readState, type StorageLike } from './storage'
import { CHECKLIST_ITEMS, loadChecklist, type ChecklistStorage } from './checklist'
import { getDayStay, overnightDays } from './accommodation'
import { fetchTrips, defaultFetch, type FetchLike } from './tripList'
import type { AccommodationBase } from './types'

/** Mirror of server/src/seed/builtin-trip-data.ts BUILTIN_TRIP_ID. */
export const BUILTIN_TRIP_ID = 'builtin-hailar-oct7'

/** Written (value "done") after the versioned migration completes. */
export const SERVER_MIGRATION_MARKER_KEY = 'hailar-slow-trip-server-migration-v2'
/** Marker used by the original migration; its presence triggers metadata upgrade. */
export const LEGACY_SERVER_MIGRATION_MARKER_KEY = 'hailar-slow-trip-server-migration-v1'

/** Fixed id of the migrated stay item for a day (upserts the seeded row). */
export function migratedStayItemId(dayIndex: number): string {
  return `builtin-stay-day-${dayIndex}`
}

/** Fixed id of the migrated checklist entry for a guide item index. */
export function migratedChecklistItemId(index: number): string {
  return `legacy-checklist-${index}`
}

export type MigrationStatus =
  'migrated' | 'already-migrated' | 'no-legacy-data' | 'trip-missing' | 'failed'

export type MigrationResult = { status: MigrationStatus; tripId?: string; tripTitle?: string }

export interface MigrationOptions {
  storage?: StorageLike
  checklistStorage?: ChecklistStorage
  fetchLike?: FetchLike
}

/**
 * Run the migration once. Never throws; a corrupted storage profile counts
 * as "no legacy data" and is marked done (the codecs' defaults are the best
 * available interpretation of it).
 */
export async function migrateLegacyDataToServer(
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const storage = options.storage ?? defaultStorage()
  const checklistStorage = options.checklistStorage ?? storage
  const fetchLike = options.fetchLike ?? defaultFetch()

  if (readMarker(storage)) return { status: 'already-migrated' }
  const legacyMarker = readLegacyMarker(storage)

  // Both codecs are 容错读取: corrupt JSON degrades to defaults here.
  const accommodation = readState(storage)
  const checked = loadChecklist(checklistStorage)
  const hasAccommodation =
    accommodation.bases.length > 0 || Object.keys(accommodation.stays).length > 0
  const hasChecklist = checked.length > 0
  if (!hasAccommodation && !hasChecklist && !legacyMarker) {
    writeMarker(storage)
    return { status: 'no-legacy-data' }
  }

  const trips = await fetchTrips(fetchLike)
  if (!trips.ok) return { status: 'failed' }
  const trip = trips.data.find((entry) => entry.id === BUILTIN_TRIP_ID)
  if (!trip) return { status: 'trip-missing' }

  const days = await fetchDays(trip.id, fetchLike)
  if (!days.ok) return { status: 'failed' }

  if (hasAccommodation || legacyMarker) {
    // Every overnight day gets its effective stay (default or override)
    // resolved to a base name — the same projection the guide page shows.
    const items = overnightDays
      .map((dayIndex) => {
        const day = days.data.find((entry) => entry.idx === dayIndex)
        const stay = getDayStay(accommodation, dayIndex)
        if (!day || !stay) return null
        const current = day.items?.find((item) => item.id === migratedStayItemId(dayIndex))
        if (legacyMarker && !current) return null
        const seed = tripPlan.days[dayIndex]
        const placeholder = `第 ${dayIndex + 1} 晚住宿`
        // A saved POI already identifies the lodging. Only replace seed text
        // when this write supplies the lodging, and keep a deliberately blank note.
        const replaceTitle =
          !current?.poi && (current?.title === seed?.stay || current?.title === placeholder)
        const replaceNote =
          !current?.poi && (current?.note === seed?.alt || current?.note === placeholder)
        return {
          id: migratedStayItemId(dayIndex),
          dayId: day.id,
          itemOrder: current?.itemOrder ?? 100,
          type: 'stay',
          title: replaceTitle ? stay.name : current?.title || stay.name,
          note: replaceNote ? (stay.address ?? '') : (current?.note ?? stay.address ?? ''),
          poi: current?.poi ?? accommodationPoi(stay),
          pending: current?.pending ?? false,
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
    if (items.length > 0) {
      const written = await putJson(fetchLike, `/api/trips/${encodeURIComponent(trip.id)}/items`, {
        items,
      })
      if (!written.ok) return { status: 'failed' }
    }
  }

  if (hasChecklist && !legacyMarker) {
    // Migrate the full guide checklist with done flags so unchecked items
    // survive too (the checklist panel in ticket 14 needs all entries).
    const items = CHECKLIST_ITEMS.map((content, index) => ({
      id: migratedChecklistItemId(index),
      content,
      done: checked.includes(index),
    }))
    const written = await putJson(
      fetchLike,
      `/api/trips/${encodeURIComponent(trip.id)}/checklist`,
      { items },
    )
    if (!written.ok) return { status: 'failed' }
  }

  writeMarker(storage)
  return { status: 'migrated', tripId: trip.id, tripTitle: trip.title }
}

// ---------------------------------------------------------------------------
// Internals — small tolerant fetch/storage helpers, nothing throws
// ---------------------------------------------------------------------------

interface DaySummary {
  id: string
  idx: number
  items?: Array<{
    id: string
    itemOrder?: number
    title: string
    note: string
    pending: boolean
    poi: Record<string, unknown> | null
  }>
}

async function fetchDays(
  tripId: string,
  fetchLike: FetchLike,
): Promise<{ ok: true; data: DaySummary[] } | { ok: false }> {
  let response: Response
  try {
    response = await fetchLike(`/api/trips/${encodeURIComponent(tripId)}/days`)
  } catch {
    return { ok: false }
  }
  if (!response.ok) return { ok: false }
  const payload = (await response.json().catch(() => null)) as { days?: unknown } | null
  const days = payload?.days
  if (!Array.isArray(days)) return { ok: false }
  const data: DaySummary[] = []
  for (const entry of days) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id) continue
    const idx = Number(record.idx)
    const items = Array.isArray(record.items)
      ? record.items
          .filter(
            (item): item is Record<string, unknown> =>
              item !== null && typeof item === 'object' && !Array.isArray(item),
          )
          .map((item) => ({
            id: typeof item.id === 'string' ? item.id : '',
            itemOrder:
              typeof item.itemOrder === 'number' && Number.isFinite(item.itemOrder)
                ? item.itemOrder
                : undefined,
            title: typeof item.title === 'string' ? item.title : '',
            note: typeof item.note === 'string' ? item.note : '',
            pending: item.pending === true || item.pending === 1,
            poi: parseStoredPoi(item.poi),
          }))
          .filter((item) => item.id !== '')
      : undefined
    data.push({ id: record.id, idx: Number.isInteger(idx) ? idx : 0, ...(items ? { items } : {}) })
  }
  return { ok: true, data }
}

async function putJson(
  fetchLike: FetchLike,
  url: string,
  body: unknown,
): Promise<{ ok: true } | { ok: false }> {
  let response: Response
  try {
    response = await fetchLike(url, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  } catch {
    return { ok: false }
  }
  return response.ok ? { ok: true } : { ok: false }
}

function readMarker(storage: StorageLike): boolean {
  try {
    return storage.getItem(SERVER_MIGRATION_MARKER_KEY) === 'done'
  } catch {
    return false
  }
}

function readLegacyMarker(storage: StorageLike): boolean {
  try {
    return storage.getItem(LEGACY_SERVER_MIGRATION_MARKER_KEY) === 'done'
  } catch {
    return false
  }
}

function writeMarker(storage: StorageLike): void {
  try {
    storage.setItem(SERVER_MIGRATION_MARKER_KEY, 'done')
    storage.setItem(LEGACY_SERVER_MIGRATION_MARKER_KEY, 'done')
  } catch {
    // storage refusal — the next entry will simply retry the migration
  }
}

function accommodationPoi(base: AccommodationBase): Record<string, unknown> {
  return {
    amapId: `legacy-accommodation:${base.id}`,
    name: base.name,
    lat: base.lat,
    lng: base.lng,
    ...(base.address ? { address: base.address } : {}),
    accommodationBaseId: base.id,
    accommodationType: base.type,
    ...(base.notes ? { accommodationNotes: base.notes } : {}),
    accommodationMigrationVersion: 2,
    category: base.type === 'area' ? '住宿区域' : '酒店 / 民宿',
    rating: 0,
    introSummary: base.notes ?? '',
  }
}

function parseStoredPoi(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
