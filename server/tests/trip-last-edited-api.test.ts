import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createApp } from '../src/app.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import type { TripSummary } from '../src/trips/types.js'

const previous = '2025-06-07T08:09:00.000Z'
const request = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

void test('only changed activity content advances the trip edit time in SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trip-last-edited-'))
  const databaseUrl = `file:${join(directory, 'trips.db')}`
  const sqlite = await createSqliteTripRepository(databaseUrl)
  try {
    await sqlite.db.run(
      `INSERT INTO trips (id, title, start_date, end_date, created_at, updated_at)
      VALUES ('target', '测试行程', '2026-11-10', '2026-11-10', ?, ?),
             ('legacy', '旧行程', '2026-11-10', '2026-11-10', ?, '')`,
      [previous, previous, previous],
    )
    await sqlite.db.run(
      "INSERT INTO days (id, trip_id, idx, date) VALUES ('day', 'target', 0, '2026-11-10')",
    )
    await sqlite.db.run(
      "INSERT INTO items (id, trip_id, day_id, title, note) VALUES ('item', 'target', 'day', '测试活动', '旧备注')",
    )
    const app = await createApp({ databaseUrl })
    const list = async () => {
      const response = await app.request('/api/trips')
      assert.equal(response.status, 200)
      return ((await response.json()) as { trips: TripSummary[] }).trips
    }
    const timestamp = async () => (await list()).find((trip) => trip.id === 'target')?.updatedAt
    const item = '/api/trips/target/items/item'
    assert.equal(await timestamp(), previous)
    assert.equal((await app.request('/api/trips/target/canvas')).status, 200)
    assert.equal(
      (await app.request(item, request('PATCH', { note: 'x'.repeat(2001) }))).status,
      400,
    )
    assert.equal((await app.request(item, request('PATCH', { note: '旧备注' }))).status, 200)
    assert.equal(await timestamp(), previous)

    const save = await app.request(item, request('PATCH', { note: '新备注' }))
    assert.equal(save.status, 200)
    assert.equal(((await save.json()) as { item: { note: string } }).item.note, '新备注')
    const editedAt = await timestamp()
    assert.ok(editedAt && Date.parse(editedAt) > Date.parse(previous))

    // Force a failure after the item UPDATE. The note and edit time must roll back together.
    await sqlite.db.run(`CREATE TRIGGER reject_edit_timestamp BEFORE UPDATE OF updated_at ON trips
      WHEN NEW.id = 'target' BEGIN SELECT RAISE(ABORT, 'test write failure'); END`)
    assert.equal((await app.request(item, request('PATCH', { note: '未保存的备注' }))).status, 500)
    const canvas = (await (await app.request('/api/trips/target/canvas')).json()) as {
      days: { items: { note: string }[] }[]
    }
    assert.equal(canvas.days[0]?.items[0]?.note, '新备注')
    assert.equal(await timestamp(), editedAt)

    for (const isPinned of [true, false]) {
      assert.equal(
        (await app.request('/api/trips/target/pin', request('PUT', { isPinned }))).status,
        200,
      )
      assert.equal(await timestamp(), editedAt)
    }
    assert.equal((await list()).find((trip) => trip.id === 'legacy')?.updatedAt, '')

    const reopened = await createSqliteTripRepository(databaseUrl)
    try {
      assert.equal((await reopened.repository.get('target'))?.updatedAt, editedAt)
      assert.equal((await reopened.contentRepository.listDays('target'))[0]?.id, 'day')
    } finally {
      await reopened.close()
    }
  } finally {
    await sqlite.close()
    await rm(directory, { recursive: true, force: true })
  }
})
