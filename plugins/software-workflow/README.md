# 软件开发工作流

在 DSH Web 里按软件开发阶段选择 Agent 预设。不同模式共用项目工作区和确认过的验收规则。

## 安装

面向 DSH Web，开发验证版本为 `0.2.2-rc.1`。从仓库根目录执行：

```sh
dsh plugin --profile web add ./plugins/software-workflow
dsh web
```

在新会话的预设选择器里选择模式，或在已有会话输入框下方点「新建工作流会话」里的模式按钮。按钮通过 DSH 的工作区导航打开同项目对应模式的会话。模型沿用当前 DSH profile 配置。

## 模式

| 模式 | 用途 | 默认工具 |
| --- | --- | --- |
| Design | 澄清需求，保存已确认的验收规则 | 读取、搜索、写入、编辑 |
| Develop | 实现并验证改动 | 读取、搜索、写入、编辑、补丁、Shell |
| Test | 按验收规则运行检查并报告证据 | 读取、搜索、Shell |
| Debug | 复现、定位并按需修复故障 | 读取、搜索、编辑、Shell |

模式决定注册的工具和 Agent 工作指引。Shell 的实际权限由 DSH 的会话沙箱配置决定。

## 试一次跨会话交接

1. 在项目内打开 **Design**，发送「我确认验收规则：导入时跳过重复记录。请保存这条规则。」
2. 查看 Design 写出的 `.dsh-workflow/acceptance.md`，其中应有规则和确认来源。
3. 在同一工作区点 **Test**，只输入「测一下导入功能」。Test 应引用该规则和来源，运行相关检查，并给出结果。如果项目没有可运行的检查，Test 会说明缺少的证据。

## 配置 Host 工具和 MCP

在 [cordis.patch.yml](cordis.patch.yml) 找到对应预设的 `config.plugins`。修改这一项可以调整提示词及该模式注册的 Host 工具。四个模式的 MCP 调用许可默认均为空。

例如，要给 **Test** 连接一个 Streamable HTTP MCP，把以下连接和工具名加入 Test 的插件列表。保留现有 `mcp-policy` 行并修改其配置，使用服务器实际地址和 DSH 公布的工具名。

```yaml
- id: mcp-test-checks
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: test-checks
    transport: streamable-http
    url: http://127.0.0.1:3000/mcp
- id: mcp-policy
  name: '@wk4lt/dsh-software-workflow/mcp-policy'
  config:
    mcpTools: ['mcp__test-checks__ping']
```

连接位于该预设作用域，许可按工具名校验。DSH 可能仍向模型展示 profile 已注册的其他 MCP 工具，调用时会被模式许可拒绝。编辑后重启 DSH，并用新会话验证变更。
