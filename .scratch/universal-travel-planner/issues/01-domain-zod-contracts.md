# 01: 统一前后端 Zod Schema 领域契约与通用模型剥离

来源：Epic #3 → GitHub Issue #4。
Part of #3

**What to build:** 建立前后端统一的 Zod Schema 领域契约体系，彻底剥离旧版呼伦贝尔特定逻辑与硬编码，保证所有领域对象类型定义单向源自 Zod。所有领域模型在前后端共享，存储层与契约保持一致并向后兼容已有 SQLite 数据迁移。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## 详细要求

1. 领域模型定义（Zod schema）：
   - `TripSchema`: id、title、destination、startDate、endDate、daysCount、coverImage、isPinned、status、createdAt、updatedAt。
   - `DaySchema`: id、tripId、dayNumber、date、title、theme、note。
   - `ActivityItemSchema`: id、dayId、order、type (attraction|transit|dining|accommodation|note)、title、timeRange、note、cost、poi (name, lat, lng, address, amapId, category, rating)、pending。
   - `LegSchema`: id、fromItemId、toItemId、distanceMeters、durationSeconds、formattedDistance、formattedDuration、mode、polyline、status (verified|estimated|pending)。
   - `StashItemSchema`: id、tripId、title、note、category、poi、createdAt。
   - `TripPatchSchema`: 结构化补丁操作集 (add_day, update_day, remove_day, add_item, update_item, move_item, remove_item, add_stash, move_stash_to_day)。
   - `RoundMetaSchema`: 回合元数据 (round, chips, poiLinks, think, thinkComplete, geographicFactCheck, sources)。
2. 保持数据存储层与契约一致，向后兼容已有 SQLite 数据迁移。
3. 遵循 root `CONTEXT.md` 术语表与规范（术语/决策按需惰性创建，见 `docs/agents/domain.md`）。

## 验收标准

- [ ] 上述领域模型均以 Zod schema 定义，TypeScript 类型由 schema 单向推导（`z.infer`）。
- [ ] 前后端共享同一套契约（无重复手写的领域类型）。
- [ ] 存储层读写与 schema 一致；旧 SQLite 数据可迁移且不丢字段。
- [ ] 所有 schema 有直接解析/校验断言测试（Zod Contract Seam）。
- [ ] `pnpm typecheck` 与 `pnpm test` 全绿。
