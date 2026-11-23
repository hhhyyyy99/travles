import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CHECKLIST_STORAGE_KEY } from '../src/domain/checklist'
import {
  BUILTIN_TRIP_ID,
  migrateLegacyDataToServer,
  SERVER_MIGRATION_MARKER_KEY,
} from '../src/domain/migration'
import { ACCOMMODATION_STORAGE_KEY } from '../src/domain/storage'
import { createApp } from '../server/src/app.js'
import type { DayContent } from '../server/src/content/types.js'
import { createSqliteDaysAdminStore } from '../server/src/days-admin/driver-sqlite.js'
import { createSqliteWorkbenchStore } from '../server/src/days/driver-sqlite.js'
import { seedBuiltinTrip } from '../server/src/seed/seed.js'
import { createSqliteToolsStore } from '../server/src/tools/driver-sqlite.js'
import { createSqliteTripRepository } from '../server/src/trips/factory.js'

void test('migrates seeded stays and checklist into the example trip while preserving user edits', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'legacy-stay-migration-'))
  const sqlite = await createSqliteTripRepository(`file:${join(directory, 'trips.db')}`)
  t.after(async () => {
    await sqlite.close()
    await rm(directory, { recursive: true, force: true })
  })
  assert.deepEqual(await seedBuiltinTrip(sqlite.db), { seeded: true })
  const app = await createApp({
    tripRepository: sqlite.repository,
    contentRepository: sqlite.contentRepository,
    workbenchStore: createSqliteWorkbenchStore(sqlite.db),
    daysAdminStore: createSqliteDaysAdminStore(sqlite.db),
    toolsStore: createSqliteToolsStore(sqlite.db),
  })
  async function json<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await app.request(url, init)
    assert.ok(response.ok, `${url}: ${response.status}`)
    return (await response.json()) as T
  }
  function write<T>(url: string, method: 'POST' | 'PUT', body: unknown): Promise<T> {
    return json<T>(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  const { trip } = await write<{ trip: { id: string } }>('/api/trips', 'POST', {
    title: '成都周末',
    startDate: '2026-10-10',
    endDate: '2026-10-11',
  })
  const tripUrl = `/api/trips/${trip.id}`
  const { day } = await write<{ day: { id: string } }>(`${tripUrl}/days`, 'POST', {
    theme: '成都慢游',
  })
  await write(`${tripUrl}/items`, 'PUT', {
    items: [
      { id: 'chengdu-stay', dayId: day.id, type: 'stay', title: '成都住宿', note: '临近地铁' },
    ],
  })
  await write(`${tripUrl}/checklist`, 'POST', { content: '带地铁卡' })
  const readOrdinaryTrip = () =>
    Promise.all([json(`${tripUrl}/canvas`), json(`${tripUrl}/checklist`)])
  const ordinaryBefore = await readOrdinaryTrip()

  const builtinUrl = `/api/trips/${BUILTIN_TRIP_ID}`
  const readStay = async (dayIndex: number) => {
    const { days } = await json<{ days: DayContent[] }>(`${builtinUrl}/days`)
    const item = days
      .find((entry) => entry.idx === dayIndex)
      ?.items.find((entry) => entry.id === `builtin-stay-day-${dayIndex}`)
    assert.ok(item)
    return item
  }
  const seeded = await readStay(1)
  assert.equal(seeded.title, '额尔古纳 · 1 晚')
  assert.equal(seeded.note, '约 580–650 m')
  const titleEdited = await readStay(2)
  const noteEdited = await readStay(3)
  const poiEdited = await readStay(4)
  const manualPoi = { name: '手选住宿', lat: 49.6, lng: 117.4 }
  await write(`${builtinUrl}/items`, 'PUT', {
    items: [
      { ...titleEdited, title: '手工安排 · 第 3 晚', itemOrder: 42 },
      { ...noteEdited, note: '' },
      { ...poiEdited, note: '用户备注', poi: manualPoi },
    ],
  })

  const legacy = new Map([
    [
      ACCOMMODATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        bases: [
          {
            id: 'test-stay',
            name: '测试民宿',
            type: 'hotel',
            lat: 50.24,
            lng: 120.18,
            address: '测试民宿地址',
          },
        ],
        stays: { 1: 'test-stay' },
      }),
    ],
    [CHECKLIST_STORAGE_KEY, JSON.stringify([0, 2])],
  ])
  let requests = 0
  const migrate = () =>
    migrateLegacyDataToServer({
      storage: {
        getItem: (key) => legacy.get(key) ?? null,
        setItem: (key, value) => {
          legacy.set(key, value)
        },
      },
      fetchLike: async (url, init) => {
        requests += 1
        return app.request(url, init)
      },
    })
  assert.equal((await migrate()).status, 'migrated')
  assert.equal(legacy.get(SERVER_MIGRATION_MARKER_KEY), 'done')
  const migrated = await readStay(1)
  assert.equal(migrated.title, '测试民宿')
  assert.equal(migrated.note, '测试民宿地址')
  assert.ok(typeof migrated.poi === 'string')
  assert.deepEqual(JSON.parse(migrated.poi), {
    amapId: 'legacy-accommodation:test-stay',
    name: '测试民宿',
    lat: 50.24,
    lng: 120.18,
    address: '测试民宿地址',
    accommodationBaseId: 'test-stay',
    accommodationType: 'hotel',
    accommodationMigrationVersion: 2,
    category: '酒店 / 民宿',
    rating: 0,
    introSummary: '',
  })
  const retitled = await readStay(2)
  assert.equal(retitled.title, '手工安排 · 第 3 晚')
  assert.equal(retitled.itemOrder, 42)
  assert.equal(
    retitled.note,
    '莫尔道嘎 · 1 晚',
    'the untouched seed note is replaced independently',
  )
  const cleared = await readStay(3)
  assert.equal(cleared.title, '黑山头')
  assert.equal(cleared.note, '')
  const preserved = await readStay(4)
  assert.equal(preserved.title, poiEdited.title)
  assert.equal(preserved.note, '用户备注')
  assert.ok(typeof preserved.poi === 'string')
  assert.deepEqual(JSON.parse(preserved.poi), manualPoi)
  const checklist = await json<{ items: { id: string; done: boolean }[] }>(
    `${builtinUrl}/checklist`,
  )
  assert.equal(checklist.items.length, 6)
  assert.deepEqual(
    checklist.items
      .filter((item) => item.done)
      .map((item) => item.id)
      .sort(),
    ['legacy-checklist-0', 'legacy-checklist-2'],
  )
  requests = 0
  assert.equal((await migrate()).status, 'already-migrated')
  assert.equal(requests, 0)
  assert.deepEqual(await readOrdinaryTrip(), ordinaryBefore)
})
