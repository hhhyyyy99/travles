# AI 服务商模板：Before / After

场景：AI 设置页，新建且尚未保存的 DeepSeek 配置。两次都使用同一组公开连接信息（DeepSeek / `https://api.deepseek.com` / `deepseek-flash`），API Key 与自定义请求头为空，没有已有服务商配置。

- **Before**：[before.png](./before.png)，实际基线 `651ca5a104cd7c80815492f52c4d48ecdf9cae68`（`feature/v1.1`、已合入 PR #11）。在原表单中手动输入上述公开连接信息。
- **After**：[after.png](./after.png)，本 PR 的交付 revision（完整 SHA 见 PR description）。通过新增的 DeepSeek 模板填入同样的连接信息。
- 两张都是实际 React 应用 + Hono 后端、独立空 SQLite 数据库的 Chromium 截图，不是重绘的界面；`GET /api/settings/ai-providers` 均返回空列表。没有使用现有部署数据库或真实密钥。
- 相同浏览器与条件：Chromium headless shell 1248，1440 × 1100 CSS px，亮色主题，`/?view=settings`，未打开模型列表或原生选择弹窗，未运行能力探测。
- 另在 390 × 844 窄屏上实际查看新表单并测量无水平溢出；浏览器测试覆盖原生选择框键盘选择。

## 复核方式

打开设置页并新建配置，选择服务商模板，检查名称、模型和 Base URL。修改公开字段后，仍可使用原来的测试、获取模型列表与保存操作。切换模板应清空未保存的密钥、请求头、模型列表与探测结果；编辑已有配置时不显示模板入口。

模板中的默认地址和模型已于 2026-11-12 对照对应的官方接入文档核对，文档链接随模板显示。账号权限、地域和工作空间仍由服务商决定；自动化使用本地模拟服务，不代表已用真实账号完成七家服务商的在线验收。
