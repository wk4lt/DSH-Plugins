# dsh-remote 0.1.2 安装验收

日期：2026-11-09。环境：Windows x64、Node 24.21.0、pnpm 11.28.5、DSH Desktop 0.2.2-rc.1。

## 干净安装

在新临时目录创建独立 `package.json`，执行：

```sh
pnpm add file:D:/DSH/DSH-Plugins/plugins/dsh-remote
```

结果：退出码 0，安装 32 个包。未使用 `--ignore-scripts`、构建审批、构建白名单或修改默认构建策略；下载使用 npmmirror registry。

- 输出没有 `ERR_PNPM_IGNORED_BUILDS`。
- 扫描安装后的 32 个包：没有 `preinstall`、`install`、`postinstall` 脚本，没有触发隐式 node-gyp 构建的根目录 `binding.gyp`。
- `cpu-features` 在项目根目录和完整依赖图中均不存在。
- `pnpm why ssh2 --json` 和安装锁文件确认依赖来源为 `file:D:/DSH/DSH-Plugins/plugins/dsh-remote/vendor/ssh2`。
- 在插件的依赖解析上下文中，`ssh2.Client` 存在，`bindingAvailable` 为 `false`，`CIPHER_INFO` 有 23 项。

**命令执行位置说明：** 默认 pnpm 隔离布局不会把插件的传递依赖 `ssh2` 暴露在消费项目根目录。因此，直接在这个干净项目根目录运行 `require('ssh2')` 会报 `MODULE_NOT_FOUND`，不能把它记作通过。这里使用插件上下文进行检查：

```js
const { createRequire } = require('node:module')
const pluginRequire = createRequire(require.resolve('@wk4lt/dsh-remote'))
console.log(!!pluginRequire('ssh2').Client) // true
const crypto = pluginRequire('ssh2/lib/protocol/crypto.js')
console.log(crypto.bindingAvailable, Object.keys(crypto.CIPHER_INFO).length) // false 23
```

真实 desktop profile 使用 `nodeLinker: hoisted`，下面两条原始验收命令已直接在其根目录执行通过：

```sh
node -e "const s=require('ssh2');console.log(!!s.Client)"
node -e "const c=require('ssh2/lib/protocol/crypto.js');console.log(c.bindingAvailable,Object.keys(c.CIPHER_INFO).length)"
```

## 打包和源码

- 新建临时项目，以 `pnpm add ssh2@1.17.0 --ignore-scripts` 获取源码，未使用桌面 profile 中的旧副本。
- 保留的上游运行文件、LICENSE 和 README 与新源码逐字节一致。
- `pnpm pack` 生成 `wk4lt-dsh-remote-0.1.2.tgz`，包含 67 个文件，含 vendor 的运行文件、包清单、LICENSE 和 VENDOR.md。
- 发布包不含 `node_modules/`、`.node` 二进制、`binding.gyp` 或 `crypto/src/`。

## 真实 desktop profile

1. 备份 profile 的 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml`。
2. 删除 `allowBuilds` 中的 `cpu-features@0.0.10`、`ssh2@1.17.0` 两条；该映射已空，因此一并移除空的 `allowBuilds`。
3. 通过桌面版注册的 `dsh plugin --profile desktop` 命令重装，退出码 0，未使用 `--ignore-scripts`，未出现构建脚本拦截。
4. 同路径的 file 依赖曾保留旧插件副本，普通 add 和 `--force` 没有更新该副本；移除插件后重新添加，已确认实际安装版本为 0.1.2。已恢复原有 bundle 顺序，保留原有依赖声明及其他配置。
5. 在该 profile 根目录执行上述两条原始验收命令，输出分别为 `true`、`false 23`；`node_modules/cpu-features` 不存在。
6. 使用真实 Desktop runtime 和该已安装 profile 启动独立 Host，仅将 `DSH_HOME` 指向临时数据目录，避免干扰用户正在运行的实例。插件详情显示版本 `0.1.2`，组件 `wk4lt-dsh-remote` 为“运行中”（active）。验证实例已关闭。

已安装客户端文件与仓库源码一致。用户当前运行的桌面实例未被重启，重启后加载新代码。

## 回归验证

6 个测试全部通过，包括模拟 SSH 的映射、推送、同步和命令执行，以及新增机器、刷新反馈、映射选择和 vendored ssh2 的构建文件/运行能力检查。

刷新按钮会在手动刷新期间显示“刷新中…”并禁用，成功后显示完成提示，失败显示错误且可重试。测试覆盖了这三个状态以及重试成功。
