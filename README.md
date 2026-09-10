# 自驾旅行手册

- Next.js 首页保留西藏行程。
- 首页的“呼伦贝尔”入口打开 `/hailar/index.html`，包含自定义住宿、路线联动、备份恢复和打印功能。

## 运行与构建

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm build` 和 `pnpm start` 用于 Node 服务模式；`pnpm export` 生成静态站点。GitHub Pages 工作流自动使用仓库子路径。

开发和构建会把呼伦贝尔手册的运行资源生成到 `public/hailar/`，无须手动同步。该目录不提交 Git。原独立预览仍可用 `pnpm preview:guide` 启动。

## 地图配置

呼伦贝尔手册优先使用构建进程中的 `NEXT_PUBLIC_AMAP_KEY` 和 `NEXT_PUBLIC_AMAP_SECURITY_JS_CODE`；未设置时沿用本地 `amap-config.js`。已有配置会自动加载，不要求访客连接。西藏 Next.js 页面沿用原有环境变量配置。

## 验证

`pnpm test` 运行 Node 测试。安装 Chromium（`pnpm exec playwright install chromium`）后，`pnpm test:browser` 运行住宿功能浏览器测试。详见 `tests/README.md`。
