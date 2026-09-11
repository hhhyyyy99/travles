/**
 * Workbench tools-panel persistence tests (ticket 14) — the
 * domain/workbenchTools codec against an in-memory StorageLike, mirroring the
 * workbenchLayout tests (容错读取、永不 throw; per-trip writes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WORKBENCH_TOOLS_STORAGE_KEY,
  closeToolsPanel,
  defaultToolsState,
  openToolsPanel,
  readToolsState,
  toggleToolsPanel,
  writeToolsState,
} from '../src/domain/workbenchTools'
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

test('readToolsState degrades to defaults for missing/corrupt state', () => {
  const empty = new MemoryStorage()
  assert.deepEqual(readToolsState(empty, 'trip-1'), defaultToolsState())

  const corrupt = new MemoryStorage()
  corrupt.setItem(WORKBENCH_TOOLS_STORAGE_KEY, '{not json')
  assert.deepEqual(readToolsState(corrupt, 'trip-1'), defaultToolsState())

  const wrongShape = new MemoryStorage()
  wrongShape.setItem(WORKBENCH_TOOLS_STORAGE_KEY, JSON.stringify({ trips: { 'trip-1': { open: 'map' } } }))
  assert.deepEqual(readToolsState(wrongShape, 'trip-1'), defaultToolsState(), 'unknown panel ids reset to closed')

  const badEntry = new MemoryStorage()
  badEntry.setItem(WORKBENCH_TOOLS_STORAGE_KEY, JSON.stringify({ trips: { 'trip-1': 'notes' } }))
  assert.deepEqual(readToolsState(badEntry, 'trip-1'), defaultToolsState())

  assert.deepEqual(readToolsState(empty, ''), defaultToolsState(), 'empty trip id never reads storage')
})

test('writeToolsState persists per trip and preserves other trips', () => {
  const storage = new MemoryStorage()
  writeToolsState(storage, 'trip-1', { open: 'notes' })
  writeToolsState(storage, 'trip-2', { open: 'gallery' })

  assert.equal(readToolsState(storage, 'trip-1').open, 'notes')
  assert.equal(readToolsState(storage, 'trip-2').open, 'gallery')
  assert.deepEqual(readToolsState(storage, 'trip-3'), defaultToolsState())

  // Closing one trip does not clobber the others; unknown panels never persist.
  writeToolsState(storage, 'trip-1', { open: null })
  assert.equal(readToolsState(storage, 'trip-1').open, null)
  assert.equal(readToolsState(storage, 'trip-2').open, 'gallery')
  writeToolsState(storage, 'trip-2', { open: 'cheat' as never })
  assert.equal(readToolsState(storage, 'trip-2').open, null)

  // Corrupt existing file on write → resets instead of throwing.
  storage.setItem(WORKBENCH_TOOLS_STORAGE_KEY, 'garbage')
  assert.doesNotThrow(() => writeToolsState(storage, 'trip-1', { open: 'checklist' }))
  assert.equal(readToolsState(storage, 'trip-1').open, 'checklist')
})

test('open/close/toggle reducers', () => {
  const closed = defaultToolsState()
  assert.deepEqual(openToolsPanel(closed, 'checklist'), { open: 'checklist' })
  assert.deepEqual(closeToolsPanel({ open: 'notes' }), { open: null })
  assert.deepEqual(toggleToolsPanel({ open: 'notes' }, 'notes'), { open: null }, 'clicking the active tool closes')
  assert.deepEqual(toggleToolsPanel({ open: 'notes' }, 'gallery'), { open: 'gallery' }, 'switching panels')
})
