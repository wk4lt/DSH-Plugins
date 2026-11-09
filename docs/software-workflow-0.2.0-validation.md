# Software Workflow 0.2.0 验收

验证日期：2026-11-10。环境：Windows、DSH 0.2.2-rc.1、Node 24.21.0、pnpm 11.28.5。

## 自动化与迁移

21 项自动化测试通过，覆盖 Markdown 原文、默认值、字段校验、行号、未知字段 warning、环境变量、重复服务器、保留 ID、目录覆盖与项目开关、编译矩阵、MCP allowlist、原生 AgentPreset 生命周期、历史投影、None 返回、会话锁定、HTTP 身份校验、动态菜单及请求失败回退。

四段 persona 正文与开发前 0.1.3 的 YAML 快照逐字比较一致。迁移后的 ID、名称、描述、order 和工具对照表见插件 README。唯一预期工具变更为 Debug 开启 `applyPatch`，仍关闭 `write`。

## 真实 DSH 运行时验收

使用独立 profile 和独立 DSH 数据目录，经 `dsh plugin add file:<repo>/plugins/software-workflow` 默认安装成功；未使用 `--ignore-scripts`，没有新增安装脚本。通过实际桌面 host、原生预设注册表、工具执行管线和无头 Chrome 验证。

- 零用户配置下仅有四个内置 Workflow；名称、顺序、persona、文件工具和 Shell 矩阵正确。
- 原生 `ctx.plugin(AgentPreset, config)` 成功；实际选择的 Agent 只连接当前 preset 的配置作用域，无服务泄漏，persona / 工具子插件均 active。
- 全局 `my-review.md` 在重启后出现，`write/edit/search: false` 和 `shell: none` 的相应工具均不存在。
- 全局同 ID 文件覆盖内置；修改 Develop 正文后重启，实际装配的 persona 包含新增标记。
- Test 挂本地 streamable-http MCP，实际经 DSH 工具管线调用返回 `ACCEPTANCE_MCP_PASS`。
- Develop 的工具列表中没有 Test 的 MCP 工具。
- Test 的非许可工具，以及另一个 `tools: []` 的 Agent，工具可见但调用返回 allowlist 错误；服务器调用计数不增加。
- 缺失环境变量、保留 ID 冲突的文件未注册，其他模式和 DSH 正常使用。精确文件、行号、字段与变量名由自动化日志捕获验证。
- `workflow: false` 保留在普通菜单；`hidden: true` 从列表隐藏，注册定义仍存在。
- 原生菜单仅在 Workflow 列表可用时过滤工作流；失败及空列表回退由实际 React 组件测试验证。
- 项目开关关闭时项目 Agent 不出现；开启后出现，显示完整来源路径，并可选择。
- 删除自定义文件后重启，该 preset 从列表消失。
- 客户端无 Remote 注入异常。

模式列表提供精确 HTTP 路由和 `/api` 别名。精确路由委托 DSH Connection 的身份校验；Fetch 路由显式使用 buffered 请求体，兼容 GET 和 Desktop API 传输。

## DSH 模型交接回归

使用真实 `deepseek-flash` 模型和独立临时项目，运行两次不同 preset 的会话：

1. Design 收到用户确认“导入重复项时只保留第一次出现的值，并保持原顺序”，实际写入 `.dsh-workflow/acceptance.md`，包含可观察条件与用户确认来源。
2. 同一项目新建 Test 会话。Test 实际读取规则，运行现有 `importer.test.cjs`，报告规则路径、确认原文、命令及结果。
3. 测试输出 `IMPORT_DEDUPLICATION_PASS`、退出码 0。DSH 的最终结论为“验收结果：通过（PASS）”。
4. 对已开始的 Test 会话请求切换 Develop，宿主返回 HTTP 409。

测试项目位于独立临时目录，未使用真实项目的验收文件；没有重启用户当前桌面进程。

## 限制

只在重启后读取文件；项目根目录由 profile 配置或启动目录决定，不跟随工作区选择。DSH 没有公开的 hidden preset 设置，因此保留了宿主 hidden 列表过滤和客户端原生入口展示适配，升级 DSH 后需重新验收。
