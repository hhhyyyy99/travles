/** Ticket 12 provider settings and dynamic model integration tests. */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import { MemoryAiProviderStoreDriver } from '../src/ai-providers/driver-memory.js'
import { probeAiProvider } from '../src/ai-providers/probe.js'
import { createProviderModel } from '../src/ai-providers/model.js'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import type { AiProviderProbe } from '../src/ai-providers/routes.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  }
}

function successfulProbe(): AiProviderProbe {
  return async (_provider) => ({
    ok: true,
    capabilities: {
      streaming: true,
      functionCalling: true,
      degraded: false,
      testedAt: '2026-09-12T00:00:00.000Z',
      error: null,
    },
  })
}

async function makeSettingsApp(probe = successfulProbe()) {
  const store = new MemoryAiProviderStoreDriver()
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    aiProviderStore: store,
    aiProviderProbe: probe,
  })
  return { app, store }
}

const providerInput = {
  name: '内部网关',
  baseUrl: 'https://model.example.test/v1/',
  modelId: 'planner-1',
  protocol: 'chat-completions' as const,
  apiKey: 'sk-provider-secret',
  headers: { 'X-Tenant': 'header-secret' },
}

type ProviderModel = {
  doStream(options: { prompt: Array<{ role: string; content: unknown }> }): Promise<{ stream: ReadableStream<Record<string, unknown>> }>
}

async function readProviderParts(model: ProviderModel, prompt: Array<{ role: string; content: unknown }>): Promise<Record<string, unknown>[]> {
  const result = await model.doStream({ prompt })
  const reader = result.stream.getReader()
  const parts: Record<string, unknown>[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) return parts
    parts.push(next.value)
  }
}

test('provider settings persist multiple configs, select a default, and redact every secret', async () => {
  const { app, store } = await makeSettingsApp()
  const first = await app.request('/api/settings/ai-providers', jsonRequest('POST', providerInput))
  assert.equal(first.status, 201)
  const firstBody = await first.json() as Record<string, unknown>
  const publicProvider = firstBody.provider as Record<string, unknown>
  assert.equal('apiKey' in publicProvider, false)
  assert.equal(publicProvider.hasApiKey, true)
  assert.deepEqual(publicProvider.headers, { 'X-Tenant': '[hidden]' })
  assert.deepEqual(publicProvider.headerNames, ['X-Tenant'])
  const firstText = JSON.stringify(firstBody)
  assert.equal(firstText.includes(providerInput.apiKey), false)
  assert.equal(firstText.includes('header-secret'), false)

  const second = await app.request('/api/ai-providers', jsonRequest('POST', {
    ...providerInput,
    name: '备用 Responses',
    protocol: 'responses',
    apiKey: 'sk-second-secret',
    headers: { 'X-Region': 'region-secret' },
    isDefault: false,
  }))
  assert.equal(second.status, 201)
  const secondProvider = (await second.json() as { provider: { id: string } }).provider

  const list = await app.request('/api/settings/ai-providers')
  assert.equal(list.status, 200)
  const listed = await list.json() as { providers: Record<string, unknown>[]; defaultProviderId: string }
  assert.equal(listed.providers.length, 2)
  assert.equal(listed.providers[0]?.isDefault, true)
  assert.equal(listed.defaultProviderId, publicProvider.id)
  assert.equal(JSON.stringify(listed).includes('sk-second-secret'), false)
  assert.equal(JSON.stringify(listed).includes('region-secret'), false)

  // Even a legacy/corrupt capability row cannot turn an upstream secret into
  // a settings response.
  const storedFirst = store.rows.get(String(publicProvider.id))
  assert.ok(storedFirst)
  storedFirst.last_error = `provider ${providerInput.apiKey} header-secret`
  storedFirst.capabilities = JSON.stringify({ streaming: true, functionCalling: false, degraded: true, testedAt: null, error: providerInput.apiKey })
  const redactedLegacy = await app.request('/api/settings/ai-providers')
  const redactedLegacyText = await redactedLegacy.text()
  assert.equal(redactedLegacyText.includes(providerInput.apiKey), false)
  assert.equal(redactedLegacyText.includes('header-secret'), false)

  const selected = await app.request(`/api/settings/ai-providers/${secondProvider.id}/default`, jsonRequest('POST'))
  assert.equal(selected.status, 200)
  const afterSelect = await app.request('/api/settings/ai-providers')
  const afterSelectBody = await afterSelect.json() as { defaultProviderId: string }
  assert.equal(afterSelectBody.defaultProviderId, secondProvider.id)

  // An update with no apiKey keeps the server-side secret in place.
  const update = await app.request(`/api/settings/ai-providers/${publicProvider.id}`, jsonRequest('PATCH', {
    ...providerInput,
    name: '内部网关更新',
    modelId: 'planner-2',
  }))
  assert.equal(update.status, 200)
  assert.equal(store.rows.get(String(publicProvider.id))?.api_key, providerInput.apiKey)
  assert.equal(JSON.stringify(await update.json()).includes(providerInput.apiKey), false)
})

test('saving a provider runs connectivity/capability probing and rejects an unreachable config', async () => {
  const calls: string[] = []
  const { app, store } = await makeSettingsApp(async (provider) => {
    calls.push(provider.apiKey)
    return {
      ok: false,
      capabilities: {
        streaming: false,
        functionCalling: false,
        degraded: true,
        testedAt: '2026-09-12T00:00:00.000Z',
        error: '无法连接模型服务，请检查配置后重试。',
      },
      error: '无法连接模型服务，请检查配置后重试。',
    }
  })
  const response = await app.request('/api/settings/ai-providers', jsonRequest('POST', providerInput))
  assert.equal(response.status, 502)
  assert.deepEqual(calls, [providerInput.apiKey])
  assert.equal(store.rows.size, 0)
  const body = await response.json() as Record<string, unknown>
  assert.equal(JSON.stringify(body).includes(providerInput.apiKey), false)
})

test('SQLite provider settings survive app recreation without exposing the stored key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hailar-provider-'))
  const databaseUrl = join(directory, 'providers.db')
  try {
    const firstApp = await createApp({ databaseUrl, aiProviderProbe: successfulProbe(), seedBuiltinTrip: false })
    const created = await firstApp.request('/api/settings/ai-providers', jsonRequest('POST', providerInput))
    assert.equal(created.status, 201)
    const secondApp = await createApp({ databaseUrl, aiProviderProbe: successfulProbe(), seedBuiltinTrip: false })
    const list = await secondApp.request('/api/settings/ai-providers')
    assert.equal(list.status, 200)
    const body = await list.text()
    assert.match(body, /内部网关/)
    assert.equal(body.includes(providerInput.apiKey), false)
    assert.equal(body.includes('header-secret'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('chat-completions and responses providers drive the real chat SSE route', async () => {
  for (const protocol of ['chat-completions', 'responses'] as const) {
    const store = new MemoryAiProviderStoreDriver()
    const messages = new MemoryMessageStoreDriver()
    const app = await createApp({
      tripRepository: new TripRepository(new MemoryTripStoreDriver()),
      aiProviderStore: store,
      messageStore: messages,
      plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
      aiProviderProbe: successfulProbe(),
    })
    const created = await app.request('/api/settings/ai-providers', jsonRequest('POST', {
      ...providerInput,
      name: protocol,
      protocol,
    }))
    assert.equal(created.status, 201)
    const tripResponse = await app.request('/api/trips', jsonRequest('POST', {
      title: '测试行程',
      startDate: '2026-10-02',
      endDate: '2026-10-03',
    }))
    const trip = (await tripResponse.json() as { trip: { id: string } }).trip
    const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = []
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({
        url,
        body,
        authorization: new Headers(init?.headers).get('authorization'),
      })
      if (protocol === 'chat-completions') {
        const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
        return new Response(`${chunk({ role: 'assistant', content: '' }, null)}${chunk({ content: '来自 Chat Completions。' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response('event: response.output_text.delta\ndata: {"delta":"来自 Responses。"}\n\nevent: response.completed\ndata: {"response":{"output":[]}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch

    const chat = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '你好' }))
    assert.equal(chat.status, 200)
    const text = await chat.text()
    assert.match(text, /event: done/)
    assert.equal(calls[0]?.url, `https://model.example.test/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`)
    assert.equal(calls[0]?.authorization, `Bearer ${providerInput.apiKey}`)
    if (protocol === 'chat-completions') {
      assert.ok(Array.isArray(calls[0]?.body.messages))
      assert.equal('input' in (calls[0]?.body ?? {}), false)
    } else {
      assert.ok(Array.isArray(calls[0]?.body.input))
      assert.equal('messages' in (calls[0]?.body ?? {}), false)
    }
  }
})

test('provider model honors a non-streaming capability and preserves JSON text', async () => {
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    aiProviderStore: new MemoryAiProviderStoreDriver(),
    messageStore: new MemoryMessageStoreDriver(),
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    aiProviderProbe: async () => ({
      ok: true,
      capabilities: {
        streaming: false,
        functionCalling: true,
        degraded: false,
        testedAt: '2026-09-12T00:00:00.000Z',
        error: null,
      },
    }),
  })
  const created = await app.request('/api/settings/ai-providers', jsonRequest('POST', providerInput))
  assert.equal(created.status, 201)
  const tripResponse = await app.request('/api/trips', jsonRequest('POST', {
    title: '非流式回复',
    startDate: '2026-10-02',
    endDate: '2026-10-03',
  }))
  const trip = (await tripResponse.json() as { trip: { id: string } }).trip
  let requestBody: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '来自普通 JSON 响应。' }, finish_reason: 'stop' }],
    }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const response = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '你好' }))
  const raw = await response.text()
  assert.equal(response.status, 200)
  const observedBody = requestBody as Record<string, unknown> | null
  assert.ok(observedBody)
  assert.equal(observedBody.stream, false)
  assert.match(raw, /来自普通 JSON 响应/)
  assert.match(raw, /event: done/)
})

test('provider model streams the first SSE delta before the upstream response closes', async () => {
  const provider = {
    id: 'streaming-test',
    name: 'streaming-test',
    baseUrl: 'https://model.example.test/v1',
    apiKey: 'sk-streaming-secret',
    modelId: 'planner-1',
    headers: {},
    protocol: 'chat-completions' as const,
    isDefault: true,
    capabilities: null,
    lastTestedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  }
  let release!: () => void
  const upstreamOpen = new Promise<void>((resolve) => { release = resolve })
  let requestBody: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const encoder = new TextEncoder()
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"先到"},"finish_reason":null}]}\n\n'))
        void upstreamOpen.then(() => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"后到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        })
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch

  const model = createProviderModel(provider, {
    streaming: true,
    functionCalling: true,
    degraded: false,
    testedAt: null,
  }) as unknown as ProviderModel
  const result = await model.doStream({ prompt: [{ role: 'user', content: '你好' }] })
  const reader = result.stream.getReader()
  assert.equal((await reader.read()).value?.type, 'stream-start')
  const firstDelta = await Promise.race([
    (async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) return null
        if (next.value.type === 'text-delta') return next.value
      }
    })(),
    new Promise<null>((_, reject) => setTimeout(() => reject(new Error('first SSE delta was buffered')), 500)),
  ])
  assert.equal(firstDelta?.delta, '先到')
  const observedBody = requestBody as Record<string, unknown> | null
  assert.ok(observedBody)
  assert.equal(observedBody.stream, true)
  release()
  const remaining = await (async () => {
    const parts: Record<string, unknown>[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) return parts
      parts.push(next.value)
    }
  })()
  assert.ok(remaining.some((part) => part.type === 'text-delta' && part.delta === '后到'))
})

test('Responses tool-call events with item and call ids produce one complete call', async () => {
  globalThis.fetch = (async () => new Response([
    'event: response.output_item.added',
    'data: {"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"emit_round_meta","arguments":""}}',
    '',
    'event: response.function_call_arguments.delta',
    'data: {"item_id":"fc_1","delta":"{\\"round\\":\\"plan\\"}"}',
    '',
    'event: response.completed',
    'data: {"response":{"output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"emit_round_meta","arguments":"{\\"round\\":\\"plan\\"}"}]}}',
    '',
  ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
  const provider = {
    id: 'responses-test',
    name: 'responses-test',
    baseUrl: 'https://model.example.test/v1',
    apiKey: 'sk-responses-secret',
    modelId: 'planner-1',
    headers: {},
    protocol: 'responses' as const,
    isDefault: true,
    capabilities: null,
    lastTestedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  }
  const model = createProviderModel(provider, {
    streaming: true,
    functionCalling: true,
    degraded: false,
    testedAt: null,
  }) as unknown as ProviderModel
  const parts = await readProviderParts(model, [{ role: 'user', content: '请调用工具' }])
  const calls = parts.filter((part) => part.type === 'tool-call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.toolCallId, 'call_1')
  assert.equal(calls[0]?.input, '{"round":"plan"}')
})

test('Chat Completions prompt keeps every parallel tool result', async () => {
  let requestBody: Record<string, unknown> | null = null
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({ choices: [{ message: { content: '收到' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const provider = {
    id: 'tool-context-test',
    name: 'tool-context-test',
    baseUrl: 'https://model.example.test/v1',
    apiKey: 'sk-context-secret',
    modelId: 'planner-1',
    headers: {},
    protocol: 'chat-completions' as const,
    isDefault: true,
    capabilities: null,
    lastTestedAt: null,
    lastError: null,
    createdAt: '',
    updatedAt: '',
  }
  const model = createProviderModel(provider, {
    streaming: false,
    functionCalling: true,
    degraded: false,
    testedAt: null,
  }) as unknown as ProviderModel
  await readProviderParts(model, [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call-a', toolName: 'first', input: {} },
        { type: 'tool-call', toolCallId: 'call-b', toolName: 'second', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call-a', toolName: 'first', output: { type: 'json', value: { first: true } } },
        { type: 'tool-result', toolCallId: 'call-b', toolName: 'second', output: { type: 'json', value: { second: true } } },
      ],
    },
  ])
  const observedBody = requestBody as Record<string, unknown> | null
  assert.ok(observedBody)
  const messages = observedBody.messages as { role: string; tool_call_id?: string }[] | undefined
  assert.deepEqual(messages?.map((message) => message.role), ['assistant', 'tool', 'tool'])
  assert.deepEqual(messages?.slice(1).map((message) => message.tool_call_id), ['call-a', 'call-b'])
})

test('degraded fallback history uses ordinary text for strict Chat and Responses providers', async () => {
  for (const protocol of ['chat-completions', 'responses'] as const) {
    const calls: Record<string, unknown>[] = []
    const app = await createApp({
      tripRepository: new TripRepository(new MemoryTripStoreDriver()),
      aiProviderStore: new MemoryAiProviderStoreDriver(),
      messageStore: new MemoryMessageStoreDriver(),
      plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
      aiProviderProbe: async () => ({
        ok: true,
        capabilities: {
          streaming: false,
          functionCalling: false,
          degraded: true,
          testedAt: '2026-09-12T00:00:00.000Z',
          error: '该模型不支持 function calling，已降级为约定 JSON 文本解析。',
        },
      }),
    })
    const created = await app.request('/api/settings/ai-providers', jsonRequest('POST', { ...providerInput, protocol }))
    assert.equal(created.status, 201)
    const tripResponse = await app.request('/api/trips', jsonRequest('POST', { title: `严格 ${protocol}`, startDate: '2026-10-02', endDate: '2026-10-03' }))
    const trip = (await tripResponse.json() as { trip: { id: string } }).trip
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push(body)
      const nativeToolFields = protocol === 'chat-completions'
        ? (Array.isArray(body.messages) && body.messages.some((message) => {
            const record = message as { role?: unknown; tool_calls?: unknown }
            return record.role === 'tool' || record.tool_calls !== undefined
          }))
        : (Array.isArray(body.input) && body.input.some((item) => {
            const record = item as { type?: unknown }
            return record.type === 'function_call' || record.type === 'function_call_output'
          }))
      if (calls.length > 1 && nativeToolFields) {
        return new Response(JSON.stringify({ error: { message: 'native tool fields rejected' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      const content = calls.length === 1
        ? JSON.stringify({ tool: 'emit_round_meta', arguments: { round: 'qa' } })
        : '降级后的普通回答'
      return protocol === 'chat-completions'
        ? new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ output_text: content, output: [] }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const response = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '继续回答' }))
    const raw = await response.text()
    assert.equal(response.status, 200)
    assert.equal(calls.length, 2)
    assert.match(raw, /降级后的普通回答/)
    assert.match(raw, /event: done/)
    assert.equal(raw.includes('native tool fields rejected'), false)
  }
})

test('upstream SSE error and Responses failure events become sanitized stream errors', async () => {
  for (const protocol of ['chat-completions', 'responses'] as const) {
    const app = await createApp({
      tripRepository: new TripRepository(new MemoryTripStoreDriver()),
      aiProviderStore: new MemoryAiProviderStoreDriver(),
      messageStore: new MemoryMessageStoreDriver(),
      plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
      aiProviderProbe: successfulProbe(),
    })
    const secret = `upstream-${protocol}-secret`
    const created = await app.request('/api/settings/ai-providers', jsonRequest('POST', { ...providerInput, protocol, apiKey: secret }))
    assert.equal(created.status, 201)
    const tripResponse = await app.request('/api/trips', jsonRequest('POST', { title: `错误 ${protocol}`, startDate: '2026-10-02', endDate: '2026-10-03' }))
    const trip = (await tripResponse.json() as { trip: { id: string } }).trip
    globalThis.fetch = (async () => protocol === 'chat-completions'
      ? new Response('data: {"choices":[{"delta":{"content":"部分"},"finish_reason":null}]}\n\ndata: {"error":{"message":"' + secret + '","code":"upstream_error"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : new Response('event: response.failed\ndata: {"response":{"status":"failed","error":{"message":"' + secret + '","code":"server_error"}}}\n\n', { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch
    const response = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '触发错误' }))
    const raw = await response.text()
    assert.equal(response.status, 200)
    assert.match(raw, /event: error/)
    assert.match(raw, /event: close/)
    assert.equal(raw.includes('event: done'), false)
    assert.equal(raw.includes(secret), false)
    const history = await app.request(`/api/trips/${trip.id}/messages`)
    assert.deepEqual((await history.json() as { messages: unknown[] }).messages, [])
  }
})

test('switching the default provider changes the next model request and keeps trip context', async () => {
  const store = new MemoryAiProviderStoreDriver()
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    aiProviderStore: store,
    messageStore: new MemoryMessageStoreDriver(),
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    aiProviderProbe: successfulProbe(),
  })
  const first = await app.request('/api/settings/ai-providers', jsonRequest('POST', providerInput))
  await first.json()
  const second = await app.request('/api/settings/ai-providers', jsonRequest('POST', { ...providerInput, name: '备用', apiKey: 'sk-second-secret', isDefault: false }))
  assert.equal(second.status, 201)
  const secondId = ((await second.clone().json()) as { provider: { id: string } }).provider.id
  const tripResponse = await app.request('/api/trips', jsonRequest('POST', { title: '上下文', startDate: '2026-10-02', endDate: '2026-10-03' }))
  const trip = (await tripResponse.json() as { trip: { id: string } }).trip
  const calls: { authorization: string | null; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    calls.push({ authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response('data: {"choices":[{"delta":{"content":"答复"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  }) as typeof fetch
  const firstChat = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '第一问' }))
  assert.equal(firstChat.status, 200)
  await firstChat.text()
  await app.request(`/api/settings/ai-providers/${secondId}/default`, jsonRequest('POST'))
  const secondChat = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '第二问' }))
  assert.equal(secondChat.status, 200)
  await secondChat.text()
  assert.equal(calls[0]?.authorization, `Bearer ${providerInput.apiKey}`)
  assert.equal(calls[1]?.authorization, 'Bearer sk-second-secret')
  const secondMessages = JSON.stringify(calls[1]?.body.messages)
  assert.match(secondMessages, /第一问/)
  assert.match(secondMessages, /答复/)
})

test('probe marks successful connectivity with normal text as function-calling degraded', async () => {
  let request = 0
  globalThis.fetch = (async () => {
    request += 1
    return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const result = await probeAiProvider({
    baseUrl: 'https://model.example.test/v1',
    apiKey: 'sk-probe-secret',
    modelId: 'planner-1',
    headers: {},
    protocol: 'chat-completions',
  })
  assert.equal(request, 2)
  assert.equal(result.ok, true)
  assert.equal(result.capabilities.functionCalling, false)
  assert.equal(result.capabilities.degraded, true)
  assert.match(result.capabilities.error ?? '', /JSON/)
})

test('degraded provider still carries metadata and TripPatch tool calls through JSON text fallback', async () => {
  const store = new MemoryAiProviderStoreDriver()
  const patchStore = new MemoryTripPatchStore()
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    aiProviderStore: store,
    tripPatchStore: patchStore,
    messageStore: new MemoryMessageStoreDriver(),
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    aiProviderProbe: async () => ({
      ok: true,
      capabilities: { streaming: true, functionCalling: false, degraded: true, testedAt: '2026-09-12T00:00:00.000Z', error: '该模型不支持 function calling，已降级为约定 JSON 文本解析。' },
    }),
  })
  const provider = await app.request('/api/settings/ai-providers', jsonRequest('POST', providerInput))
  assert.equal(provider.status, 201)
  const tripResponse = await app.request('/api/trips', jsonRequest('POST', { title: '降级回合', startDate: '2026-10-02', endDate: '2026-10-03' }))
  const trip = (await tripResponse.json() as { trip: { id: string } }).trip
  let calls = 0
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    calls += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: unknown[] }
    const serialized = JSON.stringify(body.messages)
    if (calls === 1) return fallbackResponse({ tool: 'emit_round_meta', arguments: { round: 'plan' } })
    if (calls === 2) return fallbackResponse({ tool: 'apply_trip_patch', arguments: { ops: [{ op: 'add_day', dayId: 'day-fallback', date: '2026-10-02', theme: '降级计划' }] } })
    assert.match(serialized, /apply_trip_patch/)
    return fallbackResponse('已完成降级计划。')
  }) as typeof fetch

  const response = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '请生成计划' }))
  assert.equal(response.status, 200)
  const raw = await response.text()
  assert.match(raw, /event: meta/)
  assert.match(raw, /event: applied_patch/)
  assert.match(raw, /event: done/)
  assert.equal(calls, 3)
  assert.equal((await patchStore.listDayRows(trip.id)).length, 1)
})

test('Mastra mounted agent metadata and provider failures never reflect API or header secrets', async () => {
  const { app } = await makeSettingsApp()
  const saved = await app.request('/api/settings/ai-providers', jsonRequest('POST', providerInput))
  assert.equal(saved.status, 201)
  const agent = await app.request('/api/agents/planner')
  const agentText = await agent.text()
  assert.equal(agentText.includes(providerInput.apiKey), false)
  assert.equal(agentText.includes('header-secret'), false)

  const tripResponse = await app.request('/api/trips', jsonRequest('POST', { title: '错误反射', startDate: '2026-10-02', endDate: '2026-10-03' }))
  const trip = (await tripResponse.json() as { trip: { id: string } }).trip
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: `upstream ${providerInput.apiKey} header-secret` } }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  const chat = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '你好' }))
  const chatText = await chat.text()
  assert.equal(chatText.includes(providerInput.apiKey), false)
  assert.equal(chatText.includes('header-secret'), false)

  globalThis.fetch = (async () => {
    throw new Error(`transport reflected ${providerInput.apiKey} header-secret`)
  }) as typeof fetch
  const thrown = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest('POST', { content: '再次请求' }))
  const thrownText = await thrown.text()
  assert.equal(thrownText.includes(providerInput.apiKey), false)
  assert.equal(thrownText.includes('header-secret'), false)
})

function fallbackResponse(value: unknown): Response {
  const content = typeof value === 'string' ? value : JSON.stringify(value)
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
}
