/**
 * Process-local trip change bus used by the workbench SSE subscription.
 *
 * The application currently uses one Node process, so a small in-memory bus is
 * enough to fan out committed changes to every browser connected to that
 * process. The payload carries a monotonic per-trip revision; clients always
 * refetch the authoritative projection after receiving it.
 */

export type TripEventKind = 'canvas' | 'chat' | 'trip'

export type TripEvent = {
  id: string
  tripId: string
  kind: TripEventKind
  reason: string
  revision: number
  at: string
}

type Listener = (event: TripEvent) => void

export class TripEventHub {
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly revisions = new Map<string, number>()

  subscribe(tripId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(tripId) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(tripId, listeners)

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(tripId)
    }
  }

  publish(tripId: string, kind: TripEventKind, reason: string): TripEvent {
    const revision = (this.revisions.get(tripId) ?? 0) + 1
    this.revisions.set(tripId, revision)
    const event: TripEvent = {
      id: `${tripId}:${revision}`,
      tripId,
      kind,
      reason,
      revision,
      at: new Date().toISOString(),
    }
    for (const listener of this.listeners.get(tripId) ?? []) {
      try {
        listener(event)
      } catch {
        // One disconnected subscriber must not prevent other browsers from
        // receiving the same committed change.
      }
    }
    return event
  }

  revision(tripId: string): number {
    return this.revisions.get(tripId) ?? 0
  }
}
