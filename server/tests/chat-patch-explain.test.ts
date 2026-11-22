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
import { detectTimeConstraintConflicts, isModificationRequest, longDriveWarnings } from '../src/chat/analysis.js'

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

function scriptedModel(scripts: Script[]): MastraLanguageModel & { prompts: string[] } {
  let call = 0
  const prompts: string[] = []
  return {
    specificationVersion: 'v2',
    provider: 'test.patch-explain',
    modelId: 'mock-patch-explain',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => {
      throw new Error('doGenerate not used')
    },
    prompts,
    doStream: async ({ prompt }: { prompt?: unknown }) => {
      const script = scripts[call] ?? { text: '好的。' }
      call += 1
      if (prompt !== undefined) prompts.push(JSON.stringify(prompt))
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
  } as unknown as MastraLanguageModel & { prompts: string[] }
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
  const tripRepository = new TripRepository(new MemoryTripStoreDriver())
  const patchStore = new MemoryTripPatchStore((id) => tripRepository.get(id))
  const app = await createApp({
    tripRepository,
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
  assert.ok(model.prompts[0]?.includes('read_trip_snapshot'), 'patch explanation prompt requires the current itinerary snapshot')

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

test('a first-turn confirmation cannot authorize an unreviewed patch', async () => {
  const model = scriptedModel([{ text: '不应被调用。' }])
  const { app, trip, patchStore } = await makeApp(model)
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '原计划' })

  const response = await app.request(
    '/api/trips/' + trip.id + '/messages',
    jsonRequest('POST', { content: '确认方案：未经分析直接改动' }),
  )
  assert.equal(response.status, 409)
  const body = (await response.json()) as { code: string; error: string }
  assert.equal(body.code, 'confirmation_required')
  assert.match(body.error, /没有可确认的修改方案/)
  assert.equal(model.prompts.length, 0, 'the model is not invoked for a forged confirmation')
  assert.equal((await patchStore.listDayRows(trip.id))[0]?.theme, '原计划')
})

test('a patch-explain confirmation is single-use and rejects replay', async () => {
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'emit_round_meta', input: EXPLAIN_META }, { toolName: 'apply_trip_patch', input: CONFIRMED_PATCH }] },
    { text: '请先选择一个处理方式。' },
    { toolCalls: [{ toolName: 'emit_round_meta', input: { ...EXPLAIN_META, compromises: ['压缩一个景点。'] } }, { toolName: 'apply_trip_patch', input: CONFIRMED_PATCH }] },
    { text: '已按确认方案完成重排。' },
  ])
  const { app, trip, patchStore } = await makeApp(model)
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '原计划' })

  const explain = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '10/7 改住海拉尔，帮我重新安排' }))
  assert.equal(explain.status, 200)
  await explain.text()

  const confirmed = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '确认方案：调整整条环线，让满洲里提前' }))
  assert.equal(confirmed.status, 200)
  assert.ok((await confirmed.text()).includes('applied_patch'))
  assert.equal((await patchStore.listDayRows(trip.id))[0]?.theme, '重排后：满洲里提前，国门游览压缩')

  const replay = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '确认方案：调整整条环线，让满洲里提前' }))
  assert.equal(replay.status, 409)
  const body = (await replay.json()) as { code: string }
  assert.equal(body.code, 'confirmation_required')
})

test('a patch-explain choice is rejected when the itinerary changed meanwhile', async () => {
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'emit_round_meta', input: EXPLAIN_META }, { toolName: 'apply_trip_patch', input: CONFIRMED_PATCH }] },
    { text: '请先选择一个处理方式。' },
  ])
  const { app, trip, patchStore } = await makeApp(model)
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '原计划' })

  const explain = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '10/7 改住海拉尔，帮我重新安排' }))
  assert.equal(explain.status, 200)
  await explain.text()
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '另一浏览器已调整' })

  const stale = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '确认方案：调整整条环线，让满洲里提前' }))
  assert.equal(stale.status, 409)
  const body = (await stale.json()) as { code: string }
  assert.equal(body.code, 'confirmation_stale')
  assert.equal(model.prompts.length, 2, 'stale confirmations are rejected before the model runs')
  assert.equal((await patchStore.listDayRows(trip.id))[0]?.theme, '另一浏览器已调整')
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

test('cross-day POI transfer gets an estimated warning when no cross-day leg row exists', () => {
  const warnings = longDriveWarnings(
    [],
    [
      { id: 'd1-last', trip_id: 'trip', day_id: 'day-1', item_order: 0, type: 'attraction', title: '第一天末站', note: '', poi: JSON.stringify({ name: '第一天末站', location: { lat: 49, lng: 119 } }), images: null, pending: 0 },
      { id: 'd1-text', trip_id: 'trip', day_id: 'day-1', item_order: 1, type: 'other', title: '无坐标备注', note: '', poi: null, images: null, pending: 0 },
      { id: 'd2-text', trip_id: 'trip', day_id: 'day-2', item_order: 0, type: 'traffic', title: '次日出发', note: '', poi: null, images: null, pending: 0 },
      { id: 'd2-first', trip_id: 'trip', day_id: 'day-2', item_order: 1, type: 'attraction', title: '第二天首站', note: '', poi: JSON.stringify({ name: '第二天首站', location: { lat: 53, lng: 119 } }), images: null, pending: 0 },
    ],
    [
      { id: 'day-1', trip_id: 'trip', idx: 0, date: '2026-10-02', theme: '', color: '' },
      { id: 'day-2', trip_id: 'trip', idx: 1, date: '2026-10-03', theme: '', color: '' },
    ],
  )
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0]?.estimated, true)
  assert.equal(warnings[0]?.from, '第一天末站')
  assert.equal(warnings[0]?.to, '第二天首站')
  assert.match(warnings[0]?.message ?? '', /跨天.*坐标估算/)
  assert.match(warnings[0]?.suggestion ?? '', /未核实.*拆成两段/)
})

test('ordinary questions on an existing plan keep the qa round and do not require confirmation', async () => {
  const model = scriptedModel([
    {
      toolCalls: [{ toolName: 'emit_round_meta', input: { round: 'qa' } }],
    },
    { text: '海拉尔明天晴到多云，早晚温差较大。' },
  ])
  const { app, trip, patchStore } = await makeApp(model)
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '原计划' })

  const response = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '海拉尔明天天气怎么样？' }))
  assert.equal(response.status, 200)
  const events = parseSse(await response.text())
  assert.deepEqual(events.map((entry) => entry.event), ['start', 'delta', 'meta', 'done'])
  assert.deepEqual((events[0]?.data as { round: string }).round, 'qa')
  assert.equal((events.find((entry) => entry.event === 'meta')?.data as { round: string }).round, 'qa')
  assert.equal((await patchStore.listDayRows(trip.id))[0]?.theme, '原计划')
})

test('a long existing drive is shown in metadata and assistant text with a split suggestion', async () => {
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'emit_round_meta', input: { round: 'qa' } }] },
    { text: '我先看一下当前路线。' },
  ])
  const { app, trip, patchStore } = await makeApp(model)
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '长途日' })
  await patchStore.upsertItemRow(trip.id, {
    id: 'item-a', dayId: 'day-1', itemOrder: 0, type: 'attraction', title: '海拉尔', note: '', poi: null, pending: false,
  })
  await patchStore.upsertItemRow(trip.id, {
    id: 'item-b', dayId: 'day-1', itemOrder: 1, type: 'attraction', title: '满洲里', note: '', poi: null, pending: false,
  })
  await patchStore.upsertLegRow(trip.id, {
    id: 'leg-long', fromItemId: 'item-a', toItemId: 'item-b', mode: 'drive', distanceKm: 500, durationMin: 361, polyline: null,
  })

  const response = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '这段路线有什么需要注意？' }))
  assert.equal(response.status, 200)
  const events = parseSse(await response.text())
  const meta = events.find((entry) => entry.event === 'meta')?.data as { round: string; warnings?: { kind: string; suggestion?: string }[] }
  assert.equal(meta.round, 'qa')
  assert.equal(meta.warnings?.[0]?.kind, 'long-drive')
  assert.match(meta.warnings?.[0]?.suggestion ?? '', /拆成两段/)
  const done = events.find((entry) => entry.event === 'done')?.data as { assistantMessage: { content: string } }
  assert.match(done.assistantMessage.content, /建议拆成两段/)
})

test('a cross-day coordinate estimate reaches the chat SSE metadata and prose', async () => {
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'emit_round_meta', input: { round: 'qa' } }] },
    { text: '我会先检查跨天衔接。' },
  ])
  const { app, trip, patchStore } = await makeApp(model)
  await patchStore.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '第一天' })
  await patchStore.upsertDayRow(trip.id, { id: 'day-2', idx: 1, date: '2026-10-03', theme: '第二天' })
  await patchStore.upsertItemRow(trip.id, {
    id: 'cross-day-from', dayId: 'day-1', itemOrder: 0, type: 'attraction', title: '第一天末站', note: '',
    poi: JSON.stringify({ name: '第一天末站', location: { lat: 49, lng: 119 } }), pending: false,
  })
  await patchStore.upsertItemRow(trip.id, {
    id: 'cross-day-to', dayId: 'day-2', itemOrder: 0, type: 'attraction', title: '第二天首站', note: '',
    poi: JSON.stringify({ name: '第二天首站', location: { lat: 53, lng: 119 } }), pending: false,
  })

  const response = await app.request('/api/trips/' + trip.id + '/messages', jsonRequest('POST', { content: '这两天路线有什么需要注意？' }))
  assert.equal(response.status, 200)
  const events = parseSse(await response.text())
  const meta = events.find((entry) => entry.event === 'meta')?.data as {
    warnings?: { kind: string; estimated?: boolean; message?: string; suggestion?: string }[]
  }
  assert.equal(meta.warnings?.[0]?.kind, 'long-drive')
  assert.equal(meta.warnings?.[0]?.estimated, true)
  assert.match(meta.warnings?.[0]?.message ?? '', /跨天.*坐标估算/)
  assert.match(meta.warnings?.[0]?.suggestion ?? '', /未核实.*拆成两段/)
  const done = events.find((entry) => entry.event === 'done')?.data as { assistantMessage: { content: string } }
  assert.match(done.assistantMessage.content, /未核实.*建议拆成两段/)
})

test('time-order and reversed-date contradictions are surfaced before planning', () => {
  const timeConflicts = detectTimeConstraintConflicts('请安排 10/2 18:00 抵达海拉尔，10/2 17:00 返程')
  assert.ok(timeConflicts.some((conflict) => conflict.message.includes('抵达时间')))

  const reversed = detectTimeConstraintConflicts('行程日期 10/5 到 10/2')
  assert.ok(reversed.some((conflict) => conflict.message.includes('结束时间早于开始时间')))
})

test('modification intent is limited to explicit itinerary edits', () => {
  assert.equal(isModificationRequest('请把第二天改住海拉尔'), true)
  assert.equal(isModificationRequest('重新生成一份计划'), true)
  assert.equal(isModificationRequest('海拉尔明天天气怎么样？'), false)
})
