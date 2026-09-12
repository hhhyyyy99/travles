/** SSE endpoint for near-real-time trip projections. */
import { streamSSE } from 'hono/streaming'
import type { Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { TripRepository } from '../trips/repository.js'
import { TripEventHub, type TripEvent } from './hub.js'

export type TripEventRouteOptions = {
  tripRepository: TripRepository
  events: TripEventHub
}

export function registerTripEventRoutes(app: Hono<AppEnv>, options: TripEventRouteOptions): void {
  app.get('/api/trips/:id/events', async (c) => {
    const tripId = c.req.param('id')
    if ((await options.tripRepository.get(tripId)) === null) return c.json({ error: '行程不存在' }, 404)

    return streamSSE(c, async (stream) => {
      let alive = true
      let wake: (() => void) | null = null
      const queue: TripEvent[] = []
      const unsubscribe = options.events.subscribe(tripId, (event) => {
        queue.push(event)
        wake?.()
        wake = null
      })
      const heartbeat = setInterval(() => {
        // A heartbeat keeps intermediaries from treating an idle trip as a
        // dead connection without advancing the trip revision.
        wake?.()
        wake = null
      }, 20_000)

      const stop = () => {
        alive = false
        unsubscribe()
        wake?.()
        wake = null
      }
      stream.onAbort(stop)

      try {
        await stream.writeSSE({
          event: 'ready',
          id: `${tripId}:${options.events.revision(tripId)}`,
          data: JSON.stringify({ tripId, revision: options.events.revision(tripId) }),
        })

        while (alive && !stream.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
          if (!alive || stream.aborted) break
          const event = queue.shift()
          if (event) {
            await stream.writeSSE({ event: 'trip.updated', id: event.id, data: JSON.stringify(event) })
          } else {
            await stream.writeSSE({ event: 'ping', data: '{}' })
          }
        }
      } finally {
        clearInterval(heartbeat)
        unsubscribe()
      }
    })
  })
}
