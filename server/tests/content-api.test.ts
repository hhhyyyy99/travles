/**
 * Content HTTP + repository tests (ticket 03) — the seeded trip appears in
 * the trip list; GET days / PUT items / PUT checklist behave and are
 * idempotent; corrupt rows are tolerated at the repository seam (spec
 * 测试接缝 #2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../src/app.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import { TripRepository } from '../src/trips/repository.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { seedBuiltinTrip } from '../src/seed/seed.js'
import { BUILTIN_TRIP_ID } from '../src/seed/builtin-trip-data.js'
import { TripContentRepository } from '../src/content/repository.js'
import { MemoryContentStoreDriver } from '../src/content/driver-memory.js'
import type { DayContent } from '../src/content/types.js'

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
}

async function setup(): Promise<{
  app: Awaited<ReturnType<typeof createApp>>
  db: Awaited<ReturnType<typeof createSqliteTripRepository>>['db']
  close(): Promise<void>
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'content-api-'))
  const { repository, contentRepository, db, close } = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
  await seedBuiltinTrip(db)
  const app = await createApp({ tripRepository: repository, contentRepository })
  return { app, db, close, dir }
}

test('the seeded built-in trip appears in the trip list with its date range', async () => {
  const { app, dir, close } = await setup()
  try {
    const res = await app.request('/api/trips')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { trips: Array<{ id: string; title: string; days: number; nights: number }> }
    assert.equal(body.trips.length, 1)
    assert.equal(body.trips[0]?.id, BUILTIN_TRIP_ID)
    assert.equal(body.trips[0]?.days, 7)
    assert.equal(body.trips[0]?.nights, 6)
    assert.match(body.trips[0]?.title ?? '', /呼伦贝尔/)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('GET /api/trips/:id/days returns per-day content consistent with the guide', async () => {
  const { app, dir, close } = await setup()
  try {
    const res = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/days`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { days: DayContent[] }
    assert.equal(body.days.length, 7)
    const day0 = body.days[0]
    assert.equal(day0?.id, 'builtin-day-0')
    assert.equal(day0?.date, '2026-10-02')
    // overview + 3 schedule rows + 1 stay item
    assert.equal(day0?.items.length, 5)
    assert.equal(day0?.items[0]?.itemOrder, 0)
    assert.equal(day0?.items[4]?.type, 'stay')
    // the last day (return) has no stay item
    assert.equal(body.days[6]?.items.some((item) => item.type === 'stay'), false)

    const missing = await app.request('/api/trips/no-such-id/days')
    assert.equal(missing.status, 404)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('PUT /api/trips/:id/items upserts by id — repeated migration triggers never duplicate', async () => {
  const { app, dir, close } = await setup()
  try {
    const daysRes = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/days`)
    const { days } = (await daysRes.json()) as { days: DayContent[] }
    const day0 = days[0]!.id

    const payload = (title: string) => ({
      items: [{ id: 'builtin-stay-day-0', dayId: day0, itemOrder: 100, type: 'stay', title, note: '' }],
    })
    for (const title of ['牧场民宿', '牧场民宿（改）']) {
      const res = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/items`, jsonRequest('PUT', payload(title)))
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { ok: true, upserted: 1 })
    }

    const after = (await (await app.request(`/api/trips/${BUILTIN_TRIP_ID}/days`)).json()) as { days: DayContent[] }
    const day0After = after.days.find((day) => day.id === day0)
    assert.equal(day0After?.items.length, 5, 'still five items — the stay row was updated, not duplicated')
    assert.equal(day0After?.items.find((item) => item.id === 'builtin-stay-day-0')?.title, '牧场民宿（改）')

    // A stay item whose dayId does not belong to the trip is rejected.
    const badDay = await app.request(
      `/api/trips/${BUILTIN_TRIP_ID}/items`,
      jsonRequest('PUT', { items: [{ id: 'x-1', dayId: 'some-other-trips-day', itemOrder: 0, type: 'stay', title: 'x', note: '' }] }),
    )
    assert.equal(badDay.status, 404)

    const notArray = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/items`, jsonRequest('PUT', { items: 'nope' }))
    assert.equal(notArray.status, 400)
    const missingFields = await app.request(
      `/api/trips/${BUILTIN_TRIP_ID}/items`,
      jsonRequest('PUT', { items: [{ dayId: day0, title: 'no id' }] }),
    )
    assert.equal(missingFields.status, 400)
    const missingTrip = await app.request(
      '/api/trips/no-such-id/items',
      jsonRequest('PUT', { items: [{ id: 'x', dayId: day0, itemOrder: 0, type: 'stay', title: 'x', note: '' }] }),
    )
    assert.equal(missingTrip.status, 404)
  } finally {
    await close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('PUT /api/trips/:id/checklist upserts by id and keeps done flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'content-checklist-'))
  try {
    const { repository, contentRepository, db, close } = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
    await seedBuiltinTrip(db)
    const app = await createApp({ tripRepository: repository, contentRepository })

    const entries = [
      { id: 'legacy-checklist-0', content: '确认海拉尔机场同点取还车', done: true },
      { id: 'legacy-checklist-1', content: '订好 6 晚住宿、莫尔道嘎与黑山头问供暖', done: false },
    ]
    for (let round = 0; round < 2; round += 1) {
      const res = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist`, jsonRequest('PUT', { items: entries }))
      assert.equal(res.status, 200)
    }
    const list = await contentRepository.listChecklist(BUILTIN_TRIP_ID)
    assert.equal(list.length, 2, 'no duplicates across repeated triggers')
    assert.deepEqual(
      list.map((entry) => [entry.id, entry.done]),
      [
        ['legacy-checklist-0', true],
        ['legacy-checklist-1', false],
      ],
    )

    const bad = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist`, jsonRequest('PUT', { items: [{ id: 'x' }] }))
    assert.equal(bad.status, 400)
    const notArray = await app.request(`/api/trips/${BUILTIN_TRIP_ID}/checklist`, jsonRequest('PUT', {}))
    assert.equal(notArray.status, 400)
    await close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('restarting over the same database does not reseed (marker gate) and content stays readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'content-restart-'))
  try {
    const first = await createSqliteTripRepository(`file:${join(dir, 'trips.db')}`)
    await seedBuiltinTrip(first.db)
    await first.close()

    // "Restart": a new app attaching to the existing file must not duplicate.
    const app = await createApp({ databaseUrl: `file:${join(dir, 'trips.db')}` })
    const res = await app.request('/api/trips')
    const body = (await res.json()) as { trips: Array<{ id: string }> }
    assert.equal(body.trips.length, 1)
    assert.equal(body.trips[0]?.id, BUILTIN_TRIP_ID)
    const days = (await (await app.request(`/api/trips/${BUILTIN_TRIP_ID}/days`)).json()) as { days: DayContent[] }
    assert.equal(days.days.length, 7)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('content routes without a content repository degrade to an explicit 500', async () => {
  const app = await createApp({ tripRepository: new TripRepository(new MemoryTripStoreDriver()) })
  const res = await app.request(`/api/trips/whatever/days`)
  assert.equal(res.status, 500)
  assert.equal(((await res.json()) as { error: string }).error, '服务器未配置内容存储')
})

test('the content repository tolerates corrupt rows (容错读取)', async () => {
  const driver = new MemoryContentStoreDriver()
  const repo = new TripContentRepository(driver)
  driver.dayRows.set('day-ok', { id: 'day-ok', trip_id: 't1', idx: 2, date: '2026-10-04', theme: '主题', color: null })
  driver.dayRows.set('corrupt', { id: null, trip_id: 't1', idx: 0, date: null, theme: null, color: null })
  driver.itemRows.set('i1', { id: 'i1', trip_id: 't1', day_id: 'day-ok', item_order: 1, type: 'meal', title: '晚饭', note: '俄餐', poi: null, images: null, pending: 0 })
  driver.itemRows.set('orphan', { id: 'orphan', trip_id: 't1', day_id: 'day-gone', item_order: 0, type: 'other', title: '孤儿', note: '', poi: null, images: null, pending: 0 })

  const days = await repo.listDays('t1')
  assert.equal(days.length, 1)
  assert.deepEqual(
    days[0]?.items.map((item) => item.id),
    ['i1'],
  )

  // A throwing driver degrades to empty reads / {ok:false} writes.
  driver.nextWriteError = new Error('boom')
  const write = await repo.upsertItem('t1', { id: 'x', dayId: 'day-ok', itemOrder: 0, type: 'other', title: 'x', note: '' })
  assert.deepEqual({ ok: write.ok, code: write.ok ? null : write.code }, { ok: false, code: 'storage' })

  const invalid = await repo.upsertItem('t1', { dayId: 'day-ok', title: 'no id' })
  assert.equal(invalid.ok, false)
  const unknownDay = await repo.upsertItem('t1', { id: 'x', dayId: 'no-day', itemOrder: 0, type: 'other', title: 'x', note: '' })
  assert.deepEqual({ ok: unknownDay.ok, code: unknownDay.ok ? null : unknownDay.code }, { ok: false, code: 'not_found' })
})
