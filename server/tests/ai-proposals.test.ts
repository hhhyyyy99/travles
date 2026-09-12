/** Ticket 13: proposal generation is read-only until an explicit apply call. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import type { TripSummary } from '../src/trips/types.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import type { MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'

type Part =
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'finish'; finishReason: 'stop' | 'tool-calls'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }

function fakeProposalModel(input: unknown, options: { skipSnapshot?: boolean } = {}): MastraLanguageModel {
  let calls = 0
  const needsSnapshot = !options.skipSnapshot && input !== null && typeof input === 'object' && (input as { kind?: unknown }).kind !== 'parse'
  return {
    specificationVersion: 'v2',
    provider: 'test.proposals',
    modelId: 'mock-proposals',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => {
      throw new Error('doGenerate not used')
    },
    doStream: async () => {
      calls += 1
      const proposalCall = needsSnapshot ? 2 : 1
      const parts: Part[] = calls === 1 && needsSnapshot
        ? [
            { type: 'tool-call', toolCallId: 'snapshot-1', toolName: 'read_trip_snapshot', input: '{}' },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ]
        : calls === proposalCall
          ? [
              { type: 'tool-call', toolCallId: 'proposal-1', toolName: 'create_trip_proposal', input: JSON.stringify(input) },
              { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ]
          : [
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: '建议已生成。' },
              { type: 'text-end', id: 't1' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ]
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

function snapshotBoundaryModel(input: unknown, observed: { prompts: unknown[] }): MastraLanguageModel {
  let calls = 0
  return {
    specificationVersion: 'v2',
    provider: 'test.proposals-boundary',
    modelId: 'mock-proposals-boundary',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => {
      throw new Error('doGenerate not used')
    },
    doStream: async ({ prompt }: { prompt?: unknown }) => {
      calls += 1
      if (calls === 2) observed.prompts.push(prompt)
      const parts: Part[] = calls === 1
        ? [
            { type: 'tool-call', toolCallId: 'snapshot-boundary-1', toolName: 'read_trip_snapshot', input: '{}' },
            { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          ]
        : calls === 2
          ? [
              { type: 'tool-call', toolCallId: 'proposal-boundary-1', toolName: 'create_trip_proposal', input: JSON.stringify(input) },
              { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ]
          : [
              { type: 'text-start', id: 'boundary-text' },
              { type: 'text-delta', id: 'boundary-text', delta: '建议已生成。' },
              { type: 'text-end', id: 'boundary-text' },
              { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ]
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

function request(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  }
}

async function makeApp(
  modelInput: unknown,
  patchStore = new MemoryTripPatchStore(),
  plannerModel = fakeProposalModel(modelInput),
) {
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    plannerModel,
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    tripPatchStore: patchStore,
  })
  const response = await app.request('/api/trips', request('POST', { title: '提案测试', startDate: '2026-10-02', endDate: '2026-10-02' }))
  assert.equal(response.status, 201)
  return { app, trip: ((await response.json()) as { trip: TripSummary }).trip, patchStore }
}

const PARSE_PROPOSAL = {
  kind: 'parse',
  title: '攻略解析：呼伦贝尔慢游',
  summary: '拆出一天草原游玩与一个待定住宿。',
  diff: [{ action: 'add', label: '新增草原游玩', detail: '莫尔格勒河安排在下午' }],
  items: [
    {
      itemId: 'parsed-view',
      dayId: 'parsed-day',
      type: 'attraction',
      title: '莫尔格勒河',
      note: '下午慢行',
      poi: { name: '莫尔格勒河', lat: 49.4072, lng: 119.7478 },
    },
  ],
  patch: {
    ops: [
      { op: 'add_day', dayId: 'parsed-day', date: '2026-10-02', theme: '草原慢游' },
      {
        op: 'add_item',
        itemId: 'parsed-view',
        dayId: 'parsed-day',
        type: 'attraction',
        title: '莫尔格勒河',
        note: '下午慢行',
        poi: { name: '莫尔格勒河', lat: 49.4072, lng: 119.7478 },
      },
    ],
  },
}

test('smart parse returns structured items and does not write until confirm', async () => {
  const { app, trip, patchStore } = await makeApp(PARSE_PROPOSAL)
  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'parse', text: 'D1 下午去莫尔格勒河，晚上住哪里待定' }))
  assert.equal(preview.status, 201)
  const proposal = ((await preview.json()) as { proposal: typeof PARSE_PROPOSAL & { id: string } }).proposal
  assert.equal(proposal.kind, 'parse')
  assert.equal(proposal.items?.[0]?.title, '莫尔格勒河')
  assert.equal((await patchStore.listDayRows(trip.id)).length, 0, 'preview must not mutate the trip')

  const applied = await app.request(`/api/trips/${trip.id}/ai/proposals/${proposal.id}/apply`, request('POST'))
  assert.equal(applied.status, 200)
  assert.equal((await patchStore.listDayRows(trip.id)).length, 1)
  assert.equal((await patchStore.listItemRows(trip.id)).length, 1)
})

test('standalone proposal apply preserves explicit day dates and refreshes the trip summary', async () => {
  const input = {
    ...PARSE_PROPOSAL,
    patch: {
      ops: PARSE_PROPOSAL.patch.ops.map((op) =>
        op.op === 'add_day' ? { ...op, date: '2026-10-07' } : op,
      ),
    },
  }
  const store = new MemoryTripPatchStore()
  const { app, trip } = await makeApp(input, store)
  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'parse', text: '10 月 7 日去莫尔格勒河' }))
  assert.equal(preview.status, 201)
  const proposal = ((await preview.json()) as { proposal: { id: string } }).proposal

  const applied = await app.request(`/api/trips/${trip.id}/ai/proposals/${proposal.id}/apply`, request('POST'))
  assert.equal(applied.status, 200)
  assert.equal((await store.listDayRows(trip.id))[0]?.date, '2026-10-07')
  const tripResponse = await app.request(`/api/trips/${trip.id}`)
  assert.equal(tripResponse.status, 200)
  const updatedTrip = ((await tripResponse.json()) as { trip: TripSummary }).trip
  assert.deepEqual(
    { startDate: updatedTrip.startDate, endDate: updatedTrip.endDate, days: updatedTrip.days },
    { startDate: '2026-10-07', endDate: '2026-10-07', days: 1 },
  )
})

test('canceling a route optimization proposal leaves the existing itinerary unchanged', async () => {
  const store = new MemoryTripPatchStore()
  await store.upsertDayRow('trip-seeded', { id: 'day-1', idx: 0, date: '2026-10-02', theme: '原计划' })
  await store.upsertItemRow('trip-seeded', { id: 'item-a', dayId: 'day-1', itemOrder: 0, type: 'attraction', title: 'A', note: '', poi: JSON.stringify({ name: 'A', location: { lat: 49, lng: 119 } }), pending: false })
  await store.upsertItemRow('trip-seeded', { id: 'item-b', dayId: 'day-1', itemOrder: 1, type: 'attraction', title: 'B', note: '', poi: JSON.stringify({ name: 'B', location: { lat: 49.1, lng: 119.1 } }), pending: false })
  const input = {
    kind: 'optimize',
    title: '路线优化建议',
    summary: '先去 B 再去 A，减少折返。',
    diff: [{ action: 'move', label: '调整 A/B 顺序' }],
    patch: { ops: [{ op: 'move_item', itemId: 'item-b', dayId: 'day-1', order: 0 }] },
  }
  const { app, trip, patchStore } = await makeApp(input, store)
  // The fixture store uses a different trip id until the app-created trip is
  // known; copy its rows under that id to exercise the day-scoped path.
  patchStore.dayRows[0]!.trip_id = trip.id
  patchStore.itemRows.forEach((row) => { row.trip_id = trip.id })
  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'optimize' }))
  assert.equal(preview.status, 201)
  const proposal = ((await preview.json()) as { proposal: { id: string } }).proposal
  const before = (await patchStore.listItemRows(trip.id)).map((row) => [row.id, row.item_order])
  const canceled = await app.request(`/api/trips/${trip.id}/ai/proposals/${proposal.id}`, request('DELETE'))
  assert.equal(canceled.status, 200)
  assert.deepEqual((await patchStore.listItemRows(trip.id)).map((row) => [row.id, row.item_order]), before)
})

test('day optimization rejects a patch that targets another day', async () => {
  const store = new MemoryTripPatchStore()
  const { app, trip } = await makeApp(
    {
      kind: 'day-optimize',
      targetDayId: 'day-1',
      title: '当天优化',
      summary: '调整顺序。',
      diff: [{ action: 'move', label: '调整顺序' }],
      patch: { ops: [{ op: 'move_item', itemId: 'other-item', dayId: 'day-2', order: 0 }] },
    },
    store,
  )
  await store.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '' })
  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'day-optimize', dayId: 'day-1' }))
  assert.equal(preview.status, 422)
  assert.deepEqual(await preview.json(), {
    error: '天级魔法棒只能重排目标天的已有卡片。',
    guidance: '建议未写入行程，请重新生成或换一个目标。',
    code: 'proposal_invalid',
  })
})

test('a day proposal is rejected if its card leaves the target day before confirmation', async () => {
  const store = new MemoryTripPatchStore()
  const input = {
    kind: 'day-optimize',
    targetDayId: 'day-1',
    title: '当天优化',
    summary: '调整当天顺序。',
    diff: [{ action: 'move', label: '调整当天顺序' }],
    patch: { ops: [{ op: 'move_item', itemId: 'item-a', dayId: 'day-1', order: 1 }] },
  }
  const { app, trip } = await makeApp(input, store)
  await store.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '第一天' })
  await store.upsertDayRow(trip.id, { id: 'day-2', idx: 1, date: '2026-10-03', theme: '第二天' })
  await store.upsertItemRow(trip.id, { id: 'item-a', dayId: 'day-1', itemOrder: 0, type: 'attraction', title: 'A', note: '', poi: JSON.stringify({ name: 'A', location: { lat: 49, lng: 119 } }), pending: false })
  await store.upsertItemRow(trip.id, { id: 'item-b', dayId: 'day-1', itemOrder: 1, type: 'attraction', title: 'B', note: '', poi: JSON.stringify({ name: 'B', location: { lat: 49.1, lng: 119.1 } }), pending: false })

  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'day-optimize', dayId: 'day-1' }))
  assert.equal(preview.status, 201)
  const proposal = ((await preview.json()) as { proposal: { id: string } }).proposal
  const moved = store.itemRows.find((row) => row.id === 'item-a' && row.trip_id === trip.id)
  assert.ok(moved)
  moved.day_id = 'day-2'
  const before = (await store.listItemRows(trip.id)).map((row) => [row.id, row.day_id, row.item_order])

  const applied = await app.request(`/api/trips/${trip.id}/ai/proposals/${proposal.id}/apply`, request('POST'))
  assert.equal(applied.status, 422)
  assert.deepEqual(await applied.json(), {
    error: '天级建议引用了目标天之外的卡片。',
    guidance: '建议未写入行程，请重新生成。',
    code: 'proposal_invalid',
  })
  assert.deepEqual((await store.listItemRows(trip.id)).map((row) => [row.id, row.day_id, row.item_order]), before)
})

test('global optimization applies its confirmed move through TripPatch', async () => {
  const store = new MemoryTripPatchStore()
  const input = {
    kind: 'optimize',
    title: '路线优化建议',
    summary: '先去 B 再去 A，减少折返。',
    diff: [{ action: 'move', label: '调整 A/B 顺序' }],
    patch: { ops: [{ op: 'move_item', itemId: 'item-b', dayId: 'day-1', order: 0 }] },
  }
  const { app, trip } = await makeApp(input, store)
  await store.upsertDayRow(trip.id, { id: 'day-1', idx: 0, date: '2026-10-02', theme: '原计划' })
  await store.upsertItemRow(trip.id, { id: 'item-a', dayId: 'day-1', itemOrder: 0, type: 'attraction', title: 'A', note: '', poi: JSON.stringify({ name: 'A', location: { lat: 49, lng: 119 } }), pending: false })
  await store.upsertItemRow(trip.id, { id: 'item-b', dayId: 'day-1', itemOrder: 1, type: 'attraction', title: 'B', note: '', poi: JSON.stringify({ name: 'B', location: { lat: 49.1, lng: 119.1 } }), pending: false })

  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'optimize' }))
  assert.equal(preview.status, 201)
  const proposal = ((await preview.json()) as { proposal: { id: string } }).proposal
  const applied = await app.request(`/api/trips/${trip.id}/ai/proposals/${proposal.id}/apply`, request('POST'))
  assert.equal(applied.status, 200)
  assert.deepEqual((await store.listItemRows(trip.id)).sort((a, b) => Number(a.item_order) - Number(b.item_order)).map((row) => row.id), ['item-b', 'item-a'])
})

test('optimization rejects a model turn that skips the read-only snapshot', async () => {
  const input = {
    kind: 'optimize',
    title: '路线优化建议',
    summary: '减少折返。',
    diff: [{ action: 'move', label: '调整顺序' }],
    patch: { ops: [{ op: 'move_item', itemId: 'item-b', dayId: 'day-1', order: 0 }] },
  }
  const { app, trip } = await makeApp(input, new MemoryTripPatchStore(), fakeProposalModel(input, { skipSnapshot: true }))
  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'optimize' }))
  assert.equal(preview.status, 422)
  assert.deepEqual(await preview.json(), {
    error: '路线优化建议未读取当前行程，无法确认建议范围。',
    guidance: '请重试；优化建议需要先读取当前行程后再生成。',
    code: 'proposal_invalid',
  })
})

test('HTTP proposal generation forwards the awaited snapshot result to the model', async () => {
  const input = {
    kind: 'optimize',
    title: '路线优化建议',
    summary: '保留当前日期并调整顺序。',
    diff: [{ action: 'move', label: '调整顺序' }],
    patch: { ops: [{ op: 'move_item', itemId: 'snapshot-item-b', dayId: 'snapshot-day', order: 0 }] },
  }
  const observed = { prompts: [] as unknown[] }
  const store = new MemoryTripPatchStore()
  const { app, trip } = await makeApp(input, store, snapshotBoundaryModel(input, observed))
  await store.upsertDayRow(trip.id, { id: 'snapshot-day', idx: 0, date: '2026-10-02', theme: '模型应看到的主题' })
  await store.upsertItemRow(trip.id, {
    id: 'snapshot-item-a', dayId: 'snapshot-day', itemOrder: 0, type: 'attraction', title: '模型应看到的起点', note: '',
    poi: JSON.stringify({ name: '模型应看到的起点', location: { lat: 49, lng: 119 } }), pending: false,
  })
  await store.upsertItemRow(trip.id, {
    id: 'snapshot-item-b', dayId: 'snapshot-day', itemOrder: 1, type: 'attraction', title: '模型应看到的终点', note: '',
    poi: JSON.stringify({ name: '模型应看到的终点', location: { lat: 49.1, lng: 119.1 } }), pending: false,
  })

  const response = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'optimize' }))
  assert.equal(response.status, 201)
  assert.equal(observed.prompts.length, 1)
  const modelPrompt = JSON.stringify(observed.prompts[0])
  assert.match(modelPrompt, /模型应看到的主题/)
  assert.match(modelPrompt, /模型应看到的起点/)
  assert.match(modelPrompt, /模型应看到的终点/)
})

test('global optimization cannot delete cards or days', async () => {
  const input = {
    kind: 'optimize',
    title: '路线优化建议',
    summary: '删除重复景点。',
    diff: [{ action: 'remove', label: '删除重复景点' }],
    patch: { ops: [{ op: 'remove_item', itemId: 'item-b' }] },
  }
  const { app, trip } = await makeApp(input)
  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'optimize' }))
  assert.equal(preview.status, 422)
  assert.deepEqual(await preview.json(), {
    error: '路线优化只能调整卡片顺序或内容，不能增删日期和卡片。',
    guidance: '建议未写入行程，请重新生成或换一个目标。',
    code: 'proposal_invalid',
  })
})
