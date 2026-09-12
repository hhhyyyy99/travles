# 07: 澄清回合（chips、POI 链接、思考/来源）

**What to build:** AI 具备澄清式规划的前半程：收到规划请求先给环线/框架，识别"直接影响整体安排"的关键变量，一次只澄清一个，并渲染可点选的选项 chips（点击即作为回复发送）。AI 消息支持 Markdown 与行内 POI 链接（点击联动地图定位）；"思考完成"推理段与"来源"可折叠展开；消息带"复制"按钮。

**Blocked by:** 06。

**Status:** resolved

- [x] 规划请求触发 clarify 回合：先框架后提问，一次一问，带选项 chips
- [x] 点击 chip 作为用户回复发送并推进对话
- [x] 消息内 POI 链接点击后地图聚焦该地点
- [x] 思考段与来源可折叠；无思考/来源时隐藏对应区域
- [x] mock 模型后端测试覆盖 clarify 回合的事件序列（含 chips 数据）

## 实现记录（ticket 07）

**回合元数据产出机制：工具调用（非文本 JSON 块）。** planner agent 注册了
`emit_round_meta` 工具（`server/src/chat/round-meta.ts`，zod 校验 + 容错
normalize），系统提示词要求每轮在输出正文前调用一次，上报
`{round, chips?, poiLinks?, think?, thinkComplete?, sources?}`。与正文分离的
结构化通道与 08 的 `apply_trip_patch` 同构。

**SSE schema 增补（文档在 `server/src/chat/routes.ts` 头部）：**

1. `start {round}` — `round` 取本回合 `emit_round_meta` 的 round（提示词约定
   工具调用先于正文，`start` 因此能带上 `clarify`）；模型未调用工具时回退
   `"qa"`。`meta` 事件的 `round` 是权威值。
2. `delta {text}`* — 不变。
3. `meta` — 新增（可选，模型调用了 `emit_round_meta` 才有）：
   `{round, chips?: [{label, value}], poiLinks?: [{name, lat, lng, amapId?}],
   think?, thinkComplete?, sources?: [{title, url}]}`。在 delta 之后、done
   之前发出；旧前端忽略未知事件，天然兼容。
4. `done {userMessage, assistantMessage}` — assistantMessage 现在带
   `think` / `sources` / `meta`（同 meta 事件的 payload），刷新后从
   `GET /messages` 恢复 chips / POI 链接 / 折叠区。

**持久化：** messages 表新增 `meta TEXT`（JSON RoundMetaPayload），
`think` / `sources` 保留列启用（think 存文本、sources 存 JSON）。ensureSchema
对旧库做容错 ALTER；SQLite 驱动对缺列旧库降级读写。

**前端：** `src/domain/chat.ts` 解析 `meta` 事件并在 ChatMessage 上恢复
think/sources/meta；`src/domain/chatMarkdown.ts`（新增）解析标题/加粗/列表 +
行内 POI 链接（地名最长优先匹配）；`ChatPanel.tsx` 渲染 clarify 气泡
（chips 点击 → 以 value 作为用户回复走同一条 SSE 端点；"思考完成"/"来源"
折叠区缺省隐藏；"复制"按钮）；POI 链接点击经 `onFocusPoi` 回调到
WorkbenchPage → `MapPanelPlaceholder`。

**给 ticket 05 的地图联动契约：** WorkbenchPage 持有 focus 状态
（`{name, lat, lng, amapId?}`，形状同 meta.poiLinks 条目），以 `focus` prop
传给地图面板；占位面板已在 `#map-focus-target` 上暴露
`data-map-focus/-lat/-lng/-amap-id` 并 console.info。05 的 MapPanel 接同样的
prop 即可完成聚焦 + POI 详情卡。

**给 ticket 08 的接缝：** 路由消费 `output.fullStream`（text-delta /
tool-call / tool-result / error 分支），工具结果从 fullStream 的
tool-result chunk 读取；`apply_trip_patch` 按同一模式加第二个工具即可，其
校验失败重试语义在 tool result 里回传。流上多工具并存时分支按 toolName 区分。

## Answer

Added structured clarify metadata through the real agent stream, including
framework-first rounds, one-variable chips, POI links, thinking summaries,
sources, and persisted reload behavior. The shared chat renderer keeps the
metadata optional and tolerant. Final acceptance evidence is in the [shared
acceptance report](../acceptance.md): 149 frontend and 180 server tests
passed, with both dev and preview browser sweeps at 113/113.
