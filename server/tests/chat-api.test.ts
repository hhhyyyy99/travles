/**
 * Chat SSE loop tests (ticket 06) — the highest seam (spec 测试接缝 #1).
 *
 * Every test drives the REAL app via app.request() (Hono, no port, no
 * internal mocks): the mock model is injected at the Mastra model boundary,
 * or, for the env-routing tests, a real local OpenAI-compatible HTTP server
 * stands in for the provider. We assert the SSE event sequence, message
 * persistence, and (for the SQLite path) agent memory over the same
 * database file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import type { TripSummary } from '../src/trips/types.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import type { MastraLanguageModel } from '@mastra/core/agent'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'
import type { MastraMemory } from '@mastra/core/memory'

/**
 * Local subset of the AI SDK v2 stream-part union — the public @mastra/core
 * entrypoints don't re-export `LanguageModelV2StreamPart`, so the fake model
 * casts its parts through this shape.
 */
type StreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'finish'; finishReason: 'stop'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

/** Fake language model: streams the given chunks as text deltas (v2 spec). */
function fakeStreamModel(chunks: string[], options: { fail?: boolean } = {}): MastraLanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'test.mock',
    modelId: 'mock-model',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => {
      throw new Error('doGenerate not used in this ticket')
    },
    doStream: async () => {
      if (options.fail) throw new Error('fetch failed: 模型服务不可用（连接被拒绝）')
      const parts: StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        ...chunks.flatMap((delta): StreamPart[] => [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta },
        ]),
        { type: 'text-end', id: 't1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
        },
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

type SseEvent = { event: string; data: unknown }

/** Parse an SSE body into `{event, data}` pairs (data stays JSON-parsed). */
function parseSSE(raw: string): SseEvent[] {
  const events: SseEvent[] = []
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

type InjectedApp = Awaited<ReturnType<typeof createApp>>

async function makeInjectedApp(model: MastraLanguageModel, memory?: MastraMemory): Promise<{
  app: InjectedApp
  trip: TripSummary
  messageStore: MemoryMessageStoreDriver
}> {
  const messageStore = new MemoryMessageStoreDriver()
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    messageStore,
    plannerModel: model,
    plannerMemory: memory ?? new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
  })
  const res = await app.request('/api/trips', jsonRequest('POST', { title: '呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-04' }))
  assert.equal(res.status, 201)
  const trip = ((await res.json()) as { trip: TripSummary }).trip
  return { app, trip, messageStore }
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await probe()
    if (found !== null) return found
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('qa round: mock model streams through SSE, deltas arrive in order, both messages persist', async () => {
  const { app, trip, messageStore } = await makeInjectedApp(fakeStreamModel(['海拉尔', '的秋天', '很适合看草原。']))

  const res = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '十一去海拉尔穿什么？' }))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

  const events = parseSSE(await res.text())

  // Event sequence: start → delta… → done, no error.
  assert.deepEqual(
    events.map((e) => e.event),
    ['start', 'delta', 'delta', 'delta', 'done'],
  )
  assert.deepEqual((events[0] as { data: { round: string } }).data, { round: 'qa' })
  const deltas = events.filter((e) => e.event === 'delta') as { data: { text: string } }[]
  assert.deepEqual(
    deltas.map((d) => d.data.text),
    ['海拉尔', '的秋天', '很适合看草原。'],
  )

  // `done` echoes the persisted user + assistant messages with server ids.
  const done = events[events.length - 1] as {
    data: { userMessage: { role: string; content: string }; assistantMessage: { role: string; content: string } }
  }
  assert.equal(done.data.userMessage.role, 'user')
  assert.equal(done.data.userMessage.content, '十一去海拉尔穿什么？')
  assert.equal(done.data.assistantMessage.role, 'assistant')
  assert.equal(done.data.assistantMessage.content, '海拉尔的秋天很适合看草原。')

  // Persistence: GET history returns both turns, oldest first.
  const history = await app.request(`/api/trips/${trip.id}/messages`)
  assert.equal(history.status, 200)
  const historyBody = (await history.json()) as { messages: { role: string; content: string }[] }
  assert.deepEqual(
    historyBody.messages.map((m) => [m.role, m.content]),
    [
      ['user', '十一去海拉尔穿什么？'],
      ['assistant', '海拉尔的秋天很适合看草原。'],
    ],
  )
  assert.equal(messageStore.messageRows.length, 2)
})

test('qa round: agent memory keeps one thread per trip (thread id trip-<tripId>)', async () => {
  const memory = new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true })
  const { app, trip } = await makeInjectedApp(fakeStreamModel(['好的。']), memory)

  const res = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '你好' }))
  assert.equal(res.status, 200)
  const events = parseSSE(await res.text())
  assert.equal(events[events.length - 1]?.event, 'done')

  await waitFor(async () => {
    const thread = await memory.getThreadById({ threadId: `trip-${trip.id}` })
    return thread ?? null
  })
})

test('model stream failure surfaces as an in-stream error event with guidance, nothing persists', async () => {
  const { app, trip, messageStore } = await makeInjectedApp(fakeStreamModel([], { fail: true }))

  const res = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '你好' }))
  assert.equal(res.status, 200, 'the stream itself starts; the failure arrives in-stream')

  const events = parseSSE(await res.text())
  assert.deepEqual(
    events.map((e) => e.event),
    ['start', 'error', 'close'],
  )
  const error = events.find((e) => e.event === 'error') as { data: { code: string; message: string; guidance: string } }
  assert.equal(error.data.code, 'model_unavailable')
  assert.ok(error.data.message.length > 0)
  assert.ok(error.data.guidance.length > 0, 'spec 用户故事 25: guidance tells the user what to do')

  const history = await app.request(`/api/trips/${trip.id}/messages`)
  const historyBody = (await history.json()) as { messages: unknown[] }
  assert.equal(historyBody.messages.length, 0)
  assert.equal(messageStore.messageRows.length, 0)
})

test('chat endpoints validate trip and payload before starting the stream', async () => {
  const { app, trip } = await makeInjectedApp(fakeStreamModel(['ok']))

  const unknownTrip = await app.request('/api/trips/nope/messages', jsonRequest('POST', { content: 'hi' }))
  assert.equal(unknownTrip.status, 404)

  const unknownTripGet = await app.request('/api/trips/nope/messages')
  assert.equal(unknownTripGet.status, 404)

  const emptyContent = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '   ' }))
  assert.equal(emptyContent.status, 400)

  const missingContent = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', {}))
  assert.equal(missingContent.status, 400)

  const notJson = await app.request(`/api/trips/${trip.id}/messages`, { method: 'POST', body: 'nope', headers: { 'content-type': 'application/json' } })
  assert.equal(notJson.status, 400)
})

test('no model configured → HTTP 503 with guidance before any stream starts', async () => {
  const savedEnv = { ...process.env }
  delete process.env.AI_BASE_URL
  delete process.env.AI_API_KEY
  try {
    const app = await createApp({
      tripRepository: new TripRepository(new MemoryTripStoreDriver()),
      // No plannerModel → the app runs without a configured model.
      plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    })
    const res = await app.request('/api/trips', jsonRequest('POST', { title: 't', startDate: '2026-10-02', endDate: '2026-10-03' }))
    const trip = ((await res.json()) as { trip: TripSummary }).trip

    const chat = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: 'hi' }))
    assert.equal(chat.status, 503)
    const body = (await chat.json()) as { error: string; guidance: string }
    assert.ok(body.error.includes('模型服务未配置'))
    assert.ok(body.guidance.includes('AI_BASE_URL'))
  } finally {
    Object.assign(process.env, savedEnv)
  }
})

// ---- Env-routed OpenAI-compatible endpoint tests ---------------------------
// These exercise the REAL model routing path (Mastra's OpenAI-compatible
// config built from AI_* env vars) against a local stand-in provider.

type OpenAiServer = {
  server: Server
  url: string
  requests: { messages: { role: string; content: unknown }[] }[]
  close: () => Promise<void>
}

/** Local OpenAI-compatible /chat/completions stand-in that streams `reply`. */
function startOpenAiCompatibleServer(options: { reply?: string; status?: number } = {}): Promise<OpenAiServer> {
  const requests: OpenAiServer['requests'] = []
  const reply = options.reply ?? '海拉尔的秋天很适合看草原。'
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let parsed: { messages?: { role: string; content: unknown }[] } = {}
      try {
        parsed = JSON.parse(body)
      } catch {
        /* ignore */
      }
      requests.push({ messages: parsed.messages ?? [] })

      if (options.status !== undefined && options.status !== 200) {
        res.writeHead(options.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'invalid_request_error' } }))
        return
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          created: 1700000000,
          model: 'test-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`
      res.write(chunk({ role: 'assistant', content: '' }, null))
      res.write(chunk({ content: reply }, null))
      res.write(chunk({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        server,
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

async function withAiEnv<T>(baseUrl: string, run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env }
  process.env.AI_BASE_URL = baseUrl
  process.env.AI_API_KEY = 'test-key'
  process.env.AI_MODEL = 'test-model'
  try {
    return await run()
  } finally {
    Object.assign(process.env, saved)
  }
}

test('AI_* env routing: full loop through a real OpenAI-compatible endpoint, memory over the same SQLite file', async () => {
  const provider = await startOpenAiCompatibleServer({ reply: '白天 8 度，带抓绒。' })
  const dir = await mkdtemp(join(tmpdir(), 'hailar-chat-'))
  try {
    await withAiEnv(provider.url, async () => {
      const app = await createApp({ databaseUrl: join(dir, 'trips.db') })
      const created = await app.request('/api/trips', jsonRequest('POST', { title: '呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-04' }))
      const trip = ((await created.json()) as { trip: TripSummary }).trip

      const res = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '十月上旬海拉尔冷不冷？' }))
      assert.equal(res.status, 200)
      const events = parseSSE(await res.text())
      assert.deepEqual(
        events.map((e) => e.event),
        ['start', 'delta', 'done'],
      )
      const deltas = events.filter((e) => e.event === 'delta') as { data: { text: string } }[]
      assert.equal(deltas.map((d) => d.data.text).join(''), '白天 8 度，带抓绒。')

      // Turn 2: the provider sees the prior turn again (memory recall from
      // the same SQLite database), proving thread-per-trip over that file.
      const res2 = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '那晚上呢？' }))
      assert.equal(res2.status, 200)
      const events2 = parseSSE(await res2.text())
      assert.equal(events2[events2.length - 1]?.event, 'done')

      const firstTurn = provider.requests[0]
      const secondTurn = provider.requests[1]
      assert.ok(firstTurn && secondTurn, 'both turns reached the provider')
      const serializedFirst = JSON.stringify(firstTurn.messages)
      const serializedSecond = JSON.stringify(secondTurn.messages)
      assert.ok(serializedSecond.includes('十月上旬海拉尔冷不冷？'), 'second turn replays the first user message')
      assert.ok(serializedSecond.includes('白天 8 度，带抓绒。'), 'second turn replays the first assistant reply')
      assert.ok(serializedSecond.length > serializedFirst.length)
    })
  } finally {
    await provider.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('AI_* env routing: provider 401 → in-stream model_auth error with guidance, nothing persists', async () => {
  const provider = await startOpenAiCompatibleServer({ status: 401 })
  try {
    await withAiEnv(provider.url, async () => {
      const app = await createApp({ databaseUrl: join(tmpdir(), 'hailar-chat-auth.db') })
      try {
        const created = await app.request('/api/trips', jsonRequest('POST', { title: '呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-04' }))
        const trip = ((await created.json()) as { trip: TripSummary }).trip

        const res = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '你好' }))
        assert.equal(res.status, 200)

        const events = parseSSE(await res.text())
        assert.deepEqual(
          events.map((e) => e.event),
          ['start', 'error', 'close'],
        )
        const error = events.find((e) => e.event === 'error') as { data: { code: string; message: string; guidance: string } }
        assert.equal(error.data.code, 'model_auth')
        assert.match(error.data.message, /鉴权失败/)
        assert.ok(error.data.guidance.length > 0)

        const history = await app.request(`/api/trips/${trip.id}/messages`)
        const historyBody = (await history.json()) as { messages: unknown[] }
        assert.equal(historyBody.messages.length, 0)
      } finally {
        await rm(join(tmpdir(), 'hailar-chat-auth.db'), { force: true })
      }
    })
  } finally {
    await provider.close()
  }
})
