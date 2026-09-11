# 呼伦贝尔 · 慢慢走 —— 旅行手册（React + TypeScript + Vite + Tailwind）

旅行手册的 React + TypeScript + Vite + Tailwind CSS 迁移版（原原生 HTML/CSS/JS 实现已由 tickets 01–09 完整迁移并移除）。根入口 `/` 与原 `trip.html` 入口现在都进入同一个 React 应用；`trip.html` 保留原重定向语义（携带查询参数与锚点）。

## 环境要求

- Node **>= 20.19**（`engines` 已在 `package.json` 声明；开发机使用 Node 24 验证）。
- pnpm（`packageManager` 已声明为 `pnpm@11.17.0`；可用 corepack 自动选用：
  `corepack enable && corepack prepare pnpm@11.17.0 --activate`）。

## 安装

```bash
pnpm install --frozen-lockfile   # 按 pnpm-lock.yaml 精确安装依赖（锁文件已提交）
```

Playwright 浏览器按宿主环境预先放置；如缺失可 `pnpm exec playwright install chromium`。测试同时支持
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指定现成 Chromium 可执行文件。

## 开发 / 启动

```bash
pnpm run dev    # Vite 开发服务器，默认端口 5173 → http://localhost:5173/
pnpm start      # 构建后以生产产物预览方式启动（vite preview，默认端口 4173）
```

- 根入口 `/` 与 `/trip.html`（重定向到 `/`，保留 `?query` 与 `#hash`）在开发与生产预览中都可访问。
- 生产部署：把 `dist/` 放到任意静态托管即可，不依赖源码目录或 Node 服务器。

> 开发（5173）、`start`（4173）与 `preview` 是**不同端口**，属于**不同的浏览器存储源**。
> localStorage 按源（origin）隔离：在 5173 保存的数据不会在 4173 出现——这是特性，不是数据丢失。
> 同源刷新即可恢复；跨源迁移使用「导出或恢复住宿备份」功能（住宿弹窗内入口）。

## 构建 / 检查 / 预览

| 命令 | 作用 |
|---|---|
| `pnpm run typecheck` | 独立严格类型检查（`tsc --noEmit`，不依赖 Vite 转译） |
| `pnpm run build` | 先 `typecheck` 再 `vite build`；产物输出到 `dist/`（入口 `index.html` + `trip.html`） |
| `pnpm run preview` | `vite preview`，在本地预览 `dist/` 生产产物 |

## 高德地图配置（可选）

应用默认使用 Leaflet 参考地图与预置路线，无需任何凭据即可完整工作。配置高德后可启用实时驾车路线与地点搜索：

- 本地开发：在**仓库根目录**放置 `amap-config.js`：
  ```js
  window.TIBET_AMAP_CONFIG = {
    key: '你的高德 Web 端（JS API）Key',
    securityJsCode: '你的安全密钥',
    mapType: 'satellite',   // 或 'standard'
    showRoadNet: true,
    serviceHost: ''         // 可选：安全代理，以 /_AMapService 结尾
  };
  ```
  （模板见 `amap-config.example.js`；`amap-config.js` 已被 `.gitignore` 忽略，不要提交真实凭据。）
- 生产部署：把 `amap-config.js` 复制到 `dist/` 旁边（与 `index.html` 同级），页面会自动加载。
- 未配置 / 加载失败 / Key 无权限：自动降级为参考地图与行程信息，页面其余功能不受影响；
  路线查询失败会给出明确状态（如「路线未更新」），不会把旧估算当作新结果。
- 注意：这是**浏览器端配置**，不是服务器秘密；公开部署时建议走安全代理（`serviceHost`）。

## 测试

| 命令 | 目标 |
|---|---|
| `pnpm test` | 纯逻辑测试（`node --import tsx --test tests/*.test.ts`；经 tsx 直接导入 TS 源码） |
| `pnpm run test:browser` | 新版浏览器行为验收 `tests/app/*.browser.cjs`，跑在 Vite **开发**服务器 |
| `pnpm run test:app` | 同上（开发服务器别名） |
| `pnpm run test:app:prod` | 先 `pnpm run build`，再以 `APP_MODE=preview` 跑同一套验收，针对 **生产预览** |

浏览器测试约定：Chromium headless（`tests/helpers/vite-app.cjs`，127.0.0.1 + 空闲端口 + `--strictPort`）、
默认 8 秒超时、abort 所有非 127.0.0.1 请求、`page.addInitScript` 注入 provider fixture / 旧格式
localStorage 种子。高德 provider fixture（`tests/helpers/amap-stub.cjs`）只替代外部地图服务，不实现
应用住宿逻辑；自动化验收不需要真实高德凭据。

`APP_MODE` 说明：`openApp` 默认读环境变量 `APP_MODE`（`dev` | `preview`），缺省 `dev`。

本机注意：Playwright 1.62.1 期望的浏览器修订与机器缓存（chromium-1228）不一致，跑浏览器测试时
建议设置 `PLAYWRIGHT_CHROMIUM_EXECUTABLE` 指向缓存的完整 Chromium：

```bash
export PLAYWRIGHT_CHROMIUM_EXECUTABLE="$HOME/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
```

## 目录结构

```
index.html              根入口（React 应用壳；经典 <script> 加载 public/vendor/coordtransform.js）
trip.html               旧入口重定向戳（保留 ?query 与 #hash）
vite.config.ts          构建入口 index.html + trip.html
src/main.tsx            React 挂载（<StrictMode>）
src/App.tsx             页面骨架（topbar、行程、清单、住宿、打印）
src/data/               itinerary.ts / roadRoutes.ts（旧 trip-plan.js / data/road-routes.js 的类型化迁移）
src/domain/             纯业务逻辑（accommodation/checklist/routeStates/backup/geo 等，框架无关）
src/services/           amap.ts（类型化高德边界）、map.ts（Leaflet 生命周期）等
src/components/         行程、住宿弹窗、搜索、管理、备份、打印等 React 组件
src/hooks/              accommodation/routeStates/amapLive 等 React 粘合
src/index.css           @import "tailwindcss" + @theme 设计令牌 + 全局规则 + 打印样式
tests/helpers/          vite-app.cjs（服务/浏览器 helper）、amap-stub.cjs（高德 provider fixture）
tests/app/              浏览器行为验收（01–08 按功能划分）
tests/*.test.ts         纯逻辑测试（accommodation-core / amap-utils / accommodation-search / print-itinerary）
```

设计令牌（`src/index.css` `@theme`）沿用旧版 trip.css：`ink/muted/green/line/paper/red` 六个语义色、
PingFang SC 字体栈，以及命名的 `sm: 720px / md: 1050px / lg: 1500px` 断点（不是 Tailwind 默认断点）。
打印样式（`@page` 14mm 13mm、分页规则、隐藏交互控件）保留为纯 CSS。

## 数据与兼容

- 行程与住宿数据：七天六晚、住宿基地/晚次、路线状态与出发清单的存储键、格式与旧版完全兼容
  （`hailar-slow-trip-accommodation-v1`、`hailar-slow-trip-checklist-oct7-v2`、备份格式
  `hailar-slow-trip-accommodation`）；同源刷新即可恢复旧数据，旧版有效备份可直接导入。
- 坐标：持久化为 WGS-84 [lat, lng]；仅在高德边界转换 GCJ-02（保留既有转换语义）。