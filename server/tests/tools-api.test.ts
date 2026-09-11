/**
 * Tools HTTP tests (ticket 14) — notes / checklist / gallery routes over the
 * seeded SQLite database via app.request(): 404 unknown trip, 400 invalid
 * payloads, checklist visibility + toggle of the migrated legacy rows, and
 * restart persistence (the upserted/added rows survive re-attaching the db).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../src/app.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import { seedBuiltinTrip } from '../src/seed/seed.js'
import { BUILTIN_TRIP_ID } from '../src/seed/builtin-trip-data.js'

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

/**
 * Full default stack against one temp SQLite file: seed it through the
 * factory, close it, then let createApp attach (the same pattern as the
 * content-api restart test) so the tools routes exercise the SQLite driver.
 */
async function setup(): Promise<{ app: Awaited<ReturnType<typeof createApp>>; url: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tools-api-'))
  const url = `file:${join(dir, 'trips.db')}`
  const sqlite = await createSqliteTripRepository(url)
  await seedBuiltinTrip(sqlite.db)
  await sqlite.close()
  const app = await createApp({ databaseUrl: url })
  return { app, url, dir }
}

test('notes CRUD over HTTP: create, list, patch, delete', async () => {
  const { app, dir } = await setup()
  try {
    const created = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/notes`, jsonRequest('POST', { content: '带抓绒外套' }))
    assert.equal(created.status, 201)
    const note = ((await created.json()) as { note: { id: string; content: string } }).note
    assert.equal(note.content, '带抓绒外套')

    const patched = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/notes/${note.id}`, jsonRequest('PATCH', { content: '带抓绒外套 + 手套' }))
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { note: { content: string } }).note.content, '带抓绒外套 + 手套')

    const list = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/notes`)
    assert.equal(list.status, 200)
    assert.equal(((await list.json()) as { notes: unknown[] }).notes.length, 1)

    const removed = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/notes/${note.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)

    const missingNote = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/notes/${note.id}`, jsonRequest('PATCH', { content: 'x' }))
    assert.equal(missingNote.status, 404)
    const invalidBody = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/notes`, jsonRequest('POST', { content: 42 }))
    assert.equal(invalidBody.status, 400, 'non-string content is rejected as too long/invalid')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checklist GET lists migrated legacy rows; PATCH toggles; DELETE removes', async () => {
  const { app, dir } = await setup()
  try {
    // Simulate the ticket-03 migration having run: PUT the legacy rows.
    const migrate = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist`, jsonRequest('PUT', {
      items: [
        { id: 'legacy-checklist-0', content: '确认海拉尔机场同点取还车', done: true },
        { id: 'legacy-checklist-1', content: '订好 6 晚住宿、莫尔道嘎与黑山头问供暖', done: false },
      ],
    }))
    assert.equal(migrate.status, 200)

    const list = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist`)
    assert.equal(list.status, 200)
    const { items } = (await list.json()) as { items: Array<{ id: string; content: string; done: boolean }> }
    assert.deepEqual(
      items.map((item) => [item.id, item.done]),
      [
        ['legacy-checklist-0', true],
        ['legacy-checklist-1', false],
      ],
    )

    const toggled = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist/legacy-checklist-1`, jsonRequest('PATCH', { done: true }))
    assert.equal(toggled.status, 200)
    const item = ((await toggled.json()) as { item: { done: boolean } }).item
    assert.equal(item.done, true)

    const added = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist`, jsonRequest('POST', { content: '提前 2 天预约莫尔格勒河' }))
    assert.equal(added.status, 201)
    const addedItem = ((await added.json()) as { item: { id: string } }).item
    const removed = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist/${addedItem.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)

    const noFields = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist/legacy-checklist-1`, jsonRequest('PATCH', {}))
    assert.equal(noFields.status, 400)
    const emptyContent = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist`, jsonRequest('POST', { content: '  ' }))
    assert.equal(emptyContent.status, 400)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('gallery POST validates URLs, lists and deletes', async () => {
  const { app, dir } = await setup()
  try {
    const added = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/gallery`, jsonRequest('POST', {
      url: TINY_PNG,
      caption: '手拍草原',
      itemId: 'builtin-item-1-1',
    }))
    assert.equal(added.status, 201)
    const image = ((await added.json()) as { image: { id: string; url: string } }).image
    assert.equal(image.url, TINY_PNG)

    const bad = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/gallery`, jsonRequest('POST', { url: 'data:text/html;base64,PGI+' }))
    assert.equal(bad.status, 400)
    const missingUrl = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/gallery`, jsonRequest('POST', { caption: 'x' }))
    assert.equal(missingUrl.status, 400)

    const list = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/gallery`)
    assert.equal(list.status, 200)
    assert.equal(((await list.json()) as { images: unknown[] }).images.length, 1)

    const removed = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/gallery/${image.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every tools route 404s for an unknown trip before touching storage', async () => {
  const { app, dir } = await setup()
  try {
    const bases = [
      ['GET', '/api/trips/no-such/notes', undefined],
      ['POST', '/api/trips/no-such/notes', { content: '' }],
      ['GET', '/api/trips/no-such/checklist', undefined],
      ['POST', '/api/trips/no-such/checklist', { content: 'x' }],
      ['PATCH', '/api/trips/no-such/checklist/x', { done: true }],
      ['DELETE', '/api/trips/no-such/checklist/x', undefined],
      ['GET', '/api/trips/no-such/gallery', undefined],
      ['POST', '/api/trips/no-such/gallery', { url: TINY_PNG }],
      ['DELETE', '/api/trips/no-such/gallery/x', undefined],
    ] as const
    for (const [method, path, body] of bases) {
      const res = await app.request(path, body === undefined ? { method } : jsonRequest(method, body))
      assert.equal(res.status, 404, `${method} ${path}`)
      assert.equal(((await res.json()) as { error: string }).error, '行程不存在')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tools data persists across an app restart on the same database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tools-restart-'))
  const url = `file:${join(dir, 'trips.db')}`
  try {
    const sqlite = await createSqliteTripRepository(url)
    await seedBuiltinTrip(sqlite.db)
    await sqlite.close()
    const first = await createApp({ databaseUrl: url })
    const created = await first.request(`/api/trips/${BUILTIN_TRIP_ID}/notes`, jsonRequest('POST', { content: '重启后仍在' }))
    assert.equal(created.status, 201)
    const gallery = await first.request(`/api/trips/${BUILTIN_TRIP_ID}/gallery`, jsonRequest('POST', { url: TINY_PNG, caption: '' }))
    assert.equal(gallery.status, 201)

    // "Restart": a fresh app attaching to the same file keeps tools data.
    const second = await createApp({ databaseUrl: url })
    const notes = await second.request(`/api/trips/${BUILTIN_TRIP_ID}/notes`)
    assert.equal(((await notes.json()) as { notes: Array<{ content: string }> }).notes[0]?.content, '重启后仍在')
    const images = await second.request(`/api/trips/${BUILTIN_TRIP_ID}/gallery`)
    assert.equal(((await images.json()) as { images: unknown[] }).images.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
