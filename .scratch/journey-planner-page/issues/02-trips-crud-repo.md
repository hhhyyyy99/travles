# 02: 行程 CRUD + SQLite 仓储 + 行程列表页

**What to build:** 用户打开应用看到行程列表页：可以创建新行程（标题 + 起止日期，天数/晚数自动计算）、重命名、删除。行程数据持久化在服务端 SQLite（libsql/better-sqlite3 之一，实现时定），刷新或换浏览器后行程仍在。核心表结构（trips / days / items / legs / messages 等）按 spec §Implementation Decisions 建立，本工单先落 trips 与最小骨架表。

**Blocked by:** 01。

**Status:** resolved

- [x] 创建/重命名/删除行程经服务端 API 生效并在列表页可见
- [x] 行程列表页显示标题与日期区间徽章（"10.02至10.08 7天6晚"式）
- [x] 服务重启后数据仍在（SQLite 持久化）
- [x] 仓储层以可注入驱动测试（内存驱动），沿用"容错读取、永不 throw"的 codec 测试约定
- [x] 删除有确认，误删无静默数据丢失

## Answer

Implemented server-backed trip CRUD with strict dated-trip validation, SQLite
persistence, tolerant in-memory repository seams, and a confirmed delete flow.
The quick-intake draft path also preserves date-pending metadata without
changing the manual title/date form. Full unit verification is recorded in the
[shared acceptance report](../acceptance.md): `pnpm test` passed 149 frontend
and 180 server tests.
