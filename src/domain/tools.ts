/**
 * Tools-panel API client (ticket 14) — notes / checklist / gallery HTTP calls
 * for the dockable canvas panels.
 *
 * Same codec convention as src/domain/tripList.ts / workbench.ts: tolerant
 * reads that never throw, an injectable FetchLike for Node tests, and
 * `{ok:true,data} | {ok:false,error}` results the caller surfaces verbatim.
 *
 * API (server/src/tools/routes.ts):
 *   GET/POST /api/trips/:id/notes, PATCH/DELETE /api/trips/:id/notes/:noteId
 *   GET/POST /api/trips/:id/checklist, PATCH/DELETE /api/trips/:id/checklist/:entryId
 *   GET/POST /api/trips/:id/gallery, DELETE /api/trips/:id/gallery/:imageId
 */

import type { ApiResult, FetchLike } from './tripList'
import { defaultFetch } from './tripList'
import type { WorkbenchDay } from './workbench'

export type NoteItem = {
  id: string
  content: string
  createdAt: string
  updatedAt: string
}

export type ChecklistItem = {
  id: string
  content: string
  done: boolean
  createdAt: string
}

/** One manual upload stored server-side (card images are aggregated locally). */
export type GalleryUpload = {
  id: string
  itemId: string | null
  url: string
  caption: string
  createdAt: string
}

/** Card image aggregated from the canvas (source: trip items). */
export type GalleryCardImage = {
  id: string
  itemId: string
  url: string
  caption: string
  source: 'card'
}

/** Upload constraints mirrored on the server (5 MB decoded, image types). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export const TOOLS_NETWORK_ERROR = '无法连接服务器，请确认后端服务已启动。'

// ---------------------------------------------------------------------------
// Notes (便签)
// ---------------------------------------------------------------------------

/** GET /api/trips/:id/notes — never throws; unparseable entries are dropped. */
export async function fetchNotes(tripId: string, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<NoteItem[]>> {
  return requestJson(fetchLike, `/api/trips/${encodeURIComponent(tripId)}/notes`, { method: 'GET' }, (payload) =>
    mapList(payload, 'notes', normalizeNote),
  )
}

/** POST /api/trips/:id/notes — create (content may be empty: add, then edit). */
export async function createNote(tripId: string, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<NoteItem>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/notes`,
    { method: 'POST', body: JSON.stringify({ content: '' }), headers: JSON_HEADERS },
    (payload) => parseField(payload, 'note', normalizeNote),
  )
}

/** PATCH /api/trips/:id/notes/:noteId — rewrite the free text. */
export async function updateNote(
  tripId: string,
  noteId: string,
  content: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<NoteItem>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/notes/${encodeURIComponent(noteId)}`,
    { method: 'PATCH', body: JSON.stringify({ content }), headers: JSON_HEADERS },
    (payload) => parseField(payload, 'note', normalizeNote),
  )
}

export async function deleteNote(
  tripId: string,
  noteId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<null>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/notes/${encodeURIComponent(noteId)}`,
    { method: 'DELETE' },
    () => null,
  )
}

// ---------------------------------------------------------------------------
// Checklist (清单) — includes the ticket-03 migrated legacy rows
// ---------------------------------------------------------------------------

/** GET /api/trips/:id/checklist — tolerant; migrated `legacy-checklist-*` included. */
export async function fetchChecklist(
  tripId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ChecklistItem[]>> {
  return requestJson(fetchLike, `/api/trips/${encodeURIComponent(tripId)}/checklist`, { method: 'GET' }, (payload) =>
    mapList(payload, 'items', normalizeChecklistItem),
  )
}

/** POST /api/trips/:id/checklist — add one unchecked entry. */
export async function createChecklistEntry(
  tripId: string,
  content: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ChecklistItem>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/checklist`,
    { method: 'POST', body: JSON.stringify({ content }), headers: JSON_HEADERS },
    (payload) => parseField(payload, 'item', normalizeChecklistItem),
  )
}

/** PATCH /api/trips/:id/checklist/:entryId — toggle (and/or retitle) one entry. */
export async function toggleChecklistEntry(
  tripId: string,
  entryId: string,
  done: boolean,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ChecklistItem>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/checklist/${encodeURIComponent(entryId)}`,
    { method: 'PATCH', body: JSON.stringify({ done }), headers: JSON_HEADERS },
    (payload) => parseField(payload, 'item', normalizeChecklistItem),
  )
}

export async function deleteChecklistEntry(
  tripId: string,
  entryId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<null>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/checklist/${encodeURIComponent(entryId)}`,
    { method: 'DELETE' },
    () => null,
  )
}

// ---------------------------------------------------------------------------
// Gallery (图库)
// ---------------------------------------------------------------------------

/** GET /api/trips/:id/gallery — manual uploads stored server-side. */
export async function fetchGallery(
  tripId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<GalleryUpload[]>> {
  return requestJson(fetchLike, `/api/trips/${encodeURIComponent(tripId)}/gallery`, { method: 'GET' }, (payload) =>
    mapList(payload, 'images', normalizeUpload),
  )
}

/**
 * POST /api/trips/:id/gallery — store one upload. `dataUrl` is an image data
 * URL (the server caps decoded size at 5MB) or an http(s) URL.
 */
export async function addGalleryImage(
  tripId: string,
  dataUrl: string,
  caption = '',
  itemId: string | null = null,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<GalleryUpload>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/gallery`,
    { method: 'POST', body: JSON.stringify({ url: dataUrl, caption, itemId }), headers: JSON_HEADERS },
    (payload) => parseField(payload, 'image', normalizeUpload),
  )
}

export async function deleteGalleryImage(
  tripId: string,
  imageId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<null>> {
  return requestJson(
    fetchLike,
    `/api/trips/${encodeURIComponent(tripId)}/gallery/${encodeURIComponent(imageId)}`,
    { method: 'DELETE' },
    () => null,
  )
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without React or fetch)
// ---------------------------------------------------------------------------

/**
 * Aggregate card images from the canvas days, in day → card order. URLs seen
 * more than once render once (the same cover is often reused across cards).
 */
export function collectCardImages(days: WorkbenchDay[]): GalleryCardImage[] {
  const seen = new Set<string>()
  const images: GalleryCardImage[] = []
  for (const day of days) {
    for (const item of day.items) {
      for (const image of item.images) {
        if (!image.url || seen.has(image.url)) continue
        seen.add(image.url)
        images.push({ id: `${item.id}:${images.length}`, itemId: item.id, url: image.url, caption: image.caption, source: 'card' })
      }
    }
  }
  return images
}

/** Pure client-side upload pre-check mirroring the server rules; null = OK. */
export function validateUploadFile(file: { size: number; type: string }): string | null {
  if (!file.type.startsWith('image/')) return '只能上传图片文件。'
  if (file.size > MAX_UPLOAD_BYTES) return '图片超过 5MB，请压缩后再上传。'
  return null
}

/** Read a File as a data URL (uploads are stored inline server-side). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** Pure: "2/6 已完成" progress label for the checklist header. */
export function checklistProgressLabel(items: ChecklistItem[]): string {
  const done = items.filter((item) => item.done).length
  return `${done}/${items.length} 已完成`
}

// ---------------------------------------------------------------------------
// Tolerant internals
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json' }

function normalizeNote(value: unknown): NoteItem | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) return null
  return {
    id,
    content: typeof record.content === 'string' ? record.content : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

function normalizeChecklistItem(value: unknown): ChecklistItem | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  if (!id) return null
  return {
    id,
    content: typeof record.content === 'string' ? record.content : '',
    done: record.done === true,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
  }
}

function normalizeUpload(value: unknown): GalleryUpload | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const url = typeof record.url === 'string' ? record.url : ''
  if (!id || !url) return null
  return {
    id,
    itemId: typeof record.itemId === 'string' ? record.itemId : null,
    url,
    caption: typeof record.caption === 'string' ? record.caption : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
  }
}

/** Unwrap one named entity off a payload; null → throw → {ok:false} result. */
function parseField<T>(payload: unknown, key: string, normalize: (value: unknown) => T | null): T {
  const value = normalize((payload as Record<string, unknown> | null)?.[key])
  if (value === null) throw new Error('unparseable payload')
  return value
}

function mapList<T>(payload: unknown, key: string, normalize: (value: unknown) => T | null): T[] {
  const list = (payload as Record<string, unknown> | null)?.[key]
  if (!Array.isArray(list)) return []
  return list.map(normalize).filter((entry): entry is T => entry !== null)
}

async function requestJson<T>(
  fetchLike: FetchLike,
  url: string,
  init: RequestInit,
  parse: (payload: unknown) => T,
): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetchLike(url, init)
  } catch {
    return { ok: false, error: TOOLS_NETWORK_ERROR }
  }
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // fall through — non-JSON bodies are handled below
  }
  if (!response.ok) {
    const error = (payload as { error?: unknown } | null)?.error
    return { ok: false, error: typeof error === 'string' && error ? error : `请求失败（HTTP ${response.status}）` }
  }
  try {
    return { ok: true, data: parse(payload) }
  } catch {
    return { ok: false, error: '服务器返回的数据无法解析。' }
  }
}
