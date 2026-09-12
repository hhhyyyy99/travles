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
import { APPLY_TRIP_PATCH_TOOL_NAME, createApplyTripPatchTool } from './trip-patch/tool.js'
import {
  CREATE_TRIP_PROPOSAL_TOOL_NAME,
  READ_TRIP_SNAPSHOT_TOOL_NAME,
  createTripProposalTool,
  createTripSnapshotTool,
} from './ai-proposals/tool.js'
import type { TripPatchStoreDriver } from './trip-patch/types.js'
import { createSearchPoiTool } from './recommendations/tool.js'
import type { PoiSearch } from './recommendations/types.js'

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
 * (ticket 07) and the plan round (ticket 08) on top of the qa baseline —
 * when the user asks for planning, first sketch the loop/framework, then
 * clarify the KEY variables that directly shape the whole plan (出行方式、
 * 航班车次、住宿约束、节奏偏好), one at a time, with clickable option chips.
 * Once clarified, the plan round streams 逐日概览 + 关键提醒 and writes the
 * full trip through `apply_trip_patch` — the ONLY channel the model has to
 * trip data (server-validated; see chat/round-meta.ts for the structured
 * metadata tool and src/trip-patch/ for the patch pipeline).
 */
export const PLANNER_AGENT_NAME = 'planner'
/** The one tool the planner uses to emit structured round metadata. */
export const EMIT_ROUND_META_TOOL_NAME = 'emit_round_meta'
// APPLY_TRIP_PATCH_TOOL_NAME is imported from ./trip-patch/tool.js below.

const PLANNER_INSTRUCTIONS = [
  '你是"圆周AI"，一位耐心的自驾行程规划助手，帮助用户规划慢节奏的公路旅行。',
  '',
  '## 回合类型',
  '每一轮回复属于以下回合之一：clarify（澄清规划）、plan（正式计划）、patch-explain（改动说明）、qa（普通问答）。当前已实现 clarify、qa 与 plan；patch-explain 后续版本接入。',
  '',
  '## 澄清回合协议（clarify）',
  '当用户提出规划类请求（如"我打算去呼伦贝尔玩 7 天"）时：',
  '1. 先给环线/框架概览：用 3-6 行描述整体路线骨架（起点→主要节点→终点）、大致天数分配和这趟旅程的节奏基调，让用户先看到全局。',
  '2. 再识别"直接影响整体安排"的关键变量：出行方式（自驾/包车/公共交通）、航班车次等硬约束（起止日期、抵达/离开时间）、住宿约束（指定酒店/每晚落脚城市）、节奏偏好（松弛/紧凑、预算档位）。',
  '3. 一次只澄清一个变量：用一句话说明为什么这个变量最关键，然后给出可点选的选项。用户回答后，再澄清下一个。不要把多个问题塞进同一轮。',
  '4. 关键变量都已明确（或用户交代得很清楚）时，直接进入正式计划（plan 回合）。',
  '',
  '## 计划回合协议（plan）',
  '澄清完成后输出正式计划并写入行程：',
  '1. 先调用 emit_round_meta（round 填 plan；plan 回合不需要 chips）。',
  '2. 输出正式计划正文：先逐日概览（每天一小段：日期 + 主题 + 当日亮点与路线走向），再给"关键提醒"3-6 条（预约限制、证件要求、天气穿衣、返程缓冲等）。',
  '3. 调用 apply_trip_patch 工具，把完整计划作为结构化 diff 一次写入行程（新建所有天与卡片）。',
  '4. 未确认的槽位（如还没定下来的酒店）：卡片 pending 设为 true，并在正文中显式标注"待定"。正文里的"待定"必须与 patch 中的 pending 卡片一致，不要编造未确认的细节。',
  '',
  '## qa 回合',
  '直接、简洁地回答用户关于行程、目的地、路况、住宿的问题，必要时用短列表组织信息。',
  '',
  '## emit_round_meta 工具（每轮必须调用一次）',
  '在输出正文之前，先调用 emit_round_meta 工具上报本轮的结构化元数据：',
  '- round：本轮回合类型（clarify / qa / plan / patch-explain）。',
  '- chips：clarify 回合的可点选选项（2-6 个），label 是给用户看的文案（可带 emoji），value 是用户点击后作为回复发送的文本。qa / plan 回合不要给 chips。',
  '- poiLinks：正文中提到的地点列表（name 必须与正文中的地名完全一致），附 lat/lng 坐标，用于行内 POI 链接与地图联动。',
  '- think：你推理过程的简短摘要（1-3 句），用于"思考完成"折叠区；没有则省略。',
  '- thinkComplete：think 摘要是否完整。',
  '- sources：引用来源（title + url），没有则省略。',
  '除 emit_round_meta 之外的结构化信息一律不要写进正文；正文只写用户可读的叙述。',
  '',
  '## 智能解析与路线优化建议（ticket 13）',
  '智能解析、全局路线优化、天级魔法棒都必须先调用 create_trip_proposal 生成待确认建议。该工具只返回结构化建议，不会写行程；用户确认后服务端才会调用 apply_trip_patch。',
  '全局路线优化和天级魔法棒在 create_trip_proposal 前必须先调用 read_trip_snapshot 获取当前行程；该工具只读天、卡片和交通段。',
  'parse：把用户提供的攻略长文本拆成 items，并用 patch 的 add_day/add_item 表达可写入的结构。',
  'optimize：读取现有行程，提出走法、顺序、节奏的 diff；只改必要的卡片，保留用户未涉及的内容。',
  'day-optimize：只重排指定 targetDayId 的当天卡片；不要修改其它日期，也不要静默新增或删除天。',
  '建议的 diff 用 add/update/move/remove 描述每个变更，summary 要说明取舍。不要把建议直接写入行程。',
  '',
  '## apply_trip_patch 工具（写行程的唯一通道）',
  '需要修改行程时（plan 回合整体规划、后续调整）通过该工具写入，ops 是按顺序执行的操作列表：',
  '- add_day {dayId, date?, theme?} / update_day {dayId, date?, theme?} / remove_day {dayId}',
  '- add_item {itemId, dayId, order?, type, title, note?, pending?, poi?, legPending?}：type ∈ traffic|stay|attraction|food|other',
  '- update_item {itemId, title?, note?, type?, pending?, poi?} / move_item {itemId, dayId, order?} / remove_item {itemId}',
  '硬规则：日期必须逐日连续不重叠；每天最多一个过夜住宿（stay）卡；相邻卡片尽量带 poi 坐标（name/lat/lng），没有坐标的卡片要么 pending: true（待确认），要么 legPending: true（纯文本赶路卡）。',
  'id 由你生成并保持稳定（同一对象在后续操作中复用同一个 id）。校验失败时工具会把错误原因返回给你：按错误修正后重新调用，最多重试 2 次。',
  '',
  '## 通用要求',
  '回答使用简体中文，语气亲切自然。',
  '除 apply_trip_patch 外不要尝试用其他方式修改行程数据；写入被拒绝时如实告知用户，不要假装已写入。',
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
  /**
   * Ticket 08: lazily resolve the store the `apply_trip_patch` tool writes
   * through. Defaults to undefined (tool reports "storage unavailable") —
   * app.ts wires the shared SQLite database; tests inject in-memory stores.
   */
  resolveTripPatchStore?: () => Promise<TripPatchStoreDriver>
  /** Shared `search_poi` provider used by both HTTP and Mastra tool paths. */
  searchPoi?: PoiSearch
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
    // Ticket 08: apply_trip_patch is the model's only write channel to the
    // trip; the server validates every patch before it reaches the database.
    tools: {
      emit_round_meta: createEmitRoundMetaTool(),
      [CREATE_TRIP_PROPOSAL_TOOL_NAME]: createTripProposalTool(),
      [READ_TRIP_SNAPSHOT_TOOL_NAME]: createTripSnapshotTool({ resolveStore: options.resolveTripPatchStore }),
      [APPLY_TRIP_PATCH_TOOL_NAME]: createApplyTripPatchTool({
        resolveStore: options.resolveTripPatchStore,
      }),
      search_poi: createSearchPoiTool(options.searchPoi),
    },
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
