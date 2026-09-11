/**
 * Accommodation React context + provider (ticket 04 part A).
 *
 * Loads the authoritative state on mount from injected storage (default
 * `localStorage`), exposes `{state, actions, lastError, subscribe/onChange}`,
 * and persists on every successful mutation. Storage write failures keep the
 * current in-memory state (NO rollback — legacy keeps the change in the page),
 * set `lastError` to the exact legacy string
 * `当前浏览器未允许保存，住宿安排未改变。` and return the `{ok:false, error:'保存失败'}`
 * result to the caller.
 *
 * Mutation results keep the legacy shape (assign/update/delete/restore return
 * `{ok, changed?, dayIndices?, routeDays?, error?}`; committed mutations also
 * carry `state` and `event`). No-op mutations (`ok:true, committed:false`)
 * neither persist nor notify. Part B/C consumes this context; the provider is
 * NOT mounted in App.tsx yet (parts B/C wire it).
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  applyStays as applyStaysPure,
  createBase as createBasePure,
  deleteBase as deleteBasePure,
  replaceState as replaceStatePure,
  restoreDay as restoreDayPure,
  saveAsAlternate as saveAsAlternatePure,
  updateBase as updateBasePure,
  type AccommodationMutationResult,
  type ReplaceStateResult,
} from '../domain/accommodation'
import {
  ACCOMMODATION_WRITE_FAILURE_STATUS,
  defaultStorage,
  readState,
  writeState,
  type StorageLike,
} from '../domain/storage'
import type { AccommodationChangeEvent, AccommodationState } from '../domain/types'

/** Listener payload — the legacy notify shape: change event + current state. */
export type AccommodationChangePayload = AccommodationChangeEvent & { state: AccommodationState }

/**
 * Legacy error shape for a failed action. Callers see the same `{ok:false,
 * error}` contract the legacy API returned; `lastError` carries the exact
 * user-visible status string.
 */
export interface AccommodationActionError {
  ok: false
  error: string
}

export type AccommodationActionResult = AccommodationMutationResult | AccommodationActionError

export interface AccommodationActions {
  /** Manual create — `options.applyToNights` applies stays in the same commit. */
  createBase(input: unknown, options?: { applyToNights?: number[] }): AccommodationActionResult
  updateBase(id: string, input: unknown): AccommodationActionResult
  deleteBase(id: string): AccommodationActionResult
  /** Apply a base to nights — stays store only overrides; returns {N,N+1} routeDays. */
  applyStays(dayIndices: number[], baseId: string): AccommodationActionResult
  /** Programmatic create as a 备选 — never touches nights. */
  saveAsAlternate(input: unknown): AccommodationActionResult
  restoreDay(dayIndex: number): AccommodationActionResult
  /** Full replacement (backup restore, part C) — validates input first. */
  replaceState(input: string | unknown): ReplaceStateResult | AccommodationActionError
}

export interface AccommodationValue {
  state: AccommodationState
  actions: AccommodationActions
  /** Exact legacy status string after a storage write failure; null otherwise. */
  lastError: string | null
  /** Subscribe to change events (legacy `onChange`). Returns an unsubscribe. */
  subscribe(listener: (payload: AccommodationChangePayload) => void): () => void
  /** Legacy-name alias of `subscribe`. */
  onChange(listener: (payload: AccommodationChangePayload) => void): () => void
}

const AccommodationContext = createContext<AccommodationValue | null>(null)

export function AccommodationProvider({
  storage: storageProp,
  children,
}: {
  storage?: StorageLike
  children: ReactNode
}) {
  const [storage] = useState<StorageLike>(() => storageProp ?? defaultStorage())
  const [state, setState] = useState<AccommodationState>(() => readState(storage))
  const [lastError, setLastError] = useState<string | null>(null)
  const stateRef = useRef(state)
  const listenersRef = useRef<Set<(payload: AccommodationChangePayload) => void>>(new Set())

  /** Persist + adopt a committed state, or surface the write failure (no rollback). */
  const commit = useCallback(
    (next: AccommodationState, event: AccommodationChangeEvent): AccommodationActionError | { ok: true } => {
      const write = writeState(storage, next)
      if (!write.ok) {
        setLastError(ACCOMMODATION_WRITE_FAILURE_STATUS)
        return { ok: false, error: write.error }
      }
      stateRef.current = next
      setState(next)
      setLastError(null)
      const payload: AccommodationChangePayload = { ...event, state: next }
      listenersRef.current.forEach((listener) => listener(payload))
      return { ok: true }
    },
    [storage],
  )

  const createBase = useCallback(
    (input: unknown, options?: { applyToNights?: number[] }) => {
      const result = createBasePure(stateRef.current, input, options)
      if (result.ok && result.committed) {
        const write = commit(result.state, result.event)
        if (!write.ok) return write
      }
      return result
    },
    [commit],
  )

  const updateBase = useCallback(
    (id: string, input: unknown) => {
      const result = updateBasePure(stateRef.current, id, input)
      if (result.ok && result.committed) {
        const write = commit(result.state, result.event)
        if (!write.ok) return write
      }
      return result
    },
    [commit],
  )

  const deleteBase = useCallback(
    (id: string) => {
      const result = deleteBasePure(stateRef.current, id)
      if (result.ok && result.committed) {
        const write = commit(result.state, result.event)
        if (!write.ok) return write
      }
      return result
    },
    [commit],
  )

  const applyStays = useCallback(
    (dayIndices: number[], baseId: string) => {
      const result = applyStaysPure(stateRef.current, dayIndices, baseId)
      if (result.ok && result.committed) {
        const write = commit(result.state, result.event)
        if (!write.ok) return write
      }
      return result
    },
    [commit],
  )

  const saveAsAlternate = useCallback(
    (input: unknown) => {
      const result = saveAsAlternatePure(stateRef.current, input)
      if (result.ok && result.committed) {
        const write = commit(result.state, result.event)
        if (!write.ok) return write
      }
      return result
    },
    [commit],
  )

  const restoreDay = useCallback(
    (dayIndex: number) => {
      const result = restoreDayPure(stateRef.current, dayIndex)
      if (result.ok && result.committed) {
        const write = commit(result.state, result.event)
        if (!write.ok) return write
      }
      return result
    },
    [commit],
  )

  const replaceState = useCallback(
    (input: string | unknown) => {
      const result = replaceStatePure(stateRef.current, input)
      if (result.ok && result.committed) {
        // Legacy replaceState returns errors:[status] on write failure.
        const write = commit(result.state, result.event)
        if (!write.ok) return { ...write, errors: [ACCOMMODATION_WRITE_FAILURE_STATUS] }
      }
      return result
    },
    [commit],
  )

  const subscribe = useCallback((listener: (payload: AccommodationChangePayload) => void) => {
    listenersRef.current.add(listener)
    return () => {
      listenersRef.current.delete(listener)
    }
  }, [])

  const actions = useMemo<AccommodationActions>(
    () => ({ createBase, updateBase, deleteBase, applyStays, saveAsAlternate, restoreDay, replaceState }),
    [createBase, updateBase, deleteBase, applyStays, saveAsAlternate, restoreDay, replaceState],
  )

  const value = useMemo<AccommodationValue>(
    () => ({ state, actions, lastError, subscribe, onChange: subscribe }),
    [state, actions, lastError, subscribe],
  )

  return <AccommodationContext.Provider value={value}>{children}</AccommodationContext.Provider>
}

export function useAccommodation(): AccommodationValue {
  const value = useContext(AccommodationContext)
  if (!value) throw new Error('useAccommodation 必须在 AccommodationProvider 内使用')
  return value
}