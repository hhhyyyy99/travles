/** Ticket 13 client codecs: proposal payloads stay tolerant and apply/cancel use explicit routes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyAiProposal,
  cancelAiProposal,
  createAiProposal,
  PROPOSAL_NETWORK_ERROR,
  type ProposalRequest,
} from '../src/domain/aiProposals'
import type { FetchLike } from '../src/domain/tripList'

function jsonFetch(body: unknown, status = 200, calls: { method?: string; url: string }[] = []): FetchLike {
  return async (input, init) => {
    calls.push({ method: init?.method, url: String(input) })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
}

const proposal = {
  id: 'proposal-1',
  tripId: 'trip-1',
  kind: 'parse',
  title: '攻略解析',
  summary: '新增一天',
  diff: [{ action: 'add', label: '新增莫尔格勒河' }],
  items: [{ itemId: 'item-1', dayId: 'day-1', type: 'attraction', title: '莫尔格勒河' }],
  patch: { ops: [{ op: 'add_day', dayId: 'day-1', date: '2026-10-02' }] },
  createdAt: '2026-09-12T00:00:00.000Z',
}

test('createAiProposal normalizes structured items and drops malformed diff rows', async () => {
  const result = await createAiProposal('trip-1', { kind: 'parse', text: '攻略文本' }, jsonFetch({ proposal: { ...proposal, diff: [...proposal.diff, null, { action: 'bad', label: '' }] } }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.data.items?.[0]?.title, '莫尔格勒河')
  assert.equal(result.data.diff.length, 1)
})

test('proposal apply and cancel use the explicit proposal routes', async () => {
  const calls: { method?: string; url: string }[] = []
  const fetchLike = jsonFetch(
    { proposalId: 'proposal-1', appliedPatch: { summary: '已应用建议', stats: { itemsUpdated: 1 }, patch: proposal.patch } },
    200,
    calls,
  )
  const applied = await applyAiProposal('trip-1', 'proposal-1', fetchLike)
  assert.equal(applied.ok, true)
  assert.equal(calls[0]?.method, 'POST')
  assert.equal(calls[0]?.url, '/api/trips/trip-1/ai/proposals/proposal-1/apply')

  const canceled = await cancelAiProposal('trip-1', 'proposal-1', jsonFetch({ ok: true }, 200, calls))
  assert.equal(canceled.ok, true)
  assert.equal(calls[1]?.method, 'DELETE')
  assert.equal(calls[1]?.url, '/api/trips/trip-1/ai/proposals/proposal-1')
})

test('proposal network failures never throw', async () => {
  const request: ProposalRequest = { kind: 'optimize' }
  const result = await createAiProposal('trip-1', request, async () => {
    throw new Error('offline')
  })
  assert.deepEqual(result, { ok: false, error: PROPOSAL_NETWORK_ERROR })
})
