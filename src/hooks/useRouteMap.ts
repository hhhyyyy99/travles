/**
 * Map lifecycle hook (ticket 02) — owns the Leaflet instance for `#route-map`.
 *
 * - Creates the map once per mount, destroys it on unmount (StrictMode/HMR
 *   safe: `map.remove()` clears the container id, so remounts re-init fresh).
 * - Derives `tileError` state from the tile-error fallback for `#map-error`.
 * - Callbacks (`onDaySelect`, `onMapReady`) are ref-wrapped so the map is
 *   never re-created when the callbacks change identity.
 */
import { useEffect, useRef, useState } from 'react'
import { createRouteMap, type RouteMapHandle } from '../services/map'

export interface UseRouteMapOptions {
  /** Static marker click → day (choose with focus=false, legacy trip.js:138). */
  onDaySelect: (day: number) => void
  /** Fired right after the map was created — App runs the boot `choose(0); fit()`. */
  onMapReady: () => void
  /** Optional sink that receives the live handle so the owner can draw on it. */
  handleRef?: React.MutableRefObject<RouteMapHandle | null>
}

export interface RouteMapController {
  containerRef: React.RefObject<HTMLDivElement | null>
  handleRef: React.MutableRefObject<RouteMapHandle | null>
  tileError: boolean
}

export function useRouteMap(options: UseRouteMapOptions): RouteMapController {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<RouteMapHandle | null>(null)
  const [tileError, setTileError] = useState(false)

  const onDaySelectRef = useRef(options.onDaySelect)
  const onMapReadyRef = useRef(options.onMapReady)
  onDaySelectRef.current = options.onDaySelect
  onMapReadyRef.current = options.onMapReady

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let handle: RouteMapHandle | null = null
    try {
      handle = createRouteMap(container, {
        onDaySelect: (day) => onDaySelectRef.current(day),
        onTileError: setTileError,
      })
    } catch (error) {
      // Map must never break the itinerary: keep the page usable (legacy input
      // never fails because the container always exists — this is a safety net).
      console.error('[map] Leaflet 初始化失败', error)
      return
    }
    handleRef.current = handle
    if (options.handleRef) options.handleRef.current = handle
    onMapReadyRef.current()

    return () => {
      handle?.destroy()
      handleRef.current = null
      if (options.handleRef) options.handleRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { containerRef, handleRef, tileError }
}