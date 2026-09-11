/**
 * Workbench layout persistence (ticket 04) — which of the three columns are
 * collapsed and how wide the AI column is, remembered PER TRIP (PRD §7
 * "收起状态记忆 … 按 trip 持久化"; localStorage keyed by trip id is enough
 * for this ticket).
 *
 * Same codec convention as src/domain/storage.ts: an injectable StorageLike,
 * tolerant reads that never throw (corrupt JSON → defaults), and clamped
 * writes so a corrupted value can never produce an unusable layout.
 */

import type { StorageLike } from './storage'

export const WORKBENCH_LAYOUT_STORAGE_KEY = 'journey-workbench-layout-v1'

export type ColumnId = 'ai' | 'canvas' | 'map'

/** Center-column view (ticket 10): horizontal canvas or single-day list. */
export type WorkbenchView = 'canvas' | 'list'

/** AI column is drag-resizable; the other two have fixed widths. */
export const AI_WIDTH_MIN = 260
export const AI_WIDTH_MAX = 560
export const AI_WIDTH_DEFAULT = 340

export type TripLayout = {
  aiCollapsed: boolean
  aiWidth: number
  canvasCollapsed: boolean
  mapCollapsed: boolean
  view: WorkbenchView
}

export type WorkbenchLayoutFile = {
  version: 1
  trips: Record<string, TripLayout>
}

export function defaultLayout(): TripLayout {
  return { aiCollapsed: false, aiWidth: AI_WIDTH_DEFAULT, canvasCollapsed: false, mapCollapsed: false, view: 'canvas' }
}

/** Clamp keeps drag/resume/corrupt values inside sane bounds. */
export function clampAiWidth(width: number): number {
  if (!Number.isFinite(width)) return AI_WIDTH_DEFAULT
  return Math.min(AI_WIDTH_MAX, Math.max(AI_WIDTH_MIN, Math.round(width)))
}

/**
 * Tolerant read of one trip's layout. Never throws: missing key, corrupt
 * JSON or malformed entries degrade to the defaults. Unknown trips get the
 * defaults too.
 */
export function readTripLayout(storage: StorageLike, tripId: string): TripLayout {
  const fallback = defaultLayout()
  if (!tripId) return fallback
  try {
    const raw: unknown = JSON.parse(storage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) || '{}')
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fallback
    const trips = (raw as Record<string, unknown>).trips
    if (trips === null || typeof trips !== 'object' || Array.isArray(trips)) return fallback
    const entry = (trips as Record<string, unknown>)[tripId]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return fallback
    const record = entry as Record<string, unknown>
    return {
      aiCollapsed: record.aiCollapsed === true,
      aiWidth: clampAiWidth(typeof record.aiWidth === 'number' ? record.aiWidth : AI_WIDTH_DEFAULT),
      canvasCollapsed: record.canvasCollapsed === true,
      mapCollapsed: record.mapCollapsed === true,
      view: record.view === 'list' ? 'list' : 'canvas',
    }
  } catch {
    return fallback
  }
}

/**
 * Merge-persist one trip's layout. Never throws; other trips' entries are
 * preserved, corrupt files reset, and the result is clamped.
 */
export function writeTripLayout(storage: StorageLike, tripId: string, layout: TripLayout): void {
  if (!tripId) return
  let trips: Record<string, TripLayout> = {}
  try {
    const raw: unknown = JSON.parse(storage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) || '{}')
    const candidate = (raw as Record<string, unknown> | null)?.trips
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      trips = candidate as Record<string, TripLayout>
    }
  } catch {
    trips = {}
  }
  trips[tripId] = {
    aiCollapsed: layout.aiCollapsed === true,
    aiWidth: clampAiWidth(layout.aiWidth),
    canvasCollapsed: layout.canvasCollapsed === true,
    mapCollapsed: layout.mapCollapsed === true,
    view: layout.view === 'list' ? 'list' : 'canvas',
  }
  const file: WorkbenchLayoutFile = { version: 1, trips }
  try {
    storage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify(file))
  } catch {
    // Storage refusal (private mode etc.) must never break the workbench.
  }
}

/** Pure reducer for column toggling (unit-tested without React). */
export function toggleColumn(layout: TripLayout, column: ColumnId): TripLayout {
  switch (column) {
    case 'ai':
      return { ...layout, aiCollapsed: !layout.aiCollapsed }
    case 'canvas':
      return { ...layout, canvasCollapsed: !layout.canvasCollapsed }
    case 'map':
      return { ...layout, mapCollapsed: !layout.mapCollapsed }
  }
}

/** Pure AI-width setter for the drag handle (always clamped). */
export function resizeAiColumn(layout: TripLayout, width: number): TripLayout {
  return { ...layout, aiWidth: clampAiWidth(width) }
}

/** Pure center-column view setter (ticket 10; remembered per trip). */
export function setWorkbenchView(layout: TripLayout, view: WorkbenchView): TripLayout {
  return { ...layout, view: view === 'list' ? 'list' : 'canvas' }
}
