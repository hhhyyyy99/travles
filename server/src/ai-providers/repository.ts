import { randomUUID } from 'node:crypto'
import type {
  AiProvider,
  AiProviderInput,
  AiProviderMutationResult,
  AiProviderRow,
  AiProviderStoreDriver,
  ProviderCapabilities,
  ProviderProtocol,
  PublicAiProvider,
  ThinkingLevel,
} from './types.js'

const PROTOCOLS: ProviderProtocol[] = ['chat-completions', 'responses']
const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high']

function normalizeThinking(value: unknown): ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : 'off'
}

export class AiProviderRepository {
  constructor(private readonly driver: AiProviderStoreDriver) {}

  async list(): Promise<AiProvider[]> {
    try {
      const rows = await this.driver.listRows()
      if (!Array.isArray(rows)) return []
      return rows.map(mapRow).filter((row): row is AiProvider => row !== null)
    } catch {
      return []
    }
  }

  async get(id: string): Promise<AiProvider | null> {
    try {
      const row = await this.driver.getRow(id)
      return row ? mapRow(row) : null
    } catch {
      return null
    }
  }

  async getDefault(): Promise<AiProvider | null> {
    const providers = await this.list()
    return providers.find((provider) => provider.isDefault) ?? providers[0] ?? null
  }

  async create(input: AiProviderInput, capabilities: ProviderCapabilities): Promise<AiProviderMutationResult> {
    const validation = validateProviderInput(input, true)
    if (validation) return { ok: false, error: validation, code: 'invalid' }
    const now = new Date().toISOString()
    const headers = parseHeaders(input.headers)
    if (!headers.ok) return { ok: false, error: headers.error, code: 'invalid' }
    const existing = await this.list()
    const row: AiProviderRow = {
      id: randomUUID(),
      name: input.name.trim(),
      base_url: normalizeBaseUrl(input.baseUrl),
      api_key: input.apiKey?.trim() ?? '',
      model_id: input.modelId.trim(),
      headers: JSON.stringify(headers.headers),
      protocol: input.protocol,
      thinking: normalizeThinking(input.thinking),
      is_default: input.isDefault || existing.length === 0 ? 1 : 0,
      capabilities: JSON.stringify(capabilities),
      last_tested_at: capabilities.testedAt,
      last_error: capabilities.error ?? null,
      created_at: now,
      updated_at: now,
    }
    try {
      await this.driver.insertRow(row)
      if (row.is_default === 1) await this.driver.setDefault(row.id)
      const created = await this.driver.getRow(row.id)
      const provider = created ? mapRow(created) : null
      if (!provider) return { ok: false, error: '保存失败', code: 'storage' }
      return { ok: true, provider }
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
  }

  async update(id: string, input: AiProviderInput, capabilities: ProviderCapabilities): Promise<AiProviderMutationResult> {
    const current = await this.get(id)
    if (!current) return { ok: false, error: 'AI 配置不存在', code: 'not_found' }
    const validation = validateProviderInput(input, false)
    if (validation) return { ok: false, error: validation, code: 'invalid' }
    const now = new Date().toISOString()
    const headers = parseHeaders(input.headers)
    if (!headers.ok) return { ok: false, error: headers.error, code: 'invalid' }
    const patch: Partial<AiProviderRow> = {
      name: input.name.trim(),
      base_url: normalizeBaseUrl(input.baseUrl),
      model_id: input.modelId.trim(),
      headers: JSON.stringify(headers.headers),
      protocol: input.protocol,
      ...(input.thinking !== undefined ? { thinking: normalizeThinking(input.thinking) } : {}),
      capabilities: JSON.stringify(capabilities),
      last_tested_at: capabilities.testedAt,
      last_error: capabilities.error ?? null,
      updated_at: now,
    }
    if (input.apiKey !== undefined && input.apiKey.trim() !== '') patch.api_key = input.apiKey.trim()
    if (input.isDefault === true) patch.is_default = 1
    try {
      const updated = await this.driver.updateRow(id, patch)
      if (!updated) return { ok: false, error: 'AI 配置不存在', code: 'not_found' }
      if (input.isDefault === true) await this.driver.setDefault(id)
      const saved = await this.driver.getRow(id)
      const provider = saved ? mapRow(saved) : null
      if (!provider) return { ok: false, error: '保存失败', code: 'storage' }
      return { ok: true, provider }
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
  }

  async setDefault(id: string): Promise<AiProviderMutationResult> {
    try {
      if (!(await this.driver.setDefault(id))) return { ok: false, error: 'AI 配置不存在', code: 'not_found' }
      const row = await this.driver.getRow(id)
      const provider = row ? mapRow(row) : null
      if (!provider) return { ok: false, error: '保存失败', code: 'storage' }
      return { ok: true, provider }
    } catch {
      return { ok: false, error: '保存失败', code: 'storage' }
    }
  }

  async remove(id: string): Promise<{ ok: true } | { ok: false; error: string; code: 'not_found' | 'storage' }> {
    const current = await this.get(id)
    if (!current) return { ok: false, error: 'AI 配置不存在', code: 'not_found' }
    try {
      if (!(await this.driver.deleteRow(id))) return { ok: false, error: 'AI 配置不存在', code: 'not_found' }
      if (current.isDefault) {
        const next = (await this.list())[0]
        if (next) await this.driver.setDefault(next.id)
      }
      return { ok: true }
    } catch {
      return { ok: false, error: '删除失败', code: 'storage' }
    }
  }
}

export function toPublicAiProvider(provider: AiProvider): PublicAiProvider {
  const { apiKey, headers, ...safe } = provider
  void apiKey
  const redact = (value: string | null): string | null => {
    if (value === null) return null
    return [provider.apiKey, ...Object.values(headers)]
      .filter((secret) => secret.length > 0)
      .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
  }
  const capabilities = safe.capabilities
    ? { ...safe.capabilities, ...(safe.capabilities.error !== undefined ? { error: redact(safe.capabilities.error ?? null) } : {}) }
    : null
  return {
    ...safe,
    capabilities,
    lastError: redact(safe.lastError),
    // A custom header can carry a second API token. Keep the public shape
    // useful for editing while guaranteeing no header value crosses HTTP.
    headers: Object.fromEntries(Object.keys(headers).map((key) => [key, '[hidden]'])),
    headerNames: Object.keys(headers),
    hasApiKey: provider.apiKey.length > 0,
  }
}

export function parseHeaders(value: unknown): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') return { ok: true, headers: {} }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return normalizeHeaders(value as Record<string, unknown>)
  }
  if (typeof value !== 'string') return { ok: false, error: '自定义请求头必须是 JSON 对象' }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { ok: false, error: '自定义请求头必须是有效的 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '自定义请求头必须是 JSON 对象' }
  }
  return normalizeHeaders(parsed as Record<string, unknown>)
}

function normalizeHeaders(input: Record<string, unknown>): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) return { ok: false, error: `请求头名称无效：${key}` }
    if (typeof value !== 'string') return { ok: false, error: `请求头「${key}」的值必须是字符串` }
    if (/[\r\n]/.test(value)) return { ok: false, error: `请求头「${key}」的值包含无效换行` }
    headers[key] = value
  }
  return { ok: true, headers }
}

export function validateProviderInput(input: AiProviderInput, creating: boolean): string | null {
  if (!input || typeof input !== 'object') return 'AI 配置无效'
  if (typeof input.name !== 'string' || input.name.trim() === '') return '名称不能为空'
  if (input.name.trim().length > 100) return '名称过长（最多 100 字）'
  if (typeof input.baseUrl !== 'string' || !isHttpUrl(input.baseUrl)) return 'Base URL 必须是 http(s) 地址'
  if (typeof input.modelId !== 'string' || input.modelId.trim() === '') return '模型 ID 不能为空'
  if (!PROTOCOLS.includes(input.protocol)) return '协议格式必须是 chat-completions 或 responses'
  if (input.thinking !== undefined && !THINKING_LEVELS.includes(input.thinking)) return '思考档位必须是 off、low、medium 或 high'
  if (creating && (typeof input.apiKey !== 'string' || input.apiKey.trim() === '')) return 'API Key 不能为空'
  if (input.apiKey !== undefined && typeof input.apiKey !== 'string') return 'API Key 必须是字符串'
  const headers = parseHeaders(input.headers)
  if (!headers.ok) return headers.error
  return null
}

function mapRow(row: AiProviderRow): AiProvider | null {
  if (!row || typeof row.id !== 'string' || row.id === '') return null
  const protocol: ProviderProtocol = row.protocol === 'responses' ? 'responses' : 'chat-completions'
  const thinking: ThinkingLevel = normalizeThinking(row.thinking)
  let headers: Record<string, string> = {}
  try {
    const parsed = row.headers ? JSON.parse(row.headers) : {}
    const normalized = parseHeaders(parsed)
    if (normalized.ok) headers = normalized.headers
  } catch {
    headers = {}
  }
  let capabilities: ProviderCapabilities | null = null
  try {
    const parsed = row.capabilities ? JSON.parse(row.capabilities) : null
    if (parsed && typeof parsed === 'object' && typeof parsed.streaming === 'boolean' && typeof parsed.functionCalling === 'boolean') {
      capabilities = {
        streaming: parsed.streaming,
        functionCalling: parsed.functionCalling,
        degraded: parsed.degraded === true,
        testedAt: typeof parsed.testedAt === 'string' ? parsed.testedAt : row.last_tested_at ?? null,
        ...(typeof parsed.error === 'string' || parsed.error === null ? { error: parsed.error } : {}),
      }
    }
  } catch {
    capabilities = null
  }
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : '',
    baseUrl: typeof row.base_url === 'string' ? row.base_url : '',
    apiKey: typeof row.api_key === 'string' ? row.api_key : '',
    modelId: typeof row.model_id === 'string' ? row.model_id : '',
    headers,
    protocol,
    thinking,
    isDefault: row.is_default === 1 || (row.is_default as unknown) === true,
    capabilities,
    lastTestedAt: typeof row.last_tested_at === 'string' ? row.last_tested_at : null,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}
