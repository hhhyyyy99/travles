/** Reasoning round trips through the real provider adapter and Hono/Mastra seam. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProviderModel } from '../src/ai-providers/model.js'
import type { AiProvider, ProviderCapabilities } from '../src/ai-providers/types.js'
import { createApp } from '../src/app.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'
import { MemoryAiProviderStoreDriver } from '../src/ai-providers/driver-memory.js'
import { MemoryMessageStoreDriver } from '../src/chat/driver-memory.js'
import { MockMemory } from '@mastra/core/memory'
import { InMemoryStore } from '@mastra/core/storage'

type Part = { type: string; text?: string; delta?: string; id?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; providerMetadata?: Record<string, Record<string, unknown>>; providerOptions?: Record<string, Record<string, unknown>> }
type Prompt = Array<{ role: string; content: string | Part[] }>
type Model = {
  doStream(options: { prompt: Prompt }): Promise<{ stream: ReadableStream<Part> }>
  doGenerate(options: { prompt: Prompt }): Promise<{ content: Part[] }>
}
type ChatMessage = {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string }; extra_content?: { google: { thought_signature: string } } }>
  tool_call_id?: string
}
type WireRequest = { model: string; stream: boolean; messages: ChatMessage[]; tools?: unknown[] }
const REASONING = '私有推理：先检查上下文。\n再执行工具。'
const FINAL_REASONING = '私有推理：工具已返回，可以回答。'
const REPLY = '已保留行程上下文。'
const CALL_ID = 'call_kimi_42'
const TOOL_INPUT = { round: 'qa' }
const API_KEY = 'local-provider-api-secret'
const HEADER_SECRET = 'local-provider-header-secret'

function capabilities(streaming: boolean, functionCalling = true): ProviderCapabilities {
  return { streaming, functionCalling, degraded: !functionCalling, testedAt: null }
}

function provider(baseUrl: string, caps: ProviderCapabilities, modelId = 'kimi-k3.1-pro'): AiProvider {
  return {
    id: 'reasoning-test', name: 'Local reasoning provider', baseUrl, apiKey: API_KEY,
    headers: { 'X-Test-Secret': HEADER_SECRET }, modelId, protocol: 'chat-completions',
    thinking: 'off', isDefault: true, capabilities: caps,
    lastTestedAt: null, lastError: null, createdAt: '', updatedAt: '',
  }
}

/** Strict Kimi-compatible endpoint: a tool result is rejected unless its assistant reasoning survives. */
async function startStrictProvider(options: { streaming: boolean; reasoning?: string; fallback?: boolean; omitReasoning?: boolean }) {
  const requests: WireRequest[] = []
  const rejections: string[] = []
  const reasoning = options.reasoning ?? REASONING
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const reject = (reason: string) => {
        rejections.push(reason)
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `${reason}: ${API_KEY} ${HEADER_SECRET}` } }))
      }
      if (req.url !== '/v1/chat/completions') return reject('unexpected endpoint')
      if (req.headers.authorization !== `Bearer ${API_KEY}` || req.headers['x-test-secret'] !== HEADER_SECRET) return reject('missing credentials')
      let body: WireRequest
      try { body = JSON.parse(raw) as WireRequest } catch { return reject('invalid JSON') }
      requests.push(body)
      if (body.stream !== options.streaming) return reject('incorrect streaming capability')
      const priorTools = body.messages.filter((message) => message.role === 'assistant' && message.tool_calls?.length)
      for (const assistant of priorTools) {
        if (assistant.reasoning_content !== (options.omitReasoning ? undefined : reasoning)) return reject('previous reasoning_content required')
        if (assistant.content?.includes(reasoning) && reasoning !== '') return reject('reasoning copied into content')
        const call = assistant.tool_calls?.[0]
        if (call?.id !== CALL_ID || call.function.name !== 'emit_round_meta' || call.function.arguments !== '{"round":"qa"}') return reject('tool call changed')
        if (!body.messages.some((message) => message.role === 'tool' && message.tool_call_id === CALL_ID)) return reject('tool result id changed')
      }
      for (const assistant of body.messages.filter((message) => message.role === 'assistant' && message.content === REPLY)) {
        if (assistant.reasoning_content !== (options.omitReasoning ? undefined : FINAL_REASONING)) return reject('previous answer reasoning_content required')
      }
      const fallbackCalls = body.messages.filter((message) => message.role === 'assistant' && message.content?.includes('工具调用「emit_round_meta」'))
      if (options.fallback) {
        if (body.tools || body.messages.some((message) => message.role === 'tool' || message.tool_calls)) return reject('native tool fields in ordinary text fallback')
        for (const assistant of fallbackCalls) {
          if (assistant.reasoning_content !== (options.omitReasoning ? undefined : reasoning)) return reject('fallback reasoning_content required')
          if (reasoning !== '' && assistant.content?.includes(reasoning)) return reject('fallback reasoning copied into content')
        }
        if (fallbackCalls.length > 0 && !body.messages.some((message) => message.role === 'user' && message.content?.includes('工具结果「emit_round_meta」'))) return reject('fallback result missing')
      }
      const continued = priorTools.length > 0 || fallbackCalls.length > 0
      const message = continued
        ? { role: 'assistant', content: REPLY, reasoning_content: FINAL_REASONING }
        : options.fallback
          ? { role: 'assistant', content: JSON.stringify({ tool: 'emit_round_meta', arguments: TOOL_INPUT }), reasoning_content: reasoning }
          : { role: 'assistant', content: '', reasoning_content: reasoning, tool_calls: [{ id: CALL_ID, type: 'function', function: { name: 'emit_round_meta', arguments: JSON.stringify(TOOL_INPUT) } }] }
      if (options.omitReasoning) delete (message as Partial<typeof message>).reasoning_content
      if (!options.streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message, finish_reason: continued ? 'stop' : 'tool_calls' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
      if (continued) {
        if (!options.omitReasoning) res.write(chunk({ reasoning_content: FINAL_REASONING }))
        res.write(chunk({ content: REPLY }))
      } else {
        const split = Math.floor(reasoning.length / 2)
        res.write(chunk({ role: 'assistant', ...(!options.omitReasoning ? { reasoning_content: reasoning.slice(0, split) } : {}) }))
        // content and tool_calls can coexist in a single native chunk.
        if (options.fallback) {
          res.write(chunk({ content: message.content, ...(!options.omitReasoning ? { reasoning_content: reasoning.slice(split) } : {}) }))
        } else {
          res.write(chunk({ content: '', ...(!options.omitReasoning ? { reasoning_content: reasoning.slice(split) } : {}), tool_calls: [{ index: 0, id: CALL_ID, type: 'function', function: { name: 'emit_round_meta', arguments: '{"round":' } }] }))
          res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: '"qa"}' } }] }))
        }
      }
      res.end(`${chunk({}, continued ? 'stop' : 'tool_calls')}data: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`, requests, rejections,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

const THOUGHT_SIGNATURE = 'opaque-google-thought+/base64=='
const SECOND_SIGNATURE = 'different-opaque-signature=='

/** Gemini's OpenAI endpoint validates each parallel call's own opaque signature. */
async function startSignedProvider(streaming: boolean, signSecondCall = false) {
  const requests: WireRequest[] = []
  const rejections: string[] = []
  const calls = [
    { id: 'signed-call-1', type: 'function', function: { name: 'emit_round_meta', arguments: '{"round":"qa"}' }, extra_content: { google: { thought_signature: THOUGHT_SIGNATURE } } },
    { id: 'signed-call-2', type: 'function', function: { name: 'emit_round_meta', arguments: '{"round":"qa"}' }, ...(signSecondCall ? { extra_content: { google: { thought_signature: SECOND_SIGNATURE } } } : {}) },
  ]
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw) as WireRequest
      requests.push(body)
      const priorCalls = body.messages.flatMap((message) => message.tool_calls ?? [])
      if (priorCalls.length > 0) {
        const problem = calls.some((expected) => {
          const actual = priorCalls.find((call) => call.id === expected.id)
          return !isDeepStrictEqual(actual, expected) || !body.messages.some((message) => message.tool_call_id === expected.id)
        })
        if (problem || priorCalls.length !== 2) {
          rejections.push('missing or misplaced thought_signature')
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `missing thought_signature ${API_KEY} ${HEADER_SECRET}` } }))
          return
        }
      }
      const continued = priorCalls.length > 0
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: continued ? { role: 'assistant', content: REPLY } : { role: 'assistant', content: '', tool_calls: calls }, finish_reason: continued ? 'stop' : 'tool_calls' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
      if (continued) res.write(chunk({ content: REPLY }))
      else {
        // Signatures may arrive separately from the function's argument fragments.
        res.write(chunk({ tool_calls: calls.map((call, index) => ({ index, id: call.id, type: call.type, function: { name: call.function.name, arguments: '{"round":' } })) }))
        res.write(chunk({ tool_calls: calls.map((call, index) => ({ index, ...(call.extra_content ? { extra_content: call.extra_content } : {}), function: { arguments: '"qa"}' } })) }))
      }
      res.end(`${chunk({}, continued ? 'stop' : 'tool_calls')}data: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`, requests, rejections,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

/** An ordinary provider rejects vendor fields retained in a trip's previous model history. */
async function startOrdinaryProvider(protocol: AiProvider['protocol'] = 'chat-completions') {
  const requests: Array<Partial<WireRequest> & { input?: unknown[] }> = []
  const rejections: string[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw) as Partial<WireRequest> & { input?: unknown[] }
      requests.push(body)
      const leaked = body.messages?.some((message) => 'reasoning_content' in message || message.tool_calls?.some((call) => 'extra_content' in call))
        || ['私有推理', THOUGHT_SIGNATURE, SECOND_SIGNATURE].some((value) => raw.includes(value))
      if (leaked) {
        rejections.push('unsupported vendor history')
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `unsupported fields ${API_KEY} ${HEADER_SECRET}` } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(protocol === 'responses'
        ? { output_text: '普通模型继续回答。', output: [] }
        : { choices: [{ message: { role: 'assistant', content: '普通模型继续回答。' }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`, requests, rejections,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

async function streamParts(model: Model, prompt: Prompt): Promise<Part[]> {
  const { stream } = await model.doStream({ prompt })
  const reader = stream.getReader()
  const parts: Part[] = []
  for (;;) {
    const next = await reader.read()
    if (next.done) return parts
    parts.push(next.value)
  }
}

function continuation(content: Part[]): Prompt {
  return [
    { role: 'user', content: '请检查上下文' },
    { role: 'assistant', content: content.map(({ providerMetadata, ...part }) => ({ ...part, ...(providerMetadata ? { providerOptions: providerMetadata } : {}) })) },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: CALL_ID, toolName: 'emit_round_meta', output: { type: 'json', value: { ok: true } } }] },
  ]
}

test('native reasoning streams round-trip separately from text with original tool IDs and arguments', async () => {
  const fake = await startStrictProvider({ streaming: true })
  try {
    const caps = capabilities(true)
    const model = createProviderModel(provider(fake.url, caps), caps) as unknown as Model
    const parts = await streamParts(model, [{ role: 'user', content: '请检查上下文' }])
    const reasoning = parts.filter((part) => part.type === 'reasoning-delta').map((part) => part.delta).join('')
    assert.equal(reasoning, REASONING)
    assert.deepEqual(parts.filter((part) => part.type.startsWith('reasoning-')).map((part) => part.type), ['reasoning-start', 'reasoning-delta', 'reasoning-delta', 'reasoning-end'])
    assert.equal(parts.some((part) => part.type === 'text-delta'), false)
    const calls = parts.filter((part) => part.type === 'tool-call')
    assert.deepEqual(calls, [{ type: 'tool-call', toolCallId: CALL_ID, toolName: 'emit_round_meta', input: '{"round":"qa"}' }])
    const next = await streamParts(model, continuation([
      { type: 'reasoning', text: reasoning },
      ...calls.map((call) => ({ ...call, input: JSON.parse(String(call.input)) as unknown })),
    ]))
    assert.equal(next.filter((part) => part.type === 'text-delta').map((part) => part.delta).join(''), REPLY)
    assert.equal(fake.requests[1]?.messages[1]?.reasoning_content, REASONING)
    assert.equal(fake.requests[1]?.messages[1]?.content, '')
    assert.deepEqual(fake.rejections, [])
  } finally { await fake.close() }
})

async function makeChatApp(baseUrl: string, caps: ProviderCapabilities, modelId = 'kimi-k3.1-pro') {
  const app = await createApp({
    tripRepository: new TripRepository(new MemoryTripStoreDriver()),
    aiProviderStore: new MemoryAiProviderStoreDriver(),
    messageStore: new MemoryMessageStoreDriver(),
    plannerMemory: new MockMemory({ storage: new InMemoryStore(), enableMessageHistory: true }),
    aiProviderProbe: async () => ({ ok: true, capabilities: caps }),
  })
  const saved = await app.request('/api/settings/ai-providers', jsonRequest(provider(baseUrl, caps, modelId)))
  assert.equal(saved.status, 201)
  const created = await app.request('/api/trips', jsonRequest({ title: '推理往返', startDate: '2026-10-02', endDate: '2026-10-03' }))
  assert.equal(created.status, 201)
  const trip = (await created.json() as { trip: { id: string } }).trip
  const providerId = (await saved.json() as { provider: { id: string } }).provider.id
  return { app, trip, providerId }
}

function jsonRequest(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

test('real Hono/Mastra tool continuation and next-turn memory preserve native SSE and JSON reasoning privately', async () => {
  for (const streaming of [true, false]) {
    const fake = await startStrictProvider({ streaming })
    try {
      const { app, trip } = await makeChatApp(fake.url, capabilities(streaming))
      const chat = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '请检查上下文' }))
      assert.equal(chat.status, 200)
      const raw = await chat.text()
      assert.match(raw, /event: done/)
      assert.match(raw, /event: meta/)
      assert.match(raw, /已保留行程上下文/)
      assert.equal(raw.includes('event: error'), false)
      assert.equal(fake.requests.length, 2, 'the real metadata tool executes before the final answer')
      assert.equal(fake.requests[1]?.messages.find((message) => message.tool_calls?.length)?.reasoning_content, REASONING)
      const followup = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '继续回答' }))
      const nextRaw = await followup.text()
      assert.match(nextRaw, /event: done/)
      assert.equal(fake.requests.length, 3)
      assert.ok(fake.requests[2]?.messages.some((message) => message.role === 'assistant' && message.content === REPLY && message.reasoning_content === FINAL_REASONING), 'memory replays the final answer with its own reasoning')
      const history = await app.request(`/api/trips/${trip.id}/messages`)
      const historyText = await history.text()
      const visible = raw + nextRaw + historyText
      for (const hidden of [REASONING, FINAL_REASONING, API_KEY, HEADER_SECRET]) assert.equal(visible.includes(hidden), false)
      assert.equal(visible.includes('reasoning_content'), false)
      const messages = JSON.parse(historyText) as { messages: Array<{ role: string; content: string }> }
      assert.deepEqual(messages.messages.filter((message) => message.role === 'assistant').map((message) => message.content), [REPLY, REPLY])
      assert.deepEqual(fake.rejections, [])
    } finally { await fake.close() }
  }
})

test('ordinary text fallback keeps assistant reasoning separate during the real tool continuation', async () => {
  for (const streaming of [true, false]) {
    const fake = await startStrictProvider({ streaming, fallback: true })
    try {
      const { app, trip } = await makeChatApp(fake.url, capabilities(streaming, false))
      const response = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '请检查上下文' }))
      const raw = await response.text()
      assert.match(raw, /event: done/)
      assert.match(raw, /已保留行程上下文/)
      assert.equal(fake.requests.length, 2)
      const assistant = fake.requests[1]?.messages.find((message) => message.role === 'assistant')
      assert.equal(assistant?.reasoning_content, REASONING)
      assert.equal(assistant?.content, '工具调用「emit_round_meta」：{"round":"qa"}')
      assert.equal(raw.includes('私有推理'), false)
      assert.deepEqual(fake.rejections, [])
    } finally { await fake.close() }
  }
})

test('explicit empty upstream reasoning survives Kimi tool replay without inventing content', async () => {
  for (const streaming of [true, false]) {
    const fake = await startStrictProvider({ streaming, reasoning: '' })
    try {
      const { app, trip } = await makeChatApp(fake.url, capabilities(streaming))
      const response = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '请检查上下文' }))
      assert.match(await response.text(), /event: done/)
      assert.equal(fake.requests[1]?.messages.find((message) => message.tool_calls?.length)?.reasoning_content, '')
      assert.deepEqual(fake.rejections, [])
    } finally { await fake.close() }
  }
})

test('ordinary models and messages without reasoning never receive a synthetic reasoning_content field', async () => {
  for (const streaming of [true, false]) {
    const fake = await startStrictProvider({ streaming, omitReasoning: true })
    try {
      const caps = capabilities(streaming)
      const model = createProviderModel(provider(fake.url, caps, 'ordinary-model'), caps) as unknown as Model
      const first = await model.doGenerate({ prompt: [{ role: 'assistant', content: [{ type: 'text', text: '普通历史' }] }, { role: 'user', content: '你好' }] })
      assert.equal(first.content.some((part) => part.type === 'reasoning'), false)
      await model.doGenerate({ prompt: continuation(first.content) })
      for (const request of fake.requests) {
        for (const message of request.messages) assert.equal('reasoning_content' in message, false)
        for (const message of request.messages) {
          for (const call of message.tool_calls ?? []) assert.equal('extra_content' in call, false)
        }
      }
      assert.deepEqual(fake.rejections, [])
    } finally { await fake.close() }
  }
})

test('Gemini parallel tool signatures survive the real Hono/Mastra stream, JSON and memory continuation', async () => {
  for (const streaming of [true, false]) {
    for (const signSecond of [false, true]) {
      const fake = await startSignedProvider(streaming, signSecond)
      try {
        const { app, trip } = await makeChatApp(fake.url, capabilities(streaming), 'gemini-3.8-flash')
        const response = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '请检查上下文' }))
        const raw = await response.text()
        assert.match(raw, /event: done/)
        assert.match(raw, /已保留行程上下文/)
        assert.equal(fake.requests.length, 2)
        const calls = fake.requests[1]?.messages.flatMap((message) => message.tool_calls ?? [])
        assert.equal(calls?.[0]?.extra_content?.google.thought_signature, THOUGHT_SIGNATURE)
        assert.equal(calls?.[1]?.extra_content?.google.thought_signature, signSecond ? SECOND_SIGNATURE : undefined)
        const followup = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '继续回答' }))
        const nextRaw = await followup.text()
        assert.match(nextRaw, /event: done/)
        assert.equal(fake.requests.length, 3)
        const history = await app.request(`/api/trips/${trip.id}/messages`)
        const visible = raw + nextRaw + await history.text()
        for (const hidden of [THOUGHT_SIGNATURE, SECOND_SIGNATURE, API_KEY, HEADER_SECRET, 'thought_signature', 'providerMetadata']) assert.equal(visible.includes(hidden), false)
        assert.deepEqual(fake.rejections, [])
      } finally { await fake.close() }
    }
  }
})

function assertProvenance(metadata: Part['providerMetadata'], modelId: string, baseUrl: string): void {
  assert.equal(metadata?.hailar?.providerId, 'reasoning-test')
  assert.equal(metadata?.hailar?.modelId, modelId)
  assert.match(String(metadata?.hailar?.endpointFingerprint), /^[a-f0-9]{64}$/)
  assert.deepEqual(Object.keys(metadata?.hailar ?? {}).sort(), ['endpointFingerprint', 'modelId', 'providerId'])
  for (const secret of [baseUrl, API_KEY, HEADER_SECRET]) assert.equal(JSON.stringify(metadata).includes(secret), false)
}

test('Gemini doGenerate exposes per-call signatures through standard metadata for prompt replay', async () => {
  for (const streaming of [true, false]) {
    const fake = await startSignedProvider(streaming)
    try {
      const caps = capabilities(streaming)
      const model = createProviderModel(provider(fake.url, caps, 'gemini-3.8-flash'), caps) as unknown as Model
      const first = await model.doGenerate({ prompt: [{ role: 'user', content: '请检查上下文' }] })
      assertProvenance(first.content[0]?.providerMetadata, 'gemini-3.8-flash', fake.url)
      assert.deepEqual(first.content[0]?.providerMetadata?.google, { thoughtSignature: THOUGHT_SIGNATURE })
      assert.equal(first.content[1]?.providerMetadata, undefined)
      const next = await model.doGenerate({ prompt: [
        { role: 'assistant', content: first.content.map(({ providerMetadata, ...part }) => ({ ...part, ...(providerMetadata ? { providerOptions: providerMetadata } : {}) })) },
        { role: 'tool', content: first.content.map((part) => ({ type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output: { type: 'json', value: { ok: true } } })) },
      ] })
      assert.deepEqual(next.content, [{ type: 'text', text: REPLY }])
      assert.deepEqual(fake.rejections, [])
    } finally { await fake.close() }
  }
})

test('provider/model switching retains visible history without private fields in ordinary Chat or Responses', async () => {
  for (const source of ['kimi', 'gemini'] as const) {
    for (const change of ['provider', 'model', 'endpoint'] as const) {
      for (const protocol of ['chat-completions', 'responses'] as const) {
        const original = source === 'kimi' ? await startStrictProvider({ streaming: true }) : await startSignedProvider(true)
        const ordinary = await startOrdinaryProvider(protocol)
        try {
          const caps = capabilities(true)
          const { app, trip, providerId } = await makeChatApp(original.url, caps, source === 'kimi' ? 'kimi-k3.1-pro' : 'gemini-3.8-flash')
          const first = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '请检查上下文' }))
          assert.match(await first.text(), /event: done/)
          const newModelId = change === 'endpoint' ? (source === 'kimi' ? 'kimi-k3.1-pro' : 'gemini-3.8-flash') : 'ordinary-model'
          const newProvider = { ...provider(ordinary.url, caps, newModelId), protocol }
          const switched = change === 'provider'
            ? await app.request('/api/settings/ai-providers', jsonRequest(newProvider))
            : await app.request(`/api/settings/ai-providers/${providerId}`, { ...jsonRequest(newProvider), method: 'PATCH' })
          assert.equal(switched.status, change === 'provider' ? 201 : 200)
          const next = await app.request(`/api/trips/${trip.id}/messages`, jsonRequest({ content: '切换后继续' }))
          const raw = await next.text()
          assert.match(raw, /event: done/, `${source}/${change}/${protocol}`)
          assert.match(raw, /普通模型继续回答/)
          assert.equal(ordinary.requests.length, 1)
          const history = protocol === 'responses' ? ordinary.requests[0]?.input : ordinary.requests[0]?.messages
          assert.ok(JSON.stringify(history).includes(REPLY), 'the same memory thread retains its visible answer')
          assert.deepEqual(ordinary.rejections, [])
          for (const hidden of [REASONING, FINAL_REASONING, THOUGHT_SIGNATURE, SECOND_SIGNATURE, API_KEY, HEADER_SECRET]) assert.equal(raw.includes(hidden), false)
        } finally {
          await original.close()
          await ordinary.close()
        }
      }
    }
  }
})

test('strict missing-reasoning and missing-signature rejections expose only sanitized adapter errors', async () => {
  const kimi = await startStrictProvider({ streaming: false })
  const gemini = await startSignedProvider(false)
  try {
    const caps = capabilities(false)
    const kimiModel = createProviderModel(provider(kimi.url, caps), caps) as unknown as Model
    const signedModel = createProviderModel(provider(gemini.url, caps, 'gemini-3.8-flash'), caps) as unknown as Model
    const invalidPrompts: Array<[Model, Prompt]> = [
      [kimiModel, continuation([{ type: 'tool-call', toolCallId: CALL_ID, toolName: 'emit_round_meta', input: TOOL_INPUT }])],
      [signedModel, [
        { role: 'assistant', content: ['signed-call-1', 'signed-call-2'].map((id) => ({ type: 'tool-call', toolCallId: id, toolName: 'emit_round_meta', input: TOOL_INPUT })) },
        { role: 'tool', content: ['signed-call-1', 'signed-call-2'].map((id) => ({ type: 'tool-result', toolCallId: id, toolName: 'emit_round_meta', output: { type: 'json', value: { ok: true } } })) },
      ]],
    ]
    for (const [model, prompt] of invalidPrompts) {
      await assert.rejects(model.doGenerate({ prompt }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /HTTP 400/)
        for (const hidden of [API_KEY, HEADER_SECRET, 'previous reasoning_content', 'missing thought_signature']) assert.equal(error.message.includes(hidden), false)
        return true
      })
    }
    assert.deepEqual(kimi.rejections, ['previous reasoning_content required'])
    assert.deepEqual(gemini.rejections, ['missing or misplaced thought_signature'])
  } finally {
    await kimi.close()
    await gemini.close()
  }
})

test('JSON completions and doGenerate retain standard reasoning content for Kimi and DeepSeek', async () => {
  for (const streaming of [false, true]) {
    const fake = await startStrictProvider({ streaming })
    try {
      const caps = capabilities(streaming)
      const model = createProviderModel(provider(fake.url, caps, 'deepseek-flash'), caps) as unknown as Model
      const first = await model.doGenerate({ prompt: [{ role: 'user', content: '请检查上下文' }] })
      const metadata = first.content[0]?.providerMetadata
      assertProvenance(metadata, 'deepseek-flash', fake.url)
      assert.deepEqual(first.content, [
        { type: 'reasoning', text: REASONING, providerMetadata: metadata },
        { type: 'tool-call', toolCallId: CALL_ID, toolName: 'emit_round_meta', input: { round: 'qa' } },
      ])
      // Equivalent endpoint spellings keep the same private history identity.
      const equivalent = createProviderModel(provider(`${fake.url}///`, caps, 'deepseek-flash'), caps) as unknown as Model
      const second = await equivalent.doGenerate({ prompt: continuation(first.content) })
      assert.deepEqual(second.content, [{ type: 'reasoning', text: FINAL_REASONING, providerMetadata: metadata }, { type: 'text', text: REPLY }])
      assert.equal(fake.requests[1]?.messages[1]?.reasoning_content, REASONING)
      assert.deepEqual(fake.rejections, [])
    } finally { await fake.close() }
  }
})
