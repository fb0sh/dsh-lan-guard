/**
 * dsh-lan-guard — the plugin's copy, in both of DSH's built-in languages.
 *
 * The language is NOT this plugin's own preference: it follows the one the
 * official settings page writes (设置 → 通用设置 → 语言), which DSH stores in its
 * `locale` settings namespace and publishes to every client plugin through the
 * `locale` service. This module supplies the dictionary; `client.ts` registers
 * it with `ctx.locale.register(NS, { zh, en })` and consumes it through the
 * framework-injected `t` seat, so a language switch re-renders the section
 * without a reload — exactly the behaviour the official settings pages have.
 *
 * Registering both dictionaries is mandatory in the official contract, and the
 * type below enforces it: `en` is declared as a total map over the Chinese key
 * set, so adding a Chinese string without its English pair fails to compile.
 *
 * Register notes, taken from the official dictionaries rather than invented:
 * sentence case, no second person, no rhetorical questions, no emoji; failure
 * sentences use "Could not …" and end in a full stop, short labels do not.
 */
/**
 * The locale namespace this plugin's dictionary is registered under.
 *
 * Namespaced rather than shared with `common`: the plugin owns its own copy,
 * and a namespace collision with another plugin would silently merge the two
 * dictionaries.
 */
export const LOCALE_NS = 'dsh-lan-guard'

/** Placeholder values interpolated into a message. */
export type TranslateParams = Record<string, string | number>

/**
 * Simplified Chinese — the key-set source of truth.
 *
 * Every value here is the wording the plugin already ships, reviewed against
 * the official dictionaries for register (short, declarative, no second
 * person).
 */
export const zh = {
  // Shell -------------------------------------------------------------------
  'nav': '局域网访问',
  'tab.access': '扫码访问',
  'tab.security': '安全认证',
  'tab.devices': '已授权设备',
  'tab.connection': '连接与证书',
  'tablist': '局域网访问设置分区',
  'common.copy': '复制链接',
  'common.copied': '已复制',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.retry': '重试',
  'common.loading': '加载中…',
  'common.unknown': '未知',
  'section.loading': '正在读取局域网访问设置…',
  'section.unreadable': '无法读取设置',
  'status.running': '运行中',
  'status.stopped': '已停止',

  // Access ------------------------------------------------------------------
  'access.title': '局域网访问',
  'access.desc': '同一局域网内的设备可扫码访问',
  'access.ok': '访问验证已生效',
  'access.okLocal': '访问验证已生效（当前仅本机可访问）',
  'access.noPassword': '未设置访问密码，门禁拒绝所有设备',
  'access.openNoPassword':
    '端口已对局域网开放（{port}），但未设置访问密码。门禁拒绝所有设备，不会泄露数据；请先设置访问密码。',
  'access.setPassword': '设置访问密码',
  'access.qrPending': '设置访问密码后显示二维码。',
  'access.linkHint': '扫码即登录。该链接等同于访问密码，请勿外传。首次访问需为设备命名。',
  'access.qrHint': '扫码后输入访问密码，首次访问需为设备命名。',
  'access.qrHintLocked': '扫码后输入访问密码，首次访问需为设备命名。解锁管理控制台后显示免密二维码。',
  'access.rotate': '重新生成',
  'access.privateOnly': '仅限私密环境使用',
  'access.pwaHint': '手机浏览器可通过「添加到主屏幕」以全屏应用方式打开。',

  // Authentication ----------------------------------------------------------
  'security.title': '安全认证',
  'security.lead': '决定谁能通过代理端口进入 DSH',
  'security.intro':
    '访问密码供访客设备登录；管理密码用于解锁本页管理台，未设置时退回访问密码。',
  'security.mode': '验证方式',
  'security.mode.tokenPassword': '扫码免密 + 密码',
  'security.mode.tokenPasswordDetail': '扫码免密进入，也可输入访问密码',
  'security.mode.password': '仅密码',
  'security.mode.passwordDetail': '所有设备均须输入访问密码',
  'security.mode.token': '仅安全 Token',
  'security.mode.tokenDetail': '仅接受免密链接，不接受密码登录',
  'security.accessSet': '访问密码：已设置（不会回显）',
  'security.accessUnset': '访问密码：未设置',
  'security.adminSet': '管理密码：已设置（不会回显）',
  'security.adminUnset': '管理密码：未设置（退回访问密码）',
  'security.newAccess': '输入新的访问密码（至少 8 位）',
  'security.newAdmin': '输入新的管理密码（至少 8 位）',
  'security.setAccess': '设置访问密码',
  'security.setAdmin': '设置管理密码',
  'security.loopback': '本机回环访问免密',
  'security.loopbackDesc': '本机直接打开控制台时跳过门禁',
  'security.policy': '远程设备管理权限',
  'security.policyDesc':
    '「仅本机」下局域网设备只读。如需在手机端浏览目录并添加工作区，请选择「密码解锁」或「不锁定」。',
  'security.policy.unlock': '密码解锁',
  'security.policy.unlockDetail': '任何设备均需管理员密码解锁',
  'security.policy.local': '仅本机',
  'security.policy.localDetail': '仅本机可管理，其他设备只读',
  'security.policy.open': '不锁定',
  'security.policy.openDetail': '任何能打开设置页的设备均可修改',
  'security.adminProtection': '管理操作需要先解锁',
  'security.adminProtectionDesc': '远程会话需先解锁才能修改设置',
  'security.storageNote':
    '密码仅以 PBKDF2-SHA256 哈希存于插件私有目录，不写入配置文件，不回显。',

  // Lock card ---------------------------------------------------------------
  'lock.title': '管理控制台已锁定',
  'lock.tag': '使用访问密码解锁',
  'lock.bodyAdmin': '修改验证方式与证书设置前需先解锁管理控制台。',
  'lock.bodyFallback': '当前未设置独立管理密码，输入访问密码即可解锁。',
  'lock.placeholder': '输入访问密码',
  'lock.submit': '解锁管理权限',
  'lock.recover': '找回访问密码',
  'lock.recoverTitle': '找回或重置访问密码：',
  'lock.recoverLocal': '1. 本机直连：在本机打开控制台（127.0.0.1 免锁），可修改或清除密码。',
  'lock.recoverHeadless':
    '2. 无头或服务器环境：删除插件私有目录（配置项 dataDir）下的 secrets.json 后重新设置。',
  'lock.recoverHeadlessAfter': '删除后门禁拒绝所有设备，直至设置新密码。',

  // Devices -----------------------------------------------------------------
  'devices.title': '已授权设备',
  'devices.lead': '每台设备一份独立身份，可单独批准、吊销或拉黑',
  'devices.intro': '设备首次通过门禁时显示配对页，命名后出现在下方列表。',
  'devices.requirePairing': '新设备需要命名确认',
  'devices.requirePairingDesc': '新设备须命名一次后方可进入列表',
  'devices.requireApproval': '新设备需要管理员批准',
  'devices.requireApprovalDesc': '命名后仍需在下方批准',
  'devices.approvalHint':
    '开启后，设备命名后进入「待批准」，批准后方可访问。「拒绝并拉黑」仅作废该设备的身份：同一浏览器将持续被拒绝，但清除浏览器数据或更换浏览器后仍可用密码重新配对；如需彻底阻止，请同时更换访问密码。',
  'devices.pendingTag': '待处理',
  'devices.pendingAlert': '有 {count} 台新设备等待批准',
  'devices.empty': '暂无已授权设备。',
  'devices.group.pending': '待批准',
  'devices.group.approved': '已授权',
  'devices.group.blocked': '已拉黑',
  'devices.status.pending': '待批准',
  'devices.status.approved': '已批准',
  'devices.status.blocked': '已拉黑',
  'devices.approve': '批准',
  'devices.block': '拒绝并拉黑',
  'devices.unblock': '解除拉黑',
  'devices.revokeBlock': '吊销并拉黑',
  'devices.meta': '创建 {created} · 最近使用 {seen} · 来源 {ip}',

  // Connection --------------------------------------------------------------
  'connection.title': '手机连接恢复',
  'connection.lead': '长连接断开的原因与恢复方式',
  'connection.intro':
    '会话记录仅经 WebSocket 传输：DSH 每 2 秒发送一次心跳，连续两次未响应即断开连接（约 6 秒）。手机锁屏或切至后台时页面被挂起，无法响应心跳，会话记录因此载入不全或断开。以下四项默认开启，可逐项关闭。',
  'connection.heartbeat': '代理代答心跳',
  'connection.heartbeatDesc': '手机挂起期间由代理代替响应心跳，宿主不再回收连接',
  'connection.heartbeatHint':
    '实测：停止响应心跳约 6 秒后被切断，由代理代答可存活 20 秒以上。手机自身的响应到达时属重复包，无副作用。',
  'connection.watchdog': '断线看门狗（页面补丁）',
  'connection.watchdogDesc': 'WebSocket 停留在「连接中」超过 8 秒即关闭，必要时自动重载页面',
  'connection.watchdogHint':
    '从后台恢复 10 秒后仍无连接时自动重载一次（每标签最多连续 3 次，冷却时间自 20 秒起递增）。仅影响无法连接的页面。',
  'connection.compat': '移动端兼容垫片',
  'connection.compatDesc':
    '为旧引擎补充 AbortSignal.any / AbortSignal.timeout / Promise.withResolvers / Iterator',
  'connection.compatHint':
    '缺少这些 API 时 DSH 客户端在会话流中抛错，界面持续显示「载入历史…」且无错误提示。现代浏览器上不生效。',
  'connection.scroll': '手机滚动矫正（窄屏）',
  'connection.scrollDesc': '修正窄屏下内容可见但无法滚动的问题',
  'connection.scrollHint':
    '窄屏下 DSH 外壳将对话列压于固定浮层之后，内容可见但无法滚动。开启后仅在下列条件同时成立时启用触摸滚动：整页无法滚动，且存在被裁剪的层。正常页面不受影响。加 ?lgdiag=1 显示布局诊断。',
  'connection.install': '安装为手机 App（PWA）',
  'connection.installDesc': '注册 Service Worker，使浏览器提供「安装应用」入口',
  'connection.installHint':
    'Chromium 系浏览器仅在页面注册了含 fetch 处理器的 Service Worker 时提供「安装应用」，DSH 本身不注册。此处注册的 worker 为空实现，不缓存、不拦截，请求仍由浏览器直接发出。安装入口仅在 HTTPS（或 localhost）下可用。切换后刷新页面生效。',
  'connection.doctor': '连接体检',
  'connection.doctorBusy': '体检中…',
  'connection.doctorHint':
    '在当前浏览器中检查引擎缺失的 API、已生效的页面补丁，并向本页地址发起一次 WebSocket 握手。',

  // Transport ---------------------------------------------------------------
  'transport.title': '连接与证书',
  'transport.ports': '代理端口 {port} → 上游 {upstream}',
  'transport.portBusy':
    '配置的端口 {configured} 已被占用，已自动改用 {port}。可在下方修改端口，或先关闭占用该端口的程序。',
  'scope.label': '监听范围（修改后需重启 dsh 生效）',
  'scope.lan': '局域网（默认）',
  'scope.lanDetail': '同网段设备可访问，门禁与自签 HTTPS 全程生效',
  'scope.local': '仅本机',
  'scope.localDetail': '仅本机可访问，其他设备无法连接',
  'scope.custom': '当前为自定义监听地址 {host}（由 profile patch 设置），选择以上任一项将覆盖它。',
  'scope.hint':
    '对外可达不等于可进入：未设置访问密码时门禁拒绝所有设备。如需仅在固定网卡上公布，可在 profile patch 中将 listenHost 设为该网卡 IP。',
  'unlock.title': '局域网设备可用官方设置页',
  'unlock.desc': '允许通过门禁的设备使用 DSH 官方设置页',
  'unlock.hint':
    '开启后，通过门禁的设备刷新页面即可使用 DSH 官方设置页；关闭则恢复 DSH 默认，非本机访问显示「settings are unavailable in this browser」。此为界面解锁，非新增权限：设置接口仍由门禁把关，密钥读取仍由 DSH 脱敏。切换后刷新页面生效，无需重启 dsh。',
  'port.label': '代理端口（修改后需重启 dsh 生效）',
  'port.save': '保存端口',
  'port.checking': '检查中…',
  'port.available': '端口 {port} 可用',
  'port.taken': '端口 {port} 已被占用',
  'port.checkFailed': '检查失败',
  'port.invalid': '请输入 1–65535 之间的端口号',
  'port.hint': '默认 {default}；被占用时自动向后寻找可用端口，最多尝试 {max} 个。',
  'port.originNotice': '端口即访问源的一部分：改动或自动顺延后，已安装的应用与已收藏的地址都会指向旧地址，需在新地址重新安装并重新信任自签 CA。',
  'nic.label': '对外公布的网卡',
  'nic.auto': '自动选择（优先物理网卡）',
  'nic.option': '{name} · {address}',
  'nic.optionVirtual': '{name} · {address}（虚拟：{reason}）',
  'nic.hint': '二维码与访问地址随此处选择即时刷新；虚拟网卡通常无法被其他设备访问。',
  'tls.label': '传输安全',
  'tls.selfSigned': '自签 HTTPS（默认）',
  'tls.selfSignedDetail': '设备需一次性信任自签 CA',
  'tls.off': '关闭 HTTPS',
  'tls.offDetail': '局域网内明文传输，仅建议用于完全可信的网络',
  'tls.offNotice':
    '已关闭 HTTPS：局域网内为明文传输，门禁密码与上游 cookie 可能被同网段嗅探，且浏览器部分能力（剪贴板、Service Worker）不可用。仅建议用于完全可信的私有网络。',
  'tls.notYet': 'TLS 切换暂未开放',
  'tls.caFingerprint': '自签 CA 指纹（SHA-256）：{fingerprint}',
  'tls.caHint':
    '设备首次访问需先安装并信任该 CA（见 README）；CA 身份跨重启不变，更换 IP 仅重签叶证书。',
  'reason.loopback': '当前仅绑定回环地址，局域网设备无法访问；请将 listenHost 设为 0.0.0.0 或指定网卡地址',
  'reason.noAddress': '未检测到可用的局域网 IPv4 地址',
  'reason.interfaceMissing': '配置的网卡 {interface} 不存在或没有 IPv4 地址',
  'quick.home': '主目录',
  'quick.desktop': '桌面',
  'quick.documents': '文档',
  'quick.downloads': '下载',
  'quick.projects': 'Projects',
  'quick.code': 'code',
  'quick.src': 'src',
  'quick.root': '根目录',
  'quick.driveRoot': '{drive} 盘根目录',
  'net.count': '检测到 {count} 个可用地址{virtual}。',
  'net.virtualSuffix': '（含虚拟网卡，已降权）',

  // Banners and update ------------------------------------------------------
  'banner.unlocked': '已解锁：本次会话内可直接修改以下设置',
  'banner.relock': '重新锁定',
  'banner.readOnly':
    '当前为远程访问（只读）。请在本机打开控制台修改，127.0.0.1 免锁。',
  'update.checking': '检查更新…',
  'update.check': '检查更新',
  'update.busy': '检查中…',
  'update.current': 'v{current} ✓ 最新',
  'update.failed': 'v{current} · 检查失败',
  'update.available': 'v{current} ➔ v{latest}',
  'update.github': 'GitHub',
  'update.changelog': '更新日志',
  'update.issue': '反馈 Issue',
  'update.found': '发现新版本 v{latest}（当前 v{current}）',
  'update.copyCommand': '复制命令',
  'update.installHint':
    '本插件不自动安装，也不重启 dsh。执行以上命令后需手动重启 dsh 一次。',

  // Feedback ----------------------------------------------------------------
  'toast.saved': '已保存',
  'toast.approved': '已批准',
  'toast.blocked': '已拉黑',
  'toast.unblocked': '已解除拉黑',
  'toast.revoked': '已吊销',
  'toast.copyFailed': '复制失败，请手动复制',
  'toast.enterPassword': '请输入访问密码',
  'error.readOnlyRemote': '当前策略为「仅本机」，远程设备只读，请在本机修改',
  'error.adminRequired': '请先在「安全认证」中解锁管理控制台',
  'error.adminPasswordInvalid': '管理密码不正确',
  'error.csrf': '请求被跨站校验拒绝，刷新页面后重试',
  'error.currentPasswordRequired': '需要先填写当前密码',
  'error.gateDisabledRequiresLoopback': '关闭门禁需将监听范围改回「仅本机」',

  // Health check ------------------------------------------------------------
  'doctor.patches':
    '页面补丁：官方设置页解锁 {unlock} · 移动端兼容垫片 {compat} · 断线看门狗 {watchdog}',
  'doctor.engine.ok': '浏览器引擎能力：会话流所需 API 齐全',
  'doctor.engine.missing': '浏览器引擎能力：缺 {list}（垫片未生效时会话记录停留在「载入历史…」且无错误提示）',
  'doctor.origin': '页面来源：{origin}{kind}',
  'doctor.origin.loopback': '（本机回环）',
  'doctor.origin.lan': '（经局域网入口）',
  'doctor.agent': '浏览器：{agent}',
  'doctor.socket': '会话 WebSocket（{host}）：{outcome}',
  'doctor.socket.ok': '握手成功，用时 {ms} ms',
  'doctor.socket.create': '无法创建 WebSocket：{message}',
  'doctor.socket.timeout': '12 秒内未完成握手（WebKit 后台恢复后停留在 CONNECTING）',
  'doctor.socket.failed': 'WebSocket 握手失败（门禁拒绝或证书不受信任）',
  'doctor.relay': '代理侧：在活连接 {active} · 累计升级 {upgrades} · 被拒 {refused} · 代答心跳 {answered} 次',
  'doctor.last': '最近一条：{state} · 存活 {seconds}s · 上行 {up}KB / 下行 {down}KB{abnormal}',
  'doctor.last.upgraded': '已升级',
  'doctor.last.refused': '被拒 {status}',
  'doctor.last.abnormal': ' · 异常断开（无 Close 帧）',

  // Workspace picker --------------------------------------------------------
  'picker.title': '选择工作区目录',
  'picker.adding': '正在添加工作区…',
  'picker.unreadable': '暂时无法读取该目录，请见上方提示。',
  'picker.empty': '该文件夹中没有子文件夹',
  'picker.truncated': '文件夹过多，仅显示开头部分。',
  'picker.use': '使用此目录',
  'picker.unlockPlaceholder': '管理密码（未设置时用访问密码）',
  'picker.unlock': '解锁',
  'picker.unlocking': '解锁中…',
  'picker.noPicker': '当前主机没有可用的系统目录选择器',
  'picker.unlockFailed': '解锁失败（HTTP {status}）',
  'picker.adminPasswordInvalid': '管理密码不正确',
  'notice.readOnly.title': '远程设备当前只读',
  'notice.readOnly.detail':
    '请在本机「设置 → 局域网访问 → 安全认证 → 远程设备管理权限」中选择「密码解锁」或「不锁定」，然后刷新本页。',
  'notice.adminRequired.title': '需要先解锁管理控制台',
  'notice.adminRequired.detail': '请在「设置 → 局域网访问 → 安全认证」中输入管理密码解锁，然后重试。',
  'notice.rateLimited.title': '请求过于频繁',
  'notice.rateLimited.detail': '请稍后重试。',
  'notice.blocked.title': '该目录被安全策略禁止',
  'notice.blocked.detail': '系统目录与凭据目录（.ssh、.aws、.env 等）不能浏览，也不能作为工作区。',
  'notice.notFound.title': '目录不存在',
  'notice.notFound.detail': '该目录可能已被移动或删除，请返回上一层重新选择。',
  'notice.notADirectory.title': '这不是一个文件夹',
  'notice.notADirectory.detail': '工作区必须是一个目录。',
  'notice.invalidPath.title': '路径无效',
  'notice.invalidPath.detail': '请使用完整的绝对路径。',
  'notice.unreadable.title': '无法读取该目录',
  'notice.unreadable.detail': '权限不足或磁盘不可用。',
  'notice.forbidden.title': '会话已失效',
  'notice.forbidden.detail': '刷新页面重新登录后再试。',
  'notice.unknown.title': '无法读取目录',
  'notice.unknown.detail': '未知错误。',
  'notice.coded.detail': '无法读取该目录（{code}）。',
} as const

/** The key union, derived from the Chinese dictionary. */
export type DictionaryKey = keyof typeof zh

/** One message key; an alias kept for call sites that read as "a message". */
export type MessageKey = DictionaryKey

/** A translate function: the same shape the `locale` service hands out. */
export type Translate = (key: MessageKey, params?: TranslateParams) => string

/** English — a total map over the Chinese key set (completeness is compile-checked). */
export const en: Record<DictionaryKey, string> = {
  // Shell -------------------------------------------------------------------
  'nav': 'LAN access',
  'tab.access': 'QR access',
  'tab.security': 'Authentication',
  'tab.devices': 'Devices',
  'tab.connection': 'Connection',
  'tablist': 'LAN access sections',
  'common.copy': 'Copy link',
  'common.copied': 'Copied',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.retry': 'Retry',
  'common.loading': 'Loading…',
  'common.unknown': 'Unknown',
  'section.loading': 'Reading LAN access settings…',
  'section.unreadable': 'Could not read settings',
  'status.running': 'Running',
  'status.stopped': 'Stopped',

  // Access ------------------------------------------------------------------
  'access.title': 'LAN access',
  'access.desc': 'Devices on the same network can scan to connect',
  'access.ok': 'Access verification is active',
  'access.okLocal': 'Access verification is active (this machine only)',
  'access.noPassword': 'No access password set; the gate refuses every device',
  'access.openNoPassword':
    'The port is open to the network ({port}) but no access password is set. The gate refuses every device, so nothing is exposed. Set an access password first.',
  'access.setPassword': 'Set access password',
  'access.qrPending': 'The QR code appears once an access password is set.',
  'access.linkHint':
    'Scanning signs in directly. This link equals the access password; do not share it. The first visit also asks you to name the device.',
  'access.qrHint': 'Scan, then enter the access password. The first visit also asks you to name the device.',
  'access.qrHintLocked':
    'Scan, then enter the access password. The first visit also asks you to name the device. Unlocking the management console switches to a passwordless QR code.',
  'access.rotate': 'Regenerate',
  'access.privateOnly': 'For private use only',
  'access.pwaHint': 'On a phone browser, "Add to Home Screen" opens it as a full-screen app.',

  // Authentication ----------------------------------------------------------
  'security.title': 'Authentication',
  'security.lead': 'Who may enter DSH through the proxy port',
  'security.intro':
    'The access password signs visitor devices in; the admin password unlocks this page\u2019s console and falls back to the access password when unset.',
  'security.mode': 'Verification method',
  'security.mode.tokenPassword': 'Passwordless QR + password',
  'security.mode.tokenPasswordDetail': 'Enter by passwordless QR, or type the access password',
  'security.mode.password': 'Password only',
  'security.mode.passwordDetail': 'Every device must enter the access password',
  'security.mode.token': 'Secure token only',
  'security.mode.tokenDetail': 'Accepts the passwordless link only, never a password',
  'security.accessSet': 'Access password: set (never shown)',
  'security.accessUnset': 'Access password: not set',
  'security.adminSet': 'Admin password: set (never shown)',
  'security.adminUnset': 'Admin password: not set (falls back to the access password)',
  'security.newAccess': 'Enter a new access password (at least 8 characters)',
  'security.newAdmin': 'Enter a new admin password (at least 8 characters)',
  'security.setAccess': 'Set access password',
  'security.setAdmin': 'Set admin password',
  'security.loopback': 'Skip the gate for loopback access',
  'security.loopbackDesc': 'Direct access from this machine skips the gate',
  'security.policy': 'Remote management rights',
  'security.policyDesc':
    'Under "this machine only" remote devices are read-only. Browsing directories and adding a workspace from a phone needs "password unlock" or "not locked".',
  'security.policy.unlock': 'Password unlock',
  'security.policy.unlockDetail': 'Every device needs the admin password',
  'security.policy.local': 'This machine only',
  'security.policy.localDetail': 'Only this machine may manage; other devices are read-only',
  'security.policy.open': 'Not locked',
  'security.policy.openDetail': 'Any device that can open this page may change settings',
  'security.adminProtection': 'Management actions need an unlock',
  'security.adminProtectionDesc': 'A remote session must unlock before changing settings',
  'security.storageNote':
    'Passwords are stored only as PBKDF2-SHA256 hashes in the plugin\u2019s private directory. They are never written to the config file and never shown.',

  // Lock card ---------------------------------------------------------------
  'lock.title': 'Management console locked',
  'lock.tag': 'Unlock with the access password',
  'lock.bodyAdmin': 'Unlock the management console before changing verification or certificate settings.',
  'lock.bodyFallback': 'No separate admin password is set; the access password unlocks it.',
  'lock.placeholder': 'Enter the access password',
  'lock.submit': 'Unlock management',
  'lock.recover': 'Recover access password',
  'lock.recoverTitle': 'Recovering or resetting the access password:',
  'lock.recoverLocal':
    '1. Direct access: open the console on this machine (127.0.0.1 is unlocked) to change or clear the password.',
  'lock.recoverHeadless':
    '2. Headless or server: delete secrets.json in the plugin\u2019s private directory (config key dataDir) and set it again.',
  'lock.recoverHeadlessAfter': 'Afterwards the gate refuses every device until a new password is set.',

  // Devices -----------------------------------------------------------------
  'devices.title': 'Devices',
  'devices.lead': 'Each device has its own identity, approved, revoked or blocked individually',
  'devices.intro': 'A device names itself on its first pass through the gate, then appears below.',
  'devices.requirePairing': 'New devices must be named',
  'devices.requirePairingDesc': 'A new device must be named once before it is listed',
  'devices.requireApproval': 'New devices need approval',
  'devices.requireApprovalDesc': 'Naming alone is not enough; approve below',
  'devices.approvalHint':
    'When on, a named device waits under "pending" until approved. "Reject and block" voids that device identity: the same browser stays refused, but clearing browser data or switching browsers allows re-pairing with the password. Change the access password as well to block it completely.',
  'devices.pendingTag': 'Pending',
  'devices.pendingAlert': '{count} new device(s) awaiting approval',
  'devices.empty': 'No authorised devices yet.',
  'devices.group.pending': 'Pending',
  'devices.group.approved': 'Authorised',
  'devices.group.blocked': 'Blocked',
  'devices.status.pending': 'Pending',
  'devices.status.approved': 'Approved',
  'devices.status.blocked': 'Blocked',
  'devices.approve': 'Approve',
  'devices.block': 'Reject and block',
  'devices.unblock': 'Unblock',
  'devices.revokeBlock': 'Revoke and block',
  'devices.meta': 'Created {created} · Last used {seen} · From {ip}',

  // Connection --------------------------------------------------------------
  'connection.title': 'Mobile connection recovery',
  'connection.lead': 'Why the long-lived connection drops, and how it recovers',
  'connection.intro':
    'The transcript travels only over the WebSocket. DSH pings every 2 seconds and drops a socket after two unanswered pings (about 6 seconds). A phone that locks its screen or moves to the background is suspended and cannot answer, so the transcript loads incompletely or drops. All four switches below default to on.',
  'connection.heartbeat': 'Proxy answers the heartbeat',
  'connection.heartbeatDesc': 'While the phone is suspended the proxy answers instead, so the host keeps the connection',
  'connection.heartbeatHint':
    'Measured: the socket is cut about 6 seconds after the pings stop, and survives beyond 20 seconds with the proxy answering. A late answer from the phone is a harmless duplicate.',
  'connection.watchdog': 'Socket watchdog (page patch)',
  'connection.watchdogDesc': 'A WebSocket stuck in CONNECTING for over 8 seconds is closed, and the page reloads itself when needed',
  'connection.watchdogHint':
    'On a resume with nothing connected after 10 seconds the page reloads once (at most 3 in a row per tab, with a cooldown growing from 20 seconds). Only pages that cannot connect at all are affected.',
  'connection.compat': 'Mobile compatibility shims',
  'connection.compatDesc':
    'Fills in AbortSignal.any / AbortSignal.timeout / Promise.withResolvers / Iterator for older engines',
  'connection.compatHint':
    'Without these APIs DSH\u2019s client throws inside its session-stream path and the UI sits on "Loading history…" with no error at all. On a modern engine the branches never run.',
  'connection.scroll': 'Narrow-screen scroll fix',
  'connection.scrollDesc': 'Fixes content that is visible but cannot be dragged on a narrow screen',
  'connection.scrollHint':
    'On a narrow screen DSH\u2019s own shell clips the conversation column behind its fixed floats, so content is visible but cannot be dragged. The patch enables touch scrolling only when the page cannot scroll as a whole and a clipping layer exists; healthy pages are untouched. Add ?lgdiag=1 for a layout report.',
  'connection.install': 'Install as a phone app (PWA)',
  'connection.installDesc': 'Registers a service worker so the browser offers "Install app"',
  'connection.installHint':
    'Chromium browsers offer "Install app" only for a page that registers a service worker with a fetch handler, and DSH registers none. The worker registered here is empty: it caches nothing and intercepts nothing, so requests still go straight from the browser. The install entry exists only over HTTPS (or localhost). Takes effect on refresh.',
  'connection.doctor': 'Connection check',
  'connection.doctorBusy': 'Checking…',
  'connection.doctorHint':
    'Runs in this browser: which APIs the engine lacks, which page patches are active, and one real WebSocket handshake to this page\u2019s address.',

  // Transport ---------------------------------------------------------------
  'transport.title': 'Connection & certificates',
  'transport.ports': 'Proxy port {port} → upstream {upstream}',
  'transport.portBusy':
    'Port {configured} was busy, so {port} is in use. Change the port below, or stop whatever holds it.',
  'scope.label': 'Listen scope (needs a dsh restart)',
  'scope.lan': 'LAN (default)',
  'scope.lanDetail': 'Devices on the same network can connect; the gate and self-signed HTTPS stay in force',
  'scope.local': 'This machine only',
  'scope.localDetail': 'Only this machine can connect',
  'scope.custom': 'Currently a custom listen address {host} (set in the profile patch); choosing either option above overrides it.',
  'scope.hint':
    'Reachable is not the same as enterable: with no access password the gate refuses every device. To publish on one NIC only, set listenHost to that NIC\u2019s IP in the profile patch.',
  'unlock.title': 'Official settings pages for LAN devices',
  'unlock.desc': 'Lets devices that passed the gate use DSH\u2019s official settings pages',
  'unlock.hint':
    'When on, devices that passed the gate can use DSH\u2019s official settings pages after a refresh; when off, DSH\u2019s default returns and a non-loopback page reports 「settings are unavailable in this browser」. This is a UI unlock, not a new privilege: the settings API stays behind the gate and DSH still redacts secret reads. Takes effect on refresh; no dsh restart.',
  'port.label': 'Proxy port (needs a dsh restart)',
  'port.save': 'Save port',
  'port.checking': 'Checking…',
  'port.available': 'Port {port} is free',
  'port.taken': 'Port {port} is in use',
  'port.checkFailed': 'Check failed',
  'port.invalid': 'Enter a port between 1 and 65535',
  'port.hint': 'Defaults to {default}; when busy it walks forward across at most {max} ports.',
  'port.originNotice': 'The port is part of the origin: after a change or an automatic fallback, an installed app and any saved address point at the old one, and the self-signed CA must be trusted again at the new address.',
  'nic.label': 'Published network interface',
  'nic.auto': 'Automatic (physical interfaces first)',
  'nic.option': '{name} · {address}',
  'nic.optionVirtual': '{name} · {address} (virtual: {reason})',
  'nic.hint': 'The QR code and access URL follow this choice; virtual interfaces are usually unreachable from other devices.',
  'tls.label': 'Transport security',
  'tls.selfSigned': 'Self-signed HTTPS (default)',
  'tls.selfSignedDetail': 'Each device trusts the self-signed CA once',
  'tls.off': 'HTTPS off',
  'tls.offDetail': 'Plain traffic on the network; only for a fully trusted one',
  'tls.offNotice':
    'HTTPS is off: traffic on the network is plain, so the gate password and upstream cookies can be sniffed, and some browser capabilities (clipboard, service worker) are unavailable. Only for a fully trusted private network.',
  'tls.notYet': 'Switching TLS is not available yet',
  'tls.caFingerprint': 'Self-signed CA fingerprint (SHA-256): {fingerprint}',
  'tls.caHint':
    'A device must install and trust this CA first (see the README). The CA identity survives restarts; changing the IP only re-signs the leaf certificate.',
  'reason.loopback': 'Bound to loopback only, so no device on the network can reach it; set listenHost to 0.0.0.0 or a specific interface address',
  'reason.noAddress': 'No usable LAN IPv4 address was detected',
  'reason.interfaceMissing': 'The configured interface {interface} does not exist or has no IPv4 address',
  'quick.home': 'Home',
  'quick.desktop': 'Desktop',
  'quick.documents': 'Documents',
  'quick.downloads': 'Downloads',
  'quick.projects': 'Projects',
  'quick.code': 'code',
  'quick.src': 'src',
  'quick.root': 'Root',
  'quick.driveRoot': '{drive} drive root',
  'net.count': '{count} usable address(es) detected{virtual}.',
  'net.virtualSuffix': ' (including virtual interfaces, de-prioritised)',

  // Banners and update ------------------------------------------------------
  'banner.unlocked': 'Unlocked: the settings below can be changed for this session',
  'banner.relock': 'Lock again',
  'banner.readOnly':
    'Remote access (read-only). Open the console on this machine to change settings; 127.0.0.1 is unlocked.',
  'update.checking': 'Checking for updates…',
  'update.check': 'Check for updates',
  'update.busy': 'Checking…',
  'update.current': 'v{current} ✓ Up to date',
  'update.failed': 'v{current} · Check failed',
  'update.available': 'v{current} ➔ v{latest}',
  'update.github': 'GitHub',
  'update.changelog': 'Changelog',
  'update.issue': 'Report an issue',
  'update.found': 'Version v{latest} is available (current v{current})',
  'update.copyCommand': 'Copy command',
  'update.installHint':
    'The plugin installs nothing and restarts nothing. Run the command above, then restart dsh once.',

  // Feedback ----------------------------------------------------------------
  'toast.saved': 'Saved',
  'toast.approved': 'Approved',
  'toast.blocked': 'Blocked',
  'toast.unblocked': 'Unblocked',
  'toast.revoked': 'Revoked',
  'toast.copyFailed': 'Could not copy; select the text manually',
  'toast.enterPassword': 'Enter the access password',
  'error.readOnlyRemote': 'The policy is "this machine only": remote devices are read-only. Change it on this machine.',
  'error.adminRequired': 'Unlock the management console under Authentication first',
  'error.adminPasswordInvalid': 'Incorrect admin password',
  'error.csrf': 'The cross-site check refused this request; refresh the page and retry',
  'error.currentPasswordRequired': 'Enter the current password first',
  'error.gateDisabledRequiresLoopback': 'Disabling the gate requires the listen scope to go back to "this machine only"',

  // Health check ------------------------------------------------------------
  'doctor.patches': 'Page patches: settings unlock {unlock} · mobile shims {compat} · socket watchdog {watchdog}',
  'doctor.engine.ok': 'Engine capability: every API the session stream needs is present',
  'doctor.engine.missing': 'Engine capability: missing {list} (with the shims inactive the transcript sits on "Loading history…" with no error)',
  'doctor.origin': 'Page origin: {origin}{kind}',
  'doctor.origin.loopback': ' (loopback)',
  'doctor.origin.lan': ' (through the LAN gateway)',
  'doctor.agent': 'Browser: {agent}',
  'doctor.socket': 'Session WebSocket ({host}): {outcome}',
  'doctor.socket.ok': 'handshake succeeded in {ms} ms',
  'doctor.socket.create': 'could not create a WebSocket: {message}',
  'doctor.socket.timeout': 'no handshake within 12 seconds (WebKit stuck in CONNECTING after a background resume)',
  'doctor.socket.failed': 'WebSocket handshake failed (gate refusal or untrusted certificate)',
  'doctor.relay': 'Proxy: {active} live · {upgrades} upgrades · {refused} refused · {answered} heartbeats answered',
  'doctor.last': 'Last: {state} · alive {seconds}s · up {up}KB / down {down}KB{abnormal}',
  'doctor.last.upgraded': 'upgraded',
  'doctor.last.refused': 'refused {status}',
  'doctor.last.abnormal': ' · abnormal close (no Close frame)',

  // Workspace picker --------------------------------------------------------
  'picker.title': 'Choose a workspace directory',
  'picker.adding': 'Adding workspace…',
  'picker.unreadable': 'This directory cannot be read right now; see the notice above.',
  'picker.empty': 'This folder has no subfolders',
  'picker.truncated': 'Too many folders; showing the beginning only.',
  'picker.use': 'Use this directory',
  'picker.unlockPlaceholder': 'Admin password (or the access password)',
  'picker.unlock': 'Unlock',
  'picker.unlocking': 'Unlocking…',
  'picker.noPicker': 'This host has no system directory picker',
  'picker.unlockFailed': 'Unlock failed (HTTP {status})',
  'picker.adminPasswordInvalid': 'Incorrect admin password',
  'notice.readOnly.title': 'Remote devices are read-only',
  'notice.readOnly.detail':
    'On this machine, open Settings → LAN access → Authentication → Remote management rights and choose "Password unlock" or "Not locked", then refresh this page.',
  'notice.adminRequired.title': 'Unlock the management console first',
  'notice.adminRequired.detail': 'Enter the admin password under Settings → LAN access → Authentication, then retry.',
  'notice.rateLimited.title': 'Too many requests',
  'notice.rateLimited.detail': 'Try again shortly.',
  'notice.blocked.title': 'Blocked by the security policy',
  'notice.blocked.detail': 'System and credential directories (.ssh, .aws, .env and similar) can be neither browsed nor used as a workspace.',
  'notice.notFound.title': 'Directory not found',
  'notice.notFound.detail': 'It may have been moved or deleted; go up one level and choose again.',
  'notice.notADirectory.title': 'Not a folder',
  'notice.notADirectory.detail': 'A workspace must be a directory.',
  'notice.invalidPath.title': 'Invalid path',
  'notice.invalidPath.detail': 'Use a complete absolute path.',
  'notice.unreadable.title': 'Could not read the directory',
  'notice.unreadable.detail': 'Insufficient permission, or the disk is unavailable.',
  'notice.forbidden.title': 'Session expired',
  'notice.forbidden.detail': 'Refresh the page, sign in again, then retry.',
  'notice.unknown.title': 'Could not read the directory',
  'notice.unknown.detail': 'Unknown error.',
  'notice.coded.detail': 'Could not read the directory ({code}).',
}

/** Substitute `{name}` placeholders the way the official locale service does. */
function substitute(template: string, params: TranslateParams | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    (name in params ? String(params[name]) : match))
}

/**
 * The Chinese-only translator.
 *
 * A stand-in for hosts that ship no `locale` service: the section still renders
 * in the language it always did instead of failing to mount. DSH's web client
 * always provides the service, so this is a degradation path, not a mode.
 *
 * @returns a translate function over the Chinese dictionary.
 */
export function standaloneTranslate(): Translate {
  return (key, params) => substitute(zh[key] ?? key, params)
}
