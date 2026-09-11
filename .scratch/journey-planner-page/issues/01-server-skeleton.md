# 01: 后端骨架与 workspace 化

**What to build:** 项目成为前后端分离的 workspace 应用：pnpm workspace 新增后端 package（Node ≥ 20.19，TypeScript ESM，Hono 承载 HTTP，Mastra 实例挂载就绪）。开发期前端请求可代理到后端；后端提供一个健康检查端点返回版本信息。这是纯铺路工单，不包含任何业务功能。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] workspace 新成员可独立启动后端服务（dev 与 build 均可运行）
- [x] 前端 dev server 通过代理访问后端健康检查端点成功
- [x] 健康检查端点有 HTTP 层测试（走真实 app 实例，不 mock 内部）
- [x] 根目录 `pnpm test` 与 `pnpm typecheck` 同时覆盖前后端，现有全部测试保持绿
- [x] 现有指南应用行为不变（既有 Playwright 浏览器测试全绿）

## Answer

**Delivered**

- `pnpm-workspace.yaml` 增加 `packages: ["server"]`（保留 pnpm 11 的 `allowBuilds` 设置不变；前端应用仍留在仓库根目录，最小改动）。
- 新增 workspace 成员 `server/`（`@hailar/server`）：TypeScript ESM（NodeNext）、严格 tsconfig、Hono + `@hono/node-server`；`@mastra/core@^1.66.0` 通过 `@mastra/hono` 的 `MastraServer` adapter 挂载（当版 Mastra v1 文档推荐模式，`server.init()` 注册 Mastra 路由）。`server/src/mastra.ts` 仅构造 Mastra 实例（无 agent/memory/存储，留给后续工单）。
- 健康检查 `GET /api/health` 返回 `{ ok, name, version, node, mastraReady }`；`mastraReady` 经 `c.get('mastra')` 证明实例已挂载。
- dev：`pnpm dev:server`（tsx watch，默认端口 4310，`SERVER_PORT` 可覆盖）；build：`pnpm build:server`（tsc 输出 `server/dist`，`node dist/index.js` 直接可跑）。
- Vite dev 代理 `/api → http://127.0.0.1:4310`（`vite.config.ts`，同样尊重 `SERVER_PORT`）；生产期按 spec 走同源部署，不加代理。
- 根 `pnpm test` = 前端 node:test 套件 + `pnpm --filter @hailar/server test`；根 `pnpm typecheck` = 根 tsc + server tsc。现有脚本（`dev`/`build`/`start`/`preview`/`test:app`/`test:app:prod`）行为不变。

**Verification evidence**

- `pnpm test` → 前端 56 pass / 0 fail；server 3 pass / 0 fail（HTTP 层测试直接 `app.request()` 驱动真实 app 实例，无内部 mock）。
- `pnpm typecheck` → 前后端均 0 错误。
- `pnpm build && pnpm test:app` → 66 pass / 0 fail（Playwright 套件，含 preview 模式用例；preview 用例需要先 `pnpm build` 出 `dist`，这是既有约定）。
- 手工验证：`pnpm dev:server` 与 `node server/dist/index.js` 均在 4310 端口返回健康检查 JSON；`pnpm dev`（Vite 5173）下 `curl http://localhost:5173/api/health` 经代理返回同一 JSON，`/` 与 `/trip.html` 均 200。

**Notes**

- Mastra 当前稳定版为 1.x（`@mastra/core` 1.66.x），其 `engines` 要求 Node ≥ 22.13.0；故 `server/package.json` 的 `engines.node` 为 `>=22.13.0`（根包保持 `>=20.19` 供前端使用），本机 Node 24.15 满足。这与工单原文"Node ≥ 20.19"的偏差即 Mastra 的版本要求，已按工单指示记录在 engines 字段。
- 未添加数据库/存储/memory 配置（工单 02 范围）；server 当前无业务路由。
