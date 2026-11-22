import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { LegSchema, type Leg } from '@hailar/domain'
import { createApp } from '../server/src/app.js'
import { createSqliteDatabase } from '../server/src/db/driver.js'
import { ensureSchema } from '../server/src/db/schema.js'
import { SqliteTripStoreDriver } from '../server/src/trips/driver-sqlite.js'
import { TripRepository } from '../server/src/trips/repository.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { createSqliteItemsAdminStore } from '../server/src/items-admin/driver-sqlite.js'
import { createSqliteDaysAdminStore } from '../server/src/days-admin/driver-sqlite.js'
import { mapLegRow } from '../server/src/days/repository.js'
import { recomputeTripLegs } from '../server/src/items-admin/legs.js'
import {
  refreshTripLegs,
  parseAmapRoute,
  pendingRoute,
} from '../server/src/recommendations/route.js'
import { applyTripPatch } from '../server/src/trip-patch/apply.js'
import { createSqliteTripPatchStore } from '../server/src/trip-patch/store-sqlite.js'
import { TripEventHub } from '../server/src/trip-events/hub.js'
import { synchronizeTripSchedule } from '../server/src/trip-events/schedule.js'
import { fetchTripCanvas, refreshWorkbenchLegs } from '../src/domain/workbench'
import type { FetchLike } from '../src/domain/tripList'
import type { LegRow } from '../server/src/days/types.js'
import type { RouteLegSearch } from '../server/src/recommendations/types.js'

const fields = [
  'distanceMeters',
  'durationSeconds',
  'formattedDistance',
  'formattedDuration',
] as const
function metrics(leg: Leg) {
  return Object.fromEntries(
    fields.filter((key) => Object.hasOwn(leg, key)).map((key) => [key, leg[key]]),
  )
}
function raw(distance: unknown, duration: unknown, quality: unknown = 'measured'): LegRow {
  return {
    id: 'leg-a-b',
    trip_id: 'trip',
    from_item_id: 'a',
    to_item_id: 'b',
    mode: 'drive',
    distance_km: distance,
    duration_min: duration,
    quality,
    polyline: null,
  }
}
function expected(distance: number, duration: number) {
  return {
    distanceMeters: distance * 1000,
    durationSeconds: duration * 60,
    formattedDistance: `${String(distance)} 千米`,
    formattedDuration: `${String(duration)} 分钟`,
  }
}

async function fixture(
  t: TestContext,
  routeLegs: RouteLegSearch = async () => ({
    status: 'ok',
    source: 'amap',
    distanceKm: 1.25,
    durationMin: 2.5,
    polyline: null,
  }),
) {
  const db = createSqliteDatabase(':memory:')
  t.after(() => db.close())
  await ensureSchema(db)
  await db.run(
    "INSERT INTO trips (id, title, start_date, end_date, planning_context, cover_image, is_pinned, status, created_at, updated_at) VALUES ('trip', '行程', '2026-10-02', '2026-10-03', ?, '/cover.jpg', 0, '原状态', 'created', 'updated')",
    [
      JSON.stringify({
        destination: '成都',
        durationDays: 7,
        preferences: '慢节奏',
        originalSentence: '成都旅行',
        dateStatus: 'confirmed',
      }),
    ],
  )
  await db.run(
    "INSERT INTO days (id, trip_id, idx, date, theme, color, title, note) VALUES ('day', 'trip', 0, '2026-10-02', '主题', '', '独立名称', '整日备注')",
  )
  const poi = (name: string, lat: number) =>
    JSON.stringify({
      name,
      lat,
      lng: 104.06,
      amapId: '',
      category: '',
      rating: 0,
      introSummary: '',
    })
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    await db.run(
      'INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, 'trip', 'day', index, 'attraction', id, '活动备注', poi(id, 30.6 + index * 0.1), 0],
    )
  }
  const items = createSqliteItemsAdminStore(db)
  const patchStore = createSqliteTripPatchStore(db)
  const events = new TripEventHub()
  const repository = new TripRepository(new SqliteTripStoreDriver(db))
  const app = await createApp({
    tripRepository: repository,
    workbenchStore: createSqliteWorkbenchStore(db),
    itemsAdminStore: items,
    daysAdminStore: createSqliteDaysAdminStore(db),
    tripPatchStore: patchStore,
    tripEvents: events,
    routeLegs,
  })
  const fetchLike: FetchLike = (url, init) => app.request(url, init)
  async function read() {
    const response = await app.request('/api/trips/trip/canvas')
    assert.equal(response.status, 200)
    const wire = await response.json()
    const result = await fetchTripCanvas('trip', fetchLike)
    assert.ok(result.ok)
    assert.deepEqual(result.data, wire)
    return result.data
  }
  async function write(
    distance: number | string | Uint8Array | null,
    duration: number | string | Uint8Array | null,
    quality: string | null = 'measured',
  ) {
    await db.run(
      "INSERT OR REPLACE INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline, quality) VALUES ('leg-a-b', 'trip', 'a', 'b', 'drive', ?, ?, NULL, ?)",
      [distance === Infinity ? null : distance, duration, quality],
    )
    // libSQL refuses nonfinite bind arguments; SQLite can hold this REAL literal.
    if (distance === Infinity)
      await db.run("UPDATE legs SET distance_km = 1e999 WHERE id = 'leg-a-b'")
  }
  async function snapshot() {
    return Promise.all(
      ['trips', 'days', 'items', 'legs'].map(
        async (table) => (await db.run(`SELECT * FROM ${table} ORDER BY id`)).rows,
      ),
    )
  }
  return { db, app, items, patchStore, repository, events, fetchLike, read, write, snapshot }
}

void test('shared Leg fields are optional, strict, finite and nonnegative without integer or magnitude caps', () => {
  const old = {
    id: 'l',
    fromItemId: 'a',
    toItemId: 'b',
    mode: 'drive',
    distanceKm: 1,
    durationMin: 2,
    polyline: null,
  }
  assert.deepEqual(LegSchema.parse(old), old)
  for (const field of ['distanceMeters', 'durationSeconds']) {
    for (const value of [0, 0.25, Number.MAX_VALUE])
      assert.equal(LegSchema.safeParse({ ...old, [field]: value }).success, true)
    for (const value of [null, '0', true, -1, NaN, Infinity, -Infinity])
      assert.equal(LegSchema.safeParse({ ...old, [field]: value }).success, false)
  }
  for (const field of ['formattedDistance', 'formattedDuration']) {
    assert.equal(LegSchema.safeParse({ ...old, [field]: '' }).success, true)
    assert.equal(LegSchema.safeParse({ ...old, [field]: 123 }).success, false)
  }
})

void test('raw mapping independently rejects coercions, overflow and empty placeholders while keeping legacy decoding', () => {
  for (const invalid of [
    undefined,
    null,
    '',
    '12.5',
    true,
    false,
    [],
    {},
    new Uint8Array([1]),
    -1,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_VALUE,
  ]) {
    const distance = mapLegRow(raw(invalid, 0.25))!
    assert.deepEqual(metrics(distance), { durationSeconds: 15, formattedDuration: '0.25 分钟' })
    const duration = mapLegRow(raw(0.25, invalid))!
    assert.deepEqual(metrics(duration), { distanceMeters: 250, formattedDistance: '0.25 千米' })
  }
  assert.equal(mapLegRow(raw('12.5', null))!.distanceKm, 12.5, 'old tolerant coercion remains')
  assert.equal(
    mapLegRow(raw(-1, null))!.distanceKm,
    -1,
    'legacy negative decoding is outside this increment',
  )
  for (const quality of ['pending', undefined, null, 'unknown'])
    assert.deepEqual(metrics(mapLegRow({ ...raw(0, 0), quality })!), {})
  for (const quality of ['measured', 'estimate', 'reference'])
    assert.deepEqual(metrics(mapLegRow(raw(0, 0, quality))!), expected(0, 0))
  assert.deepEqual(metrics(mapLegRow(raw(0, 0.125, 'pending'))!), expected(0, 0.125))
  for (const value of [0.123456789, 1e-8, 1e20, 1e300])
    assert.deepEqual(metrics(mapLegRow(raw(value, value))!), expected(value, value))
})

void test('SQLite → Hono → actual client retains valid projections without mutating rows or dropping corrupt legs/items', async (t) => {
  const f = await fixture(t)
  const cases: Array<
    [
      number | string | Uint8Array | null,
      number | string | Uint8Array | null,
      string | null,
      Record<string, unknown>,
    ]
  > = [
    [12.345, 0.125, 'reference', expected(12.345, 0.125)],
    [0, 0, 'measured', expected(0, 0)],
    [0, 0, 'pending', {}],
    [0, 0, null, {}],
    [null, null, null, {}],
    ['bad', 2, 'estimate', { durationSeconds: 120, formattedDuration: '2 分钟' }],
    [
      new Uint8Array([49, 50]),
      0.25,
      'reference',
      { durationSeconds: 15, formattedDuration: '0.25 分钟' },
    ],
    [-1, 0, 'measured', { durationSeconds: 0, formattedDuration: '0 分钟' }],
    [Infinity, 2, 'measured', { durationSeconds: 120, formattedDuration: '2 分钟' }],
    [Number.MAX_VALUE, 2, 'measured', { durationSeconds: 120, formattedDuration: '2 分钟' }],
    [1.5, Number.MAX_VALUE, 'measured', { distanceMeters: 1500, formattedDistance: '1.5 千米' }],
  ]
  for (const [distance, duration, quality, projection] of cases) {
    await f.write(distance, duration, quality)
    const before = await f.snapshot()
    const canvas = await f.read()
    assert.equal(canvas.legs.length, 1)
    assert.deepEqual(metrics(canvas.legs[0]!), projection)
    assert.deepEqual(
      canvas.days[0]!.items.map((item) => [item.id, item.dayId, item.order]),
      [
        ['a', 'day', 0],
        ['b', 'day', 1],
        ['c', 'day', 2],
      ],
    )
    assert.deepEqual(
      [
        canvas.days[0]!.tripId,
        canvas.days[0]!.dayNumber,
        canvas.days[0]!.title,
        canvas.days[0]!.note,
      ],
      ['trip', 1, '独立名称', '整日备注'],
    )
    assert.deepEqual(
      [
        canvas.trip.destination,
        canvas.trip.daysCount,
        canvas.trip.coverImage,
        canvas.trip.isPinned,
        canvas.trip.status,
      ],
      ['成都', 2, '/cover.jpg', false, '原状态'],
    )
    assert.deepEqual(await f.snapshot(), before)
  }
})

void test('client optional fields fail independently and old servers never acquire inferred projections', async () => {
  const old = {
    id: 'l',
    fromItemId: 'a',
    toItemId: 'b',
    mode: 'drive',
    distanceKm: '12.5',
    durationMin: null,
    polyline: null,
  }
  async function decode(leg: unknown) {
    const result = await fetchTripCanvas(
      'trip',
      async () =>
        new Response(
          JSON.stringify({
            trip: { id: 'trip', title: '旧行程', startDate: '', endDate: '', days: 1, nights: 0 },
            days: [],
            legs: [leg],
          }),
        ),
    )
    assert.ok(result.ok)
    return result.data.legs[0]!
  }
  assert.deepEqual(metrics(await decode(old)), {})
  for (const invalid of [null, '5', false, -1, NaN, Infinity, {}]) {
    const leg = await decode({
      ...old,
      distanceMeters: invalid,
      durationSeconds: 0.25,
      formattedDistance: 3,
      formattedDuration: '',
    })
    assert.deepEqual(metrics(leg), { durationSeconds: 0.25, formattedDuration: '' })
    assert.equal(leg.distanceKm, 12.5)
    assert.deepEqual(
      metrics(
        await decode({
          ...old,
          distanceMeters: 0.25,
          durationSeconds: invalid,
          formattedDistance: '',
          formattedDuration: 3,
        }),
      ),
      { distanceMeters: 0.25, formattedDistance: '' },
    )
  }
  assert.deepEqual(
    metrics(
      await decode({
        ...old,
        distanceMeters: Number.MAX_VALUE,
        durationSeconds: 0,
        formattedDistance: '服务端明确文本',
        formattedDuration: '0 分钟',
      }),
    ),
    {
      distanceMeters: Number.MAX_VALUE,
      durationSeconds: 0,
      formattedDistance: '服务端明确文本',
      formattedDuration: '0 分钟',
    },
  )
})

void test('create/move/copy/delete immediate legs and later canvas use identical projections for valid sources', async (t) => {
  const f = await fixture(t)
  await f.write(12.345, 0.25, 'reference')
  const commands = [
    ['/items', 'POST', { dayId: 'day', title: '追加', type: 'other' }],
    ['/items/c/move', 'POST', { dayId: 'day', index: 2 }],
    ['/items/c/copy', 'POST', { dayId: 'day' }],
    ['/items/c', 'DELETE', undefined],
  ] as const
  for (const [path, method, body] of commands) {
    const response = await f.app.request('/api/trips/trip' + path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.ok(response.ok)
    const immediate = (await response.json()) as { legs: Leg[] }
    const canvas = await f.read()
    assert.deepEqual(
      [...immediate.legs].sort((a, b) => a.id.localeCompare(b.id)),
      [...canvas.legs].sort((a, b) => a.id.localeCompare(b.id)),
    )
    assert.deepEqual(
      metrics(immediate.legs.find((leg) => leg.id === 'leg-a-b')!),
      expected(12.345, 0.25),
    )
    for (const leg of immediate.legs.filter((leg) => leg.quality === 'pending'))
      assert.deepEqual(metrics(leg), {})
  }
})

void test('recompute and pending route reuse preserve absence instead of projecting decoder fallback zeros', async (t) => {
  const f = await fixture(t)
  await f.write(null, 2, 'reference')
  const canvas = await f.read()
  const rebuilt = recomputeTripLegs(canvas.days[0]!.items, canvas.legs)
  assert.deepEqual(metrics(rebuilt[0]!), { durationSeconds: 120, formattedDuration: '2 分钟' })
  const refreshed = await refreshTripLegs(f.items, 'trip', async () => pendingRoute('unavailable'))
  assert.ok(refreshed.ok)
  assert.deepEqual(metrics(refreshed.legs[0]!), {
    durationSeconds: 120,
    formattedDuration: '2 分钟',
  })
  // Legacy serialization can already turn NULL into zero. This increment does
  // not add a storage provenance protocol or claim to undo that history.
})

void test('route refresh, patch and schedule/event refetch preserve the aliases and original units/quality', async (t) => {
  const f = await fixture(t)
  const refreshed = await refreshWorkbenchLegs('trip', f.fetchLike)
  assert.ok(refreshed.ok)
  assert.deepEqual(metrics(refreshed.data.legs[0]!), expected(1.25, 2.5))
  assert.deepEqual(refreshed.data.legs, (await f.read()).legs)
  const observed: Array<ReturnType<typeof f.read>> = []
  void t.after(f.events.subscribe('trip', () => observed.push(f.read())))
  const changed = await f.app.request('/api/trips/trip/items/a', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note: '新活动备注' }),
  })
  assert.equal(changed.status, 200)
  assert.deepEqual(metrics((await observed.at(-1)!).legs[0]!), expected(1.25, 2.5))
  const patched = await applyTripPatch(f.patchStore, 'trip', {
    ops: [{ op: 'update_day', dayId: 'day', theme: '新主题' }],
  })
  assert.ok(patched.ok)
  await synchronizeTripSchedule(f.repository, f.patchStore, 'trip')
  const final = await f.read()
  assert.deepEqual(metrics(final.legs[0]!), expected(1.25, 2.5))
  assert.deepEqual(
    [final.legs[0]!.distanceKm, final.legs[0]!.durationMin, final.legs[0]!.quality],
    [1.25, 2.5, 'measured'],
  )
  assert.deepEqual([final.days[0]!.title, final.days[0]!.note], ['独立名称', '整日备注'])
})

void test('current nullable provider metrics stay absent through HTTP/client refresh, cache hits and immediate reuse', async (t) => {
  const cases: Array<[number | null, number | null, Record<string, unknown>]> = [
    [null, 5, { durationSeconds: 300, formattedDuration: '5 分钟' }],
    [2.5, null, { distanceMeters: 2500, formattedDistance: '2.5 千米' }],
    [null, null, {}],
    [0, 5, expected(0, 5)],
    [2.5, 0, expected(2.5, 0)],
    [0, 0, expected(0, 0)],
    [null, 0, { durationSeconds: 0, formattedDuration: '0 分钟' }],
    [0, null, { distanceMeters: 0, formattedDistance: '0 千米' }],
  ]
  for (const [distanceKm, durationMin, projection] of cases) {
    await t.test(`${distanceKm} km / ${durationMin} min`, async (t) => {
      let calls = 0
      const f = await fixture(t, async () => {
        calls += 1
        return { status: 'ok', source: 'amap', distanceKm, durationMin, polyline: null }
      })
      const items = (await f.read()).days[0]!.items
      const response = await f.app.request('/api/trips/trip/legs/refresh', { method: 'POST' })
      assert.equal(response.status, 200)
      const immediate = (await response.json()) as { legs: Leg[]; summary: unknown }
      assert.equal(immediate.legs.length, 2)
      assert.equal(calls, 2)
      for (const leg of immediate.legs) {
        assert.deepEqual(metrics(leg), projection)
        assert.deepEqual(
          [leg.distanceKm, leg.durationMin, leg.quality],
          [distanceKm ?? 0, durationMin ?? 0, 'measured'],
          'legacy metric/quality behavior stays compatible',
        )
      }
      const reused = recomputeTripLegs(items, immediate.legs)
      assert.deepEqual(
        reused,
        immediate.legs,
        'immediate same-pair reuse preserves the supplied projection and its absence',
      )
      const cached = await refreshWorkbenchLegs('trip', f.fetchLike)
      assert.ok(cached.ok)
      assert.equal(calls, 2, 'the shared route cache serves the second HTTP refresh')
      assert.deepEqual(
        cached.data,
        immediate,
        'cache normalization and the actual client retain the original per-metric source validity',
      )
      // Subsequent canvas reads may reflect the existing write protocol's zero
      // values. They cannot recover provider NULLs; that is outside this fix.
    })
  }
})

void test('AMap precision remains the existing rounded km/min precision before projection', () => {
  const route = parseAmapRoute({
    status: '1',
    route: { paths: [{ distance: '12345', duration: '125', steps: [] }] },
  })
  assert.equal(route.status, 'ok')
  assert.deepEqual([route.distanceKm, route.durationMin], [12.3, 2])
  assert.deepEqual(metrics(mapLegRow(raw(route.distanceKm, route.durationMin))!), expected(12.3, 2))
})
