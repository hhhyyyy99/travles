# Spec: AI 行程规划工作台（前后端架构，Mastra AI）

Status: ready-for-agent

依据：[PRD](./PRD.md)（调研对象：圆周旅迹行程工作台）+ 用户决策：全量 PRD 范围；架构升级为前后端分离并接入 Mastra；本期不做分享；测试接缝为三处。

## Problem Statement

旅行规划散落在攻略、表格、地图和聊天群之间：查到的攻略无法直接变成可执行的日程，改一处约束（换一晚酒店、改一次航班）就要人工重排整条线路，行程本身也没有一个"能看、能改、能落地到路线"的载体。用户需要一个地方：说一句话就能得到结构化行程，改一句话行程就跟着变，并且在画布和地图上始终看到同一份最新计划。

本仓库现状加剧了这个问题：现有应用是一份硬编码的单次行程静态指南（呼伦贝尔），行程数据不可创建、不可编辑，AI 能力缺失，也没有服务端，数据只能躺在浏览器 localStorage 里。

## Solution

把项目改造为前后端分离的应用：

- **前端**（现有 React 19 + Vite + Tailwind 应用演进）：按 PRD 提供三栏工作台——左栏 AI 对话助手、中栏行程画布/列表、右栏路线地图，外加行程管理（多行程）与 AI 接入设置页。现有的单次行程指南内容保留为一份内置的示例行程， checklist、住宿、打印等既有能力迁入新结构而不是被丢弃。
- **后端**（新增 Node 服务，pnpm workspace 新成员）：基于 **Mastra**（TypeScript agent 框架）承载 AI 能力与业务数据。Mastra agent 实现澄清式规划协议（clarify / plan / patch-explain / qa 四类回合），通过工具调用产出结构化行程变更（TripPatch），服务端校验后落库并推送给前端。模型接入走 Mastra 模型路由，支持用户自定义任意 OpenAI 兼容服务（Chat Completions 与 Responses 两种格式）。行程、对话、清单等数据持久化在服务端数据库中。

用户视角的结果：打开应用可以创建任意目的地的行程，像聊天一样让 AI 规划和修改行程，画布和地图实时联动，换设备也能看到同一份行程。

## User Stories

**行程与工作台**

1. As a 旅行者, I want 从一句话（目的地 + 天数 + 偏好）创建一份新行程, so that 我不用从空白表格开始规划。
2. As a 旅行者, I want 在三栏工作台中同时看到 AI 对话、按天行程画布和路线地图, so that 我对行程有完整的空间感和时间感。
3. As a 旅行者, I want 三栏都能独立收起、AI 栏可调宽, so that 我可以按当前任务把注意力留给需要的视图。
4. As a 旅行者, I want 管理多份行程（列表、重命名、删除）, so that 我可以同时规划多次旅行。
5. As a 旅行者, I want 行程保存在服务端, so that 换一台设备或浏览器也能继续之前的工作。
6. As a 老用户, I want 现有呼伦贝尔指南作为一份内置示例行程出现在新结构中, so that 我已有的 checklist、住宿安排和打印能力不丢失。
7. As a 旅行者, I want 行程顶栏显示标题、日期区间与天数晚数, so that 我随时知道行程的基本盘。

**AI 对话规划**

8. As a 旅行者, I want 用自然语言让 AI 规划行程, so that 我不需要手动查攻略再逐项录入。
9. As a 旅行者, I want AI 先给框架、再逐个澄清关键变量（出行方式、航班车次、住宿约束、节奏偏好）, so that 计划建立在我真实约束上而不是 AI 的默认假设。
10. As a 旅行者, I want AI 澄清时给出可点选的选项 chips, so that 我不用打字也能回答。
11. As a 旅行者, I want AI 生成的正式计划包含逐日概览和关键提醒（预约限制、证件、天气、返程缓冲）, so that 计划是可直接执行的。
12. As a 旅行者, I want AI 确认后直接把行程写入画布和地图, so that 我不需要把聊天内容复制粘贴成日程。
13. As a 旅行者, I want AI 对未确认的槽位（如未定酒店）按默认填充并在画布上标记"待定", so that 计划完整但诚实。
14. As a 旅行者, I want 修改指令先被 AI 复述影响面并指出冲突、给出解决选项, so that 我不会在不知情时丢掉原计划的安排。
15. As a 旅行者, I want AI 执行修改后逐日汇报改动和为满足约束所做的妥协, so that 我能快速校验结果。
16. As a 旅行者, I want 每轮对话结尾有下一步建议问题 chips, so that 我知道规划还缺什么。
17. As a 旅行者, I want 展开 AI 的思考过程和来源, so that 我可以判断建议可信度。
18. As a 旅行者, I want 点击 AI 消息里的地名联动地图定位, so that 查证一个地点不用切出去搜索。
19. As a 旅行者, I want 会话历史随行程持久化, so that 回到行程时能回看规划过程。
20. As a 旅行者, I want 粘贴一段攻略文本让 AI 解析为结构化行程项（智能解析）, so that 现有攻略资产可以进入工作台。
21. As a 旅行者, I want 让 AI 对现有行程做全局路线优化和单日优化, so that 行程质量随迭代提升而不是一次性生成。

**AI 接入（BYO Model，经服务端）**

22. As a 部署者, I want 在后端配置任意 OpenAI 兼容服务（Base URL、API Key、模型 ID、自定义请求头）, so that 我可以用自选的模型服务商或自建推理服务。
23. As a 部署者, I want 协议格式支持 Chat Completions 与 Responses 两种并可切换, so that 新旧服务商都能接入。
24. As a 部署者, I want 保存配置时有连通性测试与能力探测（流式、function calling）, so that 配置错误在上线前暴露且能自动降级。
25. As a 旅行者, I want AI 服务不可用或鉴权失败时得到明确错误与处置指引, so that 我知道问题不在行程数据而在模型服务。

**画布与列表**

26. As a 旅行者, I want 行程按天分栏展示，每天有日期签、主题与卡片序列, so that 日程一目了然。
27. As a 旅行者, I want 卡片区分交通/住宿/游玩/餐饮/其他类型并带封面图、序号、备注, so that 一天的安排细节可读。
28. As a 旅行者, I want 相邻卡片之间自动显示驾车距离与时长, so that 我能判断节奏是否可行。
29. As a 旅行者, I want 拖拽排序卡片并让交通段与地图自动重算, so that 手动微调成本极低。
30. As a 旅行者, I want 对卡片上移/下移/跨天移动/跨天复制/删除, so that 调整方式符合直觉。
31. As a 旅行者, I want 添加无 POI 的纯文本活动卡, so that 自由活动、赶路这类事项也能进日程。
32. As a 旅行者, I want 切换到列表视图按天纵向核对日程, so that 小屏或校对场景下更高效。
33. As a 旅行者, I want 天级 AI 优化入口（魔法棒）, so that 我可以只重排不满意的那天。
34. As a 旅行者, I want 行程级的便签、清单和图库面板, so that 规划的周边信息不散落。

**地图**

35. As a 旅行者, I want 在地图上看到按日着色的完整驾车路线和每日里程标签, so that 环线结构一目了然。
36. As a 旅行者, I want 点击画布卡片或 AI 消息中的地点时地图聚焦该 POI 并显示详情（评分、图片、简介、收藏）, so that 我能就地了解景点。
37. As a 旅行者, I want 地图上叠加推荐点位并可一键加入行程或收藏, so that 发现和安排在同一个界面完成。
38. As a 旅行者, I want 收藏/推荐但未排期的点位进入"待计划"池并可拖入某天, so that 好点子不丢。
39. As a 旅行者, I want 按地区和类型筛选地图点位, so that 地图不因点位多而不可读。

**联动与可靠性**

40. As a 旅行者, I want 任意一处编辑后其余视图在秒级同步, so that 我永远在看最新计划。
41. As a 旅行者, I want 拖拽和增删即时生效、失败自动回滚并提示, so that 网络抖动不会吃掉我的操作。
42. As a 旅行者, I want 时间约束自相矛盾时 AI 先指出而不是静默取其一, so that 计划不会带病上线。
43. As a 旅行者, I want 跨天驾车超过 6 小时时收到拆分建议, so that 行程可执行。

## Implementation Decisions

**整体架构**

- pnpm workspace 新增后端 package（Node ≥ 20.19，TypeScript ESM，与前端同仓）；前端保留现有 Vite 应用，开发期代理 API，生产期可同源部署。
- 前后端以一条 **HTTP + SSE 边界**通信；前端不直接调用模型服务商，所有 AI 流量经后端（密钥不落浏览器，修订 PRD 中"Key 仅存本地"的决定——架构升级后由服务端持有）。
- 现有单次行程指南（数据、checklist、住宿管理、打印）重构为"内置示例行程"，复用现有 domain 模块；其既有 localStorage 数据在首次启动时迁移入服务端库或以导入文件方式进入（实现时以迁移成本低者为准，迁移行为须幂等）。

**后端（Mastra）**

- 基于 Mastra 搭建：一个 `planner` agent 承载"圆周AI"能力，系统提示词编码四类回合协议（clarify / plan / patch-explain / qa，见 PRD 附录 B）；agent 带 memory，会话线程与 trip 一一对应。
- 工具集：`apply_trip_patch`（唯一写行程的工具，服务端校验后落库）、`search_poi`（高德 Web 服务 POI 检索）、`route_legs`（驾车距离/时长）、`search_stay_reference`（住宿参考）。工具是模型接触数据的唯一通道。
- `apply_trip_patch` 校验规则：日期连续、无重叠住宿、交通段可达；校验失败将错误回传模型重试而非直接失败。
- 模型接入走 Mastra 模型路由的 OpenAI 兼容 provider：服务端设置存 Base URL / API Key / 模型 ID / 自定义请求头 / 协议格式（`chat-completions` | `responses`）；能力探测（流式、function calling）在保存时执行，不支持 function calling 时降级为约定 JSON schema 从文本解析。
- 传输：agent 流式输出经 SSE 透传给前端（回合类型、思考摘要、chips、TripPatch 应用结果均为流内事件）；Mastra 的 Hono server 能力用于挂载业务路由，或以独立 Hono 应用挂载 Mastra 实例，二选一在实现时以 Mastra 当前版本推荐为准。
- 持久化：SQLite 单库（libsql/better-sqlite3 之一），表覆盖 trips / days / items / legs / messages / checklist / notes / gallery / stash / favorites / ai_providers；Mastra memory 存储指向同一库。核心数据形状沿用 PRD §6（Trip / Day / Item / Leg / PoiRef / StashItem / Message.appliedPatch = TripPatch，AI 写入以结构化 diff 记录，支持追溯）。

**前端**

- 新增工作台路由（三栏）+ 行程列表页 + 设置页；现有指南页保留入口。
- 三栏为 trip 状态的纯投影：数据经后端 API 拉取 + SSE 订阅更新；画布拖拽等本地操作乐观更新，失败回滚。
- 地图渲染复用现有 Leaflet 主链路与 AMap 适配层；路线按日着色、日里程标签、POI 序号标记；POI 详情卡数据来自后端 `search_poi` 缓存。
- AI 接入设置页为部署者功能（服务端配置），含连通性测试按钮与降级状态明示。

**测试接缝（与用户确认的三处）**

1. **后端 agent API 接缝（最高接缝）**：通过 HTTP/SSE 驱动后端，注入 mock 模型（Mastra 的 mock/测试模型能力），断言四类回合协议、TripPatch 工具调用与校验回退。不 mock 内部工具实现。
2. **Trip 仓储接缝**：服务端 SQLite 仓储以可注入驱动方式测试（内存驱动），沿用现有"容错读取、永不 throw"的 codec 测试约定（_prior art：现有 storage 模块的注入式 StorageLike 测试）。
3. **前端 UI 联动接缝**：Playwright 浏览器测试（沿用 tests/app 编号式约定），mock 后端 SSE/API，断言画布-地图-对话三栏联动与卡片操作。

## Out of Scope

- **分享与可见性**（链接分享、邀请、只读视图）——本期明确不做（用户确认）；后端架构已为其留出能力，后续 spec 再做。
- 多人实时协同编辑、冲突合并。
- 交易闭环（订酒店/门票/租车）。
- 埋点与数据分析。
- 移动端原生 App；桌面优先，响应式仅保底。
- 现有指南内容之外的真实 POI 数据运营（POI 数据依赖高德实时检索 + 模型检索工具，不预置库）。

## Further Notes

- PRD 中"API Key 仅存浏览器本地"的决策因前后端改造被修订为服务端持有；设置页须明示密钥存放位置。
- Mastra 版本迭代较快（server 挂载方式、memory API、client SDK），spec 不锁定具体 API 面，实现时以当版文档为准；锁定的是：模型路由支持 OpenAI 兼容双格式、agent 工具调用产出 TripPatch、SSE 对外传输。
- 现有测试（node:test 单测 + Playwright）全部保留通过；workspace 化后测试命令入口不变。
