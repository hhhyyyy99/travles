// Real Hono + isolated SQLite. The model is deterministic and external services are forbidden.
import { createRequire } from 'node:module'
import { createApp, type CreateAppOptions } from '../../server/src/app.js'
import { createSqliteDatabase } from '../../server/src/db/driver.js'
import { ensureSchema } from '../../server/src/db/schema.js'
import { SqliteTripStoreDriver } from '../../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../../server/src/trips/repository.js'
import { SqliteContentStoreDriver } from '../../server/src/content/driver-sqlite.js'
import { TripContentRepository } from '../../server/src/content/repository.js'
import { createSqliteWorkbenchStore } from '../../server/src/days/driver-sqlite.js'
import { createSqliteDaysAdminStore } from '../../server/src/days-admin/driver-sqlite.js'
import { createSqliteItemsAdminStore } from '../../server/src/items-admin/driver-sqlite.js'
import { createSqliteToolsStore } from '../../server/src/tools/driver-sqlite.js'
import { createSqliteRecommendationsStore } from '../../server/src/recommendations/driver-sqlite.js'
import { createSqliteTripPatchStore } from '../../server/src/trip-patch/store-sqlite.js'
import { SqliteMessageStoreDriver } from '../../server/src/chat/driver-sqlite.js'
import { SqliteAiProviderStoreDriver } from '../../server/src/ai-providers/driver-sqlite.js'

const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { serve } = require('@hono/node-server')
const db = createSqliteDatabase(':memory:')
await ensureSchema(db)
const metadata = { timeRange: '\t 次日 01:00 JST\n现场为准 ', cost: ' ¥100–200/人（估算）\n不含停车费\t' }
const proposalItem = { itemId: 'proposal-item', dayId: 'proposal-day', type: 'other', title: '结构化提案活动', pending: true, ...metadata }
const proposal = { kind: 'parse', title: '结构化提案', summary: '保留显式作者说明',
  items: [proposalItem], diff: [{ action: 'add', label: '增加活动' }],
  patch: { ops: [{ op: 'add_day', dayId: 'proposal-day', theme: '提案日期' }, { op: 'add_item', ...proposalItem }] } }
let calls = 0
const model: NonNullable<CreateAppOptions['plannerModel']> = {
  specificationVersion: 'v2', provider: 'test.metadata', modelId: 'metadata', supportedUrls: Promise.resolve({}),
  doGenerate: async () => { throw new Error('Guide extraction is outside this explicit-input regression') },
  doStream: async () => {
    calls += 1
    const parts = calls === 1
      ? [{ type: 'tool-call', toolCallId: 'metadata-proposal', toolName: 'create_trip_proposal', input: JSON.stringify(proposal) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]
      : [{ type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: '待确认' }, { type: 'text-end', id: 'text' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]
    return { stream: new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close() } }) }
  },
} as NonNullable<CreateAppOptions['plannerModel']>
const app = await createApp({ databaseUrl: ':memory:', seedBuiltinTrip: false,
  tripRepository: new TripRepository(new SqliteTripStoreDriver(db)),
  contentRepository: new TripContentRepository(new SqliteContentStoreDriver(db)), guideImportDatabase: db,
  workbenchStore: createSqliteWorkbenchStore(db), daysAdminStore: createSqliteDaysAdminStore(db),
  itemsAdminStore: createSqliteItemsAdminStore(db), toolsStore: createSqliteToolsStore(db),
  recommendationsStore: createSqliteRecommendationsStore(db), tripPatchStore: createSqliteTripPatchStore(db),
  messageStore: new SqliteMessageStoreDriver(db), aiProviderStore: new SqliteAiProviderStoreDriver(db), plannerModel: model,
  searchPoi: async () => { throw new Error('External POI call forbidden') },
  routeLegs: async () => { throw new Error('External route call forbidden') },
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
if (!server.listening) await new Promise<void>((done) => server.once('listening', done))
console.log('READY ' + server.address().port)
let stopping: Promise<void> | undefined
function stop() {
  stopping ??= (async () => {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(done))
    await db.close()
  })()
  return stopping
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => { void stop().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) }) })
}
