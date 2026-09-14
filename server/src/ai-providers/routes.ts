import type { Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import { readJsonBody } from '../http/body.js'
import { AiProviderRepository, parseHeaders, toPublicAiProvider, validateProviderInput } from './repository.js'
import { probeAiProvider } from './probe.js'
import type {
  AiProvider,
  AiProviderInput,
  AiProviderProbeResult,
  ProviderProtocol,
  ThinkingLevel,
} from './types.js'
import { THINKING_LEVELS, THINKING_LEVEL_ERROR } from './types.js'

/** Injectable probe seam keeps API tests independent from external services. */
export type AiProviderProbe = (provider: Pick<AiProvider, 'baseUrl' | 'apiKey' | 'modelId' | 'headers' | 'protocol'>) => Promise<AiProviderProbeResult>

export type AiProviderRouteOptions = {
  repository: AiProviderRepository
  probe?: AiProviderProbe
}

const SETTINGS_PATH = '/api/settings/ai-providers'
const ALIAS_PATH = '/api/ai-providers'

/**
 * Register deployment-time provider settings. The response model is strictly
 * public: the secret itself and every custom-header value are omitted/masked.
 */
export function mountAiProviderRoutes(app: Hono<AppEnv>, options: AiProviderRouteOptions): void {
  const { repository } = options
  const runProbe = options.probe ?? probeAiProvider

  const list = async (c: Context<AppEnv>) => {
    const providers = await repository.list()
    const publicProviders = providers.map(toPublicAiProvider)
    const defaultProvider = providers.find((provider) => provider.isDefault) ?? providers[0] ?? null
    return noStoreJson(c, {
      providers: publicProviders,
      defaultProviderId: defaultProvider?.id ?? null,
    })
  }
  app.get(SETTINGS_PATH, list)
  app.get(ALIAS_PATH, list)

  const getOne = async (c: Context<AppEnv>) => {
    const provider = await repository.get(c.req.param('id') ?? '')
    if (!provider) return noStoreJson(c, { error: 'AI 配置不存在' }, 404)
    return noStoreJson(c, { provider: toPublicAiProvider(provider) })
  }
  app.get(`${SETTINGS_PATH}/:id`, getOne)
  app.get(`${ALIAS_PATH}/:id`, getOne)

  const create = async (c: Context<AppEnv>) => {
    const body = await readJsonBody(c)
    if (body === null) return noStoreJson(c, { error: '请求体必须是有效的 JSON' }, 400)
    const parsed = parseProviderInput(body, false)
    if (!parsed.ok) return noStoreJson(c, { error: parsed.error }, 400)
    const validation = validateProviderInput(parsed.input, true)
    if (validation) return noStoreJson(c, { error: validation }, 400)

    const candidate = candidateProvider(parsed.input)
    const probe = await safeProbe(runProbe, candidate)
    if (!probe.ok) return probeFailure(c, probe)
    const result = await repository.create(parsed.input, probe.capabilities)
    if (!result.ok) return providerFailure(c, result.error, result.code)
    return noStoreJson(c, { provider: toPublicAiProvider(result.provider), probe: publicProbe(probe) }, 201)
  }
  app.post(SETTINGS_PATH, create)
  app.post(ALIAS_PATH, create)

  const update = async (c: Context<AppEnv>) => {
    const id = c.req.param('id') ?? ''
    const current = await repository.get(id)
    if (!current) return noStoreJson(c, { error: 'AI 配置不存在' }, 404)
    const body = await readJsonBody(c)
    if (body === null) return noStoreJson(c, { error: '请求体必须是有效的 JSON' }, 400)
    const parsed = parseProviderInput(body, true)
    if (!parsed.ok) return noStoreJson(c, { error: parsed.error }, 400)
    const input: AiProviderInput = {
      ...parsed.input,
      // An omitted key means “keep the existing secret”. An explicit blank is
      // handled as a missing key too, so the browser never needs to download it.
      ...(parsed.input.apiKey === undefined ? { apiKey: current.apiKey } : {}),
      ...(parsed.input.headers === undefined ? { headers: current.headers } : {}),
    }
    const validation = validateProviderInput(input, false)
    if (validation) return noStoreJson(c, { error: validation }, 400)
    const candidate = candidateProvider({ ...input, isDefault: current.isDefault }, current)
    const probe = await safeProbe(runProbe, candidate)
    if (!probe.ok) return probeFailure(c, probe)
    const result = await repository.update(id, input, probe.capabilities)
    if (!result.ok) return providerFailure(c, result.error, result.code)
    return noStoreJson(c, { provider: toPublicAiProvider(result.provider), probe: publicProbe(probe) })
  }
  app.patch(`${SETTINGS_PATH}/:id`, update)
  app.patch(`${ALIAS_PATH}/:id`, update)

  const setDefault = async (c: Context<AppEnv>) => {
    const result = await repository.setDefault(c.req.param('id') ?? '')
    if (!result.ok) return providerFailure(c, result.error, result.code)
    return noStoreJson(c, { provider: toPublicAiProvider(result.provider) })
  }
  app.post(`${SETTINGS_PATH}/:id/default`, setDefault)
  app.post(`${ALIAS_PATH}/:id/default`, setDefault)
  app.put(`${SETTINGS_PATH}/:id/default`, setDefault)
  app.put(`${ALIAS_PATH}/:id/default`, setDefault)

  const remove = async (c: Context<AppEnv>) => {
    const result = await repository.remove(c.req.param('id') ?? '')
    if (!result.ok) return providerFailure(c, result.error, result.code)
    return noStoreJson(c, { ok: true })
  }
  app.delete(`${SETTINGS_PATH}/:id`, remove)
  app.delete(`${ALIAS_PATH}/:id`, remove)

  const testInput = async (c: Context<AppEnv>) => {
    const body = await readJsonBody(c)
    if (body === null) return noStoreJson(c, { error: '请求体必须是有效的 JSON' }, 400)
    const parsed = parseProviderInput(body, true)
    if (!parsed.ok) return noStoreJson(c, { error: parsed.error }, 400)
    const existing = typeof body.id === 'string' ? await repository.get(body.id) : null
    const input = parsed.input.apiKey === undefined && existing ? { ...parsed.input, apiKey: existing.apiKey } : parsed.input
    if (typeof input.apiKey !== 'string' || input.apiKey.trim() === '') {
      return noStoreJson(c, { error: 'API Key 不能为空' }, 400)
    }
    const validation = validateProviderInput(input, true)
    if (validation) return noStoreJson(c, { error: validation }, 400)
    const result = await safeProbe(runProbe, candidateProvider(input, existing ?? undefined))
    return noStoreJson(c, {
      ok: result.ok,
      capabilities: result.capabilities,
      ...(result.error ? { error: result.error } : {}),
    }, result.ok ? 200 : 502)
  }
  app.post(`${SETTINGS_PATH}/test`, testInput)
  app.post(`${ALIAS_PATH}/test`, testInput)

  const testSaved = async (c: Context<AppEnv>) => {
    const provider = await repository.get(c.req.param('id') ?? '')
    if (!provider) return noStoreJson(c, { error: 'AI 配置不存在' }, 404)
    const result = await safeProbe(runProbe, provider)
    return noStoreJson(c, {
      ok: result.ok,
      capabilities: result.capabilities,
      ...(result.error ? { error: result.error } : {}),
    }, result.ok ? 200 : 502)
  }
  app.post(`${SETTINGS_PATH}/:id/test`, testSaved)
  app.post(`${ALIAS_PATH}/:id/test`, testSaved)

  const models = async (c: Context<AppEnv>) => {
    const body = await readJsonBody(c)
    if (body === null) return noStoreJson(c, { error: '请求体必须是有效的 JSON' }, 400)
    const parsed = parseProviderInput(body, true)
    if (!parsed.ok) return noStoreJson(c, { error: parsed.error }, 400)
    const existing = typeof body.id === 'string' ? await repository.get(body.id) : null
    const input = parsed.input.apiKey === undefined && existing ? { ...parsed.input, apiKey: existing.apiKey } : parsed.input
    if (typeof input.apiKey !== 'string' || input.apiKey.trim() === '') {
      return noStoreJson(c, { error: 'API Key 不能为空' }, 400)
    }
    const validation = validateProviderInput(input, true)
    if (validation) return noStoreJson(c, { error: validation }, 400)
    const result = await fetchModels(candidateProvider(input, existing ?? undefined))
    if (!result.ok) return noStoreJson(c, { error: result.error, guidance: '请检查 Base URL、API Key 与服务商的模型列表接口。' }, 502)
    return noStoreJson(c, { models: result.models })
  }
  app.post(`${SETTINGS_PATH}/models`, models)
  app.post(`${ALIAS_PATH}/models`, models)

  const savedModels = async (c: Context<AppEnv>) => {
    const provider = await repository.get(c.req.param('id') ?? '')
    if (!provider) return noStoreJson(c, { error: 'AI 配置不存在' }, 404)
    const result = await fetchModels(provider)
    if (!result.ok) return noStoreJson(c, { error: result.error, guidance: '请检查 Base URL、API Key 与服务商的模型列表接口。' }, 502)
    return noStoreJson(c, { models: result.models })
  }
  app.get(`${SETTINGS_PATH}/:id/models`, savedModels)
  app.get(`${ALIAS_PATH}/:id/models`, savedModels)
}

function parseProviderInput(body: Record<string, unknown>, updating: boolean): { ok: true; input: AiProviderInput } | { ok: false; error: string } {
  const name = body.name
  const baseUrl = body.baseUrl
  const modelId = body.modelId
  const protocol = body.protocol
  if (typeof name !== 'string' || typeof baseUrl !== 'string' || typeof modelId !== 'string' || typeof protocol !== 'string') {
    return { ok: false, error: 'AI 配置需要 name、baseUrl、modelId、protocol 字段' }
  }
  if (protocol !== 'chat-completions' && protocol !== 'responses') return { ok: false, error: '协议格式必须是 chat-completions 或 responses' }
  const headers = parseHeaders(body.headers)
  if (!headers.ok) return headers
  if (!updating && (typeof body.apiKey !== 'string' || body.apiKey.trim() === '')) return { ok: false, error: 'API Key 不能为空' }
  if (body.apiKey !== undefined && typeof body.apiKey !== 'string') return { ok: false, error: 'API Key 必须是字符串' }
  if (body.isDefault !== undefined && typeof body.isDefault !== 'boolean') return { ok: false, error: 'isDefault 必须是布尔值' }
  const thinking = body.thinking
  if (thinking !== undefined && (typeof thinking !== 'string' || !THINKING_LEVELS.includes(thinking as ThinkingLevel))) {
    return { ok: false, error: THINKING_LEVEL_ERROR }
  }
  return {
    ok: true,
    input: {
      name,
      baseUrl,
      modelId,
      protocol: protocol as ProviderProtocol,
      ...(body.apiKey !== undefined && body.apiKey.trim() !== '' ? { apiKey: body.apiKey } : {}),
      ...(body.headers !== undefined ? { headers: headers.headers } : {}),
      ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
      ...(thinking !== undefined ? { thinking: thinking as 'off' | 'low' | 'medium' | 'high' } : {}),
    },
  }
}

function candidateProvider(input: AiProviderInput, current?: Pick<AiProvider, 'id' | 'createdAt' | 'updatedAt' | 'isDefault'>): AiProvider {
  const now = new Date().toISOString()
  return {
    id: current?.id ?? 'probe',
    name: input.name.trim(),
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: input.apiKey?.trim() ?? '',
    modelId: input.modelId.trim(),
    headers: input.headers ?? {},
    protocol: input.protocol,
    thinking: input.thinking ?? 'off',
    isDefault: input.isDefault ?? current?.isDefault ?? false,
    capabilities: null,
    lastTestedAt: null,
    lastError: null,
    createdAt: current?.createdAt ?? now,
    updatedAt: current?.updatedAt ?? now,
  }
}

async function safeProbe(probe: AiProviderProbe, provider: AiProvider): Promise<AiProviderProbeResult> {
  try {
    return redactProbeResult(await probe(provider), provider)
  } catch {
    return {
      ok: false,
      capabilities: {
        streaming: false,
        functionCalling: false,
        degraded: true,
        testedAt: new Date().toISOString(),
        error: '无法连接模型服务，请检查配置后重试。',
      },
      error: '无法连接模型服务，请检查配置后重试。',
    }
  }
}

function redactProbeResult(result: AiProviderProbeResult, provider: AiProvider): AiProviderProbeResult {
  const redact = (value: string | undefined): string | undefined => {
    if (!value) return value
    return [provider.apiKey, ...Object.values(provider.headers)]
      .filter((secret) => secret.length > 0)
      .reduce((text, secret) => text.replaceAll(secret, '[redacted]'), value)
  }
  const error = redact(result.error)
  const capabilityError = redact(result.capabilities.error ?? undefined)
  return {
    ok: result.ok,
    capabilities: {
      ...result.capabilities,
      ...(capabilityError !== undefined ? { error: capabilityError } : {}),
    },
    ...(error !== undefined ? { error } : {}),
  }
}

function publicProbe(result: AiProviderProbeResult): { ok: boolean; capabilities: AiProviderProbeResult['capabilities']; error?: string } {
  return {
    ok: result.ok,
    capabilities: result.capabilities,
    ...(result.error ? { error: result.error } : {}),
  }
}

function probeFailure(c: Context<AppEnv>, result: AiProviderProbeResult): Response {
  return noStoreJson(c, {
    error: result.error ?? result.capabilities.error ?? '模型服务连通性测试失败。',
    probe: publicProbe(result),
  }, 502)
}

function providerFailure(c: Context<AppEnv>, error: string, code: string): Response {
  return noStoreJson(c, { error }, code === 'not_found' ? 404 : code === 'storage' ? 500 : 400)
}

async function fetchModels(provider: Pick<AiProvider, 'baseUrl' | 'apiKey' | 'headers' | 'protocol'> & { modelId?: string }): Promise<{ ok: true; models: { id: string }[] } | { ok: false; error: string }> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = { accept: 'application/json', ...provider.headers }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) headers.authorization = `Bearer ${provider.apiKey}`
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return { ok: false, error: `模型列表请求失败（HTTP ${response.status}）。` }
    const payload = await response.json().catch(() => null) as unknown
    const raw = Array.isArray(payload) ? payload : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data) ? (payload as { data: unknown[] }).data : []
    const models = raw.map((entry) => typeof entry === 'string' ? { id: entry } : entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string' ? { id: (entry as { id: string }).id } : null).filter((entry): entry is { id: string } => entry !== null && entry.id.trim() !== '')
    return { ok: true, models }
  } catch {
    return { ok: false, error: '无法连接模型服务，请检查 Base URL 和网络。' }
  }
}

function noStoreJson(c: Context<AppEnv>, body: unknown, status = 200): Response {
  c.header('cache-control', 'no-store')
  return c.json(body, status as never)
}
