import { Hono } from 'hono'
import { MastraServer, type HonoBindings, type HonoVariables } from '@mastra/hono'
import { fileURLToPath } from 'node:url'
import { createMastra, modelConfigFromEnv } from './mastra.js'
import type { MastraModelConfig } from '@mastra/core/llm'
import type { MastraMemory } from '@mastra/core/memory'
import { readServerVersion } from './version.js'
import { createSqliteTripRepository } from './trips/factory.js'
import type { SqlDatabase } from './db/driver.js'
import { TripRepository } from './trips/repository.js'
import { TripContentRepository } from './content/repository.js'
import { seedBuiltinTrip } from './seed/seed.js'
import { createSqliteWorkbenchStore } from './days/driver-sqlite.js'
import { readTripCanvas } from './days/repository.js'
import type { WorkbenchStoreDriver } from './days/types.js'
import { DaysAdminRepository } from './days-admin/repository.js'
import { createSqliteDaysAdminStore } from './days-admin/driver-sqlite.js'
import type { DaysAdminStoreDriver } from './days-admin/types.js'
import { ItemsAdminRepository } from './items-admin/repository.js'
import { createSqliteItemsAdminStore } from './items-admin/driver-sqlite.js'
import type { ItemsAdminStoreDriver } from './items-admin/types.js'
import type { TripUpdate } from './trips/types.js'
import { mountToolsRoutes } from './tools/routes.js'
import { createSqliteToolsStore } from './tools/driver-sqlite.js'
import type { ToolsStoreDriver } from './tools/types.js'
import { ChatMessageRepository } from './chat/repository.js'
import { MemoryMessageStoreDriver } from './chat/driver-memory.js'
import { SqliteMessageStoreDriver } from './chat/driver-sqlite.js'
import type { MessageStoreDriver } from './chat/types.js'
import { registerChatRoutes } from './chat/routes.js'
import { readJsonBody } from './http/body.js'
import { registerAiProposalRoutes } from './ai-proposals/routes.js'
import { MemoryAiProposalStore } from './ai-proposals/types.js'
// ---- TripPatch writes (ticket 08, additive) --------------------------------
import { createSqliteTripPatchStore } from './trip-patch/store-sqlite.js'
import type { TripPatchStoreDriver } from './trip-patch/types.js'
import { createSqliteRecommendationsStore } from './recommendations/driver-sqlite.js'
import type { PoiSearch, RecommendationsStoreDriver } from './recommendations/types.js'
import { mountRecommendationsRoutes } from './recommendations/routes.js'
import { searchAmapPoi } from './recommendations/search.js'

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
  /**
   * Injected read-only workbench store (ticket 04; tests use the in-memory
   * driver). Defaults to the same SQLite database the trip repository opens,
   * resolved lazily on first canvas read so pure in-memory apps never open
   * a database file.
   */
  workbenchStore?: WorkbenchStoreDriver
  /**
   * Injected tools store (ticket 14; tests use the in-memory driver).
   * Defaults to the same SQLite database the trip repository opens, resolved
   * lazily on first tools read so pure in-memory apps never open a file.
   */
  toolsStore?: ToolsStoreDriver
  /**
   * Injected language model for the planner agent (ticket 06; tests pass a
   * mock model here per spec 测试接缝 #1). Defaults to the AI_* env routing.
   */
  plannerModel?: MastraModelConfig
  /**
   * Injected agent memory (ticket 06; tests pass a MastraMemory over an
   * in-memory store). Defaults to Mastra Memory over the same SQLite
   * database (default startup path only).
   */
  plannerMemory?: MastraMemory
  /**
   * Injected chat message store (ticket 06; tests use the in-memory driver).
   * Defaults to the same SQLite database the trip repository opens.
   */
  messageStore?: MessageStoreDriver
  /**
   * Injected day-admin write store (ticket 10; tests use the in-memory
   * driver). Defaults to the same SQLite database the trip repository opens,
   * resolved lazily like `workbenchStore` so pure in-memory apps never open
   * a database file.
   */
  daysAdminStore?: DaysAdminStoreDriver
  /**
   * Injected card-editing write store (ticket 09; tests use the in-memory
   * driver). Defaults to the same SQLite database the trip repository opens,
   * resolved lazily like `daysAdminStore`.
   */
  itemsAdminStore?: ItemsAdminStoreDriver
  /**
   * Injected TripPatch write store (ticket 08; tests use the in-memory
   * driver). Backs the `apply_trip_patch` tool — the planner model's only
   * write channel to trip data. Defaults to the same SQLite database the
   * trip repository opens, resolved lazily like `workbenchStore`.
   */
  tripPatchStore?: TripPatchStoreDriver
  /** Injected `search_poi` provider for tests; production uses AMap Web Service. */
  searchPoi?: PoiSearch
  /** Injected stash/favorites store; defaults to the shared SQLite database. */
  recommendationsStore?: RecommendationsStoreDriver
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

  const mastra = createMastra({
    model: options.plannerModel,
    memory: options.plannerMemory,
    // The default memory store points at the app database — but only on the
    // default (SQLite) startup path; pure in-memory test apps without an
    // injected memory run the agent without recall instead of opening a file.
    databaseUrl: options.tripRepository ? undefined : options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
    // Ticket 08: the apply_trip_patch tool resolves its store lazily on first
    // patch (the SQLite path opens the shared database only when actually hit).
    resolveTripPatchStore: resolveTripPatchStore,
    searchPoi: options.searchPoi ?? searchAmapPoi,
  })
  const memoryConfigured = options.plannerMemory !== undefined || !options.tripRepository

  const server = new MastraServer({ app, mastra })
  await server.init()

  // ---- Workbench canvas read (ticket 04, additive) --------------------------
  // Read-only day/item/leg reads for the three-column workbench. Resolved
  // lazily so in-memory test apps never open SQLite; when the default is
  // used it reuses the same database file the trip repository opened.
  let workbenchStore = options.workbenchStore ?? null
  let workbenchDb: SqlDatabase | null = null
  const resolveWorkbenchStore = async (): Promise<WorkbenchStoreDriver> => {
    if (workbenchStore) return workbenchStore
    if (!workbenchDb) {
      const created = await createSqliteTripRepository(
        options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
      )
      workbenchDb = created.db
    }
    workbenchStore = createSqliteWorkbenchStore(workbenchDb)
    return workbenchStore
  }

  // ---- Day-admin writes (ticket 10, additive) -------------------------------
  // Create / theme-update / cascade-delete for workbench days. Resolved
  // lazily like the workbench store; the default shares the same SQLite db.
  let daysAdminStore = options.daysAdminStore ?? null
  const resolveDaysAdminStore = async (): Promise<DaysAdminStoreDriver> => {
    if (daysAdminStore) return daysAdminStore
    if (!workbenchDb) {
      if (options.workbenchStore) {
        // The workbench store was injected (no db opened yet); open the
        // default database ourselves, same rule as the workbench default.
        const created = await createSqliteTripRepository(
          options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
        )
        workbenchDb = created.db
      } else {
        await resolveWorkbenchStore()
      }
    }
    daysAdminStore = createSqliteDaysAdminStore(workbenchDb as NonNullable<typeof workbenchDb>)
    return daysAdminStore
  }

  // ---- TripPatch writes (ticket 08, additive) -------------------------------
  // Store behind the apply_trip_patch tool (the model's only write channel to
  // trip data). Resolved like the workbench store: an injected driver in
  // tests, else lazily over the same SQLite database. No TripPatch code runs
  // unless a model actually calls the tool.
  let tripPatchStore = options.tripPatchStore ?? null
  let tripPatchDb: SqlDatabase | null = null
  async function resolveTripPatchStore(): Promise<TripPatchStoreDriver> {
    if (tripPatchStore) return tripPatchStore
    if (!tripPatchDb) {
      if (workbenchDb) {
        tripPatchDb = workbenchDb
      } else {
        const created = await createSqliteTripRepository(
          options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
        )
        tripPatchDb = created.db
      }
    }
    tripPatchStore = createSqliteTripPatchStore(tripPatchDb)
    return tripPatchStore
  }

  let tripRepository: TripRepository
  let contentRepository: TripContentRepository | undefined
  let messageStore: MessageStoreDriver | null = options.messageStore ?? null

  if (options.tripRepository) {
    tripRepository = options.tripRepository
    contentRepository = options.contentRepository
  } else {
    const sqlite = await createSqliteTripRepository(
      options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
    )
    tripRepository = sqlite.repository
    contentRepository = sqlite.contentRepository
    workbenchDb = sqlite.db
    workbenchStore = createSqliteWorkbenchStore(sqlite.db)
    messageStore = new SqliteMessageStoreDriver(sqlite.db)
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

  app.get('/api/trips/:id/canvas', async (c) => {
    const trip = await tripRepository.get(c.req.param('id'))
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    const canvas = await readTripCanvas(await resolveWorkbenchStore(), c.req.param('id'))
    return c.json({ trip, ...canvas })
  })

  // ---- Tools panels: notes / checklist / gallery (ticket 14, additive) ------
  // Dockable canvas-side panels (便签/清单/图库). The store is resolved like
  // the workbench store: an injected driver in tests, else lazily over the
  // same SQLite database. All routes live in server/src/tools/routes.ts so
  // this file only carries this one hunk.
  let toolsStore = options.toolsStore ?? null
  let toolsDb: SqlDatabase | null = null
  const resolveToolsStore = async (): Promise<ToolsStoreDriver> => {
    if (toolsStore) return toolsStore
    if (!toolsDb) {
      const created = await createSqliteTripRepository(
        options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
      )
      toolsDb = created.db
    }
    toolsStore = createSqliteToolsStore(toolsDb)
    return toolsStore
  }
  mountToolsRoutes(app, { tripRepository, resolveToolsStore })

  // ---- Recommendations / stash / favorites (ticket 15) ---------------------
  // The map consumes one aggregate snapshot; mutations remain separate so a
  // favorite can be removed without dropping a recommendation that is still
  // in the pending pool.
  let recommendationsStore = options.recommendationsStore ?? null
  let recommendationsDb: SqlDatabase | null = workbenchDb
  const resolveRecommendationsStore = async (): Promise<RecommendationsStoreDriver> => {
    if (recommendationsStore) return recommendationsStore
    if (!recommendationsDb) {
      const created = await createSqliteTripRepository(
        options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
      )
      recommendationsDb = created.db
    }
    recommendationsStore = createSqliteRecommendationsStore(recommendationsDb)
    return recommendationsStore
  }
  mountRecommendationsRoutes(app, {
    tripRepository,
    resolveStore: resolveRecommendationsStore,
    searchPoi: options.searchPoi ?? searchAmapPoi,
  })

  // ---- Day management writes (ticket 10, additive) --------------------------
  // POST   /api/trips/:id/days           create a day (next date / empty body OK)
  // PATCH  /api/trips/:id/days/:dayId    update theme (and color)
  // DELETE /api/trips/:id/days/:dayId    delete the day, its items and legs

  app.post('/api/trips/:id/days', async (c) => {
    const tripId = c.req.param('id')
    const trip = await tripRepository.get(tripId)
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    // The body is optional for create-day (default: append after the last day).
    const body = (await readJsonBody(c)) ?? {}
    const result = await new DaysAdminRepository(await resolveDaysAdminStore()).createDay(tripId, {
      date: body.date,
      theme: body.theme,
      color: body.color,
    })
    if (!result.ok) return tripError(c, result.error, result.code)
    return c.json({ day: result.day }, 201)
  })

  app.patch('/api/trips/:id/days/:dayId', async (c) => {
    const tripId = c.req.param('id')
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const patch: { theme?: unknown; color?: unknown } = {}
    if ('theme' in body) patch.theme = body.theme
    if ('color' in body) patch.color = body.color
    const result = await new DaysAdminRepository(await resolveDaysAdminStore()).updateDay(
      tripId,
      c.req.param('dayId'),
      patch,
    )
    if (!result.ok) return tripError(c, result.error, result.code)
    return c.json({ day: result.day })
  })

  app.delete('/api/trips/:id/days/:dayId', async (c) => {
    const result = await new DaysAdminRepository(await resolveDaysAdminStore()).deleteDay(
      c.req.param('id'),
      c.req.param('dayId'),
    )
    if (!result.ok) return tripError(c, result.error, result.code)
    return c.json({ ok: true, removedItems: result.removedItems })
  })

  // ---- Card editing writes (ticket 09, additive) ----------------------------
  // POST   /api/trips/:id/items                 create a card (free text or POI)
  // POST   /api/trips/:id/items/:itemId/move    reorder within / across days
  // POST   /api/trips/:id/items/:itemId/copy    duplicate into a (new) day
  // PATCH  /api/trips/:id/items/:itemId         edit title / note / images
  // DELETE /api/trips/:id/items/:itemId         remove the card
  //
  // Every layout mutation recomputes the trip's legs server-side
  // (items-admin/legs.ts: reuse stored pair legs, else haversine × 1.2
  // straight-line estimates, else an empty 0/0 leg) and answers with the new
  // leg list so the workbench map updates without a second canvas read.
  // Successful manual edits append a lightweight 'system' message to the
  // trip's chat thread via ChatMessageRepository.recordSystemMessage —
  // no-throw, so the edit UX never depends on chat storage.
  let itemsAdminStore = options.itemsAdminStore ?? null
  const resolveItemsAdminStore = async (): Promise<ItemsAdminStoreDriver> => {
    if (itemsAdminStore) return itemsAdminStore
    if (!workbenchDb) {
      if (options.workbenchStore) {
        const created = await createSqliteTripRepository(
          options.databaseUrl ?? process.env.TRIPS_DB_PATH ?? defaultDatabaseUrl(),
        )
        workbenchDb = created.db
      } else {
        await resolveWorkbenchStore()
      }
    }
    itemsAdminStore = createSqliteItemsAdminStore(workbenchDb as NonNullable<typeof workbenchDb>)
    return itemsAdminStore
  }
  // Tolerant system-message seam; injected-only setups without a message
  // store fall back to the same process-lifetime memory driver chat uses.
  const systemMessages = new ChatMessageRepository(messageStore ?? new MemoryMessageStoreDriver())

  app.post('/api/trips/:id/items', async (c) => {
    const tripId = c.req.param('id')
    if (await tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const result = await new ItemsAdminRepository(await resolveItemsAdminStore()).createItem(tripId, body)
    if (!result.ok) return tripError(c, result.error, result.code)
    await systemMessages.recordSystemMessage(tripId, `手动添加卡片「${result.item.title}」`)
    return c.json({ item: result.item, legs: result.legs }, 201)
  })

  app.post('/api/trips/:id/items/:itemId/move', async (c) => {
    const tripId = c.req.param('id')
    if (await tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
    const body = (await readJsonBody(c)) ?? {}
    const result = await new ItemsAdminRepository(await resolveItemsAdminStore()).moveItem(
      tripId,
      c.req.param('itemId'),
      body,
    )
    if (!result.ok) return tripError(c, result.error, result.code)
    await systemMessages.recordSystemMessage(tripId, `手动调整顺序：移动卡片「${result.item.title}」`)
    return c.json({ item: result.item, legs: result.legs })
  })

  app.post('/api/trips/:id/items/:itemId/copy', async (c) => {
    const tripId = c.req.param('id')
    if (await tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
    const body = (await readJsonBody(c)) ?? {}
    const result = await new ItemsAdminRepository(await resolveItemsAdminStore()).copyItem(
      tripId,
      c.req.param('itemId'),
      body,
    )
    if (!result.ok) return tripError(c, result.error, result.code)
    await systemMessages.recordSystemMessage(tripId, `手动复制卡片「${result.item.title}」`)
    return c.json({ item: result.item, legs: result.legs }, 201)
  })

  app.patch('/api/trips/:id/items/:itemId', async (c) => {
    const tripId = c.req.param('id')
    if (await tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
    const body = await readJsonBody(c)
    if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
    const patch: { title?: unknown; note?: unknown; images?: unknown } = {}
    if ('title' in body) patch.title = body.title
    if ('note' in body) patch.note = body.note
    if ('images' in body) patch.images = body.images
    if (patch.title === undefined && patch.note === undefined && patch.images === undefined) {
      return c.json({ error: '没有可更新的字段' }, 400)
    }
    const result = await new ItemsAdminRepository(await resolveItemsAdminStore()).updateItem(
      tripId,
      c.req.param('itemId'),
      patch,
    )
    if (!result.ok) return tripError(c, result.error, result.code)
    await systemMessages.recordSystemMessage(tripId, `手动编辑卡片「${result.item.title}」`)
    return c.json({ item: result.item })
  })

  app.delete('/api/trips/:id/items/:itemId', async (c) => {
    const tripId = c.req.param('id')
    if (await tripRepository.get(tripId) === null) return c.json({ error: '行程不存在' }, 404)
    const result = await new ItemsAdminRepository(await resolveItemsAdminStore()).deleteItem(
      tripId,
      c.req.param('itemId'),
    )
    if (!result.ok) return tripError(c, result.error, result.code)
    await systemMessages.recordSystemMessage(tripId, `手动删除卡片`)
    return c.json({ ok: true, legs: result.legs })
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

  // ---- AI chat, qa round (ticket 06, additive) ------------------------------
  // POST /api/trips/:id/messages streams the planner agent's reply over SSE
  // and persists user+assistant turns in the messages table; GET returns the
  // per-trip history. Injected-only setups without a message store fall back
  // to the in-memory driver (process-lifetime persistence), which is enough
  // for agent-driven tests that don't care about the messages table. Event
  // schema is documented at the top of chat/routes.ts.
  const messageRepository =
    messageStore !== null
      ? new ChatMessageRepository(messageStore)
      : new ChatMessageRepository(new MemoryMessageStoreDriver())

  registerChatRoutes(app, {
    tripRepository,
    messages: messageRepository,
    planner: mastra.getAgent('planner'),
    modelConfigured: options.plannerModel !== undefined || modelConfigFromEnv() !== null,
    memoryConfigured,
    resolveTripPatchStore,
  })

  // Ticket 13: AI proposals are read-only until the user confirms them. The
  // process-local store is intentional: a proposal is a short-lived preview,
  // while the applied TripPatch remains the durable source of truth.
  registerAiProposalRoutes(app, {
    tripRepository,
    planner: mastra.getAgent('planner'),
    modelConfigured: options.plannerModel !== undefined || modelConfigFromEnv() !== null,
    memoryConfigured,
    resolveTripPatchStore,
    proposalStore: new MemoryAiProposalStore(),
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

/** Pick the known trip fields off a request body (values stay unvalidated). */
function readTripFields(body: Record<string, unknown>): TripUpdate {
  const patch: TripUpdate = {}
  if ('title' in body) patch.title = body.title
  if ('startDate' in body) patch.startDate = body.startDate
  if ('endDate' in body) patch.endDate = body.endDate
  return patch
}
