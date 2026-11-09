# Markdown 声明式 Agent

在 DSH Web / Desktop 中，用一个 Markdown 文件声明一个 Agent。插件将 frontmatter 编译为 DSH 原生 Agent preset，正文原样用作 `persona.prefix`。不使用 `complete: true`，不修改 DSH 核心，也不向用户的 `cordis.patch.yml` 写入预设行。

开发验证版本：DSH `0.2.2-rc.1`。插件版本：`0.2.0`。

## 安装与使用

从仓库根目录执行：

```sh
dsh plugin --profile desktop add file:./plugins/software-workflow
```

Web profile 将 `desktop` 换成 `web`。安装不需要 `--ignore-scripts`，插件没有安装构建脚本。

重启 DSH，在空白新会话右侧的 **Workflow** 下拉框选择 **None / Design / Develop / Test / Debug**。发送第一条消息后，预设固定。工作流会整套替换普通 Agent 的提示词和工具；**None** 恢复进入工作流前的普通预设。从左侧普通 Agent 菜单选择预设，也会退出工作流。

将 [my-review.md](examples/my-review.md) 复制到 `$DSH_HOME/agents/my-review.md`，重启后即可添加 Review 模式，不需要改 YAML 或插件包。没有设置 `DSH_HOME` 时，使用 `~/.dsh/agents`；本机通常是 `C:\Users\Administrator\.dsh\agents`。

## 文件格式

```markdown
---
name: Review
description: Review changes and report reproducible findings.
order: 30
workflow: true
tools:
  write: false
  edit: false
  applyPatch: false
  readImage: false
  search: true
shell: none
---
Review the requested changes. Read .dsh-workflow/acceptance.md for applicable
confirmed rules. Report findings with file paths and evidence. Preserve files.
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `id` | 文件名去掉 `.md` | 会话保存的稳定 preset ID；重命名文件时用显式 ID 保留旧身份 |
| `name` | 必填 | 显示名 |
| `description` | 必填 | 预设描述 |
| `order` | `100` | 有限数值，升序排列 |
| `workflow` | `false` | `true` 显示在 Workflow；否则显示在普通 Agent 菜单 |
| `hidden` | `false` | 从列表隐藏，定义仍可供历史会话按 ID 引用 |
| `tools.write` / `tools.edit` | `true` / `true` | 映射到文件工具开关 |
| `tools.applyPatch` / `tools.readImage` | `false` / `false` | 补丁和图片读取工具开关 |
| `tools.search` | `true` | 同时注册 `glob`、`grep`；关闭时均不注册 |
| `shell` | `auto` | `none` / `auto` / `bash` / `pwsh`；auto 在 Windows 用 pwsh，其余平台用 bash |
| `mcp` | `[]` | 当前 preset 自己的 MCP 服务器及调用许可 |
| 正文 | 必填 | 原样作为 persona prefix，包括换行，不做环境变量替换 |

`standard`、`ptc`、`minimal`、`cordis` 为保留 ID，不允许文件覆盖；`none` 保留给选择器。`id`、`name`、`description` 不得为空字符串。

不支持 `mode: subagent`、`permissions` 规则数组、`model` 覆盖或任意插件行。出现这些字段及其他未知字段时，记录带字段路径的 warning 并忽略。错误类型、重复 YAML 键、自定义 YAML 标签和 `!!js` 会使该文件失效。使用完整 YAML 解析器，支持列表和嵌套映射。

## 按 Agent 挂 MCP

例如，在 Test 文件中加入：

```yaml
mcp:
  - serverName: test-checks
    transport: streamable-http
    url: ${TEST_CHECKS_URL}
    headers:
      Authorization: "Bearer ${TEST_CHECKS_TOKEN}"
    tools:
      - mcp__test-checks__run_suite
      - mcp__test-checks__list_cases
  - serverName: lint
    transport: stdio
    command: npx
    args: ['-y', '@acme/lint-mcp']
    env:
      LINT_TOKEN: ${LINT_TOKEN}
    tools:
      - mcp__lint__check
```

完整文件示例见 [test-with-mcp.md](examples/test-with-mcp.md)。这些示例服务器需替换成自己的服务，不会随插件自动启动。

每个 MCP 生成当前 preset 内的一条 `@deepseek-ai/dsh-mcp-client` 行，其他 preset 不会继承它。`serverName` 必须符合 `[A-Za-z0-9_-]{1,32}`，同一 preset 中不能重复；不同 preset 可复用同一个名字。

`mcp[].tools` 只用于生成当前 preset 的 MCP allowlist，不传给 MCP 客户端。名称必须是该服务器的完整 `mcp__<serverName>__<toolName>`。同一 Agent 的所有服务器许可合并去重。未列出的 MCP 调用及通用 MCP 资源访问工具会被 policy 拒绝；`tools: []` 表示工具仍可见，但调用全部拒绝，返回 allowlist 错误。没有配置 MCP 时，不额外挂 MCP policy。

支持客户端字段：`serverName`、`transport`、`command`、`args`、`env`、`cwd`、`url`、`headers`、`toolCallTimeoutMs`、`failOnStartupError`、`maxInstructionBytes`、`reconnect`。`reconnect` 支持 `enabled`、`initialDelayMs`、`maxDelayMs`、`maxAttempts`。不属于当前 transport 的字段会警告并忽略。

所有 frontmatter 字符串值在启动注册时展开 `${VAR}`，包括 command、args、env、cwd、url、headers 和显示元数据。读取 DSH 进程的环境变量，不自动读取 `.env`。变量不存在时，整份文件跳过，日志给出文件、行号、字段路径及变量名；不会变成空字符串，也不会在日志中打印变量值。正文中的 `${VAR}` 保留原样。

## 加载顺序、来源与信任

只读取各目录第一层的 `*.md`，顺序为：

1. 包内 `agents/*.md`：始终加载。
2. `$DSH_HOME/agents/*.md`：默认加载。
3. `<projectRoot>/.dsh/agents/*.md`：默认关闭。

后加载的同 ID 有效文件覆盖前者，并记录谁覆盖了谁。错误文件逐个跳过，不删除此前有效定义，不阻塞其他模式或 DSH 启动。同一目录按文件名排序，结果可复现。

**Agent 文件属于可执行宿主配置的信任边界。** 原生 preset 的子插件可以运行宿主代码，MCP 的 `command` 能启动任意进程。加载克隆来的仓库中的 Agent 文件，等价于授权执行其声明的进程。文件工具开关也不是沙箱；本插件不实现 permissions 规则引擎，实际文件、Shell 权限仍由 DSH 沙箱控制。

仅在信任项目时，在 profile 的 `cordis.patch.yml` 显式启用，并指定固定项目根目录：

```yaml
- id: wk4lt-software-workflow
  config:
    enableProjectAgents: true
    projectRoot: 'D:/Projects/trusted-project'
```

`projectRoot` 省略时使用 DSH 启动进程的当前目录，**不跟随界面切换工作区**。项目 Agent 的显示名会带完整来源文件路径，普通菜单和右侧 Workflow 都能看见来源。项目开关关闭时，不读取项目 Agent 文件，也不启动其 MCP。

v1 只在 **重启 DSH** 后生效，不监听文件变化。编辑包内 Develop 正文后重启，同一 preset ID 会使用新定义；修改全局覆盖文件也一样。项目级开关是 profile 级信任决定，不是每会话确认。

## 内置四模式迁移对照

四个 ID、名称、描述、顺序和 persona 正文保持原样。相较 0.1.3，Debug 额外开启补丁工具：

| preset ID | 名称 / order | 文件写入 | 编辑 | 补丁 | 搜索 | Shell |
| --- | --- | --- | --- | --- | --- | --- |
| `wk4lt-workflow-design` | Design / 20 | 开 | 开 | 关 | 开 | none |
| `wk4lt-workflow-develop` | Develop / 21 | 开 | 开 | 开 | 开 | auto |
| `wk4lt-workflow-test` | Test / 22 | 关 | 关 | 关 | 开 | auto |
| `wk4lt-workflow-debug` | Debug / 23 | 关 | 开 | **开（本次修正）** | 开 | auto |

四个模式均保留读取工具，默认关闭图片读取，默认不带 MCP。Debug 允许按需打补丁，仍禁止整文件写入工具。**Design“只保存确认过的验收规则”属于提示词级约束，不是工具强制限制**；它的写入、编辑工具可以修改工作区内其他文件。

交接协议仍是 `.dsh-workflow/acceptance.md`：Design 保存用户确认的规则与来源；同一项目的新 Test 会话读取、引用并验证这些规则。模型和全局插件继续由 profile 提供。

删除自定义 Agent 文件并重启后，该 preset 消失；历史会话若引用已不存在的 ID，DSH 会明确拒绝恢复。不会自动换成别的 Agent。保留需要继续恢复的文件，或在重命名文件时显式保留 `id`。内置 ID 不应改名；用同 ID 的全局文件覆盖内置模式时，删除覆盖文件会回退到包内定义。

## 选择器与兼容适配

宿主提供经过 DSH 身份校验的 `GET /dsh-software-workflow/modes`，返回 `[{ id, label, order }]`，仅包含 `workflow: true` 且非 hidden 的有效文件。另提供 `/api/dsh-software-workflow/modes` 供 Web / Desktop 共享 API 传输。前端加载此列表，不硬编码模式。

模式列表请求失败、超时或为空时，右侧选择器隐藏，普通原生预设入口仍可选择所有可见 Agent。列表加载成功时，Workflow 中的条目从普通菜单隐藏。客户端不访问未注入的 Remote 服务。

DSH `0.2.2-rc.1` 没有隐藏 preset 的公开设置，因此宿主仅对 `hidden` ID 做列表过滤，保留历史恢复所需的注册定义；卸载时恢复原方法。客户端复用原生入口、菜单和选择流程，仅适配显示标题与候选列表。升级 DSH 后应重新验证这两处适配。

## 开发验证

```sh
cd plugins/software-workflow
pnpm install
pnpm test
```

自动化测试覆盖解析诊断、环境变量、目录覆盖、工具编译、MCP policy、原生注册生命周期、None 返回、空白会话限制、动态菜单及请求失败回退。真实 DSH 的验收结果与模型交接记录见仓库 `docs/software-workflow-0.2.0-validation.md`。
