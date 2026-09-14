# 01: AI 思考档位（thinking）：off / low / medium / high 全链路

**What to build:** AI 接入配置新增「思考档位」`thinking: off | low | medium | high`（默认 `off`），贯穿数据层、仓库层、环境变量兜底、出站请求体映射、前端设置页与归一化。出站请求体在 `off` 时不含任何思考字段；`low/medium/high` 时 Chat Completions 发 `reasoning_effort`、Responses 发 `reasoning: { effort }`，不发送任何厂商私有字段（如 `enable_thinking`）。非法档位被服务端拒绝并返回可读错误；服务端未返回/旧行默认归一到 `off`。

**Blocked by:** 12（AI 设置双格式 provider 接入）。

**Status:** done

- [x] 数据层 ai_providers 加列（CREATE TABLE + ensureSchema ALTER），driver-sqlite 读写与 updateRow 支持 thinking
- [x] 类型与仓库层：AiProviderRow/AiProvider/PublicAiProvider/AiProviderInput 含 thinking；validateProviderInput 严格枚举校验；mapRow 容错归一到 off；toPublicAiProvider 透出且不泄漏敏感字段
- [x] providerFromEnv 固定 thinking='off'；routes parseProviderInput 接受可选 thinking
- [x] 请求体映射单点集中在 buildRequest：off 无思考字段，low/medium/high 按协议发 reasoning_effort / reasoning.effort；probe 不改动
- [x] 前端 normalizeAiProvider 归一到 off；AiSettingsPage 新增「思考档位」控件（关闭/低/中/高），表单/空表单/保存载荷带上，编辑回显，切协议保留
- [x] 测试：server 出站 body 映射与非法拒绝/存取回读/公开 payload/默认 off；前端归一化单测；浏览器套件设置→保存→重新编辑回显

## Answer

Implemented the thinking budget end-to-end. The column lands in `ai_providers`
(`thinking TEXT NOT NULL DEFAULT 'off'`) with a tolerant `ALTER` so pre-existing
rows normalize to `off`. `validateProviderInput` rejects any value outside the
`off|low|medium|high` enum with a Chinese-readable error; `mapRow`/front-end
`normalizeAiProvider` both default missing or invalid values to `off`.
`buildRequest` is the single mapping point: `off` emits nothing, while
`low/medium/high` send `reasoning_effort` (Chat Completions) or
`reasoning: { effort }` (Responses) — no vendor-private flags. The settings page
exposes a four-way segmented control that is carried in the create/update
payload and echoed when re-editing; switching protocol leaves it untouched.

Verification: `pnpm typecheck`, `pnpm build:server`, `pnpm test` (152 frontend +
186 server) and `pnpm test:app` (117 browser, # fail 0) all green.
