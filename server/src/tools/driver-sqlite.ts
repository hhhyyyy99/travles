/**
 * SQLite ToolsStoreDriver (ticket 14) — libsql-backed notes / checklist /
 * gallery access over the same `SqlDatabase` seam as the other drivers, using
 * only the tables that db/schema.ts already created (notes / checklist /
 * gallery).
 */
import type { SqlDatabase, SqlValue } from '../db/driver.js'
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

export class SqliteToolsStoreDriver implements ToolsStoreDriver {
  constructor(private readonly db: SqlDatabase) {}

  async listNoteRows(tripId: string): Promise<NoteRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, content, created_at, updated_at FROM notes WHERE trip_id = ? ORDER BY created_at ASC, id ASC',
      [tripId],
    )
    return rows as unknown as NoteRow[]
  }

  async insertNoteRow(tripId: string, note: NoteInsert): Promise<void> {
    await this.db.run(
      'INSERT INTO notes (id, trip_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [note.id, tripId, note.content, note.createdAt, note.updatedAt] as SqlValue[],
    )
  }

  async updateNoteRow(tripId: string, noteId: string, content: string, updatedAt: string): Promise<boolean> {
    const result = await this.db.run('UPDATE notes SET content = ?, updated_at = ? WHERE id = ? AND trip_id = ?', [
      content,
      updatedAt,
      noteId,
      tripId,
    ] as SqlValue[])
    return result.rowsAffected > 0
  }

  async deleteNoteRow(tripId: string, noteId: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM notes WHERE id = ? AND trip_id = ?', [noteId, tripId] as SqlValue[])
    return result.rowsAffected > 0
  }

  async listChecklistRows(tripId: string): Promise<ChecklistRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, content, done, created_at FROM checklist WHERE trip_id = ? ORDER BY created_at ASC, id ASC',
      [tripId],
    )
    return rows as unknown as ChecklistRow[]
  }

  async insertChecklistRow(tripId: string, entry: ChecklistInsert): Promise<void> {
    await this.db.run(
      'INSERT INTO checklist (id, trip_id, content, done, created_at) VALUES (?, ?, ?, ?, ?)',
      [entry.id, tripId, entry.content, entry.done ? 1 : 0, entry.createdAt] as SqlValue[],
    )
  }

  async updateChecklistRow(tripId: string, entryId: string, patch: ChecklistPatch): Promise<boolean> {
    // Sparse patch: read the row, merge in JS, write back (keeps SQL simple).
    const { rows } = await this.db.run('SELECT content, done FROM checklist WHERE id = ? AND trip_id = ?', [
      entryId,
      tripId,
    ] as SqlValue[])
    const row = rows[0]
    if (!row) return false
    const content = patch.content ?? (typeof row.content === 'string' ? row.content : '')
    const done = (patch.done ?? (row.done === 1 || row.done === true)) ? 1 : 0
    await this.db.run('UPDATE checklist SET content = ?, done = ? WHERE id = ? AND trip_id = ?', [
      content,
      done,
      entryId,
      tripId,
    ] as SqlValue[])
    return true
  }

  async deleteChecklistRow(tripId: string, entryId: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM checklist WHERE id = ? AND trip_id = ?', [
      entryId,
      tripId,
    ] as SqlValue[])
    return result.rowsAffected > 0
  }

  async listGalleryRows(tripId: string): Promise<GalleryRow[]> {
    const { rows } = await this.db.run(
      'SELECT id, trip_id, item_id, url, caption, created_at FROM gallery WHERE trip_id = ? ORDER BY created_at ASC, id ASC',
      [tripId],
    )
    return rows as unknown as GalleryRow[]
  }

  async insertGalleryRow(tripId: string, image: GalleryInsert): Promise<void> {
    await this.db.run(
      'INSERT INTO gallery (id, trip_id, item_id, url, caption, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [image.id, tripId, image.itemId, image.url, image.caption, image.createdAt] as SqlValue[],
    )
  }

  async deleteGalleryRow(tripId: string, imageId: string): Promise<boolean> {
    const result = await this.db.run('DELETE FROM gallery WHERE id = ? AND trip_id = ?', [
      imageId,
      tripId,
    ] as SqlValue[])
    return result.rowsAffected > 0
  }
}

/** Build the SQLite tools driver over an already-open database. */
export function createSqliteToolsStore(db: SqlDatabase): SqliteToolsStoreDriver {
  return new SqliteToolsStoreDriver(db)
}
