# 02: 行程 CRUD + SQLite 仓储 + 行程列表页

**What to build:** 用户打开应用看到行程列表页：可以创建新行程（标题 + 起止日期，天数/晚数自动计算）、重命名、删除。行程数据持久化在服务端 SQLite（libsql/better-sqlite3 之一，实现时定），刷新或换浏览器后行程仍在。核心表结构（trips / days / items / legs / messages 等）按 spec §Implementation Decisions 建立，本工单先落 trips 与最小骨架表。

**Blocked by:** 01。

**Status:** ready-for-agent

- [ ] 创建/重命名/删除行程经服务端 API 生效并在列表页可见
- [ ] 行程列表页显示标题与日期区间徽章（"10.02至10.08 7天6晚"式）
- [ ] 服务重启后数据仍在（SQLite 持久化）
- [ ] 仓储层以可注入驱动测试（内存驱动），沿用"容错读取、永不 throw"的 codec 测试约定
- [ ] 删除有确认，误删无静默数据丢失
