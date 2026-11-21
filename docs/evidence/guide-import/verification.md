# Guide parsing and confirmed import

This delivers the guide-entry slice of #6 and the parsing/import flow in #9, using the parser introduced in #12. Both creation methods remain available on the trip list. A guide is first previewed; confirmation creates a new itinerary and opens its existing workbench.

## Validation

- Full frontend and backend tests, TypeScript checks, Vite production build and backend build pass: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:server`.
- Seven guide-import browser scenarios pass in both Vite development and production preview. The existing three current-trip-flow scenarios also pass, including sentence intake and date-pending display.
- The import integration suite uses real temporary SQLite files and local HTTP, and covers existing database compatibility, ordered canvas readback, all item types, pending and located items, unchanged existing trips, 100-activity bounds, persistent idempotency across connections, concurrent confirmation, content conflicts, deleted receipts and rollback after an actual SQL-trigger failure.
- Screenshots were opened and inspected at 1440×1100 and 390×844. Inputs, feedback, scrollable day lists, location warnings and confirmation controls render without horizontal page overflow at the narrow viewport.

## Browser scenarios

1. Paste text → preview two days and located/pending cards → edit title → confirm → read the committed canvas → return to the list without restoring an already-imported preview → reopen the itinerary with no automatic chat request or persisted chat message.
2. Submit an unreadable URL → focus the text fallback and retain the URL → paste text, which takes priority → discard the preview without writing a trip.
3. Commit confirmation but lose its response → retain the frozen payload across a visit to settings → retry with the same UUID → return the one existing itinerary.
4. Show parsing feedback, suppress duplicate submission and cancel the request; a late successful response cannot restore a preview or create an itinerary.
5. Reject empty/invalid input locally; model-configuration errors expose settings, and returning from settings preserves the original text and guide tab.
6. Switch creation methods by keyboard, retain both form inputs, and inspect/discard a preview at 390px without horizontal overflow.
7. Parse and confirm with `crypto.randomUUID` unavailable; `crypto.getRandomValues` still produces the required UUID.

## Reproduce

The browser harness starts a separate HTTP backend for each scenario, with an isolated temporary SQLite database. It injects deterministic model output and POI search; it does not use deployment databases, real provider credentials or an external map service. The existing workbench shows its offline-map fallback in the screenshot. Live provider/POI accuracy remains outside this deterministic verification.

Use `PLAYWRIGHT_CHROMIUM_EXECUTABLE` when the Playwright-pinned browser is not installed; this run used the installed Google Chrome.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm build:server
PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' GUIDE_IMPORT_EVIDENCE_DIR=docs/evidence/guide-import node --test tests/app/21-guide-import.app.browser.cjs tests/app/17-current-trip-flows.app.browser.cjs
APP_MODE=preview PLAYWRIGHT_CHROMIUM_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/app/21-guide-import.app.browser.cjs
```

## Before / After：首页创建入口

2026-11-13 补充了独立审查要求的真实应用基线对照。原有输入、预览和导入图片均属于 After 流程阶段，不能代替 Before。

- **Before 基线版本**：`7d8c15a2145b104e6539ef783498f58d1a113e9d`，即捕获时 `feature/v1.1` 的版本。
- **After 应用版本**：`a10a8e55fc8edfc4710ba057d670e0323b438ae7`，即 PR #14 的实现版本。本次补证提交只追加截图、清单和说明，应用源码保持该版本。
- **共同场景**：`/?view=trips` 首页，隔离 SQLite 中行程数为 0，默认的一句话 AI 创建入口、输入为空、没有攻略草稿、滚动位置为顶部。
- **共同显示条件**：浅色主题、设备缩放 1，桌面 `1440×1100`，窄屏 `390×844`；同一 Chrome 版本。分别从两个真实 checkout 启动 React/Vite，连接同一个隔离 HTTP/SQLite backend，没有用设计稿或改写 DOM 模拟旧版。

| 视口 | Before：基线首页 | After：PR #14 首页 |
| --- | --- | --- |
| 1440×1100 | [Before 桌面截图](before-home-desktop.png) | [After 桌面截图](after-home-desktop.png) |
| 390×844 | [Before 窄屏截图](before-home-mobile.png) | [After 窄屏截图](after-home-mobile.png) |

已逐张打开并检查以上四张图片。基线没有攻略切换入口，After 显示“AI 创建计划 / 解析攻略”两个入口，且默认仍停留在 AI 创建。四个页面的横向内容宽度均未超过视口，捕获期间没有记录到 `pageerror`。捕获前后数据库仍为 0 个行程。

[捕获清单](comparison-manifest.json) 记录每张图的完整源版本、视口、主题、浏览器版本、SHA-256、页面文本与错误记录。捕获复用了 `tests/helpers/vite-app.cjs` 与 `tests/helpers/guide-import-server.ts`；模型和 POI 接口仍为既有确定性注入，本次首页对照没有调用模型或 POI 服务，也没有读取部署数据或凭证。

本次补证实际重新运行了两个 checkout 的领域包 TypeScript 构建（`node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.build.json`）、两版真实 HTTP 启动检查以及上述四个浏览器捕获断言。上文的完整测试、构建及七个导入场景为实现版本已有的验证记录，本次文档与图片修复没有宣称重新执行整套测试。

## After：攻略输入、预览与导入流程

以下保留实现版本的流程截图，作为新增能力的补充证据：

- [Guide input, desktop](input-desktop.png)
- [Draft preview, desktop](preview-desktop.png)
- [Guide input, narrow viewport](input-mobile.png)
- [Draft preview, narrow viewport](preview-mobile.png)
- [Imported itinerary in the workbench](imported-workbench.png)

The draft and recovery attempt are retained only in the current page's memory while visiting settings. Reloading or closing the page clears an unconfirmed draft. Dates remain unspecified until the traveler chooses them; pending locations remain visibly unresolved. This change does not complete the remaining home-library or workbench redesign requirements in #6/#7.
