# 01: 工程启动与出发清单迁移

**What to build:** 开发者能够运行、构建和预览新版旅行手册，用户可以查看出发准备、勾选清单并在刷新后继续使用原有勾选记录。

**Blocked by:** None (can start immediately)

Status: resolved

- [ ] 选择兼容的 React、TypeScript、Vite 与 Tailwind CSS 版本，声明 Node 要求并锁定依赖；提供开发、独立严格类型检查、构建及预览命令。
- [ ] 先保留旧入口及原有功能，为新版提供可验收入口；新旧实现不得在同一页面竞争 DOM 或同时写入业务状态。必要的兼容改造在迁移调用方之前完成。
- [ ] 新版出发准备及清单使用 React、TypeScript 和实际生效的 Tailwind 样式，保留原文案、计数与桌面和手机布局。
- [ ] 兼容旧清单存储键和数据格式；同源刷新恢复勾选，损坏数据不导致白屏，写入失败准确提示仅本页有效。
- [ ] 复用 Node test runner 与 Playwright，支持针对真实 Vite 服务验收新版，同时保留尚未迁移功能的原测试；不默认增加组件测试层。
- [ ] 通过清单勾选、刷新恢复、旧格式初始化和写入失败的行为验证，独立类型检查与生产构建成功，预览可打开新版。
- [ ] 记录新旧入口、测试目标和开发端口使用方式，避免把不同源的存储隔离误判为数据丢失。


---

## Answer

**Status: resolved** — 本票已在分支 `ticket/01-project-checklist` 完成（5 个提交，见下）。

### 构建内容
- 工程脚手架：`package.json`（type:module、engines node>=20.19、scripts 按架构笔记）、`package-lock.json`（已提交）、`vite.config.ts`（react + tailwindcss 插件，build 入口仅 `app.html`，无 node 全局，可被 tsc 检查）、`tsconfig.json`（strict、jsx react-jsx、moduleResolution bundler、ES2022、noEmit、include src+vite.config.ts）、`app.html`（lang=zh-CN、viewport、title `呼伦贝尔，慢慢走 · 10.02—10.08 自驾手册`、`#root`、/src/main.tsx 模块脚本）。
- `src/main.tsx`（StrictMode 挂载）、`src/index.css`（`@import "tailwindcss"` + `@theme` 令牌 ink/muted/green/line/paper/red、PingFang SC 字体栈、命名断点 sm:720px/md:1050px/lg:1500px；body/a/button/svg/:focus-visible 等旧全局元素规则与 ≤720 滚动偏移、reduced-motion 保留在 base 层）。
- 清单功能：`src/domain/checklist.ts`（纯逻辑：键 `hailar-slow-trip-checklist-oct7-v2`、6 条原文案、load=JSON.parse(getItem||'[]')、非数组/解析失败→[] 不崩溃、仅保留 number、normalize 到 0..5 去重升序、写入失败返回 false）、`src/components/Checklist.tsx`（`#check-list` 6 个 label+checkbox、heading `我的出发清单`、计数 `N / 6`（分母硬编码 6）、状态行默认 `勾选状态保存在当前浏览器。`、失败精确显示 `当前浏览器未允许保存，勾选仅在本页有效。` 且页内状态保留；挂载即写一次以持久化清洗后的选择——与旧版 updateChecks 启动行为一致；全部布局/间距/颜色/排版/两档响应式由真实 Tailwind 工具类承载）、`src/App.tsx`（topbar 品牌 `草原之间` + `旅行手册 / 呼伦贝尔` + nav 每日行程/出发准备与 ≤720 隐藏规则；main 容器 max-w-[1440px] 4%/5% 边距）。
- 测试设施：`tests/helpers/vite-app.cjs`（`startViteApp({mode:'dev'|'preview'})` 在 127.0.0.1 + 空闲端口 + `--strictPort` 起真实 vite/preview 并等 `/app.html` 响应返回 {url,close}；`openApp({mode,init,viewport,entry})` 镜像旧 helper：chromium headless、abort 非 127.0.0.1 请求、8s 默认超时、读取 `APP_MODE`（默认 dev））、`tests/app/01-checklist.app.browser.cjs`（8 个场景：勾选计数、刷新恢复、旧格式 `[0,3,5]` 种子+刷新、损坏 "not-json"、字符串 `["0"]`、setItem 抛错、Tailwind 真实生效（3 列 grid + --paper 主题色）、390×844 移动端 2 列+品牌副标隐藏+计数）。
- `README.md`：安装、Node 要求、dev 端口 5173、临时 `app.html` 入口（旧 `/` 与 `trip.html` 仍可访问）、typecheck/build/preview/test 各命令含义、APP_MODE 区分、同源 localStorage 隔离警告。`.gitignore` 增加 `dist/`。

### 命令与结果（全部使用 `npm --cache /Users/eamon.j.he/.pi-desktop/scratch/81ea657d-e536-46ef-a1d8-050c52254cba/npm-cache`）
| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 通过（tsc --noEmit 0 错误） |
| `npm run build` | 通过：dist/app.html 0.44 kB、app-*.css 12.33 kB、app-*.js 224.02 kB |
| `npm test`（改前 / 改后） | 8/8 通过（改前）→ 8/8 通过（改后，tsx loader + 未来 .ts glob） |
| `npm run test:browser`（改前 / 改后） | 20/20 通过（改前）→ 20/20 通过（改后，旧套件未动） |
| `npm run test:app` | 8/8 通过（Vite dev，127.0.0.1 临时端口） |
| `npm run test:app:prod` | 8/8 通过（build + APP_MODE=preview 生产预览） |
| 手工验证 | dev `http://localhost:5173/app.html` 200（title 正确）；`HAILAR_PORT=4188 node scripts/serve.cjs` 下 `/` 与 `/trip.html` 均 200 |

### 下一票（ticket 02）须知
1. **浏览器二进制**：本机 `~/Library/Caches/ms-playwright` 只有完整版 `chromium-1228`，缺 playwright 1.62.1 期望的 `chromium_headless_shell-1234`。所有浏览器测试需设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE="$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"`（旧 helper 与新 vite-app helper 都读该 env）。不要升级 playwright 版本。
2. **`app.html` 暂无 vendored 脚本标签**：ticket 02 需要按架构笔记在此追加复制的 `vendor/coordtransform.js` 经典 `<script>`（放在模块脚本之前）。
3. **topbar 目前只有品牌 + 两个 nav 链接**（`每日行程`/`出发准备`，≤720px 隐藏）；`#print` 按钮留给打印票（ticket 08）。
4. **vite.config.ts 构建入口仅 `app.html`**；ticket 09 再切到 index.html+trip.html。`npm start`（scripts/serve.cjs）继续作为旧静态入口。
5. **vite dev 默认绑定 localhost（本机即 ::1）**；测试 helper 总是显式 `--host 127.0.0.1`，不受影响。
6. **4173 端口被一个更早启动的、属于主仓库的 `node scripts/serve.cjs` 进程占用**（启动于本次会话之前，未触碰）；`start` 脚本本身验证可用（HAILAR_PORT=4188）。
7. `npm test` 的新脚本 glob `tests/*.test.cjs tests/*.test.ts` 依赖 Node >= 21 的 test-runner glob（本机 Node 24 已验证）；若未来跑在 Node 20.19 需留意。
