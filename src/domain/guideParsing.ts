import { GuideImportRequestSchema, GuideImportResultSchema, GuideParseRequestSchema, GuideParseResultSchema, readActivityItemMetadata, type GuideImportRequest, type GuideImportRequestInput, type GuideParseRequest, type GuideParseResult, type TripSummary } from '@hailar/domain'
import { defaultFetch, TRIPS_NETWORK_ERROR, type FetchLike } from './tripList'

export type GuideApiResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }
export type GuideImportInput = GuideImportRequestInput
export type GuideImportSession = {
  url: string; text: string; draft: GuideImportRequest['draft'] | null; title: string; importId: string
  confirmation: GuideImportInput | null
}
export type TripCreationSession = { mode: 'ai' | 'guide'; guide: GuideImportSession | null }

/** getRandomValues is also available on ordinary HTTP LAN origins. */
export function createGuideImportId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

/** Parsing only previews a guide; creating a trip always requires a separate request. */
export async function parseGuide(
  input: GuideParseRequest,
  signal?: AbortSignal,
  fetchLike: FetchLike = defaultFetch(),
): Promise<GuideApiResult<GuideParseResult>> {
  const checked = GuideParseRequestSchema.safeParse(input)
  if (!checked.success) return { ok: false, code: 'invalid_request', error: '请提供有效的攻略链接或正文（最多 20000 字）。' }
  return post('/api/ai/parse-guide', checked.data, 90_000, signal, fetchLike, (payload) => {
    const result = GuideParseResultSchema.safeParse(normalizePreviewMetadata(payload))
    if (!result.success) return null
    return result.data
  })
}

/** Tolerate only optional item metadata on reads; all other preview fields still validate strictly. */
function normalizePreviewMetadata(payload: unknown): unknown {
  if (!isRecord(payload) || payload.status !== 'ready') return payload
  const draft = payload.draft
  if (!isRecord(draft) || !Array.isArray(draft.days)) return payload
  return {
    ...payload,
    draft: {
      ...draft,
      days: draft.days.map((day: unknown) => {
        if (!isRecord(day) || !Array.isArray(day.items)) return day
        return {
          ...day,
          items: day.items.map((item: unknown) => {
            if (!isRecord(item)) return item
            const normalized = { ...item }
            delete normalized.timeRange
            delete normalized.cost
            return { ...normalized, ...readActivityItemMetadata(item) }
          }),
        }
      }),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Keep importId and the payload unchanged when retrying an uncertain save. */
export async function importGuide(
  input: GuideImportInput,
  signal?: AbortSignal,
  fetchLike: FetchLike = defaultFetch(),
): Promise<GuideApiResult<TripSummary>> {
  const checked = GuideImportRequestSchema.safeParse(input)
  if (!checked.success) return { ok: false, code: 'invalid_request', error: '草稿内容无效，请重新解析后再创建。' }
  return post('/api/trips/from-guide', checked.data, 30_000, signal, fetchLike, (payload) => {
    const parsed = GuideImportResultSchema.safeParse(payload)
    return parsed.success && parsed.data.trip.id.trim() ? parsed.data.trip : null
  })
}

async function post<T>(
  url: string, body: unknown, timeoutMs: number, signal: AbortSignal | undefined, fetchLike: FetchLike,
  decode: (payload: unknown) => T | null,
): Promise<GuideApiResult<T>> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const response = await fetchLike(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
    const payload: unknown = await response.json().catch(() => null)
    const error = payload as { error?: unknown; code?: unknown; status?: unknown } | null
    if (!response.ok || error?.status === 'error') {
      return { ok: false, error: typeof error?.error === 'string' ? error.error : `请求失败（HTTP ${response.status}），请稍后重试。`,
        ...(typeof error?.code === 'string' ? { code: error.code } : {}) }
    }
    const data = decode(payload)
    return data === null ? { ok: false, error: '服务器返回的数据无法解析，请重试。' } : { ok: true, data }
  } catch {
    return { ok: false, error: timedOut ? '请求超时，请重试。确认创建时重试不会重复保存。' : TRIPS_NETWORK_ERROR }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
