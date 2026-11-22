/** Ticket 13: proposal generation is read-only until an explicit apply call. */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import type { TripSummary } from '../src/trips/types.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import type { Agent, MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import { SqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'
import { createSqliteWorkbenchStore } from '../src/days/driver-sqlite.js'
import { createSqliteRecommendationsStore } from '../src/recommendations/driver-sqlite.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import { Hono } from 'hono'
import type { AppEnv } from '../src/app.js'
import { registerAiProposalRoutes } from '../src/ai-proposals/routes.js'
import { MemoryAiProposalStore } from '../src/ai-proposals/types.js'

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

function snapshotBoundaryModel(input: unknown, observed: { prompts: unknown[] }, afterSnapshot?: () => Promise<void>): MastraLanguageModel {
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
      if (calls === 2) {
        observed.prompts.push(prompt)
        await afterSnapshot?.()
      }
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

const STASH_POI = {
  id: 'real-poi', amapId: '', name: '室内博物馆', lat: 49, lng: 119, category: '博物馆', type: 'attraction',
  region: '', rating: 4, introSummary: '雨天备用', address: '', images: [],
}
const STASH_CHOICE = '确认方案：安排候选活动'

async function sqliteProposalApp(t: TestContext, model: MastraLanguageModel) {
  const sqlite = await createSqliteTripRepository(':memory:')
  t.after(() => sqlite.close())
  const store = new SqliteTripPatchStore(sqlite.db)
  const app = await createApp({
    tripRepository: sqlite.repository, tripPatchStore: store, workbenchStore: createSqliteWorkbenchStore(sqlite.db),
    recommendationsStore: createSqliteRecommendationsStore(sqlite.db), messageStore: new MemoryMessageStoreDriver(),
    plannerModel: model, plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
  })
  const created = await sqlite.repository.create({ title: '候选确认', startDate: '2026-10-02', endDate: '2026-10-02' })
  assert.ok(created.ok)
  const trip = created.trip
  await store.upsertDayRow(trip.id, { id: 'stash-day', idx: 0, date: '2026-10-02', theme: '保留主题' })
  return { ...sqlite, store, app, trip }
}

function stashExplainingModel(options: { onConfirmed?: () => Promise<void>; confirmedPrompts?: unknown[]; patch?: { ops: unknown[] }; explainOnly?: boolean } = {}) {
  let calls = 0
  const model = {
    specificationVersion: 'v2', provider: 'test.stash-confirmation', modelId: 'stash-confirmation', supportedUrls: Promise.resolve({}),
    doGenerate: async () => { throw new Error('streaming only') },
    doStream: async ({ prompt }: { prompt?: unknown }) => {
      calls += 1
      if (calls >= 3) options.confirmedPrompts?.push(prompt)
      if (calls === 3) await options.onConfirmed?.()
      const parts: Part[] = calls === 1 ? [
        { type: 'tool-call', toolCallId: 'premature-stash', toolName: 'apply_trip_patch', input: JSON.stringify(options.patch ?? {
          ops: [{ op: 'add_stash', stashId: 'premature', title: '不得提前写入', poi: null }],
        }) },
        { type: 'tool-call', toolCallId: 'stash-explain', toolName: 'emit_round_meta', input: JSON.stringify({
          round: 'patch-explain', impacts: ['候选将进入日程'], chips: [{ label: '确认安排', value: STASH_CHOICE }],
        }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ] : calls === 3 && (options.onConfirmed || options.patch) ? [
        { type: 'tool-call', toolCallId: 'confirmed-stash', toolName: 'apply_trip_patch', input: JSON.stringify(options.patch ?? { ops: [
          { op: 'move_stash_to_day', stashId: 'race-stash', itemId: 'race-item', dayId: 'stash-day', pending: true },
        ] }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ] : [
        { type: 'text-start', id: 'stash-reply' }, { type: 'text-delta', id: 'stash-reply', delta: '请确认候选安排。' },
        { type: 'text-end', id: 'stash-reply' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ]
      const emitted = calls === 1 && options.explainOnly
        ? parts.filter((part) => part.type !== 'tool-call' || part.toolName !== 'apply_trip_patch')
        : parts
      return { stream: new ReadableStream({ start(controller) { for (const part of emitted) controller.enqueue(part); controller.close() } }) }
    },
  } as unknown as MastraLanguageModel
  return { model, calls: () => calls }
}

for (const change of ['REST add', 'REST delete', 'favorite add', 'favorite delete', 'invalid raw row bytes', 'title', 'note', 'category', 'created_at', 'added_at', 'origin', 'poi'] as const) {
  test(`explain then stash change through ${change} rejects the old confirmation before the model runs`, async (t) => {
    const scripted = stashExplainingModel()
    const { app, trip, db, store } = await sqliteProposalApp(t, scripted.model)
    let removeId = ''
    if (change === 'favorite delete') {
      const favorite = await app.request(`/api/trips/${trip.id}/favorites`, request('POST', { poi: STASH_POI }))
      assert.equal(favorite.status, 201)
      removeId = ((await favorite.json()) as { favorite: { id: string } }).favorite.id
    } else if (change === 'REST delete') {
      const stash = await app.request(`/api/trips/${trip.id}/stash`, request('POST', { poi: STASH_POI }))
      assert.equal(stash.status, 201)
      removeId = ((await stash.json()) as { item: { id: string } }).item.id
    } else if (change !== 'REST add' && change !== 'favorite add') {
      await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at) VALUES (?, ?, ?, ?, ?)',
        ['raw-stash', trip.id, change === 'invalid raw row bytes' ? '{invalid json' : JSON.stringify(STASH_POI), 'recommend', '2026-10-01'])
      if (change === 'invalid raw row bytes') await db.run("UPDATE stash SET note = x'01' WHERE id = ?", ['raw-stash'])
    }
    const before = (await db.run('SELECT * FROM stash')).rows
    const tripBefore = (await db.run('SELECT * FROM trips')).rows
    const explained = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: '帮我重新安排候选活动' }))
    assert.equal(explained.status, 200)
    assert.match(await explained.text(), /patch-explain/)
    assert.ok((await store.getPatchConfirmation(trip.id))?.choices.includes(STASH_CHOICE))
    assert.deepEqual((await db.run('SELECT * FROM stash')).rows, before, 'explanation cannot write even if the model attempts a patch')
    const modelCalls = scripted.calls()
    if (change === 'REST add' || change === 'favorite add') {
      const added = await app.request(`/api/trips/${trip.id}/${change === 'REST add' ? 'stash' : 'favorites'}`, request('POST', { poi: STASH_POI }))
      assert.equal(added.status, 201)
    } else if (change === 'REST delete' || change === 'favorite delete') {
      const removed = await app.request(`/api/trips/${trip.id}/${change === 'REST delete' ? 'stash' : 'favorites'}/${removeId}`, request('DELETE'))
      assert.equal(removed.status, 200)
    } else if (change === 'invalid raw row bytes') {
      const visibleBefore = await app.request(`/api/trips/${trip.id}/stash`)
      assert.deepEqual(await visibleBefore.json(), { stash: [] })
      await db.run("UPDATE stash SET note = x'03' WHERE id = ?", ['raw-stash'])
      const visibleAfter = await app.request(`/api/trips/${trip.id}/stash`)
      assert.deepEqual(await visibleAfter.json(), { stash: [] }, 'tolerant display is identical despite changed raw bytes')
    } else {
      await db.run(`UPDATE stash SET ${change} = ? WHERE id = ?`, [change === 'poi' ? '{now-invalid' : 'changed raw value', 'raw-stash'])
    }
    assert.deepEqual((await db.run('SELECT * FROM trips')).rows, tripBefore, 'stash alone invalidates the confirmation')
    const after = (await db.run('SELECT * FROM stash')).rows
    const stale = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: STASH_CHOICE }))
    assert.equal(stale.status, 409)
    assert.equal((await stale.json() as { code: string }).code, 'confirmation_stale')
    assert.equal(scripted.calls(), modelCalls)
    assert.deepEqual((await db.run('SELECT * FROM stash')).rows, after)
    assert.equal((await store.listItemRows(trip.id)).length, 0)
  })
}

for (const explainOnly of [false, true]) {
  test(`a trip with only stash candidates confirms its first day after ${explainOnly ? 'direct explanation without apply attempt' : 'a blocked write'}`, async (t) => {
    const scripted = stashExplainingModel({ explainOnly, patch: { ops: [
      { op: 'add_day', dayId: 'first-stash-day', date: '2026-10-02' },
      { op: 'move_stash_to_day', stashId: 'only-stash', itemId: 'first-stash-item', dayId: 'first-stash-day', pending: true },
    ] } })
    const { app, db, store, trip } = await sqliteProposalApp(t, scripted.model)
    await store.deleteDayRow(trip.id, 'stash-day')
    await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at, title) VALUES (?, ?, ?, ?, ?, ?)',
      ['only-stash', trip.id, 'null', 'recommend', '2026-10-01', '尚未排期的候选'])
    // The modification classifier does not recognize this initial planning
    // phrase; either a direct explanation or a blocked write must be confirmable.
    const explain = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: '帮我规划一天行程' }))
    assert.equal(explain.status, 200)
    const explained = await explain.text()
    assert.match(explained, /patch-explain/)
    assert.doesNotMatch(explained, /event: applied_patch/)
    assert.equal((await store.listDayRows(trip.id)).length, 0)
    assert.equal((await store.listItemRows(trip.id)).length, 0)
    assert.equal((await store.listStashRows(trip.id)).length, 1)
    assert.ok((await store.getPatchConfirmation(trip.id))?.choices.includes(STASH_CHOICE))
    const confirm = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: STASH_CHOICE }))
    assert.equal(confirm.status, 200)
    assert.match(await confirm.text(), /event: applied_patch/)
    assert.equal((await store.listDayRows(trip.id)).length, 1)
    assert.equal((await store.listItemRows(trip.id)).length, 1)
    assert.equal((await store.listStashRows(trip.id)).length, 0)
  })
}

test('stash-only draft dates do not create a false conflict with a requested planning duration', async (t) => {
  const { app, db, store, trip } = await sqliteProposalApp(t, stashExplainingModel().model)
  await store.deleteDayRow(trip.id, 'stash-day')
  await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at, title) VALUES (?, ?, ?, ?, ?, ?)',
    ['draft-stash', trip.id, 'null', 'recommend', '2026-10-01', '草稿候选'])
  const response = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: '帮我规划3天行程' }))
  assert.equal(response.status, 200)
  const stream = await response.text()
  assert.doesNotMatch(stream, /当前行程日期|当前计划有|不能静默选择/)
  assert.match(stream, /patch-explain/)
  assert.doesNotMatch(stream, /event: applied_patch/)
  assert.equal((await store.listDayRows(trip.id)).length, 0)
  assert.equal((await store.listStashRows(trip.id)).length, 1)
  assert.ok((await store.getPatchConfirmation(trip.id))?.choices.includes(STASH_CHOICE))
})

test('stash changes during a confirmed model turn are rejected inside the patch transaction', async (t) => {
  let mutate!: () => Promise<void>
  const prompts: unknown[] = []
  const scripted = stashExplainingModel({ onConfirmed: async () => mutate(), confirmedPrompts: prompts })
  const { app, db, store, trip } = await sqliteProposalApp(t, scripted.model)
  await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at, title) VALUES (?, ?, ?, ?, ?, ?)',
    ['race-stash', trip.id, 'null', 'recommend', '2026-10-01', '原候选'])
  mutate = async () => { await db.run('UPDATE stash SET title = ? WHERE id = ?', ['模型运行时被修改', 'race-stash']) }
  const explain = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: '帮我重新安排候选活动' }))
  assert.equal(explain.status, 200)
  await explain.text()
  const confirm = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: STASH_CHOICE }))
  assert.equal(confirm.status, 200)
  const stream = await confirm.text()
  assert.doesNotMatch(stream, /event: applied_patch/)
  assert.equal((await store.listItemRows(trip.id)).length, 0)
  assert.equal((await store.listStashRows(trip.id))[0]?.title, '模型运行时被修改')
  assert.match(JSON.stringify(prompts), /已经过期/)
})

test('a confirmed patch expires when only the Trip dates change during generation', async (t) => {
  const patch = { ops: [{ op: 'update_day', dayId: 'stash-day', theme: '过期安排' }] }
  const scripted = stashExplainingModel({ patch, onConfirmed: async () => {
    const updated = await app.request(`/api/trips/${trip.id}`, request('PATCH', {
      startDate: '2026-10-04', endDate: '2026-10-05',
    }))
    assert.equal(updated.status, 200)
  } })
  const { app, store, trip, repository } = await sqliteProposalApp(t, scripted.model)
  const before = await store.listDayRows(trip.id)
  const explain = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: '帮我重新安排候选活动' }))
  assert.equal(explain.status, 200)
  assert.match(await explain.text(), /patch-explain/)
  assert.ok((await store.getPatchConfirmation(trip.id))?.choices.includes(STASH_CHOICE))

  const confirmed = await app.request(`/api/trips/${trip.id}/messages`, request('POST', { content: STASH_CHOICE }))
  assert.equal(confirmed.status, 200)
  const stream = await confirmed.text()
  assert.doesNotMatch(stream, /event: applied_patch/)
  assert.equal((await repository.get(trip.id))?.startDate, '2026-10-04')
  assert.match(stream, /confirmation_stale.*重新分析/)
  assert.deepEqual(await store.listDayRows(trip.id), before)
})

test('global stash optimization exposes real candidate IDs to the model and writes only on explicit apply', async (t) => {
  const input = {
    kind: 'optimize', title: '候选进入日程', summary: '把已有候选与一项文字备选安排到当天。',
    diff: [{ action: 'move', label: '安排已有候选', stashId: 'persisted-stash', itemId: 'from-stash', toDayId: 'stash-day' }],
    patch: { ops: [
      { op: 'move_stash_to_day', stashId: 'persisted-stash', itemId: 'from-stash', dayId: 'stash-day' },
      { op: 'move_stash_to_day', stashId: 'persisted-text-stash', itemId: 'from-existing-text', dayId: 'stash-day', pending: true },
      { op: 'add_stash', stashId: 'new-text-stash', title: '自由散步', note: '看天气', category: '备选', poi: null },
      { op: 'move_stash_to_day', stashId: 'new-text-stash', itemId: 'from-text', dayId: 'stash-day', pending: true, timeRange: '傍晚', cost: '0' },
    ] },
  }
  const observed = { prompts: [] as unknown[] }
  const { app, db, store, trip } = await sqliteProposalApp(t, snapshotBoundaryModel(input, observed))
  await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at, title, note, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ['persisted-stash', trip.id, JSON.stringify(STASH_POI), 'recommend', '2026-10-01', '作者候选标题', '作者候选备注', '室内', '2026-10-01'])
  await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at, title, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['persisted-text-stash', trip.id, 'null', 'recommend', '2026-10-01', '既有纯文字候选', '无需虚构点位'])
  const before = (await db.run('SELECT * FROM stash')).rows
  const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'optimize' }))
  assert.equal(preview.status, 201, JSON.stringify(await preview.clone().json()))
  const proposal = ((await preview.json()) as { proposal: { id: string; diff: { stashId: string }[] } }).proposal
  assert.equal(proposal.diff[0]?.stashId, 'persisted-stash')
  const prompt = JSON.stringify(observed.prompts)
  assert.match(prompt, /persisted-stash/)
  assert.match(prompt, /作者候选标题/)
  assert.match(prompt, /作者候选备注/)
  assert.match(prompt, /persisted-text-stash/)
  assert.match(prompt, /既有纯文字候选/)
  assert.match(prompt, /无需虚构点位/)
  assert.deepEqual((await db.run('SELECT * FROM stash')).rows, before)
  assert.equal((await store.listItemRows(trip.id)).length, 0)
  const applied = await app.request(`/api/trips/${trip.id}/ai/proposals/${proposal.id}/apply`, request('POST'))
  assert.equal(applied.status, 200, JSON.stringify(await applied.clone().json()))
  assert.equal((await db.run('SELECT * FROM stash')).rows.length, 0)
  const items = await store.listItemRows(trip.id)
  assert.equal(items.find((item) => item.id === 'from-stash')?.title, '作者候选标题')
  assert.equal(items.find((item) => item.id === 'from-existing-text')?.title, '既有纯文字候选')
  assert.equal(items.find((item) => item.id === 'from-text')?.time_range, '傍晚')
  assert.equal(items.find((item) => item.id === 'from-text')?.cost, '0')
  assert.equal((await store.listLegRows(trip.id)).length, 2)
})

for (const timing of ['during generation', 'before confirmation', 'at transaction entry'] as const) {
  test(`stash proposal rejects raw changes ${timing} using the snapshot the model read`, async (t) => {
    const input = {
      kind: 'optimize', title: '安排候选', summary: '把候选移入日程。', diff: [{ action: 'move', label: '安排候选', stashId: 'bound-stash' }],
      patch: { ops: [{ op: 'move_stash_to_day', stashId: 'bound-stash', itemId: 'bound-item', dayId: 'stash-day', pending: true }] },
    }
    let mutate: (() => Promise<void>) | undefined
    const model = snapshotBoundaryModel(input, { prompts: [] }, async () => { if (timing === 'during generation') await mutate?.() })
    const { app, db, store, trip } = await sqliteProposalApp(t, model)
    await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at, title, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['bound-stash', trip.id, 'null', 'recommend', '2026-10-01', '原候选标题', '原候选备注'])
    mutate = async () => { await db.run("UPDATE stash SET note = x'0312' WHERE id = ?", ['bound-stash']) }
    const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'optimize' }))
    assert.equal(preview.status, 201)
    const proposal = ((await preview.json()) as { proposal: { id: string } }).proposal
    if (timing === 'before confirmation') await mutate()
    if (timing === 'at transaction entry') {
      const transaction = store.withTransaction.bind(store)
      store.withTransaction = async (fn) => { await mutate!(); return transaction(fn) }
    }
    const applied = await app.request(`/api/trips/${trip.id}/ai/proposals/${proposal.id}/apply`, request('POST'))
    assert.equal(applied.status, 409)
    assert.equal((await applied.json() as { code: string }).code, 'proposal_stale')
    assert.equal((await store.listItemRows(trip.id)).length, 0)
    assert.equal((await store.listStashRows(trip.id)).length, 1)
  })
}

for (const op of [
  { op: 'add_stash', stashId: 'day-forbidden', title: '不可新增', poi: null },
  { op: 'move_stash_to_day', stashId: 'day-forbidden', itemId: 'day-forbidden-item', dayId: 'stash-day' },
]) {
  test(`day optimization cannot use ${op.op}`, async (t) => {
    const input = {
      kind: 'day-optimize', targetDayId: 'stash-day', title: '当天优化', summary: '当天仅可重排已有卡片。',
      diff: [{ action: 'add', label: '非法候选调整' }], patch: { ops: [op] },
    }
    const { app, store, trip } = await sqliteProposalApp(t, fakeProposalModel(input))
    const preview = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'day-optimize', dayId: 'stash-day' }))
    assert.equal(preview.status, 422)
    assert.match((await preview.json() as { error: string }).error, /只能重排/)
    assert.equal((await store.listStashRows(trip.id)).length, 0)
    assert.equal((await store.listItemRows(trip.id)).length, 0)
  })
}

test('server creation and explicit apply enforce matching proposal kinds and operation scopes', async (t) => {
  const { repository, store, trip } = await sqliteProposalApp(t, fakeProposalModel(PARSE_PROPOSAL))
  const proposals = new MemoryAiProposalStore()
  const app = new Hono<AppEnv>()
  // Script only the planner boundary: deliberately return a mismatched tool
  // result to exercise the HTTP gate independently of the tool's own checks.
  const planner = { stream: async () => ({ fullStream: (async function* () {
    yield { type: 'tool-result', payload: { toolName: 'create_trip_proposal', result: { ok: true, proposal: {
      ...PARSE_PROPOSAL, kind: 'optimize',
    } } } }
  })() }) } as unknown as Agent
  registerAiProposalRoutes(app, {
    tripRepository: repository, planner, modelConfigured: true, memoryConfigured: false,
    resolveTripPatchStore: async () => store, proposalStore: proposals,
  })
  const mismatched = await app.request(`/api/trips/${trip.id}/ai/proposals`, request('POST', { kind: 'parse', text: '攻略' }))
  assert.equal(mismatched.status, 422)
  assert.match((await mismatched.json() as { error: string }).error, /类型与请求不一致/)

  const invalid = [
    { kind: 'optimize' as const, patch: { ops: [{ op: 'remove_day' as const, dayId: 'stash-day' }] } },
    { kind: 'day-optimize' as const, targetDayId: 'stash-day', patch: { ops: [{ op: 'add_stash' as const, stashId: 'forbidden', title: '不应写入', poi: null }] } },
    { kind: 'parse' as const, patch: { ops: [{ op: 'move_stash_to_day' as const, stashId: 'missing', itemId: 'missing-item', dayId: 'stash-day' }] } },
  ]
  for (const [index, payload] of invalid.entries()) {
    const id = `invalid-scope-${index}`
    proposals.save({
      id, tripId: trip.id, title: '范围外建议', summary: '不应应用', createdAt: new Date().toISOString(),
      diff: [{ action: 'move', label: '范围外调整' }], ...payload,
    })
    const apply = await app.request(`/api/trips/${trip.id}/ai/proposals/${id}/apply`, request('POST'))
    assert.equal(apply.status, 422)
    assert.equal((await apply.json() as { code: string }).code, 'proposal_invalid')
  }
  assert.equal((await store.listDayRows(trip.id)).length, 1)
  assert.equal((await store.listItemRows(trip.id)).length, 0)
  assert.equal((await store.listStashRows(trip.id)).length, 0)
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
    error: '路线优化只能调整已有卡片、新增候选或将候选移入日程，不能增删日期或删除卡片。',
    guidance: '建议未写入行程，请重新生成或换一个目标。',
    code: 'proposal_invalid',
  })
})
