# 03: 内置示例行程与既有数据迁移

**What to build:** 现有呼伦贝尔指南成为一份内置示例行程：首次启动时 seed 进服务端库，出现在行程列表中，打开可看到逐日数据。老用户浏览器 localStorage 里的 checklist 与住宿安排在首次进入时幂等迁移进服务端（重复迁移不产生重复数据）。现有指南页面保留入口，行为不变。

**Blocked by:** 02。

**Status:** resolved

- [x] 全新部署时行程列表出现内置示例行程，内容与现有指南数据一致
- [x] 带 legacy localStorage 数据的浏览器进入后，checklist 与住宿安排出现在服务端行程中
- [x] 迁移幂等：重复触发不产生重复数据
- [x] 现有指南页既有测试保持绿；迁移逻辑有单测（含损坏 JSON 降级场景）

## Answer

The built-in Hailar trip is seeded idempotently into SQLite, legacy checklist
and accommodation rows migrate by stable ids, and interrupted or repeated
startup paths remain safe. Canonical seeded route geometry and reference
quality metadata are repaired without overwriting user edits. Verification is
recorded in the [shared acceptance report](../acceptance.md); `pnpm test`
passed 149 frontend and 180 server tests.
