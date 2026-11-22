/**
 * Plan-round TripPatch end-to-end tests (ticket 08) — the highest seam
 * (spec 测试接缝 #1), same pattern as chat-api.test.ts: the mock model emits
 * `emit_round_meta` + `apply_trip_patch` tool calls like a real
 * function-calling provider would, and the REAL app (Hono, app.request())
 * must produce the full SSE sequence (start → delta… → meta → applied_patch
 * → done), write days/items/legs, and persist the applied patch on the
 * assistant message. Rejection flows: invalid patches are fed back to the
 * model for retry; retries exhausted → in-stream `error` event, nothing
 * persisted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import type { TripSummary } from '../src/trips/types.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import { SqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import { createSqliteRecommendationsStore } from '../src/recommendations/driver-sqlite.js'
import type { MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'

/**
 * Local subset of the AI SDK v2 stream-part union (see chat-api.test.ts).
 */
type StreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }

type ScriptedCall = {
  beforeStream?: () => Promise<void>
  /** Tool calls emitted before the prose of this model round. */
  toolCalls?: { toolName: string; input: unknown }[]
  /** Prose streamed after the tool calls of this round. */
  text?: string
}

/**
 * Fake model playing a scripted plan-round conversation: round N of the
 * agent loop emits script[N-1] (tools first, then text); beyond the script
 * it answers with a plain closing line (the way a real model would wind
 * down). Every incoming prompt is recorded so tests can assert that
 * validation errors were fed back to the model.
 */
function fakeScriptedModel(script: ScriptedCall[]): MastraLanguageModel & { prompts: string[] } {
  const prompts: string[] = []
  let call = 0
  return {
    specificationVersion: 'v2',
    provider: 'test.mock',
    modelId: 'mock-plan',
    supportedUrls: Promise.resolve({}),
    prompts,
    doGenerate: async () => {
      throw new Error('doGenerate not used in this ticket')
    },
    doStream: async ({ prompt }: { prompt?: unknown }) => {
      const step = script[call] ?? { text: '好的，就按这个计划来。' }
      call += 1
      if (prompt !== undefined) prompts.push(JSON.stringify(prompt))
      await step.beforeStream?.()
      const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
      for (const [index, toolCall] of (step.toolCalls ?? []).entries()) {
        parts.push({
          type: 'tool-call',
          toolCallId: `call-${call}-${index}`,
          toolName: toolCall.toolName,
          input: JSON.stringify(toolCall.input),
        })
      }
      if (step.text !== undefined) {
        parts.push({ type: 'text-start', id: 't1' })
        parts.push({ type: 'text-delta', id: 't1', delta: step.text })
        parts.push({ type: 'text-end', id: 't1' })
      }
      parts.push({
        type: 'finish',
        finishReason: step.toolCalls !== undefined && step.toolCalls.length > 0 ? 'tool-calls' : 'stop',
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

/** Parse an SSE body into `{event, data}` pairs (data stays JSON-parsed). */
function parseSSE(raw: string): { event: string; data: unknown }[] {
  const events: { event: string; data: unknown }[] = []
  for (const block of raw.split('\n\n')) {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
      if (line.startsWith('data:')) data += line.slice('data:'.length).trim()
    }
    if (data === '' && event === 'message') continue
    events.push({ event, data: data ? JSON.parse(data) : null })
  }
  return events
}

const PLAN_META = {
  round: 'plan',
  think: '已澄清出行方式与日期，产出 2 天环线计划并写入行程。',
  thinkComplete: true,
}

/** A valid 2-day patch: coordinates on adjacent cards, one 待定 stay. */
const VALID_PATCH = {
  ops: [
    { op: 'add_day', dayId: 'day-1', date: '2026-10-02', theme: '草原穿越日' },
    { op: 'add_day', dayId: 'day-2', date: '2026-10-03', theme: '边境线日' },
    { op: 'add_item', itemId: 'i-hailar', dayId: 'day-1', type: 'traffic', title: '抵达海拉尔', legPending: true },
    {
      op: 'add_item',
      itemId: 'i-moergele',
      dayId: 'day-1',
      type: 'attraction',
      title: '莫尔格勒河',
      note: '14:00-16:30 河边慢行',
      poi: { name: '莫尔格勒河', lat: 49.4072, lng: 119.7478 },
    },
    {
      op: 'add_item',
      itemId: 'i-stay-1',
      dayId: 'day-1',
      type: 'stay',
      title: '恩和木刻楞民宿',
      pending: true,
      poi: { name: '恩和', lat: 50.3517, lng: 119.5681 },
    },
    {
      op: 'add_item',
      itemId: 'i-guomen',
      dayId: 'day-2',
      type: 'attraction',
      title: '满洲里国门',
      poi: { name: '满洲里国门', lat: 49.6116, lng: 117.3787 },
    },
  ],
}

const EXPLICIT_DATE_PATCH = {
  ops: [
    { op: 'add_day', dayId: 'explicit-day-1', date: '2026-10-07', theme: '模型指定日期一' },
    { op: 'add_day', dayId: 'explicit-day-2', date: '2026-10-08', theme: '模型指定日期二' },
  ],
}

async function makeInjectedApp(model: MastraLanguageModel): Promise<{
  app: Awaited<ReturnType<typeof createApp>>
  trip: TripSummary
  messageStore: MemoryMessageStoreDriver
  patchStore: MemoryTripPatchStore
}> {
  const messageStore = new MemoryMessageStoreDriver()
  const patchStore = new MemoryTripPatchStore()
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    messageStore,
    tripPatchStore: patchStore,
    plannerModel: model,
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
  })
  const res = await app.request('/api/trips', jsonRequest('POST', { title: '呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-03' }))
  assert.equal(res.status, 201)
  const trip = ((await res.json()) as { trip: TripSummary }).trip
  return { app, trip, messageStore, patchStore }
}

async function sendAndParse(app: Awaited<ReturnType<typeof createApp>>, tripId: string, content: string) {
  const res = await app.request(`/api/trips/${tripId}/messages`, jsonRequest('POST', { content }))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  return parseSSE(await res.text())
}

test('plan round end-to-end: apply_trip_patch writes days/items/legs, SSE carries applied_patch, message records the patch', async () => {
  const model = fakeScriptedModel([
    {
      toolCalls: [
        { toolName: 'emit_round_meta', input: PLAN_META },
        { toolName: 'apply_trip_patch', input: VALID_PATCH },
      ],
    },
    { text: '## 逐日概览\nD1 草原穿越日：莫尔格勒河 → 恩和（住宿待定）。\n## 关键提醒\n边防证件随身带。' },
  ])
  const { app, trip, messageStore, patchStore } = await makeInjectedApp(model as unknown as MastraLanguageModel)

  const events = await sendAndParse(app, trip.id, '出发日期定好了，给我们出完整计划吧')
  assert.deepEqual(
    events.map((e) => e.event),
    ['start', 'delta', 'meta', 'applied_patch', 'done'],
  )
  assert.deepEqual((events[0] as { data: { round: string } }).data, { round: 'plan' })

  // The applied_patch event carries summary + stats + the applied patch.
  const applied = events.find((e) => e.event === 'applied_patch') as {
    data: { summary: string; stats: Record<string, number>; patch: typeof VALID_PATCH }
  }
  assert.equal(applied.data.summary, '已写入行程：新增 2 天、新增 4 张卡片')
  assert.equal(applied.data.stats.daysAdded, 2)
  assert.equal(applied.data.stats.itemsAdded, 4)
  assert.deepEqual(applied.data.patch, VALID_PATCH)

  // `done` echoes the assistant message WITH the persisted applied patch.
  const done = events[events.length - 1] as {
    data: { assistantMessage: { content: string; appliedPatch: { summary: string; patch: unknown } } }
  }
  assert.ok(done.data.assistantMessage.content.includes('逐日概览'))
  assert.ok(done.data.assistantMessage.content.includes('待定'))
  assert.equal(done.data.assistantMessage.appliedPatch.summary, applied.data.summary)
  assert.deepEqual(done.data.assistantMessage.appliedPatch.patch, VALID_PATCH)

  // DB rows: 2 days, 4 items (one pending), adjacency legs.
  assert.equal((await patchStore.listDayRows(trip.id)).length, 2)
  const items = await patchStore.listItemRows(trip.id)
  assert.equal(items.length, 4)
  const stay = items.find((row) => row.id === 'i-stay-1')
  assert.equal(stay?.pending, 1, 'unconfirmed slot persists as pending')
  const legs = await patchStore.listLegRows(trip.id)
  assert.equal(legs.length, 3, 'two intra-day legs plus the exact day-1 to day-2 bridge')

  // Reload path: history returns the applied patch record too.
  const history = await app.request(`/api/trips/${trip.id}/messages`)
  const historyBody = (await history.json()) as {
    messages: { role: string; appliedPatch: { summary: string } | null }[]
  }
  const assistantRow = historyBody.messages.find((m) => m.role === 'assistant')
  assert.ok(assistantRow?.appliedPatch)
  assert.equal(assistantRow.appliedPatch.summary, applied.data.summary)
  assert.equal(messageStore.messageRows.length, 2)
})

test('a candidate saved during first-turn planning is explained before it can be scheduled', async (t) => {
  const sqlite = await createSqliteTripRepository(':memory:')
  t.after(() => sqlite.close())
  const created = await sqlite.repository.create({ title: '周末游', startDate: '2026-10-02', endDate: '2026-10-02' })
  assert.ok(created.ok)
  const { trip } = created
  const patchStore = new SqliteTripPatchStore(sqlite.db)
  const choice = '确认方案：安排雨天候选'
  const move = { op: 'move_stash_to_day', stashId: '', itemId: 'scheduled', dayId: 'first-day', pending: true }
  const apply = { toolName: 'apply_trip_patch', input: { ops: [{ op: 'add_day', dayId: 'first-day' }, move] } }
  const model = fakeScriptedModel([
    {
      beforeStream: async () => {
        const saved = await app.request(`/api/trips/${trip.id}/stash`, jsonRequest('POST', {
          poi: { id: 'museum', name: '雨天备选', lat: 49, lng: 119, type: 'attraction' },
        }))
        assert.equal(saved.status, 201)
        move.stashId = ((await saved.json()) as { item: { id: string } }).item.id
      },
      toolCalls: [{ toolName: 'emit_round_meta', input: PLAN_META }, apply],
    },
    { toolCalls: [apply, { toolName: 'read_trip_snapshot', input: {} }] },
    { toolCalls: [{ toolName: 'emit_round_meta', input: {
      round: 'patch-explain', impacts: ['雨天备选将进入第一天'], chips: [{ label: '确认安排', value: choice }],
    } }] },
    { text: '建议将刚保存的雨天备选排入第一天，请先确认。' },
    { toolCalls: [apply] },
    { text: '已安排雨天备选。' },
  ])
  const app = await createApp({
    tripRepository: sqlite.repository,
    tripPatchStore: patchStore,
    recommendationsStore: createSqliteRecommendationsStore(sqlite.db),
    messageStore: new MemoryMessageStoreDriver(),
    plannerModel: model,
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
  })

  const events = await sendAndParse(app, trip.id, '帮我规划一天行程')
  assert.ok(move.stashId)
  assert.ok(!events.some(({ event }) => event === 'applied_patch'))
  assert.deepEqual(await patchStore.listDayRows(trip.id), [])
  assert.deepEqual(await patchStore.listItemRows(trip.id), [])
  assert.deepEqual((await patchStore.listStashRows(trip.id)).map((row) => row.id), [move.stashId])
  assert.match(model.prompts[1] ?? '', /行程或候选池已发生变化.*read_trip_snapshot/)
  assert.ok(model.prompts[2]?.includes('雨天备选'))
  const meta = events.find(({ event }) => event === 'meta')?.data as { round: string; chips: { value: string }[] }
  assert.equal(meta.round, 'patch-explain')
  assert.equal(meta.chips[0]?.value, choice)
  assert.equal(events.at(-1)?.event, 'done')

  const confirmed = await sendAndParse(app, trip.id, choice)
  assert.ok(confirmed.some(({ event }) => event === 'applied_patch'))
  assert.deepEqual(await patchStore.listStashRows(trip.id), [])
  assert.equal((await patchStore.listItemRows(trip.id))[0]?.title, '雨天备选')
})

test('intake context reaches the first planner turn and successful QA gets next-step chips', async () => {
  const model = fakeScriptedModel([
    { toolCalls: [{ toolName: 'emit_round_meta', input: { round: 'qa' } }] },
    { text: '我记住了你的目的地与节奏偏好。' },
  ])
  const { app } = await makeInjectedApp(model as unknown as MastraLanguageModel)
  const intake = await app.request('/api/trips/intake', jsonRequest('POST', {
    sentence: '我想去呼伦贝尔 7 天，慢节奏，自驾',
  }))
  assert.equal(intake.status, 201)
  const trip = ((await intake.json()) as { trip: TripSummary }).trip
  const events = await sendAndParse(app, trip.id, '先聊聊这趟行程')
  const meta = events.find((event) => event.event === 'meta')?.data as { round: string; chips?: { value: string }[] }
  assert.equal(meta.round, 'qa')
  assert.ok((meta.chips?.length ?? 0) >= 1)
  assert.ok(model.prompts.some((prompt) => prompt.includes('创建意图上下文') && prompt.includes('呼伦贝尔') && prompt.includes('7 天') && prompt.includes('慢节奏，自驾')))
})

test('AI patch preserves explicit day dates through the HTTP/SSE callback', async () => {
  const model = fakeScriptedModel([
    {
      toolCalls: [
        { toolName: 'emit_round_meta', input: PLAN_META },
        { toolName: 'apply_trip_patch', input: EXPLICIT_DATE_PATCH },
      ],
    },
    { text: '已按指定日期生成计划。' },
  ])
  const { app, trip, patchStore } = await makeInjectedApp(model as unknown as MastraLanguageModel)

  const events = await sendAndParse(app, trip.id, '请按 2026-10-07 到 2026-10-08 生成计划')
  assert.ok(events.some((event) => event.event === 'applied_patch'))
  assert.deepEqual(
    (await patchStore.listDayRows(trip.id)).sort((a, b) => Number(a.idx) - Number(b.idx)).map((row) => row.date),
    ['2026-10-07', '2026-10-08'],
  )
  const tripResponse = await app.request(`/api/trips/${trip.id}`)
  assert.equal(tripResponse.status, 200)
  const updatedTrip = ((await tripResponse.json()) as { trip: TripSummary }).trip
  assert.deepEqual(
    { startDate: updatedTrip.startDate, endDate: updatedTrip.endDate, days: updatedTrip.days },
    { startDate: '2026-10-07', endDate: '2026-10-08', days: 2 },
  )
})

test('AI removal deliberately compacts the remaining day dates', async () => {
  const model = fakeScriptedModel([
    {
      toolCalls: [
        {
          toolName: 'emit_round_meta',
          input: {
            round: 'patch-explain',
            chips: [{ label: '确认删除并压缩', value: '确认方案：删除第一天并压缩日期' }],
          },
        },
      ],
    },
    { text: '删除第一天会影响后续日期，我先等你确认。' },
    {
      toolCalls: [
        { toolName: 'emit_round_meta', input: PLAN_META },
        { toolName: 'apply_trip_patch', input: { ops: [{ op: 'remove_day', dayId: 'remove-day-1' }] } },
      ],
    },
    { text: '已删除第一天并重新压缩日期。' },
  ])
  const { app, trip, patchStore } = await makeInjectedApp(model as unknown as MastraLanguageModel)
  await patchStore.upsertDayRow(trip.id, { id: 'remove-day-1', idx: 0, date: '2026-10-02', theme: '第一天' })
  await patchStore.upsertDayRow(trip.id, { id: 'remove-day-2', idx: 1, date: '2026-10-03', theme: '第二天' })

  const explanation = await sendAndParse(app, trip.id, '请删除第一天并压缩日期')
  assert.equal(explanation.find((event) => event.event === 'meta')?.data && (explanation.find((event) => event.event === 'meta')?.data as { round?: string }).round, 'patch-explain')
  const events = await sendAndParse(app, trip.id, '确认方案：删除第一天并压缩日期')
  assert.ok(events.some((event) => event.event === 'applied_patch'))
  const remaining = (await patchStore.listDayRows(trip.id)).find((row) => row.id === 'remove-day-2')
  assert.equal(remaining?.idx, 0)
  assert.equal(remaining?.date, '2026-10-02')
})

test('invalid patch is fed back to the model; the retry lands and the stream completes normally', async () => {
  const invalidPatch = {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
      { op: 'add_item', itemId: 's1', dayId: 'day-1', type: 'stay', title: '酒店A', poi: { name: '酒店A', lat: 1, lng: 1 } },
      { op: 'add_item', itemId: 's2', dayId: 'day-1', type: 'stay', title: '酒店B', poi: { name: '酒店B', lat: 2, lng: 2 } },
    ],
  }
  const model = fakeScriptedModel([
    {
      toolCalls: [
        { toolName: 'emit_round_meta', input: PLAN_META },
        { toolName: 'apply_trip_patch', input: invalidPatch },
      ],
    },
    { toolCalls: [{ toolName: 'apply_trip_patch', input: VALID_PATCH }] },
    { text: '修正了住宿安排，计划已写入。' },
  ])
  const { app, trip, patchStore } = await makeInjectedApp(model as unknown as MastraLanguageModel)

  const events = await sendAndParse(app, trip.id, '再排一次，酒店别重复')
  // No error event: the stream never fails on a rejected first attempt.
  assert.deepEqual(
    events.map((e) => e.event),
    ['start', 'delta', 'meta', 'applied_patch', 'done'],
  )

  // The step-2 prompt carried the validation error (fed back to the model).
  assert.ok(model.prompts.length >= 2)
  assert.ok(model.prompts[1]?.includes('最多一个过夜住宿'), 'the model sees the rejection reason')

  // Only the corrected patch applied: 2 days / 4 items, single application.
  assert.equal((await patchStore.listDayRows(trip.id)).length, 2)
  assert.equal((await patchStore.listItemRows(trip.id)).length, 4)
  const applied = events.find((e) => e.event === 'applied_patch') as { data: { stats: { itemsAdded: number } } }
  assert.equal(applied.data.stats.itemsAdded, 4)
})

test('retries exhausted: every apply_trip_patch rejected → error event with guidance, nothing written or persisted', async () => {
  const invalidPatch = {
    ops: [
      { op: 'add_day', dayId: 'day-1', date: '2026-10-02' },
      { op: 'add_item', itemId: 's1', dayId: 'day-1', type: 'stay', title: '酒店A', poi: { name: '酒店A', lat: 1, lng: 1 } },
      { op: 'add_item', itemId: 's2', dayId: 'day-1', type: 'stay', title: '酒店B', poi: { name: '酒店B', lat: 2, lng: 2 } },
    ],
  }
  const model = fakeScriptedModel([
    {
      toolCalls: [
        { toolName: 'emit_round_meta', input: PLAN_META },
        { toolName: 'apply_trip_patch', input: invalidPatch },
      ],
    },
    { toolCalls: [{ toolName: 'apply_trip_patch', input: invalidPatch }] },
    { toolCalls: [{ toolName: 'apply_trip_patch', input: invalidPatch }] },
    { text: '抱歉，我没能在重试次数内修正计划。' },
  ])
  const { app, trip, messageStore, patchStore } = await makeInjectedApp(model as unknown as MastraLanguageModel)

  const events = await sendAndParse(app, trip.id, '给我出计划（故意坏数据）')
  assert.deepEqual(
    events.map((e) => e.event),
    ['start', 'delta', 'error', 'close'],
  )
  const error = events.find((e) => e.event === 'error') as { data: { code: string; message: string; guidance: string } }
  assert.equal(error.data.code, 'patch_invalid')
  assert.ok(error.data.message.length > 0)
  assert.ok(error.data.guidance.includes('未被改动'))

  // Three attempts were made (initial + 2 retries), then the loop stopped.
  assert.equal(model.prompts.length, 4, 'model saw each rejection and a final prose round')

  // Nothing written, nothing persisted (never a half-applied turn).
  assert.equal((await patchStore.listDayRows(trip.id)).length, 0)
  assert.equal((await patchStore.listItemRows(trip.id)).length, 0)
  assert.equal(messageStore.messageRows.length, 0)
})
