// Production Hono endpoints over one isolated SQLite connection; no fixture HTTP routes.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createApp } from '../../server/src/app.js'
import { createSqliteTripRepository } from '../../server/src/trips/factory.js'
import { createSqliteWorkbenchStore } from '../../server/src/days/driver-sqlite.js'
import { createSqliteDaysAdminStore } from '../../server/src/days-admin/driver-sqlite.js'
import { createSqliteToolsStore } from '../../server/src/tools/driver-sqlite.js'
import { createSqliteRecommendationsStore } from '../../server/src/recommendations/driver-sqlite.js'
import { SqliteMessageStoreDriver } from '../../server/src/chat/driver-sqlite.js'
import type { SqlValue } from '../../server/src/db/driver.js'

const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { serve } = require('@hono/node-server')
const temporaryRoot = await realpath(tmpdir())
const directory = await mkdtemp(join(temporaryRoot, 'leg-metrics-browser-'))
const fixtureDirectory = await realpath(directory)
const databaseUrl = 'file:' + join(fixtureDirectory, 'trips.db')
let sqlite: Awaited<ReturnType<typeof createSqliteTripRepository>> | undefined
let server: ReturnType<typeof serve> | undefined
let stopping: Promise<void> | undefined

function stop(): Promise<void> {
  stopping ??= (async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((done, reject) => server.close((error?: Error) => error ? reject(error) : done()))
    }
    await sqlite?.close()
    // Check the actual absolute target immediately before removing our own fixture tree.
    assert.equal(resolve(directory), fixtureDirectory)
    assert.equal(await realpath(directory), fixtureDirectory)
    assert.equal(dirname(fixtureDirectory), temporaryRoot)
    assert.ok(basename(fixtureDirectory).startsWith('leg-metrics-browser-'))
    await rm(fixtureDirectory, { recursive: true, force: true })
  })()
  return stopping
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    void stop().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
  })
}

try {
  sqlite = await createSqliteTripRepository(databaseUrl)
  const { db } = sqlite
  const tripId = 'leg-metrics-trip'
  const dayId = 'leg-metrics-day'
  const context = { destination: '成都', durationDays: 9, preferences: '慢游', originalSentence: '成都九天慢游',
    dateStatus: 'confirmed', datePhrase: '2026-10-02 至 2026-10-04' }
  await db.run(`INSERT INTO trips
    (id, title, start_date, end_date, created_at, updated_at, planning_context, cover_image, is_pinned, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    tripId, 'Leg metrics browser regression', '2026-10-02', '2026-10-04',
    '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', JSON.stringify(context), '', 0, '\t  原始行程状态  \n',
  ])
  for (const day of [
    { id: dayId, index: 0, date: '2026-10-02', theme: '原始主题', title: '\t  独立的当天标题  \n', note: '\n  独立的当天备注\t ' },
    { id: 'leg-metrics-empty-day', index: 1, date: '2026-10-03', theme: '空元数据主题', title: '', note: '' },
    { id: 'leg-metrics-legacy-day', index: 2, date: '2026-10-04', theme: '旧格式主题', title: null, note: null },
  ]) {
    await db.run('INSERT INTO days (id, trip_id, idx, date, theme, color, title, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [day.id, tripId, day.index, day.date, day.theme, '#3f7d5c', day.title, day.note])
  }

  type Fixture = { id: string; distance: SqlValue; duration: SqlValue; quality: SqlValue; geometry?: boolean }
  const blob = new Uint8Array([49, 50, 46, 53]) // Numeric-looking bytes stay SQLite BLOB, never a number.
  const fixtures: Fixture[] = [
    { id: 'normal', distance: 12.5, duration: 23.75, quality: 'measured', geometry: true },
    { id: 'fractional', distance: 0.123046875, duration: 0.5078125, quality: 'reference' },
    { id: 'zero-measured', distance: 0, duration: 0, quality: 'measured' },
    { id: 'zero-estimate', distance: 0, duration: 0, quality: 'estimate' },
    { id: 'zero-reference', distance: 0, duration: 0, quality: 'reference' },
    { id: 'zero-pending', distance: 0, duration: 0, quality: 'pending' },
    { id: 'zero-pending-geometry', distance: 0, duration: 0, quality: 'pending', geometry: true },
    { id: 'zero-legacy', distance: 0, duration: 0, quality: null },
    { id: 'zero-legacy-empty-quality', distance: 0, duration: 0, quality: '' },
    { id: 'zero-legacy-geometry', distance: 0, duration: 0, quality: null, geometry: true },
    { id: 'zero-unknown-quality', distance: 0, duration: 0, quality: 'unknown' },
    { id: 'null', distance: null, duration: null, quality: 'pending' },
    { id: 'text', distance: 'not-a-number', duration: 'not-a-number', quality: 'measured' },
    { id: 'blob', distance: blob, duration: blob, quality: 'measured' },
    { id: 'negative', distance: -1.25, duration: -2.5, quality: 'measured' },
    { id: 'infinity', distance: Infinity, duration: Infinity, quality: 'measured' },
    { id: 'overflow', distance: 1e308, duration: 1e308, quality: 'measured' },
    { id: 'distance-only', distance: 2.75, duration: null, quality: 'estimate' },
    { id: 'duration-only', distance: null, duration: 3.125, quality: 'estimate' },
    { id: 'text-distance', distance: 'bad-distance', duration: 4.375, quality: 'measured' },
    { id: 'text-duration', distance: 5.125, duration: 'bad-duration', quality: 'measured' },
    { id: 'blob-distance', distance: blob, duration: 6.25, quality: 'measured' },
    { id: 'blob-duration', distance: 7.375, duration: blob, quality: 'measured' },
    { id: 'negative-distance', distance: -1, duration: 8.5, quality: 'measured' },
    { id: 'negative-duration', distance: 9.625, duration: -1, quality: 'measured' },
    { id: 'infinite-distance', distance: Infinity, duration: 10.75, quality: 'measured' },
    { id: 'infinite-duration', distance: 11.875, duration: Infinity, quality: 'measured' },
    { id: 'overflow-distance', distance: 1e306, duration: 12.125, quality: 'measured' },
    { id: 'overflow-duration', distance: 13.25, duration: 1e307, quality: 'measured' },
    { id: 'zero-distance-invalid-duration', distance: 0, duration: 'bad-duration', quality: 'measured' },
    { id: 'invalid-distance-zero-duration', distance: null, duration: 0, quality: 'measured' },
  ]
  const geometry = JSON.stringify([[104.06, 30.66], [104.07, 30.67]])
  for (let index = 0; index <= fixtures.length; index += 1) {
    await db.run(`INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending)
      VALUES (?, ?, ?, ?, 'other', ?, ?, NULL, '[]', 0)`,
    [`leg-metrics-item-${index}`, tripId, dayId, index, `简单活动 ${index}`, '活动备注与当天备注独立'])
  }
  for (const [index, fixture] of fixtures.entries()) {
    // SQL literals are necessary: libSQL rejects a bound nonfinite number, but SQLite stores 1e999 as REAL infinity.
    const distanceSql = fixture.distance === Infinity ? '1e999' : '?'
    const durationSql = fixture.duration === Infinity ? '1e999' : '?'
    const args: SqlValue[] = [fixture.id, tripId, `leg-metrics-item-${index}`, `leg-metrics-item-${index + 1}`]
    if (fixture.distance !== Infinity) args.push(fixture.distance)
    if (fixture.duration !== Infinity) args.push(fixture.duration)
    args.push(fixture.geometry ? geometry : null, fixture.quality)
    await db.run(`INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline, quality)
      VALUES (?, ?, ?, ?, 'drive', ${distanceSql}, ${durationSql}, ?, ?)`, args)
  }
  // Verify fixture storage before announcing readiness; REAL affinity must not silently erase the cases under test.
  const { rows } = await db.run(`SELECT id, typeof(distance_km) AS distance_type, typeof(duration_min) AS duration_type,
    distance_km, duration_min FROM legs WHERE id IN ('normal', 'null', 'text', 'blob', 'infinity', 'overflow')`)
  const stored = new Map(rows.map((row) => [row.id, row]))
  for (const [id, type] of [['normal', 'real'], ['null', 'null'], ['text', 'text'], ['blob', 'blob'], ['infinity', 'real'], ['overflow', 'real']]) {
    assert.equal(stored.get(id)?.distance_type, type, id + ' distance storage')
    assert.equal(stored.get(id)?.duration_type, type, id + ' duration storage')
  }
  assert.equal(stored.get('infinity')?.distance_km, Infinity)
  assert.equal(stored.get('infinity')?.duration_min, Infinity)
  assert.equal(stored.get('overflow')?.distance_km, 1e308)

  const app = await createApp({ databaseUrl, seedBuiltinTrip: false,
    tripRepository: sqlite.repository, contentRepository: sqlite.contentRepository,
    workbenchStore: createSqliteWorkbenchStore(db), daysAdminStore: createSqliteDaysAdminStore(db),
    toolsStore: createSqliteToolsStore(db), recommendationsStore: createSqliteRecommendationsStore(db),
    messageStore: new SqliteMessageStoreDriver(db),
  })
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  if (!server.listening) await new Promise<void>((done) => server.once('listening', done))
  console.log('READY ' + server.address().port)
} catch (error) {
  console.error(error)
  await stop()
  process.exit(1)
}
