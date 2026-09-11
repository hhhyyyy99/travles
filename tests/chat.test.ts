/**
 * AI chat domain tests (ticket 06) — the fetchChatHistory codec and the
 * sendChatMessage SSE reader (injected FetchLike stubs), following the same
 * tolerant-read conventions as tests/workbench-canvas.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHAT_NETWORK_ERROR,
  fetchChatHistory,
  sendChatMessage,
  type ChatStreamError,
  type FetchLike,
} from '../src/domain/chat'

function jsonFetch(body: unknown, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** FetchLike whose POST response streams the given SSE text in chunks. */
function sseFetch(blocks: string[]): FetchLike {
  const raw = blocks.join('')
  const encoder = new TextEncoder()
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // Two uneven chunks exercise the buffered, split-on-\n\n reader.
          const half = Math.ceil(raw.length / 2)
          controller.enqueue(encoder.encode(raw.slice(0, half)))
          controller.enqueue(encoder.encode(raw.slice(half)))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
}

test('fetchChatHistory normalizes persisted messages and drops corrupt rows', async () => {
  const result = await fetchChatHistory(
    'trip-1',
    jsonFetch({
      messages: [
        { id: 'm1', tripId: 'trip-1', role: 'user', content: '你好', createdAt: '2026-09-12T00:00:00.000Z' },
        { id: 'm2', tripId: 'trip-1', role: 'assistant', content: '你好！', createdAt: '2026-09-12T00:00:01.000Z' },
        { content: 'no id' },
        null,
      ],
    }),
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.data.length, 2)
  assert.equal(result.data[0]?.role, 'user')
  assert.equal(result.data[1]?.role, 'assistant')
})

test('fetchChatHistory maps failures to {ok:false, error} and never throws', async () => {
  const network = await fetchChatHistory('trip-1', async () => {
    throw new Error('down')
  })
  assert.deepEqual(network, { ok: false, error: CHAT_NETWORK_ERROR })

  const httpError = await fetchChatHistory('trip-1', jsonFetch({ error: '行程不存在' }, 404))
  assert.deepEqual(httpError, { ok: false, error: '行程不存在' })

  const garbage = await fetchChatHistory('trip-1', jsonFetch({ nope: true }))
  assert.equal(garbage.ok, false)
})

test('sendChatMessage dispatches start/delta events and resolves with the done payload', async () => {
  const rounds: string[] = []
  const deltas: string[] = []
  const errors: ChatStreamError[] = []

  const result = await sendChatMessage(
    'trip-1',
    '十一去海拉尔穿什么？',
    {
      onStart: (round) => rounds.push(round),
      onDelta: (text) => deltas.push(text),
      onError: (error) => errors.push(error),
    },
    sseFetch([
      'event: start\ndata: {"round":"qa"}\n\n',
      'event: delta\ndata: {"text":"海拉尔"}\n\n',
      'event: delta\ndata: {"text":"很冷。"}\n\n',
      'event: done\ndata: {"userMessage":{"id":"u1","tripId":"trip-1","role":"user","content":"十一去海拉尔穿什么？","createdAt":"t1"},"assistantMessage":{"id":"a1","tripId":"trip-1","role":"assistant","content":"海拉尔很冷。","createdAt":"t2"}}\n\n',
    ]),
  )

  assert.deepEqual(rounds, ['qa'])
  assert.deepEqual(deltas, ['海拉尔', '很冷。'])
  assert.deepEqual(errors, [])
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.assistantMessage.content, '海拉尔很冷。')
  assert.equal(result.userMessage.id, 'u1')
})

test('sendChatMessage surfaces in-stream error events through the onError callback', async () => {
  const errors: ChatStreamError[] = []
  const deltas: string[] = []

  const result = await sendChatMessage(
    'trip-1',
    '你好',
    {
      onDelta: (text) => deltas.push(text),
      onError: (error) => errors.push(error),
    },
    sseFetch([
      'event: start\ndata: {"round":"qa"}\n\n',
      'event: error\ndata: {"code":"model_auth","message":"模型服务鉴权失败。","guidance":"请到设置中核对 API Key。"}\n\n',
      'event: close\ndata: {}\n\n',
    ]),
  )

  assert.deepEqual(deltas, [])
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.code, 'model_auth')
  assert.equal(errors[0]?.guidance, '请到设置中核对 API Key。')
  assert.equal(result.ok, false, 'no done payload means no replaceable messages')
})

test('sendChatMessage maps HTTP/transport failures to {ok:false, error}', async () => {
  const httpError = await sendChatMessage('trip-1', '你好', {}, jsonFetch({ error: '模型服务未配置' }, 503))
  assert.deepEqual(httpError, { ok: false, error: '模型服务未配置' })

  const network = await sendChatMessage('trip-1', '你好', {}, async () => {
    throw new Error('down')
  })
  assert.deepEqual(network, { ok: false, error: CHAT_NETWORK_ERROR })
})
