# 05: 全链路端到端自动化测试与体验验收

来源：Epic #3 → GitHub Issue #8。
Part of #3

**What to build:** 验证前后端改造后的类型安全性、Mastra AI 流式与解析管道可靠性、以及浏览器端关键操作链路。

**Blocked by:** 01、02、03、04。

**Status:** ready-for-agent

## 详细要求

1. 严格运行 `pnpm typecheck` 验证前后端 TypeScript 编译零错误。
2. 运行单元测试 `pnpm test` 覆盖领域模型、Zod Schema 校验与后端路由。
3. 验证端到端场景：
   - 首页 AI 创建行程与攻略长文解析流程。
   - 工作台 AI 对话流式推送、Chips 交互与方案写入。
   - 画布卡片拖拽、里程耗时渲染与待计划抽屉联动。
   - 无地图 Key 时的优雅降级验证。

## 验收标准

- [ ] `pnpm typecheck` 前后端零错误。
- [ ] `pnpm test` 全绿，覆盖领域模型 / Zod 校验 / 后端路由。
- [ ] Playwright 浏览器接缝覆盖上述四个端到端场景并全绿。
- [ ] 无地图 Key 的降级路径有自动化验证。
- [ ] 在工单 `## Answer` 中记录实际运行的命令与结果证据。
