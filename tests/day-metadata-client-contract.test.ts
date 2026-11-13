import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DaySchema, TripCanvasSchema, TripPatchSchema, type Day, type TripSummary } from '@hailar/domain'
import {
  createWorkbenchDay,
  fetchTripCanvas,
  updateWorkbenchDay,
  type WorkbenchDayInput,
  type WorkbenchDayPatch,
} from '../src/domain/workbench'
import type { ApiResult, FetchLike } from '../src/domain/tripList'

const trip: TripSummary = {
  id: 'trip-1', title: 'Trip title', startDate: '', endDate: '', days: 0, nights: 0,
  createdAt: '', updatedAt: '',
}
const day: Day = {
  id: 'day-1', tripId: trip.id, dayNumber: 1, index: 0, date: '',
  theme: 'Theme is independent', color: '#123456',
  items: [{
    id: 'item-1', dayId: 'day-1', order: 0, type: 'other', title: 'Item title',
    note: 'Item note is independent', poi: null, images: [], pending: false,
  }],
}

const invalidMetadata = [null, 42, false, {}, []]

test('Day metadata stays optional and preserves empty strings, whitespace and independent values', () => {
  assert.deepEqual(DaySchema.parse(day), day, 'legacy days gain no metadata defaults')
  for (const metadata of [
    { title: 'Day title' }, { note: 'Day note' }, { title: '', note: '' },
    { title: '  Day title\n', note: '\t Day note  ' },
    { title: 'x'.repeat(1001), note: 'y'.repeat(1001) },
  ]) {
    const expected = { ...day, ...metadata }
    assert.deepEqual(DaySchema.parse(expected), expected)
    assert.deepEqual(TripCanvasSchema.parse({ days: [expected], legs: [] }), { days: [expected], legs: [] })
  }
  for (const field of ['title', 'note']) {
    for (const value of invalidMetadata) {
      assert.equal(DaySchema.safeParse({ ...day, [field]: value }).success, false, `${field}: ${JSON.stringify(value)}`)
    }
  }
})

test('existing add_day and update_day accept raw optional metadata and reject null or other non-strings', () => {
  for (const op of ['add_day', 'update_day']) {
    const base = { op, dayId: day.id }
    assert.deepEqual(TripPatchSchema.parse({ ops: [base] }), { ops: [base] }, 'omission stays omission')
    for (const metadata of [
      { title: '  Day title\n' }, { note: '\t Day note  ' }, { title: '', note: '' },
      { title: 'x'.repeat(1001), note: 'y'.repeat(1001), theme: 'Independent theme' },
    ]) {
      assert.deepEqual(TripPatchSchema.parse({ ops: [{ ...base, ...metadata }] }), { ops: [{ ...base, ...metadata }] })
    }
    for (const field of ['title', 'note']) {
      for (const value of invalidMetadata) {
        assert.equal(TripPatchSchema.safeParse({ ops: [{ ...base, [field]: value }] }).success, false,
          `${op}.${field}: ${JSON.stringify(value)}`)
      }
    }
  }
  assert.deepEqual(TripPatchSchema.parse({ ops: [{ op: 'update_item', itemId: 'item-1', note: null }] }), {
    ops: [{ op: 'update_item', itemId: 'item-1', note: null }],
  }, 'the existing item-note clearing contract stays independent')
})

test('day create and update serialize supplied metadata exactly and retain it in their responses', async () => {
  const input: WorkbenchDayInput = { date: '', theme: 'Create theme', color: '#abcdef', title: '  Title\n', note: '' }
  const patch: WorkbenchDayPatch = { theme: 'Update theme', color: '#fedcba', title: '', note: '\t Note  ' }
  const calls: Array<{ url: string; method?: string; body: unknown }> = []
  const fetchLike: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    calls.push({ url, method: init?.method, body })
    return Response.json({ day: { ...day, ...body } })
  }
  assert.deepEqual(await createWorkbenchDay('trip / 1', input, fetchLike), { ok: true, data: { ...day, ...input } })
  assert.deepEqual(await updateWorkbenchDay('trip / 1', 'day / 1', patch, fetchLike), { ok: true, data: { ...day, ...patch } })
  assert.deepEqual(calls, [
    { url: '/api/trips/trip%20%2F%201/days', method: 'POST', body: input },
    { url: '/api/trips/trip%20%2F%201/days/day%20%2F%201', method: 'PATCH', body: patch },
  ])
})

test('omitted day-write metadata is not sent and old responses do not invent it', async () => {
  const bodies: unknown[] = []
  const fetchLike: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ day })
  }
  assert.deepEqual(await createWorkbenchDay(trip.id, undefined, fetchLike), { ok: true, data: day })
  assert.deepEqual(await updateWorkbenchDay(trip.id, day.id, { theme: 'New theme' }, fetchLike), { ok: true, data: day })
  assert.deepEqual(bodies, [{}, { theme: 'New theme' }])
})

// Exercise the same response boundary through every browser entry point.
const dayReaders: Record<string, (rawDay: unknown) => Promise<ApiResult<Day>>> = {
  create: (rawDay) => createWorkbenchDay(trip.id, {}, async () => Response.json({ day: rawDay })),
  update: (rawDay) => updateWorkbenchDay(trip.id, day.id, {}, async () => Response.json({ day: rawDay })),
  canvas: async (rawDay) => {
    const result = await fetchTripCanvas(trip.id, async () => Response.json({ trip, days: [rawDay], legs: [] }))
    if (!result.ok) return result
    const normalized = result.data.days[0]
    assert.ok(normalized, 'the day survives tolerant canvas normalization')
    return { ok: true, data: normalized }
  },
}

for (const [path, readDay] of Object.entries(dayReaders)) {
  test(`${path} retains explicit valid metadata and omits malformed fields independently without losing items`, async () => {
    for (const metadata of [
      {}, { title: '' }, { note: '' }, { title: '', note: '' },
      { title: '  Day title\n', note: '\t Day note  ' },
    ]) {
      assert.deepEqual(await readDay({ ...day, ...metadata }), { ok: true, data: { ...day, ...metadata } })
    }
    for (const invalid of invalidMetadata) {
      assert.deepEqual(await readDay({ ...day, title: invalid, note: '  Valid note  ' }), {
        ok: true, data: { ...day, note: '  Valid note  ' },
      }, `invalid title: ${JSON.stringify(invalid)}`)
      assert.deepEqual(await readDay({ ...day, title: '  Valid title  ', note: invalid }), {
        ok: true, data: { ...day, title: '  Valid title  ' },
      }, `invalid note: ${JSON.stringify(invalid)}`)
    }
    assert.deepEqual(await readDay({ ...day, title: null, note: null }), { ok: true, data: day })
  })
}
