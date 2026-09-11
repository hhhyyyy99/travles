import { Mastra } from '@mastra/core'
import { Agent } from '@mastra/core/agent'
import type { MastraModelConfig } from '@mastra/core/llm'
import type { MastraLanguageModel } from '@mastra/core/agent'
import type { MastraMemory } from '@mastra/core/memory'
import { Memory } from '@mastra/memory'
import { LibSQLStore } from '@mastra/libsql'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { toLibsqlUrl } from './db/driver.js'

/**
 * The backend's Mastra wiring (ticket 06).
 *
 * `createMastra` builds a per-app instance carrying the single `planner`
 * agent ("圆周AI"). Tickets 01 kept a bare singleton; ticket 06 needs the
 * agent's model + memory to be injectable for the highest-seam tests
 * (spec 测试接缝 #1), so the default export stays only as a compatibility
 * singleton for callers that need *a* Mastra instance (none do anymore —
 * app.ts builds its own).
 *
 * Round protocol: this ticket implements the `qa` round (plain Q&A). The
 * system prompt encodes the minimal persona and pins the round type; the
 * full four-round protocol (clarify / plan / patch-explain / qa, PRD
 * 附录 B) lands with tickets 07/08/11 and extends this prompt.
 */
export const PLANNER_AGENT_NAME = 'planner'

const PLANNER_INSTRUCTIONS = [
  '你是"圆周AI"，一位耐心的自驾行程规划助手，帮助用户规划慢节奏的公路旅行。',
  '当前回合类型：qa（普通问答）。直接、简洁地回答用户关于行程、目的地、路况、住宿的问题。',
  '回答使用简体中文，语气亲切自然，必要时用短列表组织信息。',
  '本阶段你只做问答；不要尝试修改行程数据。',
].join('\n')

export type CreateMastraOptions = {
  /**
   * Injected language model (tests pass a mock model here; spec 测试接缝 #1).
   * Defaults to the env-configured OpenAI-compatible endpoint.
   */
  model?: MastraModelConfig
  /**
   * Injected agent memory (tests pass a core-memory-backed MastraMemory).
   * Defaults to Mastra Memory over the same SQLite/libSQL database the app
   * uses (`databaseUrl`), one thread per trip.
   */
  memory?: MastraMemory
  /** SQLite file URL (env: TRIPS_DB_PATH) for the default memory store. */
  databaseUrl?: string
}

/**
 * Default model routing config: any OpenAI-compatible Chat Completions
 * endpoint, configured purely by environment variables (the settings UI is
 * ticket 12, the ai_providers table is reserved in the schema).
 *
 * Env vars (documented in server/README.md + ticket 06):
 * - AI_BASE_URL  e.g. https://api.example.com/v1 (Mastra appends /chat/completions)
 * - AI_API_KEY   bearer token for that endpoint
 * - AI_MODEL     model id, e.g. gpt-4o-mini (default)
 * - AI_PROTOCOL  'chat-completions' | 'responses' — only 'chat-completions'
 *                is wired in this ticket; 'responses' is reserved.
 */
export function modelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MastraModelConfig | null {
  const baseUrl = env.AI_BASE_URL
  const apiKey = env.AI_API_KEY
  if (!baseUrl || !apiKey) return null
  const model = env.AI_MODEL ?? 'gpt-4o-mini'
  return { id: `openai-compatible/${model}`, url: baseUrl, apiKey }
}

export function createMastra(options: CreateMastraOptions = {}): Mastra {
  const model = options.model ?? modelConfigFromEnv() ?? unconfiguredModel()
  const memory = options.memory ?? defaultMemory(options.databaseUrl)

  const planner = new Agent({
    id: PLANNER_AGENT_NAME,
    name: PLANNER_AGENT_NAME,
    instructions: PLANNER_INSTRUCTIONS,
    model,
    memory,
  })

  return new Mastra({
    agents: { planner },
    logger: false,
  })
}

/**
 * Default agent memory: Mastra Memory over the same SQLite (libSQL) database
 * the app persists trips/messages in — one memory thread per trip
 * (`threadId = trip-<tripId>`), satisfying ticket 06's "agent memory 使用与
 * 服务端同一 SQLite 库".
 */
function defaultMemory(databaseUrl?: string): Memory | undefined {
  if (!databaseUrl) return undefined
  const url = toLibsqlUrl(databaseUrl)
  // LibSQLStore does not create the parent directory; a fresh checkout would
  // otherwise fail to open its database on first chat.
  if (url.startsWith('file:') && url !== 'file::memory:') {
    const filePath = url.slice('file:'.length)
    if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })
  }
  const storage = new LibSQLStore({ id: 'hailar-memory', url })
  return new Memory({ storage, options: { lastMessages: 20 } })
}

/**
 * Compatibility singleton (ticket 01): a bare Mastra instance with no agent
 * and no model. app.ts no longer uses it — chat needs per-app model/memory
 * injection — but it stays exported so external imports keep working.
 */
export const mastra = new Mastra({
  logger: false,
})

/**
 * Placeholder model used when nothing is configured. The chat route refuses
 * to start a stream (HTTP 503) whenever no real model is wired, so this is
 * never called in normal operation — but if it ever is, it fails loudly with
 * a clear message instead of surfacing as a confusing routing error.
 */
function unconfiguredModel(): MastraLanguageModel {
  const fail = (): never => {
    throw new Error('模型服务未配置：请设置 AI_BASE_URL / AI_API_KEY / AI_MODEL')
  }
  return {
    specificationVersion: 'v2',
    provider: 'hailar.unconfigured',
    modelId: 'not-configured',
    supportedUrls: Promise.resolve({}),
    doGenerate: async () => fail(),
    doStream: async () => fail(),
  }
}
