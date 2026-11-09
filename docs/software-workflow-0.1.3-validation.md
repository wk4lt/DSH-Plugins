# Software Workflow 0.1.3 验证

验证日期：2026-11-09。环境：Windows、DSH 0.2.2-rc.1、Node 24.21.0、pnpm 11.28.5。

## 自动化测试

`plugins/software-workflow/test/workflow.test.js` 的 9 项测试全部通过：

- 工作流注册为独立 Agent 配置，普通预设列表仅过滤本插件的四个 ID。
- 从 Standard 和 Creator 进入各阶段后，None 恢复之前的普通预设。
- 使用真实 Session 的事件序列重建选择状态及返回目标。
- 从普通预设菜单选择后退出工作流，并更新下一次的返回目标。
- 四个阶段拥有各自的 persona、文件工具、平台 Shell 和 MCP 策略。
- 列表适配卸载后恢复原方法，不隐藏第三方预设。
- 无效请求、失效会话、已开始的会话和不可用预设不会改变当前选择。
- 右侧入口全英文，无 Remote 注入访问；请求失败恢复原选择并显示错误。
- 原生入口晚于插槽声明注册时，标题适配仍会生效。

## 桌面集成验证

已将本地文件依赖更新到 desktop profile 的 0.1.3。保留原有依赖声明、bundle 顺序与用户 `cordis.patch.yml`。

用该 profile 启动独立的 DSH host，并以独立数据目录、无头 Chrome 验证，未重启用户正在使用的桌面进程，未发送模型请求。

验证结果：

- None / Design / Develop / Test / Debug 五个选项均可选择，切换请求均返回 HTTP 200。
- 四个工作流均不出现在普通 Agent 菜单中。
- 工作流启用时左侧显示 Agent preset，普通菜单仍可操作。
- Standard → 四个阶段 → None，回到 Standard。
- Creator → Design → Debug → 重载页面 → None，回到 Creator。
- Test → 左侧选择 Standard，右侧同步回到 None。
- 再次进入 Debug 后选择 None，恢复到最新选择的 Standard。
- 全程无客户端异常及 `cannot get property "remote" without inject`。

DSH 当前没有隐藏预设的公开选项，因此包含注册表列表过滤与原生入口标题两处兼容适配，详见插件 README；升级 DSH 后需要重新验证。
