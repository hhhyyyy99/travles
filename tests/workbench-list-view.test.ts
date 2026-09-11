/**
 * List-view domain tests (ticket 10) — the day-admin API client codecs
 * (createWorkbenchDay / updateWorkbenchDay / deleteWorkbenchDay, injected
 * FetchLike stubs) and the per-trip view memory added to the workbench
 * layout (view: 'canvas' | 'list', tolerant reads that never throw).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CANVAS_NETWORK_ERROR,
  createWorkbenchDay,
  deleteWorkbenchDay,
  updateWorkbenchDay,
  type FetchLike,
} from '../src/domain/workbench'
import {
  WORKBENCH_LAYOUT_STORAGE_KEY,
  defaultLayout,
  readTripLayout,
  setWorkbenchView,
  writeTripLayout,
} from '../src/domain/workbenchLayout'
import type { StorageLike } from '../src/domain/storage'

function stubFetch(
  body: unknown,
  status = 200,
  capture?: { url: string; init?: RequestInit }[],
): FetchLike {
  return async (input, init) => {
    capture?.push({ url: String(input), init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

const DAY_PAYLOAD = { id: 'day-3', index: 2, date: '2026-10-04', theme: '', color: '', items: [] }

test('createWorkbenchDay posts the payload and normalizes the returned day', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const result = await createWorkbenchDay(
    'trip-1',
    { theme: '满洲里' },
    stubFetch({ day: DAY_PAYLOAD }, 201, calls),
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.data.id, 'day-3')
  assert.equal(result.data.index, 2)
  assert.equal(result.data.items.length, 0)
  assert.equal(calls[0]?.url, '/api/trips/trip-1/days')
  assert.equal(calls[0]?.init?.method, 'POST')
  assert.equal(String(calls[0]?.init?.body), JSON.stringify({ theme: '满洲里' }))
})

test('updateWorkbenchDay patches the theme and surfaces server errors verbatim', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const ok = await updateWorkbenchDay(
    'trip-1',
    'day-1',
    { theme: '海拉尔集结' },
    stubFetch({ day: { ...DAY_PAYLOAD, id: 'day-1', theme: '海拉尔集结' } }, 200, calls),
  )
  assert.ok(ok.ok)
  if (ok.ok) assert.equal(ok.data.theme, '海拉尔集结')
  assert.equal(calls[0]?.url, '/api/trips/trip-1/days/day-1')
  assert.equal(calls[0]?.init?.method, 'PATCH')

  const fail = await updateWorkbenchDay('trip-1', 'day-1', { theme: 'x' }, stubFetch({ error: '日程不存在' }, 404))
  assert.deepEqual(fail, { ok: false, error: '日程不存在' })

  const network = await updateWorkbenchDay('trip-1', 'day-1', { theme: 'x' }, async () => {
    throw new Error('down')
  })
  assert.deepEqual(network, { ok: false, error: CANVAS_NETWORK_ERROR })

  const garbage = await updateWorkbenchDay('trip-1', 'day-1', { theme: 'x' }, stubFetch('not json'))
  assert.equal(garbage.ok, false)
})

test('deleteWorkbenchDay reports the removed card count', async () => {
  const ok = await deleteWorkbenchDay('trip-1', 'day-1', stubFetch({ ok: true, removedItems: 3 }))
  assert.deepEqual(ok, { ok: true, data: { removedItems: 3 } })

  const missing = await deleteWorkbenchDay('trip-1', 'day-x', stubFetch({ error: '日程不存在' }, 404))
  assert.deepEqual(missing, { ok: false, error: '日程不存在' })

  const tolerant = await deleteWorkbenchDay('trip-1', 'day-1', stubFetch({ ok: true }))
  assert.deepEqual(tolerant, { ok: true, data: { removedItems: 0 } })
})

// ---------------------------------------------------------------------------
// View memory (layout codec extension)
// ---------------------------------------------------------------------------

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

test('the center view choice is remembered per trip and defaults to canvas', () => {
  const storage = new MemoryStorage()
  assert.equal(readTripLayout(storage, 'trip-1').view, 'canvas', 'unknown trips start on the canvas view')

  writeTripLayout(storage, 'trip-1', { ...defaultLayout(), view: 'list' })
  assert.equal(readTripLayout(storage, 'trip-1').view, 'list')
  assert.equal(readTripLayout(storage, 'trip-2').view, 'canvas', 'other trips keep their own view')

  // Old persisted files (pre ticket-10) have no view field → canvas.
  storage.setItem(
    WORKBENCH_LAYOUT_STORAGE_KEY,
    JSON.stringify({ version: 1, trips: { 'trip-1': { aiCollapsed: true, aiWidth: 400 } } }),
  )
  const legacy = readTripLayout(storage, 'trip-1')
  assert.equal(legacy.view, 'canvas')
  assert.equal(legacy.aiCollapsed, true, 'legacy fields still restore')

  storage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, '{corrupt')
  assert.equal(readTripLayout(storage, 'trip-1').view, 'canvas')
})

test('setWorkbenchView only flips the view field', () => {
  const base = defaultLayout()
  const listed = setWorkbenchView(base, 'list')
  assert.deepEqual(listed, { ...base, view: 'list' })
  assert.deepEqual(setWorkbenchView(listed, 'canvas'), base)
  // An out-of-vocabulary value degrades to canvas instead of corrupting state.
  assert.equal(setWorkbenchView(base, 'gallery' as never).view, 'canvas')
})
