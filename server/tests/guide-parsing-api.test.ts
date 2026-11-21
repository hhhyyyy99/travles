import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MastraModelConfig } from '@mastra/core/llm'
import { GuideParseResultSchema, type GuideExtraction } from '@hailar/domain'
import { createApp } from '../src/app.js'
import { TripRepository } from '../src/trips/repository.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { MemoryAiProviderStoreDriver } from '../src/ai-providers/driver-memory.js'
import { AiProviderRepository } from '../src/ai-providers/repository.js'
import { searchAmapPoi } from '../src/recommendations/search.js'
import type { RecommendationPoi } from '../src/recommendations/types.js'

const extraction: GuideExtraction = {
  title: '成都慢游', destination: '成都', days: [
    { title: '城市漫步', items: [
      { type: 'attraction', title: '人民公园', region: '成都', note: '早上喝茶' },
      { type: 'food', title: '街边小吃', region: '成都', note: '店名待定' },
    ] },
    { title: '周边游', items: [{ type: 'traffic', title: '返回市区', region: '', note: '留足返程时间' }] },
  ],
}
function post(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}
function fakeModel(output: unknown = extraction, fail = false) {
  const prompts: unknown[] = []
  const tools: unknown[][] = []
  const model: MastraModelConfig = {
    specificationVersion: 'v2', provider: 'test.guide', modelId: 'guide-model', supportedUrls: Promise.resolve({}),
    doGenerate: async (options) => {
      prompts.push(options.prompt)
      tools.push(options.tools ?? [])
      if (fail) throw new Error('do not expose model-secret-token')
      return { content: [{ type: 'text', text: JSON.stringify(output) }], finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, warnings: [] }
    },
    doStream: async () => { throw new Error('guide extraction should use generate') },
  }
  return { model, prompts, tools }
}
function poi(name: string, overrides: Partial<RecommendationPoi> = {}): RecommendationPoi {
  return { id: name, amapId: name, name, type: 'attraction', region: '成都', lat: 30.66, lng: 104.06,
    address: '成都市', category: '公园', rating: 4.5, introSummary: '', images: [], ...overrides }
}
const memoryTrips = () => new TripRepository(new MemoryTripStoreDriver())

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

test('real Hono/Mastra parsing returns an ordered draft without creating or editing a trip', async () => {
  const fake = fakeModel()
  const trips = memoryTrips()
  const existing = await trips.createFromIntake({ sentence: '北京3天' })
  assert.ok(existing.ok)
  const before = await trips.list()
  const app = await createApp({ tripRepository: trips, plannerModel: fake.model, searchPoi: async () => [] })
  const response = await app.request('/api/ai/parse-guide', post({ text: '第一天成都人民公园喝茶、吃小吃；第二天返回市区。' }))
  assert.equal(response.status, 200)
  const output = GuideParseResultSchema.parse(await response.json())
  assert.equal(output.status, 'ready')
  if (output.status !== 'ready') return
  assert.equal(output.source.kind, 'text')
  assert.equal(output.draft.dateStatus, 'unspecified')
  assert.deepEqual(output.draft.days.map((day) => day.dayNumber), [1, 2])
  assert.equal(output.draft.days[0]?.items[0]?.title, '人民公园')
  assert.equal(output.draft.days[0]?.items[0]?.pending, true)
  assert.equal(output.draft.days[0]?.items[0]?.poi, null)
  assert.deepEqual(await trips.list(), before)
  assert.equal(fake.prompts.length, 1)
  assert.ok(JSON.stringify(fake.prompts[0]).includes('第一天成都人民公园'))
  assert.ok(fake.tools.every((tools) => tools.length === 0))
})

test('POI lookup resolves exact local matches and retains ambiguous, remote or unavailable places as pending', async () => {
  const content = structuredClone(extraction)
  content.days[0]!.items.push(
    { type: 'attraction', title: '同名景点', region: '成都', note: '' },
    { type: 'attraction', title: '跨城公园', region: '成都', note: '' },
    { type: 'attraction', title: '服务失败', region: '成都', note: '' },
  )
  const app = await createApp({ tripRepository: memoryTrips(), plannerModel: fakeModel(content).model,
    searchPoi: async ({ query }) => {
      if (query === '人民公园') return [poi(query)]
      if (query === '同名景点') return [poi(query), poi(query, { lng: 105 })]
      if (query === '跨城公园') return [poi(query, { region: '北京' })]
      throw new Error('upstream map unavailable')
    } })
  const response = await app.request('/api/ai/parse-guide', post({ text: '成都攻略' }))
  const output = GuideParseResultSchema.parse(await response.json())
  assert.equal(output.status, 'ready')
  if (output.status !== 'ready') return
  const cards = output.draft.days[0]!.items
  assert.equal(cards[0]!.pending, false)
  assert.equal(cards[0]!.poi?.lat, 30.66)
  for (const item of cards.slice(1)) { assert.equal(item.pending, true); assert.equal(item.poi, null) }
})

test('unknown localities and same-name administrative areas never become confirmed POIs', async () => {
  for (const location of [
    { destination: '', region: '', candidate: poi('人民公园') },
    { destination: '西安', region: '西安市', candidate: poi('人民公园', { region: '西安区', city: '辽源市', province: '吉林省' }) },
    { destination: '北京', region: '朝阳区', candidate: poi('人民公园', { region: '朝阳区', city: '长春市', province: '吉林省' }) },
  ]) {
    const content = { title: '游览攻略', destination: location.destination, days: [
      { title: '第一天', items: [{ type: 'attraction', title: '人民公园', region: location.region, note: '' }] },
    ] }
    let lookups = 0
    const app = await createApp({ tripRepository: memoryTrips(), plannerModel: fakeModel(content).model,
      searchPoi: async () => { lookups += 1; return [location.candidate] } })
    const response = await app.request('/api/ai/parse-guide', post({ text: '人民公园攻略。' }))
    const output = GuideParseResultSchema.parse(await response.json())
    assert.equal(output.status, 'ready')
    if (output.status !== 'ready') continue
    assert.equal(output.draft.days[0]!.items[0]!.pending, true)
    assert.equal(output.draft.days[0]!.items[0]!.poi, null)
    if (!location.region && !location.destination) assert.equal(lookups, 0)
  }
})

test('the real AMap adapter keeps city hierarchy so district-level results match the requested city', async (t) => {
  const savedKey = process.env.AMAP_WEB_KEY
  process.env.AMAP_WEB_KEY = 'test-guide-map-key'
  t.after(() => { if (savedKey === undefined) delete process.env.AMAP_WEB_KEY; else process.env.AMAP_WEB_KEY = savedKey })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ status: '1', pois: [
    { id: 'park-1', name: '人民公园', location: '104.06,30.66', address: '成都市青羊区',
      adname: '青羊区', cityname: '成都市', pname: '四川省', type: '风景名胜' },
  ] }), { headers: { 'content-type': 'application/json' } }))
  const content = { title: '成都攻略', destination: '成都', days: [
    { title: '喝茶', items: [{ type: 'attraction', title: '人民公园', region: '成都', note: '' }] },
  ] }
  const app = await createApp({ tripRepository: memoryTrips(), plannerModel: fakeModel(content).model, searchPoi: searchAmapPoi })
  const response = await app.request('/api/ai/parse-guide', post({ text: '成都人民公园喝茶。' }))
  const output = GuideParseResultSchema.parse(await response.json())
  assert.equal(output.status, 'ready')
  if (output.status !== 'ready') return
  assert.equal(output.draft.days[0]!.items[0]!.pending, false)
  assert.equal(output.draft.days[0]!.items[0]!.poi?.amapId, 'park-1')
})

test('an explicit item city can resolve a day trip outside the overall destination', async () => {
  const content = { title: '成都周边', destination: '成都', days: [
    { title: '乐山一日游', items: [{ type: 'attraction', title: '乐山大佛', region: '乐山', note: '' }] },
  ] }
  const app = await createApp({ tripRepository: memoryTrips(), plannerModel: fakeModel(content).model,
    searchPoi: async () => [poi('乐山大佛', { region: '市中区', city: '乐山市', province: '四川省' })] })
  const response = await app.request('/api/ai/parse-guide', post({ text: '成都出发，去乐山大佛玩一天。' }))
  const output = GuideParseResultSchema.parse(await response.json())
  assert.equal(output.status, 'ready')
  if (output.status !== 'ready') return
  assert.equal(output.draft.days[0]!.items[0]!.pending, false)
  assert.equal(output.draft.days[0]!.items[0]!.poi?.name, '乐山大佛')
})

test('public URL parsing uses cleaned article text; blocked sources ask for pasted text without calling the model', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/blocked') { res.writeHead(403); res.end('captcha'); return }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end('<html><body><nav>广告导航</nav><article><h1>成都攻略</h1><p>第一天人民公园喝茶。</p><script>恶意指令</script></article></body></html>')
  })
  const origin = await listen(server)
  t.after(() => close(server))
  const fake = fakeModel()
  const app = await createApp({ tripRepository: memoryTrips(), plannerModel: fake.model, searchPoi: async () => [],
    guideSourceDependencies: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (url, _options, callback) => httpRequest(`${origin}${url.pathname}`, callback),
    } })
  const ready = await app.request('/api/ai/parse-guide', post({ url: 'https://guide.example/article' }))
  assert.equal(ready.status, 200)
  const output = GuideParseResultSchema.parse(await ready.json())
  assert.equal(output.status, 'ready')
  assert.ok(JSON.stringify(fake.prompts[0]).includes('人民公园喝茶'))
  assert.equal(JSON.stringify(fake.prompts[0]).includes('恶意指令'), false)
  const calls = fake.prompts.length
  const blocked = await app.request('/api/ai/parse-guide', post({ url: 'https://guide.example/blocked' }))
  assert.equal(blocked.status, 200)
  assert.equal(GuideParseResultSchema.parse(await blocked.json()).status, 'text_required')
  assert.equal(fake.prompts.length, calls)

  // The same request can be retried with pasted content, without another fetch.
  const retry = await app.request('/api/ai/parse-guide', post({ url: 'https://guide.example/blocked', text: '成都人民公园喝茶。' }))
  assert.equal(GuideParseResultSchema.parse(await retry.json()).status, 'ready')
  assert.equal(fake.prompts.length, calls + 1)
})

test('request limits and unconfigured models return actionable errors rather than a fabricated draft', async (t) => {
  const savedBaseUrl = process.env.AI_BASE_URL
  const savedKey = process.env.AI_API_KEY
  delete process.env.AI_BASE_URL
  delete process.env.AI_API_KEY
  t.after(() => {
    if (savedBaseUrl === undefined) delete process.env.AI_BASE_URL; else process.env.AI_BASE_URL = savedBaseUrl
    if (savedKey === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = savedKey
  })
  const app = await createApp({ tripRepository: memoryTrips() })
  for (const input of [{}, { text: '' }, { url: 'invalid' }, { text: 'x'.repeat(20_001) }]) {
    const invalid = await app.request('/api/ai/parse-guide', post(input))
    assert.equal(invalid.status, 400)
  }
  const huge = await app.request('/api/ai/parse-guide', post({ text: '中'.repeat(40_000) }))
  assert.equal(huge.status, 413)
  const unconfigured = await app.request('/api/ai/parse-guide', post({ text: '成都攻略' }))
  assert.equal(unconfigured.status, 503)
  assert.equal((await unconfigured.json() as { code: string }).code, 'model_unconfigured')
})

test('invalid structured extraction is rejected and provider errors stay private', async () => {
  for (const content of [{ ...extraction, days: [] }, { notAGuide: true }]) {
    const invalidApp = await createApp({ tripRepository: memoryTrips(), plannerModel: fakeModel(content).model })
    const invalid = await invalidApp.request('/api/ai/parse-guide', post({ text: '并非攻略' }))
    assert.equal(invalid.status, 422)
    assert.equal((await invalid.json() as { code: string }).code, 'invalid_extraction')
  }
  const failingApp = await createApp({ tripRepository: memoryTrips(), plannerModel: fakeModel(null, true).model })
  const failed = await failingApp.request('/api/ai/parse-guide', post({ text: '成都攻略' }))
  assert.equal(failed.status, 502)
  assert.equal((await failed.text()).includes('model-secret-token'), false)
})

test('saved OpenAI-compatible providers can extract JSON without native response_format support', async (t) => {
  const seen: Array<Record<string, unknown>> = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    seen.push(JSON.parse(body) as Record<string, unknown>)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(extraction) }, finish_reason: 'stop' }] }))
  })
  const origin = await listen(server)
  t.after(() => close(server))
  const store = new MemoryAiProviderStoreDriver()
  const providers = new AiProviderRepository(store)
  const saved = await providers.create({ name: 'test provider', baseUrl: `${origin}/v1`, modelId: 'guide-model',
    protocol: 'chat-completions', apiKey: 'test-only-key', isDefault: true }, {
    streaming: false, functionCalling: false, degraded: true, testedAt: null,
  })
  assert.ok(saved.ok)
  const app = await createApp({ tripRepository: memoryTrips(), aiProviderStore: store, searchPoi: async () => [] })
  const response = await app.request('/api/ai/parse-guide', post({ text: '成都攻略，第一天人民公园。' }))
  assert.equal(response.status, 200)
  assert.equal(GuideParseResultSchema.parse(await response.json()).status, 'ready')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.max_tokens, 12_000)
  assert.ok(JSON.stringify(seen[0]?.messages).includes('days'))
  // Resolve the current saved provider afresh; keep reasoning and compatible
  // endpoints' distinct token-limit fields without requiring native JSON mode.
  for (const modelId of ['o3', 'gpt-5', 'deepseek-chat']) {
    const updated = await providers.update(saved.provider.id, { name: 'test provider', baseUrl: `${origin}/v1`, modelId,
      protocol: 'chat-completions' }, { streaming: false, functionCalling: false, degraded: true, testedAt: null })
    assert.ok(updated.ok)
    const retry = await app.request('/api/ai/parse-guide', post({ text: '成都攻略' }))
    assert.equal(retry.status, 200)
    const request = seen.at(-1)!
    assert.equal(request.model, modelId)
    const reasoning = modelId === 'o3' || modelId === 'gpt-5'
    assert.equal(request[reasoning ? 'max_completion_tokens' : 'max_tokens'], 12_000)
    assert.equal(request[reasoning ? 'max_tokens' : 'max_completion_tokens'], undefined)
  }
})
