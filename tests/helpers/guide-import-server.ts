// Real HTTP + Hono/Mastra + isolated SQLite. Only the model and map lookup are injected.
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../server/src/app.js'
import { createSqliteTripRepository } from '../../server/src/trips/factory.js'
import { createSqliteWorkbenchStore } from '../../server/src/days/driver-sqlite.js'
import type { CreateAppOptions } from '../../server/src/app.js'
type MastraModelConfig = NonNullable<CreateAppOptions['plannerModel']>

const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { serve } = require('@hono/node-server')
const directory = await mkdtemp(join(tmpdir(), 'guide-import-browser-'))
const databaseUrl = 'file:' + join(directory, 'trips.db')
const sqlite = await createSqliteTripRepository(databaseUrl)
const extraction = {
  title: '成都两日慢游', destination: '成都', days: [
    { title: '城市漫步', items: [
      { type: 'attraction', title: '人民公园', note: '早上喝茶', region: '成都' },
      { type: 'food', title: '街边小吃', note: '店名待定', region: '成都' },
    ] },
    { title: '周边游', items: [
      { type: 'attraction', title: '都江堰', note: '留足返程时间', region: '成都' },
      { type: 'other', title: '整理照片', note: '不需要定位', region: '' },
    ] },
  ],
}
const model: MastraModelConfig = {
  specificationVersion: 'v2', provider: 'test.guide', modelId: 'browser-guide', supportedUrls: Promise.resolve({}),
  doGenerate: async () => ({ content: [{ type: 'text', text: JSON.stringify(extraction) }],
    finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, warnings: [] }),
  doStream: async () => { throw new Error('Unexpected chat generation during guide import') },
}
const app = await createApp({ databaseUrl, tripRepository: sqlite.repository,
  contentRepository: sqlite.contentRepository, workbenchStore: createSqliteWorkbenchStore(sqlite.db),
  guideImportDatabase: sqlite.db, plannerModel: model, searchPoi: async ({ query }) => query === '人民公园' ? [{
    id: 'park-1', amapId: 'park-1', name: '人民公园', type: 'attraction', region: '成都', lat: 30.66, lng: 104.06,
    address: '成都市', category: '公园', rating: 4.5, introSummary: '', images: [],
  }] : [], routeLegs: async () => ({ status: 'pending', source: 'pending', distanceKm: null, durationMin: null, polyline: null }),
})
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
console.log('READY ' + server.address().port)
async function stop() {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(resolve))
  await sqlite.close()
  await rm(directory, { recursive: true, force: true })
  process.exit(0)
}
process.once('SIGTERM', () => { void stop() })
process.once('SIGINT', () => { void stop() })
