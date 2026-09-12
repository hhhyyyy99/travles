# AI 行程规划工作台 · 呼伦贝尔慢慢走

React + TypeScript + Vite 前端与 Hono + Mastra 后端组成的行程规划应用。支持一句话创建、多行程管理、AI 对话规划、按天画布与列表、路线地图、住宿编辑、当前行程打印、便签、清单、图库和推荐收藏。原呼伦贝尔旅行手册保留为独立指南，并自动导入一份内置示例行程。

## 环境与启动

- 完整应用需要 Node **>= 22.13.0**（Mastra 的运行要求；单独构建前端需要 >= 20.19）。
- 使用 `pnpm@11.17.0`，依赖版本由 `pnpm-lock.yaml` 固定。

```bash
pnpm install --frozen-lockfile
pnpm dev:server   # 终端 1：后端默认监听 4310
pnpm dev          # 终端 2：Vite 默认监听 5173，代理 /api 到后端
```

打开前端后进入行程列表，选择内置示例或创建自己的行程。可输入「成都5天，喜欢美食，节奏轻松」直接创建草稿并进入规划对话；未指定日期时显示「日期待定」，原始偏好会随行程保存。也可填写标题和起止日期创建行程。后端未启动时根入口显示原旅行手册。

| 入口 | 用途 |
| --- | --- |
| `/?view=trips` | 行程列表与创建、重命名、删除 |
| `/?view=workbench&trip=<id>` | 指定行程的三栏工作台 |
| `/?view=settings` | 服务端 AI 接入配置 |
| `/?view=guide` | 原呼伦贝尔指南、住宿管理与打印 |
| `/trip.html` | 兼容旧入口，重定向并保留查询参数和锚点 |

## 数据与 AI 接入

行程、会话、工具面板和收藏保存在同一个 SQLite 文件中；Mastra memory 与业务数据共用此库。设置 `TRIPS_DB_PATH` 可指定数据库路径，默认由后端包使用 `server/data/trips.db`。首次启动写入内置示例；进入行程列表时会幂等迁移同源旧版 localStorage 中的清单和住宿数据。原指南仍可独立使用本地存储和备份导入导出。

从行程列表打开 AI 设置，可保存多套 OpenAI 兼容配置并设为默认，支持 Chat Completions 和 Responses。保存前探测连通性、流式与工具调用能力；不支持工具调用时使用 JSON 文本工具协议。API Key 和自定义请求头保存在服务端，设置页只显示是否已保存及脱敏值。切换服务商后可继续同一行程的会话。

也可用服务端环境变量作初始配置：`AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`、`AI_PROTOCOL`，自定义请求头使用 `AI_HEADERS` JSON。未配置模型时行程编辑照常可用，对话提供配置指引。详见 [后端说明](server/README.md)。

AI 先澄清关键约束，再生成结构化行程；修改、智能解析、全局或单日优化先展示建议，确认后由服务端校验并写入。手动编辑会同步到画布、地图与会话；同一后端进程下的其他浏览器通过 SSE 接收更新。

工作台顶栏提供住宿编辑和打印入口。住宿修改保存在当前行程；打印前会刷新行程、便签和清单，输出当前卡片、住宿、路线与待定提示。参考路线保留估算标记，跨天交通也包含在每日路线中。

## 地图配置

Leaflet 用于显示路线与点位；无外部凭据时仍可查看内置参考路线。

- 服务端 POI 检索和实测驾车路线需要 `AMAP_WEB_KEY`（高德 Web 服务 Key；兼容 `AMAP_KEY`）。未配置或查询失败时显示待查询或参考信息。
- 原指南的浏览器高德能力使用仓库根目录 `amap-config.js`，格式参见 `amap-config.example.js`。浏览器 Key 与 Web 服务 Key 是两种配置。公开部署可通过 `serviceHost` 指定安全代理。
- 坐标以 WGS-84 保存，在高德边界转换为 GCJ-02。

## 构建与部署

```bash
pnpm build
pnpm build:server
pnpm --filter @hailar/server start
pnpm preview
```

前端产物位于 `dist/`，后端产物位于 `server/dist/`。完整工作台需要运行后端并将同源 `/api` 请求反向代理到后端；只托管静态文件可使用原旅行手册。SSE 路由应关闭代理缓冲，并允许长连接。`SERVER_PORT` 可修改后端端口，开发与预览代理使用同一个变量。

当前为单部署、单 Node 进程的工作台，未实现账户登录、分享或多人冲突合并。部署者应通过自己的入口访问控制保护服务端 AI 设置。SQLite 文件应放在持久卷并纳入备份。

## 检查与测试

| 命令 | 覆盖范围 |
| --- | --- |
| `pnpm typecheck` | 前端及后端严格类型检查 |
| `pnpm test` | 前端 domain 单测、真实后端 HTTP/SSE 与可注入仓储测试 |
| `pnpm test:app` | Playwright 浏览器验收，包含既有指南与工作台功能 |
| `pnpm test:app:prod` | 构建后在 Vite preview 上运行浏览器验收 |

首次运行浏览器测试可用 `pnpm exec playwright install chromium` 安装浏览器；也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向已有 Chromium。测试 mock 外部模型和地图服务，不需要真实凭据。详细约定见 [测试说明](tests/README.md)。

## 目录

- `src/components/workbench/`：对话、画布/列表、地图与辅助面板。
- `src/domain/`、`src/services/`：前端业务逻辑、API 与地图适配。
- `server/src/`：行程、仓储、TripPatch、AI 设置、模型工具及 SSE。
- `tests/`、`server/tests/`：前端、浏览器和后端验收。
- `.scratch/journey-planner-page/`：规格、PRD、分票与验收记录。
