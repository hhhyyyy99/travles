/**
 * Patch-explain boundary tests (ticket 11).
 *
 * The mock model deliberately tries to write on the first modification turn.
 * The server must keep the existing plan unchanged until the user selects a
 * confirmation chip. A contradictory date/day request is blocked in the same
 * seam, while the warning remains visible in the structured response.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import type { TripSummary } from '../src/trips/types.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import type { MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'
import { detectTimeConstraintConflicts, longDriveWarnings } from '../src/chat/analysis.js'

type StreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }

type Script = {
  toolCalls?: { toolName: string; input: unknown }[]
  text?: string
}

function scriptedModel(scripts: Script[]): MastraLanguageModel {
  let call = 0
  return {
    specificationVersion: 'v2',
    provider: 'test.patch-explain',
    modelId: 'mock-patch-explain',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => {
      throw new Error('doGenerate not used')
    },
    doStream: async () => {
      const script = scripts[call] ?? { text: '好的。' }
      call += 1
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
      for (const [index, toolCall] of (script.toolCalls ?? []).entries()) {
        parts.push({
          type: 'tool-call',
          toolCallId: 'call-' + call + '-' + index,
          toolName: toolCall.toolName,
          input: JSON.stringify(toolCall.input),
        })
      }
      if (script.text !== undefined) {
        parts.push({ type: 'text-start', id: 't1' })
        parts.push({ type: 'text-delta', id: 't1', delta: script.text })
        parts.push({ type: 'text-end', id: 't1' })
      }
      parts.push({
        type: 'finish',
        finishReason: script.toolCalls && script.toolCalls.length > 0 ? 'tool-calls' : 'stop',
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      })
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

function parseSse(raw: string): { event: string; data: unknown }[] {
  return raw
    .split('\n\n')
    .map((block) => {
      let event = 'message'
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
        if (line.startsWith('data:')) data += line.slice('data:'.length).trim()
      }
      return { event, data: data ? JSON.parse(data) : null }
    })
    .filter((entry) => entry.data !== null || entry.event !== 'message')
}

async function makeApp(model: MastraLanguageModel) {
  const messages = new MemoryMessageStoreDriver()
  const patchStore = new MemoryTripPatchStore()
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    messageStore: messages,
    tripPatchStore: patchStore,
    plannerModel: model,
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
  })
  const response = await app.request(
    '/api/trips',
    jsonRequest('POST', { title: '呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-03' }),
  )
  assert.equal(response.status, 201)
  const trip = ((await response.json()) as { trip: TripSummary }).trip
  return { app, trip, patchStore, messages }
}

const EXPLAIN_META = {
  round: 'patch-explain',
  impacts: ['D1 机场接送需要保留返程缓冲', 'D2 住宿城市需要前移'],
  conflicts: ['10/7 指定海拉尔，与原计划满洲里住宿冲突'],
  chips: [
    { label: '调整整条环线，让满洲里提前', value: '确认方案：调整整条环线，让满洲里提前' },
    { label: '保留满洲里，改住海拉尔', value: '确认方案：保留满洲里，改住海拉尔' },
  ],
  think: '先说明影响，再等待用户选择。',
  thinkComplete: true,
}

const CONFIRMED_PATCH = {
  ops: [{ op: 'update_day', dayId: 'day-1', theme: '重排后：满洲里提前，国门游览压缩' }],
}

test('modification is explained first and only the confirmation choice applies the patch', async () => {
  const model = scriptedModel([
    {
      toolCalls: [
        { toolName: 'emit_round_meta', input: EXPLAIN_META },
        { toolName: 'apply_trip_patch', input: CONFIRMED_PATCH },
      ],
    },
    { text: '识别到住宿冲突：10/7 原计划住满洲里。请先选择处理方式。' },
    {
      toolCalls: [
        {
          toolName: 'emit_round_meta',
          input: { ...EXPLAIN_META, compromises: ['为赶场次压缩国门游览时长。'] },
        },
        { toolName: 'apply_trip_patch', input: CONFIRMED_PATCH },
      ],
    },
    { text: 'D1：满洲里提前。妥协：国门游览压缩为 13:30–15:05，以保留返程缓冲。' },
  ])
  const { app, trip, patchStore } = await makeApp(model)
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '原计划：满洲里住宿' })

  const first = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '10/7 改住海拉尔，帮我重新安排' }))
  assert.equal(first.status, 200)
  const firstEvents = parseSse(await first.text())
  assert.equal(firstEvents.some((entry) => entry.event === 'applied_patch'), false)
  assert.equal((await patchStore.listDayRows(trip.id))[0]?.theme, '原计划：满洲里住宿')
  const firstMeta = firstEvents.find((entry) => entry.event === 'meta')?.data as { round: string; conflicts?: string[]; chips?: unknown[] }
  assert.equal(firstMeta.round, 'patch-explain')
  assert.equal(firstMeta.conflicts?.length, 1)
  assert.equal(firstMeta.chips?.length, 2)

  const second = await app.request(
    '/api/trips/' + trip.id + '/messages',
    jsonRequest('POST', { content: '确认方案：调整整条环线，让满洲里提前' }),
  )
  assert.equal(second.status, 200)
  const secondEvents = parseSse(await second.text())
  assert.ok(secondEvents.some((entry) => entry.event === 'applied_patch'))
  assert.equal((await patchStore.listDayRows(trip.id))[0]?.theme, '重排后：满洲里提前，国门游览压缩')
  const done = secondEvents.find((entry) => entry.event === 'done')?.data as { assistantMessage: { content: string; meta?: { compromises?: string[] } } }
  assert.match(done.assistantMessage.content, /妥协/)
  assert.deepEqual(done.assistantMessage.meta?.compromises, ['为赶场次压缩国门游览时长。'])
})

test('contradictory date and day constraints are reported before a patch can apply', async () => {
  const model = scriptedModel([
    {
      toolCalls: [
        { toolName: 'emit_round_meta', input: { round: 'plan' } },
        {
          toolName: 'apply_trip_patch',
          input: { ops: [{ op: 'add_day', dayId: 'day-1', date: '2026-10-02', theme: '不应写入' }] },
        },
      ],
    },
    { text: '日期和天数不一致，请先确认。' },
  ])
  const { app, trip, patchStore } = await makeApp(model)
  const response = await app.request(
    '/api/trips/' + trip.id + '/messages',
    jsonRequest('POST', { content: '我想玩 7 天，但日期是 10/2 到 10/5' }),
  )
  assert.equal(response.status, 200)
  const events = parseSse(await response.text())
  assert.equal(events.some((entry) => entry.event === 'applied_patch'), false)
  assert.equal((await patchStore.listDayRows(trip.id)).length, 0)
  const meta = events.find((entry) => entry.event === 'meta')?.data as {
    round: string
    conflicts?: string[]
    warnings?: { kind: string; suggestion?: string }[]
  }
  assert.equal(meta.round, 'patch-explain')
  assert.ok(meta.conflicts?.some((value) => value.includes('7 天')))
  assert.ok(meta.warnings?.some((warning) => warning.kind === 'time-conflict'))
  const done = events.find((entry) => entry.event === 'done')?.data as { assistantMessage: { content: string } }
  assert.match(done.assistantMessage.content, /7 天/)
})

test('analysis emits a split suggestion for a drive longer than six hours', () => {
  assert.equal(detectTimeConstraintConflicts('安排 7 天，10/2 到 10/5').length, 1)
  const warnings = longDriveWarnings(
    [{ id: 'leg-1', trip_id: 'trip', from_item_id: 'a', to_item_id: 'b', mode: 'drive', distance_km: 500, duration_min: 361, polyline: null }],
    [
      { id: 'a', trip_id: 'trip', day_id: 'd', item_order: 0, type: 'attraction', title: '海拉尔', note: '', poi: null, images: null, pending: 0 },
      { id: 'b', trip_id: 'trip', day_id: 'd', item_order: 1, type: 'attraction', title: '满洲里', note: '', poi: null, images: null, pending: 0 },
    ],
  )
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.kind, 'long-drive')
  assert.match(warnings[0]?.suggestion ?? '', /拆成两段/)
})
