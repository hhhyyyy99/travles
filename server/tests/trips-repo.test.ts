/**
 * Trip repository unit tests (ticket 02, spec 测试接缝 #2).
 *
 * The repository runs against the injected in-memory driver — the same
 * convention as the src/domain/storage.ts codec tests (容错读取、永不
 * throw): corrupt rows degrade instead of throwing, writes report
 * {ok:false} instead of throwing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository, mapRowToSummary } from '../src/trips/repository.js'
import { computeDaysNights, isValidDateString } from '../src/trips/dates.js'

function setup(): { repo: TripRepository; driver: MemoryTripStoreDriver } {
  const driver = new MemoryTripStoreDriver()
  return { repo: new TripRepository(driver), driver }
}

test('create computes inclusive days and nights from the date range', async () => {
  const { repo } = setup()
  const result = await repo.create({ title: '国庆呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-08' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.trip.days, 7)
  assert.equal(result.trip.nights, 6)
  assert.equal(result.trip.title, '国庆呼伦贝尔')
  assert.match(result.trip.id, /^[0-9a-f-]{36}$/)
  assert.ok(result.trip.createdAt.length > 0)
})

test('create trims the title and rejects blank/foreign titles', async () => {
  const { repo } = setup()
  const trimmed = await repo.create({ title: '  草原之行  ', startDate: '2026-10-02', endDate: '2026-10-03' })
  assert.equal(trimmed.ok, true)
  if (trimmed.ok) assert.equal(trimmed.trip.title, '草原之行')

  for (const title of ['', '   ', null, undefined, 42]) {
    const result = await repo.create({ title: title as unknown, startDate: '2026-10-02', endDate: '2026-10-03' })
    assert.deepEqual({ ok: result.ok, error: result.ok ? null : result.error, code: result.ok ? null : result.code }, {
      ok: false,
      error: '行程标题不能为空',
      code: 'invalid',
    })
  }
})

test('create validates both dates and the range order', async () => {
  const { repo } = setup()
  const cases: Array<{ input: Record<string, unknown>; error: string }> = [
    { input: { title: 'x', endDate: '2026-10-08' }, error: '开始日期无效（需要 YYYY-MM-DD）' },
    { input: { title: 'x', startDate: '2026-10-02' }, error: '结束日期无效（需要 YYYY-MM-DD）' },
    { input: { title: 'x', startDate: '2026/10/02', endDate: '2026-10-08' }, error: '开始日期无效（需要 YYYY-MM-DD）' },
    { input: { title: 'x', startDate: '2026-02-30', endDate: '2026-10-08' }, error: '开始日期无效（需要 YYYY-MM-DD）' },
    { input: { title: 'x', startDate: '2026-10-02', endDate: 'not-a-date' }, error: '结束日期无效（需要 YYYY-MM-DD）' },
    { input: { title: 'x', startDate: '2026-10-08', endDate: '2026-10-02' }, error: '结束日期不能早于开始日期' },
  ]
  for (const { input, error } of cases) {
    const result = await repo.create(input)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error, error)
      assert.equal(result.code, 'invalid')
    }
  }
})

test('create accepts a same-day trip (1 day, 0 nights)', async () => {
  const { repo } = setup()
  const result = await repo.create({ title: '当天往返', startDate: '2026-10-02', endDate: '2026-10-02' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.trip.days, 1)
    assert.equal(result.trip.nights, 0)
  }
})

test('createFromIntake preserves the original sentence and allows a date-pending draft to be renamed', async () => {
  const { repo } = setup()
  const created = await repo.createFromIntake({ sentence: '我想去呼伦贝尔 7 天，慢节奏，自驾' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  assert.equal(created.trip.days, 0)
  assert.equal(created.trip.durationDays, 7)
  assert.equal(created.trip.dateStatus, 'unspecified')
  assert.equal(created.trip.planningContext?.originalSentence, '我想去呼伦贝尔 7 天，慢节奏，自驾')

  const renamed = await repo.rename(created.trip.id, '我的呼伦贝尔计划')
  assert.equal(renamed.ok, true)
  if (renamed.ok) {
    assert.equal(renamed.trip.title, '我的呼伦贝尔计划')
    assert.equal(renamed.trip.dateStatus, 'unspecified')
    assert.equal(renamed.trip.planningContext?.durationDays, 7)
  }
})

test('intake accepts natural Chinese duration and strips travel wording from the destination title', async () => {
  const { repo } = setup()
  const result = await repo.createFromIntake({ sentence: '我想去呼伦贝尔玩两天，慢慢走' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.trip.title, '呼伦贝尔 · 2日行程')
  assert.equal(result.trip.planningContext?.durationDays, 2)
  assert.equal(result.trip.planningContext?.destination, '呼伦贝尔')
})

test('list returns created trips oldest-first and never throws', async () => {
  const { repo } = setup()
  assert.deepEqual(await repo.list(), [])
  await repo.create({ title: '第一站', startDate: '2026-10-02', endDate: '2026-10-03' })
  await repo.create({ title: '第二站', startDate: '2026-10-05', endDate: '2026-10-06' })
  const trips = await repo.list()
  assert.equal(trips.length, 2)
  assert.equal(trips[0]?.title, '第一站')
  assert.equal(trips[1]?.title, '第二站')
})

test('rename updates the title, keeps the dates and bumps updatedAt', async () => {
  const { repo } = setup()
  const created = await repo.create({ title: '旧名字', startDate: '2026-10-02', endDate: '2026-10-08' })
  assert.equal(created.ok, true)
  if (!created.ok) return
  const before = created.trip

  const renamed = await repo.rename(before.id, '新名字')
  assert.equal(renamed.ok, true)
  if (renamed.ok) {
    assert.equal(renamed.trip.title, '新名字')
    assert.equal(renamed.trip.startDate, '2026-10-02')
    assert.equal(renamed.trip.endDate, '2026-10-08')
    assert.equal(renamed.trip.days, 7)
    assert.ok(renamed.trip.updatedAt >= before.updatedAt, 'updatedAt advances (monotonic, same-ms renames included)')
  }

  const blank = await repo.rename(before.id, '  ')
  assert.equal(blank.ok, false)
  if (!blank.ok) assert.equal(blank.code, 'invalid')
})

test('update recomputes days/nights when the range changes', async () => {
  const { repo } = setup()
  const created = await repo.create({ title: '短途', startDate: '2026-10-02', endDate: '2026-10-03' })
  if (!created.ok) return
  const updated = await repo.update(created.trip.id, { endDate: '2026-10-08' })
  assert.equal(updated.ok, true)
  if (updated.ok) {
    assert.equal(updated.trip.startDate, '2026-10-02')
    assert.equal(updated.trip.endDate, '2026-10-08')
    assert.equal(updated.trip.days, 7)
    assert.equal(updated.trip.nights, 6)
  }
})

test('mutations on an unknown id report not_found', async () => {
  const { repo } = setup()
  const renamed = await repo.rename('no-such-id', '名字')
  assert.equal(renamed.ok, false)
  if (!renamed.ok) assert.equal(renamed.code, 'not_found')

  const updated = await repo.update('no-such-id', { title: '名字' })
  assert.equal(updated.ok, false)
  if (!updated.ok) assert.equal(updated.code, 'not_found')

  const removed = await repo.remove('no-such-id')
  assert.equal(removed.ok, false)
  if (!removed.ok) assert.equal(removed.code, 'not_found')
})

test('remove deletes the trip; get then returns null', async () => {
  const { repo } = setup()
  const created = await repo.create({ title: '要删的', startDate: '2026-10-02', endDate: '2026-10-04' })
  if (!created.ok) return
  const removed = await repo.remove(created.trip.id)
  assert.deepEqual(removed, { ok: true })
  assert.equal(await repo.get(created.trip.id), null)
})

test('tolerant reads: corrupt rows are dropped from list, never throw', async () => {
  const { repo, driver } = setup()
  driver.rows.set('broken-null-id', { id: null, title: 'x', start_date: null, end_date: null, created_at: null, updated_at: null })
  driver.rows.set('broken-numeric-id', { id: 42, title: 'x', start_date: null, end_date: null, created_at: null, updated_at: null })
  driver.rows.set('broken-empty-id', { id: '  ', title: 'x', start_date: null, end_date: null, created_at: null, updated_at: null })
  driver.rows.set('garbage-dates', { id: 'garbage-dates', title: null, start_date: '10月2号', end_date: 20261008, created_at: null, updated_at: 1760000000000 })
  driver.rows.set('good', { id: 'good', title: '完好行程', start_date: '2026-10-02', end_date: '2026-10-08', created_at: '2026-09-12T00:00:00.000Z', updated_at: '2026-09-12T00:00:00.000Z' })

  const trips = await repo.list()
  assert.deepEqual(
    trips.map((trip) => trip.id),
    ['garbage-dates', 'good'],
  )
  const garbage = trips.find((trip) => trip.id === 'garbage-dates')
  // Tolerant read keeps the raw strings (no data invented, none destroyed) —
  // unusable dates simply compute to 0 days.
  assert.deepEqual(
    garbage && { title: garbage.title, startDate: garbage.startDate, endDate: garbage.endDate, days: garbage.days, nights: garbage.nights },
    { title: '', startDate: '10月2号', endDate: '', days: 0, nights: 0 },
  )
  assert.equal(garbage?.updatedAt, new Date(1760000000000).toISOString(), 'epoch-number timestamps are coerced')

  const good = await repo.get('good')
  assert.equal(good?.title, '完好行程')
  assert.equal(good?.days, 7)
})

test('tolerant reads: a throwing driver degrades to empty results', async () => {
  const driver = new MemoryTripStoreDriver()
  driver.listTripRows = async () => {
    throw new Error('storage exploded')
  }
  driver.getTripRow = async () => {
    throw new Error('storage exploded')
  }
  const repo = new TripRepository(driver)
  assert.deepEqual(await repo.list(), [])
  assert.equal(await repo.get('whatever'), null)
})

test('write failures surface as {ok:false, code:storage} instead of throwing', async () => {
  const { repo, driver } = setup()
  driver.nextWriteError = new Error('disk on fire')
  const created = await repo.create({ title: '保存不进去', startDate: '2026-10-02', endDate: '2026-10-08' })
  assert.deepEqual(created, { ok: false, error: '保存失败', code: 'storage' })

  driver.nextWriteError = new Error('disk on fire')
  const removed = await repo.remove('whatever')
  assert.deepEqual(removed, { ok: false, error: '删除失败', code: 'storage' })
})

test('computeDaysNights and isValidDateString edge cases', () => {
  assert.deepEqual(computeDaysNights('2026-10-02', '2026-10-08'), { days: 7, nights: 6 })
  assert.deepEqual(computeDaysNights('2026-12-31', '2027-01-01'), { days: 2, nights: 1 })
  assert.deepEqual(computeDaysNights('2026-10-08', '2026-10-02'), { days: 0, nights: 0 })
  assert.deepEqual(computeDaysNights('', '2026-10-08'), { days: 0, nights: 0 })
  assert.equal(isValidDateString('2026-02-29'), false, '2026 is not a leap year')
  assert.equal(isValidDateString('2028-02-29'), true)
})

test('mapRowToSummary drops rows without a usable id', () => {
  assert.equal(mapRowToSummary({ id: '', title: 'x', start_date: '', end_date: '', created_at: '', updated_at: '' }), null)
  assert.equal(mapRowToSummary(undefined as unknown as Parameters<typeof mapRowToSummary>[0]), null)
})
