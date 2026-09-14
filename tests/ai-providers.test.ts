/**
 * AI provider domain codec tests (ticket 01 thinking-effort) — the
 * normalizeAiProvider thinking-budget normalization against an injected
 * FetchLike stub, mirroring the trip-list.test.ts convention.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchAiProviders, type FetchLike } from '../src/domain/aiProviders'

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
