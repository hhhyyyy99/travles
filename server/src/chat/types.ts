/**
 * Chat types (ticket 06) — the qa-round minimal conversation loop.
 *
 * Message rows map 1:1 onto the `messages` table from ticket 02's schema
 * (role/content/created_at; think/sources/applied_patch are JSON-reserved
 * columns this ticket never writes — they belong to tickets 07/08).
 *
 * The round type (`qa` in this ticket; `clarify` / `plan` / `patch-explain`
 * land with tickets 07/08/11) is part of the SSE protocol, not the storage:
 * persisted rows stay plain role/content pairs so later rounds can extend
 * the stream schema without a migration.
 */

export type ChatRole = 'user' | 'assistant'

/** A persisted chat message, as returned by the history endpoint. */
export type ChatMessage = {
  id: string
  tripId: string
  role: ChatRole
  content: string
  createdAt: string
}

/** Raw driver row (snake_case, mirrors the messages table columns). */
export type MessageRow = {
  id: string
  trip_id: string
  role: string
  content: string
  created_at: string
}

export interface MessageStoreDriver {
  listMessageRows(tripId: string): Promise<MessageRow[]>
  appendMessageRow(row: MessageRow): Promise<void>
}
