/**
 * Workbench layout persistence tests (ticket 04) — the domain/workbenchLayout
 * codec against an in-memory StorageLike, mirroring the accommodation
 * storage tests (容错读取、永不 throw; clamped writes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AI_WIDTH_DEFAULT,
  AI_WIDTH_MAX,
  AI_WIDTH_MIN,
  WORKBENCH_LAYOUT_STORAGE_KEY,
  clampAiWidth,
  defaultLayout,
  readTripLayout,
  resizeAiColumn,
  toggleColumn,
  writeTripLayout,
} from '../src/domain/workbenchLayout'
import type { StorageLike } from '../src/domain/storage'

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

test('readTripLayout degrades to defaults for missing/corrupt state', () => {
  const empty = new MemoryStorage()
  assert.deepEqual(readTripLayout(empty, 'trip-1'), defaultLayout())

  const corrupt = new MemoryStorage()
  corrupt.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, '{not json')
  assert.deepEqual(readTripLayout(corrupt, 'trip-1'), defaultLayout())

  const wrongShape = new MemoryStorage()
  wrongShape.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify({ trips: [1, 2] }))
  assert.deepEqual(readTripLayout(wrongShape, 'trip-1'), defaultLayout())

  const badEntry = new MemoryStorage()
  badEntry.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify({ trips: { 'trip-1': { aiWidth: '宽' } } }))
  const fromBad = readTripLayout(badEntry, 'trip-1')
  assert.equal(fromBad.aiWidth, AI_WIDTH_DEFAULT)
  assert.equal(fromBad.aiCollapsed, false)
})

test('writeTripLayout persists per trip and preserves other trips', () => {
  const storage = new MemoryStorage()
  writeTripLayout(storage, 'trip-1', { aiCollapsed: true, aiWidth: 480, canvasCollapsed: false, mapCollapsed: false })
  writeTripLayout(storage, 'trip-2', { aiCollapsed: false, aiWidth: 300, canvasCollapsed: true, mapCollapsed: true })

  assert.equal(readTripLayout(storage, 'trip-1').aiCollapsed, true)
  assert.equal(readTripLayout(storage, 'trip-2').canvasCollapsed, true, 'trip-2 keeps its own state')

  // A third trip still gets the defaults.
  assert.deepEqual(readTripLayout(storage, 'trip-3'), defaultLayout())

  // Re-writing one trip does not clobber the others.
  writeTripLayout(storage, 'trip-1', { aiCollapsed: false, aiWidth: 420, canvasCollapsed: false, mapCollapsed: false })
  assert.equal(readTripLayout(storage, 'trip-2').mapCollapsed, true)
  assert.equal(readTripLayout(storage, 'trip-1').aiWidth, 420)

  // Corrupt existing file on write → resets instead of throwing.
  storage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, 'garbage')
  assert.doesNotThrow(() => writeTripLayout(storage, 'trip-1', { ...defaultLayout(), aiCollapsed: true }))
  assert.equal(readTripLayout(storage, 'trip-1').aiCollapsed, true)
})

test('clampAiWidth keeps the resizable AI column usable', () => {
  assert.equal(clampAiWidth(50), AI_WIDTH_MIN)
  assert.equal(clampAiWidth(9999), AI_WIDTH_MAX)
  assert.equal(clampAiWidth(400.4), 400)
  assert.equal(clampAiWidth(Number.NaN), AI_WIDTH_DEFAULT)
  assert.ok(AI_WIDTH_MIN < AI_WIDTH_DEFAULT && AI_WIDTH_DEFAULT < AI_WIDTH_MAX)
})

test('toggleColumn flips exactly the requested column', () => {
  const base = defaultLayout()
  const afterAi = toggleColumn(base, 'ai')
  assert.deepEqual(afterAi, { ...base, aiCollapsed: true })
  const afterCanvas = toggleColumn(base, 'canvas')
  assert.deepEqual(afterCanvas, { ...base, canvasCollapsed: true })
  const afterMap = toggleColumn(base, 'map')
  assert.deepEqual(afterMap, { ...base, mapCollapsed: true })
  // Toggling twice returns to the start.
  assert.deepEqual(toggleColumn(toggleColumn(base, 'ai'), 'ai'), base)
})

test('resizeAiColumn clamps through the reducer', () => {
  assert.equal(resizeAiColumn(defaultLayout(), 100).aiWidth, AI_WIDTH_MIN)
  assert.equal(resizeAiColumn(defaultLayout(), 560).aiWidth, AI_WIDTH_MAX)
})
