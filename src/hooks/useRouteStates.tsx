/**
 * RouteStates React context (ticket 03) — the single consumer-visible route
 * status store. The AMap live controller writes through the same API, so React
 * components (day-detail links, legend, overview) never duplicate route state.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { tripPlan } from '../data/itinerary'
import type { RouteStatus } from '../domain/types'
import {
  beginRequest as beginRequestPure,
  createInitialRouteStates,
  markRouteStatus as markRouteStatusPure,
  routeStateOrDefault,
  type RouteState,
  type RouteStateDetails,
} from '../domain/routeStates'

export interface RouteStatesValue {
  states: Record<number, RouteState>
  get(day: number): RouteState
  /** Single status writer (port of accommodation `markRouteStatus`). */
  markRouteStatus(dayIndices: number[], status: RouteStatus, details?: RouteStateDetails, expectedToken?: number): void
  /** Pending transition (bumps the per-day token). */
  beginRequest(dayIndices: number[]): void
}

const RouteStatesContext = createContext<RouteStatesValue | null>(null)

export function RouteStatesProvider({ children }: { children: ReactNode }) {
  const [states, setStates] = useState<Record<number, RouteState>>(() =>
    createInitialRouteStates(tripPlan.days.length),
  )

  const markRouteStatus = useCallback(
    (dayIndices: number[], status: RouteStatus, details: RouteStateDetails = {}, expectedToken?: number) => {
      setStates((prev) => markRouteStatusPure(prev, dayIndices, status, details, expectedToken))
    },
    [],
  )

  const beginRequest = useCallback((dayIndices: number[]) => {
    setStates((prev) => beginRequestPure(prev, dayIndices))
  }, [])

  const get = useCallback((day: number) => routeStateOrDefault(states, day), [states])

  const value = useMemo<RouteStatesValue>(
    () => ({ states, get, markRouteStatus, beginRequest }),
    [states, get, markRouteStatus, beginRequest],
  )

  return <RouteStatesContext.Provider value={value}>{children}</RouteStatesContext.Provider>
}

export function useRouteStates(): RouteStatesValue {
  const value = useContext(RouteStatesContext)
  if (!value) throw new Error('useRouteStates 必须在 RouteStatesProvider 内使用')
  return value
}