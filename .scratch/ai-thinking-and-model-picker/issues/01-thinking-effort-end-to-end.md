# 01: AI 配置思考档位全链路（off/low/medium/high）

**What to build:** 用户在 AI 接入设置页为某套配置选择思考档位（关闭/低/中/高）并保存后：设置随配置持久化在服务端（旧配置自动为"关闭"）；此后每轮对话请求按协议携带标准思考档位字段——Chat Completions 发 `reasoning_effort`，Responses 发 `reasoning.effort`；档位为"关闭"时请求体不携带任何思考字段（与现状一致）。重新编辑配置时档位回显。请求体映射集中在模型适配器的请求构建一处；不发送 `enable_thinking` 等厂商私有字段（决策依据见 spec）。

**Blocked by:** None (can start immediately)。

**Status:** done

- [x] 配置数据新增单字段思考档位 `off | low | medium | high`，默认 `off`，数据库旧行迁移为 `off`；环境变量兜底配置固定 `off`
- [x] 创建/更新接口接受可选 `thinking` 字段并做严格枚举校验，非法值返回可读错误；公开 provider payload 返回该字段（不泄漏敏感信息的前提下）
- [x] 档位 `off` 时出站请求体不含任何思考字段；`low/medium/high` 在 Chat Completions 下发送 `reasoning_effort: <档位>`、在 Responses 下发送 `reasoning: { effort: <档位> }`
- [x] 切换协议格式（Chat Completions ↔ Responses）时思考档位设置保留
- [x] 设置页表单在协议格式附近新增思考档位控件，保存后重新编辑可回显；新建默认"关闭"
- [x] 服务端测试扩展既有 AI 配置 API 测试（桩 fetch 断言出站请求体）：off 无思考字段、三档 × 两协议映射、非法档位被拒、旧数据默认 off
- [x] 前端归一化单测：服务端未返回 thinking 时默认 off
- [x] 浏览器套件覆盖：选择档位 → 保存 → 重新编辑回显
- [x] `pnpm typecheck`、`pnpm build:server`、`pnpm test`、`pnpm test:app` 全绿（注意跑浏览器套件前停掉本地 dev server）

**备注**：本票与 02 都修改 AI 设置页同一表单文件，无阻塞关系但建议本票先合入，02 rebase 于其后。
