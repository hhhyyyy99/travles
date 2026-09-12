/**
 * Trip list API client tests (ticket 02) — the domain/tripList codec against
 * an injected FetchLike stub, mirroring the StorageLike convention of
 * accommodation-core.test.ts (容错读取、永不 throw).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  TRIPS_NETWORK_ERROR,
  createTrip,
  createTripFromSentence,
  deleteTrip,
  fetchTrips,
  formatDateBadge,
  formatDuration,
  formatTripSchedule,
  previewDaysNights,
  probeTripsApi,
  renameTrip,
  type FetchLike,
  type TripSummary,
} from '../src/domain/tripList'

const tripFixture: TripSummary = {
  id: 'trip-1',
  title: '国庆呼伦贝尔',
  startDate: '2026-10-02',
  endDate: '2026-10-08',
  days: 7,
  nights: 6,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

function stubFetch(respond: (url: string, init?: RequestInit) => { status?: number; body: unknown }): FetchLike {
  return async (url, init) => {
    const { status = 200, body } = respond(url, init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

test('fetchTrips returns the normalized trip list on success', async () => {
  const fetchLike = stubFetch(() => ({ body: { trips: [tripFixture] } }))
  const result = await fetchTrips(fetchLike)
  assert.deepEqual(result, { ok: true, data: [tripFixture] })
})

test('fetchTrips drops corrupt entries instead of throwing', async () => {
  const fetchLike = stubFetch(() => ({
    body: {
      trips: [
        null,
        42,
        { title: '没有 id' },
        { id: '  ' },
        { id: 'trip-2', title: 42, days: '很多' },
        { id: 'trip-3', title: '带空标题', startDate: '2026-10-02', endDate: '2026-10-02' },
      ],
    },
  }))
  const result = await fetchTrips(fetchLike)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(
    result.data.map((trip) => trip.id),
    ['trip-2', 'trip-3'],
  )
  const recovered = result.data.find((trip) => trip.id === 'trip-2')
  assert.deepEqual(recovered && { title: recovered.title, days: recovered.days }, { title: '', days: 0 })
})

test('fetchTrips never throws: network failures and HTTP errors become {ok:false}', async () => {
  const networkBroken: FetchLike = async () => {
    throw new TypeError('fetch failed')
  }
  assert.deepEqual(await fetchTrips(networkBroken), { ok: false, error: TRIPS_NETWORK_ERROR })

  const serverError = stubFetch(() => ({ status: 500, body: { error: '数据库炸了' } }))
  assert.deepEqual(await fetchTrips(serverError), { ok: false, error: '数据库炸了' })

  const noMessage = stubFetch(() => ({ status: 502, body: 'Bad Gateway' }))
  const result = await fetchTrips(noMessage)
  assert.deepEqual(result, { ok: false, error: '请求失败（HTTP 502）' })

  const notJson: FetchLike = async () => new Response('not json', { status: 200 })
  assert.deepEqual(await fetchTrips(notJson), { ok: true, data: [] })
})

test('createTrip POSTs the form payload and surfaces server validation errors', async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = []
  const fetchLike: FetchLike = async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ trip: tripFixture }), { status: 201 })
  }
  const result = await createTrip({ title: '国庆呼伦贝尔', startDate: '2026-10-02', endDate: '2026-10-08' }, fetchLike)
  assert.deepEqual(result, { ok: true, data: tripFixture })
  assert.equal(seen[0]?.url, '/api/trips')
  assert.equal(seen[0]?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), {
    title: '国庆呼伦贝尔',
    startDate: '2026-10-02',
    endDate: '2026-10-08',
  })

  const invalid = stubFetch(() => ({ status: 400, body: { error: '结束日期不能早于开始日期' } }))
  const failed = await createTrip({ title: 'x', startDate: '2026-10-08', endDate: '2026-10-02' }, invalid)
  assert.deepEqual(failed, { ok: false, error: '结束日期不能早于开始日期' })
})

test('createTripFromSentence posts the one-line intake and keeps its draft metadata', async () => {
  const context = {
    destination: '呼伦贝尔',
    durationDays: 7,
    preferences: '我想去呼伦贝尔 7 天，慢节奏，自驾',
    originalSentence: '我想去呼伦贝尔 7 天，慢节奏，自驾',
    dateStatus: 'unspecified' as const,
  }
  const seen: Array<{ url: string; init?: RequestInit }> = []
  const fetchLike: FetchLike = async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({
      trip: { ...tripFixture, title: '呼伦贝尔 · 7日行程', startDate: '', endDate: '', days: 0, nights: 0, durationDays: 7, dateStatus: 'unspecified', planningContext: context },
    }), { status: 201 })
  }
  const result = await createTripFromSentence({ sentence: context.originalSentence }, fetchLike)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.data.planningContext?.durationDays, 7)
  assert.equal(seen[0]?.url, '/api/trips/intake')
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), { sentence: context.originalSentence })
  assert.equal(formatTripSchedule({ startDate: '', endDate: '', days: 0, nights: 0, durationDays: 7, dateStatus: 'unspecified' }), '日期待定 · 7天6晚')
})

test('renameTrip PATCHes the encoded trip id; deleteTrip DELETEs it', async () => {
  const seen: Array<{ url: string; init?: RequestInit }> = []
  const fetchLike: FetchLike = async (url, init) => {
    seen.push({ url, init })
    return new Response(JSON.stringify({ trip: { ...tripFixture, title: '新名字' } }), { status: 200 })
  }
  const renamed = await renameTrip('trip/1 需要转义', '新名字', fetchLike)
  assert.equal(renamed.ok, true)
  if (renamed.ok) assert.equal(renamed.data.title, '新名字')
  assert.equal(seen[0]?.url, '/api/trips/' + encodeURIComponent('trip/1 需要转义'))
  assert.equal(seen[0]?.init?.method, 'PATCH')
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), { title: '新名字' })

  const removed = await deleteTrip('trip-1', stubFetch(() => ({ body: { ok: true } })))
  assert.deepEqual(removed, { ok: true, data: null })
})

test('formatDateBadge renders the "10.02至10.08" style', () => {
  assert.equal(formatDateBadge('2026-10-02', '2026-10-08'), '10.02至10.08')
  assert.equal(formatDateBadge('2026-12-30', '2027-01-02'), '2026.12.30至2027.01.02', 'cross-year keeps years')
  assert.equal(formatDateBadge('2026-10-02', ''), '2026.10.02')
  assert.equal(formatDateBadge('', ''), '')
})

test('formatDuration renders "7天6晚" and "1天"', () => {
  assert.equal(formatDuration(7, 6), '7天6晚')
  assert.equal(formatDuration(1, 0), '1天')
  assert.equal(formatDuration(0, 0), '')
  assert.equal(formatDuration(Number.NaN, Number.NaN), '')
})

test('previewDaysNights mirrors the server computation', () => {
  assert.deepEqual(previewDaysNights('2026-10-02', '2026-10-08'), { days: 7, nights: 6 })
  assert.deepEqual(previewDaysNights('2026-10-02', '2026-10-02'), { days: 1, nights: 0 })
  assert.deepEqual(previewDaysNights('2026-10-08', '2026-10-02'), { days: 0, nights: 0 })
  assert.deepEqual(previewDaysNights('2026-02-30', '2026-10-08'), { days: 0, nights: 0 })
  assert.deepEqual(previewDaysNights('', ''), { days: 0, nights: 0 })
})

test('probeTripsApi accepts only a reachable trips endpoint', async () => {
  const ok = stubFetch(() => ({ body: { trips: [] } }))
  assert.equal(await probeTripsApi(ok), true)

  const wrongShape = stubFetch(() => ({ body: { nope: true } }))
  assert.equal(await probeTripsApi(wrongShape), false)

  const httpError = stubFetch(() => ({ status: 500, body: {} }))
  assert.equal(await probeTripsApi(httpError), false)

  const broken: FetchLike = async () => {
    throw new TypeError('fetch failed')
  }
  assert.equal(await probeTripsApi(broken), false)

  const hanging: FetchLike = (_url, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  assert.equal(await probeTripsApi(hanging, 20), false, 'a hanging backend times out into "unreachable"')
})
