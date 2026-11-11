# DSH 远程工作区

在 DSH 中打开 SSH 服务器上的项目目录。可选择已有本地 checkout 作为同步目录。

基于 [flymysql/dsh-remote 0.8.80](https://github.com/flymysql/dsh-remote/tree/e851f93) 修改，保留 [MIT 许可证及上游版权声明](LICENSE)。

## 安装

在仓库根目录运行。已安装上游 `dsh-remote` 的 profile 应先卸载该 bundle，再安装此版本。两个版本使用同一套远程工具名和本机 SSH 数据。

```bash
dsh plugin --profile web add file:./plugins/dsh-remote
dsh web
```

### Windows 桌面版和内网镜像

完全退出 DSH Desktop 后，在解压的仓库根目录用桌面版注册的 `dsh` 命令安装。将下面的地址替换成内网现有的 npm 镜像。浏览器版使用 `--profile web`。

```powershell
$Registry = 'https://npm-mirror.example.internal/'
dsh plugin --profile desktop add 'file:./plugins/dsh-remote' --registry $Registry
```

源码可以直接从 ZIP 解压使用。保留 `file:` 前缀，profile 安装器会安装插件的运行依赖。裸目录路径默认会创建 `link:`，此时依赖必须已经安装在源码目录里。若已通过 `link:` 安装此插件，先用 `dsh plugin --profile desktop remove @wk4lt/dsh-remote` 移除旧链接，再执行安装命令。浏览器版使用对应的 `web` profile。

插件随包提供裁剪后的 `ssh2@1.17.0`，不包含原生加速模块或安装构建脚本，无需批准 pnpm 构建脚本。加密使用 Node 内置 OpenSSL，Poly1305 使用上游 JavaScript/WebAssembly 实现；SSH/SFTP 功能完整，大批量传输可能略慢于原生加速版本。来源、裁剪内容和升级流程见 [vendor/ssh2/VENDOR.md](vendor/ssh2/VENDOR.md)。

重新打开 DSH 后，在「设置 → 远程工作区」检查「远程服务器」和「目录映射」两栏。运行依赖由内网镜像提供，Host peer 依赖由当前 DSH 提供。安装步骤可以直接使用仓库自带的 `package.json`。

## 使用

- **设置 → 远程工作区 → 远程服务器**列出 DSH 保存的连接，可编辑、测试或删除。点击「从 ~/.ssh/config 导入」可选择一个 SSH 别名，把解析出的连接参数保存到 DSH。升级后需要导入旧版保存的别名，或编辑它并填写实际连接参数。原机器 ID 继续用于关联工作区和目录映射。
- **目录映射**按服务器分组。展开对应服务器的新增或编辑弹窗，选择已有本地目录并填写远端绝对路径。
- **工作区选择器 → 远程**选择服务器后，手动输入远端目录，或使用「浏览」和「从主目录浏览」选择目录。后者从当前 SSH 用户的主目录开始。勾选「映射到已有本地目录」时，插件验证两端目录并记录对应关系，使用选中的 checkout 作为手动同步的目录。未勾选时，插件创建一个空的托管镜像。两种方式都通过 SSH 查看和操作远端项目。
- **工作区选择器 → 本地**可以打开同一个 checkout，使用 DSH 原生工具在本机操作。

远程会话固定使用打开时的 SSH 主机和项目根目录。切换活动服务器或修改目录映射后，已有会话仍使用自己的绑定。如果原来的 SSH 目标已不可用，请从「远程」打开新工作区。模型通过 DSH 运行时上下文获得远程根目录和本地镜像路径。

点击会话顶部的远程主机标记可以查看两个目录，并手动「拉取到本地」或「推送到远端」。首次同步时，两端同名文件内容不一致会报告冲突。已有会话的映射改动后，请从「远程」重新打开对应工作区再同步。

升级到 0.1.6 后，旧的托管远程会话可以直接打开。以前直接以 checkout 路径打开的会话按本地会话处理。从「远程」重新选择服务器和项目目录可建立独立的远程会话。

连接、映射和同步记录保存在 `$DSH_HOME/remote-workspaces` 下，默认使用 `~/.dsh/remote-workspaces`。连接使用其中的 `machines.json`。OpenSSH 后端和远程终端加载同目录下的 `ssh_config`，可用「打开插件 SSH 配置」编辑 Kerberos 等 OpenSSH 选项。

包含 `ProxyCommand` 或多跳 `ProxyJump` 的连接需在插件的 `ssh_config` 中手动配置，并选择 OpenSSH 后端。
