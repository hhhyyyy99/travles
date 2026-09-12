import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { TripEventHub } from '../src/trip-events/hub.js'
import { synchronizeTripSchedule } from '../src/trip-events/schedule.js'
import { MemoryDaysAdminStoreDriver } from '../src/days-admin/driver-memory.js'
import { MemoryTripStoreDriver } from '../src/trips/driver-memory.js'
import { TripRepository } from '../src/trips/repository.js'

function parseSseChunk(value: Uint8Array): { event: string; data: unknown; id?: string } {
  const text = new TextDecoder().decode(value)
  const event = text.match(/^event: (.+)$/m)?.[1] ?? 'message'
  const id = text.match(/^id: (.+)$/m)?.[1]
  const data = text.match(/^data: (.+)$/m)?.[1] ?? ''
  return { event, ...(id ? { id } : {}), data: data ? JSON.parse(data) : null }
}

async function createTrip(repository: TripRepository) {
  const result = await repository.create({ title: '事件测试', startDate: '2026-10-02', endDate: '2026-10-04' })
  if (result.ok === false) throw new Error(result.error)
  return result.trip
}

test('trip events stream delivers a ready frame and committed updates to a live subscriber', async () => {
  const repository = new TripRepository(new MemoryTripStoreDriver())
  const events = new TripEventHub()
  const daysAdmin = new MemoryDaysAdminStoreDriver()
  const trip = await createTrip(repository)
  daysAdmin.dayRows.set('d1', { id: 'd1', trip_id: trip.id, idx: 0, date: '2026-10-02', theme: '', color: '' })
  const app = await createApp({ tripRepository: repository, daysAdminStore: daysAdmin, tripEvents: events })

  const response = await app.request(`/api/trips/${trip.id}/events`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  const reader = response.body?.getReader()
  assert.ok(reader)
  if (!reader) return

  const ready = await reader.read()
  assert.equal(ready.done, false)
  assert.equal(parseSseChunk(ready.value!).event, 'ready')

  const mutation = await app.request(`/api/trips/${trip.id}/days/d1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: '已同步' }),
  })
  assert.equal(mutation.status, 200)
  const update = await reader.read()
  assert.equal(update.done, false)
  const parsed = parseSseChunk(update.value!)
  assert.equal(parsed.event, 'trip.updated')
  assert.equal(parsed.id, `${trip.id}:1`)
  assert.equal((parsed.data as { tripId: string }).tripId, trip.id)
  assert.equal((parsed.data as { kind: string }).kind, 'canvas')
  assert.equal((parsed.data as { reason: string }).reason, 'day_updated')
  assert.equal((parsed.data as { revision: number }).revision, 1)
  assert.equal(typeof (parsed.data as { at: unknown }).at, 'string')
  await reader.cancel()
})

test('synchronizeTripSchedule compacts dated rows, reindexes them, and refreshes the trip badge', async () => {
  const repository = new TripRepository(new MemoryTripStoreDriver())
  const trip = await createTrip(repository)
  const store = new MemoryDaysAdminStoreDriver()
  store.dayRows.set('d1', { id: 'd1', trip_id: trip.id, idx: 0, date: '2026-10-02', theme: '', color: '' })
  store.dayRows.set('d3', { id: 'd3', trip_id: trip.id, idx: 4, date: '2026-10-06', theme: '', color: '' })

  const updated = await synchronizeTripSchedule(repository, store, trip.id, { compactDates: true })
  assert.equal(updated?.startDate, '2026-10-02')
  assert.equal(updated?.endDate, '2026-10-03')
  assert.equal(updated?.days, 2)
  assert.deepEqual(
    [...store.dayRows.values()]
      .sort((a, b) => Number(a.idx) - Number(b.idx))
      .map((row) => ({ id: row.id, idx: row.idx, date: row.date })),
    [
      { id: 'd1', idx: 0, date: '2026-10-02' },
      { id: 'd3', idx: 1, date: '2026-10-03' },
    ],
  )
})
