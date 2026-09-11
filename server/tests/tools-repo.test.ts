/**
 * Tools repository unit tests (ticket 14) — notes / checklist / gallery over
 * the in-memory driver: tolerant reads, {ok:false} writes, validation caps,
 * and gallery URL rules (spec 测试接缝 #2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryToolsStoreDriver } from '../src/tools/driver-memory.js'
import {
  MAX_CAPTION_LENGTH,
  MAX_UPLOAD_BYTES,
  ToolsRepository,
  validateGalleryUrl,
} from '../src/tools/repository.js'

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('notes round-trip through create/update/delete with generated ids', async () => {
  const repo = new ToolsRepository(new MemoryToolsStoreDriver())
  const created = await repo.createNote('t1', '第一版')
  assert.equal(created.ok, true)
  const note = created.note!
  assert.equal(note.content, '第一版')

  const edited = await repo.updateNote('t1', note.id, '第二版')
  assert.equal(edited.ok, true)
  assert.equal(edited.note?.content, '第二版')

  const removed = await repo.deleteNote('t1', note.id)
  assert.equal(removed.ok, true)
  assert.deepEqual(await repo.listNotes('t1'), [])

  const gone = await repo.updateNote('t1', note.id, 'again')
  assert.deepEqual({ ok: gone.ok, code: gone.ok ? null : gone.code }, { ok: false, code: 'not_found' })
})

test('notes are scoped per trip and tolerate a failing driver', async () => {
  const driver = new MemoryToolsStoreDriver()
  const repo = new ToolsRepository(driver)
  await repo.createNote('t1', '甲')
  await repo.createNote('t2', '乙')
  assert.deepEqual((await repo.listNotes('t1')).map((note) => note.content), ['甲'])

  driver.nextWriteError = new Error('boom')
  const write = await repo.createNote('t1', '丙')
  assert.deepEqual({ ok: write.ok, code: write.ok ? null : write.code }, { ok: false, code: 'storage' })
  const update = await repo.updateNote('t1', 'whatever', '丙')
  assert.equal(update.ok, false)
})

test('notes reject oversized content but allow empty drafts', async () => {
  const repo = new ToolsRepository(new MemoryToolsStoreDriver())
  const draft = await repo.createNote('t1', '')
  assert.equal(draft.ok, true)
  assert.equal(draft.note?.content, '')

  const tooLong = await repo.createNote('t1', '长'.repeat(5001))
  assert.deepEqual({ ok: tooLong.ok, code: tooLong.ok ? null : tooLong.code }, { ok: false, code: 'invalid' })
})

test('checklist lists migrated legacy rows and toggles them', async () => {
  const driver = new MemoryToolsStoreDriver()
  const repo = new ToolsRepository(driver)
  // Seed rows exactly like the ticket-03 migration wrote them.
  driver.checklistRows.set('legacy-checklist-0', {
    id: 'legacy-checklist-0',
    trip_id: 't1',
    content: '确认海拉尔机场同点取还车',
    done: 1,
    created_at: '2026-09-01T00:00:00.000Z',
  })
  driver.checklistRows.set('legacy-checklist-1', {
    id: 'legacy-checklist-1',
    trip_id: 't1',
    content: '订好 6 晚住宿、莫尔道嘎与黑山头问供暖',
    done: 0,
    created_at: '2026-09-01T00:00:00.000Z',
  })

  const items = await repo.listChecklist('t1')
  assert.deepEqual(
    items.map((item) => [item.id, item.done]),
    [
      ['legacy-checklist-0', true],
      ['legacy-checklist-1', false],
    ],
  )

  const toggled = await repo.updateChecklistEntry('t1', 'legacy-checklist-1', { done: true })
  assert.equal(toggled.ok, true)
  assert.equal(toggled.item?.done, true)

  // Corrupt rows are dropped, never thrown.
  driver.checklistRows.set('corrupt', { id: null, trip_id: 't1', content: null, done: null, created_at: null })
  assert.equal((await repo.listChecklist('t1')).length, 2)
})

test('checklist add requires content; delete of a foreign trip is not_found', async () => {
  const driver = new MemoryToolsStoreDriver()
  const repo = new ToolsRepository(driver)
  const created = await repo.createChecklistEntry('t1', '提前 2 天预约莫尔格勒河')
  assert.equal(created.ok, true)
  assert.equal(created.item?.done, false)

  const empty = await repo.createChecklistEntry('t1', '   ')
  assert.deepEqual({ ok: empty.ok, code: empty.ok ? null : empty.code }, { ok: false, code: 'invalid' })

  const foreign = await repo.deleteChecklistEntry('t2', created.item!.id)
  assert.deepEqual({ ok: foreign.ok, code: foreign.ok ? null : foreign.code }, { ok: false, code: 'not_found' })
})

test('gallery stores data URLs and http(s) URLs, validates size and shape', async () => {
  const repo = new ToolsRepository(new MemoryToolsStoreDriver())
  const added = await repo.addGalleryImage('t1', { url: TINY_PNG, caption: '卡片图', itemId: 'item-1' })
  assert.equal(added.ok, true)
  assert.equal(added.image?.itemId, 'item-1')

  const http = await repo.addGalleryImage('t1', { url: 'https://example.com/pic.jpg' })
  assert.equal(http.ok, true)

  const notImage = await repo.addGalleryImage('t1', { url: 'data:text/plain;base64,SGk=' })
  assert.deepEqual({ ok: notImage.ok, code: notImage.ok ? null : notImage.code }, { ok: false, code: 'invalid' })
  const junk = await repo.addGalleryImage('t1', { url: 'ftp://example.com/pic' })
  assert.equal(junk.ok, false)
  const oversized = await repo.addGalleryImage('t1', {
    url: `data:image/png;base64,${'A'.repeat(Math.ceil(((MAX_UPLOAD_BYTES + 1) * 4) / 3))}`,
  })
  assert.equal(oversized.ok, false)
  const longCaption = await repo.addGalleryImage('t1', { url: TINY_PNG, caption: '标'.repeat(MAX_CAPTION_LENGTH + 1) })
  assert.equal(longCaption.ok, false)

  const images = await repo.listGallery('t1')
  assert.equal(images.length, 2)
  assert.deepEqual((await repo.listGallery('t2')).map((image) => image.id), [], 'trip scoping')

  const removed = await repo.deleteGalleryImage('t1', images[0]!.id)
  assert.equal(removed.ok, true)
  assert.equal((await repo.listGallery('t1')).length, 1)
})

test('validateGalleryUrl enforces the documented rules', () => {
  assert.equal(validateGalleryUrl(TINY_PNG), TINY_PNG)
  assert.equal(validateGalleryUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg')
  assert.equal(validateGalleryUrl('http://example.com/a.jpg'), 'http://example.com/a.jpg')
  assert.equal(validateGalleryUrl('javascript:alert(1)'), null)
  assert.equal(validateGalleryUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  assert.equal(validateGalleryUrl('data:image/png,'), null)
  assert.equal(validateGalleryUrl('data:image/png;base64,!!!'), null)
  assert.equal(
    validateGalleryUrl(`data:image/png;base64,${'A'.repeat(Math.ceil(((MAX_UPLOAD_BYTES + 1024) * 4) / 3))}`),
    null,
    '5MB cap',
  )
})
