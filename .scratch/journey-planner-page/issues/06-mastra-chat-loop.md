# 06: Mastra 对话最小回路（SSE + qa 回合）

**What to build:** 左栏对话可用：用户发消息，后端 Mastra `planner` agent 流式回复（SSE），消息随行程持久化、刷新可回看。本工单先实现 qa 回合（普通问答），模型经服务端配置接入（本工单先用环境变量配置的 OpenAI 兼容端点，设置页留给 12）。后端测试在最高接缝：注入 mock 模型，经 HTTP/SSE 断言流式事件与消息落库，不 mock 内部实现。

**Blocked by:** 01, 04。

**Status:** ready-for-agent

- [ ] 用户发消息 → 流式看到 AI 回复逐字出现，完成后消息入库
- [ ] 会话线程与行程一一对应，重新进入行程可回看历史
- [ ] 模型服务不可用/鉴权失败时，对话流内给出明确错误（spec 用户故事 25）
- [ ] mock 模型经 SSE 驱动 agent 端点的后端测试：断言回合事件序列与持久化
- [ ] agent memory 使用与服务端同一 SQLite 库
