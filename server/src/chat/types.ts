/**
 * Chat types (tickets 06/07) — the conversation loop over the four-round
 * protocol (qa today; clarify arrives with ticket 07's `emit_round_meta`
 * tool; plan / patch-explain land with tickets 08/11).
 *
 * Message rows map 1:1 onto the `messages` table from ticket 02's schema
 * (role/content/created_at) plus ticket 07's round-metadata columns:
 *
 * - `think`  — the reasoning summary behind the "思考完成" collapsible (text).
 * - `sources` — JSON array of `{title, url}` citations ("来源" collapsible).
 * - `meta`   — JSON `RoundMetaPayload` (round type, clarify chips, POI links,
 *   thinkComplete). Column added additively by ticket 07 (ensureSchema issues
 *   a tolerant ALTER for pre-existing databases).
 *
 * Ticket 09 adds the `system` role: lightweight, no-throw notes the workbench
 * appends when the user manually edits the trip (reorder/move/copy/add/
 * delete), so later AI rounds (tickets 08/11/13) read an up-to-date
 * itinerary from the same thread. System rows render as muted center lines
 * in the chat panel and never participate in the SSE round loop.
 *
 * The SSE protocol carries the same payload live (see chat/routes.ts); the
 * persisted rows stay plain role/content pairs so later rounds can extend
 * the stream schema without a migration.
 */
import type { RoundMetaPayload, RoundSource } from './round-meta.js'

export type ChatRole = 'user' | 'assistant' | 'system'

/** A persisted chat message, as returned by the history endpoint. */
export type ChatMessage = {
  id: string
  tripId: string
  role: ChatRole
  content: string
  createdAt: string
  /** Assistant messages: reasoning summary for the 思考完成 collapsible. */
  think?: string | null
  /** Assistant messages: parsed citation list for the 来源 collapsible. */
  sources?: RoundSource[] | null
  /** Assistant messages: parsed round metadata (round type, chips, POI links). */
  meta?: RoundMetaPayload | null
}

/** Raw driver row (snake_case, mirrors the messages table columns). */
export type MessageRow = {
  id: string
  trip_id: string
  role: string
  content: string
  created_at: string
  /** Ticket 07: think summary text (assistant rows only). */
  think?: string | null
  /** Ticket 07: JSON array of RoundSource. */
  sources?: string | null
  /** Ticket 07: JSON RoundMetaPayload (round/chips/poiLinks/thinkComplete). */
  meta?: string | null
}

/** Optional round metadata persisted alongside an assistant message. */
export type AssistantMessageMeta = {
  think?: string
  sources?: RoundSource[]
  meta?: RoundMetaPayload
}

export interface MessageStoreDriver {
  listMessageRows(tripId: string): Promise<MessageRow[]>
  appendMessageRow(row: MessageRow): Promise<void>
}
