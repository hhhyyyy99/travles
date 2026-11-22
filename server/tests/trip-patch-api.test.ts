/**
 * TripPatch HTTP integration coverage: drive the real Hono chat route with a
 * scripted model and use a real SQLite-backed app for the write/read loop.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'

import { createApp } from '../src/app.js'
import type { TripSummary } from '../src/trips/types.js'
import type { RecommendationsApiSnapshot, TripCanvas } from '@hailar/domain'

type StreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }

function scriptedPlanModel(patch: unknown, requiresConfirmation = false): MastraLanguageModel {
  let call = 0
  return {
    specificationVersion: 'v2',
    provider: 'test.sqlite-api',
    modelId: 'sqlite-api-plan',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => {
      throw new Error('doGenerate not used')
    },
    doStream: async () => {
      call += 1
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
      if (call === 1 || (requiresConfirmation && call === 3)) {
        if (requiresConfirmation && call === 1) {
          parts.push({ type: 'tool-call', toolCallId: 'explain-1', toolName: 'emit_round_meta', input: JSON.stringify({
            round: 'patch-explain', impacts: ['新增一天、将候选排入日程，保留原有收藏和候选。'],
            chips: [{ label: '确认排期', value: '确认方案：将候选排入日程' }],
            think: '先确认候选排期。', thinkComplete: true,
          }) })
        }
        // Trying the same write during explanation verifies the server gate.
        parts.push({ type: 'tool-call', toolCallId: `apply-${call}`, toolName: 'apply_trip_patch', input: JSON.stringify(patch) })
        parts.push({
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        })
      } else {
        parts.push({ type: 'text-start', id: 'answer' })
        parts.push({ type: 'text-delta', id: 'answer', delta: '计划已写入。' })
        parts.push({ type: 'text-end', id: 'answer' })
        parts.push({
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        })
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  } as unknown as MastraLanguageModel
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

test('atomic stash patch publishes consistent SSE, candidate, favorite and canvas data through SQLite Hono', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stash-patch-api-'))
  try {
    const poi = {
      id: 'new-poi', amapId: 'new-provider', name: '推荐名称', lat: 49.2, lng: 119.7,
      category: '景点', type: 'attraction', region: '海拉尔', rating: 4.5,
      introSummary: '简介', address: '旧地址', images: [{ url: '/stash.jpg', caption: '图片' }],
    }
    const patch = { ops: [
      { op: 'add_stash', stashId: 'api-candidate', title: '明确候选标题', note: '  明确备注  ', poi },
      { op: 'add_stash', stashId: 'unscheduled-text', title: '  未排期文字候选  ', category: '随想' },
      { op: 'add_day', dayId: 'api-stash-day', date: '2026-10-02', title: '整日标题', note: '整日备注' },
      { op: 'add_item', itemId: 'first', dayId: 'api-stash-day', type: 'other', title: '起点', poi: { name: '起点', lat: 49.1, lng: 119.6 } },
      { op: 'move_stash_to_day', stashId: 'api-candidate', itemId: 'api-scheduled', dayId: 'api-stash-day', type: 'dining', timeRange: ' 午后 ', cost: ' 免费 ' },
    ] }
    const app = await createApp({
      databaseUrl: `file:${join(dir, 'trips.db')}`,
      plannerModel: scriptedPlanModel(patch, true),
      plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    })
    const created = await app.request('/api/trips', jsonRequest('POST', { title: '候选 API 行程', startDate: '2026-10-02', endDate: '2026-10-02' }))
    assert.equal(created.status, 201)
    const trip = ((await created.json()) as { trip: TripSummary }).trip
    const saved = await app.request(`/api/trips/${trip.id}/favorites`, jsonRequest('POST', { poi: { ...poi, id: 'old-poi', amapId: 'old-provider', name: '保留的收藏' } }))
    assert.equal(saved.status, 201)
    const oldSnapshot = await (await app.request(`/api/trips/${trip.id}/recommendations`)).json() as RecommendationsApiSnapshot
    assert.equal(oldSnapshot.stash.length, 1)
    assert.equal(oldSnapshot.favorites.length, 1)

    const explanation = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '把候选移入日程，添加一天' }))
    assert.equal(explanation.status, 200)
    const explanationRaw = await explanation.text()
    assert.doesNotMatch(explanationRaw, /event: applied_patch/)
    assert.match(explanationRaw, /确认方案：将候选排入日程/)
    assert.deepEqual(await (await app.request(`/api/trips/${trip.id}/recommendations`)).json(), oldSnapshot)
    assert.equal((await (await app.request(`/api/trips/${trip.id}/canvas`)).json() as TripCanvas).days.length, 0)

    const stream = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '确认方案：将候选排入日程' }))
    assert.equal(stream.status, 200)
    const raw = await stream.text()
    assert.match(raw, /event: applied_patch/)
    assert.match(raw, /"stashAdded":2/)
    assert.match(raw, /"stashMoved":1/)
    const canvas = await (await app.request(`/api/trips/${trip.id}/canvas`)).json() as TripCanvas
    assert.equal(canvas.days[0]?.title, '整日标题')
    assert.equal(canvas.days[0]?.note, '整日备注')
    const item = canvas.days[0]?.items[1]
    assert.equal(item?.id, 'api-scheduled')
    assert.equal(item?.title, '明确候选标题')
    // Canvas uses its established trimmed card-note read mapping; storage tests
    // separately verify that the authored stash note is persisted verbatim.
    assert.equal(item?.note, '明确备注')
    assert.equal(item?.type, 'food')
    assert.equal(item?.timeRange, ' 午后 ')
    assert.equal(item?.cost, ' 免费 ')
    assert.deepEqual(item?.images, poi.images)
    assert.equal(canvas.legs[0]?.fromItemId, 'first')
    assert.equal(canvas.legs[0]?.toItemId, 'api-scheduled')
    assert.ok((canvas.legs[0]?.distanceKm ?? 0) > 0)
    const snapshot = await (await app.request(`/api/trips/${trip.id}/recommendations`)).json() as RecommendationsApiSnapshot
    assert.deepEqual(snapshot.favorites, oldSnapshot.favorites)
    assert.deepEqual(snapshot.stash.filter((entry) => entry.id !== 'unscheduled-text'), oldSnapshot.stash)
    assert.equal(snapshot.stash.find((entry) => entry.id === 'unscheduled-text')?.poi, null)
    assert.equal(snapshot.stash.some((entry) => entry.id === 'api-candidate'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TripPatch writes through the real SQLite app API and canvas readback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'trip-patch-api-'))
  try {
    const patch = {
      ops: [
        { op: 'add_day', dayId: 'api-day', date: '2026-10-02', theme: 'API 测试' },
        { op: 'add_item', itemId: 'api-a', dayId: 'api-day', type: 'attraction', title: 'A', poi: { name: 'A', lat: 1, lng: 1 } },
        { op: 'add_item', itemId: 'api-b', dayId: 'api-day', type: 'food', title: 'B', poi: { name: 'B', lat: 2, lng: 2 } },
      ],
    }
    const app = await createApp({
      databaseUrl: `file:${join(dir, 'trips.db')}`,
      plannerModel: scriptedPlanModel(patch),
      plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    })

    const created = await app.request('/api/trips', jsonRequest('POST', {
      title: 'API 行程', startDate: '2026-10-02', endDate: '2026-10-02',
    }))
    assert.equal(created.status, 201)
    const trip = ((await created.json()) as { trip: TripSummary }).trip

    const stream = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '写入测试计划' }))
    assert.equal(stream.status, 200)
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/)
    const raw = await stream.text()
    assert.match(raw, /event: applied_patch/)
    assert.match(raw, /已写入行程/)

    const canvasResponse = await app.request(`/api/trips/${trip.id}/canvas`)
    assert.equal(canvasResponse.status, 200)
    const canvas = (await canvasResponse.json()) as {
      days: { id: string; items: { id: string }[] }[]
      legs: { fromItemId: string; toItemId: string; distanceKm: number }[]
    }
    assert.deepEqual(canvas.days.map((day) => [day.id, day.items.map((item) => item.id)]), [['api-day', ['api-a', 'api-b']]])
    assert.equal(canvas.legs.length, 1)
    assert.deepEqual(
      { from: canvas.legs[0]?.fromItemId, to: canvas.legs[0]?.toItemId },
      { from: 'api-a', to: 'api-b' },
    )
    assert.ok((canvas.legs[0]?.distanceKm ?? 0) > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
