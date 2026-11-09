# 02: Mastra Agent 工具链升级与 Mastra Workflow 攻略解析管道

来源：Epic #3 → GitHub Issue #5。
Part of #3

**What to build:** 在后端深度接入 Mastra AI 框架能力：升级 Mastra Agent 规划助手及其配套 Zod 工具链；构建基于 Mastra Workflow 的攻略链接与长文本解析管道；扩充主流大模型预设服务商配置。

**Blocked by:** 01（领域 Zod 契约）。

**Status:** ready-for-agent

## 详细要求

1. **Mastra Agent 工具链**：
   - `emit_round_meta`: 通过 Zod Schema 上报回合类型（clarify/plan/patch-explain/qa）、思考摘要、地理现实校验事实（`geographicFactCheck`）、可点击 Chips 与 POI 链接。
   - `apply_trip_patch`: 执行通过 Zod 校验的原子操作序列，写入 SQLite。
   - `create_trip_proposal` / `read_trip_snapshot`: 生成改动建议与 diff，供前端确认。
   - `search_poi` 与 `calculate_legs`: 高德 Web API 代理与路线服务，支持优雅降级。
2. **Mastra Workflow 攻略解析管道（`parse_link_workflow`）**：
   - URL 抓取与清洗（防爬拦截时友好提示降级粘贴）。
   - LLM 结构化抽取为 Zod Schema。
   - 地理 POI 匹配。
   - 输出标准行程草稿。
3. **AI 模型配置扩展**：支持 DeepSeek、Qwen（通义千问）、Kimi、SiliconFlow、OpenAI、Claude、Gemini 等主流预设。

## 验收标准

- [ ] `planner` Agent 的全部工具以 Zod schema 约束输入/输出，并可由 mock 模型在 HTTP/SSE 层驱动验证。
- [ ] `parse_link_workflow` 把攻略 URL/文本解析为结构化行程草稿；防爬拦截时引导用户粘贴文本，流程不中断。
- [ ] 无 `AMAP_WEB_KEY` 时 `search_poi`/`calculate_legs` 优雅降级（直线估算/待查询）。
- [ ] 设置页提供上述主流服务商预设模板。
- [ ] `pnpm typecheck` 与 `pnpm test` 全绿。
