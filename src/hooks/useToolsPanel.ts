/**
 * Tools-panel hook (ticket 14) — which dockable panel (便签/清单/图库) is open
 * for the current trip, written through to storage on every change so a
 * reload restores it (same write-through convention as useWorkbenchLayout).
 */
import { useCallback, useEffect, useState } from 'react'
import { defaultStorage, type StorageLike } from '../domain/storage'
import {
  readToolsState,
  toggleToolsPanel,
  writeToolsState,
  type ToolPanelId,
  type TripToolsState,
} from '../domain/workbenchTools'

export function useToolsPanel(tripId: string, storage: StorageLike = defaultStorage()) {
  const [state, setState] = useState<TripToolsState>(() => readToolsState(storage, tripId))

  // Switching trips restores THAT trip's remembered panel.
  useEffect(() => {
    setState(readToolsState(storage, tripId))
  }, [storage, tripId])

  const update = useCallback(
    (next: TripToolsState) => {
      writeToolsState(storage, tripId, next)
      setState(next)
    },
    [storage, tripId],
  )

  const toggle = useCallback(
    (panel: ToolPanelId) => {
      update(toggleToolsPanel(readToolsState(storage, tripId), panel))
    },
    [storage, tripId, update],
  )

  const close = useCallback(() => update({ open: null }), [update])

  return { open: state.open, toggle, close }
}
