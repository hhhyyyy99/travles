/**
 * Chat message repository (ticket 06) — validation + tolerant mapping over
 * any MessageStoreDriver (spec 测试接缝 #2), following the TripRepository
 * convention: reads never throw, writes return `{ok,...} | {ok:false,error}`.
 */
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRole, MessageRow, MessageStoreDriver } from './types.js'

export type ChatAppendResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; error: string; code: 'storage' }

export class ChatMessageRepository {
  constructor(private readonly driver: MessageStoreDriver) {}

  /** History for one trip, oldest-first. Corrupt rows are dropped. */
  async listByTrip(tripId: string): Promise<ChatMessage[]> {
    let rows: MessageRow[]
    try {
      rows = await this.driver.listMessageRows(tripId)
    } catch {
      return []
    }
    if (!Array.isArray(rows)) return []
    return rows.map((row) => mapRowToMessage(row, tripId)).filter((m): m is ChatMessage => m !== null)
  }

  /** Persist one user/assistant message row. */
  async append(tripId: string, role: ChatRole, content: string): Promise<ChatAppendResult> {
    const row: MessageRow = {
      id: randomUUID(),
      trip_id: tripId,
      role,
      content,
      created_at: new Date().toISOString(),
    }
    try {
      await this.driver.appendMessageRow(row)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    const message = mapRowToMessage(row, tripId)
    return message === null ? { ok: false, error: '保存失败', code: 'storage' } : { ok: true, message }
  }
}

/** Tolerant row → ChatMessage; null when the row is unusable. */
function mapRowToMessage(row: MessageRow, tripId: string): ChatMessage | null {
  if (row === null || typeof row !== 'object') return null
  if (typeof row.id !== 'string' || row.id === '') return null
  if (row.role !== 'assistant' && row.role !== 'user') return null
  const role: ChatRole = row.role
  return {
    id: row.id,
    tripId: typeof row.trip_id === 'string' ? row.trip_id : tripId,
    role,
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  }
}
