/**
 * Trip list API client (ticket 02).
 *
 * Same codec convention as src/domain/storage.ts: tolerant reads that never
 * throw and an injectable transport (`FetchLike`, standing in for
 * `StorageLike`) so Node tests can use an in-memory mock. Every call returns
 * `{ok:true, data} | {ok:false, error}` — callers surface the error string,
 * nothing here throws.
 *
 * The backend lives behind the dev `/api` proxy (vite.config.ts → SERVER_PORT,
 * default 4310); in production the deployment is expected to be same-origin.
 */

export type TripSummary = {
  id: string
  title: string
  startDate: string
  endDate: string
  days: number
  nights: number
  createdAt: string
  updatedAt: string
  durationDays?: number
  dateStatus?: TripDateStatus
  planningContext?: TripPlanningContext
}

export type TripDateStatus = 'confirmed' | 'unspecified' | 'tentative'

export type TripPlanningContext = {
  destination: string
  durationDays: number
  preferences: string
  originalSentence: string
  dateStatus: TripDateStatus
  datePhrase?: string
}

export type TripFormInput = { title: string; startDate: string; endDate: string }
export type TripIntakeInput = { sentence: string }

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Injectable transport (node tests pass a stub; the app uses real fetch). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export function defaultFetch(): FetchLike {
  return fetch.bind(globalThis)
}

export const TRIPS_NETWORK_ERROR = '无法连接服务器，请确认后端服务已启动。'

/** GET /api/trips — never throws; unparseable entries are dropped. */
export async function fetchTrips(fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<TripSummary[]>> {
  return requestJson(fetchLike, '/api/trips', { method: 'GET' }, (payload) => {
    const trips = (payload as { trips?: unknown } | null)?.trips
    if (!Array.isArray(trips)) return []
    return trips.map(normalizeTrip).filter((trip): trip is TripSummary => trip !== null)
  })
}

/** POST /api/trips — create from title + date range. */
export async function createTrip(
  input: TripFormInput,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<TripSummary>> {
  return tripMutation(fetchLike, '/api/trips', 'POST', input)
}

/** POST /api/trips/intake — persist one sentence as a private draft trip. */
export async function createTripFromSentence(
  input: TripIntakeInput,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<TripSummary>> {
  return tripMutation(fetchLike, '/api/trips/intake', 'POST', input)
}

/** PATCH /api/trips/:id — rename (or re-date) a trip. */
export async function renameTrip(
  id: string,
  title: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<TripSummary>> {
  return tripMutation(fetchLike, `/api/trips/${encodeURIComponent(id)}`, 'PATCH', { title })
}

/** DELETE /api/trips/:id — data of the deleted trip: {ok:true, data:null}. */
export async function deleteTrip(id: string, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<null>> {
  return requestJson(fetchLike, `/api/trips/${encodeURIComponent(id)}`, { method: 'DELETE' }, () => null)
}

/**
 * Probe whether the trips backend is reachable (AppShell decides between the
 * trip list view and the standalone guide with it). Never throws; `?view=`
 * overrides live in AppShell, not here.
 */
export async function probeTripsApi(fetchLike: FetchLike = defaultFetch(), timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchLike('/api/trips', { signal: controller.signal })
    if (!response.ok) return false
    const payload = (await response.json().catch(() => null)) as { trips?: unknown } | null
    return Array.isArray(payload?.trips)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure, badge style per spec: "10.02至10.08 7天6晚")
// ---------------------------------------------------------------------------

/** Same-year ranges render as MM.DD; cross-year keeps the full year. */
export function formatDateBadge(startDate: string, endDate: string): string {
  const start = typeof startDate === 'string' ? startDate.trim() : ''
  const end = typeof endDate === 'string' ? endDate.trim() : ''
  const monthDay = (date: string) => date.slice(5).replace('-', '.')
  const full = (date: string) => date.replaceAll('-', '.')
  if (!start && !end) return ''
  if (!start) return full(end)
  if (!end) return full(start)
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${monthDay(start)}至${monthDay(end)}`
    : `${full(start)}至${full(end)}`
}

/** "7天6晚"; a same-day trip renders as "1天". Unusable ranges render ''. */
export function formatDuration(days: number, nights: number): string {
  if (!Number.isFinite(days) || days <= 0) return ''
  return nights > 0 ? `${days}天${nights}晚` : `${days}天`
}

/** Shared schedule badge for dated trips and date-pending intake drafts. */
export function formatTripSchedule(trip: Pick<TripSummary, 'startDate' | 'endDate' | 'days' | 'nights' | 'durationDays' | 'dateStatus'>): string {
  const date = formatDateBadge(trip.startDate, trip.endDate)
  const durationDays = trip.durationDays ?? trip.days
  const duration = formatDuration(durationDays, Math.max(0, durationDays - 1))
  if (!date && (trip.dateStatus === 'unspecified' || trip.dateStatus === 'tentative')) {
    return duration ? `日期待定 · ${duration}` : '日期待定'
  }
  return [date, formatDuration(trip.days, trip.nights)].filter(Boolean).join(' ')
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Client-side preview of the server's inclusive days/nights computation. */
export function previewDaysNights(startDate: string, endDate: string): { days: number; nights: number } {
  if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) return { days: 0, nights: 0 }
  const [year, month, day] = startDate.split('-').map(Number) as [number, number, number]
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number) as [number, number, number]
  const startUtc = Date.UTC(year, month - 1, day)
  const endUtc = Date.UTC(endYear, endMonth - 1, endDay)
  const checkedStart = new Date(startUtc)
  const checkedEnd = new Date(endUtc)
  if (
    checkedStart.getUTCMonth() !== month - 1 ||
    checkedEnd.getUTCMonth() !== endMonth - 1 ||
    endUtc < startUtc
  ) {
    return { days: 0, nights: 0 }
  }
  const days = Math.round((endUtc - startUtc) / (24 * 60 * 60 * 1000)) + 1
  return { days, nights: days - 1 }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function tripMutation(
  fetchLike: FetchLike,
  url: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
): Promise<ApiResult<TripSummary>> {
  return requestJson(fetchLike, url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, (payload) => {
    const trip = normalizeTrip((payload as { trip?: unknown } | null)?.trip)
    if (trip === null) throw new Error('unparseable trip payload')
    return trip
  })
}

async function requestJson<T>(
  fetchLike: FetchLike,
  url: string,
  init: RequestInit,
  parse: (payload: unknown) => T,
): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetchLike(url, init)
  } catch {
    return { ok: false, error: TRIPS_NETWORK_ERROR }
  }
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // fall through — non-JSON bodies are handled below
  }
  if (!response.ok) {
    return { ok: false, error: extractError(payload) ?? `请求失败（HTTP ${response.status}）` }
  }
  try {
    return { ok: true, data: parse(payload) }
  } catch {
    return { ok: false, error: '服务器返回的数据无法解析。' }
  }
}

function extractError(payload: unknown): string | null {
  const error = (payload as { error?: unknown } | null)?.error
  return typeof error === 'string' && error.length > 0 ? error : null
}

/** Tolerant row normalization: invalid entries → null (dropped). */
export function normalizeTrip(value: unknown): TripSummary | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) return null
  const startDate = typeof record.startDate === 'string' ? record.startDate : ''
  const endDate = typeof record.endDate === 'string' ? record.endDate : ''
  const computed = previewDaysNights(startDate, endDate)
  const days = typeof record.days === 'number' && Number.isFinite(record.days) && record.days >= 0 ? record.days : computed.days
  const nights =
    typeof record.nights === 'number' && Number.isFinite(record.nights) && record.nights >= 0
      ? record.nights
      : computed.nights
  const planningContext = normalizePlanningContext(record.planningContext)
  return {
    id,
    title: typeof record.title === 'string' ? record.title.trim() : '',
    startDate,
    endDate,
    days,
    nights,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    ...(planningContext
      ? {
          durationDays: planningContext.durationDays,
          dateStatus: planningContext.dateStatus,
          planningContext,
        }
      : {}),
  }
}

function normalizePlanningContext(value: unknown): TripPlanningContext | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const destination = typeof record.destination === 'string' ? record.destination.trim() : ''
  const preferences = typeof record.preferences === 'string' ? record.preferences.trim() : ''
  const originalSentence = typeof record.originalSentence === 'string' ? record.originalSentence.trim() : ''
  const durationDays = typeof record.durationDays === 'number' ? record.durationDays : Number(record.durationDays)
  const dateStatus = record.dateStatus
  if (!destination || !preferences || !originalSentence || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 60) return null
  if (dateStatus !== 'confirmed' && dateStatus !== 'unspecified' && dateStatus !== 'tentative') return null
  const datePhrase = typeof record.datePhrase === 'string' && record.datePhrase.trim() ? record.datePhrase.trim() : undefined
  return { destination, durationDays, preferences, originalSentence, dateStatus, ...(datePhrase ? { datePhrase } : {}) }
}
