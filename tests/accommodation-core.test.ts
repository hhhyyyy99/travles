import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  affectedRoutes,
  alternateBases,
  applyStays,
  createBase,
  defaultBaseFor,
  defaultBases,
  defaultStayByDay,
  deleteBase,
  getDayRoute,
  getDayStay,
  getBackup,
  inUseBaseCount,
  listBases,
  normalizeBase,
  overnightDays,
  replaceState,
  restoreDay,
  routeSignature,
  saveBase,
  stayNoteGroups,
  stayNoteText,
  updateBase,
  usedBaseIds,
  usedDaysForBase,
  validateBackup,
} from '../src/domain/accommodation'
import {
  ACCOMMODATION_STORAGE_KEY,
  ACCOMMODATION_WRITE_FAILURE_STATUS,
  readState,
  writeState,
  type StorageLike,
} from '../src/domain/storage'
import type { AccommodationState } from '../src/domain/types'

// Ticket 04 part A pure suite. Mirrors the legacy scenarios of
// tests/accommodation-core.browser.cjs at the domain level plus the storage
// codec contract (note B §1/§2/§4). The provider/UI flows are covered by the
// part B/C browser suites.

const EMPTY: AccommodationState = { version: 1, bases: [], stays: {} }

/** In-memory StorageLike for codec tests (legacy contract: injected storage). */
function memoryStorage(seed: Record<string, string> = {}): { storage: StorageLike; data: Record<string, string> } {
  const data: Record<string, string> = { ...seed }
  return {
    storage: {
      getItem: (key) => (key in data ? data[key] : null),
      setItem: (key, value) => {
        data[key] = value
      },
    },
    data,
  }
}

/** A valid custom base input with a deterministic id. */
function baseInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'custom-abc',
    name: '浏览器验收民宿',
    type: 'hotel',
    lat: '49.19',
    lng: '119.79',
    address: '海拉尔区测试路',
    notes: '有独立暖气',
    createdAt: '2026-09-10T08:00:00.000Z',
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Defaults derivation (note B §1.1/§1.2)
 * ------------------------------------------------------------------ */

test('overnight days are [0..5] and default bases mirror tripPlan points', () => {
  assert.deepEqual(overnightDays, [0, 1, 2, 3, 4, 5])
  assert.deepEqual(defaultStayByDay.slice(0, 6), [
    'default-hailar',
    'default-erguna',
    'default-mordaoga',
    'default-heishantou',
    'default-manzhouli',
    'default-hailar',
  ])
  assert.deepEqual(
    defaultBases.map((base) => base.id),
    ['default-hailar', 'default-erguna', 'default-mordaoga', 'default-heishantou', 'default-manzhouli'],
  )
  assert.ok(defaultBases.every((base) => base.type === 'area' && base.isDefault))
  // Representative coordinates come from tripPlan.points.xy (WGS-84 [lat, lng]).
  assert.equal(defaultBaseFor(0)?.id, 'default-hailar')
  assert.equal(defaultBaseFor(0)?.lat, 49.212)
  assert.equal(defaultBaseFor(0)?.lng, 119.766)
  assert.equal(defaultBaseFor(1)?.routeName, '额尔古纳市')
  assert.equal(defaultBaseFor(5)?.id, 'default-hailar')
  assert.equal(defaultBaseFor(6), null)
})

test('default state resolves every night to its default stay', () => {
  assert.deepEqual(
    overnightDays.map((index) => getDayStay(EMPTY, index)?.id),
    ['default-hailar', 'default-erguna', 'default-mordaoga', 'default-heishantou', 'default-manzhouli', 'default-hailar'],
  )
  assert.equal(getDayStay(EMPTY, 6), null) // day 6 has no overnight
  assert.equal(inUseBaseCount(EMPTY), 5)
  assert.deepEqual(usedBaseIds(EMPTY), [
    'default-hailar',
    'default-erguna',
    'default-mordaoga',
    'default-heishantou',
    'default-manzhouli',
  ])
})

/* ------------------------------------------------------------------ *
 * normalizeBase (note B §1.3)
 * ------------------------------------------------------------------ */

test('normalizeBase accepts string coordinates and coerces type', () => {
  const base = normalizeBase(baseInput({ type: 'area' }))
  assert.ok(base)
  assert.equal(base.id, 'custom-abc')
  assert.equal(base.name, '浏览器验收民宿')
  assert.equal(base.type, 'area')
  assert.equal(base.lat, 49.19)
  assert.equal(base.lng, 119.79)
  assert.equal(base.isDefault, false)
  assert.equal(base.createdAt, '2026-09-10T08:00:00.000Z')
  // any non-'area' coerces to 'hotel'
  const hotel = normalizeBase(baseInput({ type: 'whatever' }))
  assert.equal(hotel?.type, 'hotel')
})

test('normalizeBase trims and slices name/address/notes to legacy limits', () => {
  const base = normalizeBase(
    baseInput({
      name: `  ${'长'.repeat(130)}  `,
      address: `${'址'.repeat(250)}`,
      notes: `${'注'.repeat(620)}`,
    }),
  )
  assert.ok(base)
  assert.equal(base.name, '长'.repeat(120))
  assert.equal(base.address, '址'.repeat(240))
  assert.equal(base.notes, '注'.repeat(600))
})

test('normalizeBase rejects missing/out-of-range coordinates and empty names', () => {
  assert.equal(normalizeBase(baseInput({ name: '  ' })), null)
  assert.equal(normalizeBase(baseInput({ lat: '' })), null)
  assert.equal(normalizeBase(baseInput({ lng: undefined })), null)
  assert.equal(normalizeBase(baseInput({ lat: '91' })), null)
  assert.equal(normalizeBase(baseInput({ lat: '-91' })), null)
  assert.equal(normalizeBase(baseInput({ lng: '181' })), null)
  assert.equal(normalizeBase(baseInput({ lat: 'abc' })), null)
  assert.equal(normalizeBase(null), null)
  assert.equal(normalizeBase('string'), null)
  // lat: 0 is valid (legacy `value.lat ?? ''` semantics)
  const zero = normalizeBase(baseInput({ lat: 0, lng: 0 }))
  assert.ok(zero)
  assert.equal(zero.lat, 0)
})

test('normalizeBase generates an id when none is provided and forces createdAt', () => {
  const base = normalizeBase(baseInput({ id: undefined, createdAt: undefined }), () => 'custom-fixed')
  assert.ok(base)
  assert.equal(base.id, 'custom-fixed')
  assert.ok(typeof base.createdAt === 'string' && base.createdAt.length > 0)
})

/* ------------------------------------------------------------------ *
 * CRUD flows (mirrors accommodation-core.browser.cjs scenarios)
 * ------------------------------------------------------------------ */

test('applying a base to nights persists across the state (map-picked base on 0 and 5)', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 5], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  assert.deepEqual(applied.event.dayIndices, [0, 5])
  assert.deepEqual(applied.event.routeDays, [0, 1, 5, 6])
  // stays holds only overrides
  assert.deepEqual(applied.state.stays, { 0: 'custom-abc', 5: 'custom-abc' })
  assert.equal(getDayStay(applied.state, 0)?.name, '浏览器验收民宿')
  assert.equal(getDayStay(applied.state, 5)?.name, '浏览器验收民宿')
  assert.equal(getDayStay(applied.state, 1)?.name, '额尔古纳')
  // distinct referenced bases still 5 (2× custom + 4 defaults... nights 0,5 custom, 1-4 defaults)
  assert.equal(inUseBaseCount(applied.state), 5)
})

test('alternates never inflate the in-use count', () => {
  const alternate = saveBase(EMPTY, baseInput({ id: 'custom-backup', name: '备选酒店' }))
  assert.ok(alternate.ok && alternate.committed)
  assert.deepEqual(alternate.event.dayIndices, [])
  assert.deepEqual(alternate.event.routeDays, [])
  assert.equal(inUseBaseCount(alternate.state), 5)
  assert.deepEqual(alternateBases(alternate.state).map((base) => base.id), ['custom-backup'])
  // applying it to a night moves it out of the alternates and keeps the count at 5
  const applied = applyStays(alternate.state, [2], 'custom-backup')
  assert.ok(applied.ok && applied.committed)
  assert.equal(inUseBaseCount(applied.state), 5)
  assert.deepEqual(alternateBases(applied.state), [])
})

test('restore removes only that night override — other nights intact', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 5], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const restored = restoreDay(applied.state, 0)
  assert.ok(restored.ok && restored.committed)
  assert.deepEqual(restored.state.stays, { 5: 'custom-abc' })
  assert.equal(getDayStay(restored.state, 0)?.id, 'default-hailar')
  assert.equal(getDayStay(restored.state, 5)?.id, 'custom-abc')
  assert.deepEqual(restored.event.dayIndices, [0])
  assert.deepEqual(restored.event.routeDays, [0, 1])
})

test('restore is a no-op when the night is already default', () => {
  const result = restoreDay(EMPTY, 0)
  assert.ok(result.ok && !result.committed)
  assert.deepEqual(result.changed, [])
})

test('restoreDay rejects non-overnight days with the exact legacy error', () => {
  const result = restoreDay(EMPTY, 6)
  assert.ok(!result.ok)
  assert.equal(result.ok === false ? result.error : '', '该日没有住宿安排')
})

test('in-use bases cannot be deleted — exact legacy message with night numbers', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 5], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const result = deleteBase(applied.state, 'custom-abc')
  assert.ok(!result.ok)
  assert.equal(result.ok === false ? result.error : '', '该基地正在使用，请先替换第 1、6 晚住宿')
  // unused custom base is deletable and never invalidates routes
  const alternate = saveBase(EMPTY, baseInput({ id: 'custom-free' }))
  assert.ok(alternate.ok && alternate.committed)
  const deleted = deleteBase(alternate.state, 'custom-free')
  assert.ok(deleted.ok && deleted.committed)
  assert.deepEqual(deleted.event.dayIndices, [])
  assert.deepEqual(deleted.event.routeDays, [])
  assert.deepEqual(listBases(deleted.state).map((base) => base.id), defaultBases.map((base) => base.id))
})

test('default bases are immutable to edit and delete', () => {
  const edited = updateBase(EMPTY, 'default-hailar', { name: '改' })
  assert.ok(!edited.ok)
  assert.equal(edited.ok === false ? edited.error : '', '默认住宿不可编辑')
  const deleted = deleteBase(EMPTY, 'default-hailar')
  assert.ok(!deleted.ok)
  assert.equal(deleted.ok === false ? deleted.error : '', '默认住宿不可删除')
  // saveBase cannot overwrite a default id
  const overwritten = saveBase(EMPTY, baseInput({ id: 'default-erguna' }))
  assert.ok(!overwritten.ok)
  assert.equal(overwritten.ok === false ? overwritten.error : '', '默认住宿不可覆盖')
})

test('editing a shared base propagates to all referencing nights and preserves id/createdAt', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 5], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const updated = updateBase(applied.state, 'custom-abc', { name: '北岸民宿', notes: '热水稳定' })
  assert.ok(updated.ok && updated.committed)
  assert.deepEqual(updated.dayIndices, [0, 5])
  assert.deepEqual(updated.routeDays, []) // name/notes do not invalidate routes
  assert.ok(updated.ok && updated.base)
  assert.equal(updated.base.id, 'custom-abc')
  assert.equal(updated.base.createdAt, '2026-09-10T08:00:00.000Z')
  assert.equal(getDayStay(updated.state, 0)?.name, '北岸民宿')
  assert.equal(getDayStay(updated.state, 5)?.name, '北岸民宿')
})

test('updateBase location change invalidates routes for the referencing nights', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [2], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const updated = updateBase(applied.state, 'custom-abc', { lat: 50.0, lng: 120.0 })
  assert.ok(updated.ok && updated.committed)
  assert.deepEqual(updated.routeDays, [2, 3])
})

test('assigning a default base to its own default night undoes the override', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  // put default-hailar on night 2 (a non-default night) — an override
  const applied = applyStays(created.state, [2], 'default-hailar')
  assert.ok(applied.ok && applied.committed)
  assert.deepEqual(applied.state.stays, { 2: 'default-hailar' })
  const route = getDayRoute(applied.state, 2)
  assert.equal(route?.to?.isCustom, false)
  assert.equal(route?.to?.isChanged, true) // gotcha 13: default base on non-default night
  assert.equal(route?.hasCustomEndpoint, false)
  assert.equal(route?.hasChangedEndpoint, true)

  // an override on night 5 is deleted by assigning the own default base
  const withCustom = applyStays(applied.state, [5], 'custom-abc')
  assert.ok(withCustom.ok && withCustom.committed)
  assert.equal(getDayStay(withCustom.state, 5)?.id, 'custom-abc')
  const undone = applyStays(withCustom.state, [5], 'default-hailar')
  assert.ok(undone.ok && undone.committed)
  assert.deepEqual(undone.state.stays, { 2: 'default-hailar' }) // night 5 override removed
  assert.equal(getDayStay(undone.state, 5)?.id, 'default-hailar')
  assert.deepEqual(undone.changed, [5])

  // assigning a default base to a night that already resolves to it is a no-op
  const already = applyStays(EMPTY, [5], 'default-hailar')
  assert.ok(already.ok && !already.committed)
})

/* ------------------------------------------------------------------ *
 * Route invalidation day sets ({N, N+1})
 * ------------------------------------------------------------------ */

test('changing night N invalidates route days N and N+1 only', () => {
  assert.deepEqual(affectedRoutes([0]), [0, 1])
  assert.deepEqual(affectedRoutes([2]), [2, 3])
  assert.deepEqual(affectedRoutes([5]), [5, 6])
  assert.deepEqual(affectedRoutes([0, 5]), [0, 1, 5, 6])
  assert.deepEqual(affectedRoutes([0, 1, 2, 3, 4, 5]), [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(affectedRoutes([]), [])
  assert.deepEqual(affectedRoutes([6]), []) // day 6 is not overnight
})

test('committed mutations carry dayIndices and routeDays in the change event', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [1, 2], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  assert.deepEqual(applied.event.type, 'assign')
  assert.deepEqual(applied.event.dayIndices, [1, 2])
  assert.deepEqual(applied.event.routeDays, [1, 2, 3])
  const restored = restoreDay(applied.state, 1)
  assert.ok(restored.ok && restored.committed)
  assert.equal(restored.event.type, 'restore')
  assert.deepEqual(restored.event.routeDays, [1, 2])
})

test('applyStays with an already-applied night is a no-op (nothing persisted)', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [2], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const again = applyStays(applied.state, [2], 'custom-abc')
  assert.ok(again.ok && !again.committed)
  assert.deepEqual(again.changed, [])
})

/* ------------------------------------------------------------------ *
 * Route endpoints per day (note B §4.4)
 * ------------------------------------------------------------------ */

test('day 0 route: airport point → night-0 stay, no via', () => {
  const route = getDayRoute(EMPTY, 0)
  assert.ok(route)
  assert.equal(route.from?.name, '海拉尔东山机场')
  assert.equal(route.from?.routeName, '海拉尔东山机场')
  assert.equal(route.from?.kind, 'point')
  assert.equal(route.from?.id, undefined)
  assert.equal(route.from?.lat, 49.205)
  assert.equal(route.from?.lng, 119.826)
  assert.equal(route.from?.isCustom, false)
  assert.equal(route.to?.id, 'default-hailar')
  assert.equal(route.to?.name, '海拉尔')
  assert.equal(route.to?.routeName, '海拉尔市区') // area representative position keyword
  assert.equal(route.to?.type, 'area')
  assert.equal(route.to?.kind, 'base')
  assert.deepEqual(route.via, [])
  assert.deepEqual(route.stops.map((stop) => stop.name), ['海拉尔东山机场', '海拉尔'])
  assert.equal(route.hasCustomEndpoint, false)
  assert.equal(route.hasChangedEndpoint, false)
})

test('day 1 route keeps the scenic keyword stop in addition to the real mid-point', () => {
  const route = getDayRoute(EMPTY, 1)
  assert.ok(route)
  assert.equal(route.from?.id, 'default-hailar')
  assert.equal(route.to?.id, 'default-erguna')
  assert.deepEqual(
    route.via.map((stop) => stop.name),
    ['莫尔格勒河', '额尔古纳湿地景区'],
  )
  const keyword = route.via[1]
  assert.equal(keyword?.keyword, '额尔古纳湿地景区')
  assert.equal(keyword?.keywordOnly, true)
  assert.equal(keyword?.kind, 'keyword')
  assert.equal(keyword?.city, '呼伦贝尔市')
  assert.equal(keyword?.lat, undefined)
  assert.deepEqual(route.stops.map((stop) => stop.name), [
    '海拉尔',
    '莫尔格勒河',
    '额尔古纳湿地景区',
    '额尔古纳',
  ])
})

test('day 6 route: night-5 stay → airport point (special last day)', () => {
  const route = getDayRoute(EMPTY, 6)
  assert.ok(route)
  assert.equal(route.from?.id, 'default-hailar')
  assert.equal(route.from?.routeName, '海拉尔市区')
  assert.equal(route.to?.name, '海拉尔东山机场')
  assert.equal(route.to?.kind, 'point')
  assert.equal(route.to?.id, undefined)
  assert.deepEqual(route.via, [])
  assert.deepEqual(route.stops.map((stop) => stop.name), ['海拉尔', '海拉尔东山机场'])
})

test('custom stops flip isCustom/hasChangedEndpoint and carry routeName fallback', () => {
  const created = createBase(EMPTY, baseInput({ name: '松林小院', address: '额尔古纳市河西' }))
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [1], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const route = getDayRoute(applied.state, 1)
  assert.equal(route?.to?.isCustom, true)
  assert.equal(route?.to?.isChanged, true)
  assert.equal(route?.to?.kind, 'base')
  assert.equal(route?.to?.type, 'hotel')
  // custom bases have no routeName → address → name fallback (gotcha 14)
  assert.equal(route?.to?.routeName, '额尔古纳市河西')
  assert.equal(route?.hasCustomEndpoint, true)
  assert.equal(route?.hasChangedEndpoint, true)
})

test('a missing stay override degrades to null endpoints without crashing', () => {
  const broken: AccommodationState = { version: 1, bases: [], stays: { 0: 'missing-id' } }
  assert.equal(getDayStay(broken, 0), null)
  const day0 = getDayRoute(broken, 0)
  assert.ok(day0)
  assert.equal(day0.to, null) // night-0 stay unresolvable
  assert.deepEqual(day0.stops.map((stop) => stop.name), ['海拉尔东山机场'])
  const day1 = getDayRoute(broken, 1)
  assert.equal(day1?.from, null) // from = night-0 stay
  assert.equal(day1?.hasChangedEndpoint, false)
})

/* ------------------------------------------------------------------ *
 * Stay-note summary grouping (trip.js:213–221)
 * ------------------------------------------------------------------ */

test('consecutive same stays group as `name N 晚` joined by  →', () => {
  // defaults: 海拉尔 is the night-0 AND night-5 stay but they are not
  // consecutive → two separate 1 晚 groups (legacy trip.js:213–221)
  assert.equal(
    stayNoteText(EMPTY),
    '海拉尔 1 晚 → 额尔古纳 1 晚 → 莫尔道嘎 1 晚 → 黑山头 1 晚 → 满洲里 1 晚 → 海拉尔 1 晚',
  )
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 1], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  assert.deepEqual(stayNoteGroups(applied.state).slice(0, 2), [
    { id: 'custom-abc', name: '浏览器验收民宿', count: 2 },
    { id: 'default-mordaoga', name: '莫尔道嘎', count: 1 },
  ])
})

test('non-consecutive same stays form separate groups (legacy consecutive-only rule)', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 5], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const counts = stayNoteGroups(applied.state).filter((group) => group.id === 'custom-abc')
  assert.equal(counts.length, 2)
  assert.ok(counts.every((group) => group.count === 1))
})

/* ------------------------------------------------------------------ *
 * Storage codec (note B §2 — legacy key/payload, corrupt reads, write shape)
 * ------------------------------------------------------------------ */

test('writeState → readState round-trips through an in-memory mock', () => {
  const { storage, data } = memoryStorage()
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 5], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const write = writeState(storage, applied.state)
  assert.deepEqual(write, { ok: true })
  const reloaded = readState(storage)
  assert.deepEqual(reloaded, applied.state)
  assert.equal(getDayStay(reloaded, 1)?.id, 'default-erguna')
  // byte-compatible payload: {version, bases, stays}, only overrides in stays
  const raw = JSON.parse(data[ACCOMMODATION_STORAGE_KEY] ?? '{}') as Record<string, unknown>
  assert.deepEqual(Object.keys(raw), ['version', 'bases', 'stays'])
  assert.equal(raw.version, 1)
  assert.deepEqual(Object.keys(raw.stays as Record<string, string>), ['0', '5'])
  const storedBases = raw.bases as Array<Record<string, unknown>>
  assert.equal(storedBases[0]?.isDefault, false)
  assert.equal(storedBases[0]?.createdAt, '2026-09-10T08:00:00.000Z')
})

test('missing or corrupt stored data degrades silently to defaults', () => {
  assert.deepEqual(readState(memoryStorage().storage), EMPTY)
  const corrupt = memoryStorage({ [ACCOMMODATION_STORAGE_KEY]: '{not json' })
  assert.deepEqual(readState(corrupt.storage), EMPTY)
  const scalar = memoryStorage({ [ACCOMMODATION_STORAGE_KEY]: '42' })
  assert.deepEqual(readState(scalar.storage), EMPTY)
  const throwing = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => undefined,
  }
  assert.deepEqual(readState(throwing), EMPTY)
})

test('legacy quirk: stored isDefault on customs is stripped and version ignored', () => {
  const legacyPayload = JSON.stringify({
    version: 99, // ignored
    bases: [
      {
        id: 'custom-legacy',
        name: '老数据民宿',
        type: 'hotel',
        lat: 49.2,
        lng: 119.8,
        address: '',
        notes: '',
        createdAt: '2026-09-10T08:00:00.000Z',
        isDefault: true, // legacy wrote isDefault on customs — stripped
        extraField: 'dropped',
      },
    ],
    stays: { '0': 'custom-legacy', '1': 'missing-base', '6': 'custom-legacy' },
  })
  const { storage } = memoryStorage({ [ACCOMMODATION_STORAGE_KEY]: legacyPayload })
  const state = readState(storage)
  assert.ok(state.ok === undefined && state.version === 1)
  assert.equal(state.bases.length, 1)
  assert.equal(state.bases[0]?.isDefault, false) // normalized, not trusted
  assert.equal('extraField' in (state.bases[0] ?? {}), false)
  assert.deepEqual(state.stays, { 0: 'custom-legacy' }) // unknown id + non-overnight day dropped
  assert.equal(getDayStay(state, 0)?.name, '老数据民宿')
  assert.equal(getDayStay(state, 1)?.id, 'default-erguna')
})

test('write failure returns the legacy error shape and never throws', () => {
  const failing = {
    getItem: () => null,
    setItem: () => {
      throw new DOMException('Full', 'QuotaExceededError')
    },
  }
  const result = writeState(failing, EMPTY)
  assert.deepEqual(result, { ok: false, error: '保存失败' })
  assert.equal(ACCOMMODATION_WRITE_FAILURE_STATUS, '当前浏览器未允许保存，住宿安排未改变。')
})

/* ------------------------------------------------------------------ *
 * replaceState / validateBackup essentials (note B §2.1/§2.2)
 * ------------------------------------------------------------------ */

function backupFor(state: AccommodationState): Record<string, unknown> {
  return {
    format: 'hailar-slow-trip-accommodation',
    version: 1,
    bases: state.bases.map(({ isDefault, ...rest }) => ({ ...rest })),
    stays: Object.fromEntries(overnightDays.map((index) => [String(index), getDayStay(state, index)?.id ?? 'default-hailar'])),
  }
}

test('replaceState performs a full replacement and reports changed route days', () => {
  const created = createBase(EMPTY, baseInput({ id: 'custom-initial' }))
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [1], 'custom-initial')
  assert.ok(applied.ok && applied.committed)
  // replace with a defaults-only backup → nights go back to defaults
  // (legacy keeps the backup's explicit stays entries — no merge/collapse)
  const defaultsOnly = backupFor(EMPTY)
  const result = replaceState(applied.state, JSON.stringify(defaultsOnly))
  assert.ok(result.ok && result.committed)
  assert.deepEqual(result.state.stays, {
    0: 'default-hailar',
    1: 'default-erguna',
    2: 'default-mordaoga',
    3: 'default-heishantou',
    4: 'default-manzhouli',
    5: 'default-hailar',
  })
  assert.deepEqual(result.event.type, 'restore')
  assert.deepEqual(result.event.dayIndices, overnightDays)
  assert.deepEqual(result.routeDays, [1, 2]) // only the changed night pair
})

test('replaceState rejects invalid versions and dangling stays with exact messages', () => {
  const bad = backupFor(EMPTY)
  bad.version = 99
  const versionResult = replaceState(EMPTY, JSON.stringify(bad))
  assert.ok(!versionResult.ok)
  assert.deepEqual(versionResult.errors, ['备份版本不受支持，仅支持 v1。'])

  const dangling = backupFor(EMPTY)
  dangling.stays = { ...(dangling.stays as Record<string, string>), '1': 'missing-base' }
  const stayResult = replaceState(EMPTY, JSON.stringify(dangling))
  assert.ok(!stayResult.ok)
  assert.deepEqual(stayResult.errors, ['第 2 晚引用了不存在的住宿基地。'])
})

test('validateBackup rejects invalid JSON, wrong format and non-object input', () => {
  assert.deepEqual(validateBackup('{nope').errors, ['备份文件不是有效的 JSON。'])
  assert.deepEqual(validateBackup(42).errors, ['备份文件必须是一个 JSON 对象。'])
  const wrongFormat = backupFor(EMPTY)
  wrongFormat.format = 'other'
  assert.deepEqual(validateBackup(wrongFormat as never).errors, ['备份格式不受支持。'])
  assert.deepEqual(validateBackup('[]').errors, ['备份文件必须是一个 JSON 对象。'])
})

test('getBackup exports the legacy payload: explicit stays, stripped flags, no settings', () => {
  const created = createBase(EMPTY, baseInput({ id: 'custom-initial' }))
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [1], 'custom-initial')
  assert.ok(applied.ok && applied.committed)
  const backup = getBackup(applied.state)
  assert.deepEqual(Object.keys(backup).sort(), ['bases', 'format', 'stays', 'version'])
  assert.equal(backup.format, 'hailar-slow-trip-accommodation')
  assert.equal(backup.version, 1)
  assert.deepEqual(backup.bases.map((base) => base.id), ['custom-initial'])
  assert.equal('isDefault' in (backup.bases[0] ?? {}), false, 'isDefault stripped from exports')
  assert.equal('routeName' in (backup.bases[0] ?? {}), false, 'routeName never exported')
  // every overnight night explicit so the file re-validates (6 nights)
  const exportedDays = Object.keys(backup.stays).map(Number).sort((a, b) => a - b)
  assert.deepEqual(exportedDays, overnightDays)
  assert.equal(backup.stays[1], 'custom-initial')
  assert.equal(backup.stays[0], 'default-hailar')
  // export round-trips through validateBackup (the import gate)
  const validation = validateBackup(JSON.stringify(backup))
  assert.ok(validation.ok)
})

test('export base object keeps the legacy byte-compatible field order', () => {
  const created = createBase(EMPTY, { ...baseInput(), id: 'custom-ab12', address: '海拉尔区', notes: '独立暖气' })
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [4], 'custom-ab12')
  assert.ok(applied.ok && applied.committed)
  const parsed = JSON.parse(JSON.stringify(getBackup(applied.state))) as { bases: Array<Record<string, unknown>> }
  assert.deepEqual(Object.keys(parsed.bases[0] ?? {}), ['id', 'name', 'type', 'lat', 'lng', 'address', 'notes', 'createdAt'])
  assert.equal(parsed.bases[0]?.name, '浏览器验收民宿')
  assert.equal(parsed.bases[0]?.address, '海拉尔区')
  assert.equal(parsed.bases[0]?.notes, '独立暖气')
})

test('routeSignature distinguishes changed endpoints for replaceState comparison', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [2], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  const before = routeSignature(getDayRoute(EMPTY, 2))
  const after = routeSignature(getDayRoute(applied.state, 2))
  assert.notEqual(before, after)
  assert.equal(routeSignature(getDayRoute(EMPTY, 2)), routeSignature(getDayRoute(EMPTY, 2)))
})

/* ------------------------------------------------------------------ *
 * Manager-facing selectors (part B contract)
 * ------------------------------------------------------------------ */

test('usedDaysForBase exposes exact nights referencing a base (manager 正在使用)', () => {
  const created = createBase(EMPTY, baseInput())
  assert.ok(created.ok && created.committed)
  const applied = applyStays(created.state, [0, 5], 'custom-abc')
  assert.ok(applied.ok && applied.committed)
  assert.deepEqual(usedDaysForBase(applied.state, 'custom-abc'), [0, 5])
  assert.deepEqual(usedDaysForBase(EMPTY, 'default-hailar'), [0, 5])
  assert.deepEqual(usedDaysForBase(applied.state, 'default-erguna'), [1])
})