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
 * - `applied_patch` — JSON `TripPatchRecord` (ticket 08): the structured diff
 *   the plan round wrote through `apply_trip_patch`, kept for traceability
 *   ("AI 改了什么", PRD §6 Message.appliedPatch). The column itself already
 *   existed in the ticket-02 schema as a reservation.
 *
 * The SSE protocol carries the same payload live (see chat/routes.ts); the
 * persisted rows are the reload-time projection of it.
 */
import type { TripPatchRecord } from '../trip-patch/types.js'
import type { RoundMetaPayload, RoundSource } from './round-meta.js'

export type ChatRole = 'user' | 'assistant'

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
  /**
   * Ticket 08: the applied TripPatch record (summary + stats + the patch the
   * model wrote), parsed from the `applied_patch` JSON column. Null when the
   * turn wrote nothing.
   */
  appliedPatch?: TripPatchRecord | null
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
  /** Ticket 08: JSON TripPatchRecord (summary/stats/patch) for plan-round writes. */
  applied_patch?: string | null
}

/** Optional round metadata persisted alongside an assistant message. */
export type AssistantMessageMeta = {
  think?: string
  sources?: RoundSource[]
  meta?: RoundMetaPayload
  /** Ticket 08: the applied TripPatch record (persisted to applied_patch). */
  appliedPatch?: TripPatchRecord
}

export interface MessageStoreDriver {
  listMessageRows(tripId: string): Promise<MessageRow[]>
  appendMessageRow(row: MessageRow): Promise<void>
}
