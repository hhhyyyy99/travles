/**
 * AI provider settings API client (ticket 12).
 *
 * The server deliberately returns only `hasApiKey` and redacted custom
 * headers. The form keeps a newly entered key in memory long enough to save
 * it, but this module never stores or reconstructs a key from a read response.
 */
import type { ApiResult, FetchLike } from './tripList'
import { defaultFetch } from './tripList'

export type ProviderProtocol = 'chat-completions' | 'responses'

export type ProviderCapabilities = {
  streaming: boolean
  functionCalling: boolean
  degraded: boolean
  testedAt: string | null
  error?: string | null
}

export type AiProvider = {
  id: string
  name: string
  baseUrl: string
  modelId: string
  protocol: ProviderProtocol
  isDefault: boolean
  hasApiKey: boolean
  /** Values are always redacted by the server. */
  headers: Record<string, string>
  headerNames: string[]
  capabilities: ProviderCapabilities | null
  lastTestedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type AiProviderInput = {
  name: string
  baseUrl: string
  modelId: string
  protocol: ProviderProtocol
  apiKey?: string
  headers?: Record<string, string>
  isDefault?: boolean
  id?: string
}

export type ProviderProbe = {
  ok: boolean
  capabilities: ProviderCapabilities
  error?: string
}

export type ModelOption = { id: string }

export async function fetchAiProviders(fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<{ providers: AiProvider[]; defaultProviderId: string | null }>> {
  return requestJson(fetchLike, '/api/settings/ai-providers', { method: 'GET' }, (payload) => {
    const record = objectValue(payload)
    const raw = record?.providers
    const providers = Array.isArray(raw)
      ? raw.map(normalizeAiProvider).filter((provider): provider is AiProvider => provider !== null)
      : []
    const defaultProviderId = typeof record?.defaultProviderId === 'string' ? record.defaultProviderId : null
    return { providers, defaultProviderId }
  })
}

export async function createAiProvider(input: AiProviderInput, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<{ provider: AiProvider; probe: ProviderProbe }>> {
  return saveProvider(fetchLike, '/api/settings/ai-providers', 'POST', input)
}

export async function updateAiProvider(id: string, input: AiProviderInput, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<{ provider: AiProvider; probe: ProviderProbe }>> {
  return saveProvider(fetchLike, `/api/settings/ai-providers/${encodeURIComponent(id)}`, 'PATCH', { ...input, id })
}

export async function setDefaultAiProvider(id: string, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<{ provider: AiProvider }>> {
  return requestJson(fetchLike, `/api/settings/ai-providers/${encodeURIComponent(id)}/default`, {
    method: 'POST',
  }, (payload) => {
    const provider = normalizeAiProvider(objectValue(payload)?.provider)
    if (!provider) throw new Error('unparseable provider payload')
    return { provider }
  })
}

export async function deleteAiProvider(id: string, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<null>> {
  return requestJson(fetchLike, `/api/settings/ai-providers/${encodeURIComponent(id)}`, { method: 'DELETE' }, () => null)
}

export async function testAiProvider(input: AiProviderInput, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<ProviderProbe>> {
  return requestJson(fetchLike, '/api/settings/ai-providers/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, (payload) => {
    const result = normalizeProbe(payload)
    if (!result) throw new Error('unparseable probe payload')
    return result
  })
}

export async function testSavedAiProvider(id: string, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<ProviderProbe>> {
  return requestJson(fetchLike, `/api/settings/ai-providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
  }, (payload) => {
    const result = normalizeProbe(payload)
    if (!result) throw new Error('unparseable probe payload')
    return result
  })
}

export async function fetchProviderModels(input: AiProviderInput, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<ModelOption[]>> {
  return requestJson(fetchLike, '/api/settings/ai-providers/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, (payload) => {
    const raw = objectValue(payload)?.models
    if (!Array.isArray(raw)) return []
    return raw.map((entry) => {
      const value = typeof entry === 'string' ? entry : objectValue(entry)?.id
      return typeof value === 'string' && value.trim() ? { id: value.trim() } : null
    }).filter((entry): entry is ModelOption => entry !== null)
  })
}

export async function fetchSavedProviderModels(id: string, fetchLike: FetchLike = defaultFetch()): Promise<ApiResult<ModelOption[]>> {
  return requestJson(fetchLike, `/api/settings/ai-providers/${encodeURIComponent(id)}/models`, {
    method: 'GET',
  }, (payload) => {
    const raw = objectValue(payload)?.models
    if (!Array.isArray(raw)) return []
    return raw.map((entry) => {
      const value = typeof entry === 'string' ? entry : objectValue(entry)?.id
      return typeof value === 'string' && value.trim() ? { id: value.trim() } : null
    }).filter((entry): entry is ModelOption => entry !== null)
  })
}

async function saveProvider(
  fetchLike: FetchLike,
  url: string,
  method: 'POST' | 'PATCH',
  input: AiProviderInput,
): Promise<ApiResult<{ provider: AiProvider; probe: ProviderProbe }>> {
  return requestJson(fetchLike, url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, (payload) => {
    const record = objectValue(payload)
    const provider = normalizeAiProvider(record?.provider)
    const probe = normalizeProbe(record?.probe)
    if (!provider || !probe) throw new Error('unparseable provider payload')
    return { provider, probe }
  })
}

function normalizeAiProvider(raw: unknown): AiProvider | null {
  const record = objectValue(raw)
  if (!record || typeof record.id !== 'string' || !record.id) return null
  const capabilities = normalizeCapabilities(record.capabilities)
  const headers: Record<string, string> = {}
  if (record.headers && typeof record.headers === 'object' && !Array.isArray(record.headers)) {
    for (const [key, value] of Object.entries(record.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  const headerNames = Array.isArray(record.headerNames)
    ? record.headerNames.filter((value): value is string => typeof value === 'string')
    : Object.keys(headers)
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : '',
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
    modelId: typeof record.modelId === 'string' ? record.modelId : '',
    protocol: record.protocol === 'responses' ? 'responses' : 'chat-completions',
    isDefault: record.isDefault === true,
    hasApiKey: record.hasApiKey === true,
    headers,
    headerNames,
    capabilities,
    lastTestedAt: typeof record.lastTestedAt === 'string' ? record.lastTestedAt : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

function normalizeCapabilities(raw: unknown): ProviderCapabilities | null {
  const record = objectValue(raw)
  if (!record || typeof record.streaming !== 'boolean' || typeof record.functionCalling !== 'boolean') return null
  return {
    streaming: record.streaming,
    functionCalling: record.functionCalling,
    degraded: record.degraded === true,
    testedAt: typeof record.testedAt === 'string' ? record.testedAt : null,
    ...(typeof record.error === 'string' || record.error === null ? { error: record.error } : {}),
  }
}

function normalizeProbe(raw: unknown): ProviderProbe | null {
  const record = objectValue(raw)
  const capabilities = normalizeCapabilities(record?.capabilities)
  if (!record || typeof record.ok !== 'boolean' || !capabilities) return null
  return {
    ok: record.ok,
    capabilities,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

async function requestJson<T>(fetchLike: FetchLike, url: string, init: RequestInit, parse: (payload: unknown) => T): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetchLike(url, init)
  } catch {
    return { ok: false, error: '无法连接服务器，请确认后端服务已启动。' }
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const error = objectValue(payload)?.error
    return { ok: false, error: typeof error === 'string' && error ? error : `请求失败（HTTP ${response.status}）` }
  }
  try {
    return { ok: true, data: parse(payload) }
  } catch {
    return { ok: false, error: '服务器返回的数据无法解析。' }
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
