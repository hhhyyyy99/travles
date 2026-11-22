import { randomUUID } from 'node:crypto'
import { readStashFields } from '@hailar/domain'
import type {
  FavoriteItem,
  FavoriteRow,
  RecommendationPoi,
  RecommendationOrigin,
  RecommendationWriteResult,
  RecommendationsSnapshot,
  RecommendationsStoreDriver,
  StashItem,
  StashRow,
} from './types.js'

const MAX_NAME = 160
const MAX_TEXT = 500

export class RecommendationsRepository {
  constructor(private readonly driver: RecommendationsStoreDriver) {}

  async snapshot(tripId: string): Promise<RecommendationsSnapshot> {
    const [stashRows, favoriteRows] = await Promise.all([
      this.safeRows(() => this.driver.listStashRows(tripId)),
      this.safeRows(() => this.driver.listFavoriteRows(tripId)),
    ])
    return {
      stash: stashRows.map((row) => mapStashRow(row, tripId)).filter((item): item is StashItem => item !== null),
      favorites: favoriteRows.map(mapFavoriteRow).filter((item): item is FavoriteItem => item !== null),
    }
  }

  async addStash(
    tripId: string,
    input: unknown,
    requestedOrigin: unknown = 'recommend',
  ): Promise<RecommendationWriteResult<StashItem>> {
    const poi = normalizePoi(input)
    if (!poi) return { ok: false, error: '推荐点位数据无效', code: 'invalid' }
    const origin: RecommendationOrigin = requestedOrigin === 'favorite' ? 'favorite' : 'recommend'
    const current = await this.snapshot(tripId)
    const existing = current.stash.find((item) => item.poi !== null && poiKey(item.poi) === poiKey(poi))
    if (existing) return { ok: true, value: existing }
    const item: StashItem = {
      id: randomUUID(),
      poi,
      origin,
      addedAt: new Date().toISOString(),
    }
    try {
      await this.driver.insertStashRow(tripId, {
        id: item.id,
        poi: JSON.stringify(item.poi),
        origin: item.origin,
        addedAt: item.addedAt,
      })
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return {
      ok: true,
      value: {
        ...item,
        // These are the normalized strings and identity just persisted above,
        // not the pre-write input or a new read-time timestamp.
        ...readStashFields({ tripId, title: poi.name, category: poi.category, createdAt: item.addedAt }, tripId),
      },
    }
  }

  async removeStash(tripId: string, stashId: string): Promise<RecommendationWriteResult<null>> {
    try {
      const removed = await this.driver.deleteStashRow(tripId, stashId)
      return removed
        ? { ok: true, value: null }
        : { ok: false, error: '待计划点位不存在', code: 'not_found' }
    } catch {
      return { ok: false, error: '删除失败', code: 'storage' }
    }
  }

  async addFavorite(tripId: string, input: unknown): Promise<RecommendationWriteResult<FavoriteItem>> {
    const poi = normalizePoi(input)
    if (!poi) return { ok: false, error: '收藏点位数据无效', code: 'invalid' }
    const current = await this.snapshot(tripId)
    const existing = current.favorites.find((item) => poiKey(item.poi) === poiKey(poi))
    if (existing) return { ok: true, value: existing }
    const favorite: FavoriteItem = {
      id: randomUUID(),
      poi,
      createdAt: new Date().toISOString(),
    }
    try {
      await this.driver.insertFavoriteRow(tripId, {
        id: favorite.id,
        poi: JSON.stringify(favorite.poi),
        createdAt: favorite.createdAt,
      })
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    // A favorite is also a pending idea until it is scheduled. Reusing the
    // same POI key keeps the stash id stable when the user toggles repeatedly.
    const stash = await this.addStash(tripId, poi, 'favorite')
    if (!stash.ok) {
      // A favorite without its pending row is still useful when it was already
      // scheduled, but this branch only runs for a newly inserted favorite.
      // Compensate the first write so a storage failure cannot create a half
      // persisted favorite that the next snapshot would expose.
      try {
        await this.driver.deleteFavoriteRow(tripId, favorite.id)
      } catch {
        // The driver may be unavailable for the compensating write; the
        // original storage error remains the actionable result.
      }
      return stash as RecommendationWriteResult<FavoriteItem>
    }
    return { ok: true, value: favorite }
  }

  async removeFavorite(tripId: string, favoriteId: string): Promise<RecommendationWriteResult<null>> {
    let favorite: FavoriteItem | undefined
    const current = await this.snapshot(tripId)
    favorite = current.favorites.find((entry) => entry.id === favoriteId)
    try {
      const removed = await this.driver.deleteFavoriteRow(tripId, favoriteId)
      if (!removed) return { ok: false, error: '收藏点位不存在', code: 'not_found' }
      if (favorite) {
        const stash = current.stash.find((entry) => entry.poi !== null && poiKey(entry.poi) === poiKey(favorite!.poi))
        if (stash?.origin === 'favorite') {
          try {
            await this.driver.deleteStashRow(tripId, stash.id)
          } catch {
            // Restore the favorite when its companion pending row could not be
            // removed, keeping the two records consistent for a retry.
            try {
              await this.driver.insertFavoriteRow(tripId, {
                id: favorite.id,
                poi: JSON.stringify(favorite.poi),
                createdAt: favorite.createdAt,
              })
            } catch {
              // Best effort; the original storage error is still returned.
            }
            return { ok: false, error: '删除失败', code: 'storage' }
          }
        }
      }
      return { ok: true, value: null }
    } catch {
      return { ok: false, error: '删除失败', code: 'storage' }
    }
  }

  private async safeRows<T>(read: () => Promise<T[]>): Promise<T[]> {
    try {
      const rows = await read()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }
}

export function poiKey(poi: Pick<RecommendationPoi, 'id' | 'amapId' | 'name' | 'lat' | 'lng'>): string {
  return poi.amapId || poi.id || `${poi.name}|${poi.lat.toFixed(5)}|${poi.lng.toFixed(5)}`
}

export function normalizePoi(value: unknown): RecommendationPoi | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const name = text(record.name, MAX_NAME)
  const lat = finite(record.lat)
  const lng = finite(record.lng)
  if (!name || lat === null || lng === null) return null
  const rawType = text(record.type, 30)
  const type: RecommendationPoi['type'] = rawType === 'food' || rawType === 'stay' || rawType === 'other' ? rawType : 'attraction'
  const images = Array.isArray(record.images)
    ? record.images
        .map((entry) => {
          if (entry === null || typeof entry !== 'object') return null
          const image = entry as Record<string, unknown>
          const url = text(image.url, MAX_TEXT)
          return url ? { url, caption: text(image.caption, MAX_TEXT) } : null
        })
        .filter((entry): entry is { url: string; caption: string } => entry !== null)
        .slice(0, 12)
    : []
  return {
    id: text(record.id, 120) || text(record.amapId, 120) || `poi-${name}-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    amapId: text(record.amapId, 120),
    name,
    lat,
    lng,
    category: text(record.category, 80),
    type,
    region: text(record.region, 80) || text(record.city, 80),
    rating: finite(record.rating) ?? 0,
    introSummary: text(record.introSummary, MAX_TEXT) || text(record.address, MAX_TEXT),
    address: text(record.address, MAX_TEXT),
    images,
  }
}

/** Shared by repository reads, patch projection, and the model snapshot. */
export function mapStashRow(row: StashRow, tripId: string): StashItem | null {
  const id = text(row?.id, 160)
  const decoded = parsePoiWithSource(row?.poi)
  if (!id || !decoded) return null
  const { poi, source } = decoded
  const fields = readStashFields({
    tripId: row?.trip_id,
    title: row?.title ?? source?.name,
    note: row?.note,
    category: row?.category ?? source?.category,
    createdAt: row?.created_at ?? row?.added_at,
  }, tripId)
  // Only JSON null deliberately represents a text candidate. A malformed or
  // missing POI remains corrupt, even when some explicit content is readable.
  if (poi === null && fields.title === undefined) return null
  return {
    id,
    poi,
    origin: row?.origin === 'favorite' ? 'favorite' : 'recommend',
    addedAt: text(row?.added_at, 80),
    ...fields,
  }
}

function mapFavoriteRow(row: FavoriteRow): FavoriteItem | null {
  const id = text(row?.id, 160)
  const poi = parsePoi(row?.poi)
  if (!id || !poi) return null
  return { id, poi, createdAt: text(row?.created_at, 80) }
}

function parsePoi(value: unknown): RecommendationPoi | null {
  return parsePoiWithSource(value)?.poi ?? null
}

function parsePoiWithSource(value: unknown): { poi: RecommendationPoi | null; source: Record<string, unknown> | null } | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const source: unknown = JSON.parse(value)
    if (source === null) return { poi: null, source: null }
    const poi = normalizePoi(source)
    return poi ? { poi, source: source as Record<string, unknown> } : null
  } catch {
    return null
  }
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function finite(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}
