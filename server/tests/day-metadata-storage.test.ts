import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteDatabase, type SqlDatabase } from '../src/db/driver.js'
import { ensureSchema, SCHEMA_STATEMENTS } from '../src/db/schema.js'
import { createApp } from '../src/app.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'
import { SqliteDaysAdminStoreDriver } from '../src/days-admin/driver-sqlite.js'
import { SqliteWorkbenchStoreDriver } from '../src/days/driver-sqlite.js'
import { SqliteItemsAdminStoreDriver } from '../src/items-admin/driver-sqlite.js'
import type { Day } from '@hailar/domain'

async function createHttpFixture() {
  const { repository, contentRepository, db } = await createSqliteTripRepository(':memory:')
  const result = await repository.create({ title: 'Metadata trip', startDate: '2026-10-02', endDate: '2026-10-03' })
  assert.ok(result.ok)
  const app = await createApp({
    tripRepository: repository,
    contentRepository,
    workbenchStore: new SqliteWorkbenchStoreDriver(db),
    daysAdminStore: new SqliteDaysAdminStoreDriver(db),
  })
  const tripId = result.trip.id
  const write = (path: string, method: string, body: Record<string, unknown>) => app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { app, db, tripId, daysPath: `/api/trips/${tripId}/days`, write }
}

async function createLegacyDays(db: SqlDatabase): Promise<void> {
  await db.run(SCHEMA_STATEMENTS[0]!)
  await db.run("INSERT INTO trips (id, title, created_at, updated_at) VALUES ('trip', 'Old trip', '2026-10-01', '2026-10-01')")
  await db.run(`CREATE TABLE days (
    id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, date TEXT, theme TEXT, color TEXT
  )`)
}

test('Day metadata round-trips through SQLite HTTP writes and all Day reads without changing item notes', async () => {
  const { app, db, tripId, daysPath, write } = await createHttpFixture()
  try {
    const created = await write(daysPath, 'POST', {
      date: '2026-10-20', theme: 'Existing theme', color: '#123456',
      title: '  Day title\n', note: '\n  Day note  \n',
    })
    assert.equal(created.status, 201)
    const { day } = await created.json() as { day: Day }
    assert.equal(day.title, '  Day title\n')
    assert.equal(day.note, '\n  Day note  \n')
    assert.equal(day.date, '2026-10-02', 'POST returns the authoritative date after schedule synchronization')
    assert.equal(day.index, 0)
    assert.equal(day.tripId, tripId)
    assert.equal(day.dayNumber, 1)
    await db.run("INSERT INTO items (id, trip_id, day_id, title, note) VALUES ('item', ?, ?, 'Item title', 'Separate item note')", [tripId, day.id])

    await db.run('UPDATE days SET idx = 9, date = ? WHERE id = ?', ['2026-10-22', day.id])
    const cleared = await write(`${daysPath}/${day.id}`, 'PATCH', { title: '' })
    assert.equal(cleared.status, 200)
    const clearedDay = (await cleared.json() as { day: Day }).day
    assert.equal(clearedDay.title, '', 'empty string explicitly clears a title')
    assert.equal(clearedDay.note, '\n  Day note  \n', 'omitted note is preserved')
    assert.equal(clearedDay.theme, 'Existing theme')
    assert.equal(clearedDay.color, '#123456')
    assert.equal(clearedDay.index, 0, 'PATCH rereads the normalized index')
    assert.equal(clearedDay.date, '2026-10-02', 'PATCH rereads the normalized date')

    const clearedNote = await write(`${daysPath}/${day.id}`, 'PATCH', { note: '' })
    assert.equal(clearedNote.status, 200)
    assert.equal((await clearedNote.json() as { day: Day }).day.note, '')
    const themeOnly = await write(`${daysPath}/${day.id}`, 'PATCH', { theme: 'Updated theme' })
    assert.equal(themeOnly.status, 200)
    const finalDay = (await themeOnly.json() as { day: Day }).day
    assert.equal(finalDay.title, '')
    assert.equal(finalDay.note, '')

    for (const path of [daysPath, `/api/trips/${tripId}/canvas`]) {
      const response = await app.request(path)
      assert.equal(response.status, 200)
      const readDay = (await response.json() as { days: Day[] }).days[0]!
      assert.equal(readDay.title, '')
      assert.equal(readDay.note, '')
      assert.equal(readDay.theme, 'Updated theme')
      assert.equal(readDay.items[0]?.note, 'Separate item note')
    }
    const itemAdminDay = (await new SqliteItemsAdminStoreDriver(db).listDayRows(tripId))[0]!
    assert.equal(itemAdminDay.title, '')
    assert.equal(itemAdminDay.note, '')
  } finally {
    await db.close()
  }
})

test('Day HTTP rejects null and other non-string metadata atomically for create and update', async () => {
  const { app, db, tripId, daysPath, write } = await createHttpFixture()
  try {
    const created = await write(daysPath, 'POST', { title: 'Original title', note: 'Original note', theme: 'Original theme' })
    assert.equal(created.status, 201)
    const originalDay = (await created.json() as { day: Day }).day
    for (const field of ['title', 'note']) {
      for (const invalid of [null, 42, true, [], {}]) {
        const otherField = field === 'title' ? 'note' : 'title'
        const payload = { [otherField]: 'Would change valid metadata', [field]: invalid, theme: 'Would change theme' }
        assert.equal((await write(daysPath, 'POST', payload)).status, 400, `create rejects ${field}=${JSON.stringify(invalid)}`)
        assert.equal((await write(`${daysPath}/${originalDay.id}`, 'PATCH', payload)).status, 400, `update rejects ${field}=${JSON.stringify(invalid)}`)
      }
    }
    assert.equal((await write(`/api/trips/another-trip/days/${originalDay.id}`, 'PATCH', { title: 'Foreign write' })).status, 404)
    const listed = await app.request(`/api/trips/${tripId}/canvas`)
    const { days } = await listed.json() as { days: Day[] }
    assert.equal(days.length, 1, 'invalid creates write no rows')
    assert.equal(days[0]?.title, 'Original title')
    assert.equal(days[0]?.note, 'Original note')
    assert.equal(days[0]?.theme, 'Original theme', 'invalid updates change no fields')
  } finally {
    await db.close()
  }
})

test('Day reads omit NULL and corrupt metadata independently while retaining days and their items', async () => {
  const { app, db, tripId, daysPath, write } = await createHttpFixture()
  try {
    const created = await write(daysPath, 'POST', {})
    assert.equal(created.status, 201)
    const day = (await created.json() as { day: Day }).day
    assert.equal(Object.hasOwn(day, 'title'), false)
    assert.equal(Object.hasOwn(day, 'note'), false)
    const initialRow = (await db.run('SELECT title, note FROM days WHERE id = ?', [day.id])).rows[0]!
    assert.equal(initialRow.title, null)
    assert.equal(initialRow.note, null)
    await db.run("INSERT INTO items (id, trip_id, day_id, title, note) VALUES ('item', ?, ?, 'Retained item', 'Retained item note')", [tripId, day.id])
    const cases = [
      { title: new Uint8Array([1, 2]), note: '  Good note\n', expected: { note: '  Good note\n' } },
      { title: '  Good title\n', note: new Uint8Array([3, 4]), expected: { title: '  Good title\n' } },
      { title: null, note: '', expected: { note: '' } },
      { title: '', note: null, expected: { title: '' } },
      { title: null, note: null, expected: {} },
    ]
    for (const entry of cases) {
      await db.run('UPDATE days SET title = ?, note = ? WHERE id = ?', [entry.title, entry.note, day.id])
      for (const path of [daysPath, `/api/trips/${tripId}/canvas`]) {
        const response = await app.request(path)
        assert.equal(response.status, 200)
        const readDays = (await response.json() as { days: Day[] }).days
        assert.equal(readDays.length, 1)
        const readDay = readDays[0]!
        assert.equal(readDay.items.length, 1)
        assert.equal(readDay.items[0]?.note, 'Retained item note')
        for (const field of ['title', 'note'] as const) {
          assert.equal(Object.hasOwn(readDay, field), Object.hasOwn(entry.expected, field))
          assert.equal(readDay[field], entry.expected[field as keyof typeof entry.expected])
        }
      }
      const response = await write(`${daysPath}/${day.id}`, 'PATCH', { theme: 'Independent theme update' })
      assert.equal(response.status, 200)
      const readDay = (await response.json() as { day: Day }).day
      for (const field of ['title', 'note'] as const) {
        assert.equal(Object.hasOwn(readDay, field), Object.hasOwn(entry.expected, field))
        assert.equal(readDay[field], entry.expected[field as keyof typeof entry.expected])
      }
    }
  } finally {
    await db.close()
  }
})

test('partial Day metadata migrations retain populated fields and add only the missing column', async () => {
  for (const existing of ['title', 'note']) {
    const db = createSqliteDatabase(':memory:')
    try {
      await createLegacyDays(db)
      await db.run(`ALTER TABLE days ADD COLUMN ${existing} TEXT`)
      await db.run(`INSERT INTO days (id, trip_id, idx, ${existing}) VALUES ('populated', 'trip', 4, ?)`, ['  Existing metadata\n'])
      await db.run(`INSERT INTO days (id, trip_id, idx, ${existing}) VALUES ('cleared', 'trip', 4, '')`)
      await ensureSchema(db)
      const missing = existing === 'title' ? 'note' : 'title'
      const rows = (await db.run('SELECT * FROM days ORDER BY id')).rows
      assert.equal(rows.length, 2)
      assert.equal(rows[0]?.[existing], '')
      assert.equal(rows[1]?.[existing], '  Existing metadata\n')
      assert.equal(rows[0]?.[missing], null)
      assert.equal(rows[1]?.[missing], null)
      assert.equal(rows[0]?.idx, 4)
      assert.equal(rows[1]?.idx, 4)
    } finally {
      await db.close()
    }
  }
})

test('legacy Day metadata migrates additively, stays NULL, and survives repeated initialization', async () => {
  const db = createSqliteDatabase(':memory:')
  try {
    await createLegacyDays(db)
    await db.run("INSERT INTO days VALUES ('old-day', 'trip', 7, '2026-10-02', 'legacy theme', '#123456')")
    await db.run("INSERT INTO days VALUES ('duplicate-index', 'trip', 7, NULL, NULL, NULL)")
    await db.run("INSERT INTO days VALUES ('sparse-index', 'trip', 19, '', 'another theme', '')")
    await db.run(SCHEMA_STATEMENTS.find((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS items'))!)
    await db.run(SCHEMA_STATEMENTS.find((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS legs'))!)
    await db.run("INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending) VALUES ('old-item', 'trip', 'old-day', 4, 'stay', 'Legacy hotel', 'Original item note', '{\"name\":\"Hotel\"}', '[]', 1)")
    await db.run("INSERT INTO items (id, trip_id, day_id, title, note) VALUES ('other-item', 'trip', 'sparse-index', 'Legacy attraction', 'Other item note')")
    await db.run("INSERT INTO legs (id, trip_id, from_item_id, to_item_id, mode, distance_km, duration_min, polyline, quality) VALUES ('old-leg', 'trip', 'old-item', 'other-item', 'drive', 12.5, 22, '[[120,50],[121,51]]', 'measured')")
    const before = await db.run("SELECT rootpage FROM sqlite_schema WHERE name = 'days'")
    const oldDays = await db.run('SELECT id, trip_id, idx, date, theme, color FROM days ORDER BY id')
    const oldItems = await db.run('SELECT * FROM items ORDER BY id')
    const oldLegs = await db.run('SELECT * FROM legs ORDER BY id')

    await ensureSchema(db)
    await ensureSchema(db)

    const columns = await db.run('PRAGMA table_info(days)')
    for (const name of ['title', 'note']) {
      const column = columns.rows.find((entry) => entry.name === name)
      assert.ok(column, `${name} exists on a migrated days table`)
      assert.equal(column.type, 'TEXT')
      assert.equal(column.notnull, 0)
      assert.equal(column.dflt_value, null)
    }
    const after = await db.run("SELECT rootpage FROM sqlite_schema WHERE name = 'days'")
    assert.deepEqual(after.rows, before.rows, 'migration keeps the original table')
    assert.deepEqual((await db.run('SELECT id, trip_id, idx, date, theme, color FROM days ORDER BY id')).rows, oldDays.rows)
    assert.deepEqual((await db.run('SELECT * FROM items ORDER BY id')).rows, oldItems.rows)
    assert.deepEqual((await db.run('SELECT * FROM legs ORDER BY id')).rows, oldLegs.rows)
    const migratedDays = await db.run('SELECT title, note FROM days')
    assert.equal(migratedDays.rows.length, 3)
    for (const row of migratedDays.rows) {
      assert.equal(row.title, null)
      assert.equal(row.note, null)
    }
  } finally {
    await db.close()
  }
})

test('concurrent schema initializers safely recheck Day columns added by another connection', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'day-metadata-concurrent-'))
  const first = createSqliteDatabase(join(directory, 'trips.db'))
  const second = createSqliteDatabase(join(directory, 'trips.db'))
  try {
    await createLegacyDays(first)
    const barriers = new Map(['title', 'note'].map((name) => {
      let release!: () => void
      const ready = new Promise<void>((resolve) => { release = resolve })
      const barrier = { arrivals: 0, ready, release }
      return [name, barrier] as const
    }))
    const synchronizeAlter = (db: SqlDatabase): SqlDatabase => ({
      ...db,
      run: async (sql, args) => {
        const name = /^ALTER TABLE days ADD COLUMN (title|note) TEXT$/i.exec(sql)?.[1]
        const barrier = name ? barriers.get(name) : undefined
        if (barrier) {
          barrier.arrivals += 1
          if (barrier.arrivals === 2) barrier.release()
          await barrier.ready
        }
        return db.run(sql, args)
      },
    })
    await Promise.all([ensureSchema(synchronizeAlter(first)), ensureSchema(synchronizeAlter(second))])
    for (const [name, barrier] of barriers) {
      assert.equal(barrier.arrivals, 2, `both initializers observed missing ${name} before either altered it`)
    }
    const columns = await first.run('PRAGMA table_info(days)')
    assert.equal(columns.rows.filter((column) => column.name === 'title').length, 1)
    assert.equal(columns.rows.filter((column) => column.name === 'note').length, 1)
    await ensureSchema(second)
  } finally {
    await first.close()
    await second.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('a real SQLite failure adding Day metadata propagates when the column remains absent', async () => {
  const db = createSqliteDatabase(':memory:')
  try {
    await createLegacyDays(db)
    const readOnlyAtMigration: SqlDatabase = {
      ...db,
      run: async (sql, args) => {
        if (/^ALTER TABLE days ADD COLUMN title TEXT$/i.test(sql)) await db.run('PRAGMA query_only = ON')
        return db.run(sql, args)
      },
    }
    await assert.rejects(ensureSchema(readOnlyAtMigration), /readonly|read-only/i)
    const columns = await db.run('PRAGMA table_info(days)')
    assert.equal(columns.rows.some((column) => column.name === 'title'), false)
    await db.run('PRAGMA query_only = OFF')
    await ensureSchema(db)
    assert.equal((await db.run('PRAGMA table_info(days)')).rows.some((column) => column.name === 'title'), true)
  } finally {
    await db.close()
  }
})
