/**
 * Tools-panel HTTP routes (ticket 14) — notes / checklist / gallery CRUD for
 * the dockable canvas panels, mounted onto the app with a single hunk from
 * app.ts so parallel tickets editing app.ts stay merge-friendly.
 *
 * Route conventions (mirror the ticket 02/03 routes): {error} bodies, 404 for
 * an unknown trip, 400 for invalid payloads, and the tolerant repository
 * failure classes mapped through the same status rule as tripError().
 *
 *   GET    /api/trips/:id/notes                    → {notes}
 *   POST   /api/trips/:id/notes {content?}         → 201 {note}
 *   PATCH  /api/trips/:id/notes/:noteId {content}  → {note}
 *   DELETE /api/trips/:id/notes/:noteId            → {ok:true}
 *   GET    /api/trips/:id/checklist                → {items}   (incl. migrated rows)
 *   POST   /api/trips/:id/checklist {content}      → 201 {item}
 *   PATCH  /api/trips/:id/checklist/:entryId {done?, content?} → {item}
 *   DELETE /api/trips/:id/checklist/:entryId       → {ok:true}
 *   GET    /api/trips/:id/gallery                  → {images}  (manual uploads)
 *   POST   /api/trips/:id/gallery {url, caption?, itemId?} → 201 {image}
 *   DELETE /api/trips/:id/gallery/:imageId         → {ok:true}
 */
import type { Hono } from 'hono'
import type { HonoBindings, HonoVariables } from '@mastra/hono'
import type { TripRepository } from '../trips/repository.js'
import { ToolsRepository } from './repository.js'
import type { ToolsStoreDriver } from './types.js'

export type ToolsApp = Hono<{ Bindings: HonoBindings; Variables: HonoVariables }>

export type ToolsRouteDeps = {
  tripRepository: TripRepository
  /** Resolved lazily by app.ts (injected driver in tests, SQLite otherwise). */
  resolveToolsStore: () => Promise<ToolsStoreDriver>
}

export function mountToolsRoutes(app: ToolsApp, deps: ToolsRouteDeps): void {
  const repository = () => deps.resolveToolsStore().then((store) => new ToolsRepository(store))

  const withTrip = async (
    c: { req: { param(name: string): string }; json(body: unknown, status?: number): Response },
    run: (tripId: string, tools: ToolsRepository) => Promise<Response>,
  ): Promise<Response> => {
    const tripId = c.req.param('id')
    const trip = await deps.tripRepository.get(tripId)
    if (trip === null) return c.json({ error: '行程不存在' }, 404)
    return run(tripId, await repository())
  }

  // ---- Notes (便签) ---------------------------------------------------------

  app.get('/api/trips/:id/notes', (c) =>
    withTrip(c, (tripId, tools) => tools.listNotes(tripId).then((notes) => c.json({ notes }))),
  )

  app.post('/api/trips/:id/notes', (c) =>
    withTrip(c, async (tripId, tools) => {
      const body = await readJsonBody(c)
      if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
      if (body.content !== undefined && typeof body.content !== 'string') {
        return c.json({ error: '便签内容无效' }, 400)
      }
      const content = typeof body.content === 'string' ? body.content : ''
      const result = await tools.createNote(tripId, content)
      return toolsWrite(c, result, 201)
    }),
  )

  app.patch('/api/trips/:id/notes/:noteId', (c) =>
    withTrip(c, async (tripId, tools) => {
      const body = await readJsonBody(c)
      if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
      if (typeof body.content !== 'string') return c.json({ error: '便签内容无效' }, 400)
      const result = await tools.updateNote(tripId, c.req.param('noteId'), body.content)
      return toolsWrite(c, result)
    }),
  )

  app.delete('/api/trips/:id/notes/:noteId', (c) =>
    withTrip(c, async (tripId, tools) => toolsWrite(c, await tools.deleteNote(tripId, c.req.param('noteId')))),
  )

  // ---- Checklist (清单) — shares the ticket-03 table incl. migrated rows ----

  app.get('/api/trips/:id/checklist', (c) =>
    withTrip(c, (tripId, tools) => tools.listChecklist(tripId).then((items) => c.json({ items }))),
  )

  app.post('/api/trips/:id/checklist', (c) =>
    withTrip(c, async (tripId, tools) => {
      const body = await readJsonBody(c)
      if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
      const content = typeof body.content === 'string' ? body.content.trim() : ''
      if (!content) return c.json({ error: '清单内容不能为空' }, 400)
      const result = await tools.createChecklistEntry(tripId, content)
      return toolsWrite(c, result, 201)
    }),
  )

  app.patch('/api/trips/:id/checklist/:entryId', (c) =>
    withTrip(c, async (tripId, tools) => {
      const body = await readJsonBody(c)
      if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
      const patch: { done?: boolean; content?: string } = {}
      if ('done' in body) patch.done = body.done === true
      if ('content' in body) {
        if (typeof body.content !== 'string') return c.json({ error: '清单内容无效' }, 400)
        patch.content = body.content
      }
      if (patch.done === undefined && patch.content === undefined) {
        return c.json({ error: '没有可更新的字段' }, 400)
      }
      const result = await tools.updateChecklistEntry(tripId, c.req.param('entryId'), patch)
      return toolsWrite(c, result)
    }),
  )

  app.delete('/api/trips/:id/checklist/:entryId', (c) =>
    withTrip(c, async (tripId, tools) =>
      toolsWrite(c, await tools.deleteChecklistEntry(tripId, c.req.param('entryId'))),
    ),
  )

  // ---- Gallery (图库) — manual uploads; card images are aggregated client-side

  app.get('/api/trips/:id/gallery', (c) =>
    withTrip(c, (tripId, tools) => tools.listGallery(tripId).then((images) => c.json({ images }))),
  )

  app.post('/api/trips/:id/gallery', (c) =>
    withTrip(c, async (tripId, tools) => {
      const body = await readJsonBody(c)
      if (body === null) return c.json({ error: '请求体必须是有效的 JSON' }, 400)
      if (typeof body.url !== 'string') return c.json({ error: '图片必须是 http(s) 链接或 5MB 以内的图片数据' }, 400)
      const result = await tools.addGalleryImage(tripId, {
        url: body.url,
        caption: typeof body.caption === 'string' ? body.caption : undefined,
        itemId: typeof body.itemId === 'string' ? body.itemId : null,
      })
      return toolsWrite(c, result, 201)
    }),
  )

  app.delete('/api/trips/:id/gallery/:imageId', (c) =>
    withTrip(c, async (tripId, tools) =>
      toolsWrite(c, await tools.deleteGalleryImage(tripId, c.req.param('imageId'))),
    ),
  )
}

/** Map a repository failure class to its HTTP status (mirrors app.ts tripError). */
function toolsWrite(
  c: { json(body: unknown, status?: number): Response },
  result: { ok: true; note?: unknown; item?: unknown; image?: unknown } | { ok: false; error: string; code: string },
  createdStatus?: number,
): Response {
  if (result.ok) {
    const body = result.note
      ? { note: result.note }
      : result.item
        ? { item: result.item }
        : result.image
          ? { image: result.image }
          : { ok: true }
    return c.json(body, createdStatus ?? 200)
  }
  const status = result.code === 'not_found' ? 404 : result.code === 'storage' ? 500 : 400
  return c.json({ error: result.error }, status)
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
