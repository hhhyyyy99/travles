// Production Hono routes and SQLite stores over one isolated in-memory connection.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createApp } from '../../server/src/app.js'
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
let server: ReturnType<typeof serve> | undefined
let stopping: Promise<void> | undefined

function stop(): Promise<void> {
  stopping ??= (async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close((error?: Error) => error ? reject(error) : done()))
    }
    await db.close()
  })()
  return stopping
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void stop().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
  })
}

try {
  // A legacy table permits absent/NULL timestamps. Production ensureSchema
  // attaches to it without backfilling; every HTTP read/write still uses the
  // real SQLite driver and repository. Fresh production tables use NOT NULL.
  await db.run(`CREATE TABLE stash (
    id TEXT PRIMARY KEY,
    trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    poi TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'recommend',
    added_at TEXT
  )`)
  await ensureSchema(db)
  const tripId = 'stash-fields-trip'
  const otherTripId = 'stash-fields-other-trip'
  for (const id of [tripId, otherTripId]) {
    await db.run(`INSERT INTO trips (id, title, created_at, updated_at)
      VALUES (?, ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    [id, id === tripId ? 'Stash fields browser regression' : 'Excluded trip'])
    await db.run('INSERT INTO days (id, trip_id, idx, theme, color) VALUES (?, ?, 0, ?, ?)',
      [id + '-day', id, '随心慢游', '#3f7d5c'])
  }
  const poi = (id: string, extra: Record<string, unknown> = {}) => ({
    id: 'poi-' + id, amapId: '', name: '点位 ' + id, lat: 30.66, lng: 104.06,
    category: '原始分类', type: 'attraction', region: '成都', rating: 4.5,
    introSummary: '独立简介', address: '独立地址', images: [], ...extra,
  })
  const rows = [
    { id: 'raw', poi: poi('raw', { name: '\t  原始点位名称  \n', category: '\n  自由文本分类  \t',
      title: '不得成为别名', tripId: otherTripId, createdAt: '不得成为时间别名' }),
      origin: 'favorite', time: '\t  not-an-ISO-date  \n' },
    { id: 'long', poi: poi('long', { name: '\t' + '旅'.repeat(175) + '\n', category: '  ' + '类'.repeat(95) + '\t' }),
      origin: 'recommend', time: '\n ' + 't'.repeat(100) + ' \t' },
    { id: 'invalid-category', poi: poi('invalid-category', { category: { label: '不可强制转换' } }),
      origin: 'unknown', time: '2026-09-02T01:02:03.000Z' },
    { id: 'null-time', poi: poi('null-time', { category: null }), origin: 'recommend', time: null },
    { id: 'blank', poi: poi('blank', { category: '\t  \n' }), origin: 'recommend', time: '\n \t' },
    { id: 'blob-time', poi: poi('blob-time'), origin: 'recommend', time: new Uint8Array([50, 48, 50, 54]) },
  ]
  for (const row of rows) {
    await db.run('INSERT INTO stash (id, trip_id, poi, origin, added_at) VALUES (?, ?, ?, ?, ?)',
      [row.id, tripId, JSON.stringify(row.poi), row.origin, row.time])
  }
  // Both an omitted SQL column and an explicit NULL must stay absent aliases.
  await db.run('INSERT INTO stash (id, trip_id, poi) VALUES (?, ?, ?)',
    ['missing-time', tripId, JSON.stringify({ id: 'poi-missing-time', name: '缺少分类和时间', lat: 30.66, lng: 104.06 })])
  await db.run('INSERT INTO stash (id, trip_id, poi, added_at) VALUES (?, ?, ?, ?)',
    ['bad-json', tripId, '{broken JSON', '2026-09-01'])
  await db.run('INSERT INTO stash (id, trip_id, poi, added_at) VALUES (?, ?, ?, ?)',
    ['bad-poi', tripId, JSON.stringify(poi('bad-poi', { name: ' \t\n' })), '2026-09-01'])
  await db.run('INSERT INTO stash (id, trip_id, poi, added_at) VALUES (?, ?, ?, ?)',
    ['other-trip-stash', otherTripId, JSON.stringify(poi('other-trip', { name: '跨行程点位' })), '2026-09-01'])
  await db.run('INSERT INTO favorites (id, trip_id, poi, created_at) VALUES (?, ?, ?, ?)',
    ['other-trip-favorite', otherTripId, JSON.stringify(poi('other-favorite')), '2026-09-01'])

  // Check that SQLite did not coerce the corrupt timestamp cases before READY.
  const { rows: storage } = await db.run(`SELECT id, typeof(added_at) AS time_type FROM stash
    WHERE id IN ('raw', 'null-time', 'missing-time', 'blob-time')`)
  assert.deepEqual(Object.fromEntries(storage.map((row) => [row.id, row.time_type])), {
    raw: 'text', 'null-time': 'null', 'missing-time': 'null', 'blob-time': 'blob',
  })

  // Inject all stores: an option resolver must never open a second :memory:
  // connection, or fall through to a shared file from the developer environment.
  const app = await createApp({
    databaseUrl: ':memory:', seedBuiltinTrip: false,
    tripRepository: new TripRepository(new SqliteTripStoreDriver(db)),
    contentRepository: new TripContentRepository(new SqliteContentStoreDriver(db)),
    guideImportDatabase: db,
    workbenchStore: createSqliteWorkbenchStore(db), daysAdminStore: createSqliteDaysAdminStore(db),
    itemsAdminStore: createSqliteItemsAdminStore(db), toolsStore: createSqliteToolsStore(db),
    recommendationsStore: createSqliteRecommendationsStore(db), tripPatchStore: createSqliteTripPatchStore(db),
    messageStore: new SqliteMessageStoreDriver(db), aiProviderStore: new SqliteAiProviderStoreDriver(db),
    searchPoi: async () => { throw new Error('External POI search is outside this regression') },
    routeLegs: async () => { throw new Error('External route lookup is outside this regression') },
  })
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await new Promise<void>((done) => server.once('listening', done))
  console.log('READY ' + server.address().port)
} catch (error) {
  console.error(error)
  await stop()
  process.exit(1)
}
