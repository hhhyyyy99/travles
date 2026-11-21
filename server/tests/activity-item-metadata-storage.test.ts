import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readActivityItemMetadata, type ActivityItemMetadata } from '@hailar/domain'
import { createSqliteDatabase, type SqlDatabase } from '../src/db/driver.js'
import { ensureSchema } from '../src/db/schema.js'
import { MemoryWorkbenchStoreDriver } from '../src/days/driver-memory.js'
import { SqliteWorkbenchStoreDriver } from '../src/days/driver-sqlite.js'
import { readTripCanvas, mapItemRow } from '../src/days/repository.js'
import type { DayRow, ItemRow } from '../src/days/types.js'
import { MemoryContentStoreDriver } from '../src/content/driver-memory.js'
import { SqliteContentStoreDriver } from '../src/content/driver-sqlite.js'
import { TripContentRepository } from '../src/content/repository.js'
import { MemoryItemsAdminStoreDriver } from '../src/items-admin/driver-memory.js'
import { SqliteItemsAdminStoreDriver } from '../src/items-admin/driver-sqlite.js'
import { ItemsAdminRepository } from '../src/items-admin/repository.js'
import type { ItemFullUpsert } from '../src/items-admin/types.js'

const DAY: DayRow = { id: 'day', trip_id: 'trip', idx: 0, date: '', theme: '', color: '' }
const SECOND_DAY: DayRow = { ...DAY, id: 'second', idx: 1 }
const RAW: ItemRow = {
  id: 'item', trip_id: 'trip', day_id: 'day', item_order: 0, type: 'other',
  title: '09:00 Title', note: 'Note ¥200', poi: null, images: null, pending: 0,
}
const UPSERT: ItemFullUpsert = {
  id: 'item', dayId: 'day', itemOrder: 0, type: 'other', title: 'Title',
  note: 'Separate note', poiJson: null, imagesJson: null,
}

async function database(): Promise<SqlDatabase> {
  const db = createSqliteDatabase(':memory:')
  await ensureSchema(db)
  await db.run("INSERT INTO trips (id, title, created_at, updated_at) VALUES ('trip', 'Trip', '', '')")
  await db.run("INSERT INTO days (id, trip_id, idx) VALUES ('day', 'trip', 0), ('second', 'trip', 1)")
  return db
}

function assertMetadata(value: unknown, expected: ActivityItemMetadata): void {
  assert.deepEqual(readActivityItemMetadata(value), expected)
  assert.ok(value && typeof value === 'object')
  for (const key of ['timeRange', 'cost']) {
    assert.equal(Object.hasOwn(value, key), Object.hasOwn(expected, key), `${key} property presence`)
  }
}

test('all SQLite raw readers carry metadata and tolerant projections preserve text while omitting NULL and BLOB independently', async () => {
  const db = await database()
  const workbench = new SqliteWorkbenchStoreDriver(db)
  const content = new SqliteContentStoreDriver(db)
  const admin = new SqliteItemsAdminStoreDriver(db)
  const cases = [
    { timeRange: null, cost: null, expected: {} },
    { timeRange: '', cost: '  ¥50–100 /人\n', expected: { timeRange: '', cost: '  ¥50–100 /人\n' } },
    { timeRange: '  次日 01:00 JST\n', cost: '', expected: { timeRange: '  次日 01:00 JST\n', cost: '' } },
    { timeRange: new Uint8Array([1, 2]), cost: 'valid cost', expected: { cost: 'valid cost' } },
    { timeRange: 'valid time', cost: new Uint8Array([3, 4]), expected: { timeRange: 'valid time' } },
  ]
  try {
    await admin.upsertItemFull('trip', UPSERT)
    for (const entry of cases) {
      await db.run("UPDATE items SET time_range = ?, cost = ? WHERE id = 'item'", [entry.timeRange, entry.cost])
      const before = (await db.run('SELECT * FROM items')).rows
      for (const driver of [workbench, content, admin]) {
        const row = (await driver.listItemRows('trip'))[0]!
        assert.deepEqual(row.time_range, before[0]!.time_range)
        assert.deepEqual(row.cost, before[0]!.cost)
      }
      const byId = await admin.getItemRow('item')
      assert.deepEqual(byId?.time_range, before[0]!.time_range)
      assert.deepEqual(byId?.cost, before[0]!.cost)
      assertMetadata((await readTripCanvas(workbench, 'trip')).days[0]!.items[0], entry.expected)
      assertMetadata((await new TripContentRepository(content).listDays('trip'))[0]!.items[0], entry.expected)
      assertMetadata(mapItemRow(byId!), entry.expected)
      assert.deepEqual((await db.run('SELECT * FROM items')).rows, before, 'reading never writes normalized metadata back')
      const updated = await new ItemsAdminRepository(admin).updateItem('trip', 'item', { title: 'Unrelated title' })
      assert.ok(updated.ok)
      assertMetadata(updated.item, entry.expected)
      const after = (await db.run('SELECT time_range, cost FROM items')).rows[0]!
      assert.deepEqual(after.time_range, before[0]!.time_range, 'an unrelated edit preserves raw BLOB/NULL')
      assert.deepEqual(after.cost, before[0]!.cost)
    }
  } finally {
    await db.close()
  }
})

test('memory readers retain activities and independently omit missing, NULL, numeric, object, boolean, and BLOB metadata', async () => {
  const cases = [
    { raw: {}, expected: {} },
    { raw: { time_range: null, cost: 'cost' }, expected: { cost: 'cost' } },
    { raw: { time_range: 'time', cost: 42 }, expected: { timeRange: 'time' } },
    { raw: { time_range: false, cost: '' }, expected: { cost: '' } },
    { raw: { time_range: ' \n ', cost: {} }, expected: { timeRange: ' \n ' } },
    { raw: { time_range: [], cost: new Uint8Array([1]) }, expected: {} },
  ]
  for (const entry of cases) {
    const row = { ...RAW, ...entry.raw }
    const workbench = new MemoryWorkbenchStoreDriver()
    workbench.seed({ days: [DAY], items: [row] })
    const content = new MemoryContentStoreDriver()
    content.dayRows.set('day', DAY)
    content.itemRows.set('item', row)
    const admin = new MemoryItemsAdminStoreDriver()
    admin.dayRows.set('day', DAY)
    admin.itemRows.set('item', row)
    assert.deepEqual((await workbench.listItemRows('trip'))[0], row)
    assert.deepEqual((await content.listItemRows('trip'))[0], row)
    assert.deepEqual(await admin.getItemRow('item'), row)
    assertMetadata((await readTripCanvas(workbench, 'trip')).days[0]!.items[0], entry.expected)
    assertMetadata((await new TripContentRepository(content).listDays('trip'))[0]!.items[0], entry.expected)
    const result = await new ItemsAdminRepository(admin).updateItem('trip', 'item', { title: 'Changed title' })
    assert.ok(result.ok)
    assertMetadata(result.item, entry.expected)
    assert.equal(result.item.note, RAW.note)
    if (Object.hasOwn(entry.raw, 'time_range')) assert.deepEqual(admin.itemRows.get('item')?.time_range, row.time_range)
    if (Object.hasOwn(entry.raw, 'cost')) assert.deepEqual(admin.itemRows.get('item')?.cost, row.cost)
  }
})

for (const kind of ['sqlite', 'memory'] as const) {
  test(`${kind} trusted item drivers validate runtime metadata before writing and preserve omitted siblings`, async () => {
    const db = kind === 'sqlite' ? await database() : undefined
    const admin = db ? new SqliteItemsAdminStoreDriver(db) : new MemoryItemsAdminStoreDriver()
    const content = db ? new SqliteContentStoreDriver(db) : new MemoryContentStoreDriver()
    if (admin instanceof MemoryItemsAdminStoreDriver) admin.dayRows.set('day', DAY)
    if (content instanceof MemoryContentStoreDriver) content.dayRows.set('day', DAY)
    const writers = [
      { name: 'items-admin', write: (item: ItemFullUpsert) => admin.upsertItemFull('trip', item), rows: () => admin.listItemRows('trip') },
      { name: 'content', write: (item: ItemFullUpsert) => content.upsertItemRow('trip', item), rows: () => content.listItemRows('trip') },
    ]
    try {
      for (const writer of writers) {
        const base = { ...UPSERT, id: writer.name }
        await writer.write(base)
        let row = (await writer.rows()).find((entry) => entry.id === base.id)!
        assert.equal(row.time_range, null)
        assert.equal(row.cost, null)
        await writer.write({ ...base, timeRange: ' \n Time', cost: 'Cost \n ' })
        await writer.write({ ...base, title: 'Omitted fields', timeRange: undefined, cost: undefined })
        row = (await writer.rows()).find((entry) => entry.id === base.id)!
        assert.equal(row.time_range, ' \n Time')
        assert.equal(row.cost, 'Cost \n ')
        await writer.write({ ...base, timeRange: '' })
        row = (await writer.rows()).find((entry) => entry.id === base.id)!
        assert.equal(row.time_range, '')
        assert.equal(row.cost, 'Cost \n ')
        await writer.write({ ...base, cost: '' })
        row = (await writer.rows()).find((entry) => entry.id === base.id)!
        assert.equal(row.time_range, '')
        assert.equal(row.cost, '')
        for (const field of ['timeRange', 'cost']) {
          for (const invalid of [null, 42, true, [], {}, new Uint8Array([1, 2])]) {
            const before = await writer.rows()
            const invalidItem = { ...base, title: 'Must not save', [field]: invalid } as unknown as ItemFullUpsert
            await assert.rejects(writer.write(invalidItem), `${writer.name} rejects ${field}`)
            assert.deepEqual(await writer.rows(), before, 'a rejected update changes no row')
            await assert.rejects(writer.write({ ...invalidItem, id: `${base.id}-invalid-new` }))
            assert.deepEqual(await writer.rows(), before, 'a rejected create writes no row')
          }
        }
      }
    } finally {
      await db?.close()
    }
  })

  test(`${kind} item repositories preserve metadata through create, edit, copy, cross-day move and reorder`, async () => {
    const db = kind === 'sqlite' ? await database() : undefined
    const admin = db ? new SqliteItemsAdminStoreDriver(db) : new MemoryItemsAdminStoreDriver()
    if (admin instanceof MemoryItemsAdminStoreDriver) {
      admin.dayRows.set('day', DAY)
      admin.dayRows.set('second', SECOND_DAY)
    }
    const repository = new ItemsAdminRepository(admin)
    try {
      const absent = await repository.createItem('trip', { dayId: 'day', title: 'Old shape', timeRange: undefined })
      assert.ok(absent.ok)
      assertMetadata(absent.item, {})
      assert.equal((await admin.getItemRow(absent.item.id))?.time_range, null)
      assert.equal((await admin.getItemRow(absent.item.id))?.cost, null)
      const created = await repository.createItem('trip', {
        dayId: 'day', title: 'With metadata', timeRange: '  23:00–次日\n', cost: '  ¥10 /人\n', note: 'Independent note',
      })
      assert.ok(created.ok)
      const metadata = { timeRange: '  23:00–次日\n', cost: '  ¥10 /人\n' }
      assertMetadata(created.item, metadata)
      const id = created.item.id
      const titleOnly = await repository.updateItem('trip', id, { title: 'Edited', timeRange: undefined, cost: undefined })
      assert.ok(titleOnly.ok)
      assertMetadata(titleOnly.item, metadata)
      const cleared = await repository.updateItem('trip', id, { timeRange: '' })
      assert.ok(cleared.ok)
      assertMetadata(cleared.item, { timeRange: '', cost: metadata.cost })
      const updated = await repository.updateItem('trip', id, { cost: ' \n ' })
      assert.ok(updated.ok)
      assertMetadata(updated.item, { timeRange: '', cost: ' \n ' })
      const copied = await repository.copyItem('trip', id, { dayId: 'second' })
      assert.ok(copied.ok)
      assert.notEqual(copied.item.id, id)
      assertMetadata(copied.item, { timeRange: '', cost: ' \n ' })
      assert.equal(copied.item.note, 'Independent note')
      const absentCopy = await repository.copyItem('trip', absent.item.id, { dayId: 'second' })
      assert.ok(absentCopy.ok)
      assertMetadata(absentCopy.item, {})
      assert.equal((await admin.getItemRow(absentCopy.item.id))?.cost, null)
      const moved = await repository.moveItem('trip', id, { dayId: 'second', index: 0 })
      assert.ok(moved.ok)
      assertMetadata(moved.item, { timeRange: '', cost: ' \n ' })
      const reordered = await repository.moveItem('trip', id, { index: 2 })
      assert.ok(reordered.ok)
      assertMetadata(reordered.item, { timeRange: '', cost: ' \n ' })
      const row = await admin.getItemRow(id)
      assert.equal(row?.time_range, '')
      assert.equal(row?.cost, ' \n ')
      for (const field of ['timeRange', 'cost']) {
        for (const invalid of [null, 42, true, [], {}, new Uint8Array([1])]) {
          const before = await admin.listItemRows('trip')
          const invalidCreate = await repository.createItem('trip', { dayId: 'day', title: 'Reject', [field]: invalid })
          assert.equal(invalidCreate.ok, false)
          if (!invalidCreate.ok) assert.equal(invalidCreate.code, 'invalid')
          const invalidUpdate = await repository.updateItem('trip', id, { title: 'Reject', [field]: invalid })
          assert.equal(invalidUpdate.ok, false)
          if (!invalidUpdate.ok) assert.equal(invalidUpdate.code, 'invalid')
          assert.deepEqual(await admin.listItemRows('trip'), before)
        }
      }
      const nullNote = await repository.updateItem('trip', id, { note: null })
      assert.equal(nullNote.ok, false, 'the existing items-admin note:null rejection stays unchanged')
    } finally {
      await db?.close()
    }
  })

  test(`${kind} content repository rejects invalid metadata and preserves prior values on omitted or undefined upserts`, async () => {
    const db = kind === 'sqlite' ? await database() : undefined
    const driver = db ? new SqliteContentStoreDriver(db) : new MemoryContentStoreDriver()
    if (driver instanceof MemoryContentStoreDriver) driver.dayRows.set('day', DAY)
    const repository = new TripContentRepository(driver)
    const base = { id: 'content', dayId: 'day', title: 'Content' }
    try {
      assert.deepEqual(await repository.upsertItem('trip', base), { ok: true })
      assertMetadata((await repository.listDays('trip'))[0]!.items[0], {})
      assert.deepEqual(await repository.upsertItem('trip', { ...base, timeRange: '  Time\n', cost: 'Cost  ', note: 'Note' }), { ok: true })
      assert.deepEqual(await repository.upsertItem('trip', { ...base, title: 'Edited', timeRange: undefined, cost: undefined }), { ok: true })
      assertMetadata((await repository.listDays('trip'))[0]!.items[0], { timeRange: '  Time\n', cost: 'Cost  ' })
      assert.deepEqual(await repository.upsertItem('trip', { ...base, timeRange: '' }), { ok: true })
      assertMetadata((await repository.listDays('trip'))[0]!.items[0], { timeRange: '', cost: 'Cost  ' })
      assert.deepEqual(await repository.upsertItem('trip', { ...base, cost: '' }), { ok: true })
      assertMetadata((await repository.listDays('trip'))[0]!.items[0], { timeRange: '', cost: '' })
      for (const field of ['timeRange', 'cost']) {
        for (const invalid of [null, 42, true, [], {}, new Uint8Array([1])]) {
          const before = await driver.listItemRows('trip')
          for (const id of ['content', 'invalid-new']) {
            const result = await repository.upsertItem('trip', { ...base, id, title: 'Must not save', [field]: invalid })
            assert.equal(result.ok, false)
            if (!result.ok) assert.equal(result.code, 'invalid')
            assert.deepEqual(await driver.listItemRows('trip'), before)
          }
        }
      }
      assert.deepEqual(await repository.upsertItem('trip', { ...base, note: null }), { ok: true })
      assert.equal((await repository.listDays('trip'))[0]!.items[0]!.note, '', 'the legacy content note:null coercion stays unchanged')
    } finally {
      await db?.close()
    }
  })
}

test('item title-only and single-metadata updates preserve a sibling changed after the repository read', async () => {
  const db = await database()
  const backing = new SqliteItemsAdminStoreDriver(db)
  try {
    await backing.upsertItemFull('trip', { ...UPSERT, timeRange: 'Old time', cost: 'Old cost' })
    for (const patch of [{ title: 'New title' }, { timeRange: 'Explicit new time' }]) {
      const driver = new SqliteItemsAdminStoreDriver(db)
      const originalTransaction = driver.withTransaction.bind(driver)
      driver.withTransaction = async (fn) => {
        await db.run("UPDATE items SET cost = 'Concurrent cost' WHERE id = 'item'")
        return originalTransaction(fn)
      }
      const result = await new ItemsAdminRepository(driver).updateItem('trip', 'item', patch)
      assert.ok(result.ok)
      assert.equal((await backing.getItemRow('item'))?.cost, 'Concurrent cost')
      assert.equal(result.item.cost, 'Concurrent cost', 'the successful response must use the persisted sibling metadata')
      await db.run("UPDATE items SET cost = 'Old cost' WHERE id = 'item'")
    }
  } finally {
    await db.close()
  }
})

test('move responses include metadata added after loading the old layout', async () => {
  const db = await database()
  const driver = new SqliteItemsAdminStoreDriver(db)
  try {
    await driver.upsertItemFull('trip', UPSERT)
    const originalTransaction = driver.withTransaction.bind(driver)
    driver.withTransaction = async (fn) => {
      await db.run("UPDATE items SET cost = 'Concurrent cost' WHERE id = 'item'")
      return originalTransaction(fn)
    }
    const result = await new ItemsAdminRepository(driver).moveItem('trip', 'item', { dayId: 'second', index: 0 })
    assert.ok(result.ok)
    assert.equal((await driver.getItemRow('item'))?.cost, 'Concurrent cost')
    assert.equal(result.item.cost, 'Concurrent cost', 'the move response must use the persisted metadata')
  } finally {
    await db.close()
  }
})

for (const kind of ['sqlite', 'memory'] as const) {
  test(`${kind} update fails atomically when the post-write metadata row cannot be read safely`, async () => {
    const db = kind === 'sqlite' ? await database() : undefined
    const driver = db ? new SqliteItemsAdminStoreDriver(db) : new MemoryItemsAdminStoreDriver()
    if (driver instanceof MemoryItemsAdminStoreDriver) driver.dayRows.set('day', DAY)
    try {
      await driver.upsertItemFull('trip', { ...UPSERT, timeRange: 'Old time', cost: 'Old cost' })
      const before = structuredClone(await driver.listItemRows('trip'))
      const originalTransaction = driver.withTransaction.bind(driver)
      for (const failure of ['read error', 'missing', 'wrong id', 'wrong trip']) {
        let readValue: unknown
        driver.withTransaction = (fn) => originalTransaction(async (transaction) => {
          const originalRead = transaction.getItemRow
          transaction.getItemRow = async (id) => {
            const saved = await originalRead.call(transaction, id)
            readValue = saved?.time_range
            if (failure === 'read error') throw new Error('Read failed')
            if (failure === 'missing' || !saved) return null
            return { ...saved, ...(failure === 'wrong id' ? { id: 'other-item' } : { trip_id: 'other-trip' }) }
          }
          try { return await fn(transaction) } finally { transaction.getItemRow = originalRead }
        })
        const result = await new ItemsAdminRepository(driver).updateItem('trip', 'item', { timeRange: 'New time' })
        assert.equal(readValue, 'New time', 'the authoritative read occurs after the upsert')
        assert.deepEqual(result, { ok: false, error: '保存失败', code: 'storage' }, failure)
        assert.deepEqual(await driver.listItemRows('trip'), before, 'a failed authoritative read rolls back instead of returning old metadata')
      }
    } finally {
      await db?.close()
    }
  })

  test(`${kind} layout mutations roll back positions, legs and new rows when the metadata read fails`, async () => {
    const db = kind === 'sqlite' ? await database() : undefined
    const driver = db ? new SqliteItemsAdminStoreDriver(db) : new MemoryItemsAdminStoreDriver()
    if (driver instanceof MemoryItemsAdminStoreDriver) {
      driver.dayRows.set('day', DAY)
      driver.dayRows.set('second', SECOND_DAY)
    }
    try {
      await driver.upsertItemFull('trip', { ...UPSERT, timeRange: 'Time', cost: 'Cost' })
      await driver.upsertItemFull('trip', { ...UPSERT, id: 'neighbor', itemOrder: 1 })
      const repository = new ItemsAdminRepository(driver)
      assert.ok((await repository.moveItem('trip', 'item', { index: 0 })).ok)
      const snapshot = async () => structuredClone({ items: await driver.listItemRows('trip'), legs: await driver.listLegRows('trip') })
      const before = await snapshot()
      const originalTransaction = driver.withTransaction.bind(driver)
      for (const operation of ['move', 'copy', 'create']) {
        for (const failure of ['read error', 'missing', 'wrong id', 'wrong trip']) {
          const readRows: Array<ItemRow | null> = []
          driver.withTransaction = (fn) => originalTransaction(async (transaction) => {
            const originalRead = transaction.getItemRow
            transaction.getItemRow = async (id) => {
              const saved = await originalRead.call(transaction, id)
              readRows.push(saved)
              if (failure === 'read error') throw new Error('Read failed')
              if (failure === 'missing' || !saved) return null
              return { ...saved, ...(failure === 'wrong id' ? { id: 'other-item' } : { trip_id: 'other-trip' }) }
            }
            try { return await fn(transaction) } finally { transaction.getItemRow = originalRead }
          })
          const target = { dayId: 'second', index: 0 }
          const result = operation === 'move'
            ? await repository.moveItem('trip', 'item', target)
            : operation === 'copy'
              ? await repository.copyItem('trip', 'item', target)
              : await repository.createItem('trip', { ...target, title: 'Created', timeRange: '', cost: 'New cost' })
          assert.equal(readRows.length, 1)
          assert.equal(readRows[0]?.day_id, 'second', 'the authoritative read sees the completed layout write')
          assert.deepEqual(result, { ok: false, error: '保存失败', code: 'storage' }, `${operation}: ${failure}`)
          assert.deepEqual(await snapshot(), before, 'read failure rolls back row/position and leg writes together')
        }
      }
    } finally {
      await db?.close()
    }
  })
}
