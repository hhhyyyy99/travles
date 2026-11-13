import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { importGuide, parseGuide } from '../src/domain/guideParsing'
import type { GuideDraft } from '@hailar/domain'
import type { FetchLike } from '../src/domain/tripList'

const draft: GuideDraft = { title: '成都', destination: '成都', dateStatus: 'unspecified', warnings: [], days: [
  { title: '城市漫步', dayNumber: 1, items: [{ title: '人民公园', type: 'attraction', region: '成都', note: '', pending: true, poi: null }] },
] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('invalid guide input and malformed import contracts never reach the network', async () => {
  let calls = 0
  const transport: FetchLike = async () => { calls++; return json({}) }
  assert.equal((await parseGuide({}, undefined, transport)).ok, false)
  assert.equal((await parseGuide({ text: 'a'.repeat(20001) }, undefined, transport)).ok, false)
  assert.equal((await importGuide({ draft, title: '成都', importId: 'bad' }, undefined, transport)).ok, false)
  assert.equal(calls, 0)
})

test('parser preserves text-required as a recoverable outcome and exposes model setup failures', async () => {
  const fallback = { status: 'text_required', code: 'source_unavailable', guidance: '请粘贴正文' }
  assert.deepEqual(await parseGuide({ url: 'https://example.com/guide' }, undefined, async () => json(fallback)), { ok: true, data: fallback })
  const error = await parseGuide({ text: '攻略' }, undefined, async () => json({ status: 'error', code: 'model_unconfigured', error: '请配置模型' }, 503))
  assert.deepEqual(error, { ok: false, error: '请配置模型', code: 'model_unconfigured' })
})

test('successful HTTP responses still require a valid ordered draft, and parsing never confirms it', async () => {
  const calls: string[] = []
  const transport: FetchLike = async (url) => { calls.push(url); return json({ status: 'ready', source: { kind: 'text' }, draft }) }
  assert.equal((await parseGuide({ text: '攻略' }, undefined, transport)).ok, true)
  assert.deepEqual(calls, ['/api/ai/parse-guide'])
  const invalid = structuredClone(draft)
  invalid.days[0]!.dayNumber = 2
  assert.equal((await parseGuide({ text: '攻略' }, undefined, async () => json({ status: 'ready', source: { kind: 'text' }, draft: invalid }))).ok, false)
  assert.equal((await parseGuide({ text: '攻略' }, undefined, async () => new Response('<html>bad gateway</html>'))).ok, false)
})

test('confirmation retains the caller idempotency key across a lost response and retry', async () => {
  const input = { draft, title: '我的成都', importId: randomUUID() }
  const bodies: unknown[] = []
  let first = true
  const trip = { id: 'created-trip', title: input.title, startDate: '', endDate: '', days: 0, nights: 0, createdAt: '', updatedAt: '', durationDays: 1, dateStatus: 'unspecified' }
  const transport: FetchLike = async (url, init) => {
    assert.equal(url, '/api/trips/from-guide')
    bodies.push(JSON.parse(String(init?.body)))
    if (first) { first = false; throw new Error('lost response') }
    return json({ trip }, 201)
  }
  assert.equal((await importGuide(input, undefined, transport)).ok, false)
  assert.deepEqual(await importGuide(input, undefined, transport), { ok: true, data: trip })
  assert.deepEqual(bodies[0], bodies[1])
  assert.equal((await importGuide(input, undefined, async () => json({ trip: { ...trip, id: '' } }, 201))).ok, false)
})

test('the page abort signal reaches the transport and abort failures do not escape as exceptions', async () => {
  const controller = new AbortController()
  const transport: FetchLike = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  const pending = parseGuide({ text: '攻略' }, controller.signal, transport)
  controller.abort()
  assert.equal((await pending).ok, false)
})
