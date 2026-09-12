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
  /** Called after EventSource reconnects with the server's current revision. */
  onReconnect?: (revision: number) => void
  onError?: () => void
}

export type TripReadyEvent = {
  tripId: string
  revision: number
}

export function parseTripReadyEvent(raw: unknown): TripReadyEvent | null {
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
  const tripId = typeof record.tripId === 'string' ? record.tripId : ''
  const revision = typeof record.revision === 'number' && Number.isInteger(record.revision) ? record.revision : 0
  if (!tripId || revision < 0) return null
  return { tripId, revision }
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
  let connected = false
  let hadError = false
  const ready = (event: Event) => {
    const parsed = parseTripReadyEvent((event as MessageEvent).data)
    if (!parsed || parsed.tripId !== tripId) return
    // The first ready event establishes the baseline. A ready event after an
    // error means the stream recovered; the revision may include updates that
    // were published while this browser was offline, so refresh projections.
    const reconnected = connected || hadError
    connected = true
    hadError = false
    if (reconnected) handlers.onReconnect?.(parsed.revision)
  }
  const update = (event: Event) => {
    const parsed = parseTripUpdateEvent((event as MessageEvent).data)
    if (parsed && parsed.tripId === tripId) handlers.onUpdate?.(parsed)
  }
  source.addEventListener('ready', ready)
  source.addEventListener('trip.updated', update)
  source.onerror = () => {
    hadError = true
    handlers.onError?.()
  }

  return () => {
    source.removeEventListener('ready', ready)
    source.removeEventListener('trip.updated', update)
    source.close()
  }
}
