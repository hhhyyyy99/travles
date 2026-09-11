/**
 * Workbench layout hook (ticket 04) — collapse/width state per trip, written
 * through to the storage backend on every change so a reload restores the
 * exact layout (PRD §7 收起状态记忆).
 */
import { useCallback, useEffect, useState } from 'react'
import { defaultStorage, type StorageLike } from '../domain/storage'
import {
  readTripLayout,
  resizeAiColumn,
  setWorkbenchView,
  toggleColumn,
  writeTripLayout,
  type ColumnId,
  type TripLayout,
  type WorkbenchView,
} from '../domain/workbenchLayout'

export function useWorkbenchLayout(tripId: string, storage: StorageLike = defaultStorage()) {
  const [layout, setLayout] = useState<TripLayout>(() => readTripLayout(storage, tripId))

  // Switching trips restores THAT trip's remembered layout.
  useEffect(() => {
    setLayout(readTripLayout(storage, tripId))
  }, [storage, tripId])

  const update = useCallback(
    (next: TripLayout) => {
      writeTripLayout(storage, tripId, next)
      setLayout(next)
    },
    [storage, tripId],
  )

  const toggle = useCallback(
    (column: ColumnId) => {
      update(toggleColumn(readTripLayout(storage, tripId), column))
    },
    [storage, tripId, update],
  )

  const resizeAi = useCallback((width: number) => update(resizeAiColumn(readTripLayout(storage, tripId), width)), [
    storage,
    tripId,
    update,
  ])

  // Center-column view (canvas/list) — remembered per trip (ticket 10).
  const setView = useCallback(
    (view: WorkbenchView) => {
      update(setWorkbenchView(readTripLayout(storage, tripId), view))
    },
    [storage, tripId, update],
  )

  return { layout, toggle, resizeAi, setView }
}
