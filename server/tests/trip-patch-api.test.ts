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

type StreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }

function scriptedPlanModel(patch: unknown): MastraLanguageModel {
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
      if (call === 1) {
        parts.push({ type: 'tool-call', toolCallId: 'apply-1', toolName: 'apply_trip_patch', input: JSON.stringify(patch) })
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
