# 01: 后端骨架与 workspace 化

**What to build:** 项目成为前后端分离的 workspace 应用：pnpm workspace 新增后端 package（Node ≥ 20.19，TypeScript ESM，Hono 承载 HTTP，Mastra 实例挂载就绪）。开发期前端请求可代理到后端；后端提供一个健康检查端点返回版本信息。这是纯铺路工单，不包含任何业务功能。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] workspace 新成员可独立启动后端服务（dev 与 build 均可运行）
- [ ] 前端 dev server 通过代理访问后端健康检查端点成功
- [ ] 健康检查端点有 HTTP 层测试（走真实 app 实例，不 mock 内部）
- [ ] 根目录 `pnpm test` 与 `pnpm typecheck` 同时覆盖前后端，现有全部测试保持绿
- [ ] 现有指南应用行为不变（既有 Playwright 浏览器测试全绿）
