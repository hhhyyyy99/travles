/**
 * Tools repository (ticket 14) — validation + tolerant mapping over any
 * ToolsStoreDriver, mirroring TripContentRepository.
 *
 * Convention (mirrors src/domain/storage.ts):
 * - Reads NEVER throw: a failing driver or corrupt rows degrade to empty
 *   lists / dropped entries.
 * - Writes return {ok:true} | {ok:false, error, code} — the HTTP layer maps
 *   that to status codes.
 * - The repository generates row ids (crypto.randomUUID) and timestamps;
 *   callers only supply validated content.
 *
 * Gallery storage decision (ticket 14, documented): manual uploads are stored
 * as image data URLs in the existing `gallery.url` TEXT column — no
 * filesystem, no extra table, identical behavior for the SQLite and in-memory
 * drivers. Uploads are capped (5 MB decoded, image mime types only, see
 * validateGalleryUrl); a later ticket can switch to file/blob storage by
 * changing only the URL values.
 */
import { randomUUID } from 'node:crypto'
import type {
  ChecklistEntryContent,
  ChecklistPatch,
  ChecklistRow,
  GalleryImageContent,
  GalleryRow,
  NoteContent,
  NoteRow,
  ToolsErrorCode,
  ToolsStoreDriver,
  ToolsWriteResult,
} from './types.js'

/** Hard caps so hostile payloads cannot write unbounded rows. */
export const MAX_NOTE_LENGTH = 5000
export const MAX_CHECKLIST_LENGTH = 500
export const MAX_CAPTION_LENGTH = 200
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/** Image data-URL mime types accepted for manual uploads. */
const DATA_URL_PATTERN = /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/

/**
 * Validate a gallery URL. Accepts http(s) URLs (e.g. aggregated card images)
 * and image data URLs up to MAX_UPLOAD_BYTES decoded — null = reject.
 */
export function validateGalleryUrl(url: string): string | null {
  if (url.startsWith('data:')) {
    const match = DATA_URL_PATTERN.exec(url)
    if (match === null) return null
    const base64 = match[2] ?? ''
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const bytes = Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
    return bytes <= MAX_UPLOAD_BYTES ? url : null
  }
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export class ToolsRepository {
  constructor(private readonly driver: ToolsStoreDriver) {}

  /** Notes of a trip, tolerant like everything here. */
  async listNotes(tripId: string): Promise<NoteContent[]> {
    let rows: NoteRow[]
    try {
      rows = await this.driver.listNoteRows(tripId)
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows.map(mapNoteRow).filter((note): note is NoteContent => note !== null)
  }

  /** Create a note (content may be empty — the panel adds, then edits). */
  async createNote(tripId: string, content: string): Promise<ToolsWriteResult & { note?: NoteContent }> {
    if (content.length > MAX_NOTE_LENGTH) return { ok: false, error: '便签内容过长', code: 'invalid' }
    const now = new Date().toISOString()
    const note: NoteContent = { id: randomUUID(), content, createdAt: now, updatedAt: now }
    try {
      await this.driver.insertNoteRow(tripId, { ...note })
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, note }
  }

  /** Rewrite a note's content (PATCH). */
  async updateNote(tripId: string, noteId: string, content: string): Promise<ToolsWriteResult & { note?: NoteContent }> {
    if (content.length > MAX_NOTE_LENGTH) return { ok: false, error: '便签内容过长', code: 'invalid' }
    try {
      const updated = await this.driver.updateNoteRow(tripId, noteId, content, new Date().toISOString())
      if (!updated) return { ok: false, error: '便签不存在', code: 'not_found' }
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    const note = (await this.listNotes(tripId)).find((entry) => entry.id === noteId)
    if (!note) return { ok: false, error: '便签不存在', code: 'not_found' }
    return { ok: true, note }
  }

  async deleteNote(tripId: string, noteId: string): Promise<ToolsWriteResult> {
    return this.remove(noteId, '便签不存在', (id) => this.driver.deleteNoteRow(tripId, id))
  }

  /** Checklist entries of a trip — includes the ticket-03 migrated rows. */
  async listChecklist(tripId: string): Promise<ChecklistEntryContent[]> {
    let rows: ChecklistRow[]
    try {
      rows = await this.driver.listChecklistRows(tripId)
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows.map(mapChecklistRow).filter((entry): entry is ChecklistEntryContent => entry !== null)
  }

  /** Add one checklist entry (unchecked by default; content required). */
  async createChecklistEntry(
    tripId: string,
    content: string,
  ): Promise<ToolsWriteResult & { item?: ChecklistEntryContent }> {
    if (!validContent(content, MAX_CHECKLIST_LENGTH)) return { ok: false, error: '清单内容不能为空', code: 'invalid' }
    const item: ChecklistEntryContent = { id: randomUUID(), content, done: false, createdAt: new Date().toISOString() }
    try {
      await this.driver.insertChecklistRow(tripId, { ...item })
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, item }
  }

  /** Toggle (and optionally retitle) one checklist entry. */
  async updateChecklistEntry(
    tripId: string,
    entryId: string,
    patch: ChecklistPatch,
  ): Promise<ToolsWriteResult & { item?: ChecklistEntryContent }> {
    if (patch.content !== undefined && !validContent(patch.content, MAX_CHECKLIST_LENGTH)) {
      return { ok: false, error: '清单内容无效', code: 'invalid' }
    }
    try {
      const updated = await this.driver.updateChecklistRow(tripId, entryId, patch)
      if (!updated) return { ok: false, error: '清单条目不存在', code: 'not_found' }
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    const item = (await this.listChecklist(tripId)).find((entry) => entry.id === entryId)
    if (!item) return { ok: false, error: '清单条目不存在', code: 'not_found' }
    return { ok: true, item }
  }

  async deleteChecklistEntry(tripId: string, entryId: string): Promise<ToolsWriteResult> {
    return this.remove(entryId, '清单条目不存在', (id) => this.driver.deleteChecklistRow(tripId, id))
  }

  /** Uploaded gallery images of a trip (card images are aggregated client-side). */
  async listGallery(tripId: string): Promise<GalleryImageContent[]> {
    let rows: GalleryRow[]
    try {
      rows = await this.driver.listGalleryRows(tripId)
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows.map(mapGalleryRow).filter((image): image is GalleryImageContent => image !== null)
  }

  /** Add one gallery image (http(s) URL or ≤5MB image data URL). */
  async addGalleryImage(
    tripId: string,
    input: { url: string; caption?: string; itemId?: string | null },
  ): Promise<ToolsWriteResult & { image?: GalleryImageContent }> {
    const url = validateGalleryUrl(input.url)
    if (url === null) {
      return { ok: false, error: '图片必须是 http(s) 链接或 5MB 以内的图片数据', code: 'invalid' }
    }
    const caption = input.caption ?? ''
    if (caption.length > MAX_CAPTION_LENGTH) {
      return { ok: false, error: '图片说明过长', code: 'invalid' }
    }
    const itemId = typeof input.itemId === 'string' && input.itemId.trim() ? input.itemId.trim() : null
    const image: GalleryImageContent = {
      id: randomUUID(),
      itemId,
      url,
      caption,
      createdAt: new Date().toISOString(),
    }
    try {
      await this.driver.insertGalleryRow(tripId, { ...image })
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    return { ok: true, image }
  }

  async deleteGalleryImage(tripId: string, imageId: string): Promise<ToolsWriteResult> {
    return this.remove(imageId, '图片不存在', (id) => this.driver.deleteGalleryRow(tripId, id))
  }

  // -------------------------------------------------------------------------

  private async remove(
    rowId: string,
    notFound: string,
    remove: (id: string) => Promise<boolean>,
  ): Promise<ToolsWriteResult> {
    try {
      const removed = await remove(rowId)
      if (!removed) return { ok: false, error: notFound, code: 'not_found' as ToolsErrorCode }
      return { ok: true }
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
  }
}

// ---------------------------------------------------------------------------
// Tolerant mapping helpers (corrupt values degrade, never throw)
// ---------------------------------------------------------------------------

function mapNoteRow(row: NoteRow): NoteContent | null {
  const id = asText(row?.id)
  if (!id) return null
  return {
    id,
    content: asText(row?.content),
    createdAt: asText(row?.created_at),
    updatedAt: asText(row?.updated_at),
  }
}

function mapChecklistRow(row: ChecklistRow): ChecklistEntryContent | null {
  const id = asText(row?.id)
  if (!id) return null
  return {
    id,
    content: asText(row?.content),
    done: row?.done === 1 || row?.done === true,
    createdAt: asText(row?.created_at),
  }
}

function mapGalleryRow(row: GalleryRow): GalleryImageContent | null {
  const id = asText(row?.id)
  const url = asText(row?.url)
  if (!id || !url) return null
  const itemId = asText(row?.item_id)
  return {
    id,
    itemId: itemId || null,
    url,
    caption: asText(row?.caption),
    createdAt: asText(row?.created_at),
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function validContent(value: string, max: number): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= max
}
