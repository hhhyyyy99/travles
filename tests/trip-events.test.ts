import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTripUpdateEvent } from '../src/domain/tripEvents'

test('parseTripUpdateEvent accepts a committed canvas update and drops malformed payloads', () => {
  const event = parseTripUpdateEvent(
    JSON.stringify({
      id: 'trip-1:4',
      tripId: 'trip-1',
      kind: 'canvas',
      reason: 'item_moved',
      revision: 4,
      at: '2026-09-12T00:00:00.000Z',
    }),
  )
  assert.deepEqual(event, {
    id: 'trip-1:4',
    tripId: 'trip-1',
    kind: 'canvas',
    reason: 'item_moved',
    revision: 4,
    at: '2026-09-12T00:00:00.000Z',
  })
  assert.equal(parseTripUpdateEvent('{"tripId":"trip-1","kind":"canvas"}'), null)
  assert.equal(parseTripUpdateEvent('not-json'), null)
})
