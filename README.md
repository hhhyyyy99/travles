# 呼伦贝尔 · 慢慢走 —— 旅行手册（React + TypeScript + Vite + Tailwind）

旅行手册的 React + TypeScript + Vite + Tailwind CSS 迁移版。迁移期间新版应用从临时入口 `app.html` 提供；旧版静态页面（`/` 与 `trip.html`）保持可用，直到 cutover 票（09）把根入口切换到构建产物。

## 环境要求

- Node **>= 20.19**（`engines` 已在 `package.json` 声明；开发机使用 Node 24 验证）。
- npm。本机默认 `~/.npm` 缓存可能有权限问题，所有 npm 命令请显式指定缓存目录：
  `npm --cache <你的缓存目录> <command>`（例如 `npm --cache /path/to/npm-cache ci`）。

## 安装

```bash
npm ci          # 安装 lockfile 锁定的依赖（package-lock.json 已提交）
```

迁移期间新增依赖时改完 `package.json` 后改用 `npm install`，并提交更新后的 `package-lock.json`。

Playwright 浏览器按宿主环境预先放置；如缺失可 `npx playwright install chromium`。测试同时支持
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定现成 Chromium 可执行文件。

## 开发

```bash
npm run dev     # Vite 开发服务器，默认端口 5173 → http://localhost:5173/app.html
```

`app.html` 是迁移期间的临时入口（ticket 09 前保留）；后续票会在其中追加复制型的
`vendor/coordtransform.js` 经典 `<script>` 标签，目前尚未添加。

旧版入口仍可访问（不动旧文件）：

```bash
npm start       # 旧静态入口：node scripts/serve.cjs → http://127.0.0.1:4173/（index.html）
                # trip.html 仍是到 index.html 的重定向戳，老书签继续有效
```

> 开发（5173，Vite）、生产预览（预览服务器端口）与旧版静态入口（4173）是**三个不同端口**，
> 因此属于**三个不同的浏览器存储源**。localStorage 按源（origin）隔离：在 5173 勾选的数据不会在
> 4173 出现——这是特性，不是数据丢失。同源刷新即可恢复；跨源迁移使用住宿备份功能，不要通过
> 跨端口“拷贝” localStorage 来绕过。

## 构建 / 检查 / 预览

| 命令 | 作用 |
|---|---|
| `npm run typecheck` | 独立严格类型检查（`tsc --noEmit`，不依赖 Vite 转译） |
| `npm run build` | 先 `typecheck` 再 `vite build`，产物输出到 `dist/`（单页入口 `app.html`） |
| `npm run preview` | `vite preview`，在本地预览 `dist/` 生产产物 |

## 测试

| 命令 | 目标 |
|---|---|
| `npm test` | 纯逻辑测试（`node --import tsx --test tests/*.test.cjs tests/*.test.ts`；已迁移的 TS 测试通过 tsx 直接导入源码） |
| `npm run test:browser` | 旧版浏览器行为套件 `tests/*.browser.cjs`（继续覆盖尚未迁移的功能，走旧静态入口） |
| `npm run test:app` | 新版浏览器验收 `tests/app/*.browser.cjs`，跑在 Vite **开发**服务器（`tests/helpers/vite-app.cjs`，127.0.0.1 + 空闲端口 + `--strictPort`） |
| `npm run test:app:prod` | 先 `npm run build`，再以 `APP_MODE=preview` 跑同一套新版浏览器验收，针对 **生产预览** |

浏览器测试约定（与旧 helper 一致）：Chromium headless、默认 8 秒超时、abort 所有非 127.0.0.1 请求、
`page.addInitScript` 注入 fixture / 旧格式 localStorage 种子。

`APP_MODE` 说明：`openApp` 默认读环境变量 `APP_MODE`（`dev` | `preview`），缺省 `dev`。
`test:app:prod` 通过 `APP_MODE=preview` 让同一测试文件命中 `vite preview`。

本机注意：Playwright 1.62.1 期望的浏览器修订与机器缓存（chromium-1228）不一致，跑浏览器测试时
建议设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向缓存的完整 Chromium：

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

## 目录结构（迁移期）

```
app.html                新版临时入口（单页）
vite.config.ts          仅 app.html 一个构建入口（ticket 09 切到 index.html + trip.html）
src/main.tsx            React 挂载（<StrictMode>）
src/App.tsx             页面骨架（topbar 品牌 + 各 section 组合）
src/domain/             纯业务逻辑（checklist.ts 等，框架无关）
src/components/         React 组件（Checklist.tsx 等）
src/index.css           @import "tailwindcss" + @theme 设计令牌 + 全局元素规则
tests/helpers/          vite-app.cjs（新版服务/浏览器 helper）、browser.cjs（旧版）
tests/app/              新版浏览器验收（* .app.browser.cjs）
tests/*.browser.cjs    旧版行为套件（迁移期间保持通过）
```

设计令牌（`src/index.css` `@theme`）沿用旧版 trip.css：`ink/muted/green/line/paper/red` 六个
语义色、PingFang SC 字体栈，以及命名的 `sm: 720px / md: 1050px / lg: 1500px` 断点（不是 Tailwind
默认断点）。全局元素规则（body/a/button/svg/:focus-visible 等）保留在与旧版一致的基础层中。
