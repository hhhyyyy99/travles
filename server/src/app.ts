import { Hono } from 'hono'
import { MastraServer, type HonoBindings, type HonoVariables } from '@mastra/hono'
import { fileURLToPath } from 'node:url'
import { mastra } from './mastra.js'
import { readServerVersion } from './version.js'
import { createSqliteTripRepository } from './trips/factory.js'
import { TripRepository } from './trips/repository.js'
import { TripContentRepository } from './content/repository.js'
import { seedBuiltinTrip } from './seed/seed.js'
import type { TripUpdate } from './trips/types.js'

export type AppEnv = {
  Bindings: HonoBindings
  Variables: HonoVariables
}

export type CreateAppOptions = {
  /** Injected trip repository (tests use the in-memory driver). */
  tripRepository?: TripRepository
  /**
   * Injected days/items/checklist repository (ticket 03). Only meaningful
   * together with `tripRepository`; the SQLite path builds both from one db.
   */
  contentRepository?: TripContentRepository
  /** SQLite file URL for the default repository (env: TRIPS_DB_PATH). */
  databaseUrl?: string
  /**
   * Seed the built-in example trip (ticket 03) on startup. Defaults to true
   * only on the default production startup path (no injected repository, no
   * explicit `databaseUrl`) — an explicit `databaseUrl` means "attach to this
   * db as-is" (used by tests and self-managed deployments). Idempotent: the
   * app_meta marker makes repeat startups no-ops.
   */
  seedBuiltinTrip?: boolean
}

/** Default SQLite location: <server>/data/trips.db (gitignored). */
function defaultDatabaseUrl(): string {
  return fileURLToPath(new URL('../data/trips.db', import.meta.url))
}

/**
 * Build the backend Hono app with the Mastra instance mounted via the
 * @mastra/hono server adapter (the pattern recommended by the current Mastra
 * v1 docs: https://mastra.ai/reference/server/hono-adapter).
 *
 * Mastra routes are registered by `server.init()`. Our own routes registered
 * after init() can access the mounted instance via `c.get('mastra')`.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<Hono<AppEnv>> {
  const app = new Hono<AppEnv>()

  const server = new MastraServer({ app, mastra })
  await server.init()

  let tripRepository: TripRepository
  let contentRepository: TripContentRepository | undefined

  if (options.tripRepository) {
    tripRepository = options.tripRepository
    contentRepository = options.contentRepository
  } else {
    const sqlite = await createSqliteTripRepository(
      options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
    )
    tripRepository = sqlite.repository
    contentRepository = sqlite.contentRepository
    if (options.seedBuiltinTrip ?? (options.databaseUrl === undefined)) {
      await seedBuiltinTrip(sqlite.db)
    }
  }

  // ---- Trip CRUD (ticket 02) ------------------------------------------------
  // Responses stay forward-compatible with later tickets: list/create/rename/
  // delete now, TripPatch-driven day/item writes + SSE updates later.

  app.get('/api/trips', async (c) => {
    const trips = await tripRepository.list()
    return c.json({ trips })
  })

  app.post('/api/trips', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const input = readTripFields(body)
    const result = await tripRepository.create(input)
    if (!result.ok) return tripError(c, result.error, result.code)
    return c.json({ trip: result.trip }, 201)
  })

  app.get('/api/trips/:id', async (c) => {
    const trip = await tripRepository.get(c.req.param('id'))
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    return c.json({ trip })
  })

  app.patch('/api/trips/:id', async (c) => {
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const patch = readTripFields(body)
    if (patch.title === undefined && patch.startDate === undefined && patch.endDate === undefined) {
      return c.json({ error: '没有可更新的字段' }, 400)
    }
    const result = await tripRepository.update(c.req.param('id'), patch)
    if (!result.ok) return tripError(c, result.error, result.code)
    return c.json({ trip: result.trip })
  })

  app.delete('/api/trips/:id', async (c) => {
    const result = await tripRepository.remove(c.req.param('id'))
    if (!result.ok) return tripError(c, result.error, result.code)
    return c.json({ ok: true })
  })

  // ---- Trip content (ticket 03) --------------------------------------------
  // Minimal days/items/checklist read + idempotent upsert surface, enough for
  // the built-in trip seed and the legacy localStorage migration. Tickets 04
  // (workbench canvas) and 14 (checklist/notes panels) extend from here —
  // upserts are keyed by row id, so repeats never duplicate rows.

  app.get('/api/trips/:id/days', async (c) => {
    if (!contentRepository) return contentStorageMissing(c)
    const trip = await tripRepository.get(c.req.param('id'))
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    const days = await contentRepository.listDays(c.req.param('id'))
    return c.json({ days })
  })

  app.put('/api/trips/:id/items', async (c) => {
    if (!contentRepository) return contentStorageMissing(c)
    const trip = await tripRepository.get(c.req.param('id'))
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const items = body.items
    if (!Array.isArray(items)) return c.json({ error: 'items 必须是数组' }, 400)
    let upserted = 0
    for (const entry of items) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return c.json({ error: '条目字段无效（需要 id、dayId、title）' }, 400)
      }
      const result = await contentRepository.upsertItem(c.req.param('id'), entry as Record<string, unknown>)
      if (!result.ok) return tripError(c, result.error, result.code)
      upserted += 1
    }
    return c.json({ ok: true, upserted })
  })

  app.put('/api/trips/:id/checklist', async (c) => {
    if (!contentRepository) return contentStorageMissing(c)
    const trip = await tripRepository.get(c.req.param('id'))
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const items = body.items
    if (!Array.isArray(items)) return c.json({ error: 'items 必须是数组' }, 400)
    let upserted = 0
    for (const entry of items) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        return c.json({ error: '清单条目字段无效（需要 id 与 content）' }, 400)
      }
      const result = await contentRepository.upsertChecklistEntry(c.req.param('id'), entry as Record<string, unknown>)
      if (!result.ok) return tripError(c, result.error, result.code)
      upserted += 1
    }
    return c.json({ ok: true, upserted })
  })

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      name: '@hailar/server',
      version: readServerVersion(),
      node: process.version,
      mastraReady: Boolean(c.get('mastra')),
    })
  })

  return app
}

/** Map a repository failure class to its HTTP status. */
function tripError(c: { json(body: unknown, status?: number): Response }, error: string, code: string) {
  const status = code === 'not_found' ? 404 : code === 'storage' ? 500 : 400
  return c.json({ error }, status)
}

/** Content routes need a content repository; injected-only setups may omit it. */
function contentStorageMissing(c: { json(body: unknown, status?: number): Response }) {
  return c.json({ error: '服务器未配置内容存储' }, 500)
}

/** Parse a JSON request body; null when missing/invalid (caller → 400). */
async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return null
  }
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** Pick the known trip fields off a request body (values stay unvalidated). */
function readTripFields(body: Record<string, unknown>): TripUpdate {
  const patch: TripUpdate = {}
  if ('title' in body) patch.title = body.title
  if ('startDate' in body) patch.startDate = body.startDate
  if ('endDate' in body) patch.endDate = body.endDate
  return patch
}
