/**
 * Read-only AI proposal contracts (ticket 13).
 *
 * A proposal is deliberately separate from a TripPatch record. The model may
 * suggest a patch, but the trip is only changed by the explicit apply route.
 * Keeping the proposal in a small process-local store also gives the UI a
 * stable id for confirm / cancel / retry interactions.
 */
import type { AiProposal } from '@hailar/domain'

export type { ProposalKind, ProposalItem, ProposalChange, AiProposal } from '@hailar/domain'

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
