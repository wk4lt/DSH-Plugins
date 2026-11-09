// dsh-remote — client half.
// Settings → 远程工作区: a multi-machine SSH registry (add/edit/select current;
// passphrase / host-key mode / proxy jump / agent / keychain password; password
// stored host-side and kept private). Plus a port-forward panel, the command
// audit log view, quick workspace switching, and an ~/.ssh/config importer.
//
// A unified workspace directory picker fills ui-workspace's two directory-flow
// holes (sidebar + conversation hero):
//   • 本机 tab → opens the NATIVE OS folder chooser (/dsh-remote/local-pick)
//     and returns the picked local path (works with local workspaces).
//   • 远程 tab → pick a machine (dropdown), list its directories over
//     /dsh-remote/ls, choose or type a remote path → /dsh-remote/mirror builds a
//     real LOCAL mirror → onPicked(localMirror) so host adopts it as a workspace.
//
// better-sidebar integration (optional): a live remote file explorer tab and a
// read-only-by-default remote file tab with an explicit「编辑 → 保存到远程」flow
// (mtime optimistic lock via POST /dsh-remote/write).
//
// Client entries must be classic scripts registered via window.__ModuleLoader__.load
// ({ id, factory }); the factory receives a synchronous `require`.
window.__ModuleLoader__.load({
  id: '@wk4lt/dsh-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const name = 'wk4lt-dsh-remote'

    // ── optional host primitives ────────────────────────────────────────────
    // Issue #74: a remote session's .md link must open over SFTP, NOT via the
    // built-in preview that reads the local mirror and dies with ENOENT when the
    // file was never synced. remote-link therefore claims .md again (issue #64's
    // objection was "source is a downgrade from a rendered doc") — but the viewer
    // RENDERS the markdown with the host's own MarkdownText when this build ships
    // one, so there is no downgrade. Older builds / the test harness fall back to
    // plain source.
    const Primitives = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return null } })()
    const MarkdownText = (Primitives && typeof Primitives.MarkdownText === 'function') ? Primitives.MarkdownText : null
    // Host visual primitives adopted incrementally, always with a graceful
    // fallback (the shared map's contents vary by host version — the bundle
    // ships ~290 exports, older type packages fewer):
    //   Modal — always-portaled dialog with focus trap/autofocus/restore and
    //     IME-composition guards (useModalLayer underneath). Its mask dismisses
    //     on bare click, so the DIR PICKER keeps its own press-origin-guarded
    //     overlay (issue #52); simple dialogs without mid-gesture re-layouts
    //     (PromptDialog, ConfirmDialog) adopt Modal wholesale.
    //   HostMenu — anchored menu with optional body portal; replaces our
    //     imperative-DOM context menu when present.
    //   useModalLayer — the focus/escape layer on its own, applied to the picker's
    //     custom overlay (which keeps its #52 mask guard).
    //   writeClipboard — replaces the scratch-textarea copy hack.
    //   Switch — settings toggles (bundle-verified contract: onChange delivers
    //     a bare BOOLEAN, not an event, and unknown props are swallowed, so the
    //     stable data-testids ride on a wrapper span, never on the Switch).
    //   SegmentedTabs — the dir picker's 本机/远程 switch (items[{value,label}],
    //     value, onChange(value)); brings the sliding-indicator tablist.
    //   FileTypeIcon — explorer/picker row glyphs ({kind:'folder'} for dirs,
    //     {path:name} for files; unknown extensions land on 'other').
    const Modal = (Primitives && typeof Primitives.Modal === 'function') ? Primitives.Modal : null
    const HostMenu = (Primitives && typeof Primitives.Menu === 'function') ? Primitives.Menu : null
    const useModalLayerFn = (Primitives && typeof Primitives.useModalLayer === 'function') ? Primitives.useModalLayer : null
    const writeClipboardFn = (Primitives && typeof Primitives.writeClipboard === 'function') ? Primitives.writeClipboard : null
    const HostSegmentedTabs = (Primitives && typeof Primitives.SegmentedTabs === 'function') ? Primitives.SegmentedTabs : null
    const HostFileTypeIcon = (Primitives && typeof Primitives.FileTypeIcon === 'function') ? Primitives.FileTypeIcon : null

    // Issue #93: floating layers must PORTAL to document.body, exactly like the
    // host's own Modal/Menu (and like our context menu already does with an
    // imperative append). An inline `position:fixed` overlay stays inside the
    // slot's subtree, where the 0.2.2 conversation layout traps its pointer
    // events in existing sessions — the dialog paints but every click falls
    // through to the chat text beneath (the hero page has no such container,
    // which is why new sessions "worked"). react-dom is in the host's shared
    // module map; when it is not (older host, test harness), keep the inline
    // overlay rather than lose the dialog altogether.
    const ReactDOM = (() => { try { return require('react-dom') } catch { return null } })()
    const portalize = (element) => (
      ReactDOM && typeof ReactDOM.createPortal === 'function'
        && typeof document !== 'undefined' && document.body
        ? ReactDOM.createPortal(element, document.body)
        : element
    )

    // ── i18n (issue #14) ────────────────────────────────────────────────────
    // Dictionaries are keyed by stable ids, zh + en share the same key set.
    // Lookup order: active locale → en fallback → the key itself (so a missing
    // translation stays visible instead of blanking the UI).
    const NS = 'dsh-remote'
    const L = {
      zh: {
        'mapping.servers': '远程服务器',
        'mapping.title': '目录映射',
        'mapping.server': '服务器',
        'mapping.add': '新增映射',
        'mapping.edit': '编辑目录映射',
        'mapping.remove': '解除绑定',
        'mapping.local': '本地目录',
        'mapping.remote': '远端目录',
        'mapping.check': '映射到已有本地目录',
        'mapping.typeLocal': '请输入已有本地目录的绝对路径。',
        'mapping.noServers': '请先在 SSH 配置中添加服务器，再在这里保存。',
        'mapping.missingServer': '服务器已移除',
        'mapping.removeConfirm': '解除 {local} 的远端绑定？',
        'mapping.replace': '将 {local} 的远端目标从 {old} 改为 {next}？',
        'settings.title': '远程工作区（dsh-remote）',
        'settings.intro': '下面直接列出 ~/.ssh/config 里的机器：点「连接」，再选一个远程目录就能开始。要加机器，点「打开配置文件」编辑这个文件，改完点「刷新」。',
        'settings.noMachines': '还没有保存的机器 —— 上面列出的是 ~/.ssh/config 里的主机，点「连接」即可。',
        // ── issue #73：首屏就是 ssh 配置里的主机列表（像 VSCode Remote-SSH）──
        'settings.pickHost': '选择远程机器',
        'settings.hostListSource': '来自 ~/.ssh/config',
        'settings.hostListLoading': '正在读取 ~/.ssh/config…',
        'settings.hostListRefresh': '刷新',
        'settings.hostListRefreshHint': '重新读取 ~/.ssh/config（改完文件点这里，不用重开设置页）',
        'settings.hostListEmpty': '没在 {file} 里找到主机。写好 Host 段后点「刷新」。',
        'settings.hostListFailed': '读取失败：{msg}。这不是你的 ssh 配置有问题（文件根本没读到）——点「刷新」重试；一直失败说明插件版本与服务端不一致，重启 DSH 即可。',
        'settings.hostConnect': '连接',
        'settings.hostConnecting': '连接中…',
        'settings.hostConnectHint': '连上并设为当前机器（之后就能选远程目录）',
        'settings.hostConnected': '已连接 · {latency}',
        'settings.hostConnectedHint': '已连接，选择要打开的远程目录即可开始工作。',
        'settings.openSshConfig': '打开配置文件',
        'settings.openSshConfigHint': '用本机编辑器打开 ~/.ssh/config。改完点「刷新」，新的 Host 会出现在列表里。',
        'settings.sshConfigOpened': '已打开：{file}',
        'settings.sshConfigOpenFailed': '无法自动打开（{msg}）——可以直接编辑这个文件：{file}',
        'settings.badgeKey': '私钥',
        'settings.openWorkspace': '选目录',
        'settings.openWorkspaceHint': '在这台机器上选一个远程目录作为工作区',
        'settings.recentWorkspacesFor': '最近工作区（{n}）',
        'settings.recentWorkspacesHint': '这台机器用过的远程目录，点开直接打开',
        'settings.openWorkspaceHere': '打开',
        'settings.openWorkspaceOnHint': '在 {host} 上打开这个目录（会创建/复用本地镜像）',
        'settings.workspaceOpened': '已打开远程工作区：{path}',
        // 列表的搜索、排序与连接状态（机器一多就要用）。
        'settings.hostFilter': '搜索主机（名字 / 地址 / 用户）',
        'settings.liveNow': '已连接',
        'settings.lastConn': '上次连接 {when}{ms}',
        'settings.agoJustNow': '刚刚',
        'settings.agoMinutes': '{n} 分钟前',
        'settings.agoHours': '{n} 小时前',
        'settings.agoDays': '{n} 天前',
        'settings.current': '当前',
        'settings.edit': '编辑',
        'settings.delete': '删除',
        'settings.currentMachine': '当前远程机：{name}',
        'settings.clearCurrent': '取消设为当前（active remote = none）',
        'settings.noActive': '当前没有活动远程机：保存的机器只是备用连接，不会自动进入会话上下文（本地会话不受影响）。',
        'settings.editMachine': '编辑机器',
        'settings.badgeSshConfig': 'ssh cfg',
        // Issue #51 — transport backend (GSSAPI/Kerberos via system OpenSSH).
        'settings.badgeOpenssh': 'openssh',
        'settings.backend': '连接后端',
        'settings.backendNative': 'native（内置 ssh2：密码 / 私钥 / agent / 动态码）',
        'settings.backendOpenssh': 'openssh（调用本机 ssh 命令）',
        'settings.backendOpensshHint': '调用本机 ssh，因此完全遵循 ~/.ssh/config：支持 GSSAPI/Kerberos（kinit 后免密登录）、ProxyCommand、PKCS11Provider、Match 等 OpenSSH 专有特性；主机密钥由 ssh 用你自己的 known_hosts 校验。代价是每条命令都要新建一次连接（比 native 慢），文件浏览（SFTP）仍保持长连接。',
        'settings.backendOpensshAliasOk': '已勾选「使用 ssh_config 别名」：主机名原样交给 ssh，端口/用户/私钥/跳板机一律由 ~/.ssh/config 的 Host 块决定，对应的输入框在 openssh 后端下填了也不生效（这就是「配置唯一来源」，issue #50）。密码/Passphrase 仍会通过 askpass 交给 ssh，仅当 Host 块里没有可用认证时才用得上。',
        'settings.sshBinary': 'ssh 路径',
        'settings.sshBinaryPlaceholder': '留空 = 用 PATH 里的 ssh',
        // Issue #54: the README told users to point `webAttachCommand` at a
        // private-prefix dsh, but the settings UI offered nowhere to type it —
        // it could only be written by the deploy flow or by hand-editing
        // machines.json. It is an ordinary per-machine field now.
        'settings.sshImport': '从 ~/.ssh/config 导入',
        'settings.useSshConfig': 'Host 名来自 ~/.ssh/config（主机栏填 Host 名即可）',
        'settings.useSshConfigHint': '连的时候会按 ~/.ssh/config 里这个 Host 的实际配置去连（用户/端口/私钥/跳板机都从文件读，改文件就生效）；这里留空即可。',
        'settings.saveWritesSshConfig': '保存时会把 主机/用户/端口/私钥 写入 ~/.ssh/config 的受管块（# dsh-remote: managed 标记）；此后该文件优先——直接改它立即生效。',
        'settings.sshResolvedTo': '→ {user}@{host}:{port}',
        'settings.sshResolvedNone': '~/.ssh/config 中没有匹配「{alias}」的 Host 条目',
        'settings.sshResolvedWarn': '注意：{msg}',
        'settings.sshAliasSaved': '已按别名保存（连接时解析）',
        'settings.name': '名称',
        'settings.host': '主机',
        'settings.port': '端口',
        'settings.user': '用户',
        'settings.password': '密码',
        // 密码框永远是空的（宿主不会把密文/明文回传），所以「有没有存过密码」
        // 只能靠 placeholder 表达：星号 = 已保存。空框 + 中性提示会让人以为
        // 插件把密码弄丢了。
        'settings.passwordPlaceholder': 'SSH 密码（隐藏输入；不用密码可留空）',
        'settings.secretSavedPlaceholder': '••••••••••••（已保存，留空 = 不修改）',
        'settings.secretSavedHint': '已保存密码 ••••••••••••（出于安全不回显）：留空保存 = 沿用已保存的密码，填新值 = 覆盖。',
        'settings.passphraseSavedHint': '已保存私钥 passphrase ••••••••••••：留空保存 = 沿用，填新值 = 覆盖。',
        'settings.proxyPwdSavedHint': '已保存跳板机密码 ••••••••••••：留空保存 = 沿用，填新值 = 覆盖。',
        'settings.noCredentialHint': '⚠️ 这台机器还没有任何凭据（密码 / 私钥 / agent 都没填），连接会报「缺少凭据」。',
        'settings.testUsedSaved': '（本次测试使用了已保存的密码）',
        'settings.testHint': '用上面的配置测试连接；留空的密码/私钥/passphrase 会自动沿用已保存的值',
        'settings.testNeedsHost': '先填写主机地址才能测试',
        // 灰按钮必须能解释自己：用户「点了没反应」时唯一能拿到的线索就是 hover 提示。
        'settings.saveNeedsHost': '先填写主机地址才能保存',
        'settings.saveHint': '保存这台机器（留空的密码/私钥/passphrase 沿用已保存的值）',
        'settings.fwdNeedsPort': '先填写本地监听端口才能添加转发',
        'settings.fwdAddHint': '添加一条端口转发',
        'settings.advCollapse': '▲ 收起高级配置',
        'settings.advExpand': '▼ 高级配置（私钥 / 跳板机 / agent 等）',
        'settings.privateKey': '私钥路径',
        'settings.passphrase': 'Passphrase',
        'settings.workspace': '默认工作区',
        'settings.hostKeyMode': 'HostKey 模式',
        'settings.hkDefault': '（默认 accept-new）',
        'settings.hkAccept': 'accept-new（信任首次，之后校验）',
        'settings.hkVerify': 'verify（严格：拒绝陌生主机）',
        'settings.hkOff': 'off（不校验，不推荐）',
        'settings.agent': 'SSH agent（SSH_AUTH_SOCK）',
        'settings.keyboardInteractive': 'keyboard-interactive（OTP/动态码）',
        'settings.encryptPassword': '加密保存密码（系统钥匙串）',
        'settings.proxyHost': '跳板机',
        'settings.proxyPortUser': '端口/用户',
        'settings.proxyKey': '跳板私钥',
        'settings.cancelEdit': '取消编辑',
        'settings.clear': '清空',
        'settings.testing': '连接中…',
        'settings.testOk': '✓ 连接成功',
        'settings.testConn': '测试连接',
        'settings.saving': '保存中…',
        'settings.save': '保存',
        'settings.forwards': '端口转发（SSH 隧道）',
        'settings.fwdStop': '停止',
        'settings.fwdStart': '启动',
        'settings.fwdRemove': '删除',
        'settings.fwdDirLocal': '本地→远端',
        'settings.fwdDirReverse': '远端→本地',
        'settings.fwdListen': '监听端口',
        'settings.fwdTargetHost': '目标主机',
        'settings.fwdTargetPort': '目标端口',
        'settings.fwdAuto': '自动重连',
        'settings.fwdAdd': '添加转发',
        'settings.audit': '最近执行的远程命令（审计日志）',
        'settings.auditEmpty': '暂无记录（在远端执行的命令会记录到 $DSH_HOME/remote-workspaces/audit.log）',
        'settings.auditRefresh': '刷新日志',
        'settings.auditOpen': '打开日志文件',
        'settings.auditReveal': '在文件夹中显示',
        'settings.auditOpenHint': '用本机默认程序打开审计日志文件（日志在运行 DSH 的这台机器上）',
        'settings.auditRevealHint': '在本机文件管理器里定位这个日志文件',
        'settings.auditOpened': '已打开：{file}',
        'settings.auditRevealed': '已在文件管理器中定位：{file}',
        'settings.auditOpenFailed': '无法自动打开（{msg}）——可以直接复制上面的路径自己打开。',
        'settings.badgePwd': '密码',
        'settings.badgeKeychain': '钥匙串',
        'settings.badgeProxy': '跳板',
        'settings.sectionHide': '收起此栏',
        'settings.sectionShow': '展开此栏',
        'settings.checking': '检查中…',
        'settings.checkUpdate': '检查更新',
        'settings.deleted': '已删除',
        'settings.saved': '已保存更新',
        'settings.rebound': '已将 {n} 个本地工作区镜像重新绑定到新地址（内容保留，无需重新同步）',
        'settings.added': '已添加 — 可设为当前',
        'settings.secretStoreFailed': '密码未能写入系统密钥库（{msg}），已按 credentialFallback=plain 回退为明文保存在 machines.json。',
        'settings.secretStoreRefused': '密码未能写入系统密钥库（{msg}），已放弃保存该密码（不会以明文落盘）。修复密钥库后重新保存，或把 credentialFallback 设为 plain 以接受明文回退。',
        'settings.cleared': '已取消当前远程机 — 本地会话不再自动使用远程上下文',
        'settings.connOk': '连接成功',
        'settings.connOkWith': '连接成功（{user}@{host}，{latency}ms）{shell}',
        'settings.connFail': '连接失败',
        'settings.shellWin': '（Windows · Git Bash）',
        'settings.shellWinNoGit': '（Windows · 未找到 Git Bash）',
        'settings.shellPosix': '（POSIX）',
        'settings.deleteConfirm': '确定删除这台机器？',
        'settings.delFail': '删除失败: {msg}',
        'settings.addFail': '保存失败: {msg}',
        'picker.title': '选择工作目录',
        'picker.close': '关闭 ✕',
        'picker.tabLocal': '本机',
        'picker.tabRemote': '远程',
        'picker.localIntro': '弹出系统文件夹对话框选择；不可用时用内置目录浏览，也可直接输入本机目录。',
        'picker.localPlaceholder': '本机目录，如 C:\\Users\\you\\project',
        'picker.useLocalPath': '选用此本地路径',
        'picker.openSysPicker': '打开系统文件夹选择器',
        'picker.opening': '打开中…',
        'picker.remoteMachine': '远程机器:',
        'picker.chooseMachine': '— 选择机器 —',
        'picker.noMachines': '还没有机器，请先在设置里添加',
        'picker.recent': '最近:',
        'picker.pathPlaceholder': '输入远程路径（自动补全）',
        'picker.pathPlaceholderWin': '输入远程路径，如 C:\\Users\\…（自动补全）',
        'picker.chooseMachineFirst': '先选远程机器',
        'picker.browse': '浏览…',
        'picker.home': '~ 主目录',
        'picker.setRemoteWs': '设为远程工作区',
        'picker.mirroring': '镜像中…',
        'picker.cancel': '取消',
        'confirm.title': '请确认',
        'picker.selectDir': '选择工作目录',
        'picker.selected': '所选: {path}',
        'picker.driveRoot': '（驱动器根）',
        'picker.emptyDir': '（空目录）',
        'picker.loading': '加载中…',
        'picker.readingRoot': '正在读取根目录…',
        'picker.back': '回上一级 ▴',
        'picker.closeBtn': '关闭 ✕',
        'picker.newDir': '新建目录',
        'picker.newFolder': '新建文件夹',
        'picker.create': '新建',
        'picker.chooseThis': '选用此路径',
        'picker.enterDir': '进入 {name}',
        'picker.enterDrive': '进入驱动器 {name}',
        'picker.fileAt': '文件: {name}',
        'picker.cancelled': '已取消选择',
        'picker.noSysPicker': '无法打开系统文件夹选择器，可直接在输入框填本地路径',
        'picker.timeout': '目录选择已超时，请重试或直接在输入框填本地路径',
        'picker.pickerBinNotFound': '未找到目录选择器程序',
        'picker.noSysPickerHost': '当前系统不支持自动打开目录选择器，请在输入框直接填本地路径',
        'picker.noHomeWin': 'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径',
        'picker.typePath': ' — 可直接在输入框填本地路径',
        'picker.noHome': '无法解析主目录',
        'picker.newDirName': '新建目录名（在 {path} 下）',
        'picker.noSubdir': '（没有子目录 — 可直接选用当前目录）',
        'picker.truncated': '（条目过多已截断）',
        'picker.thisPc': '此电脑',
        'picker.chooseDrive': ' 选择驱动器',
        'picker.homeBtn': '🏠',
        'picker.goHome': '回家目录',
        'picker.hintKeys': 'Enter 确认 · Esc 关闭 · Ctrl/⌘+Enter 设为工作区',
        'explorer.refresh': '刷新',
        'explorer.newDir': '新建目录',
        'explorer.more': '…',
        'explorer.remoteWs': '远程工作区: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': '未设置远程工作区',
        'explorer.sessionLocal': '当前会话未使用远程工作区',
        'explorer.localSession': '当前会话是本地工作区，未使用远程文件。\n\n如需访问远程，可在设置页将某台机器「设为当前」，再用上方「…」选择远程工作区。',
        // issue #49：会话列表里标识「这是远程会话，连的是哪台机」
        'session.remoteBadge': '远程会话：{target}',
        'session.remoteHover': '远程主机：{target}',
        'explorer.loading': '加载中…',
        'explorer.dirMissing': '目录不存在或已被删除',
        'explorer.notConnected': '未连接远程主机（重启后需在设置中将机器「设为当前」，或刷新右侧列）',
        'explorer.softError': '⚠ {msg}（显示缓存，可点 ↻ 刷新）',
        'explorer.busy': '处理中… ',
        'explorer.menuExpand': '📂 展开/收起',
        'explorer.menuOpen': '📄 打开文件',
        'explorer.menuDownload': '⬇ 下载到本地镜像',
        'explorer.menuCopyRel': '📋 复制相对地址',
        'explorer.menuCopyAbs': '📋 复制绝对地址',
        'explorer.menuRename': '✏ 重命名',
        'explorer.menuDelete': '🗑 删除',
        'explorer.menuDeleteDir': '🗑 删除（含子目录）',
        'explorer.renamePrompt': '重命名为（新名字）',
        'explorer.renameTitle': '重命名',
        'explorer.mkdirTitle': '新建目录',
        'explorer.namePlaceholder': '名称',
        'explorer.deleteConfirm': '确认删除 {path}？',
        'explorer.copied': '已复制',
        'explorer.tabTitle': '远程文件',
        'file.readonly': '只读',
        'file.editing': '编辑中',
        'file.saveToRemote': '保存到远程',
        'file.saving': '保存中…',
        'file.cancel': '取消',
        'file.edit': '编辑',
        'file.download': '下载',
        'file.loading': '加载中…',
        'file.binary': '二进制文件 ({size}) — 请用「下载」或 rw_download / 本地镜像查看。',
        'file.unknownSize': '未知大小',
        'file.empty': '（空文件）',
        'file.truncated': '… 内容已截断（只读远程查看，完整文件请用 rw_read_file / 下载）',
        'file.conflict': '远端文件已变化，请重新读取',
        'file.dirty': '未保存',
        'file.saveHint': 'Ctrl/⌘+S 保存',
        'file.downloaded': '已下载到本地镜像{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': '远程读取失败: {msg}',
        'file.listFail': '远程目录读取失败: {msg}',
        // Issue #55: a file link in a remote Session cannot be mapped onto the
        // remote host (no mirror for the Session's cwd), so say so instead of
        // rendering an empty editor.
        'file.linkUnresolved': '这个文件链接无法对应到远端路径（该会话的工作区不是一个远程镜像目录）。请用侧栏「远程文件」打开，或用 rw_read_file 读取。',
        'common.refresh': '刷新',
        'common.close': '关闭',
        'common.confirm': '确认',
      },
      en: {
        'mapping.servers': 'Remote servers',
        'mapping.title': 'Directory mappings',
        'mapping.server': 'Server',
        'mapping.add': 'Add mapping',
        'mapping.edit': 'Edit directory mapping',
        'mapping.remove': 'Unbind',
        'mapping.local': 'Local directory',
        'mapping.remote': 'Remote directory',
        'mapping.check': 'Map to an existing local directory',
        'mapping.typeLocal': 'Enter the absolute path of an existing local directory.',
        'mapping.noServers': 'Add a server to your SSH config, then save it here.',
        'mapping.missingServer': 'Server removed',
        'mapping.removeConfirm': 'Unbind the remote target for {local}?',
        'mapping.replace': 'Change the remote target for {local} from {old} to {next}?',
        'settings.title': 'Remote workspace (dsh-remote)',
        'settings.intro': 'Your ~/.ssh/config hosts are listed below: click Connect, then pick a remote folder. To add a host, click Open config, edit the file, then Refresh.',
        'settings.noMachines': 'No saved machines yet — the list above comes from ~/.ssh/config; click 连接 to use one.',
        'settings.pickHost': 'Choose a remote machine',
        'settings.hostListSource': 'from ~/.ssh/config',
        'settings.hostListLoading': 'Reading ~/.ssh/config…',
        'settings.hostListRefresh': 'Refresh',
        'settings.hostListRefreshHint': 'Re-read ~/.ssh/config (no need to reopen this page)',
        'settings.hostListEmpty': 'No hosts found in {file}. Add Host blocks, then hit Refresh.',
        'settings.hostListFailed': 'Could not read it: {msg}. This is NOT a problem with your ssh config (the file was never read) — hit Refresh; if it keeps failing the plugin versions are out of sync, so restart DSH.',
        'settings.hostConnect': 'Connect',
        'settings.hostConnecting': 'Connecting…',
        'settings.hostConnectHint': 'Connect and make it the current machine (then pick a remote folder)',
        'settings.hostConnected': 'Connected · {latency}',
        'settings.hostConnectedHint': 'Connected — pick the remote folder to start working.',
        'settings.openSshConfig': 'Open config',
        'settings.openSshConfigHint': 'Open ~/.ssh/config in your editor. Hit Refresh afterwards and the new Host shows up here.',
        'settings.sshConfigOpened': 'Opened: {file}',
        'settings.sshConfigOpenFailed': 'Could not open it automatically ({msg}) — edit this file yourself: {file}',
        'settings.badgeKey': 'key',
        'settings.openWorkspace': 'Folder',
        'settings.openWorkspaceHint': 'Pick a remote folder on this machine as the workspace',
        'settings.recentWorkspacesFor': 'Recent folders ({n})',
        'settings.recentWorkspacesHint': 'Remote folders this machine used before — open one directly',
        'settings.openWorkspaceHere': 'Open',
        'settings.openWorkspaceOnHint': 'Open this folder on {host} (creates or reuses the local mirror)',
        'settings.workspaceOpened': 'Opened remote workspace: {path}',
        'settings.hostFilter': 'Search hosts (name / address / user)',
        'settings.liveNow': 'Connected',
        'settings.lastConn': 'Last connected {when}{ms}',
        'settings.agoJustNow': 'just now',
        'settings.agoMinutes': '{n} min ago',
        'settings.agoHours': '{n} h ago',
        'settings.agoDays': '{n} d ago',
        'settings.current': 'current',
        'settings.edit': 'Edit',
        'settings.delete': 'Delete',
        'settings.currentMachine': 'Current remote: {name}',
        'settings.clearCurrent': 'Clear current (active remote = none)',
        'settings.noActive': 'No active remote machine: saved machines are standby connections and never enter a session context automatically (local sessions are unaffected).',
        'settings.editMachine': 'Edit machine',
        'settings.badgeSshConfig': 'ssh cfg',
        // Issue #51 — transport backend (GSSAPI/Kerberos via system OpenSSH).
        'settings.badgeOpenssh': 'openssh',
        'settings.backend': 'Backend',
        'settings.backendNative': 'native (built-in ssh2: password / key / agent / OTP)',
        'settings.backendOpenssh': 'openssh (drive the local ssh command)',
        'settings.backendOpensshHint': 'Delegates the transport to the local `ssh`, so the whole of ~/.ssh/config applies: GSSAPI/Kerberos (log in once with kinit and no secret is needed), ProxyCommand, PKCS11Provider, Match blocks… Host keys are checked by ssh against your own known_hosts. The cost is a fresh connection per command (slower than native); file browsing over SFTP still reuses one session.',
        'settings.backendOpensshAliasOk': '"Use a ~/.ssh/config alias" is on: the name is handed to ssh verbatim, and Port/User/IdentityFile/ProxyJump come from that Host block — the matching fields below have no effect (this is the "one source of truth" case, issue #50). A password/passphrase is still offered to ssh through askpass, and is only used if the Host block has no usable authentication.',
        'settings.sshBinary': 'ssh path',
        'settings.sshBinaryPlaceholder': 'Empty = the ssh on PATH',
        // Issue #54: the README documented `webAttachCommand` but the settings
        // UI had no field for it.
        'settings.sshImport': 'Import from ~/.ssh/config',
        'settings.useSshConfig': 'Host name comes from ~/.ssh/config (put the Host name in 主机)',
        'settings.useSshConfigHint': 'Connecting follows that Host block in ~/.ssh/config (user / port / key / jump host are read from the file, so editing it takes effect). Leave the other fields empty.',
        'settings.saveWritesSshConfig': 'Saving writes host/user/port/key into a managed block in ~/.ssh/config (marked # dsh-remote: managed); the file then takes precedence — edit it directly and it takes effect at once.',
        'settings.sshResolvedTo': '→ {user}@{host}:{port}',
        'settings.sshResolvedNone': 'no ~/.ssh/config block matches "{alias}"',
        'settings.sshResolvedWarn': 'Heads-up: {msg}',
        'settings.sshAliasSaved': 'Saved as an alias (resolved on connect)',
        'settings.name': 'Name',
        'settings.host': 'Host',
        'settings.port': 'Port',
        'settings.user': 'User',
        'settings.password': 'Password',
        'settings.passwordPlaceholder': 'SSH password (hidden; leave blank if unused)',
        'settings.secretSavedPlaceholder': '•••••••••••• (saved — leave blank to keep)',
        'settings.secretSavedHint': 'A password is saved (••••••••••••) and is never echoed back for safety: leave the box empty to keep it, type a new value to replace it.',
        'settings.passphraseSavedHint': 'A private-key passphrase is saved (••••••••••••): leave the box empty to keep it, type a new value to replace it.',
        'settings.proxyPwdSavedHint': 'A jump-host password is saved (••••••••••••): leave the box empty to keep it, type a new value to replace it.',
        'settings.noCredentialHint': '⚠️ This machine has no credential yet (no password, private key or agent) — connecting will fail with "no credentials".',
        'settings.testUsedSaved': '(this test used the saved password)',
        'settings.testHint': 'Probe with the values above; a blank password/key/passphrase falls back to the saved one',
        'settings.testNeedsHost': 'Fill in the host before testing',
        'settings.saveNeedsHost': 'Fill in the host before saving',
        'settings.saveHint': 'Save this machine (a blank password/key/passphrase keeps the saved one)',
        'settings.fwdNeedsPort': 'Fill in the local listen port before adding a forward',
        'settings.fwdAddHint': 'Add a port forward',
        'settings.advCollapse': '▲ Collapse advanced config',
        'settings.advExpand': '▼ Advanced (private key / proxy jump / agent, etc.)',
        'settings.privateKey': 'Private key path',
        'settings.passphrase': 'Passphrase',
        'settings.workspace': 'Default workspace',
        'settings.hostKeyMode': 'HostKey mode',
        'settings.hkDefault': '（default accept-new）',
        'settings.hkAccept': 'accept-new (trust first, verify later)',
        'settings.hkVerify': 'verify (strict: reject unknown hosts)',
        'settings.hkOff': 'off (no verification, not recommended)',
        'settings.agent': 'SSH agent (SSH_AUTH_SOCK)',
        'settings.keyboardInteractive': 'keyboard-interactive (OTP / dynamic code)',
        'settings.encryptPassword': 'Encrypt saved password (system keychain)',
        'settings.proxyHost': 'Proxy jump host',
        'settings.proxyPortUser': 'Port / user',
        'settings.proxyKey': 'Proxy jump private key',
        'settings.cancelEdit': 'Cancel edit',
        'settings.clear': 'Clear',
        'settings.testing': 'Connecting…',
        'settings.testOk': '✓ Connected',
        'settings.testConn': 'Test connection',
        'settings.saving': 'Saving…',
        'settings.save': 'Save',
        'settings.forwards': 'Port forwarding (SSH tunnels)',
        'settings.fwdStop': 'Stop',
        'settings.fwdStart': 'Start',
        'settings.fwdRemove': 'Remove',
        'settings.fwdDirLocal': 'Local → remote',
        'settings.fwdDirReverse': 'Remote → local',
        'settings.fwdListen': 'Listen port',
        'settings.fwdTargetHost': 'Target host',
        'settings.fwdTargetPort': 'Target port',
        'settings.fwdAuto': 'Auto reconnect',
        'settings.fwdAdd': 'Add forward',
        'settings.audit': 'Recent remote commands (audit log)',
        'settings.auditEmpty': 'No records yet (commands run remotely are logged to $DSH_HOME/remote-workspaces/audit.log)',
        'settings.auditRefresh': 'Refresh log',
        'settings.auditOpen': 'Open log file',
        'settings.auditReveal': 'Show in folder',
        'settings.auditOpenHint': 'Open the audit log with the host machine default application (the log lives on the machine running DSH)',
        'settings.auditRevealHint': 'Reveal this log file in the host file manager',
        'settings.auditOpened': 'Opened: {file}',
        'settings.auditRevealed': 'Revealed in the file manager: {file}',
        'settings.auditOpenFailed': 'Could not open it automatically ({msg}) — copy the path above and open it yourself.',
        'settings.badgePwd': 'password',
        'settings.badgeKeychain': 'keychain',
        'settings.badgeProxy': 'jump',
        'settings.sectionHide': 'Collapse section',
        'settings.sectionShow': 'Expand section',
        'settings.checking': 'Checking…',
        'settings.checkUpdate': 'Check for updates',
        'settings.deleted': 'Deleted',
        'settings.saved': 'Saved',
        'settings.rebound': 'Rebound {n} local workspace mirror(s) to the new address (content kept — no re-sync needed)',
        'settings.added': 'Added — you can set it as current',
        'settings.secretStoreFailed': 'The OS keychain refused the password ({msg}); credentialFallback=plain wrote it to machines.json in plaintext.',
        'settings.secretStoreRefused': 'The OS keychain refused the password ({msg}); the password was NOT saved (it will not be written to disk in plaintext). Repair the keychain and save again, or set credentialFallback to plain to accept the plaintext fallback.',
        'settings.cleared': 'Cleared current remote — local sessions no longer use remote context automatically',
        'settings.connOk': 'Connection successful',
        'settings.connOkWith': 'Connection successful ({user}@{host}, {latency}ms){shell}',
        'settings.connFail': 'Connection failed',
        'settings.shellWin': ' (Windows · Git Bash)',
        'settings.shellWinNoGit': ' (Windows · no Git Bash found)',
        'settings.shellPosix': ' (POSIX)',
        'settings.deleteConfirm': 'Delete this machine?',
        'settings.delFail': 'Delete failed: {msg}',
        'settings.addFail': 'Save failed: {msg}',
        'picker.title': 'Select working directory',
        'picker.close': 'Close ✕',
        'picker.tabLocal': 'Local',
        'picker.tabRemote': 'Remote',
        'picker.localIntro': 'Opens the system folder dialog; when unavailable, uses the built-in directory browser. You can also type a local path directly.',
        'picker.localPlaceholder': 'Local directory, e.g. C:\\Users\\you\\project',
        'picker.useLocalPath': 'Use this local path',
        'picker.openSysPicker': 'Open system folder picker',
        'picker.opening': 'Opening…',
        'picker.remoteMachine': 'Remote machine:',
        'picker.chooseMachine': '— choose a machine —',
        'picker.noMachines': 'No machines yet — add one in Settings first',
        'picker.recent': 'Recent:',
        'picker.pathPlaceholder': 'Enter remote path (auto-complete)',
        'picker.pathPlaceholderWin': 'Enter remote path, e.g. C:\\Users\\… (auto-complete)',
        'picker.chooseMachineFirst': 'Choose a remote machine first',
        'picker.browse': 'Browse…',
        'picker.home': '~ Home',
        'picker.setRemoteWs': 'Set as remote workspace',
        'picker.mirroring': 'Mirroring…',
        'picker.cancel': 'Cancel',
        'confirm.title': 'Please confirm',
        'picker.selectDir': 'Select working directory',
        'picker.selected': 'Selected: {path}',
        'picker.driveRoot': ' (drive root)',
        'picker.emptyDir': ' (empty directory)',
        'picker.loading': 'Loading…',
        'picker.readingRoot': 'Reading root directory…',
        'picker.back': 'Back ▴',
        'picker.closeBtn': 'Close ✕',
        'picker.newDir': 'New directory',
        'picker.newFolder': 'New folder',
        'picker.create': 'Create',
        'picker.chooseThis': 'Use this path',
        'picker.enterDir': 'Enter {name}',
        'picker.enterDrive': 'Enter drive {name}',
        'picker.fileAt': 'File: {name}',
        'picker.cancelled': 'Selection cancelled',
        'picker.noSysPicker': 'Cannot open the system folder picker — you can type a local path in the input box',
        'picker.timeout': 'Directory selection timed out — retry or type a local path directly',
        'picker.pickerBinNotFound': 'Directory picker program not found',
        'picker.noSysPickerHost': 'This system cannot auto-open a directory picker — type a local path in the input box',
        'picker.noHomeWin': 'Windows remotes do not support ~ resolution — enter an absolute path',
        'picker.typePath': ' — type a local path in the input box instead',
        'picker.noHome': 'Cannot resolve home directory',
        'picker.newDirName': 'New directory name (under {path})',
        'picker.noSubdir': ' (no subdirectories — you can use the current directory)',
        'picker.truncated': ' (too many entries, truncated)',
        'picker.thisPc': 'This PC',
        'picker.chooseDrive': ' choose a drive',
        'picker.homeBtn': '🏠',
        'picker.goHome': 'Go to home',
        'picker.hintKeys': 'Enter confirms · Esc closes · Ctrl/⌘+Enter sets workspace',
        'explorer.refresh': 'Refresh',
        'explorer.newDir': 'New directory',
        'explorer.more': '…',
        'explorer.remoteWs': 'Remote workspace: {path}{host}',
        'explorer.hostTag': '  ({user}@{host})',
        'explorer.noRemoteWs': 'No remote workspace set',
        'explorer.sessionLocal': 'This session does not use a remote workspace',
        'explorer.localSession': 'This session is a local workspace and does not use remote files.\n\nTo access remote, set a machine as "current" in Settings, then pick a remote workspace with the "…" button above.',
        // issue #49: tell a remote Session apart in the Session list, and name its host.
        'session.remoteBadge': 'Remote session: {target}',
        'session.remoteHover': 'Remote host: {target}',
        'explorer.loading': 'Loading…',
        'explorer.dirMissing': 'Directory does not exist or was deleted',
        'explorer.notConnected': 'Not connected to the remote host (after a restart, set a machine as "current" in Settings, or refresh the right column)',
        'explorer.softError': '⚠ {msg} (showing cache, click ↻ to refresh)',
        'explorer.busy': 'Processing… ',
        'explorer.menuExpand': '📂 Expand/collapse',
        'explorer.menuOpen': '📄 Open file',
        'explorer.menuDownload': '⬇ Download to local mirror',
        'explorer.menuCopyRel': '📋 Copy relative path',
        'explorer.menuCopyAbs': '📋 Copy absolute path',
        'explorer.menuRename': '✏ Rename',
        'explorer.menuDelete': '🗑 Delete',
        'explorer.menuDeleteDir': '🗑 Delete (with contents)',
        'explorer.renamePrompt': 'Rename to (new name)',
        'explorer.renameTitle': 'Rename',
        'explorer.mkdirTitle': 'New directory',
        'explorer.namePlaceholder': 'Name',
        'explorer.deleteConfirm': 'Delete {path}?',
        'explorer.copied': 'Copied',
        'explorer.tabTitle': 'Remote Files',
        'file.readonly': 'read-only',
        'file.editing': 'editing',
        'file.saveToRemote': 'Save to remote',
        'file.saving': 'Saving…',
        'file.cancel': 'Cancel',
        'file.edit': 'Edit',
        'file.download': 'Download',
        'file.loading': 'Loading…',
        'file.binary': 'Binary file ({size}) — use "Download", rw_download or the local mirror to view.',
        'file.unknownSize': 'unknown size',
        'file.empty': ' (empty file)',
        'file.truncated': '… content truncated (read-only remote view; use rw_read_file / Download for the full file)',
        'file.conflict': 'The remote file changed, please re-read it',
        'file.dirty': 'unsaved',
        'file.saveHint': 'Ctrl/⌘+S to save',
        'file.downloaded': 'Downloaded to local mirror{local}',
        'file.downloadedAt': ': {path}',
        'file.readFail': 'Failed to read remote: {msg}',
        'file.listFail': 'Failed to list remote directory: {msg}',
        'file.linkUnresolved': 'This file link does not map onto a remote path (the Session workspace is not a remote mirror directory). Open it from the sidebar "Remote Files" tab, or read it with rw_read_file.',
        'common.refresh': 'Refresh',
        'common.close': 'Close',
        'common.confirm': 'Confirm',
      },
    }

    // Active dictionary: resolved from the DSH locale service when available
    // (its active locale + en fallback), else from the browser language, else en.
    let ACTIVE_LANG = 'en'
    try {
      const nav = (typeof navigator !== 'undefined' && navigator.languages) ? navigator.languages : (typeof navigator !== 'undefined' ? [navigator.language] : [])
      for (const tag of nav) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh') { ACTIVE_LANG = 'zh'; break }
        if (primary === 'en') { ACTIVE_LANG = 'en'; break }
      }
    } catch { /* keep en */ }

    // The DSH locale service binds a translate thunk; we call it first and fall
    // back to our own dictionary so missing keys never blank the UI.
    function makeTr() {
      const dict = L[ACTIVE_LANG] || L.en
      return (key, params) => {
        let text = dict[key]
        if (text === undefined && ACTIVE_LANG !== 'en') text = L.en[key]
        if (text === undefined) text = key
        if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
        return text
      }
    }
    let tr = makeTr()
    // Called from apply() once the real locale service is reachable; registers
    // both dictionaries and rebinds tr so live locale switches take effect.
    function wireLocale(ctx) {
      try {
        const locale = ctx && ctx.get && ctx.get('locale')
        if (!locale || typeof locale.register !== 'function') return
        const dispose = locale.register(NS, { zh: L.zh, en: L.en })
        const bound = locale.bind(NS)
        tr = (key, params) => {
          let text = bound(key, params)
          if (text === key) {
            const d = L[ACTIVE_LANG] || L.en
            text = d[key] !== undefined ? d[key] : L.en[key]
            if (text === undefined) text = key
            if (params) text = String(text).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m))
          }
          return text
        }
        if (ctx.effect) ctx.effect(() => dispose, 'dsh-remote.locale')
      } catch (e) { /* keep local dict fallback */ }
    }

    // Known host-side error messages (lib/index.js) are Chinese. Map them to
    // dictionary keys so non-zh locales see localized errors instead of raw
    // zh text. Unknown / server-generated messages pass through untouched.
    const HOST_ERROR_KEYS = {
      '目录选择已超时，请重试或直接在输入框填本地路径': 'picker.timeout',
      '无法打开系统文件夹选择器': 'picker.noSysPicker',
      '当前系统不支持自动打开目录选择器，请在输入框直接填本地路径': 'picker.noSysPickerHost',
      'Windows 远程暂不支持 ~ 解析，请直接输入绝对路径': 'picker.noHomeWin',
      '无法连接 npm registry': 'settings.registryUnreachable',
    }
    const HOST_ERROR_PREFIX = [
      ['未找到目录选择器程序', 'picker.pickerBinNotFound'],
    ]
    const HOST_ERROR_SUFFIX = [
      [' — 可直接在输入框填本地路径', 'picker.typePath'],
    ]
    function trHostError(msg) {
      if (!msg || ACTIVE_LANG === 'zh') return msg
      if (HOST_ERROR_KEYS[msg]) return tr(HOST_ERROR_KEYS[msg])
      for (const [prefix, key] of HOST_ERROR_PREFIX) {
        if (msg.startsWith(prefix)) {
          const en = L.en[key]
          if (en !== undefined) return en + msg.slice(prefix.length)
        }
      }
      for (const [suffix, key] of HOST_ERROR_SUFFIX) {
        if (msg.endsWith(suffix)) {
          const en = L.en[key]
          if (en !== undefined) return msg.slice(0, -suffix.length) + en
        }
      }
      return msg
    }

    // The official Electron shell serves the shared API over its private
    // dsh-app carrier. Legacy browser hosts keep their existing route prefix.
    // Choose before sending: never retry a mutating request on another route.
    function apiPath(path) {
      return window.location && window.location.protocol === 'dsh-app:'
        ? '/api' + path : path
    }

    function sessionQuery(sessionId) {
      return sessionId ? 'sessionId=' + encodeURIComponent(sessionId) : ''
    }
    function withSessionQuery(path, sessionId) {
      const q = sessionQuery(sessionId)
      if (!q) return path
      return path + (path.includes('?') ? '&' : '?') + q
    }
    function withSessionBody(body, sessionId) {
      if (!sessionId) return body
      return Object.assign({}, body || {}, { sessionId })
    }

    async function api(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(apiPath(path), opts)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(trHostError((data && (data.error || data.message))) || 'HTTP ' + res.status)
      return data
    }

    // Like api() but returns {status, data} so callers can handle 409 etc.
    async function apiRaw(method, path, body) {
      const opts = { method, headers: {} }
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
      const res = await fetch(apiPath(path), opts)
      const data = await res.json().catch(() => ({}))
      if (data && typeof data.error === 'string') data.error = trHostError(data.error)
      if (data && typeof data.message === 'string') data.message = trHostError(data.message)
      return { status: res.status, data }
    }

    // Theme via DSH design tokens so this follows the harness light/dark theme.
    const v = (name, fb) => `var(${name}, ${fb})`
    const T = {
      bg: v('--dsw-alias-bg-layer-1', 'rgba(128,128,128,0.07)'),
      bg2: v('--dsw-alias-interactive-bg-hover', 'rgba(128,128,128,0.10)'),
      border: v('--dsw-alias-border-l2', 'rgba(128,128,128,0.35)'),
      borderStrong: v('--dsw-alias-border-l3', 'rgba(128,128,128,0.5)'),
      danger: v('--dsw-static-red-500', '#e06c75'),
      dangerText: v('--dsw-static-red-400', '#e06c75'),
      ok: v('--dsw-static-green-500', '#4caf7d'),
      warn: v('--dsw-static-yellow-500', '#e6c07b'),
      radius: 8,
      muted: v('--dsw-alias-label-tertiary', 'rgba(128,128,128,0.7)'),
      label: v('--dsw-alias-label-primary', '#e4e4e7'),
      primary: v('--dsw-alias-button-primary-fill', '#2563eb'),
      // Text ON a --dsw-alias-button-primary-fill surface must use the *label*
      // token, which is the pairing the harness's own primary button uses
      // (._primary{background:button-primary-fill;color:label-primary-foreground}).
      // --dsw-alias-button-contrast-fill is a FILL token (the harness uses it as a
      // `background`), so it is NOT the light-on-dark colour: in the light theme it
      // is #61666b (gray on #0f1115 = 3.3:1, and 1.6:1 once :disabled fades it),
      // and in the dark theme it collapses to #f9fafb on a #f9fafb fill (invisible).
      onPrimary: v('--dsw-alias-label-primary-foreground', '#fff'),
      // Hover tints are a neutral translucent gray rather than a theme token:
      // the harness's own interactive-bg-hover is a 6% tint that disappears on
      // the settings surface, while a gray overlay darkens light themes and
      // lightens dark ones.
      hoverBg: 'rgba(128,128,128,0.14)',
    }
    const inputS = { flex: 1, padding: '6px 10px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, outline: 'none' }
    const buttonS = { padding: '6px 12px', borderRadius: T.radius, border: '1px solid ' + T.border, background: T.bg, color: T.label, cursor: 'pointer' }
    const primaryBtnS = { padding: '6px 12px', borderRadius: T.radius, border: 'none', background: T.primary, color: T.onPrimary, cursor: 'pointer', fontWeight: 600 }
    const box = { border: '1px solid ' + T.border, borderRadius: 10, background: T.bg, padding: 12 }
    const boxS = box
    const LABEL_W = 108
    const CHROME_CSS_ID = 'dsh-remote-chrome'
    function ensureChromeCss() {
      try {
        if (typeof document === 'undefined' || !document.head || typeof document.getElementById !== 'function') return
        if (document.getElementById(CHROME_CSS_ID)) return
        const el = document.createElement('style')
        el.id = CHROME_CSS_ID
        el.textContent = [
          '.dsh-rw-btn{transition:background .12s ease,opacity .12s ease,border-color .12s ease}',
          '.dsh-rw-btn:hover:not(:disabled){background:rgba(128,128,128,.18)}',
          '.dsh-rw-btn:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#2563eb);outline-offset:1px}',
          // A disabled FILLED primary keeps its solid fill. Fading the whole
          // button (opacity) turned the near-black primary fill into a muddy
          // gray and dragged the white label down to ~1.5:1 — the fill is the
          // affordance here, so keep it pure; the cursor carries "disabled".
          '.dsh-rw-btn:disabled{cursor:not-allowed}',
          '.dsh-rw-btn:disabled:not(.dsh-rw-primary){opacity:.45}',
          // A filled primary keeps its own fill on hover; opacity is the only
          // cue that stays visible whether that fill is near-black or near-white.
          '.dsh-rw-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,#2563eb);opacity:.85}',
          '.dsh-rw-input{transition:border-color .12s ease,box-shadow .12s ease}',
          '.dsh-rw-input:focus{border-color:var(--dsw-alias-button-primary-fill,#2563eb)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-button-primary-fill,#2563eb) 28%,transparent)}',
          '.dsh-rw-row{border-radius:8px;margin:0 -6px;padding-left:8px;padding-right:8px;transition:background .12s ease}',
          '.dsh-rw-row:hover{background:rgba(128,128,128,.14)}',
          '.dsh-rw-list-item{transition:background .1s ease}',
          '.dsh-rw-list-item:hover{background:rgba(128,128,128,.18)}',
          '.dsh-rw-tabs{display:inline-flex;padding:3px;gap:2px;border-radius:10px;background:rgba(128,128,128,.14);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))}',
          '.dsh-rw-tab{border:none!important;background:transparent!important}',
          '.dsh-rw-tab.is-active{background:var(--dsw-alias-button-primary-fill,#2563eb)!important;color:var(--dsw-alias-label-primary-foreground,#fff)!important;font-weight:600}',
          '.dsh-rw-pill{display:inline-flex;align-items:center;font-size:11px;line-height:1.3;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));opacity:.9;white-space:nowrap}',
          '.dsh-rw-pill.is-ok{color:var(--dsw-static-green-500,#4caf7d);border-color:currentColor}',
          '.dsh-rw-section-btn{width:100%;text-align:left;display:flex;align-items:center;gap:8px;background:transparent;border:none;cursor:pointer;padding:0;color:inherit}',
          '@keyframes dsh-rw-in{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',
          '.dsh-rw-modal-panel{animation:dsh-rw-in .14s ease-out}',
        ].join('')
        document.head.appendChild(el)
      } catch { /* vm tests / no DOM */ }
    }
    /**
     * Issue #52 — a backdrop may close its dialog only when the PRESS began on
     * the backdrop itself.
     *
     * `click` is dispatched on the nearest common ancestor of the mousedown and
     * mouseup targets. A gesture that pressed an element INSIDE the panel and
     * released on the backdrop — because the panel re-laid-out mid-gesture (the
     * remote autocomplete list used to sit in document flow, so expanding it
     * pushed a centred panel's edges out from under the pointer) — is therefore
     * reported as a click ON THE BACKDROP, and a bare `onClick` closed the whole
     * dialog. Selecting a suggestion kicked the user out of the picker.
     *
     * Guarding on the press origin keeps "click outside to dismiss" while a
     * drag that merely ENDS outside can no longer dismiss anything. The panel's
     * own `stopPropagation` stays as a second line of defence.
     *
     * @returns {{onMouseDown: Function, onClick: (e: object) => boolean}} props to
     *   spread on the backdrop; `onClick` reports whether the press started there.
     */
    function useBackdropGuard() {
      const pressedOnBackdrop = React.useRef(false)
      return {
        onMouseDown: (e) => { pressedOnBackdrop.current = e.target === e.currentTarget },
        onClick: (e) => {
          const startedOnBackdrop = pressedOnBackdrop.current
          pressedOnBackdrop.current = false
          return startedOnBackdrop && e.target === e.currentTarget
        },
      }
    }

    function PromptDialog(props) {
      const { title, initial, placeholder, onSubmit, onCancel } = props
      const backdrop = useBackdropGuard()
      const [val, setVal] = React.useState(initial || '')
      const submit = () => { const t = val.trim(); if (t) onSubmit(t) }
      React.useEffect(() => {
        try {
          if (typeof document === 'undefined') return
          const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            if (e.key === 'Enter') { e.preventDefault(); submit() }
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        } catch { return undefined }
      }, [val, onSubmit, onCancel])
      // Host Modal when available: portal + focus trap + autofocus + restore +
      // IME-composition guard come from its useModalLayer; our document-level
      // Escape/Enter stays as the fallback path's key handling (harmless
      // duplication: Modal's layer preventDefaults first).
      if (Modal) {
        return React.createElement(Modal, {
          open: true,
          onClose: onCancel,
          title,
          closeLabel: tr('picker.close'),
          onKeyDownCapture: (e) => {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit() }
          },
        },
          React.createElement('input', { autoFocus: true, 'data-modal-autofocus': true, value: val, onChange: (e) => setVal(e.target.value), placeholder: placeholder || '', className: 'dsh-rw-input', style: inputS }),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 } },
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: onCancel }, tr('file.cancel')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: submit, disabled: !val.trim() }, tr('common.confirm')),
          ),
        )
      }
      return React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 1000000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onMouseDown: backdrop.onMouseDown,
        // Issue #52: only a press that STARTED here may dismiss (a gesture that
        // began inside the panel and ended on the backdrop must not).
        onClick: (e) => { if (backdrop.onClick(e)) onCancel() },
      },
        React.createElement('div', {
          className: 'dsh-rw-modal-panel',
          style: { background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 10, padding: 14, width: 'min(420px, 92vw)', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.4)' },
          onClick: (e) => e.stopPropagation(),
        },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, color: T.label } }, title),
          React.createElement('input', { autoFocus: true, value: val, onChange: (e) => setVal(e.target.value), placeholder: placeholder || '', className: 'dsh-rw-input', style: inputS }),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: onCancel }, tr('file.cancel')),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => { const t = val.trim(); if (t) onSubmit(t) }, disabled: !val.trim() }, tr('common.confirm')),
          ),
        ),
      )
    }

    /**
     * Themed confirm dialog. Uses the host Modal when the build ships one
     * (always portaled, focus trap, autofocus, focus restore, Escape, IME
     * guard); otherwise our own press-guarded portalized overlay. Either way it
     * replaces `window.confirm`, which is visually alien and may be suppressed
     * by embedders. Safe for Mask adoption here because the content never
     * re-lays-out mid-gesture (no autocomplete list — that is why the DIRECTORY
     * picker keeps its custom guarded overlay).
     */
    function ConfirmDialog(props) {
      const { message, onAnswer } = props
      const cancelBtn = React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: () => onAnswer(false) }, tr('file.cancel'))
      const okBtn = React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, 'data-modal-autofocus': true, onClick: () => onAnswer(true) }, tr('common.confirm'))
      if (Modal) {
        return React.createElement(Modal, {
          open: true,
          onClose: () => onAnswer(false),
          title: tr('confirm.title'),
          closeLabel: tr('picker.close'),
        },
          React.createElement('div', { style: { fontSize: 13, color: T.label, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: 'min(460px, 86vw)' } }, message),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 } }, cancelBtn, okBtn),
        )
      }
      const backdrop = useBackdropGuard()
      return portalize(React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 1000001, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onMouseDown: backdrop.onMouseDown,
        onClick: (e) => { if (backdrop.onClick(e)) onAnswer(false) },
      },
        React.createElement('div', { style: { background: v('--dsw-alias-bg-layer-1', '#18181b'), color: T.label, border: '1px solid ' + T.borderStrong, borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', padding: 16, maxWidth: 'min(460px, 86vw)' }, onClick: (e) => e.stopPropagation() },
          React.createElement('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 10 } }, tr('confirm.title')),
          React.createElement('div', { style: { fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, message),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 } }, cancelBtn, okBtn),
        ),
      ))
    }

    /** Promise-style confirm: `if (!(await confirm.ask(msg))) return`. Render
     * `confirm.node` anywhere in the component's tree. */
    function useConfirm() {
      const [req, setReq] = React.useState(null)
      const ask = React.useCallback((message) => new Promise((resolve) => setReq({ message, resolve })), [])
      const node = req
        ? React.createElement(ConfirmDialog, {
          message: req.message,
          onAnswer: (ok) => { setReq(null); req.resolve(ok) },
        })
        : null
      return { ask, node }
    }

    function humanSize(n) {
      if (n == null) return ''
      if (n < 1024) return n + ' B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let i = -1
      let v = n
      while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
      return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i]
    }
    function fmtTime(ts) {
      if (!ts) return ''
      const d = new Date(ts * 1000)
      const pad = (x) => String(x).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    // Write text to the clipboard. Order: the host primitive (its behavior is
    // the reference), then the async Clipboard API (works on http://127.0.0.1
    // secure contexts), then the legacy execCommand('copy') path.
    function copyToClipboard(text) {
      if (writeClipboardFn) {
        try { return Promise.resolve(writeClipboardFn(String(text))).then(() => true).catch(() => false) } catch { /* fall through to the manual paths */ }
      }
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = String(text)
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        return Promise.resolve(ok)
      } catch (e) {
        return Promise.resolve(false)
      }
    }

    let SESSIONS = null // optional sessions service, tracked by ctx.inject in apply()

    // ── Settings → 远程工作区 (machine registry + forwards + audit) ──────────
    const h = React.createElement
    const settingsButton = (label, onClick, disabled = false, primary = false) => h('button', {
      type: 'button', className: 'dsh-rw-btn', style: primary ? primaryBtnS : buttonS, onClick, disabled,
    }, label)

    function SettingsEditor({ title, close, children }) {
      const backdrop = useBackdropGuard()
      if (Modal) return h(Modal, { open: true, onClose: close, title, closeLabel: tr('picker.close') },
        h('div', { style: { width: 'min(590px, 75vw)', maxHeight: '65vh', overflowY: 'auto', padding: 2 } }, children))
      return portalize(h('div', {
        style: { position: 'fixed', inset: 0, zIndex: 1000000, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center' },
        onMouseDown: backdrop.onMouseDown,
        onClick: e => { if (backdrop.onClick(e)) close() },
      }, h('section', {
        role: 'dialog', 'aria-modal': true, 'aria-label': title,
        onKeyDown: e => { if (e.key === 'Escape') close() },
        style: { ...boxS, background: v('--dsw-alias-bg-layer-1', '#18181b'), color: T.label, width: 'min(610px, 90vw)', maxHeight: '85vh', overflowY: 'auto' },
      }, h('h3', null, title), children)))
    }

    function LocalMappingDirectory({ value, onChange, onError }) {
      const [picking, setPicking] = React.useState(false)
      const pick = async () => {
        setPicking(true)
        try {
          const result = await api('POST', '/dsh-remote/local-pick')
          if (result.path) onChange(String(result.path))
          else if (!result.cancelled || result.browse) onError(tr('mapping.typeLocal'))
        } catch (error) {
          onError(error.message)
        } finally {
          setPicking(false)
        }
      }
      return h('div', { style: { display: 'flex', flex: 1, gap: 6, minWidth: 0 } },
        h('input', { className: 'dsh-rw-input', style: { ...inputS, minWidth: 0 },
          'aria-label': tr('mapping.local'), placeholder: tr('picker.localPlaceholder'),
          value, onChange: e => onChange(e.target.value) }),
        settingsButton(picking ? tr('picker.opening') : tr('picker.browse'), pick, picking))
    }

    async function saveDirectoryMapping(input, confirm, machines) {
      const send = data => apiRaw('POST', '/dsh-remote/mappings', { ...data, action: 'save' })
      let result = await send(input)
      const old = result.data.conflict
      if (!input.id && result.status === 409 && old && result.data.replaceable) {
        const label = id => {
          const machine = machines.find(record => record.id === id)
          return machine?.name || machine?.host || id
        }
        if (!(await confirm(tr('mapping.replace', {
          local: old.localPath,
          old: label(old.machineId) + ' · ' + old.remotePath,
          next: label(input.machineId) + ' · ' + input.remotePath,
        })))) return null
        result = await send({ ...input, id: old.id, revision: old.revision })
      }
      if (!result.data.ok) throw new Error(result.data.error || 'HTTP ' + result.status)
      return result.data.mapping
    }

    function RemoteWorkspacePage() {
      const [machines, setMachines] = React.useState([])
      const [mappings, setMappings] = React.useState([])
      const [sshHosts, setSshHosts] = React.useState([])
      const [rowState, setRowState] = React.useState({})
      const [form, setForm] = React.useState(null)
      const [editMapping, setEditMapping] = React.useState(null)
      const [advOpen, setAdvOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [tst, setTst] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [err, setErr] = React.useState('')
      const confirmUi = useConfirm()

      const refresh = async () => {
        const result = await Promise.all([
          api('GET', '/dsh-remote/machines'),
          api('GET', '/dsh-remote/mappings'),
          api('GET', '/dsh-remote/ssh-config'),
        ])
        setMachines(result[0].machines || [])
        setMappings(result[1].mappings || [])
        setSshHosts(result[2].entries || [])
      }
      const reload = () => refresh().catch(error => setErr(error.message))
      React.useEffect(() => {
        ensureChromeCss()
        reload()
        window.addEventListener('focus', reload)
        return () => window.removeEventListener('focus', reload)
      }, [])

      const showServer = machine => {
        setErr(''); setMsg(''); setTst('')
        setAdvOpen(!!(machine.privateKeyPath || machine.useAgent || machine.proxy || machine.backend === 'openssh'))
        setForm({
          ...machine,
          name: machine.name || '', host: machine.host || '', port: String(machine.port || 22),
          username: machine.username || '', workspace: machine.workspace || '',
          privateKeyPath: machine.privateKeyPath || '', hostKeyMode: machine.hostKeyMode || '',
          password: '', passphrase: '', encryptPassword: !!(machine.credentialBackend && machine.credentialBackend !== 'plain'),
          proxyHost: machine.proxy?.host || '', proxyPort: String(machine.proxy?.port || 22),
          proxyUser: machine.proxy?.username || '', proxyPassword: '', proxyKey: machine.proxy?.privateKeyPath || '',
          proxyPasswordSet: !!machine.proxy?.passwordSet,
        })
      }
      const setF = key => event => setForm(previous => ({ ...previous, [key]: event.target.value }))
      const setFb = key => event => setForm(previous => ({ ...previous, [key]: event.target.checked }))
      const formPayload = () => {
        const { proxy, sshConfigResolved, connected, ...fields } = form
        return {
          ...fields, port: Number(form.port) || 22,
          proxy: form.proxyHost ? {
            host: form.proxyHost, port: Number(form.proxyPort) || 22,
            username: form.proxyUser, password: form.proxyPassword, privateKeyPath: form.proxyKey,
          } : null,
        }
      }
      const testConn = async () => {
        setTst('testing'); setErr(''); setMsg('')
        try {
          const result = await api('POST', '/dsh-remote/test-connect', formPayload())
          setTst('ok')
          setMsg(tr('settings.connOkWith', { user: result.user, host: result.host, latency: result.latencyMs, shell: '' }))
        } catch (error) {
          setTst('failing'); setErr(error.message)
        }
      }
      const testServer = async machine => {
        const key = machine.id || machine.host
        const setResult = value => setRowState(previous => ({ ...previous, [key]: value }))
        setResult({ busy: true })
        try {
          const result = await api('POST', '/dsh-remote/test-connect', {
            id: machine.id, host: machine.host, port: machine.port,
            username: machine.username, useSshConfig: !!machine.useSshConfig,
          })
          setResult({ text: tr('settings.connOkWith', { user: result.user, host: result.host, latency: result.latencyMs, shell: '' }) })
        } catch (error) {
          setResult({ text: error.message, failed: true })
        }
      }
      const saveServer = async () => {
        setBusy(true); setErr('')
        try {
          const result = await api('POST', '/dsh-remote/machines', { ...formPayload(), action: form.id ? 'update' : 'add' })
          setForm(null)
          await refresh()
          if (result.warning === 'secret-store-refused' || result.warning === 'secret-store-failed') {
            setErr(tr(result.warning === 'secret-store-refused' ? 'settings.secretStoreRefused' : 'settings.secretStoreFailed', { msg: result.warningDetail || '' }))
          }
        } catch (error) {
          setErr(error.message)
        } finally {
          setBusy(false)
        }
      }

      const showMapping = mapping => { setErr(''); setEditMapping(mapping) }
      const changeMapping = (key, value) => setEditMapping(previous => ({ ...previous, [key]: value }))
      const saveMapping = async () => {
        setBusy(true); setErr('')
        try {
          const saved = await saveDirectoryMapping(editMapping, confirmUi.ask, machines)
          if (!saved) return
          setEditMapping(null)
          await refresh()
        } catch (error) {
          setErr(error.message)
        } finally {
          setBusy(false)
        }
      }
      const removeMapping = async mapping => {
        if (!(await confirmUi.ask(tr('mapping.removeConfirm', { local: mapping.localPath })))) return
        setBusy(true); setErr('')
        try {
          await api('POST', '/dsh-remote/mappings', { action: 'remove', id: mapping.id, revision: mapping.revision })
          await refresh()
        } catch (error) {
          setErr(error.message)
        } finally {
          setBusy(false)
        }
      }

      const row = (label, ctrl, key) => h('label', { key, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
        h('span', { style: { width: LABEL_W, fontSize: 12, opacity: .8, flexShrink: 0 } }, label), ctrl)
      const banner = text => text ? h('p', { role: 'alert', style: { color: T.danger, overflowWrap: 'anywhere' } }, text) : null
      const closeServer = () => { if (!busy && tst !== 'testing') { setForm(null); setErr('') } }
      const closeMapping = () => { if (!busy) { setEditMapping(null); setErr('') } }
      const savedAliases = new Set(machines.filter(machine => machine.useSshConfig).map(machine => machine.host))
      const listed = [...machines, ...sshHosts.filter(host => !savedAliases.has(host.alias)).map(host => ({
        name: host.alias, host: host.alias, port: host.port, username: host.user, useSshConfig: true,
      }))]
      const groups = [...machines, ...[...new Set(mappings.map(mapping => mapping.machineId))]
        .filter(id => !machines.some(machine => machine.id === id))
        .map(id => ({ id, name: tr('mapping.missingServer'), missing: true }))]
      const rowStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0' }
      const footerStyle = { ...rowStyle, justifyContent: 'flex-end' }
      const pathStyle = { fontFamily: 'monospace', overflowWrap: 'anywhere', flex: '1 1 240px' }

      return h('div', { className: 'dsh-rw-settings', style: { display: 'grid', gap: 12 } },
        !form && !editMapping ? banner(err) : null,
        h('section', { style: boxS, 'aria-label': tr('mapping.servers') },
          h('div', { style: rowStyle },
            h('h3', { style: { flex: 1, margin: 0 } }, tr('mapping.servers')),
            settingsButton(tr('settings.openSshConfig'), async () => {
              try { await api('POST', '/dsh-remote/ssh-config', { action: 'open' }) } catch (error) { setErr(error.message) }
            }),
            settingsButton(tr('settings.hostListRefresh'), reload)),
          listed.length ? listed.map(machine => {
            const key = machine.id || machine.host
            const result = rowState[key]
            return h('div', { key, style: { ...rowStyle, borderTop: '1px solid ' + T.border } },
              h('strong', null, machine.name || machine.host),
              h('span', { style: pathStyle }, [machine.username, machine.host].filter(Boolean).join('@') + (machine.port ? ':' + machine.port : '')),
              settingsButton(tr('settings.edit'), () => showServer(machine)),
              settingsButton(result?.busy ? tr('settings.testing') : tr('settings.testConn'), () => testServer(machine), result?.busy),
              result?.text ? h('span', { role: 'status', style: { flexBasis: '100%', color: result.failed ? T.danger : T.ok } }, result.text) : null)
          }) : h('p', null, tr('mapping.noServers'))),
        h('section', { style: boxS, 'aria-label': tr('mapping.title') },
          h('h3', { style: { margin: '0 0 8px' } }, tr('mapping.title')),
          groups.length ? groups.map(server => {
            const entries = mappings.filter(mapping => mapping.machineId === server.id)
            return h('div', { key: server.id, style: { borderTop: '1px solid ' + T.border, padding: '6px 0' } },
              h('div', { style: rowStyle },
                h('strong', { style: { flex: 1 } }, (server.name || server.host) + ' · ' + entries.length),
                !server.missing ? settingsButton(tr('mapping.add'), () => showMapping({ machineId: server.id, localPath: '', remotePath: '' })) : null),
              ...entries.map(mapping => h('div', { key: mapping.id, style: { ...rowStyle, paddingLeft: 12 } },
                h('span', { style: pathStyle }, mapping.localPath + ' ↔ ' + mapping.remotePath),
                settingsButton(tr('settings.edit'), () => showMapping(mapping)),
                settingsButton(tr('mapping.remove'), () => removeMapping(mapping), busy))))
          }) : h('p', null, tr('mapping.noServers'))),
        form ? h(SettingsEditor, { title: tr('settings.editMachine'), close: closeServer },
          h(React.Fragment, null,
          row(tr('settings.name'), React.createElement('input', { className: 'dsh-rw-input', value: form.name, onChange: setF('name'), placeholder: tr('settings.name') + ' (e.g. build-server)', style: inputS }), 'n'),
          row(tr('settings.host'), React.createElement('input', { className: 'dsh-rw-input', value: form.host, onChange: setF('host'), placeholder: form.useSshConfig ? tr('settings.sshImport') + ' Host 别名' : 'IP or hostname', style: inputS }), 'h'),
          row(tr('settings.useSshConfig'), React.createElement('input', { type: 'checkbox', checked: !!form.useSshConfig, onChange: setFb('useSshConfig') }), 'sshc'),
          form.useSshConfig ? React.createElement('div', { style: { fontSize: 11, opacity: 0.8, marginBottom: 8, lineHeight: 1.5 } }, tr('settings.useSshConfigHint')) : null,
          // Issue #50: a literal save also touches ~/.ssh/config (managed
          // block) — say so where the choice is made.
          !form.useSshConfig ? React.createElement('div', { style: { fontSize: 11, opacity: 0.8, marginBottom: 8, lineHeight: 1.5 } }, tr('settings.saveWritesSshConfig')) : null,
          form.useSshConfig ? (() => {
            // Preview where the alias points, from the same resolution the
            // connect path uses (the host list carries it — issue #38).
            const preview = machines.find((m) => m.host === form.host && m.useSshConfig)
            const res = preview && preview.sshConfigResolved
            if (!res) return null
            return React.createElement('div', { style: { fontSize: 11, marginBottom: 8, color: res.matched ? T.ok : T.warn, lineHeight: 1.5 } },
              res.matched
                ? form.host + ' ' + tr('settings.sshResolvedTo', { user: res.username || '?', host: res.host, port: res.port })
                : tr('settings.sshResolvedNone', { alias: form.host }),
              (res.warnings && res.warnings.length) ? React.createElement('div', { style: { opacity: 0.85 } }, tr('settings.sshResolvedWarn', { msg: res.warnings.join(' ') })) : null)
          })() : null,
          row(tr('settings.port'), React.createElement('input', { className: 'dsh-rw-input', value: form.port, onChange: setF('port'), placeholder: '22', style: { ...inputS, width: 70 } }), 'p'),
          row(tr('settings.user'), React.createElement('input', { className: 'dsh-rw-input', value: form.username, onChange: setF('username'), placeholder: 'root', style: inputS }), 'u'),
          // The password box is EMPTY by design (the host never echoes a secret
          // back) — but an empty box with a neutral placeholder reads as "this
          // machine has no password", which is exactly the wrong conclusion to
          // reach while debugging a connection. When a secret IS stored, the
          // placeholder shows dots and says what an empty box will do.
          row(tr('settings.password'), React.createElement('input', {
            className: 'dsh-rw-input',
            type: 'password',
            value: form.password,
            onChange: setF('password'),
            placeholder: form.passwordSet ? tr('settings.secretSavedPlaceholder') : tr('settings.passwordPlaceholder'),
            style: inputS,
            title: form.passwordSet ? tr('settings.secretSavedHint') : '',
          }), 'w'),
          form.passwordSet
            ? React.createElement('div', { style: { marginLeft: LABEL_W + 8, marginBottom: 8, fontSize: 11, lineHeight: 1.5, color: T.ok } },
                tr('settings.secretSavedHint'))
            : null,
          // A machine with NO credential of any kind cannot connect, and the error
          // it produces ("缺少凭据") blames the user's configuration. Say it here,
          // while the form is open, instead of after a failed connect.
          (!form.passwordSet && !form.password && !form.privateKeyPath.trim() && !form.useAgent && !form.keyboardInteractive)
            ? React.createElement('div', { style: { marginLeft: LABEL_W + 8, marginBottom: 8, fontSize: 11, lineHeight: 1.5, color: T.warn } },
                tr('settings.noCredentialHint'))
            : null,
          // 高级配置折叠开关
          React.createElement('button', {
            type: 'button',
            className: 'dsh-rw-btn',
            onClick: () => setAdvOpen(!advOpen),
            style: { ...buttonS, width: '100%', marginBottom: advOpen ? 10 : 0, color: advOpen ? T.primary : 'inherit', fontWeight: advOpen ? 600 : 400, borderStyle: 'dashed' },
          }, advOpen ? tr('settings.advCollapse') : tr('settings.advExpand')),
          advOpen ? React.createElement('div', { key: 'adv', style: { paddingTop: 2 } },
            // Issue #51 — transport backend. Placed FIRST in the advanced block
            // because it changes what the fields below even mean: with the
            // system-OpenSSH backend, host/user/port/key all come from
            // ~/.ssh/config and only the machine name (an alias) matters.
            row(tr('settings.backend'), React.createElement('select', { value: form.backend || 'native', onChange: setF('backend'), style: { ...inputS, maxWidth: 260 } },
              React.createElement('option', { value: 'native' }, tr('settings.backendNative')),
              React.createElement('option', { value: 'openssh' }, tr('settings.backendOpenssh'))), 'be'),
            (form.backend === 'openssh')
              ? React.createElement('div', { style: { fontSize: 11, opacity: 0.85, marginBottom: 8, marginLeft: LABEL_W + 8, lineHeight: 1.55 } },
                  React.createElement('div', null, tr('settings.backendOpensshHint')),
                  form.useSshConfig
                    ? React.createElement('div', { style: { color: T.ok, marginTop: 2 } }, tr('settings.backendOpensshAliasOk'))
                    : null)
              : null,
            (form.backend === 'openssh')
              ? row(tr('settings.sshBinary'), React.createElement('input', { value: form.sshBinary || '', onChange: setF('sshBinary'), placeholder: tr('settings.sshBinaryPlaceholder'), style: inputS }), 'sb')
              : null,
            row(tr('settings.privateKey'), React.createElement('input', { value: form.privateKeyPath, onChange: setF('privateKeyPath'), placeholder: 'Empty = password or agent', style: inputS }), 'k'),
            row(tr('settings.passphrase'), React.createElement('input', { type: 'password', value: form.passphrase, onChange: setF('passphrase'), placeholder: form.passphraseSet ? tr('settings.secretSavedPlaceholder') : 'Encrypted private key passphrase', style: inputS, title: form.passphraseSet ? tr('settings.secretSavedHint') : '' }), 'pp'),
            form.passphraseSet
              ? React.createElement('div', { style: { marginLeft: LABEL_W + 8, marginBottom: 8, fontSize: 11, lineHeight: 1.5, color: T.ok } }, tr('settings.passphraseSavedHint'))
              : null,
            row(tr('settings.workspace'), React.createElement('input', { value: form.workspace, onChange: setF('workspace'), placeholder: 'Optional: default remote dir for this machine', style: inputS }), 'ws'),
            row(tr('settings.hostKeyMode'), React.createElement('select', { value: form.hostKeyMode, onChange: setF('hostKeyMode'), style: { ...inputS, maxWidth: 220 } },
              React.createElement('option', { value: '' }, tr('settings.hkDefault')),
              React.createElement('option', { value: 'accept-new' }, tr('settings.hkAccept')),
              React.createElement('option', { value: 'verify' }, tr('settings.hkVerify')),
              React.createElement('option', { value: 'off' }, tr('settings.hkOff'))), 'hkm'),
            React.createElement('div', { style: { display: 'flex', gap: 16, paddingLeft: LABEL_W + 8, flexWrap: 'wrap', marginBottom: 8 } },
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.useAgent, onChange: setFb('useAgent') }), tr('settings.agent')),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.keyboardInteractive, onChange: setFb('keyboardInteractive') }), tr('settings.keyboardInteractive')),
              React.createElement('label', { style: { fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' } },
                React.createElement('input', { type: 'checkbox', checked: form.encryptPassword, onChange: setFb('encryptPassword') }), tr('settings.encryptPassword'))),
            row(tr('settings.proxyHost'), React.createElement('input', { value: form.proxyHost, onChange: setF('proxyHost'), placeholder: 'Route through this host (optional)', style: inputS }), 'ph'),
            row(tr('settings.proxyPortUser'), React.createElement('div', { style: { display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' } },
              React.createElement('input', { value: form.proxyPort, onChange: setF('proxyPort'), placeholder: 'Port (22)', style: { ...inputS, minWidth: 90, maxWidth: 120 } }),
              React.createElement('input', { value: form.proxyUser, onChange: setF('proxyUser'), placeholder: 'Jump user', style: { ...inputS, minWidth: 140 } }),
              React.createElement('input', { type: 'password', value: form.proxyPassword, onChange: setF('proxyPassword'), placeholder: form.proxyPasswordSet ? tr('settings.secretSavedPlaceholder') : 'Jump password', style: { ...inputS, minWidth: 140 }, title: form.proxyPasswordSet ? tr('settings.proxyPwdSavedHint') : '' })), 'pu'),
            row(tr('settings.proxyKey'), React.createElement('input', { value: form.proxyKey, onChange: setF('proxyKey'), placeholder: 'Jump private key path (optional)', style: inputS }), 'pk'),
          ) : null),
          banner(err),
          msg ? h('p', { role: 'status', style: { color: T.ok } }, msg) : null,
          h('div', { style: footerStyle },
            settingsButton(tr('file.cancel'), closeServer, busy || tst === 'testing'),
            settingsButton(tst === 'testing' ? tr('settings.testing') : tr('settings.testConn'), testConn, busy || !form.host.trim() || tst === 'testing'),
            settingsButton(busy ? tr('settings.saving') : tr('settings.save'), saveServer, busy || !form.host.trim() || tst === 'testing', true))) : null,
        editMapping ? h(SettingsEditor, { title: tr(editMapping.id ? 'mapping.edit' : 'mapping.add'), close: closeMapping },
          row(tr('mapping.server'), h('select', { value: editMapping.machineId, onChange: e => changeMapping('machineId', e.target.value), style: inputS },
            h('option', { value: '', disabled: true }, tr('picker.chooseMachine')),
            !machines.some(machine => machine.id === editMapping.machineId) ? h('option', { value: editMapping.machineId, disabled: true }, tr('mapping.missingServer')) : null,
            ...machines.map(machine => h('option', { key: machine.id, value: machine.id }, machine.name || machine.host))), 'server'),
          row(tr('mapping.remote'), h('input', { value: editMapping.remotePath, onChange: e => changeMapping('remotePath', e.target.value),
            style: inputS, placeholder: '/home/user/project' }), 'remote'),
          row(tr('mapping.local'), h(LocalMappingDirectory, { value: editMapping.localPath,
            onChange: value => changeMapping('localPath', value), onError: setErr }), 'local'),
          banner(err),
          h('div', { style: footerStyle },
            settingsButton(tr('file.cancel'), closeMapping, busy),
            settingsButton(busy ? tr('settings.saving') : tr('settings.save'), saveMapping,
              busy || !editMapping.remotePath.trim() || !editMapping.localPath.trim() || !machines.some(machine => machine.id === editMapping.machineId), true))) : null,
        confirmUi.node)
    }

    // ── Unified picker (fill the directory-flow holes) ───────────────────
    function parseLs(text) {
      const out = []
      for (const ln of String(text || '').split('\n')) {
        const t = ln.trim()
        if (!t || !t.length || /^total\b/i.test(t)) continue
        const parts = t.split(/\s+/).filter(Boolean)
        if (parts.length < 8) continue
        const mode = parts[0]
        const name = parts.slice(8).join(' ')
        if (!name || name === '.' || name === '..') continue
        const isDir = mode.charAt(0) === 'd'
        out.push({ name, dir: isDir })
      }
      return out
    }

    // Clickable breadcrumb of the current remote path. Windows remotes show a
    // "This PC" root and `\` separators (此电脑 / C:\ / Users / dev); POSIX `/`.
    function breadcrumb(active, cur, win, jumpTo) {
      const raw = String(cur || '')
      const isWinPath = win && (raw === '' || /^[a-zA-Z]:/.test(raw))
      const rootLabel = isWinPath ? tr('picker.thisPc') : '/'
      const crumbs = []
      const rootStyle = { cursor: active ? 'pointer' : 'default', color: active ? T.ok : T.muted, whiteSpace: 'nowrap' }
      crumbs.push(React.createElement('span', { key: 'root', style: rootStyle, onClick: active ? () => jumpTo('') : undefined }, rootLabel))
      if (isWinPath && raw !== '') {
        const driveM = raw.match(/^([a-zA-Z]):(.*)$/)
        const drive = driveM[1].toUpperCase() + ':\\'
        crumbs.push(React.createElement('span', { key: 'sep0', style: { color: T.muted } }, '\\'))
        crumbs.push(React.createElement('span', { key: 'drive', style: { cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: raw === drive ? 700 : 400, whiteSpace: 'nowrap' }, onClick: active ? () => jumpTo(drive) : undefined }, drive))
        let acc = drive
        for (const s of (driveM[2] || '').split('\\')) {
          if (!s) continue
          acc += s + '\\'
          const target = acc.slice(0, -1)
          crumbs.push(React.createElement('span', { key: 's|' + target, style: { color: T.muted } }, '\\'))
          crumbs.push(React.createElement('span', { key: target, style: { cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: target === raw ? 700 : 400, whiteSpace: 'nowrap' }, onClick: active ? () => jumpTo(target) : undefined }, s))
        }
      } else if (!isWinPath && raw !== '' && raw !== '/') {
        const segs = raw.replace(/\/+$/, '').split('/')
        let acc = ''
        for (const s of segs) {
          if (!s) continue
          acc += '/' + s
          crumbs.push(React.createElement('span', { key: s + '|' + acc, style: { color: T.muted } }, '/'))
          crumbs.push(React.createElement('span', { key: acc, style: { cursor: active ? 'pointer' : 'default', color: active ? T.label : T.muted, fontWeight: acc === raw ? 700 : 400, whiteSpace: 'nowrap' }, onClick: active ? () => jumpTo(acc) : undefined }, s))
        }
      }
      if (crumbs.length === 1) crumbs.push(React.createElement('span', { key: 'empty', style: { color: T.muted } }, isWinPath ? tr('picker.chooseDrive') : ''))
      return React.createElement('span', { key: 'crumb', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block', maxWidth: '100%' } }, crumbs)
    }

    function DirPicker(props) {
      // initialMachineId lets a caller open the picker FOR a specific machine. The
      // settings page needs it: 选目录 on a non-current machine must not silently
      // browse the current one.
      // registerWorkspace: this picker is the CORE's "Add workspace" directory
      // flow, which adopts the returned mirror as a workspace right after we
      // commit. The plugin's own pickers (settings, Remote Files) only choose a
      // folder, so they pass false and never grow a stray workspace.
      const { open, busy, onPicked, onCancel, initialMachineId, registerWorkspace } = props
      const [mapLocal, setMapLocal] = React.useState(false)
      const [mappedPath, setMappedPath] = React.useState('')
      const [mappingBusy, setMappingBusy] = React.useState(false)
      const mappingConfirm = useConfirm()
      const [tab, setTab] = React.useState('local')
      const [machines, setMachines] = React.useState([])
      const [machineId, setMachineId] = React.useState('')
      const [path, setPath] = React.useState('')
      const [items, setItems] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [levels, setLevels] = React.useState(null)
      const [popOpen, setPopOpen] = React.useState(false)
      const [suggest, setSuggest] = React.useState([])
      const [suggestOpen, setSuggestOpen] = React.useState(false)
      const [recent, setRecent] = React.useState([])
      const [win, setWin] = React.useState(false) // remote platform: windows = Git-Bash host
      // 本机浏览浮层（browse 后端）：{ path, home, crumbs, entries, truncated }。
      const [localPop, setLocalPop] = React.useState(null)
      const [newDirName, setNewDirName] = React.useState('')
      const [mkdirPrompt, setMkdirPrompt] = React.useState(false)
      const suggestTimer = React.useRef(null)
      const suggestRef = React.useRef(null)
      // Issue #52 defect 1: the modal backdrop must dismiss only when the press
      // STARTED on it (a suggestion click whose mouseup landed on the backdrop
      // used to close the whole picker). The local-browse popup below is its own
      // full-screen overlay, so it gets its own guard ref — sharing one ref
      // would make a press on either backdrop arm the other.
      const backdrop = useBackdropGuard()
      const localBackdrop = useBackdropGuard()
      // Autocomplete performance (slow per-keystroke remote scans):
      //  - postedCurrentRef/currentPromiseRef: POST /current once per machine
      //    switch; concurrent callers share ONE in-flight promise and a failed
      //    switch REJECTS (never run /ls — or cache its listing — on the wrong
      //    machine)
      //  - lsCacheRef/lsInflightRef: one /ls per (machine, dir), TTL-cached
      //  - lsGenRef/fetchSeqRef: per-key fetch generation — a cache write from
      //    a superseded fetch (fresh navigation, picker reopen) is dropped
      //  - suggestSeqRef: drop stale suggestion responses (older keystrokes)
      const postedCurrentRef = React.useRef('')
      const currentPromiseRef = React.useRef(null)
      const lsCacheRef = React.useRef(new Map())
      const lsInflightRef = React.useRef(new Map())
      const lsGenRef = React.useRef(new Map())
      const fetchSeqRef = React.useRef(0)
      const suggestSeqRef = React.useRef(0)
      React.useEffect(() => {
        if (!suggestOpen) return
        const onDown = (ev) => { if (suggestRef.current && !suggestRef.current.contains(ev.target)) { suggestSeqRef.current++; setSuggestOpen(false) } }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [suggestOpen])
      const [mOpen, setMOpen] = React.useState(false)
      const ddRef = React.useRef(null)
      React.useEffect(() => {
        if (!mOpen) return
        const onDown = (ev) => { if (ddRef.current && !ddRef.current.contains(ev.target)) setMOpen(false) }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [mOpen])
      React.useEffect(() => { if (open) ensureChromeCss() }, [open])

      const sortItems = (list) => {
        const dirs = list.filter((it) => it.dir)
        const files = list.filter((it) => !it.dir)
        dirs.sort((a, b) => a.name.localeCompare(b.name))
        files.sort((a, b) => a.name.localeCompare(b.name))
        return dirs.concat(files)
      }

      // Client-side full-path fallback: when the server did not attach a `path`
      // (older host half), join base + name with the base's own separator.
      const joinDisplay = (base, name) => {
        const b = String(base || '')
        const n = String(name || '')
        if (!b || b === '/') return '/' + n
        const sep = /^[a-zA-Z]:/.test(b) || b.includes('\\') ? '\\' : '/'
        return b.replace(/[\\/]+$/, '') + sep + n
      }

      // Identity of the machine a listing was answered for (the /ls response
      // echoes it), checked against the machine the fetch INTENDED. The picker
      // memoizes "machine already active", but the settings page can switch
      // machines too — validate every listing before trusting the memo. A
      // machine may show up as its ~/.ssh/config alias OR its resolved host, so
      // accept either identity; nothing to compare against → accept.
      const echoMatches = (id, echo) => {
        if (!echo || !echo.host) return true // older host half without an echo
        const m = (machines || []).find((x) => x && x.id === id)
        if (!m) return true
        const cands = [{ host: String(m.host || ''), port: Number(m.port) || 22, username: String(m.username || '') }]
        const r = m.sshConfigResolved
        if (r && r.host) cands.push({ host: String(r.host), port: Number(r.port) || 22, username: String(r.username || m.username || '') })
        return cands.some((c) => c.host === String(echo.host) && c.port === (Number(echo.port) || 22) && c.username === String(echo.username || ''))
      }

      // POST /current once per machine switch. The picker used to post it before
      // EVERY /ls; the host re-applies the machine on that route, which used to
      // close the live SSH connection — so each autocomplete keystroke paid a
      // full reconnect. The memo is set only on SUCCESS and concurrent callers
      // share ONE in-flight promise, so no request can overtake a pending switch
      // and read the OLD machine's listing. A failed switch REJECTS: the
      // caller's fetch chain aborts WITHOUT writing the cache.
      const ensureCurrent = (id) => {
        if (!id) return Promise.resolve()
        if (postedCurrentRef.current === id) return Promise.resolve()
        const inflight = currentPromiseRef.current
        if (inflight) {
          if (inflight.id === id) return inflight.promise
          // Serialize switches: ours must land AFTER any pending one (the host
          // applies whichever POST arrives last), never race it.
          return inflight.promise.then(() => ensureCurrent(id), () => ensureCurrent(id))
        }
        const p = api('POST', '/dsh-remote/current', { id }).then(() => {
          postedCurrentRef.current = id
        })
        const entry = { id, promise: p }
        currentPromiseRef.current = entry
        const clear = () => { if (currentPromiseRef.current === entry) currentPromiseRef.current = null }
        p.then(clear, clear)
        return p
      }

      const LS_TTL_MS = 30000
      // Cached remote listing per (machine, dir): typing inside one parent
      // directory used to re-fetch the identical list on every keystroke.
      // `fresh` bypasses the cache (browse navigation / post-mkdir refresh) and
      // SUPERSEDES older fetches for the key: a cache write from a superseded
      // fetch is dropped (it still resolves its own callers), so a pre-mkdir
      // listing can never overwrite the post-mkdir one. Concurrent identical
      // requests share one in-flight fetch.
      const fetchDirList = (id, dirParam, fresh) => {
        const key = String(id) + '\u0000' + String(dirParam)
        const hit = lsCacheRef.current.get(key)
        if (!fresh && hit && Date.now() - hit.at < LS_TTL_MS) return Promise.resolve(hit.node)
        const inflight = fresh ? null : lsInflightRef.current.get(key)
        if (inflight) return inflight
        const gen = ++fetchSeqRef.current
        lsGenRef.current.set(key, gen)
        const toNode = (res) => {
          const real = res && res.path ? res.path : String(dirParam)
          // Server returns [{ type, name, size, mtime, path }] where `path` is
          // the FULL display-form path (C:\Users\dev on Windows) — the client
          // never joins paths itself, so drives and Windows paths just work.
          const list = Array.isArray(res && res.items)
            ? res.items.map((it) => ({ name: it.name, dir: it.type === 'dir', size: it.size, mtime: it.mtime, path: it.path || joinDisplay(real, it.name), drive: !!it.drive }))
            : parseLs(res && res.text)
          return {
            path: real,
            platform: !!(res && res.platform === 'windows'),
            dirs: sortItems(list.filter((it) => it.dir)),
            all: sortItems(list),
          }
        }
        const run = (retried) => ensureCurrent(id)
        .then(() => api('GET', '/dsh-remote/ls?path=' + encodeURIComponent(dirParam)))
        .then((res) => {
          // External-switch defense: on an identity-echo mismatch the host is
          // no longer on the machine this fetch intended — bust the memo, force
          // one re-switch and retry ONCE. A mismatched listing is never cached.
          if (!echoMatches(id, res && res.machine)) {
            if (retried) return toNode(res)
            postedCurrentRef.current = ''
            return run(true)
          }
          const node = toNode(res)
          if (lsGenRef.current.get(key) === gen) lsCacheRef.current.set(key, { at: Date.now(), node })
          return node
        })
        const p = run(false)
        .finally(() => { if (lsInflightRef.current.get(key) === p) lsInflightRef.current.delete(key) })
        lsInflightRef.current.set(key, p)
        return p
      }

      // Fresh session on every open: forget everything a previous open left
      // behind. A stale in-flight response must not repopulate the cache
      // (generation fence) and a stale suggestion response must not reopen the
      // dropdown on the now-live tree.
      const resetPickerFetchState = () => {
        postedCurrentRef.current = ''
        lsCacheRef.current.clear()
        lsInflightRef.current.clear()
        lsGenRef.current.clear()
        suggestSeqRef.current++
      }

      const loadLevels = (id, p, toIndex) => {
        if (!id) return
        setLoading(true); setErr('')
        fetchDirList(id, p || '', true)
        .then((node) => {
          setWin(node.platform)
          const level = { path: node.path, dirs: node.dirs, all: node.all }
          setLevels((prev) => {
            const base = prev && prev.length ? prev.slice() : []
            let idx = typeof toIndex === 'number' && toIndex >= 0 ? toIndex : base.length
            if (idx >= base.length) return base.concat([level])
            base[idx] = level
            return base.slice(0, idx + 1)
          })
        })
        .catch((e) => setErr(String((e && e.message) || e)))
        .finally(() => setLoading(false))
      }

      React.useEffect(() => { if (open) {
        // Bug fix: the picker must NOT reopen with the previous selection's
        // path — reset the path bar (and the browse state) on every open.
        setPath(''); setLevels(null); setWin(false)
        setMapLocal(false); setMappedPath('')
        setLocalPop(null); setNewDirName('')
        // Fresh session: re-post /current on the first request and forget
        // everything a previous open left behind (TTL bounds staleness within
        // one open; reopening should see the live tree) — cached AND in-flight
        // listings, plus any pending suggestion response.
        resetPickerFetchState()
        if (suggestTimer.current) { clearTimeout(suggestTimer.current); suggestTimer.current = null }
        api('GET', '/dsh-remote/machines').then((r) => {
          setMachines(r.machines || [])
          const cur = (r.machines || []).find((m) => m.id === r.currentId)
          setRecent((cur && cur.recentWorkspaces) || [])
          setMachineId(initialMachineId || r.currentId || (r.machines && r.machines[0] && r.machines[0].id) || '')
        })
      } }, [open])

      // 本机目录浏览（browse 后端兜底）：列出 path 的子目录；path 为空 → 宿主家目录。
      const loadLocal = (p) => {
        setLoading(true); setErr('')
        api('GET', '/dsh-remote/local-list' + (p ? '?path=' + encodeURIComponent(p) : ''))
          .then((r) => setLocalPop({ path: (r && r.path) || p || '', home: (r && r.home) || '', crumbs: (r && r.crumbs) || [], entries: (r && r.entries) || [], truncated: !!(r && r.truncated), drives: (r && r.drives) || [] }))
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setLoading(false))
      }

      const chooseLocal = () => {
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/local-pick')
          .then((r) => {
            if (r && r.path) { setLoading(false); onPicked(String(r.path)) }
            // browse 后端（DSH Desktop / 无显示的远程宿主）：没有 OS 对话框可开
            // → 打开内置本机目录浏览器。
            else if (r && r.kind === 'browse') loadLocal('')
            else if (r && r.cancelled) { setLoading(false); setErr(tr('picker.cancelled')) }
            else { setLoading(false); setErr((r && r.error) || tr('picker.noSysPicker')) }
          })
          .catch((e) => { setLoading(false); setErr(String((e && e.message) || e) + tr('picker.typePath')) })
      }

      // 在浮层当前目录下新建文件夹（browse 后端 createDirectory），成功后刷新列表。
      const mkdirLocal = () => {
        const cur = localPop
        const name = newDirName.trim()
        if (!cur || !cur.path || !name || loading) return
        setLoading(true); setErr('')
        api('POST', '/dsh-remote/local-mkdir', { path: cur.path, name })
          .then(() => { setNewDirName(''); loadLocal(cur.path) })
          .catch((e) => { setErr(String((e && e.message) || e)); setLoading(false) })
      }

      // 选用浮层中的本机目录：回填输入框（不直接提交），复核后再点「选用此本地路径」。
      const acceptLocalPick = (p) => {
        setPath(String(p || ''))
        setErr('')
        setLocalPop(null)
      }

      const switchTab = (t) => {
        setTab(t); setErr('')
        // each tab keeps its own path — never leak the other tab's selection
        setPath('')
        if (t === 'remote') {
          // Windows remotes show a "This PC" drive view at the root; POSIX shows
          // the filesystem root. Either way loadLevels('') lists that root.
          if (machineId) loadLevels(machineId, '', 0)
        }
      }

      // Parent path of a display-form remote path (client-side, both separators).
      const parentOf = (p) => {
        const t = String(p || '')
        if (!t || t === '/') return null
        const win = /^[a-zA-Z]:/.test(t)
        if (win && /^[a-zA-Z]:\\?$/.test(t)) return null // drive root: no parent
        const sep = win ? '\\' : '/'
        const idx = t.lastIndexOf(sep)
        if (idx <= 0) return null
        const par = t.slice(0, idx)
        if (win && /^[a-zA-Z]:$/.test(par)) return par + '\\'
        return par || '/'
      }

      // enterDir(it): drive into the given entry — `it.path` is the FULL
      // display-form path from the server (drives C:\, Windows and POSIX alike).
      const enterDir = (it) => {
        if (busy || loading || !it || !it.dir) return
        loadLevels(machineId, it.path, (levels ? levels.length : 0))
      }

      // Navigate one level up in the browse popup. When the current level was
      // opened directly at a deep path (levels.length === 1 — e.g. the popup
      // was opened at the path bar's value) the parent is loaded as the new top
      // level instead of being disabled.
      const goUp = () => {
        if (loading) return
        const last = levels && levels.length ? levels[levels.length - 1] : null
        if (!last) return
        if (levels.length > 1) { setLevels((p) => p.slice(0, p.length - 1)); return }
        const par = parentOf(last.path)
        if (par) loadLevels(machineId, par, 1)
      }

      // Drop any pending suggestion response and close the dropdown.
      const killSuggestions = () => {
        suggestSeqRef.current++
        setSuggest([])
        setSuggestOpen(false)
      }

      // One seq-guarded "fetch listing → derive suggestion paths" pipeline
      // shared by loadSuggestions (typing: dirs matching a prefix) and
      // continueSuggest (expanding a picked dir: all its entries) — the
      // differing parts stay at the call sites as the `pick` parameter. Only
      // the newest request owns the dropdown: a slow older /ls must never
      // overwrite the suggestions for the text now in the input. The catch
      // keeps the seq-guarded empty fallback (a failed machine switch rejects
      // too, and must leave the dropdown closed and empty).
      const suggestFrom = (id, dirParam, pick, fresh) => {
        const seq = ++suggestSeqRef.current
        return fetchDirList(id, dirParam, fresh).then((node) => {
          if (seq !== suggestSeqRef.current) return
          const matches = pick(node).slice(0, 40)
          setSuggest(matches)
          setSuggestOpen(!!matches.length)
        }).catch(() => {
          if (seq !== suggestSeqRef.current) return
          setSuggest([]); setSuggestOpen(false)
        })
      }

      const loadSuggestions = (raw, mid) => {
        const id = mid || machineId
        const t = String(raw || '').trim()
        if (!id || !t) { killSuggestions(); return }
        // Separator-aware split: `\` when the input looks like a Windows path.
        const backslash = t.includes('\\') || /^[a-zA-Z]:/.test(t)
        const sep = backslash ? '\\' : '/'
        const idx = t.lastIndexOf(sep)
        let parent, lastSeg
        if (idx < 0) { parent = backslash ? t + '\\' : '/'; lastSeg = backslash ? '' : t }
        else if (idx === t.length - 1) { parent = t.slice(0, idx) || '/'; lastSeg = '' }
        else { parent = t.slice(0, idx) || '/'; lastSeg = t.slice(idx + 1) }
        suggestFrom(id, parent || '/', (node) => node.dirs
          .filter((it) => !lastSeg || it.name.toLowerCase().startsWith(String(lastSeg).toLowerCase()))
          .map((it) => it.path))
      }

      const onPathChange = (raw) => {
        setPath(raw); setErr('')
        if (suggestTimer.current) clearTimeout(suggestTimer.current)
        suggestTimer.current = setTimeout(() => loadSuggestions(raw), 220)
      }

      const continueSuggest = (dir) => {
        if (!machineId || !dir) { killSuggestions(); return }
        setSuggestOpen(false)
        const target = String(dir).replace(/[\\/]+$/, '') || '/'
        // Expanding a just-selected directory is a NAVIGATION step: the caching
        // spec only sanctions "typing inside one parent directory, local
        // filtering", so fetch fresh instead of serving up to 30s-stale entries.
        suggestFrom(machineId, target, (node) => node.all.map((it) => it.path), true)
      }

      const selectSuggestion = (s) => {
        if (!s) { setSuggestOpen(false); return }
        // Auto-append the trailing separator so the path reads as a directory
        // and the user can keep typing the next segment right away.
        const sep = String(s).includes('\\') ? '\\' : '/'
        const withSep = String(s).replace(/[\\/]+$/, '') + sep
        setPath(withSep); setErr(''); setSuggestOpen(false)
        continueSuggest(withSep)
      }

      const commitPath = (p) => {
        const target = String(p || '').trim()
        if (!target || !machineId || busy) return
        if (mapLocal) {
          if (!mappedPath.trim() || mappingBusy) return
          setMappingBusy(true); setErr('')
          saveDirectoryMapping({ machineId, remotePath: target, localPath: mappedPath }, mappingConfirm.ask, machines)
            .then(mapping => { if (mapping) onPicked(mapping.localPath, mapping.remotePath) })
            .catch(error => setErr(error.message))
            .finally(() => setMappingBusy(false))
          return
        }
        setPopOpen(false); killSuggestions()
        // State the machine this pick was made on. The picker acts on the shared
        // active pool, and another actor (the settings page, or rw_connect in
        // another session) can switch it while the picker is open — the mirror
        // would then be created with THAT machine's identity while the user was
        // looking at this one's tree. The host re-asserts the named machine
        // instead of trusting whichever happens to be active.
        ensureCurrent(machineId)
          .then(() => api('POST', '/dsh-remote/mirror', { path: target, machineId, registerWorkspace: registerWorkspace !== false }))
          // `onPicked(localMirror, remotePath)`: the mirror is ALREADY created here.
          // The sidebar opens the local mirror (1st arg); a caller that only wants to
          // report/continue from the remote path uses the 2nd. Handing back only the
          // local path made the settings page post /mirror a SECOND time with a
          // Windows path as if it were remote ("not a directory (or unreachable)").
          .then((res) => (res && res.localMirror ? onPicked(res.localMirror, res.path || target) : setErr((res && res.error) || '')))
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      const acceptBrowserPick = (p) => {
        setPath(String(p || ''))
        killSuggestions()
        setPopOpen(false)
      }

      const pickHome = () => {
        // Same identity contract as commitPath: /home is answered by the active
        // pool, so name the machine this picker is showing.
        ensureCurrent(machineId)
          .then(() => api('POST', '/dsh-remote/home', { machineId }))
          .then((r) => {
            if (r && r.home) { setPath(r.home); setErr(''); loadSuggestions(r.home) }
            else setErr((r && (r.hint || r.error)) || tr('picker.noHome'))
          }).catch((e) => setErr(String((e && e.message) || e)))
      }

      const mkdirHere = () => {
        const last = levels && levels.length ? levels[levels.length - 1] : null
        const base = (last && last.path) || '/'
        setMkdirPrompt({ base })
      }
      const confirmMkdirHere = (nm) => {
        const last = levels && levels.length ? levels[levels.length - 1] : null
        const base = (mkdirPrompt && mkdirPrompt.base) || (last && last.path) || '/'
        setMkdirPrompt(false)
        const name = String(nm || '').trim()
        if (!name) return
        const sep = base.includes('\\') ? '\\' : '/'
        const full = base === '/' ? '/' + name : base + sep + name
        api('POST', '/dsh-remote/fs', { op: 'mkdir', path: full })
          .then(() => { setErr(''); loadLevels(machineId, base, (levels ? levels.length - 1 : 0)) })
          .catch((e) => setErr(String((e && e.message) || e)))
      }

      // 本机浏览浮层的面包屑：browse 后端给出完整祖先链（含盘符根），可点击跳转。
      const localCrumbs = (cur) => {
        const crumbs = (cur && cur.crumbs) || []
        if (!crumbs.length) return React.createElement('span', null, '/')
        const out = []
        crumbs.forEach((c, i) => {
          if (i > 0) out.push(React.createElement('span', { key: 'sep' + i, style: { color: T.muted } }, ' › '))
          out.push(React.createElement('span', {
            key: c.path || i,
            title: c.path,
            onClick: () => loadLocal(c.path),
            style: { cursor: 'pointer', color: i === crumbs.length - 1 ? T.label : T.ok, fontWeight: i === crumbs.length - 1 ? 700 : 400 },
          }, c.name))
        })
        return React.createElement('span', null, out)
      }

      // 本机目录浏览浮层（browse 后端）：进入子目录 / 面包屑跳转 / 回家目录 /
      // 新建文件夹 / 选用回填。与远程浏览弹层同一套交互。
      function renderLocalPopup() {
        const cur = localPop
        if (!cur) return null
        const crumbs = cur.crumbs || []
        const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : null
        return React.createElement('div', {
          style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12 },
          onMouseDown: localBackdrop.onMouseDown,
          onClick: (e) => { if (localBackdrop.onClick(e)) setLocalPop(null) },
        },
          React.createElement('div', { style: { background: v('--dsw-alias-bg-overlay', '#1e1e1e'), border: '1px solid ' + T.borderStrong, borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.5)', width: 'min(560px, 94vw)', minWidth: 320, display: 'flex', flexDirection: 'column', maxHeight: 'min(460px, 84vh)', overflow: 'hidden' }, onClick: (e) => e.stopPropagation() },
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid ' + T.border } },
              React.createElement('button', { style: { ...buttonS, padding: '3px 10px' }, onClick: () => parent && loadLocal(parent), disabled: !parent || loading, title: parent || '' }, tr('picker.back')),
              cur.home ? React.createElement('button', { style: { ...buttonS, padding: '3px 8px' }, onClick: () => loadLocal(cur.home), disabled: loading, title: tr('picker.goHome') }, tr('picker.homeBtn')) : null,
              React.createElement('div', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, localCrumbs(cur)),
              React.createElement('button', { style: { ...buttonS, padding: '3px 10px' }, onClick: () => setLocalPop(null) }, tr('picker.closeBtn')),
            ),
            // 盘符切换行（Windows 无统一根目录，browse 面包屑到不了其他盘）。
            (cur.drives && cur.drives.length > 1) ? React.createElement('div', { style: { display: 'flex', gap: 4, flexWrap: 'wrap', padding: '6px 12px', borderBottom: '1px solid ' + T.border } },
              cur.drives.map((d) => {
                const active = String(cur.path).toUpperCase().startsWith(String(d.name).toUpperCase())
                return React.createElement('button', {
                  key: d.path,
                  onClick: () => loadLocal(d.path),
                  disabled: loading,
                  title: d.path,
                  style: { ...buttonS, padding: '2px 8px', fontSize: 11, fontFamily: 'monospace', fontWeight: active ? 700 : 400, color: active ? T.ok : T.label },
                }, d.name)
              }),
            ) : null,
            React.createElement('div', { style: { overflowY: 'auto', overflowX: 'hidden' } },
              loading ? React.createElement('div', { style: { opacity: 0.7, padding: 12 } }, tr('picker.loading'))
                : (cur.entries.length ? cur.entries.slice(0, 400).map((it, i) => React.createElement('div', {
                    key: it.path || i, title: tr('picker.enterDir', { name: it.name }),
                    onClick: () => loadLocal(it.path),
                    className: 'dsh-rw-list-item',
                    style: { padding: '7px 12px', cursor: 'pointer', color: T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border },
                  },
                    // Same folder glyph as everywhere else when the host ships
                    // FileTypeIcon; the emoji stays as the no-primitive fallback.
                    React.createElement('span', { style: { display: 'inline-flex', flexShrink: 0 } }, HostFileTypeIcon ? React.createElement(HostFileTypeIcon, { kind: 'folder', size: 14 }) : '📁'),
                    React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.name),
                  )) : React.createElement('div', { style: { opacity: 0.6, padding: 12 } }, tr('picker.noSubdir'))),
              cur.truncated ? React.createElement('div', { style: { opacity: 0.6, padding: '6px 12px', fontSize: 11 } }, tr('picker.truncated')) : null,
            ),
            err ? React.createElement('div', { style: { color: T.danger, fontSize: 12, padding: '4px 12px' } }, err) : null,
            React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '8px 12px', borderTop: '1px solid ' + T.border } },
              React.createElement('input', { className: 'dsh-rw-input', value: newDirName, onChange: (e) => setNewDirName(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') mkdirLocal() }, placeholder: tr('picker.newFolder'), style: { ...inputS, width: 110, flex: '0 0 auto', padding: '4px 8px', fontSize: 12 } }),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '4px 10px', whiteSpace: 'nowrap' }, onClick: mkdirLocal, disabled: loading || !newDirName.trim() || !cur.path }, tr('picker.create')),
              React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, tr('picker.selected', { path: cur.path })),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: { ...primaryBtnS, whiteSpace: 'nowrap' }, onClick: () => acceptLocalPick(cur.path) }, tr('picker.chooseThis')),
            ),
          ),
        )
      }

      function renderDirPopup() {
        if (!levels || !levels.length) {
          return React.createElement('div', { style: { opacity: 0.6, fontSize: 12 } }, (loading ? tr('picker.loading') : tr('picker.readingRoot')))
        }
        const last = levels[levels.length - 1]
        const entries = last.all || []
        return React.createElement('div', { style: { border: '1px solid ' + T.borderStrong, borderRadius: 10, background: v('--dsw-alias-bg-overlay', '#1e1e1e'), boxShadow: '0 8px 32px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', maxHeight: 'min(300px, 46vh)', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid ' + T.border } },
            React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: goUp, disabled: loading || (levels.length <= 1 && !parentOf(last.path)) }, tr('picker.back')),
            React.createElement('div', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, breadcrumb(!!machineId, last.path, win, (p) => setLevels((prev) => { const cut = (prev || []).findIndex((lv) => lv.path === p); return cut >= 0 ? prev.slice(0, cut + 1) : prev }))),
            React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: mkdirHere }, tr('picker.newDir')),
            React.createElement('button', { style: { ...buttonS, padding: '2px 8px' }, onClick: () => setPopOpen(false) }, tr('picker.closeBtn')),
          ),
          React.createElement('div', { style: { overflowY: 'auto', overflowX: 'hidden' } },
            loading ? React.createElement('div', { style: { opacity: 0.7, padding: 12 } }, tr('picker.loading'))
              : (entries.length ? entries.slice(0, 400).map((it, i) => React.createElement('div', {
                  key: i, title: it.drive ? tr('picker.enterDrive', { name: it.name }) : (it.dir ? tr('picker.enterDir', { name: it.name }) : tr('picker.fileAt', { name: it.name })),
                  onClick: it.dir ? () => enterDir(it) : undefined,
                  className: it.dir ? 'dsh-rw-list-item' : undefined,
                  style: { padding: '6px 10px', cursor: it.dir ? 'pointer' : 'default', color: T.label, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, borderBottom: '1px solid ' + T.border },
                },
                  React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex', color: T.label, fontSize: 13 } }, it.drive ? '💽' : (it.dir
                    ? IconFolder()
                    : IconFile(it.name))),
                  React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, it.name),
                  React.createElement('span', { style: { fontSize: 11, opacity: 0.55, flexShrink: 0, fontFamily: 'monospace' } }, it.dir ? '' : (humanSize(it.size) + (it.mtime ? '  ' + fmtTime(it.mtime) : ''))),
                )) : React.createElement('div', { style: { opacity: 0.6, padding: 12 } }, tr('picker.emptyDir'))),
          ),
          React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', padding: '6px 10px', borderTop: '1px solid ' + T.border } },
            React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, tr('picker.selected', { path: (last.path || (win ? tr('picker.driveRoot') : '/')) })),
            React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => { acceptBrowserPick(last.path); setPopOpen(false) } }, tr('picker.chooseThis')),
          ),
        )
      }

      React.useEffect(() => {
        if (!open) return
        try {
          if (typeof document === 'undefined') return
          const onKey = (e) => {
            if (mkdirPrompt || mappingConfirm.node) return
            if (e.key === 'Escape') {
              if (popOpen) { e.preventDefault(); setPopOpen(false); return }
              if (suggestOpen) { e.preventDefault(); suggestSeqRef.current++; setSuggestOpen(false); return }
              if (!busy && !mappingBusy) { e.preventDefault(); onCancel() }
              return
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (tab === 'local' && path.trim()) onPicked(path)
              else if (tab === 'remote' && path.trim()) commitPath(path)
            }
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        } catch { return undefined }
      }, [open, busy, tab, path, machineId, popOpen, suggestOpen, mkdirPrompt, mapLocal, mappedPath, mappingBusy, mappingConfirm.node])

      if (!open) return null
      const tabBtn = (t, lbl) => React.createElement('button', {
        type: 'button',
        className: 'dsh-rw-btn dsh-rw-tab' + (tab === t ? ' is-active' : ''),
        onClick: () => switchTab(t),
        style: { ...buttonS, fontWeight: tab === t ? 700 : 400, padding: '5px 14px' },
      }, lbl)
      return portalize(React.createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
        onMouseDown: backdrop.onMouseDown,
        // Issue #52 defect 1: this was a bare onClick, so picking an autocomplete
        // suggestion (mousedown inside the panel, panel re-laid-out, mouseup on
        // the backdrop) closed the whole dialog. Only a press that began on the
        // backdrop dismisses now.
        onClick: (e) => { if (backdrop.onClick(e) && !busy && !mappingBusy && !mkdirPrompt) onCancel() },
      },
        React.createElement('div', { className: 'dsh-rw-modal-panel', style: { background: v('--dsw-alias-bg-layer-1', '#18181b'), color: T.label, border: '1px solid ' + T.borderStrong, borderRadius: 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)', width: 'min(600px, 94vw)', maxHeight: 'min(680px, 92vh)', display: 'flex', flexDirection: 'column', padding: 16, boxSizing: 'border-box' }, onClick: (e) => e.stopPropagation() },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
          React.createElement('div', { style: { fontSize: 15, fontWeight: 650 } }, tr('picker.title')),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 8px' }, onClick: () => { if (!busy && !mappingBusy) onCancel() }, disabled: busy || mappingBusy }, tr('picker.close')),
        ),
        // 本机/远程 switch: host SegmentedTabs when the bundle ships one
        // (sliding-indicator tablist, roving tabindex and arrow-key navigation
        // baked in); onChange delivers the item value, which is exactly what
        // switchTab consumes. Older hosts keep the hand-rolled button pair.
        HostSegmentedTabs
          ? React.createElement('div', { style: { marginBottom: 10, alignSelf: 'flex-start' } },
              React.createElement(HostSegmentedTabs, {
                items: [
                  { value: 'local', label: tr('picker.tabLocal') },
                  { value: 'remote', label: tr('picker.tabRemote') },
                ],
                value: tab,
                onChange: switchTab,
                label: tr('picker.title'),
              }))
          : React.createElement('div', { className: 'dsh-rw-tabs', style: { marginBottom: 10, alignSelf: 'flex-start' } },
              tabBtn('local', tr('picker.tabLocal')),
              tabBtn('remote', tr('picker.tabRemote'))),
        tab === 'local'
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              React.createElement('div', { style: { fontSize: 12, opacity: 0.8, lineHeight: 1.5 } }, tr('picker.localIntro')),
              React.createElement('div', { style: { display: 'flex', gap: 6 } },
                React.createElement('input', { className: 'dsh-rw-input', value: path, onChange: (e) => setPath(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter' && path.trim()) { e.preventDefault(); onPicked(path) } }, placeholder: tr('picker.localPlaceholder'), style: inputS }),
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => (path.trim() ? onPicked(path) : undefined), disabled: !path.trim() }, tr('picker.useLocalPath')),
              ),
              React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, alignSelf: 'flex-start' }, onClick: chooseLocal, disabled: loading }, loading ? tr('picker.opening') : tr('picker.openSysPicker')),
              err ? React.createElement('div', { style: { color: T.danger, fontSize: 12 } }, err) : null,
              localPop ? renderLocalPopup() : null,
            )
          : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, overflowY: suggestOpen ? 'visible' : 'auto' } },
              React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                React.createElement('label', { style: { fontSize: 12, opacity: 0.8, whiteSpace: 'nowrap' } }, tr('picker.remoteMachine')),
                React.createElement('div', { ref: ddRef, style: { position: 'relative', display: 'inline-block' } },
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...inputS, textAlign: 'left', cursor: 'pointer', minWidth: 200, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, onClick: () => setMOpen((x) => !x) },
                    (machines.find((m) => m.id === machineId) || {}).name || (machineId ? '…' : tr('picker.chooseMachine')),
                  ),
                  mOpen
                    ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, zIndex: 1000, marginTop: 2, minWidth: 300, maxHeight: 260, overflow: 'auto', background: v('--dsw-alias-bg-overlay', '#1f1f23'), color: T.label, border: '1px solid ' + T.border, borderRadius: T.radius, padding: 4 } },
                        machines.length
                          ? machines.map((m) => React.createElement('div', { key: m.id, className: 'dsh-rw-list-item', onClick: () => { setMachineId(m.id); setRecent(m.recentWorkspaces || []); setLevels(null); setPath(''); setMOpen(false); if (m.id) loadLevels(m.id, '', 0) }, style: { padding: '6px 8px', borderRadius: 4, cursor: 'pointer', color: m.id === machineId ? T.ok : 'inherit' } }, m.name + '  (' + m.username + '@' + m.host + ':' + m.port + ')'))
                          : React.createElement('div', { style: { padding: 6, opacity: 0.6 } }, tr('picker.noMachines')),
                      )
                    : null,
                ),
              ),
              recent.length ? React.createElement('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap' } }, tr('picker.recent')),
                recent.map((w, i) => React.createElement('button', { type: 'button', className: 'dsh-rw-btn', key: w + i, onClick: () => { setPath(w); setErr(''); continueSuggest(w) }, style: { ...buttonS, padding: '2px 8px', fontSize: 11, fontFamily: 'monospace' } }, w))) : null,
              React.createElement('div', { ref: suggestRef, style: { position: 'relative' } },
                React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  React.createElement('input', {
                    className: 'dsh-rw-input',
                    value: path,
                    onChange: (e) => onPathChange(e.target.value),
                    onFocus: () => loadSuggestions(path),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        if (suggestOpen && suggest.length) selectSuggestion(suggest[0])
                        else if (path.trim()) commitPath(path)
                      }
                    },
                    placeholder: (machineId ? (win ? tr('picker.pathPlaceholderWin') : tr('picker.pathPlaceholder')) : tr('picker.chooseMachineFirst')),
                    disabled: !machineId, style: { ...inputS, flex: 1, minWidth: 120 },
                  }),
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, whiteSpace: 'nowrap' }, onClick: () => { if (!machineId) return; const p = path.trim(); loadLevels(machineId, p || '', 0); setPopOpen(true) }, disabled: !machineId }, tr('picker.browse')),
                  React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, whiteSpace: 'nowrap' }, onClick: pickHome, disabled: !machineId }, tr('picker.home')),
                ),
                (suggestOpen && suggest.length)
                  // Issue #52 defect 2: this used to be an in-flow block, so
                  // expanding it pushed the 「设为远程工作区」 button down and the
                  // user could never hit a button that was moving. It is now an
                  // absolutely-positioned overlay hanging off `suggestRef`
                  // (position: relative), which also keeps the modal's height —
                  // and therefore its centred edges — stable while open (that
                  // stability is what makes the press-origin guard above exact).
                  // `paddingBottom` lets the last entries scroll clear of the
                  // button row, which is lifted over the dropdown by zIndex.
                  ? React.createElement('div', { style: { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, marginTop: 6, paddingBottom: 36, background: v('--dsw-alias-bg-overlay', '#1e1e1e'), color: T.label, border: '1px solid ' + T.borderStrong, borderRadius: 8, maxHeight: 200, overflowY: 'auto', boxShadow: '0 6px 24px rgba(0,0,0,0.25)' } },
                      // Issue #52 defect 1, local belt-and-braces: swallow the
                      // gesture so no ancestor (least of all the backdrop) can
                      // observe a click that began on a suggestion.
                      suggest.map((s, i) => React.createElement('div', { key: s + i, className: 'dsh-rw-list-item', onMouseDown: (e) => { e.preventDefault(); e.stopPropagation(); selectSuggestion(s) }, style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, s)),
                    )
                  : null,
              ),
              popOpen ? renderDirPopup() : null,
              err ? React.createElement('div', { style: { color: T.danger, fontSize: 12 } }, err) : null,
              registerWorkspace !== false ? h('label', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' } },
                h('input', { type: 'checkbox', checked: mapLocal, onChange: e => setMapLocal(e.target.checked), disabled: mappingBusy }),
                tr('mapping.check')) : null,
              mapLocal && registerWorkspace !== false ? h(LocalMappingDirectory, {
                value: mappedPath, onChange: setMappedPath, onError: setErr,
              }) : null,
              // The action row rides ABOVE the dropdown (zIndex 70) on its own
              // opaque layer, so the list slides out from behind it instead of
              // covering 「设为远程工作区」.
              React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', position: 'relative', zIndex: 70, background: v('--dsw-alias-bg-layer-1', '#18181b') } },
                React.createElement('span', { style: { fontSize: 11, opacity: 0.75, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } }, path ? tr('picker.selected', { path }) : ''),
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: primaryBtnS, onClick: () => commitPath(path), disabled: busy || mappingBusy || !machineId || !path.trim() || (mapLocal && !mappedPath.trim()) }, busy || mappingBusy ? tr('picker.mirroring') : tr('picker.setRemoteWs')),
              ),
            ),
        React.createElement('div', { style: { fontSize: 11, opacity: 0.55, paddingTop: 8 } }, tr('picker.hintKeys')),
        (tab === 'local') ? React.createElement('div', { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } }, React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: buttonS, onClick: onCancel }, tr('picker.cancel'))) : null,
        mappingConfirm.node,
        mkdirPrompt ? React.createElement(PromptDialog, {
          title: tr('picker.newDirName', { path: mkdirPrompt.base || '/' }),
          placeholder: tr('explorer.namePlaceholder'),
          onSubmit: confirmMkdirHere,
          onCancel: () => setMkdirPrompt(false),
        }) : null,
        ),
      ))
    }

    // ── better-sidebar integration (optional) ────────────────────────────────
    // One descriptor only: the explorer page. The per-file viewer is a native
    // resource type, never a better-sidebar card (see registerSidebarIntegration).
    const SIDEBAR_EXPLORER_ID = 'dsh-remote:explorer'

    // Issue #78: durable opt-out for the sidebar auto-open. The in-memory
    // autoOpenedFor set forgetting across restarts is by design; THIS key is
    // the user's persistent "别再给我弹远程文件面板". Browser-local because the
    // feature itself is browser-local. Default ON preserves the behaviour
    // existing users know — only an explicit uncheck turns it off.
    const EXPLORER_AUTO_OPEN_KEY = 'dsh-remote:explorerAutoOpen'
    function explorerAutoOpenEnabled() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return true
        return window.localStorage.getItem(EXPLORER_AUTO_OPEN_KEY) !== '0'
      } catch { return true }
    }

    function fetchRemoteStatus(sessionId) {
      return api('GET', withSessionQuery('/dsh-remote/status', sessionId)).catch(() => null)
    }

    // Resolve the remote path this session shows. Issue #13: the ONLY source
    // of truth is the session's own cwd mapped through /dsh-remote/resolve-
    // mirror — a cwd outside any mirror dir means "this session is NOT a
    // remote session", and the sidebar must NOT fall back to the machine
    // workspace (that made an unrelated saved machine leak into local
    // sessions).
    function resolveSessionRemote(sessionId) {
      if (!sessionId) return Promise.resolve('')
      // 1) Prefer the client-side session list cwd (mirror dir under
      //    $DSH_HOME/remote-workspaces/...) passed as ?local=.
      let local = ''
      try {
        const list = SESSIONS && SESSIONS.list && typeof SESSIONS.list.getSnapshot === 'function'
          ? SESSIONS.list.getSnapshot()
          : null
        const entry = list && list.byId && list.byId[sessionId]
        if (entry && entry.cwd) local = String(entry.cwd)
      } catch { /* sessions store shape differs */ }
      if (local) {
        return api('GET', '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(local))
          .then((r) => (r && r.remotePath) || '')
          .catch(() => '')
      }
      // 2) Fall back to host-side session header cwd.
      return api('GET', '/dsh-remote/resolve-mirror?sessionId=' + encodeURIComponent(sessionId))
        .then((r) => (r && r.remotePath) || '')
        .catch(() => '')
    }

    // ── which sessions are remote (issue #49) ────────────────────────────────
    //
    // The sidebar must say, at a glance, whether a Session row is a LOCAL
    // session or one working on a remote host — and which host. The truth is
    // already on the client: every Session summary carries its own cwd, and a
    // cwd that lives inside a `$DSH_HOME/remote-workspaces/<host-user-port>/…`
    // mirror IS a remote session bound to that mirror's recorded origin (the
    // same invariant lib/binding.js uses host-side; see issue #13).
    //
    // So one GET /dsh-remote/bindings (the whole mirror registry, with each
    // mirror's recorded host/port/user/path) answers every row, instead of one
    // request per row. The active machine is deliberately NOT consulted: a saved
    // machine that happens to be "current" must never label a local session.
    //
    // Failure is not fatal and not retried in a loop: no registry means no
    // badge, which is exactly what a user with zero mirrors sees.

    const MIRRORS = { list: [], loaded: false, error: '' }
    const mirrorWatchers = new Set()
    let mirrorLoad = null
    let mirrorTimer = null

    const notifyMirrors = () => {
      for (const fn of mirrorWatchers) { try { fn() } catch { /* one watcher must not stop the rest */ } }
    }
    /** Load the mirror registry once (concurrent callers share the request). */
    function ensureMirrors() {
      if (MIRRORS.loaded) return Promise.resolve(MIRRORS)
      if (mirrorLoad) return mirrorLoad
      mirrorLoad = api('GET', '/dsh-remote/bindings')
        .then((r) => {
          MIRRORS.list = (r && Array.isArray(r.mirrors)) ? r.mirrors : []
          MIRRORS.error = ''
        })
        .catch((e) => { MIRRORS.error = String((e && e.message) || e) })
        .then(() => {
          MIRRORS.loaded = true
          mirrorLoad = null
          notifyMirrors()
          return MIRRORS
        })
      return mirrorLoad
    }
    /** Force a refresh (mirrors appear when a workspace is picked). */
    function refreshMirrors() {
      MIRRORS.loaded = false
      return ensureMirrors()
    }
    /**
     * The mirror containing a local path, or null.
     *
     * Separator-aware on purpose: `/a/mirror-2` must NOT be treated as living
     * inside `/a/mirror` (the same trap lib/binding.js documents). The deepest
     * match wins, so a future nested layout stays stable. Windows paths compare
     * case-insensitively because the platform does.
     */
    function mirrorForCwd(cwd, mirrors) {
      const raw = String(cwd || '')
      if (!raw) return null
      const list = Array.isArray(mirrors) ? mirrors : []
      const isWin = raw.includes('\\')
      const sep = isWin ? '\\' : '/'
      const fold = (s) => (isWin ? s.toLowerCase() : s)
      const base = fold(raw.replace(/[\\/]+$/, ''))
      let best = null
      for (const m of list) {
        const dirRaw = String((m && m.dir) || '').replace(/[\\/]+$/, '')
        if (!dirRaw) continue
        const dir = fold(dirRaw)
        if (base !== dir && !base.startsWith(dir + sep) && !base.startsWith(dir + '/')) continue
        if (!best || dir.length > fold(String(best.dir).replace(/[\\/]+$/, '')).length) best = m
      }
      return best
    }
    /** `user@host:port` for a mirror record (port omitted when it is 22). */
    function mirrorTarget(m) {
      if (!m) return ''
      const user = m.username ? m.username + '@' : ''
      const port = Number(m.port) && Number(m.port) !== 22 ? ':' + m.port : ''
      return user + String(m.host || '') + port
    }
    /** Host as the reader asked for it: the address, plus the saved machine name. */
    function mirrorLabel(m) {
      if (!m) return ''
      const target = mirrorTarget(m)
      return m.name && m.name !== m.host ? target + ' · ' + m.name : target
    }
    /**
     * The remote binding of one Session row, read from that row's own cwd.
     *
     * A row with no cwd (a blank New Session) is not remote — a blank session
     * has no workspace yet, and must never inherit the badge from a neighbor.
     *
     * Hook shape is CONSTANT: when the framework does not hand the entry a
     * `useSessions` (older sidebar), a stable no-op hook is selected instead of
     * skipping the call, so the hook count cannot change across renders (a
     * conditional hook is a crash, not a degraded badge).
     */
    const NO_SELECT = () => undefined
    function useSessionMirror(sessionId, useSessions) {
      // `mirrorVersion` is only a re-render trigger: the registry arrives
      // asynchronously, and every mounted mark must repaint when it does.
      const [, bumpMirrorVersion] = React.useState(0)
      const select = typeof useSessions === 'function' ? useSessions : NO_SELECT
      const cwd = select((s) => (sessionId && s && s.byId && s.byId[sessionId] ? s.byId[sessionId].cwd : undefined))
      React.useEffect(() => {
        const fn = () => bumpMirrorVersion((n) => n + 1)
        mirrorWatchers.add(fn)
        ensureMirrors()
        // Mirrors change when a remote workspace is picked in THIS tab; a slow
        // poll covers a pick made in another tab without a per-render request.
        if (!mirrorTimer && typeof setInterval === 'function') {
          mirrorTimer = setInterval(refreshMirrors, 60000)
        }
        return () => {
          mirrorWatchers.delete(fn)
          if (!mirrorWatchers.size && mirrorTimer) { clearInterval(mirrorTimer); mirrorTimer = null }
        }
      }, [])
      return mirrorForCwd(cwd, MIRRORS.list)
    }

    // Leading seat of a Session row: the 16px cell before the title. A green dot
    // means "this session works on a remote host"; a local session renders
    // nothing at all, so the cell stays blank exactly as before. The owner only
    // mounts this seat while the row is idle (a running/pending row keeps its
    // own status dot there) — the hover card below therefore carries the host
    // for every row, running or not.
    function RemoteSessionMark(props) {
      const m = useSessionMirror(props.sessionId, props.useSessions)
      if (!m) return null
      const target = mirrorTarget(m)
      return React.createElement('span', {
        'data-dsh-remote-mark': '',
        role: 'img',
        'aria-label': tr('session.remoteBadge', { target }),
        title: tr('session.remoteBadge', { target }) + (m.remotePath ? '\n' + m.remotePath : ''),
        style: { width: 16, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
      }, React.createElement('span', {
        'aria-hidden': 'true',
        style: {
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--dsw-alias-state-success-primary, #4caf7d)',
          boxShadow: '0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary, #4caf7d) 22%, transparent)',
        },
      }))
    }

    // Hover-card section of a Session row, between its relative time and its
    // trailing status line: names the remote host (and the remote path it
    // works on) for a remote row. A local row renders nothing.
    function RemoteSessionHover(props) {
      const m = useSessionMirror(props.sessionId, props.useSessions)
      if (!m) return null
      return React.createElement('div', { 'data-dsh-remote-hover': '', style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, lineHeight: '16px' } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          React.createElement('span', {
            'aria-hidden': 'true',
            style: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--dsw-alias-state-success-primary, #4caf7d)' },
          }),
          React.createElement('span', { style: { color: '#cfd3d6', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, mirrorLabel(m)),
        ),
        m.remotePath
          ? React.createElement('div', { style: { color: '#adb2b8', wordBreak: 'break-all', paddingLeft: 13 } }, m.remotePath)
          : null,
      )
    }

    // Conversation header chip for the CURRENT session: the one place the host
    // can stay visible without hovering anything (the row's 16px cell is too
    // narrow for an address). Renders nothing for a local session.
    //
    // This seat is session-scoped, so the owner hands the entry its `sessionId`
    // (exactly like the shipped "open in app" utility) and the chip needs
    // nothing from the sidebar.
    function RemoteSessionChip(props) {
      const m = useSessionMirror(props.sessionId, props.useSessions)
      if (!m) return null
      const target = mirrorTarget(m)
      return React.createElement('span', {
        'data-dsh-remote-chip': '',
        className: 'dsh-rw-pill is-ok',
        title: tr('session.remoteHover', { target }) + (m.remotePath ? '\n' + m.remotePath : ''),
        style: { maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-flex', alignItems: 'center', gap: 5 },
      },
        React.createElement('span', {
          'aria-hidden': 'true',
          style: { width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--dsw-alias-state-success-primary, #4caf7d)' },
        }),
        React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, target),
      )
    }

    function readRemoteFile(path, maxBytes, sessionId) {
      return api('POST', '/dsh-remote/read', withSessionBody({ path, maxBytes }, sessionId)).catch((e) => {
        throw new Error(tr('file.readFail', { msg: ((e && e.message) || e) }))
      })
    }

    function listRemoteDir(path, sessionId) {
      return api('GET', withSessionQuery('/dsh-remote/ls?path=' + encodeURIComponent(path || ''), sessionId)).catch((e) => {
        throw new Error(tr('file.listFail', { msg: ((e && e.message) || e) }))
      })
    }

    function joinRemote(base, name) {
      if (!base) return name
      return base.replace(/[\\/]+$/, '') + (base.includes('\\') ? '\\' : '/') + name
    }

    // ── Remote explorer tab ────────────────────────────────────────────────
    // Row glyphs: the host FileTypeIcon when the bundle ships one —
    // directories take its 'folder' kind (the host glyph has no open/closed
    // variant, matching our old SVG which drew the same path for both states),
    // files derive the kind from the file name (an unknown extension lands on
    // the 'other' glyph). Older hosts keep the inline monochrome SVGs
    // (fill: currentColor → follows the row text color, i.e. black on the
    // sidebar). The (open)/(name) parameters survive so call sites stay
    // meaningful on both paths.
    const IconFolder = (open) => HostFileTypeIcon
      ? React.createElement(HostFileTypeIcon, { kind: 'folder', size: 14 })
      : React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', style: { flexShrink: 0 },
      },
        React.createElement('path', { d: 'M1.5 3.5A1.5 1.5 0 0 1 3 2h3.2a1.5 1.5 0 0 1 1.06.44L8.5 3.7h4.5A1.5 1.5 0 0 1 14.5 5.2V12A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12V3.5Zm2.5 1a.5.5 0 0 0 0 1h1.2a.5.5 0 0 0 0-1H4Z' }),
      )
    const IconFile = (name) => HostFileTypeIcon
      ? React.createElement(HostFileTypeIcon, { path: String(name || ''), size: 14 })
      : React.createElement('svg', {
        width: 14, height: 14, viewBox: '0 0 16 16', fill: 'currentColor', style: { flexShrink: 0, opacity: 0.85 },
      },
        React.createElement('path', { d: 'M3.5 1.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.2a1 1 0 0 0-.29-.7L10.5 1.79a1 1 0 0 0-.7-.29H3.5Zm1.5 3h2.25a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5ZM5 9.5h6a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Zm0 2.25h4a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5Z' }),
      )

    // Issue #32: the remote tree's expansion list travels on the TAB (`meta`),
    // never on better-sidebar's session-shared `expanded` array. Best-effort:
    // an older sidebar without tab meta simply forgets the expansion on reload.
    const TAB_EXPANDED_META = 'remoteExpanded'
    /** The tab's persisted expansion list, or null when the tab records none
     *  (so a caller can tell "never expanded" from "expanded then collapsed
     *  everything"). */
    function readTabExpanded(tab) {
      try {
        const meta = tab && tab.meta
        if (!meta || typeof meta !== 'object' || !(TAB_EXPANDED_META in meta)) return null
        const list = meta[TAB_EXPANDED_META]
        return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : []
      } catch { return null }
    }
    /** Fallback store when the sidebar predates tab meta (no persistence then,
     *  but the tree still opens and closes within the page's lifetime). */
    const tabExpandedFallback = new Map()
    function tabExpandedOf(tab) {
      const fromMeta = readTabExpanded(tab)
      if (fromMeta !== null) return fromMeta
      const id = tab && tab.id
      return (id && tabExpandedFallback.get(id)) || []
    }
    function toggleTabExpanded(ctx, tab, path) {
      const cur = tabExpandedOf(tab)
      const next = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]
      const id = tab && tab.id
      if (id) tabExpandedFallback.set(id, next)
      try {
        if (!ctx || !tab || !id || typeof ctx.get !== 'function') return next
        const bs = ctx.get('betterSidebar')
        if (!bs || typeof bs.updateTab !== 'function') return next
        const meta = tab.meta && typeof tab.meta === 'object' ? tab.meta : {}
        bs.updateTab(id, { meta: { ...meta, [TAB_EXPANDED_META]: next } })
      } catch { /* expansion memory is best-effort */ }
      return next
    }

    // Issue #32 healing, kept pure so it is directly testable: an older
    // dsh-remote pushed REMOTE paths into better-sidebar's session-shared
    // `expanded` set through onToggleDir. That set is PERSISTED (localStorage
    // `dsh-sidebar:v1:<sessionId>`) and the built-in local Files tree loads
    // every entry through a LOCAL fs.realpath, so those remote paths kept
    // failing with ENOENT until the set was cleaned.
    //
    // Return exactly the entries this tree owns: the current remote root and
    // anything under it. That range is remote-only by construction (the root
    // comes from resolve-mirror), so a legitimate local directory cannot
    // match. A LOCAL MIRROR path is never evicted — on a host whose own home is
    // an ancestor of the remote root (a macOS host driving a macOS remote) the
    // mirror under $DSH_HOME/remote-workspaces would otherwise fall inside it.
    //
    // On a WINDOWS host the sweep is broader and complete: a POSIX-absolute
    // entry (`/home/...`) can never be a valid local path there (Windows paths
    // are drive- or UNC-rooted), which is exactly why the bug only bit Windows.
    // That also cleans pollution left by an earlier remote root, which no
    // per-root rule could find.
    function isPosixAbsolutePath(p) {
      return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')
    }
    function windowsHost() {
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null
        if (!nav) return false
        if (nav.userAgentData && typeof nav.userAgentData.platform === 'string') {
          return /win/i.test(nav.userAgentData.platform)
        }
        if (typeof nav.platform === 'string' && nav.platform) return /win/i.test(nav.platform)
        return typeof nav.userAgent === 'string' && /windows/i.test(nav.userAgent)
      } catch { return false }
    }
    function strayRemoteSharedPaths(root, shared, hostIsWindows = windowsHost()) {
      if (!Array.isArray(shared) || !shared.length) return []
      let prefix = ''
      if (typeof root === 'string' && root !== '' && root !== '/') prefix = root.replace(/[\\/]+$/, '')
      const isMirror = (p) => p.includes('/remote-workspaces/') || p.includes('\\remote-workspaces\\')
      return shared.filter((p) => {
        if (typeof p !== 'string' || p === '' || isMirror(p)) return false
        if (prefix !== '' && (p === prefix || p === root ||
          p.startsWith(prefix + '/') || p.startsWith(prefix + '\\'))) return true
        return hostIsWindows && isPosixAbsolutePath(p)
      })
    }

    // Issue #32: the remote tree must NOT use better-sidebar's `expanded` /
    // `onToggleDir` props. That pair is the SESSION-shared expansion set, which
    // the built-in local Files tree also reads and loads as local directories
    // through /sidebar/api fs.tree. Feeding it remote paths (/home/...) made the
    // core tree run a LOCAL fs.realpath on them; on win32 a POSIX path counts as
    // absolute (drive-rooted), so it resolved to `D:\home\...` and failed with
    // ENOENT. Own the expansion here and persist it on the tab instead.
    //
    // Because that shared set is PERSISTED, an already-affected user stays
    // broken across reloads, so the stray entries are also migrated eagerly (see
    // migratePollutedSidebarState) and healed again from the tab (below).
    const SIDEBAR_STATE_PREFIX = 'dsh-sidebar:v1:'
    /**
     * Strip remote paths a pre-fix dsh-remote left in PERSISTED sidebar state,
     * before the built-in Files tree loads them. Only entries that cannot be a
     * valid local path on this host are removed (see strayRemoteSharedPaths).
     * Best-effort: any storage failure just leaves the tab-level healing to do
     * the job on the next load.
     *
     * @param storage - a Storage-like object (window.localStorage).
     * @param hostIsWindows - overrides host detection (tests).
     * @returns how many stray entries were removed.
     */
    function migratePollutedSidebarState(storage, hostIsWindows = windowsHost()) {
      if (!storage || typeof storage.length !== 'number') return 0
      let cleaned = 0
      try {
        const keys = []
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (key && key.startsWith(SIDEBAR_STATE_PREFIX)) keys.push(key)
        }
        for (const key of keys) {
          const raw = storage.getItem(key)
          if (typeof raw !== 'string' || raw === '') continue
          let parsed
          try { parsed = JSON.parse(raw) } catch { continue }
          if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.expanded)) continue
          const stray = strayRemoteSharedPaths('', parsed.expanded, hostIsWindows)
          if (!stray.length) continue
          const drop = new Set(stray)
          parsed.expanded = parsed.expanded.filter((p) => !drop.has(p))
          storage.setItem(key, JSON.stringify(parsed))
          cleaned += stray.length
        }
      } catch { /* storage unavailable: the tab-level healing still runs */ }
      return cleaned
    }

    // `evictStray` heals state an older dsh-remote already polluted: the tree
    // calls it once it knows its remote root, and it drops exactly those paths
    // from the shared set. It is a plain function (not an effect) so the rule is
    // directly testable.
    function RemoteExplorerTabOwned(props) {
      const [expanded, setExpanded] = React.useState(tabExpandedOf(props.tab))
      const sharedExpanded = Array.isArray(props.expanded) ? props.expanded : []
      const evictShared = typeof props.onToggleDir === 'function' ? props.onToggleDir : null
      // Heal without needing the remote root: on a Windows host a POSIX-absolute
      // entry can never be a valid local path, so the sweep is complete there.
      // (The root-scoped sweep for the session's own remote tree runs inside the
      // tab, which is where the resolved root becomes known.)
      const sharedKey = sharedExpanded.join('\u0000')
      React.useEffect(() => {
        if (!evictShared) return
        const stray = strayRemoteSharedPaths('', sharedKey ? sharedKey.split('\u0000') : [])
        for (const p of stray) evictShared(p)
      }, [sharedKey, evictShared])
      // Explicitly drop the framework's session-shared pair from the child.
      const owned = { ...props }
      delete owned.expanded
      delete owned.onToggleDir
      return React.createElement(RemoteExplorerTab, {
        ...owned,
        evictStray: (root) => {
          if (!evictShared || !sharedExpanded.length) return []
          const stray = strayRemoteSharedPaths(root, sharedExpanded)
          for (const p of stray) evictShared(p)
          return stray
        },
        expanded,
        onToggleDir: (path) => setExpanded(toggleTabExpanded(props.ctx, props.tab, path)),
      })
    }

    // Tree-style remote file explorer. Data is listed live from the remote host
    // over /dsh-remote/ls, rooted at this session's remote workspace dir.
    function RemoteExplorerTab(props) {
      const [status, setStatus] = React.useState(null)
      const [root, setRoot] = React.useState('') // remote root path for this session
      const [data, setData] = React.useState({}) // dir -> { entries | error | loading }
      const dataRef = React.useRef(data)
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [picker, setPicker] = React.useState(false)
      const [menu, setMenu] = React.useState(null) // { x, y, path, isDir, name }
      const [rootOpen, setRootOpen] = React.useState(true) // first level expanded by default
      const [hoverPath, setHoverPath] = React.useState('') // row hover highlight
      /** Row whose path was just copied — shows a brief「已复制」label. */
      const [copiedPath, setCopiedPath] = React.useState('')
      const [namePrompt, setNamePrompt] = React.useState(null) // { kind, path, name }
      const confirmUi = useConfirm()
      React.useEffect(() => { ensureChromeCss() }, [])
      const expanded = Array.isArray(props.expanded) ? props.expanded : []
      const scopeCwd = props.scope && props.scope.cwd
      const sessionId = props.scope && props.scope.sessionId

      const storeLevel = (path, level) => {
        dataRef.current = { ...dataRef.current, [path]: level }
        setData(dataRef.current)
      }

      const loadDir = React.useCallback((dir, opts) => {
        const cur = dataRef.current
        const existing = cur[dir]
        // If we already have data (entries loaded) and this is a background
        // refresh, keep what we have — don't flash a loading state over a
        // populated tree.
        if (existing && !existing.loading && opts && opts.keep) return
        if (cur[dir] !== undefined && !cur[dir].loading) return
        storeLevel(dir, { loading: true })
        listRemoteDir(dir, sessionId)
          .then((res) => {
            const items = Array.isArray(res && res.items) ? res.items : []
            const sorted = items.slice().sort((a, b) => {
              if (a.type === 'dir' && b.type !== 'dir') return -1
              if (a.type !== 'dir' && b.type === 'dir') return 1
              return String(a.name).localeCompare(String(b.name))
            })
            storeLevel(dir, { entries: sorted })
          })
          .catch((e) => {
            // Keep any previously-loaded entries under this dir (so a transient
            // SFTP failure doesn't collapse the whole subtree); surface a
            // message only when there was nothing to show before.
            const prev = dataRef.current[dir]
            if (prev && prev.entries) {
              storeLevel(dir, { ...prev, softError: String((e && e.message) || e) })
            } else {
              storeLevel(dir, { error: String((e && e.message) || e) })
            }
          })
      }, [sessionId])

      // Resolve this session's remote root, then load it and every expanded dir.
      // Re-runs whenever the session scope changes (switching conversations, or
      // the async sessionCwd fetch landing), so the sidebar follows the session's
      // own workspace dir.
      const rootRef = React.useRef('')
      const refreshStatus = React.useCallback((opts) => {
        const applyRoot = (r, connected) => {
          const prevRoot = rootRef.current
          rootRef.current = r
          setRoot(r)
          // Full reset ONLY when the session's remote root actually changed
          // (different workspace / different conversation). When we just come
          // back to this tab with the same workspace, keep the loaded tree so
          // expanded dirs and their contents stay put.
          const sameRoot = prevRoot && r && prevRoot === r
          if (!sameRoot) {
            setData({})
            dataRef.current = {}
          }
          if (r) {
            // Not connected (e.g. freshly restarted, machine no longer active):
            // show a clear disconnected state instead of firing ls requests
            // that all fail with AggregateError / 500 in a loop.
            // A bound remote session lists on demand even if this process has
            // not yet opened the SSH socket; only an unbound/disconnected
            // machine-scoped view should show the empty "未连接" state.
            if (!connected && !sessionId) {
              storeLevel(r, { error: tr('explorer.notConnected') })
              return
            }
            if (!sameRoot) {
              storeLevel(r, { loading: true })
            }
            listRemoteDir(r, sessionId)
              .then((res) => {
                const items = Array.isArray(res && res.items) ? res.items : []
                const sorted = items.slice().sort((a, b) => {
                  if (a.type === 'dir' && b.type !== 'dir') return -1
                  if (a.type !== 'dir' && b.type === 'dir') return 1
                  return String(a.name).localeCompare(String(b.name))
                })
                storeLevel(r, { entries: sorted, missing: !!(res && res.missing) })
                for (const dir of expanded) loadDir(dir, { keep: true })
              })
              .catch((e) => {
                // Transient connection failure: keep the previously visible
                // root level so the tree doesn't collapse to an error.
                const prev = dataRef.current[r]
                if (prev && prev.entries) {
                  storeLevel(r, { ...prev, softError: String((e && e.message) || e) })
                } else {
                  storeLevel(r, { error: String((e && e.message) || e) })
                }
              })
          }
        }
        const resolveRoot = () => {
          if (scopeCwd) {
            return api('GET', '/dsh-remote/resolve-mirror?local=' + encodeURIComponent(scopeCwd))
              .then((r) => (r && r.remotePath) || '')
              .catch(() => '')
          }
          if (sessionId) return resolveSessionRemote(sessionId)
          return Promise.resolve('')
        }
        resolveRoot().then((r) => {
          fetchRemoteStatus(sessionId).then((s) => {
            setStatus(s)
            // Issue #13: NEVER fall back to the machine-level workspace here —
            // a session whose cwd is not a mirror is a LOCAL session and shows
            // the "no remote workspace" empty state instead.
            applyRoot(r || '', !!(s && s.connected))
          })
        })
      }, [scopeCwd, sessionId])

      React.useEffect(() => { refreshStatus() }, [refreshStatus])
      React.useEffect(() => { if (props.visible) refreshStatus({ visible: true }) }, [props.visible])
      // Load dirs as they get expanded (keep already-loaded content).
      React.useEffect(() => { if (root) for (const dir of expanded) loadDir(dir, { keep: true }) }, [root, expanded, loadDir])
      // Issue #32 healing: once the remote root is known, drop the paths an
      // older dsh-remote left in better-sidebar's PERSISTED session-shared
      // expansion set (the built-in local tree was loading them through a local
      // fs.realpath and failing). See strayRemoteSharedPaths().
      React.useEffect(() => {
        if (root && typeof props.evictStray === 'function') props.evictStray(root)
      }, [root, props.evictStray])
      /** Shared dispatch for the context menu (host Menu or the DOM fallback). */
      const runMenuAction = (id, m) => {
        if (!m) return
        if (id === 'open') { if (m.isDir) { if (props.onToggleDir) props.onToggleDir(m.path) } else openFile(m.path); return }
        if (id === 'download') { doFs('download', { path: m.path }); return }
        if (id === 'copy-rel') { copyPath(relPath(m.path), m.path); return }
        if (id === 'copy-abs') { copyPath(m.path, m.path); return }
        if (id === 'rename') { setNamePrompt({ kind: 'rename', path: m.path, name: m.name }); return }
        if (id === 'delete') { confirmUi.ask(tr('explorer.deleteConfirm', { path: m.path })).then((ok) => { if (ok) doFs('remove', { path: m.path }, true) }) }
      }
      // ── Context-menu portal: append to document.body so the sidebar's
      //    overflow/transform cannot clip it. Pure DOM, no React portal needed.
      //    Only the FALLBACK when the host ships no Menu primitive: the main
      //    path renders HostMenu (anchored, body-portaled, keyboard-navigable).
      React.useEffect(() => {
        if (!menu || HostMenu) return
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;z-index:999999;pointer-events:auto'
        const box = document.createElement('div')
        box.style.cssText = 'position:fixed;left:' + menu.x + 'px;top:' + menu.y + 'px;z-index:999999;background:var(--dsw-alias-bg-overlay,#1f1f23);border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,0.5));border-radius:8px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.4);min-width:170px;font-family:system-ui,sans-serif;color:var(--dsw-alias-label-primary,#e4e4e7)'
        const mkItem = (label, danger, fn) => {
          const d = document.createElement('div')
          d.textContent = label
          d.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:12px;color:' + (danger ? 'var(--dsw-static-red-400,#e06c75)' : 'inherit') + ';border-radius:4px;white-space:nowrap;transition:background 0.1s'
          d.onmouseenter = () => { d.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,0.14))' }
          d.onmouseleave = () => { d.style.background = 'transparent' }
          d.addEventListener('click', (e) => { e.stopPropagation(); setMenu(null); fn() })
          return d
        }
        box.appendChild(mkItem(menu.isDir ? tr('explorer.menuExpand') : tr('explorer.menuOpen'), false, () => runMenuAction('open', menu)))
        box.appendChild(mkItem(tr('explorer.menuDownload'), false, () => runMenuAction('download', menu)))
        box.appendChild(mkItem(tr('explorer.menuCopyRel'), false, () => runMenuAction('copy-rel', menu)))
        box.appendChild(mkItem(tr('explorer.menuCopyAbs'), false, () => runMenuAction('copy-abs', menu)))
        box.appendChild(mkItem(tr('explorer.menuRename'), false, () => runMenuAction('rename', menu)))
        box.appendChild(mkItem(menu.isDir ? tr('explorer.menuDeleteDir') : tr('explorer.menuDelete'), true, () => runMenuAction('delete', menu)))
        host.appendChild(box)
        document.body.appendChild(host)
        const close = (e) => { if (!box.contains(e.target)) { setMenu(null) } }
        // Delay adding listener so the same mousedown that opened the menu doesn't close it
        const tid = setTimeout(() => document.addEventListener('mousedown', close), 0)
        return () => { clearTimeout(tid); document.removeEventListener('mousedown', close); host.remove() }
        // confirmUi.ask is stable (useCallback); depending on the wrapper object
        // would rebuild the menu DOM on every render.
      }, [menu, confirmUi.ask])

      // Open one remote file. The viewer is a RESOURCE tab type: the address
      // names the file, and the HOST's tab registry picks the type that claims
      // it (ours, `dsh-resource://dsh-remote/**`). That is the same call the
      // native explorer makes through `onOpenFile`, so one file behaves
      // identically in both compositions — and it needs no better-sidebar
      // descriptor, whose only effect would have been a switch that unregisters
      // the viewer.
      const openFile = (p) => {
        if (props.onOpenFile) { props.onOpenFile(p); return }
        const sessionId = (props.scope && props.scope.sessionId) || ''
        try {
          const right = props.ctx && props.ctx.get && props.ctx.get('sidebarRight')
          if (right && typeof right.openResource === 'function') {
            right.openResource(remoteFileAddress(sessionId, p))
            return
          }
        } catch (e) {
          console.warn('[dsh-remote] remote file open failed:', e)
          return
        }
        console.warn('[dsh-remote] no right-sidebar resource opener; remote file not opened')
      }

      const doFs = (op, payload, refreshParent) => {
        setBusy(op)
        return api('POST', '/dsh-remote/fs', withSessionBody({ op, ...payload }, sessionId))
          .then(() => {
            setErr('')
            if (refreshParent) {
              dataRef.current = {}
              setData({})
              if (root) { storeLevel(root, { loading: true }); loadDir(root) }
              for (const dir of expanded) loadDir(dir)
            }
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setBusy(''))
      }

      const onCtx = (e, path, isDir, name) => {
        e.preventDefault(); e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY, path, isDir, name })
      }
      const ctxItem = (label, danger, fn) => React.createElement('div', {
        onClick: (e) => { e.stopPropagation(); setMenu(null); fn() },
        className: 'dsh-rw-list-item',
        style: { padding: '6px 10px', cursor: 'pointer', fontSize: 12, color: danger ? T.danger : T.label, borderRadius: 4, whiteSpace: 'nowrap' },
      }, label)

      // The path shown by「复制相对地址」: relative to this session's remote
      // workspace root (mirror of the built-in local tree's cwd-relative copy).
      const relPath = (p) => {
        if (!root) return p
        const r = String(root).replace(/[\\/]+$/, '')
        const s = String(p)
        if (s === r) return '.'
        if (s.startsWith(r + '/')) return s.slice(r.length + 1)
        if (s.startsWith(r + '\\')) return s.slice(r.length + 1)
        return s
      }
      // Copy `text`, then briefly flag the row whose path was copied.
      const copyPath = (text, path) => {
        copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopiedPath(path)
          window.setTimeout(() => {
            setCopiedPath((cur) => (cur === path ? '' : cur))
          }, 1200)
        })
      }
      /** Trailing「已复制」feedback for a row (after a successful copy). */
      const copiedMark = (path) => (copiedPath === path
        ? React.createElement('span', { style: { fontSize: 11, opacity: 0.75, flexShrink: 0, color: T.ok } }, tr('explorer.copied'))
        : null)

      // One tree row (dir toggles via the framework's onToggleDir; file opens).
      // Text uses the normal foreground (theme-following) — no accent green.
      const row = (entry, depth) => {
        const pad = depth * 22 + 6
        const hovered = hoverPath === entry.path
        const base = {
          display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: pad,
          borderRadius: 5, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', transition: 'background 0.12s ease',
          background: hovered ? 'rgba(128,128,128,0.14)' : 'transparent',
          color: T.label,
        }
        if (entry.type === 'dir') {
          const isOpen = expanded.includes(entry.path)
          return React.createElement('div', { key: entry.path },
            React.createElement('div', {
              role: 'button', tabIndex: 0,
              onClick: () => { if (props.onToggleDir) props.onToggleDir(entry.path) },
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (props.onToggleDir) props.onToggleDir(entry.path) } },
              onContextMenu: (e) => onCtx(e, entry.path, true, entry.name),
              onMouseEnter: () => setHoverPath(entry.path),
              onMouseLeave: () => setHoverPath((p) => (p === entry.path ? '' : p)),
              style: base,
              title: entry.path,
            },
              React.createElement('span', { style: { flexShrink: 0, color: T.label, display: 'inline-flex' } }, IconFolder(isOpen)),
              React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, fontWeight: 500 } }, entry.name),
              copiedMark(entry.path),
            ),
            isOpen ? renderLevel(entry.path, depth + 1) : null,
          )
        }
        return React.createElement('div', {
          role: 'button', tabIndex: 0, key: entry.path,
          onClick: () => openFile(entry.path),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFile(entry.path) } },
          onContextMenu: (e) => onCtx(e, entry.path, false, entry.name),
          onMouseEnter: () => setHoverPath(entry.path),
          onMouseLeave: () => setHoverPath((p) => (p === entry.path ? '' : p)),
          style: base,
          title: entry.path,
        },
          React.createElement('span', { style: { flexShrink: 0, display: 'inline-flex' } }, IconFile(entry.name)),
          React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, entry.name),
          copiedMark(entry.path),
          (entry.size != null || entry.mtime)
            ? React.createElement('span', { style: { fontSize: 11, opacity: 0.55, flexShrink: 0, fontFamily: 'monospace' } },
                humanSize(entry.size) + (entry.mtime ? '  ' + fmtTime(entry.mtime) : ''))
            : null,
        )
      }

      const renderLevel = (dir, depth) => {
        const level = data[dir]
        if (level === undefined || (level.loading && !level.entries)) {
          return React.createElement('div', { key: dir + ':loading', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 13, opacity: 0.6 } }, tr('explorer.loading'))
        }
        if (level.missing) {
          return React.createElement('div', { key: dir + ':missing', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 13, opacity: 0.6 } }, tr('explorer.dirMissing'))
        }
        if (level.error !== undefined) {
          return React.createElement('div', { key: dir + ':err', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 13, color: T.danger } }, level.error)
        }
        const items = level.entries || []
        const soft = level.softError
            ? React.createElement('div', { key: dir + ':softerr', style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: depth * 22 + 6, fontSize: 11, opacity: 0.6, color: T.warn } }, tr('explorer.softError', { msg: level.softError }))
          : null
        if (!items.length) return soft || null
        return React.createElement('div', { key: dir + ':list' },
          items.map((it) => row({ ...it, path: joinRemote(dir, it.name) }, depth)),
          soft,
        )
      }

      const rootName = root ? String(root).split(/[\\/]/).filter(Boolean).pop() || root : ''
      const rootLevel = data[root]

      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
        React.createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid ' + T.border } },
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '3px 8px', fontSize: 12 }, onClick: refreshStatus, title: tr('explorer.refresh') }, '↻'),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-rw-btn',
            style: { ...buttonS, padding: '3px 8px', fontSize: 12 },
            onClick: () => setNamePrompt({ kind: 'mkdir', path: root || '/', name: '' }),
          }, tr('explorer.newDir')),
          React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '3px 8px', fontSize: 12 }, onClick: () => setPicker(true) }, tr('explorer.more')),
        ),
        status && status.workspace && root
          ? React.createElement('div', { style: { fontSize: 11, opacity: 0.7, padding: '4px 8px', wordBreak: 'break-all' } }, tr('explorer.remoteWs', { path: root, host: (status.host ? tr('explorer.hostTag', { user: status.username, host: status.host }) : '') }))
          : React.createElement('div', { style: { fontSize: 11, opacity: 0.7, padding: '4px 8px' } }, root ? tr('explorer.noRemoteWs') : tr('explorer.sessionLocal')),
        picker ? React.createElement('div', { style: { padding: 8 } }, React.createElement(DirPicker, {
          open: true, busy: false, registerWorkspace: false, onPicked: () => { setPicker(false); refreshStatus() }, onCancel: () => setPicker(false),
        })) : null,
        React.createElement('div', { style: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '2px 0' } },
          !root
            ? React.createElement('div', { style: { opacity: 0.6, padding: 12, fontSize: 13 } }, tr('explorer.localSession'))
            : React.createElement('div', { key: root },
                React.createElement('div', {
                  role: 'button', tabIndex: 0,
                  onClick: () => setRootOpen((v) => !v),
                  onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRootOpen((v) => !v) } },
                  onContextMenu: (e) => onCtx(e, root, true, rootName),
                  style: { display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', paddingLeft: 6, borderRadius: 5, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: T.label, fontWeight: 600 },
                  title: root,
                },
                  React.createElement('span', { style: { flexShrink: 0, color: T.label, display: 'inline-flex' } }, IconFolder(rootOpen)),
                  React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 } }, rootName || root),
                ),
                rootLevel && rootOpen ? renderLevel(root, 1) : null,
              ),
        ),
        // context menu — host Menu primitive when available (anchored at the
        // pointer, body-portaled), otherwise the DOM portal in the effect above
        menu && HostMenu ? React.createElement(HostMenu, {
          open: true,
          portal: true,
          getAnchorRect: () => ({ left: menu.x, top: menu.y, right: menu.x, bottom: menu.y, width: 0, height: 0 }),
          items: [
            { id: 'open', label: menu.isDir ? tr('explorer.menuExpand') : tr('explorer.menuOpen') },
            { id: 'download', label: tr('explorer.menuDownload') },
            { id: 'copy-rel', label: tr('explorer.menuCopyRel') },
            { id: 'copy-abs', label: tr('explorer.menuCopyAbs') },
            { id: 'rename', label: tr('explorer.menuRename') },
            { id: 'delete', label: menu.isDir ? tr('explorer.menuDeleteDir') : tr('explorer.menuDelete'), danger: true },
          ],
          onSelect: (id) => { const m = menu; setMenu(null); runMenuAction(id, m) },
          onClose: () => setMenu(null),
        }) : null,
        confirmUi.node,
        err ? React.createElement('div', { style: { color: T.danger, fontSize: 12, padding: '4px 8px' } }, (busy ? tr('explorer.busy') : '') + err) : null,
        namePrompt ? React.createElement(PromptDialog, {
          title: namePrompt.kind === 'rename' ? tr('explorer.renameTitle') : tr('explorer.mkdirTitle'),
          initial: namePrompt.name || '',
          placeholder: namePrompt.kind === 'rename' ? tr('explorer.renamePrompt') : tr('explorer.namePlaceholder'),
          onCancel: () => setNamePrompt(null),
          onSubmit: (nm) => {
            const name = String(nm || '').trim()
            const cur = namePrompt
            setNamePrompt(null)
            if (!name) return
            if (cur.kind === 'rename') {
              if (name === cur.name) return
              doFs('rename', { path: cur.path, dest: joinRemote(String(cur.path).replace(/[\\/][^\\/]*$/, ''), name) }, true)
            } else {
              doFs('mkdir', { path: joinRemote(cur.path, name) }, true)
            }
          },
        }) : null,
      )
    }

    // ── Remote file tab (opened by the explorer; live read + explicit edit) ──
    function RemoteFileTab(props) {
      const { tab, scope } = props
      const path = tab.path || ''
      const fileSessionId = scope && scope.sessionId
      const [data, setData] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [edit, setEdit] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [saving, setSaving] = React.useState(false)
      React.useEffect(() => { ensureChromeCss() }, [])

      const originalText = (data && data.content != null ? data.content : '').replace(/\n…\[truncated:.*$/, '')
      const dirty = edit && draft !== originalText

      const load = () => {
        if (!path) { setLoading(false); return }
        let cancelled = false
        setLoading(true); setErr(''); setData(null); setEdit(false)
        readRemoteFile(path, 256 * 1024, fileSessionId)
          .then((d) => { if (!cancelled) { setData(d); setLoading(false) } })
          .catch((e) => { if (!cancelled) { setErr(String((e && e.message) || e)); setLoading(false) } })
        return () => { cancelled = true }
      }
      React.useEffect(load, [path])

      const startEdit = () => {
        if (!data || data.binary || data.image) return
        setDraft((data.content != null ? data.content : '').replace(/\n…\[truncated:.*$/, ''))
        setEdit(true); setErr('')
      }
      const saveRemote = () => {
        setSaving(true); setErr('')
        apiRaw('POST', '/dsh-remote/write', withSessionBody({ path, content: draft, expectedMtime: data && data.mtime }, fileSessionId))
          .then((r) => {
            if (r.status === 409) {
              setErr(String((r.data && r.data.error) || tr('file.conflict')))
              return
            }
            if (r.status >= 400) throw new Error((r.data && (r.data.error || r.data.message)) || 'HTTP ' + r.status)
            setEdit(false)
            load()
          })
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setSaving(false))
      }
      const downloadMirror = () => {
        setSaving(true); setErr('')
        api('POST', '/dsh-remote/fs', withSessionBody({ op: 'download', path }, fileSessionId))
          .then((r) => setErr(tr('file.downloaded', { local: (r && r.local ? tr('file.downloadedAt', { path: r.local }) : '') })))
          .catch((e) => setErr(String((e && e.message) || e)))
          .finally(() => setSaving(false))
      }

      const baseName = path.split(/[\\/]/).pop() || path
      const isMarkdown = /\.(md|markdown)$/i.test(baseName)
      return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: T.label } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid ' + T.border, fontSize: 12 } },
          React.createElement('span', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, '📄 ' + baseName),
          React.createElement('code', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.75 } }, path),
          dirty ? React.createElement('span', { className: 'dsh-rw-pill', style: { color: T.warn } }, tr('file.dirty')) : null,
          React.createElement('span', { style: { opacity: 0.7, fontSize: 11, flexShrink: 0 } }, edit ? tr('file.editing') : tr('file.readonly')),
          edit
            ? React.createElement(React.Fragment, null,
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn dsh-rw-primary', style: { ...primaryBtnS, padding: '2px 10px', fontSize: 12 }, onClick: saveRemote, disabled: saving || !dirty, title: tr('file.saveHint') }, saving ? tr('file.saving') : tr('file.saveToRemote')),
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 10px', fontSize: 12 }, onClick: () => { setEdit(false); setErr('') } }, tr('file.cancel')))
            : React.createElement(React.Fragment, null,
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 10px', fontSize: 12 }, onClick: startEdit, disabled: !data || data.binary || data.image }, tr('file.edit')),
                React.createElement('button', { type: 'button', className: 'dsh-rw-btn', style: { ...buttonS, padding: '2px 10px', fontSize: 12 }, onClick: downloadMirror, disabled: saving }, tr('file.download'))),
        ),
        React.createElement('div', { style: { flex: 1, overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column' } },
          err ? React.createElement('div', { style: { color: T.danger, padding: '8px 12px', fontSize: 13, flexShrink: 0 } }, err) : null,
          loading ? React.createElement('div', { style: { opacity: 0.7, padding: 12, fontSize: 13 } }, tr('file.loading'))
            : (data && data.binary
                  ? React.createElement('div', { style: { padding: 12, fontSize: 13, color: T.warn } },
                      tr('file.binary', { size: (data.size != null ? data.size + ' bytes' : tr('file.unknownSize')) }))
                  : data && data.image
                    ? React.createElement('div', { style: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, minHeight: 0 } },
                        React.createElement('img', { src: `data:${data.mime};base64,${data.content}`, alt: baseName, style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } }))
                    : (edit
                      ? React.createElement('textarea', {
                          value: draft,
                          onChange: (e) => setDraft(e.target.value),
                          onKeyDown: (e) => {
                            if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); if (!saving && dirty) saveRemote() }
                            if (e.key === 'Escape') { e.preventDefault(); setEdit(false); setErr('') }
                          },
                          spellCheck: false,
                          style: { width: '100%', height: '100%', flex: 1, boxSizing: 'border-box', border: 'none', outline: 'none', resize: 'none', background: 'transparent', color: T.label, fontSize: 13, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
                        })
                      : (isMarkdown && MarkdownText
                        // Render remote markdown with the host renderer instead of a
                        // source wall (issue #74 keeps #64's promise): a link that used
                        // to die with ENOENT on the local mirror now shows the remote
                        // file, rendered.
                        ? React.createElement('div', { style: { padding: '10px 14px', flexShrink: 0, overflow: 'auto' } },
                            React.createElement(MarkdownText, { text: originalText, variant: 'body' }),
                            (data && data.truncated)
                              ? React.createElement('div', { style: { color: T.warn, fontSize: 12, marginTop: 8 } }, tr('file.truncated'))
                              : null)
                        : React.createElement('div', { style: { fontSize: 13, lineHeight: 1.55, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', padding: '10px 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: T.label } },
                            (data && data.content != null) ? data.content : (err ? '' : tr('file.empty')),
                            (data && data.truncated)
                              ? React.createElement('div', { style: { color: T.warn, fontSize: 12, marginTop: 8 } }, tr('file.truncated'))
                              : null,
                          )))),
        ),
      )
    }

    // ── better-sidebar registration (guarded: plugin may be absent) ────────
    function registerSidebarIntegration(ctx) {
      const bs = (ctx && ctx.get && ctx.get('betterSidebar')) || null
      if (!bs || typeof bs.registerTab !== 'function') return
      // Issue #32 migration: drop the remote paths an older dsh-remote left in
      // PERSISTED sidebar state, BEFORE the built-in Files tree loads them
      // through its local fs guard. Runs once per activation; a failure is
      // harmless because the tab-level healing repeats it.
      try {
        migratePollutedSidebarState(typeof window !== 'undefined' ? window.localStorage : null)
      } catch { /* best-effort migration */ }
      const disposers = []
      try {
        disposers.push(bs.registerTab({
          id: SIDEBAR_EXPLORER_ID,
          title: () => tr('explorer.tabTitle'),
          icon: (size) => React.createElement('span', { style: { fontSize: (size || 14), lineHeight: 1 } }, '🌐'),
          order: 55,
          single: true,
          // Issue #32: own the expansion state (see RemoteExplorerTabOwned).
          component: RemoteExplorerTabOwned,
        }))
        // No descriptor for the FILE viewer on purpose. It is a resource tab
        // type (`dsh-remote/file`, registered with `patterns` on the native
        // registry), not a page: it only means something once an address names
        // the file, so it has no card to draw and no page to open. A
        // descriptor here would put a card in better-sidebar's 侧边栏内容
        // inventory whose switch could only ever unregister the viewer — the
        // "switch does nothing" report this replaced. The tree hands the HOST
        // an address instead and the host routes it to that type (openFile).
      } catch (e) {
        console.warn('[dsh-remote] better-sidebar integration skipped:', e)
        disposers.forEach((d) => { try { d() } catch {} })
        return
      }
      let autoOpenedFor = new Set()
      let disposeAuto = null
      const tryAutoOpen = () => {
        if (!explorerAutoOpenEnabled()) return // issue #78: the user said no, persistently
        if (typeof bs.subscribeState !== 'function') return
        const snap = bs.getSnapshot && bs.getSnapshot()
        if (!snap || !snap.sessionId) return
        if (autoOpenedFor.has(snap.sessionId)) return
        const sessionId = snap.sessionId
        // Issue #13: only auto-open the Remote Files tab for sessions that are
        // genuinely remote (cwd inside a mirror). A plain local session must
        // not get a remote tab popped open by a machine that happens to be
        // saved as "current".
        resolveSessionRemote(sessionId).then((remotePath) => {
          if (!remotePath || autoOpenedFor.has(sessionId)) return
          autoOpenedFor.add(sessionId)
          try {
            bs.openTab({ type: SIDEBAR_EXPLORER_ID, title: tr('explorer.tabTitle'), path: remotePath })
          } catch (e2) {
            console.warn('[dsh-remote] better-sidebar auto-open skipped:', e2)
          }
        })
      }
      tryAutoOpen()
      if (typeof bs.subscribeState === 'function') {
        disposeAuto = bs.subscribeState(tryAutoOpen)
        disposers.push(disposeAuto)
      }
      return () => disposers.forEach((d) => { try { d() } catch {} })
    }

    // Official Desktop's right-sidebar extension contract. Reuse the SSH
    // explorer/editor rather than replacing core Files or pretending remote
    // paths are local filesystem resources. Each address is session-scoped.
    const NATIVE_EXPLORER = 'dsh-remote/explorer'
    const NATIVE_FILE = 'dsh-remote/file'
    // Issue #55: the address the CORE emits for a file link, which is NOT the
    // one this plugin mints for its own explorer. A model-emitted
    // `[x](src/main.c)` (or a `@src/main.c` chip) is turned into
    // `dsh-resource://file/session/<sessionId>/<path>` by the chat, and the only
    // shipped claimant is the built-in text preview, which reads it through the
    // HOST's ctx.fs. For a remote Session the header cwd is the LOCAL MIRROR, so
    // the link opens an empty (or stale) local directory and fails. A plugin
    // cannot re-register protocol `file` (one provider per protocol, and it is
    // taken), so the supported interception is a tab type that CLAIMS that
    // address and serves it over SFTP instead.
    const NATIVE_LINK = 'dsh-remote/remote-link'
    function remoteFileAddress(sessionId, path) {
      return 'dsh-resource://dsh-remote/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(path)
    }
    function remoteFilePath(address) {
      const url = new URL(address)
      if (url.protocol !== 'dsh-resource:' || url.hostname !== 'dsh-remote') throw new Error('Invalid remote resource')
      return decodeURIComponent(url.pathname.split('/').slice(2).join('/'))
    }
    /**
     * Parse the core's `dsh-resource://file/session/<id>/<path>` address.
     *
     * Mirrors the grammar the core uses (`dsh-util-workspace-path`): the first
     * segment after the scheme is the scope (`session`), then the id, then the
     * path. Anything else — including the `absolute/` scope — is not ours: an
     * absolute remote path cannot be mapped back onto a mirror, so refusing is
     * correct rather than guessing.
     *
     * @param {string} address - the address a link click produced.
     * @returns {{sessionId: string, path: string}|null} the parts, or null when
     *   this is not a session-scoped core file address.
     */
    function parseCoreFileAddress(address) {
      let url
      try { url = new URL(String(address || '')) } catch { return null }
      if (url.protocol !== 'dsh-resource:' || url.hostname !== 'file') return null
      const rest = url.pathname.replace(/^\/+/, '')
      const [scope, ...tail] = rest.split('/')
      if (scope !== 'session' || tail.length < 2) return null
      const sessionId = decodeURIComponent(tail[0])
      if (!sessionId) return null
      // Dropping the leading empty segment keeps a session-root address ('') a
      // legitimate empty path instead of turning it into '/'.
      return { sessionId, path: decodeURIComponent(tail.slice(1).join('/')) }
    }
    /**
     * The ABSOLUTE remote path a core file address refers to, or null.
     *
     * A relative link is mirror-rooted and an absolute one is already absolute;
     * either way what the reader must see is the path on the REMOTE host. The
     * session's own cwd (a mirror directory) identifies the mirror, whose record
     * carries the remote root the mirror was taken from — the same invariant
     * `lib/binding.js` uses host-side.
     *
     * Separator-aware on purpose (`mirrorForCwd` handles `/a/mirror` vs
     * `/a/mirror-2`): showing the WRONG remote file would be worse than the
     * current failure, so an ambiguous address returns null.
     *
     * @param {{sessionId: string, path: string}} parsed - a parsed core address.
     * @param {string} cwd - the session's local cwd (its mirror directory).
     * @returns {string} an absolute remote path, or null when it cannot be mapped.
     */
    function remotePathForCoreAddress(parsed, cwd) {
      const mirror = mirrorForCwd(cwd, MIRRORS.list)
      if (!mirror) return null
      const remoteRoot = String(mirror.remotePath || '').replace(/[\\/]+$/, '')
      // The REMOTE host's separator is INDEPENDENT of this machine's, and taking
      // it from the address was wrong: a Windows client mirroring a Linux host
      // is the ordinary case here, and reading the separator off the local path
      // then glued a POSIX root to a Windows join ("/home/u/app" + "\" + "x.c").
      // Decide from the remote root alone.
      const remoteIsWin = /^[A-Za-z]:/.test(remoteRoot) || (remoteRoot.includes('\\') && !remoteRoot.includes('/'))
      const remoteSep = remoteIsWin ? '\\' : '/'
      const toRemote = (s) => String(s).replace(/[\\/]+/g, remoteSep)
      // Comparison is separator-INSENSITIVE: `@` completion may insert either
      // style, and the two sides describe the same directory. The local side
      // folds case when it looks like a Windows path (Windows paths do).
      const canon = (s) => String(s).replace(/[\\/]+/g, '/').replace(/\/+$/, '')
      const localDir = String(mirror.dir || '')
      const localIsWin = /^[A-Za-z]:/.test(localDir) || localDir.includes('\\')
      const fold = (s) => (localIsWin ? s.toLowerCase() : s)
      const rel = canon(parsed.path || '')
      const mirrorDir = canon(localDir)
      // The mirror's own directory prefix may be baked into the address when the
      // link was written against the LOCAL path (that is what `@` completion
      // inserts); strip it so the result is remote-relative rather than
      // duplicated under the remote root.
      const stripped = rel && mirrorDir && (fold(rel) === fold(mirrorDir) || fold(rel).startsWith(fold(mirrorDir) + '/'))
        ? rel.slice(mirrorDir.length).replace(/^\/+/, '')
        : rel
      const relBody = canon(stripped)
      if (!remoteRoot) return relBody ? toRemote(relBody) : remoteSep
      if (!relBody) return remoteRoot
      // A drive-letter absolute path on a POSIX remote is a LOCAL path that fell
      // outside the mirror: nothing on the remote can name it, so refuse rather
      // than invent "/home/u/app/D:/x.c".
      if (!remoteIsWin && /^[A-Za-z]:/.test(relBody)) return null
      // Genuinely absolute: the reader meant that path on the remote.
      if (/^[A-Za-z]:/.test(relBody) || /^\//.test(relBody)) return toRemote(relBody)
      return remoteRoot + remoteSep + toRemote(relBody)
    }
    function NativeExplorer(props) {
      const info = props.useTabInfo()
      const [expanded, setExpanded] = React.useState([])
      return React.createElement(RemoteExplorerTab, {
        scope: { sessionId: props.sessionId }, visible: info.tab.visible,
        expanded,
        onToggleDir: (path) => setExpanded((old) => old.includes(path) ? old.filter((p) => p !== path) : [...old, path]),
        onOpenFile: (path) => info.tab.actions.openResource(remoteFileAddress(props.sessionId, path)),
      })
    }
    function NativeFile(props) {
      const info = props.useTabInfo()
      const path = remoteFilePath(info.tab.navigation.address)
      return React.createElement(RemoteFileTab, { key: path, tab: { path }, scope: { sessionId: props.sessionId } })
    }
    /**
     * The body for a CORE file link in a remote Session (issue #55).
     *
     * It resolves the address to an absolute REMOTE path before rendering the
     * same editor the plugin's own explorer uses, so a link and the explorer
     * agree on what a path means. Resolution is attempted synchronously first
     * (the mirror registry is usually warm) and retried once the registry
     * arrives, so a click during page load still ends up in the right file.
     */
    function NativeRemoteLink(props) {
      const info = props.useTabInfo()
      const address = info.tab.navigation.address
      const parsed = parseCoreFileAddress(address)
      const sessionId = (parsed && parsed.sessionId) || props.sessionId
      const [remotePath, setRemotePath] = React.useState(() => {
        const p = parsed || parseCoreFileAddress(address)
        return p ? remotePathForCoreAddress(p, sessionCwdFor(sessionId)) : null
      })
      React.useEffect(() => {
        if (remotePath || !parsed) return undefined
        let cancelled = false
        ensureMirrors().then(() => {
          if (cancelled) return
          const cwd = sessionCwdFor(sessionId)
          const resolved = remotePathForCoreAddress(parsed, cwd)
          if (resolved) setRemotePath(resolved)
        })
        return () => { cancelled = true }
      }, [address, remotePath])
      if (!remotePath) {
        return React.createElement('div', { style: { padding: 16, fontSize: 12, opacity: 0.7 } },
          tr('file.linkUnresolved'))
      }
      return React.createElement(RemoteFileTab, { key: remotePath, tab: { path: remotePath }, scope: { sessionId } })
    }
    /** The local cwd of a session, from the client's own session store. */
    function sessionCwdFor(sessionId) {
      try {
        const list = SESSIONS && SESSIONS.list && typeof SESSIONS.list.getSnapshot === 'function'
          ? SESSIONS.list.getSnapshot()
          : null
        const entry = list && list.byId && list.byId[sessionId]
        return (entry && entry.cwd) ? String(entry.cwd) : ''
      } catch { return '' }
    }
    function registerNativeSidebar(inner) {
      const tabs = inner.get('sidebarRightTabs')
      const slots = inner.get('slots')
      // Whether this build accepted the remote-link type. A local (not module
      // level) flag, so two plugin lifetimes cannot see each other's state.
      let linkTypeAccepted = false
      // Issue #55: `canOpen` is synchronous and runs on every routing decision,
      // so the mirror registry has to be warm BEFORE the first link click —
      // otherwise the very first click of a page load falls through to the
      // built-in local preview. This is a warm-up, not a dependency: a failure
      // just leaves the conservative behaviour in place.
      try { ensureMirrors() } catch { /* the registry is best-effort */ }
      // ── Who owns the 开始 card ────────────────────────────────────────────
      // The 远程文件 card on the right sidebar's start page (开始) is the
      // `guide` entry of a native tab type, and TWO providers can publish one:
      // this plugin (below) and dsh-better-sidebar, which registers a native
      // type per tab descriptor it hosts — our `dsh-remote:explorer` gets a
      // guide row of its own there, governed by its side-card settings switch.
      //
      // Publishing both is what made that switch look broken: turning the type
      // off removed better-sidebar's row and left ours, so the card never went
      // away. The card therefore belongs to exactly ONE provider:
      //   · better-sidebar in the composition → ITS descriptor owns the card
      //     (its switch IS the switch for it), and this type is registered
      //     without a guide entry. The type and its body stay: a tab opened by
      //     kind still renders, and nothing else about the panel changes.
      //   · plain install → the card is ours, always, exactly as before.
      //
      // `guide` is captured at registration time and an id may not be
      // registered twice, so a handover means dispose-then-register inside one
      // synchronous block: no render can observe the gap.
      let betterSidebar = false
      let disposed = false
      let disposeExplorer = null
      let guideListed = null
      const syncExplorerType = () => {
        const withGuide = !betterSidebar
        if (guideListed === withGuide && disposeExplorer) return
        const previous = disposeExplorer
        disposeExplorer = null
        if (previous) { try { previous() } catch { /* already released */ } }
        disposeExplorer = tabs.register({
          id: NATIVE_EXPLORER, kind: NATIVE_EXPLORER,
          title: () => tr('explorer.tabTitle'),
          ...(withGuide ? { guide: [{ order: 55, title: () => tr('explorer.tabTitle') }] } : {}),
        })
        guideListed = withGuide
      }
      inner.effect(() => {
        syncExplorerType()
        return () => {
          disposed = true
          const dispose = disposeExplorer
          disposeExplorer = null
          guideListed = null
          if (dispose) { try { dispose() } catch { /* already released */ } }
        }
      }, 'dsh-remote.native-explorer-type')
      // The two plugins may activate in EITHER order, so the service has to be
      // followed rather than read once: the card moves to better-sidebar when
      // it arrives, and comes back here if it goes away.
      inner.inject(['betterSidebar'], (withSidebar) => {
        betterSidebar = true
        try { syncExplorerType() } catch (e) { console.warn('[dsh-remote] start-page card handover skipped:', e) }
        if (!withSidebar || typeof withSidebar.effect !== 'function') return
        withSidebar.effect(() => () => {
          betterSidebar = false
          if (disposed) return
          try { syncExplorerType() } catch (e) { console.warn('[dsh-remote] start-page card handover skipped:', e) }
        }, 'dsh-remote.start-card-owner')
      })
      inner.effect(() => tabs.register({
        id: NATIVE_FILE, kind: NATIVE_FILE,
        patterns: ['dsh-resource://dsh-remote/**'],
        title: (address) => remoteFilePath(address).split(/[\\/]/).pop() || tr('explorer.tabTitle'),
      }), 'dsh-remote.native-file-type')
      // Issue #55. No `priority` is declared, so this registers in the
      // `extension` band, which by contract outranks every viewer the product
      // ships — including the built-in text preview that currently claims
      // `dsh-resource://file/**` in the `fallback` band and reads locally.
      // `canOpen` is the whole safety story: it must return true ONLY for a
      // session whose cwd is PROVEN to be a remote mirror. Local sessions, and
      // a page load before the mirror registry has arrived, fall through to the
      // built-in preview and behave exactly as they did before.
      //
      // Registration is wrapped because the address-claiming half of this
      // contract (`patterns` + `canOpen`) is not something every DSH line
      // necessarily has. The plugin supports both the 0.1.x and 0.2.x lines, and
      // on a build whose tab registry cannot express an address claim the right
      // outcome is "file links keep working the old way" — NOT a throw that
      // would take the explorer and file types down with it.
      inner.effect(() => {
        try {
          const dispose = tabs.register({
            id: NATIVE_LINK, kind: NATIVE_LINK,
            patterns: ['dsh-resource://file/**'],
            canOpen: (address) => {
              const parsed = parseCoreFileAddress(address)
              if (!parsed) return false
              // Issue #74: .md/.markdown are claimed too. The built-in Markdown
              // preview reads the LOCAL MIRROR — for a remote session a link to a
              // file that was never synced dies with ENOENT and shows nothing at
              // all. This editor opens the file over SFTP and RENDERS it via the
              // host's MarkdownText (source only when the primitive is missing),
              // so claiming is no longer a downgrade. Local sessions still fall
              // through: their cwd is not a mirror, proven below.
              const cwd = sessionCwdFor(parsed.sessionId)
              // `MIRRORS.loaded` is checked so a cold start NEVER steals a local
              // link: an empty registry cannot prove a mirror, and guessing would
              // break the text preview for every local session.
              if (!cwd || !MIRRORS.loaded) return false
              return !!mirrorForCwd(cwd, MIRRORS.list)
            },
            title: (address) => {
              const parsed = parseCoreFileAddress(address)
              return ((parsed && parsed.path) || '').split(/[\\/]/).pop() || tr('explorer.tabTitle')
            },
          })
          linkTypeAccepted = true
          return () => { linkTypeAccepted = false; if (typeof dispose === 'function') dispose() }
        } catch (err) {
          try { console.warn('dsh-remote: remote file links are unavailable on this DSH build', err) } catch { /* no console */ }
          return undefined
        }
      }, 'dsh-remote.native-link-type')
      inner.effect(() => slots.inject('sidebar.right.pane.tab', () => {
        const disposers = [
          slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_EXPLORER }, NativeExplorer),
          slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_FILE }, NativeFile),
        ]
        // Only register the link body when its type was accepted: a body under a
        // kind nothing claims would never render, and on a build that rejected
        // the type the seat may reject the body too.
        if (linkTypeAccepted) {
          disposers.push(slots.register({ name: 'sidebar.right.pane.tab', key: NATIVE_LINK }, NativeRemoteLink))
        }
        return () => disposers.forEach((dispose) => dispose())
      }), 'dsh-remote.native-bodies')
    }

    function apply(ctx) {
      ensureChromeCss()
      const slots = ctx.get('slots')
      wireLocale(ctx)
      // Optional integrations must not gate the settings page. In particular,
      // replacement sidebars may disable the native ui-workspace package.
      ctx.inject(['sessions'], (inner) => {
        const sessions = inner.get('sessions')
        SESSIONS = sessions
        inner.effect(() => () => {
          if (SESSIONS === sessions) SESSIONS = null
        }, 'dsh-remote.sessions')
      })
      slots.inject('settings.section', () =>
        slots.register({ name: 'settings.section', id: 'dsh-remote', order: 40, label: () => tr('settings.title') }, () => React.createElement(RemoteWorkspacePage, null)),
      )
      for (const slot of ['conversation.hero.workspace.directoryFlow', 'sidebar.workspaces.directoryFlow']) {
        slots.inject(slot, () =>
          slots.register({ name: slot, id: 'dsh-remote', priority: -100 }, DirPicker),
        )
      }
      ctx.inject(['betterSidebar'], (inner) => {
        inner.effect(() => registerSidebarIntegration(inner), 'dsh-remote.betterSidebar')
      })
      ctx.inject(['sidebarRightTabs'], registerNativeSidebar)
      // Issue #49: mark the remote Sessions in the sidebar's own Session list.
      // These three seats belong to the SHIPPED ui-workspace browser, so they
      // are injected (not assumed): a composition with a replacement sidebar
      // simply never declares them, and the mark is absent rather than broken.
      slots.inject('sidebar.session.row.leading', () =>
        slots.register({ name: 'sidebar.session.row.leading', id: 'dsh-remote-remote-mark', order: 5 }, RemoteSessionMark),
      )
      slots.inject('sidebar.session.row.hover', () =>
        slots.register({ name: 'sidebar.session.row.hover', id: 'dsh-remote-remote-host', order: 5 }, RemoteSessionHover),
      )
      slots.inject('conversation.session.header.utilities', () =>
        slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-remote-remote-chip', order: 15 }, RemoteSessionChip),
      )
    }

    exports.name = name
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})