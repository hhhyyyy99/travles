/**
 * Tools-panel persistence (ticket 14) — which dockable panel (便签/清单/图库,
 * or none) is open on the canvas's left edge, remembered PER TRIP.
 *
 * Kept separate from ticket 04's journey-workbench-layout-v1 file (its own
 * key, `journey-workbench-tools-v1`) so the two tickets' codecs never fight
 * over one storage entry; the codec conventions are the same as
 * workbenchLayout.ts: an injectable StorageLike, tolerant reads that never
 * throw (corrupt JSON → defaults), and writes that preserve other trips.
 */

import type { StorageLike } from './storage'

export const WORKBENCH_TOOLS_STORAGE_KEY = 'journey-workbench-tools-v1'

export type ToolPanelId = 'notes' | 'checklist' | 'gallery'

export type TripToolsState = { open: ToolPanelId | null }

export type WorkbenchToolsFile = {
  version: 1
  trips: Record<string, TripToolsState>
}

export function defaultToolsState(): TripToolsState {
  return { open: null }
}

const PANEL_IDS: ToolPanelId[] = ['notes', 'checklist', 'gallery']

function isPanelId(value: unknown): value is ToolPanelId {
  return typeof value === 'string' && (PANEL_IDS as string[]).includes(value)
}

/** Tolerant read of one trip's tools state; never throws. */
export function readToolsState(storage: StorageLike, tripId: string): TripToolsState {
  if (!tripId) return defaultToolsState()
  try {
    const raw: unknown = JSON.parse(storage.getItem(WORKBENCH_TOOLS_STORAGE_KEY) || '{}')
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultToolsState()
    const trips = (raw as Record<string, unknown>).trips
    if (trips === null || typeof trips !== 'object' || Array.isArray(trips)) return defaultToolsState()
    const open = (trips as Record<string, unknown>)[tripId]
    if (open === null || typeof open !== 'object' || Array.isArray(open)) return defaultToolsState()
    const panel = (open as Record<string, unknown>).open
    return { open: isPanelId(panel) ? panel : null }
  } catch {
    return defaultToolsState()
  }
}

/** Merge-persist one trip's tools state; other trips' entries are preserved. */
export function writeToolsState(storage: StorageLike, tripId: string, state: TripToolsState): void {
  if (!tripId) return
  let trips: Record<string, TripToolsState> = {}
  try {
    const raw: unknown = JSON.parse(storage.getItem(WORKBENCH_TOOLS_STORAGE_KEY) || '{}')
    const candidate = (raw as Record<string, unknown> | null)?.trips
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      trips = candidate as Record<string, TripToolsState>
    }
  } catch {
    trips = {}
  }
  trips[tripId] = { open: isPanelId(state.open) ? state.open : null }
  const file: WorkbenchToolsFile = { version: 1, trips }
  try {
    storage.setItem(WORKBENCH_TOOLS_STORAGE_KEY, JSON.stringify(file))
  } catch {
    // Storage refusal (private mode etc.) must never break the workbench.
  }
}

/** Pure: open (or switch to) a panel. */
export function openToolsPanel(_state: TripToolsState, panel: ToolPanelId): TripToolsState {
  return { open: panel }
}

/** Pure: close whichever panel is open. */
export function closeToolsPanel(_state: TripToolsState): TripToolsState {
  return { open: null }
}

/** Pure: toggle — clicking the active panel's rail icon closes it. */
export function toggleToolsPanel(state: TripToolsState, panel: ToolPanelId): TripToolsState {
  return state.open === panel ? closeToolsPanel(state) : openToolsPanel(state, panel)
}
