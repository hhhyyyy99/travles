import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { TripRepository } from '../trips/repository.js'
import { readJsonBody } from '../http/body.js'
import { normalizePoi, RecommendationsRepository } from './repository.js'
import { refreshTripLegs } from './route.js'
import type { ItemsAdminStoreDriver } from '../items-admin/types.js'
import type { PoiSearch, RecommendationPoi, RouteLegSearch } from './types.js'

export type RecommendationsRouteOptions = {
  tripRepository: TripRepository
  resolveStore: () => Promise<import('./types.js').RecommendationsStoreDriver>
  searchPoi: PoiSearch
  routeLegs?: RouteLegSearch
  resolveItemsStore?: () => Promise<ItemsAdminStoreDriver>
  /** Broadcast successful stash/favorite writes to open workbenches. */
  onTripUpdated?: (tripId: string, reason: string) => Promise<void> | void
}

/** Mounts the ticket 15 POI recommendation, stash, and favorite APIs. */
export function mountRecommendationsRoutes(app: Hono<AppEnv>, options: RecommendationsRouteOptions): void {
  const repository = async (): Promise<RecommendationsRepository> => new RecommendationsRepository(await options.resolveStore())

  app.get('/api/trips/:id/recommendations', async (c) => {
    if (await options.tripRepository.get(c.req.param('id')) === null) return c.json({ error: '行程不存在' }, 404)
    const snapshot = await (await repository()).snapshot(c.req.param('id'))
    const recommendations = uniquePois(snapshot)
    return c.json({ recommendations, pois: recommendations, ...snapshot })
  })

  // Narrow list aliases keep the API convenient for docked panels and are
  // backed by the same aggregate snapshot as the map endpoint.
  app.get('/api/trips/:id/stash', async (c) => {
    if (await options.tripRepository.get(c.req.param('id')) === null) return c.json({ error: '行程不存在' }, 404)
    return c.json({ stash: (await (await repository()).snapshot(c.req.param('id'))).stash })
  })

  app.get('/api/trips/:id/favorites', async (c) => {
    if (await options.tripRepository.get(c.req.param('id')) === null) return c.json({ error: '行程不存在' }, 404)
    return c.json({ favorites: (await (await repository()).snapshot(c.req.param('id'))).favorites })
  })

  app.get('/api/trips/:id/recommendations/search', async (c) => {
    if (await options.tripRepository.get(c.req.param('id')) === null) return c.json({ error: '行程不存在' }, 404)
    const query = (c.req.query('query') ?? c.req.query('q') ?? '').trim()
    const region = (c.req.query('region') ?? '').trim()
    const type = (c.req.query('type') ?? '').trim() as RecommendationPoi['type'] | ''
    if (type && !['attraction', 'food', 'stay', 'other'].includes(type)) {
      return c.json({ error: '推荐类型无效' }, 400)
    }
    if (!query && !region && !type) return c.json({ recommendations: [], pois: [] })
    try {
      const recommendations = await options.searchPoi({ query, ...(region ? { region } : {}), ...(type ? { type } : {}) })
      const result = uniquePois({ stash: [], favorites: [] }, recommendations)
      return c.json({ recommendations: result, pois: result })
    } catch {
      return c.json({ recommendations: [], pois: [], error: '推荐点位暂不可用' }, 200)
    }
  })

  // Item-admin mutations keep the quick local estimate. This explicit refresh
  // path upgrades those rows when a real routing provider is configured; a
  // pending provider response leaves the existing numbers untouched.
  if (options.resolveItemsStore) {
    app.post('/api/trips/:id/legs/refresh', async (c) => {
      const tripId = c.req.param('id')
      if (await options.tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
      const result = await refreshTripLegs(await options.resolveItemsStore!(), tripId, options.routeLegs)
      if (!result.ok) return c.json({ error: result.error }, 500)
      return c.json({ legs: result.legs })
    })
  }

  app.post('/api/trips/:id/stash', async (c) => {
    return writeWithTrip(c, options, async (repo, tripId, body) => {
      const result = await repo.addStash(tripId, body.poi, body.origin)
      if (!result.ok) return resultResponse(c, result)
      await notifyTripUpdated(options, tripId, 'stash_added')
      return c.json({ item: result.value }, 201)
    })
  })

  app.delete('/api/trips/:id/stash/:stashId', async (c) => {
    return writeWithTrip(c, options, async (repo, tripId) => {
      const result = await repo.removeStash(tripId, c.req.param('stashId'))
      if (!result.ok) return resultResponse(c, result)
      await notifyTripUpdated(options, tripId, 'stash_deleted')
      return c.json({ ok: true })
    })
  })

  app.post('/api/trips/:id/favorites', async (c) => {
    return writeWithTrip(c, options, async (repo, tripId, body) => {
      const result = await repo.addFavorite(tripId, body.poi)
      if (!result.ok) return resultResponse(c, result)
      await notifyTripUpdated(options, tripId, 'favorite_added')
      return c.json({ favorite: result.value }, 201)
    })
  })

  app.delete('/api/trips/:id/favorites/:favoriteId', async (c) => {
    return writeWithTrip(c, options, async (repo, tripId) => {
      const result = await repo.removeFavorite(tripId, c.req.param('favoriteId'))
      if (!result.ok) return resultResponse(c, result)
      await notifyTripUpdated(options, tripId, 'favorite_deleted')
      return c.json({ ok: true })
    })
  })
}

async function notifyTripUpdated(options: RecommendationsRouteOptions, tripId: string, reason: string): Promise<void> {
  try {
    await options.onTripUpdated?.(tripId, reason)
  } catch {
    // A notification subscriber must never turn a committed write into a
    // failed response. The next snapshot will still expose the saved row.
  }
}

async function writeWithTrip(
  c: Context<AppEnv>,
  options: RecommendationsRouteOptions,
  action: (repo: RecommendationsRepository, tripId: string, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  const tripId = c.req.param('id') ?? ''
  if (await options.tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
  const body = await readJsonBody(c)
  // DELETE routes intentionally have no body; POST routes still reject an
  // empty or malformed JSON payload at the HTTP boundary.
  if (body === null && c.req.method !== 'DELETE') return c.json({ error: '请求体必须是有效的 JSON' }, 400)
  return action(new RecommendationsRepository(await options.resolveStore()), tripId, body ?? {})
}

function resultResponse(c: Context<AppEnv>, result: { ok: false; error: string; code: string }): Response {
  const status = result.code === 'not_found' ? 404 : result.code === 'storage' ? 500 : 400
  return c.json({ error: result.error }, status)
}

function uniquePois(snapshot: { stash: Array<{ poi: RecommendationPoi }>; favorites: Array<{ poi: RecommendationPoi }> }, extra: RecommendationPoi[] = []): RecommendationPoi[] {
  const values = [...extra, ...snapshot.stash.map((entry) => entry.poi), ...snapshot.favorites.map((entry) => entry.poi)]
  const seen = new Set<string>()
  const normalizedPois: RecommendationPoi[] = []
  for (const poi of values) {
    const normalized = normalizePoi(poi)
    if (!normalized) continue
    const key = normalized.amapId || normalized.id || `${normalized.name}|${normalized.lat}|${normalized.lng}`
    if (seen.has(key)) continue
    seen.add(key)
    normalizedPois.push(normalized)
  }
  return normalizedPois
}
