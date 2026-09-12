/**
 * Read-only AI proposal contracts (ticket 13).
 *
 * A proposal is deliberately separate from a TripPatch record. The model may
 * suggest a patch, but the trip is only changed by the explicit apply route.
 * Keeping the proposal in a small process-local store also gives the UI a
 * stable id for confirm / cancel / retry interactions.
 */
import type { TripPatchInput } from '../trip-patch/schema.js'

export type ProposalKind = 'parse' | 'optimize' | 'day-optimize'

export type ProposalItem = {
  itemId: string
  dayId: string
  order?: number
  type: 'traffic' | 'stay' | 'attraction' | 'food' | 'other'
  title: string
  note?: string
  pending?: boolean
  poi?: {
    name: string
    lat: number
    lng: number
    amapId?: string
    category?: string
    rating?: number
  } | null
  legPending?: boolean
}

export type ProposalChange = {
  action: 'add' | 'update' | 'move' | 'remove'
  label: string
  detail?: string
  itemId?: string
  dayId?: string
  fromDayId?: string
  toDayId?: string
}

export type AiProposal = {
  id: string
  tripId: string
  kind: ProposalKind
  title: string
  summary: string
  diff: ProposalChange[]
  patch: TripPatchInput
  items?: ProposalItem[]
  targetDayId?: string
  createdAt: string
}

export type ProposalToolResult =
  | { ok: true; proposal: Omit<AiProposal, 'id' | 'tripId' | 'createdAt'> }
  | { ok: false; retryable: boolean; error: string }

export interface AiProposalStore {
  save(proposal: AiProposal): void
  get(tripId: string, proposalId: string): AiProposal | null
  remove(tripId: string, proposalId: string): void
}

/** Process-local store; proposals intentionally expire so stale previews cannot be applied forever. */
export class MemoryAiProposalStore implements AiProposalStore {
  private readonly proposals = new Map<string, AiProposal>()

  constructor(private readonly ttlMs = 30 * 60 * 1000) {}

  save(proposal: AiProposal): void {
    this.proposals.set(proposal.id, proposal)
  }

  get(tripId: string, proposalId: string): AiProposal | null {
    const proposal = this.proposals.get(proposalId)
    if (proposal === undefined || proposal.tripId !== tripId) return null
    if (Date.now() - Date.parse(proposal.createdAt) > this.ttlMs) {
      this.proposals.delete(proposalId)
      return null
    }
    return proposal
  }

  remove(tripId: string, proposalId: string): void {
    const proposal = this.proposals.get(proposalId)
    if (proposal?.tripId === tripId) this.proposals.delete(proposalId)
  }
}
