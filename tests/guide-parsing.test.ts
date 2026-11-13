import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { importGuide, parseGuide, type GuideImportSession } from '../src/domain/guideParsing'
import { GuideDraftSchema, GuideExtractionSchema, GuideImportRequestSchema, type GuideDraft, type GuideImportRequest } from '@hailar/domain'
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

test('explicit guide metadata survives preview decoding, session confirmation, schema parsing and retries', async () => {
  const explicitDraft = structuredClone(draft)
  explicitDraft.days[0]!.items[0]!.timeRange = '  22:00 → 次日 02:00\n'
  explicitDraft.days[0]!.items[0]!.cost = ''
  assert.deepEqual(GuideDraftSchema.parse(explicitDraft), explicitDraft)
  const preview = await parseGuide({ text: '攻略' }, undefined, async () => json({ status: 'ready', source: { kind: 'text' }, draft: explicitDraft }))
  assert.ok(preview.ok && preview.data.status === 'ready')
  if (!preview.ok || preview.data.status !== 'ready') return
  assert.deepEqual(preview.data.draft, explicitDraft)
  const confirmation = { draft: preview.data.draft, title: '我的成都', importId: randomUUID() }
  const session: GuideImportSession = {
    url: '', text: '攻略', draft: preview.data.draft, title: confirmation.title, importId: confirmation.importId, confirmation,
  }
  const restored = structuredClone(session)
  assert.deepEqual(GuideImportRequestSchema.parse(restored.confirmation), confirmation)
  const trip = { id: 'created-trip', title: confirmation.title, startDate: '', endDate: '', days: 0, nights: 0, createdAt: '', updatedAt: '' }
  const bodies: unknown[] = []
  const transport: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return json({ trip }, 201)
  }
  assert.deepEqual(await importGuide(restored.confirmation!, undefined, transport), { ok: true, data: trip })
  assert.deepEqual(await importGuide(restored.confirmation!, undefined, transport), { ok: true, data: trip })
  assert.deepEqual(bodies, [confirmation, confirmation])
  assert.deepEqual(restored.draft, explicitDraft)
})

test('guide previews omit malformed optional metadata independently while keeping valid siblings, activities and old omissions', async () => {
  const preview = (value: unknown) => parseGuide({ text: '攻略' }, undefined, async () => json({
    status: 'ready', source: { kind: 'text' }, draft: value,
  }))
  assert.deepEqual(await preview(draft), { ok: true, data: { status: 'ready', source: { kind: 'text' }, draft } })
  const source = draft.days[0]!.items[0]!
  for (const field of ['timeRange', 'cost']) {
    for (const invalid of [null, 42, false, {}, [], new Uint8Array([65, 66])]) {
      const sibling = field === 'timeRange' ? { cost: ' valid cost\n' } : { timeRange: '\tvalid time  ' }
      const rawDraft = structuredClone(draft)
      rawDraft.days[0]!.items = [
        { ...source, ...sibling, [field]: invalid },
        { ...source, timeRange: '', cost: '\t  ' },
        { ...source },
      ]
      const expected = structuredClone(draft)
      expected.days[0]!.items = [{ ...source, ...sibling }, { ...source, timeRange: '', cost: '\t  ' }, { ...source }]
      assert.deepEqual(await preview(rawDraft), { ok: true, data: { status: 'ready', source: { kind: 'text' }, draft: expected } })
    }
  }
  const invalidBoth = structuredClone(draft)
  Object.assign(invalidBoth.days[0]!.items[0]!, { timeRange: null, cost: 42 })
  assert.deepEqual(await preview(invalidBoth), { ok: true, data: { status: 'ready', source: { kind: 'text' }, draft } })
  for (const malformed of [
    { title: null }, { note: false }, { type: 'invalid' }, { poi: {} },
  ]) {
    const invalidCore = structuredClone(draft)
    Object.assign(invalidCore.days[0]!.items[0]!, { timeRange: null, cost: 'valid', ...malformed })
    assert.equal((await preview(invalidCore)).ok, false, 'only the two optional metadata fields are tolerant')
  }
})

test('guide extraction keeps its original item schema while explicit import metadata rejects non-strings before network access', async () => {
  const extraction = {
    title: draft.title, destination: draft.destination,
    days: [{ title: draft.days[0]!.title, items: [{ title: '人民公园', type: 'attraction', region: '成都', note: '' }] }],
  }
  const withExtra = structuredClone(extraction)
  Object.assign(withExtra.days[0]!.items[0]!, { timeRange: 'not part of extraction', cost: 'not part of extraction' })
  assert.deepEqual(GuideExtractionSchema.parse(withExtra), extraction)
  let calls = 0
  const transport: FetchLike = async () => { calls++; return json({}) }
  for (const field of ['timeRange', 'cost']) {
    for (const value of [null, 42, false, {}, []]) {
      const malformed = structuredClone(draft)
      Object.assign(malformed.days[0]!.items[0]!, { [field]: value })
      const input = { draft: malformed, importId: randomUUID() } as GuideImportRequest
      assert.equal(GuideImportRequestSchema.safeParse(input).success, false)
      assert.deepEqual(await importGuide(input, undefined, transport), {
        ok: false, code: 'invalid_request', error: '草稿内容无效，请重新解析后再创建。',
      })
    }
  }
  assert.equal(calls, 0)
})
