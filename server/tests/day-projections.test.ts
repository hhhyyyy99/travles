import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assembleCanvas, mapDayRow, readTripCanvas } from '../src/days/repository.js'
import { MemoryWorkbenchStoreDriver } from '../src/days/driver-memory.js'
import { TripContentRepository } from '../src/content/repository.js'
import { MemoryContentStoreDriver } from '../src/content/driver-memory.js'
import type { DayRow } from '../src/days/types.js'

const row: DayRow = { id: 'unrelated-name', trip_id: 'actual-trip', idx: 4, date: '2026-10-02', theme: '旅行', color: '#abc' }

test('canvas and content readers omit untrusted trip identity without losing days or their items', async () => {
  for (const trip_id of ['other-trip', '', '  ', null, 7, false]) {
    const source = { ...row, trip_id }
    const item = { id: 'activity', trip_id: 'actual-trip', day_id: row.id, item_order: 6,
      type: 'other', title: '原活动', note: '原备注', poi: null, images: null, pending: 0 }
    // A faulty injected driver can violate the SQL WHERE constraint. Do not
    // expose its conflicting trip id or guess one from the Day id/theme.
    const canvasStore = new MemoryWorkbenchStoreDriver()
    canvasStore.listDayRows = async () => [source]
    canvasStore.listItemRows = async () => [item]
    const canvas = await readTripCanvas(canvasStore, 'actual-trip')
    const contentStore = new MemoryContentStoreDriver()
    contentStore.listDayRows = async () => [source]
    contentStore.listItemRows = async () => [item]
    const content = await new TripContentRepository(contentStore).listDays('actual-trip')
    for (const day of [canvas.days[0], content[0]]) {
      assert.ok(day)
      assert.equal(Object.hasOwn(day, 'tripId'), false, String(trip_id))
      assert.equal(day.dayNumber, 5, 'the valid independent index still projects')
      assert.equal(day.id, row.id)
      assert.equal(day.date, row.date)
      assert.equal(day.items[0]?.dayId, row.id)
      assert.equal(day.items[0]?.title, item.title)
    }
    assert.equal(canvas.days[0]?.items[0]?.order, 6)
    assert.equal(content[0]?.items[0]?.itemOrder, 6)
    assert.deepEqual(source, { ...row, trip_id }, 'reading leaves source untouched')
  }
  const assembled = assembleCanvas([row], [], [])
  assert.equal(assembled.days[0]?.tripId, 'actual-trip', 'a pure assembly can use the existing row relation')
  assert.equal(assembleCanvas([row], [], [], 'foreign-trip').days[0]?.tripId, undefined)
})

test('raw index projection never invents day 1 from tolerant old-field fallbacks', async () => {
  const cases: Array<{ idx: unknown; expected?: number }> = [
    { idx: 0, expected: 1 }, { idx: -0, expected: 1 }, { idx: 12, expected: 13 },
    { idx: Number.MAX_SAFE_INTEGER - 1, expected: Number.MAX_SAFE_INTEGER },
    ...[-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
      null, undefined, '', ' ', '4', 'broken', true, false, [], {}].map((idx) => ({ idx })),
  ]
  for (const { idx, expected } of cases) {
    const source = { ...row, idx }
    const before = structuredClone(source)
    const canvas = mapDayRow(source, [])
    assert.ok(canvas)
    const contentStore = new MemoryContentStoreDriver()
    contentStore.listDayRows = async () => [source]
    const [content] = await new TripContentRepository(contentStore).listDays('actual-trip')
    assert.ok(content)
    for (const day of [canvas, content]) {
      assert.equal(day.dayNumber, expected, String(idx))
      assert.equal(Object.hasOwn(day, 'dayNumber'), expected !== undefined, String(idx))
      assert.equal(day.tripId, 'actual-trip', 'bad index must not erase trustworthy ownership')
    }
    const legacyNumber = typeof idx === 'number' ? idx : Number(idx)
    assert.equal(canvas.index, Number.isFinite(legacyNumber) ? legacyNumber : 0)
    assert.equal(content.idx, Number.isInteger(Number(idx)) ? Number(idx) : 0)
    assert.equal(canvas.date, row.date)
    assert.equal(content.date, row.date)
    assert.deepEqual(source, before)
  }
})
