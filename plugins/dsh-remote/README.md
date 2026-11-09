# DSH 远程工作区

将已有的 Windows 工作区绑定到 SSH 服务器上的项目目录。可独立安装和使用。

基于 [flymysql/dsh-remote 0.8.80](https://github.com/flymysql/dsh-remote/tree/e851f93) 修改，保留 [MIT 许可证及上游版权声明](LICENSE)。

## 安装

在仓库根目录运行。已安装上游 `dsh-remote` 的 profile 应先卸载该 bundle，再安装此版本。两个版本使用同一套远程工具名和本机 SSH 数据。

```bash
dsh plugin --profile web add file:./plugins/dsh-remote --ignore-scripts
dsh web
```

### Windows 桌面版和内网镜像

完全退出 DSH Desktop 后，在解压的仓库根目录用桌面版注册的 `dsh` 命令安装。将下面的地址替换成内网现有的 npm 镜像。浏览器版使用 `--profile web`。

```powershell
$Registry = 'https://npm-mirror.example.internal/'
dsh plugin --profile desktop add 'file:./plugins/dsh-remote' --registry $Registry --ignore-scripts
```

源码可以直接从 ZIP 解压使用。保留 `file:` 前缀，profile 安装器会安装插件的运行依赖。裸目录路径默认会创建 `link:`，此时依赖必须已经安装在源码目录里。若已通过 `link:` 安装此插件，先用 `dsh plugin --profile desktop remove @wk4lt/dsh-remote` 移除旧链接，再执行安装命令。浏览器版使用对应的 `web` profile。

`--ignore-scripts` 跳过 SSH 依赖的可选原生构建脚本，插件使用 JavaScript 实现。

重新打开 DSH 后，在「设置 → 远程工作区」检查「远程服务器」和「目录映射」两栏。运行依赖由内网镜像提供，Host peer 依赖由当前 DSH 提供。安装步骤可以直接使用仓库自带的 `package.json`。

## 使用

- **设置 → 远程工作区 → 远程服务器**列出已保存的服务器和 SSH 配置中的主机。编辑打开弹窗，测试连接的结果显示在该行。首次使用 SSH 配置中的主机时，打开编辑并保存。
- **目录映射**按服务器分组。展开对应服务器的新增或编辑弹窗，选择已有本地目录并填写远端绝对路径。
- **工作区选择器 → 远程**选择服务器和远端目录，然后勾选「映射到已有本地目录」。选定目录后以本地 checkout 为会话工作区。复选框关闭时使用原有的托管镜像流程。

保存映射会验证本地和远端目录。已有绑定指向别处时会显示两个目标供确认。解绑移除映射记录，托管镜像的清理功能仍以插件创建的目录为作用范围。

`rw_push` 和 `rw_sync` 继续负责同步，支持 `dryRun` 预览。已有 checkout 首次同步时，两端已有但内容不同的文件会报冲突。远程命令、文件操作和端口转发仍可通过原有 `rw_*` 工具使用，后台审计也可用。插件移除了上游的远端 DSH 网页入口、自更新和匿名统计。

映射和同步记录保存在本机的 `$DSH_HOME/remote-workspaces` 下。
