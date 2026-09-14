/**
 * AI provider domain codec tests (ticket 01 thinking-effort) — the
 * normalizeAiProvider thinking-budget normalization against an injected
 * FetchLike stub, mirroring the trip-list.test.ts convention.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchAiProviders, fetchProviderModels, fetchSavedProviderModels, type FetchLike, type AiProviderInput } from '../src/domain/aiProviders'

function stubFetch(respond: (url: string, init?: RequestInit) => { status?: number; body: unknown }): FetchLike {
  return async (url, init) => {
    const { status = 200, body } = respond(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function provider(id: string, thinking: unknown): Record<string, unknown> {
  return {
    id,
    name: `配置 ${id}`,
    baseUrl: 'https://model.example.test/v1',
    modelId: 'planner-1',
    protocol: 'chat-completions',
    hasApiKey: true,
    headers: {},
    headerNames: [],
    capabilities: { streaming: true, functionCalling: true, degraded: false, testedAt: null },
    lastTestedAt: null,
    lastError: null,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    ...(thinking !== undefined ? { thinking } : {}),
  }
}

test('normalizeAiProvider defaults missing or invalid thinking to off and keeps valid levels', async () => {
  const fetchLike = stubFetch(() => ({
    body: {
      providers: [
        provider('p-high', 'high'),
        provider('p-medium', 'medium'),
        provider('p-low', 'low'),
        // Server omitted the field entirely (legacy / default).
        provider('p-missing', undefined),
        // An out-of-range value the client must never trust.
        provider('p-invalid', 'ultra'),
        // Non-string garbage the server would have rejected; normalize defensively.
        provider('p-number', 3),
      ],
    },
  }))
  const result = await fetchAiProviders(fetchLike)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const byId = Object.fromEntries(result.data.providers.map((provider) => [provider.id, provider]))
  assert.equal(byId['p-high'].thinking, 'high')
  assert.equal(byId['p-medium'].thinking, 'medium')
  assert.equal(byId['p-low'].thinking, 'low')
  assert.equal(byId['p-missing'].thinking, 'off')
  assert.equal(byId['p-invalid'].thinking, 'off')
  assert.equal(byId['p-number'].thinking, 'off')
})

test('normalizeAiProvider drops corrupt entries instead of throwing', async () => {
  const fetchLike = stubFetch(() => ({
    body: {
      providers: [
        null,
        { title: '没有 id' },
        provider('p-valid', 'high'),
      ],
    },
  }))
  const result = await fetchAiProviders(fetchLike)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(
    result.data.providers.map((provider) => provider.id),
    ['p-valid'],
  )
  assert.equal(result.data.providers[0]?.thinking, 'high')
})

const modelInput: AiProviderInput = {
  name: '网关',
  baseUrl: 'https://model.example.test/v1/',
  modelId: 'planner-1',
  protocol: 'chat-completions',
}

test('fetchProviderModels normalizes string and object model entries and drops invalid ones', async () => {
  const fetchLike = stubFetch(() => ({
    body: {
      models: [
        'gpt-4o',
        { id: '  claude-3 ' },
        { id: 'gemini-1.5' },
        null,
        42,
        '',
        { name: '没有 id' },
        { id: '   ' },
      ],
    },
  }))
  const result = await fetchProviderModels(modelInput, fetchLike)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.data, [
    { id: 'gpt-4o' },
    { id: 'claude-3' },
    { id: 'gemini-1.5' },
  ])
})

test('fetchSavedProviderModels normalizes the GET model-list response', async () => {
  const fetchLike = stubFetch(() => ({
    body: { models: [{ id: 'saved-1' }, { id: 'saved-2' }] },
  }))
  const result = await fetchSavedProviderModels('saved-id', fetchLike)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.data, [{ id: 'saved-1' }, { id: 'saved-2' }])
})

test('fetchProviderModels and fetchSavedProviderModels tolerate empty and malformed model responses', async () => {
  for (const body of [undefined, null, '', { models: [] }, { models: null }, { models: '不是数组' }, {}]) {
    const fetchLike = stubFetch(() => ({ body: body as unknown }))
    const posted = await fetchProviderModels(modelInput, fetchLike)
    assert.equal(posted.ok, true, `空/畸形响应仍应解析成功: ${JSON.stringify(body)}`)
    if (posted.ok) assert.deepEqual(posted.data, [])
    const got = await fetchSavedProviderModels('id', fetchLike)
    assert.equal(got.ok, true, `GET 空/畸形响应仍应解析成功: ${JSON.stringify(body)}`)
    if (got.ok) assert.deepEqual(got.data, [])
  }
  // A non-ok upstream status surfaces as a failure without throwing.
  const failing = stubFetch(() => ({ status: 502, body: { error: '模型列表请求失败（HTTP 502）。' } }))
  const failed = await fetchProviderModels(modelInput, failing)
  assert.equal(failed.ok, false)
})
