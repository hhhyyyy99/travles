/**
 * Tools-panel domain tests (ticket 14) — src/domain/tools.ts API clients
 * (injectable FetchLike) + pure helpers, mirroring trip-list.test.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_UPLOAD_BYTES,
  TOOLS_NETWORK_ERROR,
  addGalleryImage,
  checklistProgressLabel,
  collectCardImages,
  createChecklistEntry,
  createNote,
  deleteGalleryImage,
  fetchChecklist,
  fetchGallery,
  fetchNotes,
  toggleChecklistEntry,
  updateNote,
  validateUploadFile,
  type NoteItem,
} from '../src/domain/tools'
import type { ApiResult, FetchLike } from '../src/domain/tripList'
import type { WorkbenchDay } from '../src/domain/workbench'

const NOTE = { id: 'note-1', content: '带手套', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' }
const ITEM = { id: 'legacy-checklist-0', content: '确认海拉尔机场同点取还车', done: true, createdAt: '2026-09-01T00:00:00Z' }
const UPLOAD = { id: 'img-1', itemId: null, url: 'data:image/png;base64,AAAA', caption: '', createdAt: '2026-09-12T00:00:00Z' }

/** Assert {ok:true} and return the data (keeps the union honest in tests). */
function unwrap<T>(result: ApiResult<T>): T {
  assert.equal(result.ok, true)
  return (result as { ok: true; data: T }).data
}

/** FetchLike stub replaying scripted responses; requests are recorded. */
function stubFetch(responses: Array<{ status: number; body?: unknown }>): { fetchLike: FetchLike; requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  return {
    requests,
    fetchLike: async (url, init) => {
      requests.push({ url, init })
      const next = responses.shift()
      if (!next) throw new Error('no scripted response')
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      })
    },
  }
}

test('notes client maps list/create/update onto the tools routes', async () => {
  const { fetchLike, requests } = stubFetch([
    { status: 200, body: { notes: [NOTE, { id: null }, 'junk'] } },
    { status: 201, body: { note: { ...NOTE, id: 'note-2' } } },
    { status: 200, body: { note: { ...NOTE, content: '改' } } },
  ])

  assert.deepEqual(unwrap(await fetchNotes('t1', fetchLike)), [NOTE])
  assert.equal(requests[0]?.url, '/api/trips/t1/notes')
  assert.equal((unwrap(await createNote('t1', fetchLike)) as NoteItem).id, 'note-2')
  assert.equal((unwrap(await updateNote('t1', 'note-1', '改', fetchLike))).content, '改')
})

test('checklist client surfaces migrated legacy entries and toggles', async () => {
  const { fetchLike, requests } = stubFetch([
    { status: 200, body: { items: [ITEM, { id: 'legacy-checklist-1', content: 'x', done: 0, createdAt: '' }] } },
    { status: 200, body: { item: { ...ITEM, done: false } } },
    { status: 201, body: { item: { id: 'new', content: '新', done: false, createdAt: '' } } },
  ])

  const list = unwrap(await fetchChecklist('t1', fetchLike))
  assert.deepEqual(
    list.map((item) => [item.id, item.done]),
    [
      ['legacy-checklist-0', true],
      ['legacy-checklist-1', false],
    ],
  )

  const toggled = unwrap(await toggleChecklistEntry('t1', 'legacy-checklist-0', false, fetchLike))
  assert.equal(toggled.done, false)
  const init = requests[1]?.init as RequestInit
  assert.equal(init.method, 'PATCH')
  assert.deepEqual(JSON.parse(String(init.body)), { done: false })

  const added = unwrap(await createChecklistEntry('t1', '新', fetchLike))
  assert.equal(added.id, 'new')
})

test('gallery client lists uploads and posts data URLs', async () => {
  const { fetchLike, requests } = stubFetch([
    { status: 200, body: { images: [UPLOAD] } },
    { status: 201, body: { image: { ...UPLOAD, id: 'img-2' } } },
  ])

  assert.deepEqual(unwrap(await fetchGallery('t1', fetchLike)), [UPLOAD])
  const added = unwrap(await addGalleryImage('t1', 'data:image/png;base64,AAAA', 'photo.png', 'item-1', fetchLike))
  assert.equal(added.id, 'img-2')
  const init = requests[1]?.init as RequestInit
  assert.equal(init.method, 'POST')
  assert.deepEqual(JSON.parse(String(init.body)), { url: 'data:image/png;base64,AAAA', caption: 'photo.png', itemId: 'item-1' })
})

test('API failures surface the server error string and network drops the shared message', async () => {
  const server = stubFetch([{ status: 404, body: { error: '行程不存在' } }])
  assert.deepEqual(await fetchNotes('nope', server.fetchLike), { ok: false, error: '行程不存在' })

  const badJson = stubFetch([{ status: 200, body: undefined }])
  // List reads tolerate a null payload (empty list); entity reads fail cleanly.
  assert.deepEqual(unwrap(await fetchNotes('t1', badJson.fetchLike)), [])
  assert.equal((await createNote('t1', badJson.fetchLike)).ok, false)

  const dropped: FetchLike = async () => {
    throw new TypeError('network down')
  }
  assert.deepEqual(await fetchChecklist('t1', dropped), { ok: false, error: TOOLS_NETWORK_ERROR })
})

test('collectCardImages aggregates canvas covers in day order, deduplicated by URL', () => {
  const days = [
    {
      id: 'day-1',
      index: 0,
      date: '2026-10-02',
      theme: '',
      color: '',
      items: [
        { id: 'a', dayId: 'day-1', order: 0, type: 'stay' as const, title: '', note: '', poi: null, images: [{ url: 'u1', caption: '帽儿山' }], pending: false },
        { id: 'b', dayId: 'day-1', order: 1, type: 'food' as const, title: '', note: '', poi: null, images: [] },
      ],
    },
    {
      id: 'day-2',
      index: 1,
      date: '2026-10-03',
      theme: '',
      color: '',
      items: [
        { id: 'c', dayId: 'day-2', order: 0, type: 'attraction' as const, title: '', note: '', poi: null, images: [{ url: 'u2', caption: '' }, { url: 'u1', caption: '' }], pending: false },
      ],
    },
  ] satisfies WorkbenchDay[]

  const images = collectCardImages(days)
  assert.deepEqual(
    images.map((image) => image.url),
    ['u1', 'u2'],
  )
  assert.equal(images[0]?.source, 'card')
  assert.equal(images[0]?.itemId, 'a')
  assert.equal(images[0]?.caption, '帽儿山')
})

test('upload validation mirrors the server rules (image type, 5MB cap)', () => {
  assert.equal(validateUploadFile({ size: 100, type: 'image/png' }), null)
  assert.equal(validateUploadFile({ size: MAX_UPLOAD_BYTES, type: 'image/jpeg' }), null)
  assert.ok(validateUploadFile({ size: MAX_UPLOAD_BYTES + 1, type: 'image/png' })?.includes('5MB'))
  assert.ok(validateUploadFile({ size: 10, type: 'application/pdf' })?.includes('图片'))
})

test('checklistProgressLabel counts done items', () => {
  assert.equal(checklistProgressLabel([{ ...ITEM, done: true }, { ...ITEM, id: 'b', done: false }]), '1/2 已完成')
  assert.equal(checklistProgressLabel([]), '0/0 已完成')
})
