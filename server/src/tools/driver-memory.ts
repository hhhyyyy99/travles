/**
 * In-memory ToolsStoreDriver (ticket 14) — the injected driver for tools unit
 * tests, mirroring MemoryContentStoreDriver. Maps are exposed so tests can
 * seed corrupt rows; `nextWriteError` simulates storage failures.
 */
import type {
  ChecklistInsert,
  ChecklistPatch,
  ChecklistRow,
  GalleryInsert,
  GalleryRow,
  NoteInsert,
  NoteRow,
  ToolsStoreDriver,
} from './types.js'

export class MemoryToolsStoreDriver implements ToolsStoreDriver {
  readonly noteRows = new Map<string, NoteRow>()
  readonly checklistRows = new Map<string, ChecklistRow>()
  readonly galleryRows = new Map<string, GalleryRow>()
  /** When set, the next write operation throws with this error (then clears). */
  nextWriteError: Error | null = null

  private failNextWrite(): void {
    if (this.nextWriteError) {
      const error = this.nextWriteError
      this.nextWriteError = null
      throw error
    }
  }

  async listNoteRows(tripId: string): Promise<NoteRow[]> {
    return [...this.noteRows.values()].filter((row) => row.trip_id === tripId)
  }

  async insertNoteRow(tripId: string, note: NoteInsert): Promise<void> {
    this.failNextWrite()
    this.noteRows.set(note.id, {
      id: note.id,
      trip_id: tripId,
      content: note.content,
      created_at: note.createdAt,
      updated_at: note.updatedAt,
    })
  }

  async updateNoteRow(tripId: string, noteId: string, content: string, updatedAt: string): Promise<boolean> {
    this.failNextWrite()
    const row = this.noteRows.get(noteId)
    if (!row || row.trip_id !== tripId) return false
    this.noteRows.set(noteId, { ...row, content, updated_at: updatedAt })
    return true
  }

  async deleteNoteRow(tripId: string, noteId: string): Promise<boolean> {
    this.failNextWrite()
    const row = this.noteRows.get(noteId)
    if (!row || row.trip_id !== tripId) return false
    this.noteRows.delete(noteId)
    return true
  }

  async listChecklistRows(tripId: string): Promise<ChecklistRow[]> {
    return [...this.checklistRows.values()].filter((row) => row.trip_id === tripId)
  }

  async insertChecklistRow(tripId: string, entry: ChecklistInsert): Promise<void> {
    this.failNextWrite()
    this.checklistRows.set(entry.id, {
      id: entry.id,
      trip_id: tripId,
      content: entry.content,
      done: entry.done ? 1 : 0,
      created_at: entry.createdAt,
    })
  }

  async updateChecklistRow(tripId: string, entryId: string, patch: ChecklistPatch): Promise<boolean> {
    this.failNextWrite()
    const row = this.checklistRows.get(entryId)
    if (!row || row.trip_id !== tripId) return false
    this.checklistRows.set(entryId, {
      ...row,
      content: patch.content ?? row.content,
      done: (patch.done ?? (row.done === 1 || row.done === true)) ? 1 : 0,
    })
    return true
  }

  async deleteChecklistRow(tripId: string, entryId: string): Promise<boolean> {
    this.failNextWrite()
    const row = this.checklistRows.get(entryId)
    if (!row || row.trip_id !== tripId) return false
    this.checklistRows.delete(entryId)
    return true
  }

  async listGalleryRows(tripId: string): Promise<GalleryRow[]> {
    return [...this.galleryRows.values()].filter((row) => row.trip_id === tripId)
  }

  async insertGalleryRow(tripId: string, image: GalleryInsert): Promise<void> {
    this.failNextWrite()
    this.galleryRows.set(image.id, {
      id: image.id,
      trip_id: tripId,
      item_id: image.itemId,
      url: image.url,
      caption: image.caption,
      created_at: image.createdAt,
    })
  }

  async deleteGalleryRow(tripId: string, imageId: string): Promise<boolean> {
    this.failNextWrite()
    const row = this.galleryRows.get(imageId)
    if (!row || row.trip_id !== tripId) return false
    this.galleryRows.delete(imageId)
    return true
  }
}
