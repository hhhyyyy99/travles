import type { MastraLanguageModel } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import type { AiProvider, ProviderCapabilities } from './types.js'
import { endpointFor } from './probe.js'

type PromptPart = { type?: string; text?: string; delta?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; value?: unknown }
type PromptMessage = { role: string; content: string | PromptPart[] }
type CallOptions = {
  prompt: PromptMessage[]
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  stopSequences?: string[]
  tools?: Array<{ type: string; name: string; description?: string; inputSchema?: unknown; parameters?: unknown }>
  toolChoice?: unknown
  abortSignal?: AbortSignal
  responseFormat?: unknown
  headers?: Record<string, string | undefined>
}

type StreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'other'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
  | { type: 'error'; error: unknown }

type ToolCall = { id: string; name: string; args: string; index?: number }

/**
 * HTTP model adapter for both OpenAI-compatible wire formats. It keeps the
 * API key in this object on the server and never places it in model metadata,
 * response bodies, or thrown error messages.
 */
export function createProviderModel(provider: AiProvider, capabilities: ProviderCapabilities | null): MastraModelConfig {
  return new ProviderLanguageModel(provider, capabilities ?? {
    streaming: true,
    functionCalling: true,
    degraded: false,
    testedAt: null,
  }) as unknown as MastraLanguageModel
}

/** Environment fallback retained for deployments that have not saved a DB provider yet. */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): AiProvider | null {
  const baseUrl = env.AI_BASE_URL?.trim()
  const apiKey = env.AI_API_KEY?.trim()
  if (!baseUrl || !apiKey) return null
  let headers: Record<string, string> = {}
  if (env.AI_HEADERS) {
    try {
      const parsed = JSON.parse(env.AI_HEADERS) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>
      }
    } catch {
      headers = {}
    }
  }
  const now = new Date().toISOString()
  return {
    id: 'environment',
    name: '环境变量配置',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    modelId: env.AI_MODEL?.trim() || 'gpt-4o-mini',
    headers,
    protocol: env.AI_PROTOCOL === 'responses' ? 'responses' : 'chat-completions',
    isDefault: true,
    capabilities: {
      streaming: true,
      functionCalling: true,
      degraded: false,
      testedAt: null,
    },
    lastTestedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }
}

class ProviderLanguageModel {
  readonly specificationVersion = 'v2' as const
  readonly provider: string
  readonly modelId: string
  readonly supportedUrls = Promise.resolve({})

  constructor(private readonly config: AiProvider, private readonly capabilities: ProviderCapabilities) {
    this.provider = `hailar.${config.protocol}`
    this.modelId = config.modelId
  }

  async doGenerate(options: CallOptions): Promise<Record<string, unknown>> {
    const result = await this.doStream(options)
    const parts: StreamPart[] = []
    for await (const part of streamToAsyncIterable(result.stream)) parts.push(part)
    const failure = parts.find((part): part is Extract<StreamPart, { type: 'error' }> => part.type === 'error')
    if (failure) {
      throw failure.error instanceof Error ? failure.error : new Error('模型服务响应无效')
    }
    const text = parts
      .filter((part): part is Extract<StreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
      .map((part) => part.delta)
      .join('')
    const toolCalls = parts.filter((part): part is Extract<StreamPart, { type: 'tool-call' }> => part.type === 'tool-call')
    return {
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...toolCalls.map((call) => ({ type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) as unknown })),
      ],
      finishReason: toolCalls.length > 0 ? 'tool-calls' : 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      warnings: [],
    }
  }

  async doStream(options: CallOptions): Promise<{ stream: ReadableStream<StreamPart> }> {
    const request = buildRequest(this.config, this.capabilities, options)
    let response: Response
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: options.abortSignal,
      })
    } catch {
      // Never reflect provider/transport errors: custom fetch implementations
      // and upstream libraries occasionally include request details in Error.
      throw new Error('无法连接模型服务，请检查 Base URL 和网络。')
    }
    if (!response.ok) throw providerHttpError(response.status)
    if (!response.body) throw new Error('模型服务没有返回响应体')

    return { stream: parseProviderStream(response, this.config.protocol, this.capabilities.functionCalling) }
  }
}

function buildRequest(provider: AiProvider, capabilities: ProviderCapabilities, options: CallOptions): {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
} {
  const headers: Record<string, string> = {
    accept: 'text/event-stream, application/json',
    'content-type': 'application/json',
    ...provider.headers,
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'authorization') && provider.apiKey) {
    headers.authorization = `Bearer ${provider.apiKey}`
  }
  const messages = options.prompt.map(toChatMessage)
  const tools = capabilities.functionCalling ? options.tools?.map((tool) => toTool(tool, provider.protocol)) : undefined
  if (provider.protocol === 'responses') {
    const system = options.prompt.filter((message) => message.role === 'system').map(contentOf).join('\n\n')
    const input = options.prompt.filter((message) => message.role !== 'system').flatMap(toResponseInput)
    if (!capabilities.functionCalling) appendFallbackInstruction(input, system, options.tools)
    return {
      url: endpointFor(provider.baseUrl, provider.protocol),
      headers,
      body: {
        model: provider.modelId,
        ...(system ? { instructions: system } : {}),
        input,
        stream: true,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxOutputTokens !== undefined ? { max_output_tokens: options.maxOutputTokens } : {}),
      },
    }
  }
  const prompt = messages
  if (!capabilities.functionCalling) appendFallbackInstruction(prompt, '', options.tools)
  return {
    url: endpointFor(provider.baseUrl, provider.protocol),
    headers,
    body: {
      model: provider.modelId,
      messages: prompt,
      stream: true,
      ...(tools && tools.length > 0 ? { tools, tool_choice: options.toolChoice ? toToolChoice(options.toolChoice) : 'auto' } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    },
  }
}

function toChatMessage(message: PromptMessage): Record<string, unknown> {
  const content = message.content
  if (message.role === 'tool') {
    const result = Array.isArray(content) ? content.find((part) => part.type === 'tool-result') : undefined
    return {
      role: 'tool',
      tool_call_id: result?.toolCallId ?? 'tool-call',
      content: outputText(result?.output ?? result?.value ?? ''),
    }
  }
  if (!Array.isArray(content)) return { role: message.role, content }
  const text = content.filter((part) => part.type === 'text' || part.type === 'reasoning').map((part) => part.text ?? '').join('')
  const toolCalls = content
    .filter((part) => part.type === 'tool-call')
    .map((part) => ({
      id: part.toolCallId ?? 'tool-call',
      type: 'function',
      function: { name: part.toolName ?? '', arguments: JSON.stringify(part.input ?? {}) },
    }))
  return {
    role: message.role,
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

function toResponseInput(message: PromptMessage): Record<string, unknown>[] {
  if (!Array.isArray(message.content)) return [{ role: responseRole(message.role), content: [{ type: 'input_text', text: message.content }] }]
  const output: Record<string, unknown>[] = []
  for (const part of message.content) {
    if (part.type === 'text' || part.type === 'reasoning') {
      output.push({ role: responseRole(message.role), content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text ?? '' }] })
    } else if (part.type === 'tool-call') {
      output.push({ type: 'function_call', call_id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.input ?? {}) })
    } else if (part.type === 'tool-result') {
      output.push({ type: 'function_call_output', call_id: part.toolCallId, output: outputText(part.output ?? part.value ?? '') })
    }
  }
  return output
}

function responseRole(role: string): string {
  // Responses accepts user/assistant/developer roles. Mastra's system prompt
  // is sent separately as `instructions`, while tool messages become output
  // items below, so this is only a defensive normalization for odd prompts.
  return role === 'system' ? 'developer' : role === 'tool' ? 'user' : role
}

function toTool(
  tool: { type: string; name: string; description?: string; inputSchema?: unknown; parameters?: unknown },
  protocol: AiProvider['protocol'],
): Record<string, unknown> {
  const parameters = tool.parameters ?? tool.inputSchema
  if (protocol === 'responses') {
    return {
      type: 'function',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
    }
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(parameters !== undefined ? { parameters } : {}),
    },
  }
}

function toToolChoice(choice: unknown): unknown {
  if (!choice || typeof choice !== 'object') return 'auto'
  const value = choice as { type?: unknown; toolName?: unknown }
  return value.type === 'tool' && typeof value.toolName === 'string'
    ? { type: 'function', function: { name: value.toolName } }
    : value.type === 'none' ? 'none' : value.type === 'required' ? 'required' : 'auto'
}

function appendFallbackInstruction(
  messages: Array<Record<string, unknown>>,
  system: string,
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown; parameters?: unknown }>,
): void {
  const toolList = (tools ?? []).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined || tool.inputSchema !== undefined
      ? { parameters: tool.parameters ?? tool.inputSchema }
      : {}),
  }))
  const instruction = `当前模型不支持 function calling。需要调用工具时，只输出 JSON：{"tool":"工具名","arguments":{}}；不要输出 Markdown 代码围栏。可调用工具：${JSON.stringify(toolList)}。普通回答直接输出文本。`
  if (system) {
    messages.unshift({ role: 'system', content: system + '\n\n' + instruction })
  } else {
    messages.unshift({ role: 'system', content: instruction })
  }
}

function parseProviderStream(response: Response, protocol: AiProvider['protocol'], functionCalling: boolean): ReadableStream<StreamPart> {
  return new ReadableStream<StreamPart>({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      const textParts: string[] = []
      const toolCalls = new Map<string, ToolCall>()
  let finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' = 'stop'
      let textStarted = false
      let textEnded = false
      try {
        const raw = await response.text()
        if (/text\/event-stream/i.test(response.headers.get('content-type') ?? '') || /(?:^|\n)\s*(?:event:|data:)/.test(raw)) {
          parseSseText(raw, (event, payload) => {
            const result = parseEvent(event, payload, protocol, functionCalling, toolCalls)
            if (result.text) {
              if (!functionCalling) textParts.push(result.text)
              else {
                if (!textStarted) {
                  textStarted = true
                  controller.enqueue({ type: 'text-start', id: 'text-1' })
                }
                controller.enqueue({ type: 'text-delta', id: 'text-1', delta: result.text })
              }
            }
            if (result.finishReason) finishReason = result.finishReason
          })
        } else {
          const parsed = JSON.parse(raw) as unknown
          const result = parseJsonResponse(parsed, protocol, toolCalls)
          if (result.text) textParts.push(result.text)
          if (result.finishReason) finishReason = result.finishReason
        }
        if (!functionCalling) {
          const fallbackTool = parseFallbackTool(textParts.join(''))
          if (fallbackTool) toolCalls.set(fallbackTool.id, fallbackTool)
          else if (textParts.join('')) {
            textStarted = true
            controller.enqueue({ type: 'text-start', id: 'text-1' })
            controller.enqueue({ type: 'text-delta', id: 'text-1', delta: textParts.join('') })
          }
        }
        if (textStarted && !textEnded) controller.enqueue({ type: 'text-end', id: 'text-1' })
        for (const call of toolCalls.values()) {
          controller.enqueue({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.args })
        }
        if (toolCalls.size > 0) finishReason = 'tool-calls'
        controller.enqueue({ type: 'finish', finishReason, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
        controller.close()
      } catch (error) {
        controller.enqueue({ type: 'error', error })
        controller.close()
      }
    },
  })
}

function parseSseText(raw: string, emit: (event: string, payload: Record<string, unknown>) => void): void {
  let event = ''
  let data = ''
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) data += line.slice(5).trim()
    else if (line === '' && data) {
      if (data !== '[DONE]') {
        try {
          const payload = JSON.parse(data) as unknown
          if (payload && typeof payload === 'object') emit(event, payload as Record<string, unknown>)
        } catch {
          // Ignore provider keepalive/malformed chunks; the stream may continue.
        }
      }
      event = ''
      data = ''
    }
  }
  if (data && data !== '[DONE]') {
    try {
      const payload = JSON.parse(data) as unknown
      if (payload && typeof payload === 'object') emit(event, payload as Record<string, unknown>)
    } catch {
      // Ignore a truncated final event.
    }
  }
}

function parseEvent(event: string, payload: Record<string, unknown>, protocol: AiProvider['protocol'], functionCalling: boolean, toolCalls: Map<string, ToolCall>): { text?: string; finishReason?: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' } {
  if (protocol === 'responses') {
    const type = event || stringValue(payload.type)
    if (type === 'response.output_text.delta' || type === 'response.text.delta') return { text: stringValue(payload.delta) }
    if (type === 'response.function_call_arguments.delta') {
      const id = stringValue(payload.item_id) || stringValue(payload.call_id) || 'tool-call'
      const call = toolCalls.get(id) ?? { id, name: stringValue(payload.name), args: '' }
      call.args += stringValue(payload.delta)
      toolCalls.set(id, call)
      return {}
    }
    if (type === 'response.output_item.added') {
      const item = objectValue(payload.item)
      if (item && item.type === 'function_call') {
        const id = stringValue(item.call_id) || stringValue(item.id) || 'tool-call'
        toolCalls.set(id, { id, name: stringValue(item.name), args: stringValue(item.arguments) })
      }
      return {}
    }
    if (type === 'response.completed' || type === 'response.done') {
      const response = objectValue(payload.response) ?? payload
      addResponseToolCalls(response, toolCalls)
      return { finishReason: 'stop' }
    }
    return {}
  }
  const choice = objectValue((Array.isArray(payload.choices) ? payload.choices[0] : undefined))
  const delta = objectValue(choice?.delta)
  if (delta) {
    if (typeof delta.content === 'string') return { text: delta.content }
    if (functionCalling) addChatToolCalls(delta, toolCalls)
  }
  const reason = stringValue(choice?.finish_reason)
  return { finishReason: reason === 'tool_calls' ? 'tool-calls' : reason === 'length' ? 'length' : reason ? 'stop' : undefined }
}

function parseJsonResponse(payload: unknown, protocol: AiProvider['protocol'], toolCalls: Map<string, ToolCall>): { text: string; finishReason?: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' } {
  const response = objectValue(payload)
  if (!response) return { text: '' }
  if (protocol === 'responses') {
    addResponseToolCalls(response, toolCalls)
    return { text: stringValue(response.output_text) || collectResponseText(response), finishReason: 'stop' }
  }
  const choice = objectValue(Array.isArray(response.choices) ? response.choices[0] : undefined)
  const message = objectValue(choice?.message)
  if (message) addChatToolCalls(message, toolCalls)
  return { text: contentText(message?.content), finishReason: stringValue(choice?.finish_reason) === 'tool_calls' ? 'tool-calls' : 'stop' }
}

function addChatToolCalls(value: Record<string, unknown>, calls: Map<string, ToolCall>): void {
  const raw = Array.isArray(value.tool_calls) ? value.tool_calls : value.function_call ? [value.function_call] : []
  for (const entry of raw) {
    const call = objectValue(entry)
    if (!call) continue
    const fn = objectValue(call.function) ?? call
    const rawIndex = call.index
    const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) ? rawIndex : undefined
    const prior = index === undefined ? undefined : [...calls.values()].find((candidate) => candidate.index === index)
    const id = stringValue(call.id) || prior?.id || `tool-${index === undefined ? calls.size + 1 : index + 1}`
    const existing = calls.get(id) ?? { id, name: stringValue(fn.name), args: '', ...(index !== undefined ? { index } : {}) }
    existing.name ||= stringValue(fn.name)
    existing.args += stringValue(fn.arguments)
    calls.set(id, existing)
  }
}

function addResponseToolCalls(value: Record<string, unknown>, calls: Map<string, ToolCall>): void {
  const output = Array.isArray(value.output) ? value.output : []
  for (const entry of output) {
    const item = objectValue(entry)
    if (!item || item.type !== 'function_call') continue
    const id = stringValue(item.call_id) || stringValue(item.id) || `tool-${calls.size + 1}`
    calls.set(id, { id, name: stringValue(item.name), args: stringValue(item.arguments) })
  }
}

function collectResponseText(value: Record<string, unknown>): string {
  const output = Array.isArray(value.output) ? value.output : []
  return output.flatMap((entry) => {
    const item = objectValue(entry)
    const content = item && Array.isArray(item.content) ? item.content : []
    return content.map((part) => stringValue(objectValue(part)?.text))
  }).filter(Boolean).join('')
}

function parseFallbackTool(text: string): ToolCall | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const value = parsed as { tool?: unknown; name?: unknown; arguments?: unknown; args?: unknown }
    const name = typeof value.tool === 'string' ? value.tool : typeof value.name === 'string' ? value.name : ''
    const args = value.arguments ?? value.args ?? {}
    return name ? { id: 'fallback-tool-call', name, args: typeof args === 'string' ? args : JSON.stringify(args) } : null
  } catch {
    return null
  }
}

function contentOf(message: PromptMessage): string {
  return Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : message.content
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'value' in value) return outputText((value as { value?: unknown }).value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => {
    if (typeof part === 'string') return part
    const object = objectValue(part)
    return stringValue(object?.text) || stringValue(object?.content)
  }).join('')
}

function providerHttpError(status: number): Error & { statusCode: number } {
  const error = new Error(`模型服务请求失败（HTTP ${status}）`) as Error & { statusCode: number }
  error.statusCode = status
  return error
}

async function* streamToAsyncIterable<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) return
      yield item.value
    }
  } finally {
    reader.releaseLock()
  }
}
