/**
 * Accommodation storage codecs (ticket 04 part A).
 *
 * Byte-compatible with the legacy site (note B §2): key
 * `hailar-slow-trip-accommodation-v1`, payload
 * `{version: 1, bases: CustomBase[], stays: {<dayIndex>: <baseId>}}` where
 * `stays` holds ONLY overrides. Reads are legacy-tolerant (version ignored,
 * invalid bases dropped, corrupt JSON silently resets to defaults — no throw,
 * no user message, gotcha 4); the `isDefault` field stored on custom bases is
 * stripped through `normalizeBase` (isDefault is always false for customs).
 *
 * Accepts an injected storage-like (default `localStorage`) so tests can use
 * an in-memory mock — the same contract the legacy site has.
 */
import {
  ACCOMMODATION_VERSION,
  defaultBaseIds,
  normalizeBase,
  overnightDays,
} from './accommodation'
import type { AccommodationBase, AccommodationState } from './types'

export const ACCOMMODATION_STORAGE_KEY = 'hailar-slow-trip-accommodation-v1'

/** Exact status string on storage write failure (accommodation.js:193, 291). */
export const ACCOMMODATION_WRITE_FAILURE_STATUS = '当前浏览器未允许保存，住宿安排未改变。'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Default storage (lazy so Node tests never touch `window`). */
export function defaultStorage(): StorageLike {
  return window.localStorage
}

/**
 * Legacy-tolerant read (L157–173). Never throws: missing key, non-JSON or a
 * throw from storage all degrade to the all-defaults state. Stored custom
 * bases pass through `normalizeBase` (invalid ones dropped, `isDefault`
 * stripped); stays kept only for overnight days referencing a known base.
 */
export function readState(storage: StorageLike): AccommodationState {
  try {
    const raw: unknown = JSON.parse(storage.getItem(ACCOMMODATION_STORAGE_KEY) || '{}')
    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const bases = (Array.isArray(record.bases) ? record.bases : [])
      .map((value) => normalizeBase(value))
      .filter((base): base is AccommodationBase => base !== null)
    const known = new Set<string>([...defaultBaseIds, ...bases.map((base) => base.id)])
    const stays: Record<number, string> = {}
    if (record.stays && typeof record.stays === 'object' && !Array.isArray(record.stays)) {
      Object.entries(record.stays).forEach(([day, id]) => {
        const index = Number(day)
        if (overnightDays.includes(index) && typeof id === 'string' && known.has(id)) stays[index] = id
      })
    }
    return { version: 1, bases, stays }
  } catch {
    return { version: 1, bases: [], stays: {} }
  }
}

export type WriteStateResult = { ok: true } | { ok: false; error: string }

/**
 * Persist (L175–182). Never throws: a storage refusal returns the legacy
 * `{ok:false, error:'保存失败'}` shape (caller keeps the current in-memory
 * state and surfaces `ACCOMMODATION_WRITE_FAILURE_STATUS` — gotcha 5).
 */
export function writeState(storage: StorageLike, state: AccommodationState): WriteStateResult {
  try {
    storage.setItem(
      ACCOMMODATION_STORAGE_KEY,
      JSON.stringify({ version: ACCOMMODATION_VERSION, bases: state.bases, stays: state.stays }),
    )
    return { ok: true }
  } catch {
    return { ok: false, error: '保存失败' }
  }
}