/**
 * Trip repository contracts (ticket 02, spec 测试接缝 #2).
 *
 * Two layers:
 * - `TripStoreDriver` — the injectable low-level row seam (SQLite driver in
 *   production, in-memory driver in tests). Row fields are snake_case on
 *   purpose so the SQLite driver maps libsql columns 1:1; values stay
 *   `unknown` because corrupt rows are a real scenario the repository must
 *   survive (容错读取、永不 throw — same codec convention as
 *   src/domain/storage.ts).
 * - `TripRepository` — validation, day/night computation and tolerant
 *   mapping, written once against any driver.
 */
export type TripSummary = {
  id: string
  title: string
  startDate: string
  endDate: string
  /** Inclusive day count, auto-computed from the date range. */
  days: number
  /** Nights = days - 1 (0 for a same-day trip or unusable dates). */
  nights: number
  createdAt: string
  updatedAt: string
}

/** Raw driver row; values unknown so corrupt storage can be represented. */
export interface TripRow {
  id: unknown
  title: unknown
  start_date: unknown
  end_date: unknown
  created_at: unknown
  updated_at: unknown
}

export type TripUpdate = {
  title?: unknown
  startDate?: unknown
  endDate?: unknown
}

/** Machine-readable failure class the HTTP layer maps to status codes. */
export type TripErrorCode = 'invalid' | 'not_found' | 'storage'

export type TripWriteResult =
  | { ok: true; trip: TripSummary }
  | { ok: false; error: string; code: TripErrorCode }
export type TripMutationResult = { ok: true } | { ok: false; error: string; code: TripErrorCode }

export interface TripStoreDriver {
  listTripRows(): Promise<TripRow[]>
  getTripRow(id: string): Promise<TripRow | null>
  insertTripRow(row: Required<TripRow>): Promise<void>
  /** Returns false when the trip does not exist. */
  updateTripRow(
    id: string,
    patch: { title: string; startDate: string; endDate: string; updatedAt: string },
  ): Promise<boolean>
  /** Returns false when the trip does not exist. */
  deleteTripRow(id: string): Promise<boolean>
}
