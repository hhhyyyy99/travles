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

/** Internal binding stays outside the public/model proposal schema. */
export type StoredAiProposal = AiProposal & { snapshotHash?: string }

export type ProposalToolResult =
  | { ok: true; proposal: Omit<AiProposal, 'id' | 'tripId' | 'createdAt'>; snapshotHash?: string }
  | { ok: false; retryable: boolean; error: string }

export interface AiProposalStore {
  save(proposal: StoredAiProposal): void
  get(tripId: string, proposalId: string): StoredAiProposal | null
  remove(tripId: string, proposalId: string): void
}

/** Process-local store; proposals intentionally expire so stale previews cannot be applied forever. */
export class MemoryAiProposalStore implements AiProposalStore {
  private readonly proposals = new Map<string, StoredAiProposal>()

  constructor(private readonly ttlMs = 30 * 60 * 1000) {}

  save(proposal: StoredAiProposal): void {
    this.proposals.set(proposal.id, structuredClone(proposal))
  }

  get(tripId: string, proposalId: string): StoredAiProposal | null {
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
