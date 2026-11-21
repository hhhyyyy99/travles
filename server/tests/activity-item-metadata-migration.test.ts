import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createSqliteDatabase, type SqlDatabase } from '../src/db/driver.js'
import { ensureSchema, SCHEMA_STATEMENTS } from '../src/db/schema.js'

async function createLegacyItems(db: SqlDatabase): Promise<void> {
  for (const table of ['trips', 'days', 'legs']) {
    await db.run(SCHEMA_STATEMENTS.find((sql) => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`))!)
  }
  await db.run("INSERT INTO trips (id, title, created_at, updated_at) VALUES ('trip', 'Old trip', '2026-10-01', '2026-10-01')")
  await db.run("INSERT INTO days (id, trip_id, idx, theme, title, note) VALUES ('day', 'trip', 7, 'Theme', 'Day title', 'Day note')")
  await db.run(`CREATE TABLE items (
    id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    day_id TEXT NOT NULL REFERENCES days(id) ON DELETE CASCADE,
    item_order INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL DEFAULT '', note TEXT, poi TEXT, images TEXT,
    pending INTEGER NOT NULL DEFAULT 0
  )`)
  await db.run(`INSERT INTO items (id, trip_id, day_id, item_order, type, title, note, poi, images, pending)
    VALUES ('old', 'trip', 'day', 4, 'stay', '09:00 legacy title', 'Legacy note ¥200', '{"name":"Hotel"}', '[]', 1)`)
  await db.run("INSERT INTO legs (id, trip_id, from_item_id, to_item_id, distance_km, duration_min, quality) VALUES ('leg', 'trip', 'old', 'old', 12, 20, 'reference')")
}

test('fresh and legacy item metadata columns are nullable TEXT without defaults, backfill, or table rebuild', async () => {
  for (const legacy of [false, true]) {
    const db = createSqliteDatabase(':memory:')
    try {
      if (legacy) await createLegacyItems(db)
      else await ensureSchema(db)
      const before = legacy ? {
        root: (await db.run("SELECT rootpage FROM sqlite_schema WHERE name = 'items'")).rows,
        items: (await db.run('SELECT id, trip_id, day_id, item_order, type, title, note, poi, images, pending FROM items')).rows,
        days: (await db.run('SELECT * FROM days')).rows,
        legs: (await db.run('SELECT * FROM legs')).rows,
      } : undefined
      await ensureSchema(db)
      await ensureSchema(db)
      const columns = (await db.run('PRAGMA table_info(items)')).rows
      for (const name of ['time_range', 'cost']) {
        const column = columns.find((row) => row.name === name)
        assert.ok(column)
        assert.equal(column.type, 'TEXT')
        assert.equal(column.notnull, 0)
        assert.equal(column.dflt_value, null)
      }
      if (before) {
        assert.deepEqual((await db.run("SELECT rootpage FROM sqlite_schema WHERE name = 'items'")).rows, before.root)
        assert.deepEqual((await db.run('SELECT id, trip_id, day_id, item_order, type, title, note, poi, images, pending FROM items')).rows, before.items)
        assert.deepEqual((await db.run('SELECT * FROM days')).rows, before.days)
        assert.deepEqual((await db.run('SELECT * FROM legs')).rows, before.legs)
        const row = (await db.run("SELECT time_range, cost FROM items WHERE id = 'old'")).rows[0]!
        assert.equal(row.time_range, null, 'a title containing a time does not populate metadata')
        assert.equal(row.cost, null, 'a note containing a cost does not populate metadata')
      }
    } finally {
      await db.close()
    }
  }
})

test('partial item metadata migrations keep populated text, empty strings, and BLOBs untouched', async () => {
  for (const existing of ['time_range', 'cost']) {
    const db = createSqliteDatabase(':memory:')
    try {
      await createLegacyItems(db)
      await db.run(`ALTER TABLE items ADD COLUMN ${existing} TEXT`)
      await db.run(`UPDATE items SET ${existing} = ? WHERE id = 'old'`, ['  Existing\n'])
      await db.run(`INSERT INTO items (id, trip_id, day_id, ${existing}) VALUES ('empty', 'trip', 'day', '')`)
      await db.run(`INSERT INTO items (id, trip_id, day_id, ${existing}) VALUES ('blob', 'trip', 'day', ?)`, [new Uint8Array([1, 2, 3])])
      const before = (await db.run(`SELECT id, ${existing}, typeof(${existing}) AS storage_type FROM items ORDER BY id`)).rows
      await ensureSchema(db)
      await ensureSchema(db)
      assert.deepEqual((await db.run(`SELECT id, ${existing}, typeof(${existing}) AS storage_type FROM items ORDER BY id`)).rows, before)
      const missing = existing === 'time_range' ? 'cost' : 'time_range'
      for (const row of (await db.run(`SELECT ${missing} FROM items`)).rows) assert.equal(row[missing], null)
    } finally {
      await db.close()
    }
  }
})

test('concurrent item metadata migrations recheck columns created by the other SQLite connection', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'activity-item-metadata-'))
  const first = createSqliteDatabase(join(directory, 'trips.db'))
  const second = createSqliteDatabase(join(directory, 'trips.db'))
  try {
    await createLegacyItems(first)
    const barriers = new Map(['time_range', 'cost'].map((name) => {
      let release!: () => void
      const ready = new Promise<void>((resolveReady) => { release = resolveReady })
      const barrier = { arrivals: 0, ready, release }
      return [name, barrier] as const
    }))
    const synchronize = (db: SqlDatabase): SqlDatabase => ({
      ...db,
      run: async (sql, args) => {
        const name = /^ALTER TABLE items ADD COLUMN (time_range|cost) TEXT$/i.exec(sql)?.[1]
        const barrier = name ? barriers.get(name) : undefined
        if (barrier) {
          barrier.arrivals += 1
          if (barrier.arrivals === 2) barrier.release()
          await barrier.ready
        }
        return db.run(sql, args)
      },
    })
    await Promise.all([ensureSchema(synchronize(first)), ensureSchema(synchronize(second))])
    const columns = (await first.run('PRAGMA table_info(items)')).rows
    for (const [name, barrier] of barriers) {
      assert.equal(barrier.arrivals, 2, `both initializers first observe missing ${name}`)
      assert.equal(columns.filter((column) => column.name === name).length, 1)
    }
  } finally {
    await first.close()
    await second.close()
    assert.equal(resolve(directory).startsWith(`${resolve(tmpdir())}/activity-item-metadata-`), true)
    await rm(directory, { recursive: true, force: true })
  }
})

test('real SQLite ALTER failure propagates while item metadata remains absent', async () => {
  const db = createSqliteDatabase(':memory:')
  try {
    await createLegacyItems(db)
    const readOnlyAtMigration: SqlDatabase = {
      ...db,
      run: async (sql, args) => {
        if (/^ALTER TABLE items ADD COLUMN time_range TEXT$/i.test(sql)) await db.run('PRAGMA query_only = ON')
        return db.run(sql, args)
      },
    }
    await assert.rejects(ensureSchema(readOnlyAtMigration), /readonly|read-only/i)
    assert.equal((await db.run('PRAGMA table_info(items)')).rows.some((column) => column.name === 'time_range'), false)
    await db.run('PRAGMA query_only = OFF')
    await ensureSchema(db)
    assert.equal((await db.run('PRAGMA table_info(items)')).rows.some((column) => column.name === 'time_range'), true)
  } finally {
    await db.close()
  }
})
