# 代码质量检查

安装依赖：`pnpm install --frozen-lockfile`。运行环境和包管理器版本与项目一致（CI 使用 Node 24）。

| 命令                                | 用途                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `pnpm lint`                         | 检查整个工作区的 JavaScript 和 TypeScript                    |
| `pnpm format:check`                 | 检查整个工作区的格式，不修改文件                             |
| `pnpm format`                       | 格式化整个工作区；如需避免无关改动，优先使用下一条命令       |
| `pnpm exec prettier --write <文件>` | 仅格式化指定文件                                             |
| `pnpm quality:changed <基准提交>`   | 检查相对基准提交新增或修改的文件（含本地未提交的已跟踪文件） |

## 采用哪些标准

| 官方参考                                                                                          | 在 Travles 的落地                                                                                        |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Google TypeScript 风格](https://google.github.io/styleguide/tsguide.html#import-and-export-type) | 类型专用依赖显式用 `import type`；可变绑定用 `let`，不变绑定优先用 `const`。                             |
| [Airbnb JavaScript 风格](https://github.com/airbnb/javascript#comparison--eqeqeq)                 | 优先严格比较，阻止 `switch` 意外穿透；保留有意用 `value == null` 同时检查 null 和 undefined。            |
| [React Hooks](https://react.dev/reference/eslint-plugin-react-hooks)                              | 前端 `src/` 的组件与自定义 Hook 检查调用顺序和依赖数组；暂不全量启用 React Compiler 专项规则。           |
| [Prettier 配置](https://prettier.io/docs/options)                                                 | 2 空格、LF、100 列换行参考宽度、适用处的尾逗号和箭头函数括号。沿用项目的单引号（JSX 属性除外）和无分号。 |

ESLint 另外在前端、后端、域包及纳入类型项目的测试中检查无意义的 `await`、未处理的 Promise、Promise 误用及联合类型的 `switch` 是否覆盖各分支。React JSX 回调属性暂不启用 Promise 返回值检查；其他位置仍启用。

这些是为 Travles 选用的规则，不等于采用任一公司完整规范。不同指南在标点、布局和运行环境上有差异。Prettier 独立负责格式，ESLint 关注可能改变行为或造成缺陷的模式，避免两套规则争抢格式。

PR 工作流检查 GitHub 合并候选中本次 PR 改动的文件，不要求一次性格式化历史文件。全量本地检查可能仍报告旧问题；请在单独的清理变更中处理。删掉的文件、生成物以及锁文件不参与格式检查。工作流不使用仓库密钥，也没有在本次变更中设为分支必需检查。
