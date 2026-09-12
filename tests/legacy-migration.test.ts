/**
 * Legacy localStorage → server migration tests (ticket 03).
 *
 * The migration runs against an injected StorageLike (in-memory mock, same
 * convention as accommodation-core.test.ts) and a recording FetchLike stub.
 * Covered: happy path (checklist + stays → fixed-id upserts), idempotency
 * (marker + no duplicate triggers), corrupt-JSON degradation, and every
 * failure mode leaving the marker untouched so the next entry retries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUILTIN_TRIP_ID,
  LEGACY_SERVER_MIGRATION_MARKER_KEY,
  SERVER_MIGRATION_MARKER_KEY,
  migrateLegacyDataToServer,
  migratedChecklistItemId,
  migratedStayItemId,
} from '../src/domain/migration'
import { ACCOMMODATION_STORAGE_KEY } from '../src/domain/storage'
import { CHECKLIST_STORAGE_KEY } from '../src/domain/checklist'
import type { StorageLike } from '../src/domain/storage'
import type { FetchLike } from '../src/domain/tripList'

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>()
  /** When set, every access throws (storage refused). */
  throwOnAccess = false
  get accessCount(): number {
    return this.accesses
  }
  private accesses = 0

  getItem(key: string): string | null {
    this.accesses += 1
    if (this.throwOnAccess) throw new Error('storage denied')
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.accesses += 1
    if (this.throwOnAccess) throw new Error('storage denied')
    this.map.set(key, value)
  }

  peek(key: string): string | null {
    return this.map.get(key) ?? null
  }
}

const BUILTIN_TRIP_FIXTURE = {
  id: BUILTIN_TRIP_ID,
  title: '呼伦贝尔慢环线 · 示例行程',
  startDate: '2026-10-02',
  endDate: '2026-10-08',
  days: 7,
  nights: 6,
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
}

const DAYS_FIXTURE = {
  days: [0, 1, 2, 3, 4, 5, 6].map((idx) => ({ id: `builtin-day-${idx}`, idx, date: `2026-10-0${idx + 2}`, theme: `第${idx + 1}天`, color: '' })),
}

interface RecordedCall {
  url: string
  init?: RequestInit
}

/** Recording stub: routes guide-API calls; `failUrl` makes matching calls fail. */
function recordingFetch(options: { trips?: unknown[]; days?: unknown; failUrls?: string[]; throwOnAll?: boolean } = {}): {
  fetchLike: FetchLike
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchLike: FetchLike = async (url, init) => {
    calls.push({ url, init })
    if (options.throwOnAll) throw new Error('network down')
    if (options.failUrls?.some((fragment) => url.includes(fragment))) {
      return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
    }
    if (url === '/api/trips') {
      return new Response(JSON.stringify({ trips: options.trips ?? [BUILTIN_TRIP_FIXTURE] }), { status: 200 })
    }
    if (url === `/api/trips/${BUILTIN_TRIP_ID}/days`) {
      return new Response(JSON.stringify(options.days ?? DAYS_FIXTURE), { status: 200 })
    }
    return new Response(JSON.stringify({ ok: true, upserted: 1 }), { status: 200 })
  }
  return { fetchLike, calls }
}

const putCalls = (calls: RecordedCall[]) => calls.filter((call) => call.init?.method === 'PUT')
const putBody = (call: RecordedCall) => JSON.parse(String(call.init?.body)) as Record<string, unknown>

/** A legacy profile: default stays plus a custom override on day 1, checklist 0+2 checked. */
function seedLegacyData(storage: MemoryStorage): void {
  storage.setItem(
    ACCOMMODATION_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      bases: [{ id: 'custom-1', name: '牧场民宿', type: 'hotel', lat: 50.24, lng: 120.18, address: '额尔古纳牧场', notes: '', createdAt: '2025-10-01T00:00:00.000Z' }],
      stays: { 1: 'custom-1' },
    }),
  )
  storage.setItem(CHECKLIST_STORAGE_KEY, JSON.stringify([0, 2]))
}

test('migrates checklist and accommodation stays into the built-in trip, then marks done', async () => {
  const storage = new MemoryStorage()
  seedLegacyData(storage)
  const { fetchLike, calls } = recordingFetch()

  const result = await migrateLegacyDataToServer({ storage, fetchLike })
  assert.equal(result.status, 'migrated')
  assert.equal(result.tripId, BUILTIN_TRIP_ID)
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), 'done')

  // Stays: one upsert per overnight day (0–5), fixed ids, resolved base names.
  const itemsCall = putCalls(calls).find((call) => call.url.endsWith('/items'))
  assert.ok(itemsCall, 'a PUT /items call happened')
  const items = putBody(itemsCall).items as Array<Record<string, unknown>>
  assert.equal(items.length, 6)
  assert.deepEqual(
    items.map((item) => item.id),
    [0, 1, 2, 3, 4, 5].map(migratedStayItemId),
  )
  assert.equal(items[1]?.title, '牧场民宿', 'the day-1 override resolves to the custom base name')
  assert.equal(items[1]?.type, 'stay')
  assert.equal(items[0]?.title, '海拉尔', 'unoverridden nights migrate the default base')
  assert.deepEqual(items[1]?.poi, {
    amapId: 'legacy-accommodation:custom-1',
    name: '牧场民宿',
    lat: 50.24,
    lng: 120.18,
    address: '额尔古纳牧场',
    accommodationBaseId: 'custom-1',
    accommodationType: 'hotel',
    accommodationMigrationVersion: 2,
    category: '酒店 / 民宿',
    rating: 0,
    introSummary: '',
  }, 'custom base coordinates/type and its per-night id are retained')
  assert.ok(items.every((item) => item.dayId === `builtin-day-${items.indexOf(item)}`))

  // Checklist: all six guide items with done flags.
  const checklistCall = putCalls(calls).find((call) => call.url.endsWith('/checklist'))
  assert.ok(checklistCall, 'a PUT /checklist call happened')
  const checklist = putBody(checklistCall).items as Array<Record<string, unknown>>
  assert.equal(checklist.length, 6)
  assert.equal(checklist[0]?.id, migratedChecklistItemId(0))
  assert.deepEqual(
    checklist.map((item) => item.done),
    [true, false, true, false, false, false],
  )
})

test('versioned migration upgrades an old marker with rich POI metadata without overwriting stay edits', async () => {
  const storage = new MemoryStorage()
  seedLegacyData(storage)
  storage.setItem(LEGACY_SERVER_MIGRATION_MARKER_KEY, 'done')
  const days = {
    days: [0, 1, 2, 3, 4, 5, 6].map((idx) => ({
      id: `builtin-day-${idx}`,
      idx,
      date: `2026-10-0${idx + 2}`,
      theme: `第${idx + 1}天`,
      color: '',
      items: idx < 2 ? [{
        id: migratedStayItemId(idx),
        title: idx === 1 ? '用户编辑的住宿' : `海拉尔 · 第 ${idx + 1} 晚`,
        note: idx === 1 ? '用户自己的备注' : '',
        ...(idx === 1 ? { poi: { name: '用户选的住宿', lat: 50.3, lng: 120.4, address: '用户更新的地址' } } : {}),
      }] : [],
    })),
  }
  const { fetchLike, calls } = recordingFetch({ days })

  const result = await migrateLegacyDataToServer({ storage, fetchLike })
  assert.equal(result.status, 'migrated')
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), 'done')
  const itemsCall = putCalls(calls).find((call) => call.url.endsWith('/items'))
  assert.ok(itemsCall)
  const items = putBody(itemsCall).items as Array<Record<string, unknown>>
  assert.equal(items.length, 2, 'an old completed migration does not resurrect user-deleted stay cards')
  const edited = items.find((item) => item.id === migratedStayItemId(1))
  assert.equal(edited?.title, '用户编辑的住宿')
  assert.equal(edited?.note, '用户自己的备注')
  assert.deepEqual(edited?.poi, { name: '用户选的住宿', lat: 50.3, lng: 120.4, address: '用户更新的地址' })
  assert.equal(putCalls(calls).filter((call) => call.url.endsWith('/checklist')).length, 0, 'an old completed migration does not overwrite checklist edits')
})

test('is idempotent: the marker short-circuits repeated triggers', async () => {
  const storage = new MemoryStorage()
  seedLegacyData(storage)
  const first = recordingFetch()
  assert.equal((await migrateLegacyDataToServer({ storage, fetchLike: first.fetchLike })).status, 'migrated')

  const second = recordingFetch()
  const again = await migrateLegacyDataToServer({ storage, fetchLike: second.fetchLike })
  assert.equal(again.status, 'already-migrated')
  assert.equal(second.calls.length, 0, 'no server calls on a repeat visit')
})

test('a browser without legacy data is marked done without touching the server', async () => {
  const storage = new MemoryStorage()
  const { fetchLike, calls } = recordingFetch()
  const result = await migrateLegacyDataToServer({ storage, fetchLike })
  assert.equal(result.status, 'no-legacy-data')
  assert.equal(calls.length, 0)
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), 'done')
})

test('corrupt JSON degrades to no-legacy-data instead of throwing', async () => {
  const storage = new MemoryStorage()
  storage.setItem(ACCOMMODATION_STORAGE_KEY, '{not valid json')
  storage.setItem(CHECKLIST_STORAGE_KEY, ']]corrupt[[')
  const { fetchLike, calls } = recordingFetch()
  const result = await migrateLegacyDataToServer({ storage, fetchLike })
  assert.equal(result.status, 'no-legacy-data', 'the codecs degrade corrupt profiles to defaults')
  assert.equal(calls.length, 0)
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), 'done')

  // A throwing storage also degrades (marker unreadable → retry later).
  const denied = new MemoryStorage()
  denied.throwOnAccess = true
  const deniedFetch = recordingFetch()
  const deniedResult = await migrateLegacyDataToServer({ storage: denied, fetchLike: deniedFetch.fetchLike })
  assert.equal(deniedResult.status, 'no-legacy-data')
  assert.equal(deniedFetch.calls.length, 0)
})

test('a missing built-in trip reports trip-missing and retries on the next entry', async () => {
  const storage = new MemoryStorage()
  seedLegacyData(storage)
  const withoutTrip = recordingFetch({ trips: [] })
  const result = await migrateLegacyDataToServer({ storage, fetchLike: withoutTrip.fetchLike })
  assert.equal(result.status, 'trip-missing')
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), null, 'no marker — next visit retries')

  const withTrip = recordingFetch()
  const retried = await migrateLegacyDataToServer({ storage, fetchLike: withTrip.fetchLike })
  assert.equal(retried.status, 'migrated')
})

test('server failures leave the marker untouched so the migration retries', async () => {
  const storage = new MemoryStorage()
  seedLegacyData(storage)

  const unreachable = recordingFetch({ throwOnAll: true })
  assert.equal((await migrateLegacyDataToServer({ storage, fetchLike: unreachable.fetchLike })).status, 'failed')
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), null)

  const listFails = recordingFetch({ failUrls: ['/api/trips'] })
  assert.equal((await migrateLegacyDataToServer({ storage, fetchLike: listFails.fetchLike })).status, 'failed')

  const daysFail = recordingFetch({ failUrls: ['/days'] })
  assert.equal((await migrateLegacyDataToServer({ storage, fetchLike: daysFail.fetchLike })).status, 'failed')
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), null)

  const itemsFail = recordingFetch({ failUrls: ['/items'] })
  assert.equal((await migrateLegacyDataToServer({ storage, fetchLike: itemsFail.fetchLike })).status, 'failed')
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), null)

  const checklistFail = recordingFetch({ failUrls: ['/checklist'] })
  assert.equal((await migrateLegacyDataToServer({ storage, fetchLike: checklistFail.fetchLike })).status, 'failed')
  assert.equal(storage.peek(SERVER_MIGRATION_MARKER_KEY), null)
})
