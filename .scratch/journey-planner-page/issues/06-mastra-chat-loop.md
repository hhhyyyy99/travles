# 06: Mastra 对话最小回路（SSE + qa 回合）

**What to build:** 左栏对话可用：用户发消息，后端 Mastra `planner` agent 流式回复（SSE），消息随行程持久化、刷新可回看。本工单先实现 qa 回合（普通问答），模型经服务端配置接入（本工单先用环境变量配置的 OpenAI 兼容端点，设置页留给 12）。后端测试在最高接缝：注入 mock 模型，经 HTTP/SSE 断言流式事件与消息落库，不 mock 内部实现。

**Blocked by:** 01, 04。

**Status:** resolved

- [x] 用户发消息 → 流式看到 AI 回复逐字出现，完成后消息入库
- [x] 会话线程与行程一一对应，重新进入行程可回看历史
- [x] 模型服务不可用/鉴权失败时，对话流内给出明确错误（spec 用户故事 25）
- [x] mock 模型经 SSE 驱动 agent 端点的后端测试：断言回合事件序列与持久化
- [x] agent memory 使用与服务端同一 SQLite 库

---

## 实现纪要（ticket 06 落地记录）

### HTTP 接口

- `GET /api/trips/:id/messages` → `{ messages: ChatMessage[] }`（按时间升序；ChatMessage = `{id, tripId, role: 'user'|'assistant', content, createdAt}`）。
- `POST /api/trips/:id/messages`，body `{ content: string }` → `text/event-stream`。
- 流未开始前的错误为普通 JSON：400 非法 body、404 行程不存在、503 模型未配置（`{error, guidance}`）、502 无法启动对话流。

### SSE 事件 schema（07/08 在此基础上扩展）

每个事件为 `event: <name>\ndata: <JSON>\n\n`。成功 qa 回合的事件序列：

1. `start` → `{"round":"qa"}` — 流已建立，`round` 为回合类型（本工单只有 `qa`）。
2. `delta` → `{"text":"<chunk>"}` — agent token，0..n 个，前端增量渲染。
3. `done` → `{"userMessage":ChatMessage,"assistantMessage":ChatMessage}` — 终止事件；两条消息已落库（messages 表，按 trip 键），并回带服务端 id/createdAt 供前端替换乐观气泡。

流内错误（模型不可用/鉴权失败/存储失败）：

- `error` → `{"code":string,"message":string,"guidance":string}`；`code ∈ model_auth | model_unavailable | storage | stream`（HTTP 层预检失败为 `http`）；`guidance` 是给用户的排查指引（spec 用户故事 25）。
- `close` → `{}` — 错误终止后的收尾事件；错误回合不落库。

### Mastra 接线（server/src/mastra.ts）

- `createMastra({model?, memory?, databaseUrl?})` 按应用构建 Mastra 实例，内含唯一 `planner` agent（圆周AI persona + qa 回合指令；四类回合协议由 07/08/11 扩展此 prompt）。
- 模型路由：默认走 Mastra 的 OpenAI 兼容配置 `OpenAICompatibleConfig`（`{id: "openai-compatible/<model>", url, apiKey}`，Mastra 在 url 后追加 `/chat/completions`）。
- Memory：`@mastra/memory` 的 `Memory` + `@mastra/libsql` 的 `LibSQLStore`，指向与服务端相同的 SQLite 文件（`toLibsqlUrl` 归一化）；每条行程一个 thread：`memory: {thread: "trip-<tripId>", resource: <tripId>}`，`lastMessages: 20`。

### 环境变量（server 侧；设置页 UI 为 ticket 12）

| 变量 | 含义 |
| --- | --- |
| `AI_BASE_URL` | OpenAI 兼容端点 Base URL（如 `https://api.example.com/v1`），必填 |
| `AI_API_KEY` | 该端点的 Bearer API Key，必填 |
| `AI_MODEL` | 模型 ID（默认 `gpt-4o-mini`） |
| `AI_PROTOCOL` | `chat-completions`（默认，本工单唯一实现）\| `responses`（保留，暂未接线） |

`AI_BASE_URL`/`AI_API_KEY` 缺任一 → 应用可启动，但聊天端点返回 503 并给出配置指引。

### 测试接缝 #1（最高接缝）的实际做法

- `createApp({plannerModel?, plannerMemory?, messageStore?})`：在 Mastra 模型边界注入 fake `LanguageModelV2`（`doStream` 直接产出 v2 stream parts），agent、路由、SSE、持久化全部走真实实现，`app.request()` 驱动，不开端口、不 mock 内部 handler。
- Mastra 自带的 `@mastra/core/test-utils/llm-mock`（MockProvider/MastraLanguageModelV2Mock）依赖 `vitest` 才能加载，与 node:test 不兼容，故在本仓库按同一模型接口自造 fake（与官方 mock 同形）。
- 另有两条"真实模型路由"测试：本地起一个 OpenAI 兼容 HTTP 服务（流式 chunk / 401 两种），通过 `AI_*` 环境变量走完整默认接线，验证 env 路由、记忆（第二轮请求重放第一轮上下文）与 401 → `model_auth` 事件。

### 给后续工单的提示

- **07/08**：回合类型只改两处 —— `chat/routes.ts` 的 SSE `start.round` 与事件扩展（chips / TripPatch / 思考 / 来源均可作为新事件名追加，schema 向后兼容）；`messages` 表的 `think/sources/applied_patch` JSON 列已预留未写。消息渲染侧 `ChatPanel.tsx` 的 `ChatBubble` 是扩展点。
- **12**：`ai_providers` 表已在 schema 预留；`modelConfigFromEnv()`（mastra.ts）是 env-only 模型解析点，接入设置页后替换为按 provider 行构建 `OpenAICompatibleConfig` 即可；`AI_PROTOCOL=responses` 未接线。
- 前端 `src/domain/chat.ts` 的 `sendChatMessage` 对未知事件名宽容忽略，新增事件不会破坏现有解析。
