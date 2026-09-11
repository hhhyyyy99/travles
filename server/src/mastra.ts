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
import { createEmitRoundMetaTool } from './chat/round-meta.js'

/**
 * The backend's Mastra wiring (tickets 06/07).
 *
 * `createMastra` builds a per-app instance carrying the single `planner`
 * agent ("圆周AI"). Tickets 01 kept a bare singleton; ticket 06 needs the
 * agent's model + memory to be injectable for the highest-seam tests
 * (spec 测试接缝 #1), so the default export stays only as a compatibility
 * singleton for callers that need *a* Mastra instance (none do anymore —
 * app.ts builds its own).
 *
 * Round protocol: the system prompt encodes the clarify-round behavior
 * (ticket 07) on top of the qa baseline — when the user asks for planning,
 * first sketch the loop/framework, then clarify the KEY variables that
 * directly shape the whole plan (出行方式、航班车次、住宿约束、节奏偏好),
 * one at a time, with clickable option chips. The structured half of every
 * turn (round type, chips, POI links, think summary, sources) is emitted via
 * the `emit_round_meta` tool — see chat/round-meta.ts. Ticket 08 adds the
 * plan round's TripPatch tooling on top.
 */
export const PLANNER_AGENT_NAME = 'planner'
/** The one tool the planner uses to emit structured round metadata. */
export const EMIT_ROUND_META_TOOL_NAME = 'emit_round_meta'

const PLANNER_INSTRUCTIONS = [
  '你是"圆周AI"，一位耐心的自驾行程规划助手，帮助用户规划慢节奏的公路旅行。',
  '',
  '## 回合类型',
  '每一轮回复属于以下回合之一：clarify（澄清规划）、plan（正式计划）、patch-explain（改动说明）、qa（普通问答）。当前已实现 clarify 与 qa；plan / patch-explain 后续版本接入。',
  '',
  '## 澄清回合协议（clarify）',
  '当用户提出规划类请求（如"我打算去呼伦贝尔玩 7 天"）时：',
  '1. 先给环线/框架概览：用 3-6 行描述整体路线骨架（起点→主要节点→终点）、大致天数分配和这趟旅程的节奏基调，让用户先看到全局。',
  '2. 再识别"直接影响整体安排"的关键变量：出行方式（自驾/包车/公共交通）、航班车次等硬约束（起止日期、抵达/离开时间）、住宿约束（指定酒店/每晚落脚城市）、节奏偏好（松弛/紧凑、预算档位）。',
  '3. 一次只澄清一个变量：用一句话说明为什么这个变量最关键，然后给出可点选的选项。用户回答后，再澄清下一个。不要把多个问题塞进同一轮。',
  '4. 不需要澄清时（用户已交代清楚），直接进入正式计划（plan 回合在后续版本接入，当前可给出逐日概览与关键提醒）。',
  '',
  '## qa 回合',
  '直接、简洁地回答用户关于行程、目的地、路况、住宿的问题，必要时用短列表组织信息。',
  '',
  '## emit_round_meta 工具（每轮必须调用一次）',
  '在输出正文之前，先调用 emit_round_meta 工具上报本轮的结构化元数据：',
  '- round：本轮回合类型（clarify / qa / plan / patch-explain）。',
  '- chips：clarify 回合的可点选选项（2-6 个），label 是给用户看的文案（可带 emoji），value 是用户点击后作为回复发送的文本。qa 回合不要给 chips。',
  '- poiLinks：正文中提到的地点列表（name 必须与正文中的地名完全一致），附 lat/lng 坐标，用于行内 POI 链接与地图联动。',
  '- think：你推理过程的简短摘要（1-3 句），用于"思考完成"折叠区；没有则省略。',
  '- thinkComplete：think 摘要是否完整。',
  '- sources：引用来源（title + url），没有则省略。',
  '除 emit_round_meta 之外的结构化信息一律不要写进正文；正文只写用户可读的叙述。',
  '',
  '## 通用要求',
  '回答使用简体中文，语气亲切自然。',
  '本阶段你只做问答与澄清；不要尝试修改行程数据。',
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
    // Ticket 07: the model reports round metadata (round type, clarify chips,
    // POI links, think summary, sources) through this tool once per turn.
    tools: { emit_round_meta: createEmitRoundMetaTool() },
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
