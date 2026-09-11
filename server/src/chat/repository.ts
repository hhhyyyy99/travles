/**
 * Chat message repository (tickets 06/07) — validation + tolerant mapping over
 * any MessageStoreDriver (spec 测试接缝 #2), following the TripRepository
 * convention: reads never throw, writes return `{ok,...} | {ok:false,error}`.
 *
 * Ticket 07 adds round-metadata persistence on assistant rows: `think`
 * (text), `sources` (JSON) and `meta` (JSON RoundMetaPayload). Corrupt JSON
 * is dropped field-by-field — a bad `sources` blob never hides the message.
 * Ticket 08 adds `applied_patch` (JSON TripPatchRecord) the same way.
 */
import { randomUUID } from 'node:crypto'
import type { RoundSource } from './round-meta.js'
import type { AssistantMessageMeta, ChatMessage, ChatRole, MessageRow, MessageStoreDriver } from './types.js'

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

  /**
   * Persist one user/assistant message row. Assistant rows may carry the
   * round metadata (think summary, sources, round meta payload) emitted by
   * the turn's `emit_round_meta` tool call.
   */
  async append(
    tripId: string,
    role: ChatRole,
    content: string,
    meta?: AssistantMessageMeta,
  ): Promise<ChatAppendResult> {
    const row: MessageRow = {
      id: randomUUID(),
      trip_id: tripId,
      role,
      content,
      created_at: new Date().toISOString(),
      ...(role === 'assistant' && meta
        ? {
            think: meta.think ?? null,
            sources: meta.sources ? JSON.stringify(meta.sources) : null,
            meta: meta.meta ? JSON.stringify(meta.meta) : null,
            applied_patch: meta.appliedPatch ? JSON.stringify(meta.appliedPatch) : null,
          }
        : {}),
    }
    try {
      await this.driver.appendMessageRow(row)
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
    const message = mapRowToMessage(row, tripId)
    return message === null ? { ok: false, error: '保存失败', code: 'storage' } : { ok: true, message }
  }

  /**
   * Lightweight system note in the trip's thread (ticket 09) — recorded when
   * the user manually edits the itinerary so later AI rounds see the latest
   * plan. Tolerant and no-throw by contract: a failing chat store never
   * blocks or fails the edit UX that triggered it.
   */
  async recordSystemMessage(tripId: string, content: string): Promise<void> {
    if (!content.trim()) return
    try {
      await this.driver.appendMessageRow({
        id: randomUUID(),
        trip_id: tripId,
        role: 'system',
        content,
        created_at: new Date().toISOString(),
      })
    } catch {
      // Intentionally swallowed: edit UX never depends on chat storage.
    }
  }
}

/** Tolerant row → ChatMessage; null when the row is unusable. */
function mapRowToMessage(row: MessageRow, tripId: string): ChatMessage | null {
  if (row === null || typeof row !== 'object') return null
  if (typeof row.id !== 'string' || row.id === '') return null
  if (row.role !== 'assistant' && row.role !== 'user' && row.role !== 'system') return null
  const role: ChatRole = row.role
  const message: ChatMessage = {
    id: row.id,
    tripId: typeof row.trip_id === 'string' ? row.trip_id : tripId,
    role,
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  }
  if (role === 'assistant') {
    message.think = typeof row.think === 'string' && row.think !== '' ? row.think : null
    message.sources = parseSources(row.sources)
    message.meta = parseRoundMeta(row.meta)
    message.appliedPatch = parseAppliedPatch(row.applied_patch)
  }
  return message
}

/** Parse the sources JSON column; null unless every entry is usable. */
function parseSources(raw: string | null | undefined): RoundSource[] | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const sources: RoundSource[] = []
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue
      const title = (entry as { title?: unknown }).title
      const url = (entry as { url?: unknown }).url
      if (typeof title === 'string' && title && typeof url === 'string' && url) {
        sources.push({ title, url })
      }
    }
    return sources.length > 0 ? sources : null
  } catch {
    return null
  }
}

/** Parse the round-meta JSON column; null on anything unusable. */
function parseRoundMeta(raw: string | null | undefined): ChatMessage['meta'] {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const round = (parsed as { round?: unknown }).round
    if (typeof round !== 'string' || round === '') return null
    return parsed as NonNullable<ChatMessage['meta']>
  } catch {
    return null
  }
}

/**
 * Parse the applied-patch JSON column (ticket 08); null unless the record
 * carries a summary — a corrupt blob never hides the message itself.
 */
function parseAppliedPatch(raw: string | null | undefined): ChatMessage['appliedPatch'] {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const summary = (parsed as { summary?: unknown }).summary
    if (typeof summary !== 'string' || summary === '') return null
    return parsed as NonNullable<ChatMessage['appliedPatch']>
  } catch {
    return null
  }
}
