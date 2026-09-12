# 12: AI 设置：双格式 provider 接入

**What to build:** 设置页（部署者功能）可配置 AI 接入：名称、协议格式（chat-completions | responses 二选一）、Base URL、API Key、模型 ID（自由填写 + "获取模型列表"校验）、自定义请求头。支持多套配置切换/设默认；保存时执行连通性测试与能力探测（流式、function calling），不支持 function calling 自动降级为约定 JSON schema 文本解析并在界面明示。密钥仅存服务端，设置页明示存放位置；agent 使用当前选中配置。中途切换配置保留会话上下文。

**Blocked by:** 06。

**Status:** resolved

- [x] 两种协议格式均可通过连通性测试并用于对话（各有集成测试：mock 双格式服务端）
- [x] 能力探测正确降级并在设置页明示降级状态
- [x] 多套配置保存/切换/设默认，刷新后保持
- [x] 切换配置后既有会话可继续（上下文不丢）
- [x] API Key 不出现在任何前端接口响应与日志中

## Answer

Implemented the provider settings page and server boundary. Providers are
stored in SQLite (or the injectable memory driver), support Chat Completions
and Responses, and are probed for connectivity, streaming, and function
calling before save. A provider without function calling uses server-side JSON
tool-call parsing and exposes the explicit degraded state in the UI. The
selected provider is resolved for each chat turn, while memory remains on the
existing trip-scoped thread.

Settings responses contain `hasApiKey` plus redacted custom-header values;
mounted Mastra metadata routes and provider errors are covered by secret-leak
regression tests. Verification: server typecheck, frontend typecheck, 110
existing server tests plus 8 focused provider tests, production Vite build,
and a Chromium settings-route smoke check.
