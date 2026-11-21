/**
 * Map recommendations, pending stash, and favorites API client (ticket 15).
 *
 * The codecs are deliberately tolerant like the canvas/chat clients: malformed
 * POIs are dropped and transport failures become `{ok:false}` results.
 */
import type { ApiResult, FetchLike } from './tripList'
import { defaultFetch } from './tripList'
import type { PoiRef, WorkbenchItem, WorkbenchItemCreateInput } from './workbench'

import { readStashFields } from '@hailar/domain'
import type {
  FavoriteItem,
  RecommendationPoi,
  RecommendationsApiSnapshot as RecommendationsSnapshot,
  RecommendationType,
  StashItem,
} from '@hailar/domain'
export type {
  FavoriteItem,
  RecommendationPoi,
  RecommendationsApiSnapshot as RecommendationsSnapshot,
  RecommendationType,
  StashItem,
} from '@hailar/domain'

const REQUEST_ERROR = '无法连接服务器，请确认后端服务已启动。'

export async function fetchRecommendations(
  tripId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<RecommendationsSnapshot>> {
  let response: Response
  try {
    response = await fetchLike(`/api/trips/${encodeURIComponent(tripId)}/recommendations`)
  } catch {
    return { ok: false, error: REQUEST_ERROR }
  }
  return parseSnapshotResponse(response, tripId)
}

export async function searchRecommendations(
  tripId: string,
  query: string,
  filters: { region?: string; type?: RecommendationType | 'all' } = {},
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<RecommendationPoi[]>> {
  const params = new URLSearchParams()
  if (query.trim()) params.set('query', query.trim())
  if (filters.region && filters.region !== 'all') params.set('region', filters.region)
  if (filters.type && filters.type !== 'all') params.set('type', filters.type)
  let response: Response
  try {
    response = await fetchLike(`/api/trips/${encodeURIComponent(tripId)}/recommendations/search?${params.toString()}`)
  } catch {
    return { ok: false, error: REQUEST_ERROR }
  }
  if (!response.ok) return { ok: false, error: await responseError(response) }
  const payload = (await response.json().catch(() => null)) as { recommendations?: unknown; error?: unknown } | null
  if (!payload || !Array.isArray(payload.recommendations)) return { ok: false, error: '服务器返回的推荐数据无法解析。' }
  if (typeof payload.error === 'string' && payload.error) return { ok: false, error: payload.error }
  return {
    ok: true,
    data: payload.recommendations.map(normalizePoi).filter((poi): poi is RecommendationPoi => poi !== null),
  }
}

export async function addToStash(
  tripId: string,
  poi: RecommendationPoi,
  origin: StashItem['origin'] = 'recommend',
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<StashItem>> {
  const response = await recommendationRequest(fetchLike, `/api/trips/${encodeURIComponent(tripId)}/stash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi, origin }),
  })
  if (!response.ok) return response
  const item = normalizeStash((response.data as { item?: unknown }).item, tripId)
  return item ? { ok: true, data: item } : { ok: false, error: '服务器返回的待计划点位无法解析。' }
}

export async function removeFromStash(
  tripId: string,
  stashId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<null>> {
  return mutationRequest(fetchLike, `/api/trips/${encodeURIComponent(tripId)}/stash/${encodeURIComponent(stashId)}`)
}

export async function addFavorite(
  tripId: string,
  poi: RecommendationPoi,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<FavoriteItem>> {
  const response = await recommendationRequest(fetchLike, `/api/trips/${encodeURIComponent(tripId)}/favorites`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ poi }),
  })
  if (!response.ok) return response
  const favorite = normalizeFavorite((response.data as { favorite?: unknown }).favorite)
  return favorite ? { ok: true, data: favorite } : { ok: false, error: '服务器返回的收藏点位无法解析。' }
}

export async function removeFavorite(
  tripId: string,
  favoriteId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<null>> {
  return mutationRequest(fetchLike, `/api/trips/${encodeURIComponent(tripId)}/favorites/${encodeURIComponent(favoriteId)}`)
}

/** Convert a recommended POI to the existing card-create request shape. */
export function recommendationCardInput(poi: RecommendationPoi, dayId: string, index?: number): WorkbenchItemCreateInput {
  const type = poi.type === 'stay' ? 'stay' : poi.type === 'food' ? 'food' : poi.type === 'attraction' ? 'attraction' : 'other'
  return {
    dayId,
    title: poi.name,
    type,
    note: poi.address,
    poi: poiRefFromRecommendation(poi),
    images: poi.images,
    ...(index === undefined ? {} : { index }),
  }
}

export function poiRefFromRecommendation(poi: RecommendationPoi): PoiRef {
  return {
    amapId: poi.amapId || poi.id,
    name: poi.name,
    lat: poi.lat,
    lng: poi.lng,
    category: poi.category || poi.type,
    rating: poi.rating,
    introSummary: poi.introSummary || poi.address,
  }
}

export function recommendationTypeLabel(type: RecommendationType): string {
  return type === 'attraction' ? '游玩' : type === 'food' ? '餐饮' : type === 'stay' ? '住宿' : '其他'
}

export function filterRecommendations(
  pois: RecommendationPoi[],
  filters: { region?: string; type?: RecommendationType | 'all' },
): RecommendationPoi[] {
  return pois.filter((poi) => {
    if (filters.region && filters.region !== 'all' && poi.region !== filters.region) return false
    if (filters.type && filters.type !== 'all' && poi.type !== filters.type) return false
    return true
  })
}

export function recommendationFilterCounts(pois: RecommendationPoi[]): Record<'attraction' | 'food' | 'stay' | 'other', number> {
  return pois.reduce(
    (counts, poi) => {
      counts[poi.type] += 1
      return counts
    },
    { attraction: 0, food: 0, stay: 0, other: 0 },
  )
}

function normalizeStash(value: unknown, expectedTripId: string): StashItem | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const poi = normalizePoi(record.poi)
  if (!poi || typeof record.id !== 'string' || !record.id) return null
  return {
    id: record.id,
    poi,
    origin: record.origin === 'favorite' ? 'favorite' : 'recommend',
    addedAt: typeof record.addedAt === 'string' ? record.addedAt : '',
    ...readStashFields({
      tripId: record.tripId,
      title: record.title,
      category: record.category,
      createdAt: record.createdAt,
    }, expectedTripId),
  }
}

function normalizeFavorite(value: unknown): FavoriteItem | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const poi = normalizePoi(record.poi)
  if (!poi || typeof record.id !== 'string' || !record.id) return null
  return { id: record.id, poi, createdAt: typeof record.createdAt === 'string' ? record.createdAt : '' }
}

function normalizePoi(value: unknown): RecommendationPoi | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const lat = Number(record.lat)
  const lng = Number(record.lng)
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const rawType = record.type
  const type: RecommendationType = rawType === 'food' || rawType === 'stay' || rawType === 'other' ? rawType : 'attraction'
  const images = Array.isArray(record.images)
    ? record.images
        .map((entry) => {
          if (entry === null || typeof entry !== 'object') return null
          const image = entry as Record<string, unknown>
          return typeof image.url === 'string' && image.url ? { url: image.url, caption: typeof image.caption === 'string' ? image.caption : '' } : null
        })
        .filter((entry): entry is { url: string; caption: string } => entry !== null)
    : []
  return {
    id:
      typeof record.id === 'string' && record.id
        ? record.id
        : typeof record.amapId === 'string' && record.amapId
          ? record.amapId
          : `poi-${name}-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    amapId: typeof record.amapId === 'string' ? record.amapId : '',
    name,
    lat,
    lng,
    category: typeof record.category === 'string' ? record.category : '',
    type,
    region: typeof record.region === 'string' ? record.region : typeof record.city === 'string' ? record.city : '',
    rating: finite(record.rating),
    introSummary: typeof record.introSummary === 'string' ? record.introSummary : '',
    address: typeof record.address === 'string' ? record.address : '',
    images,
  }
}

async function parseSnapshotResponse(response: Response, expectedTripId: string): Promise<ApiResult<RecommendationsSnapshot>> {
  if (!response.ok) return { ok: false, error: await responseError(response) }
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) return { ok: false, error: '服务器返回的推荐数据无法解析。' }
  const recommendations = Array.isArray(payload.recommendations)
    ? payload.recommendations.map(normalizePoi).filter((poi): poi is RecommendationPoi => poi !== null)
    : []
  const stash = Array.isArray(payload.stash)
    ? payload.stash.map((item) => normalizeStash(item, expectedTripId)).filter((item): item is StashItem => item !== null)
    : []
  const favorites = Array.isArray(payload.favorites)
    ? payload.favorites.map(normalizeFavorite).filter((item): item is FavoriteItem => item !== null)
    : []
  return { ok: true, data: { recommendations, stash, favorites } }
}

async function recommendationRequest(
  fetchLike: FetchLike,
  url: string,
  init: RequestInit,
): Promise<ApiResult<Record<string, unknown>>> {
  try {
    const response = await fetchLike(url, init)
    if (!response.ok) return { ok: false, error: await responseError(response) }
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
    return data ? { ok: true, data } : { ok: false, error: '服务器返回的数据无法解析。' }
  } catch {
    return { ok: false, error: REQUEST_ERROR }
  }
}

async function mutationRequest(fetchLike: FetchLike, url: string): Promise<ApiResult<null>> {
  try {
    const response = await fetchLike(url, { method: 'DELETE' })
    if (!response.ok) return { ok: false, error: await responseError(response) }
    return { ok: true, data: null }
  } catch {
    return { ok: false, error: REQUEST_ERROR }
  }
}

async function responseError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null
  return typeof payload?.error === 'string' && payload.error ? payload.error : `请求失败（HTTP ${response.status}）`
}

function finite(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

// Keep this import in the module's public surface for callers that already
// have a canvas item and want to check whether a recommendation is scheduled.
export function recommendationMatchesItem(poi: RecommendationPoi, item: WorkbenchItem): boolean {
  return Boolean(
    item.poi &&
      (((item.poi.amapId && poi.amapId && item.poi.amapId === poi.amapId) ||
        (item.poi.name === poi.name && item.poi.lat === poi.lat && item.poi.lng === poi.lng))),
  )
}
