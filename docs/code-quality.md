# 代码质量检查

安装依赖：`pnpm install --frozen-lockfile`。运行环境和包管理器版本与项目一致（CI 使用 Node 24）。

| 命令                                | 用途                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `pnpm lint`                         | 检查整个工作区的 JavaScript 和 TypeScript                    |
| `pnpm format:check`                 | 检查整个工作区的格式，不修改文件                             |
| `pnpm format`                       | 格式化整个工作区；如需避免无关改动，优先使用下一条命令       |
| `pnpm exec prettier --write <文件>` | 仅格式化指定文件                                             |
| `pnpm quality:changed <基准提交>`   | 检查相对基准提交新增或修改的文件（含本地未提交的已跟踪文件） |

ESLint 在前端、后端、域包及其 TypeScript 测试中检查无意义的 `await`、未处理的 Promise 和 Promise 误用。React JSX 回调属性暂不启用 Promise 返回值检查；其他位置仍启用。现有 JavaScript 使用基础规则。Prettier 单独管理风格，不运行在 ESLint 内。

PR 工作流检查 GitHub 合并候选中本次 PR 改动的文件，不要求一次性格式化历史文件。全量本地检查可能仍报告旧问题；请在单独的清理变更中处理。删掉的文件、生成物以及锁文件不参与格式检查。工作流不使用仓库密钥，也没有在本次变更中设为分支必需检查。
