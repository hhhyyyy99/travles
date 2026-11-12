import { createHash } from 'node:crypto'
import type { MastraLanguageModel } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import type { AiProvider, ProviderCapabilities } from './types.js'
import { THINKING_LEVELS } from './types.js'
import { endpointFor } from './probe.js'

type ProviderMetadata = { hailar: { providerId: string; modelId: string; endpointFingerprint: string }; google?: { thoughtSignature: string } }
type PromptPart = { type?: string; text?: string; delta?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; value?: unknown; providerOptions?: Record<string, Record<string, unknown>> }
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
  | { type: 'reasoning-start'; id: string; providerMetadata: ProviderMetadata }
  | { type: 'reasoning-delta'; id: string; delta: string; providerMetadata: ProviderMetadata }
  | { type: 'reasoning-end'; id: string; providerMetadata: ProviderMetadata }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string; providerMetadata?: ProviderMetadata }
  | { type: 'finish'; finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'other'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
  | { type: 'error'; error: unknown }

type ToolCall = { id: string; name: string; args: string; index?: number; aliases?: string[]; thoughtSignature?: string }

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
    thinking: 'off',
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
    const reasoning = parts
      .filter((part): part is Extract<StreamPart, { type: 'reasoning-delta' }> => part.type === 'reasoning-delta')
      .map((part) => part.delta)
      .join('')
    const toolCalls = parts.filter((part): part is Extract<StreamPart, { type: 'tool-call' }> => part.type === 'tool-call')
    return {
      content: [
        ...(parts.some((part) => part.type === 'reasoning-start') ? [{ type: 'reasoning', text: reasoning, providerMetadata: sourceMetadata(this.config) }] : []),
        ...(text ? [{ type: 'text', text }] : []),
        ...toolCalls.map((call) => ({
          type: 'tool-call', toolCallId: call.toolCallId, toolName: call.toolName, input: JSON.parse(call.input) as unknown,
          ...(call.providerMetadata ? { providerMetadata: call.providerMetadata } : {}),
        })),
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

    return { stream: parseProviderStream(response, this.config, this.capabilities.functionCalling) }
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
  const fallback = !capabilities.functionCalling
  const messages = options.prompt.flatMap((message) => toChatMessage(message, provider, fallback))
  const tools = capabilities.functionCalling ? options.tools?.map((tool) => toTool(tool, provider.protocol)) : undefined
  // Thinking budget: wire-format-only. `off` (the default for env/legacy
  // providers) emits no reasoning field at all; `low/medium/high` map to the
  // provider's native effort control. No vendor-private flags are sent.
  const effort = THINKING_LEVELS.includes(provider.thinking) ? provider.thinking : 'off'
  if (provider.protocol === 'responses') {
    const system = options.prompt.filter((message) => message.role === 'system').map(contentOf).join('\n\n')
    const input = options.prompt.filter((message) => message.role !== 'system').flatMap((message) => toResponseInput(message, fallback))
    const instructions = fallback
      ? [system, fallbackInstruction(options.tools)].filter(Boolean).join('\n\n')
      : system
    return {
      url: endpointFor(provider.baseUrl, provider.protocol),
      headers,
      body: {
        model: provider.modelId,
        ...(instructions ? { instructions } : {}),
        input,
        stream: capabilities.streaming,
        ...(effort !== 'off' ? { reasoning: { effort } } : {}),
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
      stream: capabilities.streaming,
      ...(effort !== 'off' ? { reasoning_effort: effort } : {}),
      ...(tools && tools.length > 0 ? { tools, tool_choice: options.toolChoice ? toToolChoice(options.toolChoice) : 'auto' } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.topP !== undefined ? { top_p: options.topP } : {}),
      ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    },
  }
}

function toChatMessage(message: PromptMessage, provider: AiProvider, fallback = false): Record<string, unknown>[] {
  if (fallback) return toFallbackChatMessages(message, provider)
  const content = message.content
  if (message.role === 'tool') {
    const results = Array.isArray(content) ? content.filter((part) => part.type === 'tool-result') : []
    return results.length > 0
      ? results.map((result) => ({
          role: 'tool',
          tool_call_id: result.toolCallId ?? 'tool-call',
          content: outputText(result.output ?? result.value ?? ''),
        }))
      : [{ role: 'tool', tool_call_id: 'tool-call', content: '' }]
  }
  if (!Array.isArray(content)) return [{ role: message.role, content }]
  const text = content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('')
  const reasoning = assistantReasoning(message, provider)
  const toolCalls = content
    .filter((part) => part.type === 'tool-call')
    .map((part) => ({
      id: part.toolCallId ?? 'tool-call',
      type: 'function',
      function: { name: part.toolName ?? '', arguments: JSON.stringify(part.input ?? {}) },
      ...(matchesSource(part, provider) && typeof part.providerOptions?.google?.thoughtSignature === 'string'
        ? { extra_content: { google: { thought_signature: part.providerOptions.google.thoughtSignature } } }
        : {}),
    }))
  return [{
    role: message.role,
    content: text,
    ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }]
}

function endpointFingerprint(provider: AiProvider): string {
  const endpoint = new URL(endpointFor(provider.baseUrl, provider.protocol)).href
  // URLs may contain credentials; only their opaque identity enters memory.
  return createHash('sha256').update(JSON.stringify([provider.protocol, endpoint])).digest('hex')
}

function sourceMetadata(provider: AiProvider): ProviderMetadata {
  return { hailar: { providerId: provider.id, modelId: provider.modelId, endpointFingerprint: endpointFingerprint(provider) } }
}

/** Private replay fields belong to the provider/model/endpoint that returned them. */
function matchesSource(part: PromptPart, provider: AiProvider): boolean {
  const source = part.providerOptions?.hailar
  return !source || (source.providerId === provider.id && source.modelId === provider.modelId && source.endpointFingerprint === endpointFingerprint(provider))
}

/** An empty reasoning part still records an upstream field; absence must stay absent. */
function assistantReasoning(message: PromptMessage, provider: AiProvider): string | undefined {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return undefined
  const parts = message.content.filter((part) => part.type === 'reasoning' && matchesSource(part, provider))
  return parts.length > 0 ? parts.map((part) => part.text ?? '').join('') : undefined
}

function toFallbackChatMessages(message: PromptMessage, provider: AiProvider): Record<string, unknown>[] {
  const content = message.content
  if (!Array.isArray(content)) return [{ role: fallbackChatRole(message.role), content: message.role === 'tool' ? `工具结果：${content}` : content }]
  if (message.role === 'tool') {
    const results = content.filter((part) => part.type === 'tool-result')
    return results.length > 0
      ? results.map((part) => ({ role: 'user', content: fallbackToolResultText(part) }))
      : [{ role: 'user', content: '工具结果：' }]
  }
  const text = content.filter((part) => part.type === 'text').map((part) => part.text ?? '').filter(Boolean)
  const reasoning = assistantReasoning(message, provider)
  const toolCalls = content.filter((part) => part.type === 'tool-call').map(fallbackToolCallText)
  return [{
    role: fallbackChatRole(message.role),
    content: [...text, ...toolCalls].join('\n\n'),
    ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
  }]
}

function toResponseInput(message: PromptMessage, fallback = false): Record<string, unknown>[] {
  if (fallback) return toFallbackResponseInput(message)
  if (!Array.isArray(message.content)) return [{ role: responseRole(message.role), content: [{ type: 'input_text', text: message.content }] }]
  const output: Record<string, unknown>[] = []
  for (const part of message.content) {
    // Chat reasoning lacks the native Responses item ids/encrypted payload;
    // omit it rather than exposing private reasoning as output_text.
    if (part.type === 'text') {
      output.push({ role: responseRole(message.role), content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text ?? '' }] })
    } else if (part.type === 'tool-call') {
      output.push({ type: 'function_call', call_id: part.toolCallId, name: part.toolName, arguments: JSON.stringify(part.input ?? {}) })
    } else if (part.type === 'tool-result') {
      output.push({ type: 'function_call_output', call_id: part.toolCallId, output: outputText(part.output ?? part.value ?? '') })
    }
  }
  return output
}

function toFallbackResponseInput(message: PromptMessage): Record<string, unknown>[] {
  const content = message.content
  const role = fallbackResponseRole(message.role)
  if (!Array.isArray(content)) return [{ role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: message.content }] }]
  const output: Record<string, unknown>[] = []
  for (const part of content) {
    // Chat reasoning lacks the native Responses item ids/encrypted payload;
    // omit it rather than exposing private reasoning as output_text.
    if (part.type === 'text') {
      output.push({ role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text ?? '' }] })
    } else if (part.type === 'tool-call') {
      output.push({ role: 'assistant', content: [{ type: 'output_text', text: fallbackToolCallText(part) }] })
    } else if (part.type === 'tool-result') {
      output.push({ role: 'user', content: [{ type: 'input_text', text: fallbackToolResultText(part) }] })
    }
  }
  return output
}

function fallbackToolCallText(part: PromptPart): string {
  return `工具调用「${part.toolName ?? ''}」：${JSON.stringify(part.input ?? {})}`
}

function fallbackToolResultText(part: PromptPart): string {
  return `工具结果「${part.toolName ?? ''}」：${outputText(part.output ?? part.value ?? '')}`
}

function fallbackChatRole(role: string): 'system' | 'user' | 'assistant' {
  return role === 'system' || role === 'assistant' || role === 'user' ? role : 'user'
}

function fallbackResponseRole(role: string): 'user' | 'assistant' | 'developer' {
  return role === 'assistant' ? 'assistant' : role === 'system' ? 'developer' : 'user'
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
  const instruction = fallbackInstruction(tools)
  const content = system ? system + '\n\n' + instruction : instruction
  messages.unshift({ role: 'system', content })
}

function fallbackInstruction(
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown; parameters?: unknown }>,
): string {
  const toolList = (tools ?? []).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined || tool.inputSchema !== undefined
      ? { parameters: tool.parameters ?? tool.inputSchema }
      : {}),
  }))
  return `当前模型不支持 function calling。需要调用工具时，只输出 JSON：{"tool":"工具名","arguments":{}}；不要输出 Markdown 代码围栏。可调用工具：${JSON.stringify(toolList)}。普通回答直接输出文本。`
}

function parseProviderStream(response: Response, provider: AiProvider, functionCalling: boolean): ReadableStream<StreamPart> {
  const protocol = provider.protocol
  const providerMetadata = sourceMetadata(provider)
  return new ReadableStream<StreamPart>({
    async start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      const textParts: string[] = []
      const toolCalls = new Map<string, ToolCall>()
      let finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' = 'stop'
      let textStarted = false
      let textEnded = false
      let reasoningStarted = false

      const emitReasoning = (text: string): void => {
        if (!reasoningStarted) {
          reasoningStarted = true
          controller.enqueue({ type: 'reasoning-start', id: 'reasoning-1', providerMetadata })
        }
        controller.enqueue({ type: 'reasoning-delta', id: 'reasoning-1', delta: text, providerMetadata })
      }

      const emitText = (text: string): void => {
        if (!text) return
        if (!textStarted) {
          textStarted = true
          controller.enqueue({ type: 'text-start', id: 'text-1' })
        }
        controller.enqueue({ type: 'text-delta', id: 'text-1', delta: text })
      }

      const handleEvent = (event: string, payload: Record<string, unknown>): void => {
        const result = parseEvent(event, payload, protocol, functionCalling, toolCalls)
        if (result.error) throw result.error
        if (result.reasoning !== undefined) emitReasoning(result.reasoning)
        if (result.text) {
          if (functionCalling) emitText(result.text)
          else textParts.push(result.text)
        }
        if (result.finishReason) finishReason = result.finishReason
      }

      try {
        const body = response.body
        if (!body) throw new Error('模型服务没有返回响应体')
        const reader = body.getReader()
        const decoder = new TextDecoder()
        const sseParser = new IncrementalSseParser(handleEvent)
        let sseMode = /text\/event-stream/i.test(response.headers.get('content-type') ?? '')
        let buffered = ''

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          if (sseMode) {
            sseParser.push(chunk)
            continue
          }
          buffered += chunk
          if (looksLikeSse(buffered)) {
            sseMode = true
            sseParser.push(buffered)
            buffered = ''
          }
        }

        const tail = decoder.decode()
        if (sseMode) {
          if (tail) sseParser.push(tail)
          sseParser.finish()
        } else {
          buffered += tail
          const parsed = JSON.parse(buffered) as unknown
          if (hasProviderError(parsed, protocol)) throw providerEventError(parsed)
          const result = parseJsonResponse(parsed, protocol, toolCalls)
          if (result.reasoning !== undefined) emitReasoning(result.reasoning)
          if (result.text) textParts.push(result.text)
          if (result.finishReason) finishReason = result.finishReason
        }

        const completeText = textParts.join('')
        if (!functionCalling) {
          const fallbackTool = parseFallbackTool(completeText)
          if (fallbackTool) toolCalls.set(fallbackTool.id, fallbackTool)
          else emitText(completeText)
        } else {
          // A provider may return a regular JSON response even when tools are
          // enabled. Preserve its text just like streamed text deltas.
          emitText(completeText)
        }
        if (reasoningStarted) controller.enqueue({ type: 'reasoning-end', id: 'reasoning-1', providerMetadata })
        if (textStarted && !textEnded) {
          controller.enqueue({ type: 'text-end', id: 'text-1' })
          textEnded = true
        }
        for (const call of toolCalls.values()) {
          controller.enqueue({
            type: 'tool-call', toolCallId: call.id, toolName: call.name, input: call.args,
            ...(call.thoughtSignature !== undefined
              ? { providerMetadata: { ...providerMetadata, google: { thoughtSignature: call.thoughtSignature } } }
              : {}),
          })
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

function looksLikeSse(value: string): boolean {
  return /(?:^|\n)\s*(?:event:|data:)/.test(value)
}

class IncrementalSseParser {
  private buffer = ''
  private event = ''
  private dataLines: string[] = []

  constructor(private readonly emit: (event: string, payload: Record<string, unknown>) => void) {}

  push(value: string): void {
    this.buffer += value
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newline + 1)
      this.processLine(line)
    }
  }

  finish(): void {
    if (this.buffer) {
      this.processLine(this.buffer.replace(/\r$/, ''))
      this.buffer = ''
    }
    this.flushEvent()
  }

  private processLine(line: string): void {
    if (line === '') {
      this.flushEvent()
    } else if (line.startsWith(':')) {
      // SSE comments are keepalive frames.
    } else if (line.startsWith('event:')) {
      this.event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      const data = line.slice(5)
      this.dataLines.push(data.startsWith(' ') ? data.slice(1) : data)
    }
  }

  private flushEvent(): void {
    if (this.dataLines.length === 0) return
    const data = this.dataLines.join('\n')
    const event = this.event
    this.dataLines = []
    this.event = ''
    if (data === '[DONE]') return
    let payload: unknown
    try {
      payload = JSON.parse(data) as unknown
    } catch {
      // Ignore provider keepalive/malformed chunks; the stream may continue.
      return
    }
    if (payload && typeof payload === 'object') this.emit(event, payload as Record<string, unknown>)
  }
}

function parseEvent(event: string, payload: Record<string, unknown>, protocol: AiProvider['protocol'], functionCalling: boolean, toolCalls: Map<string, ToolCall>): { text?: string; reasoning?: string; error?: Error; finishReason?: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' } {
  if (event === 'error' || payload.type === 'error' || hasProviderError(payload, protocol)) return { error: providerEventError(payload) }
  if (protocol === 'responses') {
    const type = event || stringValue(payload.type)
    if (type === 'response.output_text.delta' || type === 'response.text.delta') return { text: stringValue(payload.delta) }
    if (type === 'response.function_call_arguments.delta') {
      const itemId = stringValue(payload.item_id)
      const callId = stringValue(payload.call_id)
      const id = callId || itemId || 'tool-call'
      const call = findToolCall(toolCalls, [callId, itemId]) ?? createToolCall(toolCalls, [id, itemId], stringValue(payload.name))
      if (callId) preferToolCallId(toolCalls, call, callId)
      addToolCallAliases(call, [itemId, callId])
      call.name ||= stringValue(payload.name)
      call.args += stringValue(payload.delta)
      return {}
    }
    if (type === 'response.output_item.added') {
      const item = objectValue(payload.item)
      if (item && item.type === 'function_call') {
        const callId = stringValue(item.call_id)
        const itemId = stringValue(item.id)
        const call = findToolCall(toolCalls, [callId, itemId]) ?? createToolCall(toolCalls, [callId, itemId], stringValue(item.name))
        if (callId) preferToolCallId(toolCalls, call, callId)
        addToolCallAliases(call, [itemId, callId])
        call.name ||= stringValue(item.name)
        if (stringValue(item.arguments)) call.args = stringValue(item.arguments)
      }
      return {}
    }
    if (type === 'response.function_call_arguments.done' || type === 'response.output_item.done') {
      const item = objectValue(payload.item)
      const itemId = stringValue(payload.item_id) || stringValue(item?.id)
      const callId = stringValue(payload.call_id) || stringValue(item?.call_id)
      const name = stringValue(payload.name) || stringValue(item?.name)
      const completeArguments = stringValue(payload.arguments) || stringValue(item?.arguments)
      const id = callId || itemId || 'tool-call'
      const call = findToolCall(toolCalls, [callId, itemId]) ?? createToolCall(toolCalls, [id, itemId], name)
      if (callId) preferToolCallId(toolCalls, call, callId)
      addToolCallAliases(call, [itemId, callId])
      call.name ||= name
      if (completeArguments) call.args = completeArguments
      return {}
    }
    if (type === 'response.failed') return { error: providerEventError(payload) }
    if (type === 'response.completed' || type === 'response.done') {
      const response = objectValue(payload.response) ?? payload
      if (hasProviderError(response, protocol) || stringValue(response.status) === 'failed') return { error: providerEventError(response) }
      addResponseToolCalls(response, toolCalls)
      return { finishReason: 'stop' }
    }
    return {}
  }
  const choice = objectValue((Array.isArray(payload.choices) ? payload.choices[0] : undefined))
  const delta = objectValue(choice?.delta)
  if (delta && functionCalling) addChatToolCalls(delta, toolCalls)
  const reason = stringValue(choice?.finish_reason)
  return {
    text: typeof delta?.content === 'string' ? delta.content : undefined,
    reasoning: typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : undefined,
    finishReason: reason === 'tool_calls' ? 'tool-calls' : reason === 'length' ? 'length' : reason ? 'stop' : undefined,
  }
}

function parseJsonResponse(payload: unknown, protocol: AiProvider['protocol'], toolCalls: Map<string, ToolCall>): { text: string; reasoning?: string; finishReason?: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' } {
  const response = objectValue(payload)
  if (!response) return { text: '' }
  if (protocol === 'responses') {
    addResponseToolCalls(response, toolCalls)
    return { text: stringValue(response.output_text) || collectResponseText(response), finishReason: 'stop' }
  }
  const choice = objectValue(Array.isArray(response.choices) ? response.choices[0] : undefined)
  const message = objectValue(choice?.message)
  if (message) addChatToolCalls(message, toolCalls)
  return {
    text: contentText(message?.content),
    reasoning: typeof message?.reasoning_content === 'string' ? message.reasoning_content : undefined,
    finishReason: stringValue(choice?.finish_reason) === 'tool_calls' ? 'tool-calls' : 'stop',
  }
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
    const signature = objectValue(objectValue(call.extra_content)?.google)?.thought_signature
    if (typeof signature === 'string') existing.thoughtSignature = signature
    calls.set(id, existing)
  }
}

function addResponseToolCalls(value: Record<string, unknown>, calls: Map<string, ToolCall>): void {
  const output = Array.isArray(value.output) ? value.output : []
  for (const entry of output) {
    const item = objectValue(entry)
    if (!item || item.type !== 'function_call') continue
    const callId = stringValue(item.call_id)
    const itemId = stringValue(item.id)
    const call = findToolCall(calls, [callId, itemId]) ?? createToolCall(calls, [callId, itemId], stringValue(item.name))
    if (callId) preferToolCallId(calls, call, callId)
    addToolCallAliases(call, [itemId, callId])
    call.name ||= stringValue(item.name)
    if (stringValue(item.arguments)) call.args = stringValue(item.arguments)
  }
}

function findToolCall(calls: Map<string, ToolCall>, ids: string[]): ToolCall | undefined {
  return [...calls.values()].find((call) => ids.some((id) => id !== '' && (call.id === id || call.aliases?.includes(id))))
}

function createToolCall(calls: Map<string, ToolCall>, ids: string[], name: string): ToolCall {
  const id = ids.find((value) => value !== '') || `tool-${calls.size + 1}`
  const call: ToolCall = { id, name, args: '' }
  addToolCallAliases(call, ids)
  calls.set(id, call)
  return call
}

function addToolCallAliases(call: ToolCall, ids: string[]): void {
  const aliases = ids.filter((value) => value !== '' && value !== call.id && !call.aliases?.includes(value))
  if (aliases.length > 0) call.aliases = [...(call.aliases ?? []), ...aliases]
}

function preferToolCallId(calls: Map<string, ToolCall>, call: ToolCall, id: string): void {
  if (!id || call.id === id) return
  const previousId = call.id
  addToolCallAliases(call, [previousId, id])
  for (const [key, value] of calls) {
    if (value === call) {
      calls.delete(key)
      break
    }
  }
  call.id = id
  calls.set(id, call)
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

function hasProviderError(value: unknown, protocol: AiProvider['protocol']): boolean {
  const root = objectValue(value)
  if (!root) return false
  if (root.error !== undefined && root.error !== null) return true
  if (protocol !== 'responses') return false
  const response = objectValue(root.response)
  return response?.error !== undefined && response.error !== null
}

function providerEventError(value: unknown): Error & { statusCode?: number } {
  const root = objectValue(value)
  const response = objectValue(root?.response)
  const rootError = objectValue(root?.error)
  const responseError = objectValue(response?.error)
  const code = stringValue(rootError?.code) || stringValue(responseError?.code) || stringValue(root?.code)
  const status = numberValue(rootError?.status) ?? numberValue(responseError?.status) ?? numberValue(root?.status) ?? numberValue(response?.status)
  const isAuth = status === 401 || status === 403 || /auth|api[_ -]?key|unauthor|forbidden/i.test(code)
  const message = isAuth
    ? '模型服务鉴权失败，请检查 API Key。'
    : status !== undefined && status >= 500
      ? `模型服务暂时不可用（HTTP ${status}）。`
      : '模型服务返回失败。'
  const error = new Error(message) as Error & { statusCode?: number }
  if (status !== undefined) error.statusCode = status
  return error
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
