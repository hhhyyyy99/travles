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

test('proposal responses are scoped to the requested trip and carry a usable patch', async () => {
  const wrongTrip = await createAiProposal(
    'trip-1',
    { kind: 'parse', text: '攻略文本' },
    jsonFetch({ proposal: { ...proposal, tripId: 'trip-2' } }),
  )
  assert.deepEqual(wrongTrip, { ok: false, error: '服务器返回的建议无法解析。' })

  const missingPatch = await createAiProposal(
    'trip-1',
    { kind: 'parse', text: '攻略文本' },
    jsonFetch({ proposal: { ...proposal, patch: undefined } }),
  )
  assert.deepEqual(missingPatch, { ok: false, error: '服务器返回的建议无法解析。' })
})

test('stash proposals preserve real stash references and both operations through preview and confirmed apply decoding', async () => {
  const patch = { ops: [
    { op: 'add_stash', stashId: 'stash-real', title: '雨天备用', note: '室内活动', poi: null },
    { op: 'move_stash_to_day', stashId: 'stash-real', itemId: 'scheduled-real', dayId: 'day-1', pending: true },
  ] }
  const preview = await createAiProposal('trip-1', { kind: 'optimize' }, jsonFetch({ proposal: {
    ...proposal, kind: 'optimize', items: undefined, patch,
    diff: [{ action: 'move', label: '安排雨天备用', stashId: 'stash-real', itemId: 'scheduled-real', toDayId: 'day-1' }],
  } }))
  assert.ok(preview.ok)
  assert.deepEqual(preview.data.patch, patch)
  assert.equal(preview.data.diff[0]?.stashId, 'stash-real')
  const applied = await applyAiProposal('trip-1', 'proposal-1', jsonFetch({
    proposalId: 'proposal-1', appliedPatch: { summary: '候选已安排', patch },
  }))
  assert.ok(applied.ok)
  assert.deepEqual(applied.data.appliedPatch.patch, patch)
})

test('create rejects a proposal outside the requested kind or target day', async () => {
  const wrongKind = await createAiProposal('trip-1', { kind: 'optimize' }, jsonFetch({ proposal }))
  assert.deepEqual(wrongKind, { ok: false, error: '服务器返回的建议无法解析。' })
  const wrongDay = await createAiProposal('trip-1', { kind: 'day-optimize', dayId: 'day-1' }, jsonFetch({ proposal: {
    ...proposal, kind: 'day-optimize', targetDayId: 'day-other', items: undefined,
    patch: { ops: [{ op: 'move_item', itemId: 'item-1', dayId: 'day-other' }] },
  } }))
  assert.deepEqual(wrongDay, { ok: false, error: '服务器返回的建议无法解析。' })
})

test('apply rejects a response for a different proposal id', async () => {
  const result = await applyAiProposal(
    'trip-1',
    'proposal-1',
    jsonFetch({ proposalId: 'proposal-other', appliedPatch: { summary: '已应用', patch: proposal.patch } }),
  )
  assert.deepEqual(result, { ok: false, error: '服务器返回的应用结果无法解析。' })
})
