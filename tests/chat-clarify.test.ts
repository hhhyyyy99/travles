/**
 * Chat clarify-round tests (ticket 07) — the meta SSE event dispatch and the
 * meta-carrying persisted messages (tests/chat.test.ts keeps the ticket-06
 * qa-round cases); plus the assistant-content parser (markdown subset +
 * inline POI links) in src/domain/chatMarkdown.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchChatHistory,
  normalizeChatMeta,
  sendChatMessage,
  type ChatMessageMeta,
  type FetchLike,
} from '../src/domain/chat'
import { parseAssistantContent } from '../src/domain/chatMarkdown'

/** FetchLike whose POST response streams the given SSE text in chunks. */
function sseFetch(blocks: string[]): FetchLike {
  const raw = blocks.join('')
  const encoder = new TextEncoder()
  return async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(raw))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
}

const CLARIFY_META: ChatMessageMeta = {
  round: 'clarify',
  chips: [
    { label: '🚗 自驾/租车自驾', value: '我们自驾出行' },
    { label: '✈️ 飞到当地后租车', value: '飞到海拉尔后租车' },
  ],
  poiLinks: [{ name: '莫尔格勒河', lat: 49.4072, lng: 119.7478 }],
  think: '用户没说出行方式，先澄清。',
  thinkComplete: true,
  sources: [{ title: '呼伦贝尔自驾攻略', url: 'https://example.com/guide' }],
}

test('sendChatMessage dispatches the meta event payload to onMeta', async () => {
  const metas: ChatMessageMeta[] = []
  const assistantMessage = {
    id: 'a1',
    tripId: 'trip-1',
    role: 'assistant',
    content: '先给框架，再澄清一个关键变量：',
    createdAt: 't2',
    think: CLARIFY_META.think ?? null,
    sources: CLARIFY_META.sources,
    meta: CLARIFY_META,
  }
  const result = await sendChatMessage(
    'trip-1',
    '我打算去呼伦贝尔玩 7 天',
    {
      onMeta: (meta) => metas.push(meta),
    },
    sseFetch([
      'event: start\ndata: {"round":"clarify"}\n\n',
      'event: delta\ndata: {"text":"先给框架，"}\n\n',
      'event: delta\ndata: {"text":"再澄清一个关键变量："}\n\n',
      `event: meta\ndata: ${JSON.stringify(CLARIFY_META)}\n\n`,
      `event: done\ndata: ${JSON.stringify({
        userMessage: { id: 'u1', tripId: 'trip-1', role: 'user', content: '我打算去呼伦贝尔玩 7 天', createdAt: 't1' },
        assistantMessage,
      })}\n\n`,
    ]),
  )

  assert.ok(result.ok)
  if (!result.ok) return
  assert.deepEqual(metas, [CLARIFY_META])
  assert.deepEqual(result.assistantMessage.meta, CLARIFY_META)
  assert.equal(result.assistantMessage.think, CLARIFY_META.think)
  assert.deepEqual(result.assistantMessage.sources, CLARIFY_META.sources)
})

test('meta events with unknown rounds or malformed payloads are tolerated, never fatal', async () => {
  const metas: ChatMessageMeta[] = []
  const errors: string[] = []
  const donePayload = {
    userMessage: { id: 'u1', tripId: 'trip-1', role: 'user', content: '你好', createdAt: 't1' },
    assistantMessage: { id: 'a1', tripId: 'trip-1', role: 'assistant', content: '你好！', createdAt: 't2' },
  }
  const result = await sendChatMessage(
    'trip-1',
    '你好',
    {
      onMeta: (meta) => metas.push(meta),
      onError: (error) => errors.push(error.message),
    },
    sseFetch([
      'event: start\ndata: {"round":"qa"}\n\n',
      'event: meta\ndata: {"noRoundHere":true}\n\n',
      'event: meta\ndata: {"round":"qa","chips":[{"label":"只有label"},{"label":"x","value":"有效"}]}\n\n',
      // Unknown event (forward compat with tickets 08/11) must be ignored.
      'event: trip_patch\ndata: {"patch":{}}\n\n',
      `event: done\ndata: ${JSON.stringify(donePayload)}\n\n`,
    ]),
  )

  assert.ok(result.ok)
  assert.deepEqual(errors, [])
  assert.deepEqual(metas, [{ round: 'qa', chips: [{ label: 'x', value: '有效' }] }])
})

test('fetchChatHistory restores meta fields on persisted assistant messages', async () => {
  const result = await fetchChatHistory('trip-1', async () =>
    new Response(
      JSON.stringify({
        messages: [
          { id: 'm1', tripId: 'trip-1', role: 'user', content: '规划一下', createdAt: 't1' },
          {
            id: 'm2',
            tripId: 'trip-1',
            role: 'assistant',
            content: '框架…',
            createdAt: 't2',
            think: '先给框架。',
            sources: [{ title: '攻略', url: 'https://example.com/a' }, { title: '坏的', url: '' }],
            meta: CLARIFY_META,
          },
          { id: 'm3', tripId: 'trip-1', role: 'assistant', content: '无元数据', createdAt: 't3' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  )

  assert.ok(result.ok)
  if (!result.ok) return
  const [, withMeta, withoutMeta] = result.data
  assert.deepEqual(withMeta?.meta, CLARIFY_META)
  assert.equal(withMeta?.think, '先给框架。')
  assert.deepEqual(withMeta?.sources, [{ title: '攻略', url: 'https://example.com/a' }], 'invalid entries dropped')
  assert.equal(withoutMeta?.meta, null)
  assert.equal(withoutMeta?.think, null)
  assert.equal(withoutMeta?.sources, null)
})

test('chat metadata keeps valid geographic checks when another entry is malformed', () => {
  const check = { from: '成都', to: '康定', durationMin: 420, source: 'model', estimated: true }
  assert.deepEqual(normalizeChatMeta({
    round: 'qa',
    geographicFactCheck: [check, { ...check, durationMin: '420' }, { ...check, estimated: false }],
  }), { round: 'qa', geographicFactCheck: [check] })
  assert.deepEqual(normalizeChatMeta({ round: 'qa' }), { round: 'qa' })
})

// ---- parseAssistantContent (chatMarkdown) ---------------------------------

test('parses headings, bold runs and lists into renderable blocks', () => {
  const blocks = parseAssistantContent(
    '## 经典环线\n海拉尔→莫尔格勒河→**额尔古纳**→满洲里\n- 提前 2 天预约\n1. 先到海拉尔',
  )
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['heading', 'paragraph', 'list-item', 'list-item'],
  )
  const heading = blocks[0]
  assert.equal(heading?.kind, 'heading')
  if (heading?.kind !== 'heading') return
  assert.equal(heading.level, 2)
  assert.deepEqual(heading.spans, [{ kind: 'text', text: '经典环线' }])

  const paragraph = blocks[1]
  if (paragraph === undefined || paragraph.kind !== 'paragraph') return
  assert.deepEqual(paragraph.spans, [
    { kind: 'text', text: '海拉尔→莫尔格勒河→' },
    { kind: 'bold', text: '额尔古纳' },
    { kind: 'text', text: '→满洲里' },
  ])

  const unordered = blocks[2]
  if (unordered === undefined || unordered.kind !== 'list-item') return
  assert.equal(unordered.ordered, false)
  assert.equal(unordered.marker, '•')
  const ordered = blocks[3]
  if (ordered === undefined || ordered.kind !== 'list-item') return
  assert.equal(ordered.ordered, true)
  assert.equal(ordered.marker, '1.')
})

test('POI names become poi spans; longest name wins and surrounding text survives', () => {
  const poiLinks = [
    { name: '海拉尔', lat: 49.2, lng: 119.7 },
    { name: '海拉尔国家森林公园', lat: 49.24, lng: 119.75 },
    { name: '额尔古纳', lat: 50.24, lng: 120.19 },
  ]
  const blocks = parseAssistantContent('推荐海拉尔国家森林公园，再往北是额尔古纳。', poiLinks)
  const paragraph = blocks[0]
  if (paragraph === undefined || paragraph.kind !== 'paragraph') return
  assert.deepEqual(paragraph.spans, [
    { kind: 'text', text: '推荐' },
    { kind: 'poi', text: '海拉尔国家森林公园', poi: poiLinks[1] },
    { kind: 'text', text: '，再往北是' },
    { kind: 'poi', text: '额尔古纳', poi: poiLinks[2] },
    { kind: 'text', text: '。' },
  ])
})

test('content without meta or markup degrades to plain paragraphs', () => {
  const blocks = parseAssistantContent('第一行\n\n第二行')
  assert.equal(blocks.length, 2)
  const first = blocks[0]
  if (first === undefined || first.kind !== 'paragraph') return
  assert.deepEqual(first.spans, [{ kind: 'text', text: '第一行' }])
})
