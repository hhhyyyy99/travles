# Spec: AI 行程规划工作台全面改造（pitravel.cn 对齐 + Mastra AI + Zod）

Status: ready-for-agent

来源：GitHub Issue #9（[Spec] AI 行程规划工作台全面改造规格书），归属 Epic #3。
本目录把该总规格书落为本仓库的 issue tracker 条目：`spec.md` 为规格书，`issues/NN-*.md` 为逐张实现工单，对应 Epic #3 拆解的 GitHub 子 issue #4–#8。

## Problem Statement

旅行者规划多天行程时，通用聊天机器人只输出无结构的长文，不考虑地理现实、驾车可行性与排期合理性。现有工具也缺少结构化操作：无法在交互地图上可视化行程、查看站点间驾车时间，或从社交媒体攻略（小红书、博客等）中抽取结构化计划。此外，本项目最初被限定为一份呼伦贝尔自驾指南，路线硬编码，游客无法规划任意目的地，也缺少健壮的、schema 驱动的 AI 引擎。

## Solution

把应用改造为对齐 pitravel.cn 的通用、AI 驱动的旅行规划工作台：

1. **首页入口**：双创建路径——对话式 AI 生成与外部攻略链接/文本解析，并配一份精选视觉行程库。
2. **三栏规划工作台**：
   - 对话式 AI 规划器（Mastra AI + Zod）：评估地理约束、呈现路线取舍、折叠思考过程、提供结构化 Diff 建议。
   - 交互式横向 Day 画布：展示活动条目（景点、餐饮、交通、住宿）并在相邻站点间计算驾车路段（距离与耗时），支持画布缩放与单日路线优化。
   - 交互式路线地图，与底部 Stash 抽屉联动：未排期的候选灵感可在地图上显隐、一键排入具体某天。
3. **Schema 优先的后端**：所有领域实体、工具输入/输出与变更补丁均由 Zod schema 严格约束；同时提供双 Mastra 管道——Agent（多轮对话规划）与 Workflow（多阶段攻略解析）。

## User Stories

1. As a traveler, I want to describe my trip in natural language on the home page, so that the AI can instantly sketch a suitable itinerary.
2. As a traveler, I want to paste a travel guide URL or article text, so that the system can automatically parse it into days and activity items.
3. As a traveler, I want to be prompted to paste note text if a link is blocked by anti-scraping measures, so that my parsing workflow is not interrupted.
4. As a traveler, I want to create a blank trip manually, so that I can construct my itinerary from scratch.
5. As a traveler, I want to see my trips presented as cards with high-quality landscape covers and destination tags, so that I can easily recognize and organize my trips.
6. As a traveler, I want to pin my most important trips to the top, so that they are immediately accessible.
7. As a traveler, I want to rename, duplicate, change covers, or delete trips, so that I have full control over my itinerary library.
8. As a traveler, I want to switch between "My Trips" and "Saved Trips", so that I can distinguish between my active plans and bookmarked references.
9. As a traveler, I want the AI to clarify critical travel variables (transport mode, dates, pacing) one at a time before generating a full plan, so that the itinerary reflects my actual constraints without overwhelming me.
10. As a traveler, I want to click option chips rather than typing repetitive answers during clarification, so that planning is fast and effortless.
11. As a traveler, I want the AI to perform geographic reality checks on long driving distances or infeasible daily transfers, so that I avoid unsafe or exhausting travel days.
12. As a traveler, I want to see the AI's step-by-step reasoning collapsed under a "Thought Complete" header, so that I can inspect its logic without cluttering my chat.
13. As a traveler, I want to preview proposed itinerary modifications as structured diffs before committing them, so that the AI never silently overwrites my work.
14. As a traveler, I want to click POI links mentioned in the chat to immediately focus that location on the map, so that I can inspect its geographic context.
15. As a traveler, I want to switch between a horizontal multi-day canvas view and a single-day list view, so that I can choose the planning layout that suits my current focus.
16. As a traveler, I want to zoom the canvas in or out, so that I can see the entire trip at a glance or examine details of individual cards.
17. As a traveler, I want activity items color-coded and badged by category (attraction, dining, transit, accommodation, note), so that I can quickly assess the balance of each day.
18. As a traveler, I want to see driving distance and duration badges between consecutive activity items, so that I know exactly how much transit time to expect.
19. As a traveler, I want to trigger a single-click route optimization for a specific day, so that the stops are automatically sequenced to minimize driving time.
20. As a traveler, I want to drag and drop activity items to reorder them within a day or move them across days, so that manual fine-tuning is intuitive.
21. As a traveler, I want to add custom activity items directly to any day, so that I can include personal reservations or recommendations.
22. As a traveler, I want the map to automatically render routes and markers matching my active day, so that I have an accurate spatial overview.
23. As a traveler, I want to save unassigned places and ideas into a Stash drawer, so that I don't lose interesting spots while drafting my days.
24. As a traveler, I want to toggle Stash markers on the map, so that I can see how close candidate spots are to my planned route.
25. As a traveler, I want to drag or one-click add an item from the Stash directly into a specific day, so that scheduling candidate spots is effortless.
26. As a traveler, I want the driving legs on the canvas and map to automatically recompute when an item is added from the Stash, so that my schedule is immediately updated.
27. As a traveler, I want the application to function reliably even without an external map API key by displaying estimated transit times, so that network or credential issues do not break the app.
28. As an administrator, I want to configure custom AI providers using pre-built templates for popular LLMs, so that I can use my preferred AI service.

## Implementation Decisions

1. **Domain Modeling & Single-Context Layout**：
   - 仓库按单一领域上下文组织，由根 `CONTEXT.md` 定义规范术语（`Trip`、`Day`、`Activity Item`、`Leg`、`Stash`、`Round`、`Clarify Question`、`Geographic Reality Check`、`Proposal`、`Patch`、`Link Parsing`）。
   - 架构决策记录于 `docs/adr/0001-universal-travel-planner.md`、`docs/adr/0002-mastra-agent-workflow-split.md`、`docs/adr/0003-graceful-link-parsing-pipeline.md`。
   - 注：按 `docs/agents/domain.md`，`CONTEXT.md` 与 ADR 采用惰性创建——在术语/决策实际被确定时创建，不预先撰写。
2. **Mastra AI Architecture**：
   - 对话式 Agent（`planner`）：带 memory 的多轮规划，由 Zod 工具驱动（`emit_round_meta`、`apply_trip_patch`、`create_trip_proposal`、`search_poi`、`calculate_legs`）。
   - Mastra Workflow（`parse_link_workflow`）：多步管道，把外部文章解析为天与活动条目，带自动文本降级。
3. **Schema First（Zod）**：所有模型（`Trip`、`Day`、`ActivityItem`、`Leg`、`StashItem`、`TripPatch`、`Proposal`、`RoundMeta`）以 Zod schema 定义，前后端共享。
4. **Storage & Realtime Sync**：SQLite/libSQL，带迁移支持；SSE 事件流在 Chat、Canvas、Map 面板间实时同步。
5. **Map & Routing**：Leaflet 地图，GCJ-02 坐标；服务端高德 API 代理做 POI 检索与驾车路线计算，未配置时优雅降级为直线估算。

## Testing Decisions

1. **Testing Seams**：
   - **HTTP/SSE API Seam（最高后端接缝）**：用注入的 mock 语言模型驱动真实 Hono 应用，经 HTTP/SSE 请求断言回合元数据、工具执行、地理校验与持久化。
   - **Playwright Browser Seam（最高前端接缝）**：在 Vite dev server 上驱动完整应用，断言三栏工作台交互、画布缩放、条目拖拽、链接解析与地图同步。
   - **Zod Contract Seam**：对所有领域契约做直接 schema 解析与校验断言。
2. **Good Test Principles**：测试外部可观察契约与用户交互，而非内部私有 helper。
3. **Prior Art**：`tests/helpers/vite-app.cjs`、`tests/*.test.ts`、`server/tests/*.test.ts`。

## Out of Scope

- 用户认证、登录会话与多用户访问控制。
- 原生移动 App 部署（聚焦响应式桌面/移动 Web）。
- 实时第三方预订交易（如机票/酒店购买）。

## Further Notes

- 地域指南（如旧版呼伦贝尔指南）保留为种子模板，而非硬编码约束。

## 工单拆解

| 本地工单 | 对应 GitHub issue | 依赖 |
| --- | --- | --- |
| [01 领域 Zod 契约](./issues/01-domain-zod-contracts.md) | #4 | — |
| [02 Mastra Agent 与攻略解析 Workflow](./issues/02-mastra-agent-workflow.md) | #5 | 01 |
| [03 首页重构（pitravel 双 Tab + 卡片库）](./issues/03-home-redesign.md) | #6 | 01, 02 |
| [04 工作台对齐（AI 助手 / 横向画布 / 待计划抽屉）](./issues/04-workbench-alignment.md) | #7 | 01, 02 |
| [05 全链路端到端测试与验收](./issues/05-e2e-acceptance.md) | #8 | 01, 02, 03, 04 |
