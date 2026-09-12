import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'

import { createApp, type AppEnv } from '../src/app.js'
import { MemoryRecommendationsStoreDriver } from '../src/recommendations/driver-memory.js'
import { mountRecommendationsRoutes } from '../src/recommendations/routes.js'
import type { RecommendationPoi } from '../src/recommendations/types.js'
import { MemoryToolsStoreDriver } from '../src/tools/driver-memory.js'
import { TripEventHub } from '../src/trip-events/hub.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'

const poi: RecommendationPoi = {
  id: 'poi-sync',
  amapId: 'amap-sync',
  name: '同步测试点',
  lat: 49.3,
  lng: 119.8,
  category: '景点',
  type: 'attraction',
  region: '额尔古纳',
  rating: 4.5,
  introSummary: '同步测试用推荐点位',
  address: '额尔古纳沿线',
  images: [],
}

async function createTrip(repository: TripRepository): Promise<{ id: string }> {
  const result = await repository.create({ title: '面板同步测试', startDate: '2026-10-02', endDate: '2026-10-03' })
  if (!result.ok) throw new Error(result.error)
  return result.trip
}

type Reader = ReadableStreamDefaultReader<Uint8Array>

async function readSseEvent(reader: Reader, state: { buffer: string }): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder()
  while (true) {
    const boundary = state.buffer.indexOf('\n\n')
    if (boundary >= 0) {
      const frame = state.buffer.slice(0, boundary)
      state.buffer = state.buffer.slice(boundary + 2)
      const event = frame.match(/^event:\s*(.+)$/m)?.[1] ?? 'message'
      const data = frame.match(/^data:\s*(.+)$/m)?.[1] ?? ''
      return { event, data: data ? JSON.parse(data) : null }
    }
    const next = await reader.read()
    if (next.done) throw new Error('SSE stream closed before the expected event')
    state.buffer += decoder.decode(next.value, { stream: true })
  }
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

test('tools and recommendation writes publish committed auxiliary events to one SSE subscriber', async () => {
  const tripRepository = new TripRepository(new MemoryTripStoreDriver())
  const trip = await createTrip(tripRepository)
  const events = new TripEventHub()
  const app = await createApp({
    tripRepository,
    toolsStore: new MemoryToolsStoreDriver(),
    recommendationsStore: new MemoryRecommendationsStoreDriver(),
    tripEvents: events,
  })

  const stream = await app.request(`/api/trips/${trip.id}/events`)
  assert.equal(stream.status, 200)
  const reader = stream.body?.getReader()
  assert.ok(reader)
  if (!reader) return
  const state = { buffer: '' }
  assert.equal((await readSseEvent(reader, state)).event, 'ready')

  const note = await app.request(`/api/trips/${trip.id}/notes`, jsonRequest('POST', { content: '带外套' }))
  assert.equal(note.status, 201)
  const noteEvent = await readSseEvent(reader, state)
  assert.equal(noteEvent.event, 'trip.updated')
  assert.deepEqual(noteEvent.data && typeof noteEvent.data === 'object'
    ? { kind: (noteEvent.data as Record<string, unknown>).kind, reason: (noteEvent.data as Record<string, unknown>).reason }
    : null, { kind: 'canvas', reason: 'note_created' })

  const stash = await app.request(`/api/trips/${trip.id}/stash`, jsonRequest('POST', { poi }))
  assert.equal(stash.status, 201)
  const stashEvent = await readSseEvent(reader, state)
  assert.equal((stashEvent.data as { reason: string }).reason, 'stash_added')

  const favorite = await app.request(`/api/trips/${trip.id}/favorites`, jsonRequest('POST', { poi }))
  assert.equal(favorite.status, 201)
  const favoriteEvent = await readSseEvent(reader, state)
  assert.equal((favoriteEvent.data as { reason: string }).reason, 'favorite_added')

  await reader.cancel()
})

test('recommendation notification failures do not change a successful committed write', async () => {
  const tripRepository = new TripRepository(new MemoryTripStoreDriver())
  const trip = await createTrip(tripRepository)
  const recommendations = new MemoryRecommendationsStoreDriver()
  const app = new Hono<AppEnv>()
  mountRecommendationsRoutes(app, {
    tripRepository,
    resolveStore: async () => recommendations,
    searchPoi: async () => [],
    onTripUpdated: () => {
      throw new Error('subscriber disconnected')
    },
  })

  // The write is already durable when a notification callback runs. A
  // disconnected subscriber must not turn that successful write into HTTP 5xx.
  const response = await app.request(`/api/trips/${trip.id}/stash`, jsonRequest('POST', { poi }))
  assert.equal(response.status, 201)
  const snapshot = await app.request(`/api/trips/${trip.id}/recommendations`)
  assert.equal(snapshot.status, 200)
  assert.equal(((await snapshot.json()) as { stash: unknown[] }).stash.length, 1)
})
