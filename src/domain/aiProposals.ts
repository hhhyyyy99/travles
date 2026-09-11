/** Client codec for ticket 13's preview → confirm → TripPatch flow. */
import type { ApiResult, FetchLike } from './tripList'
import { defaultFetch } from './tripList'

export type ProposalKind = 'parse' | 'optimize' | 'day-optimize'

export type ProposalItem = {
  itemId: string
  dayId: string
  order?: number
  type: 'traffic' | 'stay' | 'attraction' | 'food' | 'other'
  title: string
  note?: string
  pending?: boolean
  poi?: { name: string; lat: number; lng: number; amapId?: string; category?: string; rating?: number } | null
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
  patch: unknown
  items?: ProposalItem[]
  targetDayId?: string
  createdAt: string
}

export type ProposalRequest = { kind: ProposalKind; text?: string; dayId?: string }

export type ProposalAppliedPatch = {
  summary: string
  stats?: Record<string, number>
  patch?: unknown
}

export type ProposalApplyResult = {
  proposalId: string
  appliedPatch: ProposalAppliedPatch
}

export type AiProposalState =
  | { status: 'idle' }
  | { status: 'loading'; request: ProposalRequest }
  | { status: 'ready'; proposal: AiProposal }
  | { status: 'applying'; proposal: AiProposal }
  | { status: 'error'; request: ProposalRequest; error: string; proposal?: AiProposal }
  | { status: 'applied'; record: ProposalAppliedPatch }

export const PROPOSAL_NETWORK_ERROR = '无法连接服务器，请确认后端服务已启动。'

export async function createAiProposal(
  tripId: string,
  request: ProposalRequest,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<AiProposal>> {
  let response: Response
  try {
    response = await fetchLike(`/api/trips/${encodeURIComponent(tripId)}/ai/proposals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch {
    return { ok: false, error: PROPOSAL_NETWORK_ERROR }
  }
  if (!response.ok) return { ok: false, error: await readError(response) }
  const payload = (await response.json().catch(() => null)) as { proposal?: unknown } | null
  const proposal = normalizeProposal(payload?.proposal)
  return proposal === null ? { ok: false, error: '服务器返回的建议无法解析。' } : { ok: true, data: proposal }
}

export async function applyAiProposal(
  tripId: string,
  proposalId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<ProposalApplyResult>> {
  let response: Response
  try {
    response = await fetchLike(
      `/api/trips/${encodeURIComponent(tripId)}/ai/proposals/${encodeURIComponent(proposalId)}/apply`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
    )
  } catch {
    return { ok: false, error: PROPOSAL_NETWORK_ERROR }
  }
  if (!response.ok) return { ok: false, error: await readError(response) }
  const payload = (await response.json().catch(() => null)) as { proposalId?: unknown; appliedPatch?: unknown } | null
  const proposalIdValue = typeof payload?.proposalId === 'string' ? payload.proposalId : ''
  const appliedPatch = normalizeAppliedPatch(payload?.appliedPatch)
  if (!proposalIdValue || appliedPatch === null) return { ok: false, error: '服务器返回的应用结果无法解析。' }
  return { ok: true, data: { proposalId: proposalIdValue, appliedPatch } }
}

export async function cancelAiProposal(
  tripId: string,
  proposalId: string,
  fetchLike: FetchLike = defaultFetch(),
): Promise<ApiResult<null>> {
  try {
    const response = await fetchLike(
      `/api/trips/${encodeURIComponent(tripId)}/ai/proposals/${encodeURIComponent(proposalId)}`,
      { method: 'DELETE' },
    )
    if (!response.ok) return { ok: false, error: await readError(response) }
    return { ok: true, data: null }
  } catch {
    return { ok: false, error: PROPOSAL_NETWORK_ERROR }
  }
}

export function normalizeProposal(raw: unknown): AiProposal | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const tripId = typeof record.tripId === 'string' ? record.tripId : ''
  const kind = record.kind
  const title = typeof record.title === 'string' ? record.title : ''
  const summary = typeof record.summary === 'string' ? record.summary : ''
  if (!id || !tripId || (kind !== 'parse' && kind !== 'optimize' && kind !== 'day-optimize') || !title || !summary) return null
  if (!Array.isArray(record.diff)) return null
  const diff: ProposalChange[] = []
  for (const entry of record.diff) {
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (!['add', 'update', 'move', 'remove'].includes(String(item.action)) || typeof item.label !== 'string' || !item.label) continue
    diff.push({
      action: item.action as ProposalChange['action'],
      label: item.label,
      ...(typeof item.detail === 'string' && item.detail ? { detail: item.detail } : {}),
      ...(typeof item.itemId === 'string' && item.itemId ? { itemId: item.itemId } : {}),
      ...(typeof item.dayId === 'string' && item.dayId ? { dayId: item.dayId } : {}),
      ...(typeof item.fromDayId === 'string' && item.fromDayId ? { fromDayId: item.fromDayId } : {}),
      ...(typeof item.toDayId === 'string' && item.toDayId ? { toDayId: item.toDayId } : {}),
    })
  }
  if (diff.length === 0) return null
  const items = Array.isArray(record.items)
    ? record.items.map(normalizeProposalItem).filter((item): item is ProposalItem => item !== null)
    : undefined
  return {
    id,
    tripId,
    kind,
    title,
    summary,
    diff,
    patch: record.patch,
    ...(items !== undefined && items.length > 0 ? { items } : {}),
    ...(typeof record.targetDayId === 'string' && record.targetDayId ? { targetDayId: record.targetDayId } : {}),
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
  }
}

function normalizeProposalItem(raw: unknown): ProposalItem | null {
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  if (
    typeof item.itemId !== 'string' || !item.itemId ||
    typeof item.dayId !== 'string' || !item.dayId ||
    typeof item.title !== 'string' || !item.title ||
    !['traffic', 'stay', 'attraction', 'food', 'other'].includes(String(item.type))
  ) return null
  const poi = normalizeProposalPoi(item.poi)
  return {
    itemId: item.itemId,
    dayId: item.dayId,
    ...(typeof item.order === 'number' && Number.isInteger(item.order) ? { order: item.order } : {}),
    type: item.type as ProposalItem['type'],
    title: item.title,
    ...(typeof item.note === 'string' ? { note: item.note } : {}),
    ...(typeof item.pending === 'boolean' ? { pending: item.pending } : {}),
    ...(poi !== undefined ? { poi } : {}),
    ...(typeof item.legPending === 'boolean' ? { legPending: item.legPending } : {}),
  }
}

function normalizeProposalPoi(raw: unknown): ProposalItem['poi'] | undefined {
  if (raw === null) return null
  if (raw === undefined || typeof raw !== 'object') return undefined
  const poi = raw as Record<string, unknown>
  if (typeof poi.name !== 'string' || typeof poi.lat !== 'number' || typeof poi.lng !== 'number') return undefined
  return {
    name: poi.name,
    lat: poi.lat,
    lng: poi.lng,
    ...(typeof poi.amapId === 'string' ? { amapId: poi.amapId } : {}),
    ...(typeof poi.category === 'string' ? { category: poi.category } : {}),
    ...(typeof poi.rating === 'number' ? { rating: poi.rating } : {}),
  }
}

function normalizeAppliedPatch(raw: unknown): ProposalAppliedPatch | null {
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (typeof record.summary !== 'string' || !record.summary) return null
  const stats: Record<string, number> = {}
  if (record.stats !== null && typeof record.stats === 'object') {
    for (const [key, value] of Object.entries(record.stats as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) stats[key] = value
    }
  }
  return { summary: record.summary, ...(Object.keys(stats).length > 0 ? { stats } : {}), patch: record.patch }
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; guidance?: unknown } | null
  if (typeof body?.error === 'string' && body.error) {
    return typeof body.guidance === 'string' && body.guidance ? `${body.error} ${body.guidance}` : body.error
  }
  return `请求失败（HTTP ${response.status}）`
}
