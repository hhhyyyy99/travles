/** Client for the trip-level SSE change stream used by the workbench. */

export type TripEventKind = 'canvas' | 'chat' | 'trip'

export type TripUpdateEvent = {
  id: string
  tripId: string
  kind: TripEventKind
  reason: string
  revision: number
  at: string
}

export type TripEventHandlers = {
  onUpdate?: (event: TripUpdateEvent) => void
  onError?: () => void
}

/** Parse an SSE `trip.updated` payload; malformed events are ignored. */
export function parseTripUpdateEvent(raw: unknown): TripUpdateEvent | null {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const tripId = typeof record.tripId === 'string' ? record.tripId : ''
  const kind = record.kind === 'canvas' || record.kind === 'chat' || record.kind === 'trip' ? record.kind : null
  const revision = typeof record.revision === 'number' && Number.isInteger(record.revision) ? record.revision : 0
  if (!id || !tripId || kind === null || revision < 1) return null
  return {
    id,
    tripId,
    kind,
    reason: typeof record.reason === 'string' ? record.reason : '',
    revision,
    at: typeof record.at === 'string' ? record.at : '',
  }
}

/**
 * Subscribe to committed changes for one trip. EventSource reconnects on a
 * transient network error; callers close the returned subscription on unmount.
 */
export function subscribeTripEvents(tripId: string, handlers: TripEventHandlers = {}): () => void {
  if (!tripId || typeof window === 'undefined' || typeof EventSource === 'undefined') return () => {}

  const source = new EventSource(`/api/trips/${encodeURIComponent(tripId)}/events`)
  const update = (event: Event) => {
    const parsed = parseTripUpdateEvent((event as MessageEvent).data)
    if (parsed && parsed.tripId === tripId) handlers.onUpdate?.(parsed)
  }
  source.addEventListener('trip.updated', update)
  source.onerror = () => handlers.onError?.()

  return () => {
    source.removeEventListener('trip.updated', update)
    source.close()
  }
}
