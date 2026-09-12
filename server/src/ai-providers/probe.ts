import type { AiProvider, AiProviderProbeResult, ProviderCapabilities, ProviderProtocol } from './types.js'

type ProbeResponse = {
  status: number
  contentType: string
  text: string
}

const PROBE_TIMEOUT_MS = 15_000

/** Probe connectivity and the two capabilities that affect the agent loop. */
export async function probeAiProvider(provider: Pick<AiProvider, 'baseUrl' | 'apiKey' | 'modelId' | 'headers' | 'protocol'>): Promise<AiProviderProbeResult> {
  const testedAt = new Date().toISOString()
  const base: ProviderCapabilities = {
    streaming: false,
    functionCalling: false,
    degraded: true,
    testedAt,
    error: null,
  }

  let streamingResponse: ProbeResponse
  try {
    streamingResponse = await requestProvider(provider, {
      stream: true,
      includeTools: false,
      prompt: '请只回复 OK。',
    })
  } catch (error) {
    return { ok: false, capabilities: { ...base, error: safeProbeError(error) }, error: safeProbeError(error) }
  }

  if (streamingResponse.status === 401 || streamingResponse.status === 403) {
    const error = '模型服务鉴权失败（HTTP 401/403）'
    return { ok: false, capabilities: { ...base, error }, error }
  }

  if (streamingResponse.status >= 200 && streamingResponse.status < 300) {
    base.streaming = looksLikeStream(streamingResponse)
  } else if (streamingResponse.status >= 400 && streamingResponse.status < 500) {
    // A provider may reject `stream: true` while still supporting normal
    // requests. Keep the config usable and record streaming=false.
    try {
      const regular = await requestProvider(provider, { stream: false, includeTools: false, prompt: '请只回复 OK。' })
      if (regular.status === 401 || regular.status === 403) {
        const error = '模型服务鉴权失败（HTTP 401/403）'
        return { ok: false, capabilities: { ...base, error }, error }
      }
      if (regular.status < 200 || regular.status >= 300) {
        const error = `模型服务连接失败（HTTP ${regular.status}）`
        return { ok: false, capabilities: { ...base, error }, error }
      }
    } catch (error) {
      const message = safeProbeError(error)
      return { ok: false, capabilities: { ...base, error: message }, error: message }
    }
  } else {
    const error = `模型服务连接失败（HTTP ${streamingResponse.status}）`
    return { ok: false, capabilities: { ...base, error }, error }
  }

  try {
    const functionResponse = await requestProvider(provider, {
      stream: false,
      includeTools: true,
      prompt: '请调用工具 probe_capability，并传入 {"ok":true}。',
    })
    if (functionResponse.status === 401 || functionResponse.status === 403) {
      const error = '模型服务鉴权失败（HTTP 401/403）'
      return { ok: false, capabilities: { ...base, error }, error }
    }
    if (functionResponse.status >= 200 && functionResponse.status < 300 && supportsFunctionCalling(functionResponse, provider.protocol)) {
      base.functionCalling = true
    }
  } catch {
    // An unreachable capability probe is treated as unsupported, while the
    // successful basic connectivity result remains useful to the operator.
    base.functionCalling = false
  }
  base.degraded = !base.functionCalling
  if (base.degraded) base.error = '该模型不支持 function calling，已降级为约定 JSON 文本解析。'
  else if (!base.streaming) base.error = '该模型不支持流式输出，将在服务端完整读取后返回。'
  return { ok: true, capabilities: base }
}

export async function requestProvider(
  provider: Pick<AiProvider, 'baseUrl' | 'apiKey' | 'modelId' | 'headers' | 'protocol'>,
  options: { stream: boolean; includeTools: boolean; prompt: string },
): Promise<ProbeResponse> {
  const endpoint = endpointFor(provider.baseUrl, provider.protocol)
  const headers: Record<string, string> = {
    accept: options.stream ? 'text/event-stream, application/json' : 'application/json',
    'content-type': 'application/json',
    ...provider.headers,
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'authorization') && provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`
  }
  const body = provider.protocol === 'responses'
    ? responsesBody(provider.modelId, options)
    : chatCompletionsBody(provider.modelId, options)
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal })
  const text = await response.text()
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', text: text.slice(0, 1_000_000) }
}

export function endpointFor(baseUrl: string, protocol: ProviderProtocol): string {
  return `${baseUrl.replace(/\/+$/, '')}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`
}

export function chatCompletionsBody(model: string, options: { stream: boolean; includeTools: boolean; prompt: string }): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content: options.prompt }],
    stream: options.stream,
    ...(options.includeTools
      ? {
          tools: [{ type: 'function', function: { name: 'probe_capability', description: 'Capability probe', parameters: { type: 'object', properties: {} } } }],
          tool_choice: { type: 'function', function: { name: 'probe_capability' } },
        }
      : {}),
  }
}

export function responsesBody(model: string, options: { stream: boolean; includeTools: boolean; prompt: string }): Record<string, unknown> {
  return {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: options.prompt }] }],
    stream: options.stream,
    ...(options.includeTools
      ? {
          tools: [{ type: 'function', name: 'probe_capability', description: 'Capability probe', parameters: { type: 'object', properties: {} } }],
          tool_choice: { type: 'function', name: 'probe_capability' },
        }
      : {}),
  }
}

function looksLikeStream(response: ProbeResponse): boolean {
  return /text\/event-stream/i.test(response.contentType) || /(?:^|\n)\s*(?:event:|data:)/.test(response.text)
}

function supportsFunctionCalling(response: ProbeResponse, protocol: ProviderProtocol): boolean {
  if (hasProviderError(response.text)) return false
  const text = response.text
  try {
    const parsed = JSON.parse(text) as unknown
    if (protocol === 'responses') return hasResponseFunctionCall(parsed)
    return hasChatFunctionCall(parsed)
  } catch {
    // A provider may use SSE even when it returns application/json as its
    // content type. Inspect each event for the protocol's tool-call fields.
    return protocol === 'responses'
      ? /function_call|function_call_arguments/.test(text)
      : /tool_calls|function_call/.test(text)
  }
}

function hasChatFunctionCall(value: unknown): boolean {
  const response = objectValue(value)
  const choices = response && Array.isArray(response.choices) ? response.choices : []
  const first = objectValue(choices[0])
  const message = objectValue(first?.message)
  return Boolean(message && (Array.isArray(message.tool_calls) && message.tool_calls.length > 0 || message.function_call))
}

function hasResponseFunctionCall(value: unknown): boolean {
  const response = objectValue(value)
  const output = response && Array.isArray(response.output) ? response.output : []
  return output.some((entry) => objectValue(entry)?.type === 'function_call')
}

function hasProviderError(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { error?: unknown }
    return parsed.error !== undefined && parsed.error !== null
  } catch {
    return false
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeProbeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '连接模型服务超时'
  if (error instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(error.message)) {
    return '无法连接模型服务，请检查 Base URL 和网络。'
  }
  return '无法连接模型服务，请检查配置后重试。'
}
