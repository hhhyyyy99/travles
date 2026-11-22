import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { applyTripPatch } from '../src/trip-patch/apply.js'
import { MemoryTripPatchStore } from '../src/trip-patch/store-memory.js'
import { SqliteTripPatchStore } from '../src/trip-patch/store-sqlite.js'
import { createSqliteTripRepository } from '../src/trips/factory.js'

async function fixture(t: TestContext, backend: 'SQLite' | 'memory') {
  const sqlite = await createSqliteTripRepository(':memory:')
  t.after(() => sqlite.close())
  const created = await sqlite.repository.create({ title: '候选入日程', startDate: '2026-10-02', endDate: '2026-10-03' })
  assert.ok(created.ok)
  return { ...sqlite, tripId: created.trip.id, store: backend === 'SQLite' ? new SqliteTripPatchStore(sqlite.db) : new MemoryTripPatchStore() }
}

const recommendation = {
  id: 'poi-source', amapId: 'provider-id', name: '旧 POI 名称', lat: 49.2, lng: 119.7,
  category: '餐饮标签', type: 'attraction', region: '海拉尔', rating: 4.5,
  introSummary: '旧 POI 简介', address: '地址', images: [{ url: '/stash-image.jpg', caption: '候选图片' }],
}

test('SQLite saves a stash-only patch despite existing accommodation conflicts', async (t) => {
  const { store, tripId } = await fixture(t, 'SQLite')
  await store.upsertDayRow(tripId, { id: 'day', idx: 0, date: '2026-10-02', theme: '' })
  for (const itemOrder of [0, 1]) {
    await store.upsertItemRow(tripId, {
      id: `stay-${itemOrder}`, dayId: 'day', itemOrder, type: 'stay', title: `住宿 ${itemOrder}`,
      note: '', poi: null, pending: true,
    })
  }
  const before = await store.listItemRows(tripId)

  const result = await applyTripPatch(store, tripId, { ops: [
    { op: 'add_stash', stashId: 'idea', title: '雨天备选' },
  ] })
  assert.ok(result.ok, result.ok ? undefined : result.error)
  assert.deepEqual((await store.listStashRows(tripId)).map((row) => row.id), ['idea'])
  assert.deepEqual(await store.listItemRows(tripId), before)

  const mixed = await applyTripPatch(store, tripId, { ops: [
    { op: 'add_stash', stashId: 'another-idea', title: '另一个候选' },
    { op: 'update_day', dayId: 'day', theme: '修改日程' },
  ] })
  assert.equal(mixed.ok, false)
  if (!mixed.ok) assert.match(mixed.error, /每天最多一个过夜住宿/)
  assert.deepEqual((await store.listStashRows(tripId)).map((row) => row.id), ['idea'])
})

for (const backend of ['SQLite', 'memory'] as const) {
  test(`${backend} add_stash followed by move consumes the caller id and copies explicit content and images`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    const result = await applyTripPatch(store, tripId, { ops: [
      { op: 'add_stash', stashId: 'caller-stash', title: '  自定标题  ', note: '  原始备注\n下一行  ', category: '任意分类', poi: recommendation, createdAt: 'caller-time' },
      { op: 'add_day', dayId: 'target', date: '2026-10-02', title: '整日标题', note: '整日备注' },
      { op: 'move_stash_to_day', stashId: 'caller-stash', itemId: 'scheduled', dayId: 'target', type: 'dining', timeRange: '  午后  ', cost: '' },
    ] })
    assert.ok(result.ok, result.ok ? undefined : result.error)
    assert.equal(result.stats.stashAdded, 1)
    assert.equal(result.stats.stashMoved, 1)
    assert.equal(result.stats.itemsAdded, 1)
    assert.match(result.summary, /新增 1 个候选.*将 1 个候选移入日程/)
    assert.deepEqual(await store.listStashRows(tripId), [])
    const [item] = await store.listItemRows(tripId)
    assert.equal(item?.id, 'scheduled')
    assert.equal(item?.title, '  自定标题  ')
    assert.equal(item?.note, '  原始备注\n下一行  ')
    assert.equal(item?.type, 'food')
    assert.equal(item?.time_range, '  午后  ')
    assert.equal(item?.cost, '')
    assert.deepEqual(JSON.parse(String(item?.images)), recommendation.images)
    assert.equal(JSON.parse(String(item?.poi)).name, recommendation.name)
  })

  test(`${backend} out-of-range POI coordinates cannot enter activities through add_stash and move`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    assert.ok((await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'target', title: '保留标题', note: '保留整日备注' },
      { op: 'add_item', itemId: 'existing', dayId: 'target', type: 'attraction', title: '保留活动', poi: { name: '保留地点', lat: 49, lng: 119 } },
      { op: 'add_stash', stashId: 'existing-stash', title: '保留候选' },
    ] })).ok)
    const snapshot = async () => structuredClone({
      days: await store.listDayRows(tripId), items: await store.listItemRows(tripId),
      stash: await store.listStashRows(tripId), legs: await store.listLegRows(tripId),
    })
    const before = await snapshot()
    for (const coords of [{ lat: -91 }, { lat: 91 }, { lng: -181 }, { lng: 181 }]) {
      const result = await applyTripPatch(store, tripId, { ops: [
        { op: 'update_day', dayId: 'target', title: '不应先写入' },
        { op: 'add_stash', stashId: 'invalid-coordinates', title: '无效地点', poi: { ...recommendation, ...coords } },
        { op: 'move_stash_to_day', stashId: 'invalid-coordinates', itemId: 'not-scheduled', dayId: 'target' },
      ] })
      assert.equal(result.ok, false, JSON.stringify(coords))
      if (!result.ok) {
        assert.equal(result.code, 'invalid')
        assert.match(result.error, /patch 结构无效：ops\.1\.poi\.(lat|lng)/)
      }
      assert.deepEqual(await snapshot(), before)
    }
  })

  test(`${backend} existing legacy POI candidates retain long titles, default type, note and images`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    const longName = '旧'.repeat(120)
    await store.insertStashRow(tripId, { id: 'legacy', poi: JSON.stringify({ ...recommendation, name: longName }), origin: 'favorite', addedAt: '2025-01-01' })
    assert.ok((await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'target' },
      { op: 'move_stash_to_day', stashId: 'legacy', itemId: 'legacy-item', dayId: 'target' },
    ] })).ok)
    const [item] = await store.listItemRows(tripId)
    assert.equal(item?.title, longName)
    assert.equal(item?.note, recommendation.address)
    assert.equal(item?.type, 'attraction', 'category is not an activity type')
    assert.deepEqual(JSON.parse(String(item?.images)), recommendation.images)
    assert.deepEqual(await store.listStashRows(tripId), [])
  })

  test(`${backend} text candidates keep null POI, use other, and require a pending adjacency declaration`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    assert.ok((await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'target' },
      { op: 'add_item', itemId: 'existing', dayId: 'target', type: 'attraction', title: '景点', poi: { name: '景点', lat: 1, lng: 1 } },
      { op: 'add_stash', stashId: 'text', title: '  自由活动  ', note: '', category: '住宿' },
    ] })).ok)
    const before = structuredClone(await store.listStashRows(tripId))
    const denied = await applyTripPatch(store, tripId, { ops: [
      { op: 'move_stash_to_day', stashId: 'text', itemId: 'text-item', dayId: 'target' },
    ] })
    assert.equal(denied.ok, false)
    if (!denied.ok) assert.match(denied.error, /缺少坐标且未标记待定/)
    assert.deepEqual(await store.listStashRows(tripId), before)
    for (const flag of ['pending', 'legPending']) {
      const candidate = `text-${flag}`
      const result = await applyTripPatch(store, tripId, { ops: [
        { op: 'add_stash', stashId: candidate, title: '自由活动', category: '住宿' },
        { op: 'move_stash_to_day', stashId: candidate, itemId: `item-${flag}`, dayId: 'target', [flag]: true },
      ] })
      assert.ok(result.ok, result.ok ? undefined : result.error)
      const item = (await store.listItemRows(tripId)).find((row) => row.id === `item-${flag}`)
      assert.equal(item?.poi, null)
      assert.equal(item?.type, 'other')
      assert.equal(item?.note, '')
    }
    assert.equal((await store.listLegRows(tripId)).length, 2)
    assert.ok((await store.listLegRows(tripId)).every((leg) => leg.quality === 'pending'))
    assert.deepEqual(await store.listStashRows(tripId), before)
  })

  test(`${backend} missing, already consumed, and cross-trip candidates cannot mutate the itinerary`, async (t) => {
    const { store, tripId, repository } = await fixture(t, backend)
    const other = await repository.create({ title: '别的行程', startDate: '2026-10-02', endDate: '2026-10-03' })
    assert.ok(other.ok)
    await store.insertStashRow(other.trip.id, { id: 'foreign', title: '别的候选', poi: 'null', origin: 'recommend', addedAt: 'old' })
    for (const stashId of ['missing', 'foreign']) {
      const result = await applyTripPatch(store, tripId, { ops: [
        { op: 'add_day', dayId: 'not-created' },
        { op: 'move_stash_to_day', stashId, itemId: 'not-created-item', dayId: 'not-created' },
      ] })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'invalid')
      assert.deepEqual(await store.listDayRows(tripId), [])
      assert.deepEqual(await store.listItemRows(tripId), [])
      assert.equal((await store.listStashRows(other.trip.id)).length, 1)
    }
    const twice = await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'not-created' },
      { op: 'add_stash', stashId: 'once', title: '只能移动一次' },
      { op: 'move_stash_to_day', stashId: 'once', itemId: 'first', dayId: 'not-created' },
      { op: 'move_stash_to_day', stashId: 'once', itemId: 'second', dayId: 'not-created', pending: true },
    ] })
    assert.equal(twice.ok, false)
    assert.deepEqual(await store.listDayRows(tripId), [])
    assert.deepEqual(await store.listStashRows(tripId), [])
  })

  test(`${backend} candidate creation generates one server timestamp and raw snapshot rows preserve content`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    const before = Date.now()
    const result = await applyTripPatch(store, tripId, { ops: [
      { op: 'add_stash', stashId: 'timestamp', title: '标题', note: '  原文\n ', category: '任意', poi: null, createdAt: 'forged', addedAt: 'forged' },
    ] })
    assert.ok(result.ok, result.ok ? undefined : result.error)
    const [row] = await store.listStashRows(tripId)
    assert.equal(row?.created_at, row?.added_at)
    assert.ok(Date.parse(String(row?.created_at)) >= before)
    assert.ok(Date.parse(String(row?.created_at)) <= Date.now())
    assert.equal(row?.title, '标题')
    assert.equal(row?.note, '  原文\n ')
    assert.equal(row?.poi, 'null')
  })

  test(`${backend} globally fresh ids cannot be recycled by adding and removing in the same patch`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    const cases = [
      [
        { op: 'add_day', dayId: 'reused' }, { op: 'remove_day', dayId: 'reused' }, { op: 'add_day', dayId: 'reused' },
      ],
      [
        { op: 'add_day', dayId: 'target' },
        { op: 'add_item', itemId: 'reused', dayId: 'target', type: 'other', title: 'A' },
        { op: 'remove_item', itemId: 'reused' },
        { op: 'add_stash', stashId: 'source', title: 'B' },
        { op: 'move_stash_to_day', stashId: 'source', itemId: 'reused', dayId: 'target' },
      ],
      [
        { op: 'add_day', dayId: 'target' },
        { op: 'add_stash', stashId: 'reused', title: 'A' },
        { op: 'move_stash_to_day', stashId: 'reused', itemId: 'scheduled', dayId: 'target' },
        { op: 'add_stash', stashId: 'reused', title: 'B' },
      ],
    ]
    for (const ops of cases) {
      const result = await applyTripPatch(store, tripId, { ops })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /重复创建/)
      assert.deepEqual(await store.listDayRows(tripId), [])
      assert.deepEqual(await store.listItemRows(tripId), [])
      assert.deepEqual(await store.listStashRows(tripId), [])
    }
    // Rows occupied when the transaction began remain reserved after removal.
    assert.ok((await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'existing-day' },
      { op: 'add_item', itemId: 'existing-item', dayId: 'existing-day', type: 'other', title: '原卡片' },
    ] })).ok)
    const result = await applyTripPatch(store, tripId, { ops: [
      { op: 'remove_item', itemId: 'existing-item' },
      { op: 'add_item', itemId: 'existing-item', dayId: 'existing-day', type: 'other', title: '替代卡片' },
    ] })
    assert.equal(result.ok, false)
    assert.equal((await store.listItemRows(tripId))[0]?.title, '原卡片')
  })

  test(`${backend} failure while rebuilding legs restores all days, items, stash and previous legs`, async (t) => {
    const { store, tripId, db } = await fixture(t, backend)
    assert.ok((await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'original', date: '2026-10-02', title: '保留标题', note: '保留整日备注' },
      { op: 'add_item', itemId: 'a', dayId: 'original', type: 'attraction', title: 'A', timeRange: '上午', cost: '免费', poi: { name: 'A', lat: 1, lng: 1 } },
      { op: 'add_item', itemId: 'b', dayId: 'original', type: 'food', title: 'B', poi: { name: 'B', lat: 2, lng: 2 } },
      { op: 'add_stash', stashId: 'original-stash', title: '保留候选', note: '保留候选备注', poi: recommendation },
    ] })).ok)
    const snapshot = async () => structuredClone({
      days: await store.listDayRows(tripId), items: await store.listItemRows(tripId),
      stash: await store.listStashRows(tripId), legs: await store.listLegRows(tripId),
    })
    const before = await snapshot()
    if (store instanceof MemoryTripPatchStore) {
      store.upsertLegRow = async () => { throw new Error('late leg storage failure') }
    } else {
      await db.run("CREATE TRIGGER reject_leg BEFORE INSERT ON legs BEGIN SELECT RAISE(ABORT, 'late leg storage failure'); END")
    }
    const result = await applyTripPatch(store, tripId, { ops: [
      { op: 'update_day', dayId: 'original', title: '不应留下' },
      { op: 'update_item', itemId: 'a', cost: '不应留下' },
      { op: 'add_day', dayId: 'new-day', date: '2026-10-03' },
      { op: 'move_stash_to_day', stashId: 'original-stash', itemId: 'scheduled', dayId: 'new-day' },
      { op: 'add_stash', stashId: 'temporary-stash', title: '不应留下' },
    ] })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'storage')
    assert.deepEqual(await snapshot(), before)
  })

  test(`${backend} valid create, update and remove combinations replay sequentially`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    const result = await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'temporary-day' },
      { op: 'update_day', dayId: 'temporary-day', title: '暂时标题' },
      { op: 'add_stash', stashId: 'temporary', title: '临时活动' },
      { op: 'move_stash_to_day', stashId: 'temporary', itemId: 'temporary-item', dayId: 'temporary-day' },
      { op: 'update_item', itemId: 'temporary-item', timeRange: '暂时时段' },
      { op: 'remove_item', itemId: 'temporary-item' },
      { op: 'remove_day', dayId: 'temporary-day' },
    ] })
    assert.ok(result.ok, result.ok ? undefined : result.error)
    assert.deepEqual(await store.listDayRows(tripId), [])
    assert.deepEqual(await store.listItemRows(tripId), [])
    assert.deepEqual(await store.listStashRows(tripId), [])
    assert.deepEqual(await store.listLegRows(tripId), [])
  })

  test(`${backend} snapshot guard executes inside the transaction before any itinerary reads or writes`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    let inTransaction = false
    const original = store.withTransaction.bind(store)
    store.withTransaction = async (fn) => original(async (transaction) => {
      inTransaction = true
      try { return await fn(transaction) } finally { inTransaction = false }
    })
    let guarded = false
    const result = await applyTripPatch(store, tripId, { ops: [{ op: 'add_day', dayId: 'blocked' }] }, {
      beforeApply: async () => {
        guarded = true
        assert.equal(inTransaction, true)
        return { ok: false, code: 'invalid', error: '候选已变化，请重新确认' }
      },
    })
    assert.equal(guarded, true)
    assert.deepEqual(result, { ok: false, code: 'invalid', error: '候选已变化，请重新确认' })
    assert.deepEqual(await store.listDayRows(tripId), [])
  })

  test(`${backend} concurrent moves consume a candidate once without undoing the successful transaction`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    assert.ok((await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'target' },
      { op: 'add_stash', stashId: 'single', title: '一次候选', poi: recommendation },
    ] })).ok)
    const results = await Promise.all(['first', 'second'].map((itemId) => applyTripPatch(store, tripId, { ops: [
      { op: 'move_stash_to_day', stashId: 'single', itemId, dayId: 'target' },
    ] })))
    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.equal((await store.listItemRows(tripId)).length, 1)
    assert.equal((await store.listStashRows(tripId)).length, 0)
  })

  test(`${backend} ordered updates can precede adding their eventual destination day`, async (t) => {
    const { store, tripId } = await fixture(t, backend)
    assert.ok((await applyTripPatch(store, tripId, { ops: [
      { op: 'add_day', dayId: 'original-day', date: '2026-10-02', title: '原日标题', note: '原日备注' },
      { op: 'add_item', itemId: 'original-item', dayId: 'original-day', type: 'other', title: '原活动', timeRange: ' 上午 ', cost: ' 免费 ', pending: true },
    ] })).ok)
    const result = await applyTripPatch(store, tripId, { ops: [
      { op: 'update_item', itemId: 'original-item', title: '更新活动' },
      { op: 'add_day', dayId: 'later-day', date: '2026-10-03', note: '新日备注' },
      { op: 'move_item', itemId: 'original-item', dayId: 'later-day' },
    ] })
    assert.ok(result.ok, result.ok ? undefined : result.error)
    const [item] = await store.listItemRows(tripId)
    assert.equal(item?.day_id, 'later-day')
    assert.equal(item?.title, '更新活动')
    assert.equal(item?.time_range, ' 上午 ')
    assert.equal(item?.cost, ' 免费 ')
    assert.deepEqual((await store.listDayRows(tripId)).map((row) => [row.id, row.title, row.note]), [
      ['original-day', '原日标题', '原日备注'], ['later-day', backend === 'SQLite' ? null : undefined, '新日备注'],
    ])
  })
}
