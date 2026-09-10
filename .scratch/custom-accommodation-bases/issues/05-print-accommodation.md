# 05: 打印可供同行者查看的住宿行程

**What to build:** 用户打印当前行程或使用浏览器另存为 PDF，让同行者看到所选住宿名称、地址和备注，以及可靠的路线状态。

**Blocked by:** 01：手动添加住宿基地并用于行程

Status: resolved

- [x] 打印内容使用当前有效住宿安排，逐日展示住宿名称、已填写的地址和备注；空选填字段不产生无意义占位。
- [x] 打印住宿摘要及基地数量与实际行程一致，不包含未使用的备选基地。
- [x] 区域型基地的代表位置估算提示和未更新路线状态保持清楚，不将失败或过期距离作为有效新结果。
- [x] 打印视图隐藏编辑按钮、输入控件和仅供操作的管理界面。
- [x] 支持浏览器打印及另存为 PDF，不新增独立 PDF 服务、在线共享链接或公共基地目录。
- [x] 浏览器打印模式验收并目视检查分页、长名称、长地址、多晚复用和备注；内容可读，无关键文字裁切。
- [x] 打印操作不修改或公开本地基地数据；查看打印内容不依赖同行者拥有账号。

## Answer

Implemented on branch `codex/accommodation-05` in the ticket implementation commit. The print view now renders from the current accommodation API state, shows each effective overnight base with its name, optional address, optional notes, area representative-position disclosure, and route status. Unused backup bases and stale route estimates are excluded from the printed itinerary. The print-only stylesheet removes maps, editing controls, and management UI, adds wrapping and pagination rules, and supports browser print / Save as PDF.

Evidence: `npm test` passed 3 tests; `tests/accommodation-print.browser.cjs` passed in desktop and mobile print media, with long text and overflow assertions. An A4 PDF rendered to 6 pages; pages 1, 2, and 6 were visually inspected for pagination, route status, area disclaimers, long accommodation fields, and uncropped text. The complete browser suite on this isolated ticket branch still has five failures in the separate route/core acceptance flows that depend on other integration work.
