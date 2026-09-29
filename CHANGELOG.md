# Changelog

## [0.4.5] — 2026-09-29（长会话延迟挂载时，裁剪补偿不再提前收工）

**现象**：0.4.4 之后，部分长会话在手机上依旧「只有一小段、拖不到底」，而同一条会话在宽屏/桌面完全正常。

**根因**：`run()` 在 `convScrolls()` 为真时立刻 `done=true` 收工，而 `fixClip()` 每次只处理当次已存在的被裁层。长会话的正文是**后挂载**的——官方滚动层先拿到少量可滚范围（本次实测仅 336px），`EvIC1a_frame` 稍后才以 `overflow:hidden` 锁死高度。于是补偿恰好在最需要它的那一刻已经停止轮询；真机上表现为注入标记在、`fixClip()` 的补偿逻辑在，却没有留下任何内联修补。

**修法**：`convScrolls()` 为真时不再结束，改为保留原有的每 1.5s、最多 30 次（约 45s）轮询窗口，等延迟出现的裁剪层交给 `fixClip()` 释放；补偿成功或回退分支成功才收工。`fixClip()` 自身「可滚范围没有变大就整体回退」的自检不变。

**真机验收**（iPhone 16 Pro Max / iOS 27，经代理 3081，同一长会话）：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 官方滚动层 client / scroll | 668 / 1004 | 668 / 7557 |
| 可滚范围 | **336** | **6889** |
| 滚动层内部被裁层 | 1（`EvIC1a_frame` 796 高、`overflow:hidden`） | **0** |

官方「回到底部」按钮仍在屏内（y=538），未复现 0.4.4 修过的 sticky 回退；脚本仍只在窄屏 + 移动 UA 下运行，宽屏与桌面不受影响。

## [0.4.4] — 2026-09-29（补偿 DSH `0.2.0-rc.1` 的会话裁剪回归）

**现象**（真机 iPhone 16 Pro Max / iOS 27，经代理的 3081）：会话内容看得见，但**手指几乎拖不动、打开会话也不停在最新消息**。

**根因（真机 A/B）**：DSH `0.2.0-rc.1` 下，官方滚动层 `[data-conversation-scroll]` **内部**的 `EvIC1a_frame` 是 `overflow:hidden` 且高度被锁死（≈视口高），把 21083px 的会话内容裁掉，高度传不上去——该滚动层虽然「有溢出」，可滚范围却只有 **336px**：

| | `0.1.7-rc.2`（本机 10.0.0.20） | `0.2.0-rc.1`（lionm4 10.0.0.30） |
| --- | --- | --- |
| 滚动层 client / scroll | 720 / 15925 | 668 / 1004 |
| 可滚范围 | 15205 | **336** |
| 最后一条消息 | 在屏内 | 在 21215px 处（屏外） |

把页面上本插件的内联改动全部清掉后该裁剪依旧存在 ⇒ **属 DSH 原生回归，不是注入造成的**；本插件的角色是补偿。

**修法**：`mobileScrollFix` 新增 `fixClip()`——对滚动层**内部**满足「`overflow:hidden/clip` 且内容溢出」的层**同时**设 `height:auto` 与 `overflow:visible`，并以「可滚范围是否真的变大」自检、无效则整体回退。两条缺一不可：

- `height:auto`：让该层长高到内容高度，高度才能回流到官方滚动层；
- `overflow:visible`：让该层不再是滚动容器。否则官方「回到底部」的槽（`EvIC1a_toBottomSlot`，`position:sticky; bottom:208px`）会以该层自己的底边为参照，按钮从 y≈514 掉到 y≈10683 而消失（这是只改 `height:auto` 时的实测副作用）。

只动滚动层内部那一层：不新建滚动容器、不改官方其余 UI。同一版还把 `touchPassThrough()` 与 `fixClip()` 都移到 `convScrolls()` 短路**之前**——此前「官方滚动层按尺寸可滚」（正是故障场景本身）会让放行逻辑永不执行，Runbook 期望的 `touch passthrough layers=N` 也永远打不出来。

**真机验收**（同一长会话，滚到中段）：可滚范围 336 → **20675**；输入框在顶部/中段/靠底/到底四处均为 `[588,780]`（吸底）；官方 ↓ 按钮四处均在 `[538,572]`（与 stock 的 `[514,548]` 同区）；滚到底时最后一条消息 `[540,572]` 在视口内。`?lgdiag=1` 面板输出 `clip grow layers=1 max 336->20675` → `clip released -> max=20675`。

**已排除的误判**：用户报「输入框底下还能看到滚动的文字」。按 10px 密集采样输入框那一条（586→796），stock 与修复后的最上层元素/背景/透明度**逐点完全一致**（如 y=786 两者都是透明的会话正文）⇒ 属 DSH 自带样式，非本版引入。

## [0.4.3] — 2026-09-28（改用 dsh-mobile 式「高度链」修正，移除自建补丁）

### 方向修正 — 不再给内容层打 overflow 补丁

**对照实验（用户实测）**：3080 直连（本插件注入不生效）**能正常拖动**；3081 经代理（注入生效）**拖不动**；而 dsh-mobile 在**同一套官方 UI、同一台手机**上可用。

**dsh-mobile 的做法是移动端「高度链」**（`src/mobile-layout.ts`）：

```css
html, body, #root { height:100%; overflow:hidden }
.dshm-shell { height:100dvh }   /* dvh，不是 vh */
.dshm-main  { min-height:0 }    /* flex/grid 子项允许收缩 */
```

**根因**：官方外壳在窄屏 iOS 下高度链断裂——实测内容 1688 被裁在 844 的层里，而官方认定的滚动层 `[data-conversation-scroll]` 永远 754/754（内容没进它的流）。后果：手指拖不动、官方「回到底部」点了没反应、**打开会话也不会停在最新消息**。0.4.1/0.4.2 给内容层打 `overflow-y:auto !important` 是治标，并引发了白屏与抽屉遮罩两个副作用。

**0.4.3 的做法**（`mobileScrollFix`）：

1. 给 `html/body/#root` 一个确定高度（`100%`，支持时 `100dvh`）并锁住页面滚动；
2. 沿「被裁且内容溢出」的那一层，给链上所有 flex/grid 容器补 `min-height:0`；
3. **立刻验证**官方认定的滚动层是否真的能滚：能 → 保留；**不能 → 全部撤销**，页面回到与官方逐字节一致（宁可不动，也不引入第二个滚动层）；
4. 遮罩/对话框打开时同样先撤销（0.4.2 遮罩事故的教训）。

**移除**：自建「回到底部」按钮（官方按钮恢复工作，且打开会话会自动停在最新）、内容层 `overflow-y`/`touch-action` 补丁、`-webkit-overflow-scrolling`。

### 补充（同日真机诊断后）— 触摸放行

真机 `?lgdiag=1` 的决定性数据：`official scroll layer already works`——官方滚动层**是可滚的**，但手指拖不动。结论：**触摸被全屏视觉层吃掉**（`pI_x6G_overlayLayer` / `dsh-sc-layer` 这类 `position:absolute/fixed` 的全屏层，在 iOS 上 `pointer-events:auto` 会拦截触摸；桌面 Chrome 的滚轮走另一条路径，所以本地一直"能拖"）。

新增 `touchPassThrough()`：只对**纯视觉容器**放行触摸（全屏覆盖、`pointer-events` 非 none、不含 button/input/textarea/select/[contenteditable]、文本 <40 字符），设 `pointer-events:none !important`；真正的交互层一律不碰。

### 兼容性声明 — DSH 0.2.0-rc.1

- `dsh.engines.dsh`、`peerDependencies['@deepseek-ai/dsh-client-connection']` 与 `peerDependencies['@deepseek-ai/dsh-host-webserver']` 的上界由 `<0.2.0` 放宽为 `<0.3.0`，`dsh.compatibility.dshReleases` 新增 `0.2.0-rc.1: compatible`。旧上界是一颗定时炸弹：profile 加载会拒绝范围不含运行版本的 bundle，而裸的 `<0.2.0` 恰好排除 DSH `0.2.0` 正式版——正式版发布当天本插件会被静默丢弃。
- 依据：本插件正以 link 方式运行在当前 DSH `0.2.0-rc.1` profile 中（无 skipping 警告）；`dsh.client.inject` 涉及的宿主包（`dsh-client-ui-renderer`、`dsh-client-ui-layout`、`dsh-client-ui-settings(-general)`）与 peer 包（`dsh-client-connection`、`dsh-host-webserver`）在 `dsh-v0.1.7-rc.2` → `dsh-v0.2.0-rc.1` 之间仅有版本号改动，本插件用到的接口面（`webServer.register` / `tapIndex`、`connection.requestRejection`、`connection.authenticatedUrl`、`settings.section` seat）无一变化。仅声明，零代码。

### 升级

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

重启一次 dsh 生效。

## [0.4.2] — 2026-09-28（手机端补上「回到底部」按钮）

### 修复 — 手机上滚动到中间时没有回到底部的按钮

**症状**（2026-09-28 用户报告）：0.4.1 之后手机已经能滚动、也能看到最新内容，但**滚到消息中间时右下角没有「回到底部」的下箭头**，只能手动往回滑。

**根因（官方源码 + 真机视口诊断）**：官方自带这个按钮（`chat.toBottom`），显示条件是「不在尾部」（`!scroll.followingTail`），而这个判断基于官方认定的滚动层。窄屏下官方布局（`dsh-client-ui-layout` 的 `pI_x6G_frame`）承担了实际滚动，而 conversation 的 `[data-conversation-scroll]` 层内容高度并没有跟着涨——实测 `convScroll 754/754`，同时 `pI_x6G_frame 844/1688`。两边不一致 → 官方永远以为还在尾部 → 按钮不出现。

**改动**（并入 `mobileScrollFix`，窄屏 + 移动端生效）：网关侧自带一个「回到底部」按钮：
- 不依赖官方内部状态：每次滚动/尺寸变化后，找出**当前真正在滚动的容器**（滚动量最大且可见者），不在尾部时显示 36px 圆形浮动按钮，点击平滑滚到底；
- **自动避让**：一旦检测到官方按钮（`aria-label` 含「底部」或 `bottom`）出现，自己的按钮立即移除，不会出现两个；
- **自动避开输入框**：按输入框位置动态计算按钮的 `bottom`（键盘弹出、快捷回复展开时不会压住输入区）。

### 修复 — 打开左侧边栏被遮罩盖住（0.4.2 内的回归修复）

**症状**：0.4.2 的滚动矫正上线后，手机上打开左侧边栏会被一层灰雾盖住、点不动。
**根因（用户 A/B 实测确认）**：矫正给内容滚动层加了 `overflow-y:auto !important`（以及 `-webkit-overflow-scrolling:touch`），与官方抽屉打开时的滚动锁定/层级互相打架；把 `mobileScrollFix` 关掉即恢复正常。
**改动**：检测到全屏遮罩/对话框（`[aria-modal=true]` / `[role=dialog]` / `[data-conversation-overlay]`，或命中点上方有覆盖 ≥85% 视口的定位层）时，**完全撤销**自己加过的样式并隐藏自己的按钮，把页面还给官方；抽屉关闭后再应用。同时**去掉 `-webkit-overflow-scrolling`**（iOS 会为它强制合成层，正是层级错乱的来源）。

### 升级

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

重启一次 dsh 生效。

## [0.4.1] — 2026-09-28（修掉手机端「聊天区滑不动」）

### 修复 — 手机上会话内容可见但无法上下滑动

**症状**（2026-09-28 用户报告）：手机上打开会话，最新内容能看到一部分，但**无法上下滑动**；底部固定的「目标条 / 快捷回复 / 输入框」压住内容，右侧滚动条停在中途。

**定位（诊断数据来自真实 iPhone 视口）**：DSH 官方外壳在**窄屏 + 移动端**下的根层 `pI_x6G_frame` 是 `overflow:hidden` 且内容溢出——实测 `clientHeight=844 / scrollHeight=1688`，同时**整页也不可滚**（`pageScrolls=false`）。内容被裁在容器里，手指自然滑不动。同一视口在桌面 Chrome 上滚动正常，因此这是 iOS/窄屏的布局差异，**与反向代理无关**（页面 DOM/CSS 全部来自官方 UI）。

**改动**：新增默认开启的 `mobileScrollFix`。注入的脚本**只在四个条件同时成立时**才动手：窄屏（≤1023px）、移动端 UA、**整页不可滚**、且**确实找到被裁剪且内容溢出的层**；然后只把那几层改为可触摸滚动（`overflow-y:auto`、`-webkit-overflow-scrolling:touch`、`touch-action:pan-y`）。能正常滚动的页面一律不碰（实测：桌面视口与健康页面下 no-op）。诊断：页面 URL 加 `?lgdiag=1` 会显示一屏布局数据（`narrow/mobile/innerH/pageScrolls/clippingLayers/是否已修`）。

### 真机验收（2026-09-28 用户实测通过）

同一台 iPhone（16 Pro Max）上验证：

| 场景 | 结果 |
| --- | --- |
| 打开长会话 | 能看到最新内容、可上下滑动（修复前内容被裁、滑不动） |
| **锁屏 60 秒后回来** | 会话仍在、**无需重连**，回来后直接发消息成功 |
| 代理侧记录（同轮） | 最长一条连接存活 **86.4 秒**且**正常 Close**；整轮**无 `1006` 异常断开**；代答心跳累计 **274 次**。对照 0.3.6 基线：静默客户端 ~6 秒即被 `1006` 切断 |

### 同时

- `mobileCompat`（垫片）与 `socketWatchdog`（看门狗）**保持关闭**：`0.4.0` 曾让手机整页空白，在确认到具体成因前不默认开启。代理代答心跳 `answerHeartbeat` 保持开启（本次问题的另一处真修复，不碰页面）。

### 升级

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

重启一次 dsh 生效。

## [0.4.0] — 2026-09-28（手机长连接自愈：代理代答心跳 + 页面看门狗 + 兼容垫片）

### 修复 — 手机端「会话载入不全，甚至断开」

**症状**（2026-09-28 用户报告，附手机截图）：手机上打开会话，界面、目标条、统计数字都在，唯独对话区永久停在「载入历史…」，并反复断开；同一网络下别的局域网入口却看不出来。

**定位（实测，不是推测）**：会话记录**只走 WebSocket**（`/api/remote.mux` 上的 `session/follow`），会话列表/goal/统计则来自 HTTP——所以症状的形状是「界面在、对话空」。

1. 宿主每 2 秒 Ping 一次，连续两次没被回应就 `terminate`（`websocketHeartbeatIntervalMs: 2000`、`MAX_MISSED_HEARTBEATS: 2`）。
2. 用真实 DSH 实测：客户端停止回 Pong 后 **6.0 秒**被切断，`close 1006`（连 Close 帧都没有），三处独立复现（直连 3081、经转发、浏览器冻结主线程各一次）。
3. 手机锁屏/切走时页面被系统挂起，回不了心跳；WebKit 另有一类已知问题：后台恢复后 `new WebSocket()` 永久停在 CONNECTING，而 HTTP 一切正常。
4. 缺现代 API 的引擎（`AbortSignal.any` 等）会在 DSH 的会话流里抛错，而 `Session.doOpen` 会把非传输类异常原样抛出——界面上就只剩「载入历史…」，**连报错都没有**。

**改动**（三层，默认全开、可逐项关闭）：

- **`answerHeartbeat`（代理代答心跳）**：新增 `src/ws-heartbeat.ts`，在中转时只读地解析上游→浏览器方向的 WS 控制帧，遇到 Ping 立刻以客户端身份回一个掩码 Pong。RFC 6455 允许未经请求的 Pong，宿主只按「收到过 Pong」重置计数，手机自己回的重复包无害。**实测：停回心跳 6 秒被切断 → 代答后 20 秒以上存活。** 转发仍是纯字节管道，观察器最多只累积 14 字节头（Ping 再多 125 字节），异常即永久退出（fail-open）。
- **`socketWatchdog`（断线看门狗）**：服务端注入的页面补丁。卡在 CONNECTING 超过 8 秒的 socket 会被关掉；从后台回来 10 秒后仍一条都没连上时重载一次（每标签连续最多 3 次，冷却 20 秒起、成功连上即清零）。从未建过 socket 的页面永远不会被重载。
- **`mobileCompat`（移动端兼容垫片）**：补 `AbortSignal.any`/`AbortSignal.timeout`/`Promise.withResolvers`/`Iterator`，并把 viewport 换成带 `viewport-fit=cover` 的那一条、补 `apple-mobile-web-app-*` 与 `theme-color`。每个垫片都只在缺失时安装；**不禁用缩放**（本插件的移动端契约不是拿走用户的捏合手势）。

### 新增 — 「连接与证书 → 手机连接与自愈」+ 连接体检

- 三个开关的控件都在这里，每个都写明「为什么需要它」。
- **连接体检**在这个浏览器里跑：缺哪些 API、页面拿到了哪些补丁、对当前地址做一次真实 WebSocket 握手（12 秒超时会把「卡在 CONNECTING」单独报出来）。
- 代理侧计数：在活连接、累计升级、被拒次数、**代答心跳次数**，以及最近 12 条连接的时长、上下行字节、是否异常断开（无 Close 帧）。计数器是有界环形缓冲，不写日志文件。

### 验证

- 新增/更新用例，测试套件 **349 项**全绿（0.3.6 为 330）。
- 心跳代答有端到端用例：上游按 40ms 心跳、漏 2 次即 destroy —— **关掉代答必被回收、打开代答连接存活**。
- 注入的页面脚本在测试里被执行（假环境 + 假时钟）：超时关 socket、有 OPEN 不重载、无 socket 不重载、后台恢复才重载一次并按冷却与上限退避、隐藏时不重载。
- 浏览器实测（Chrome 154，经临时回环转发走完整插件链路）：WS 握手 3ms、首帧 2.1MB 单帧 43–110ms、12 秒 310 帧无中断；无代答的连接在页面冻结 12 秒后收到 `close 1006`。
- 真实 DSH 上的装机验证在发布后进行（本机运行的是已安装的 0.3.6，需重装 + 重启 dsh 才生效）。

### 升级

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

## [0.3.6] — 2026-09-26（远程也能添加工作区：修掉让远程管理台永远锁定的代理缺陷）

### 新增 — 远程设备可以添加工作区（智能分流 + 页面内目录浏览器）

**症状**（2026-09-26 用户报告）：在局域网另一台电脑（或手机）上点「添加工作区」，远程那侧没有任何反应，**对话框却开在运行 DSH 的电脑屏幕上**。

**根因**：DSH 的目录选择器在**进程启动时判定一次**（`dsh-host-directory-picker-auto`）。判定要求「仅回环绑定 + 非 SSH + 有显示器」，而 DSH 自身正是只绑回环，所以 macOS/Windows 上恒判为 `native`——对话框属于**宿主屏幕**，远程设备永远够不到。这个判定是进程级的，无法按客户端重算。

**改动**：不碰 DSH 的组合（钉死 `-browse` 会把本机操作者的系统对话框也一起拿走），而是在浏览器侧**遮蔽**官方目录流程占用者——`single` 槽位渲染最低优先级，且每个优先级只允许一个占用者，因此 `priority: -20` 能接管而不触发重复注册：

- **本机浏览器**（回环 hostname / Electron / 桌面 preload）仍走系统原生对话框；
- **远程设备**改用页面内目录浏览器：面包屑、快捷入口、目录列表、「使用此目录」，并可在弹层内**直接解锁管理台**，不必再去找设置页的锁定卡片。

选中的路径仍交回 DSH 官方工作区流程登记（`onPicked` → `workspaces.create`），插件**只读目录、不创建不修改任何文件**。

### 修复 — 代理双向丢弃插件自己的管理 cookie，`password_unlock` 对远程形同虚设

**症状**：在远程设备上把管理策略设为「密码解锁」并提示已保存，但远程设置页始终锁定、远程目录浏览恒返回 `403 admin_required`（用户描述为「添加工作区里仍然是空的」）。

**根因**：代理**双向**丢弃了本插件自己的管理会话 cookie —— 请求方向用注入的上游 cookie 整体替换 `Cookie` 头，响应方向丢弃全部 `set-cookie`。而校验 `isAdminUnlocked()` 的代码跑在 DSH 的 web server 上、只能经代理到达，于是解锁 POST 返回 200、下一个请求仍被判为锁定。

**改动**（`src/headers.ts`、`src/proxy.ts`）：只放行本插件自己的 cookie 名（`dsh_lan_guard_admin`）。**DSH 自身的会话 cookie 依旧绝不外泄**，访客的门禁会话与设备身份 cookie 也依旧不到上游。这一处修复同时修好了整个远程管理面（设置写入、设备管理、解锁），不只是目录浏览。

### 修复 — 设置页一直没有「远程设备管理权限」控件

**根因**：`POLICY_CHOICES`（密码解锁 / 仅本机 / 不锁定）从写下那天起就是**死代码**，从未被渲染；`adminPolicy` 只能手改 profile patch，而它正是远程目录浏览能否工作的开关。

**改动**：安全认证 tab 补上「远程设备管理权限」与「管理操作需要先解锁」两个控件。另外，目录浏览路由的鉴权改为与其它管理写入完全一致（`adminProtection=false` 同样放行），避免「设置能改、目录却被拒」的矛盾。

### 修复 — 「已保存」横幅会把整页推下去

**症状**：任何一次保存都在页面顶部弹出一栏，长 tab 底部保存时页面像跳了一下，且看不出是否真的保存了。

**改动**：改为**右上角固定 toast** —— 不占布局、不引起位移；带图标、关闭按钮与倒计时条（条与定时器共用同一个 `TOAST_MS`，不会漂移）。同时修掉「2.6 秒内连续保存时，旧定时器把新提示提前掐掉」的问题。

### 修复 — 状态表面配色在深色与浅色下都不达标

**根因**（按 DSH 0.1.7 真实调色板实测）：

- `--dsw-alias-state-business-primary` 当**正文颜色**时对比度只有浅色 **3.60:1** / 深色 **4.39:1**，低于 AA 正文的 4.5:1；
- `--dsw-alias-interactive-bg-hover-danger` 解析成 8 位 hex、alpha 仅 **0x0d（5%）**——它是 hover 染色，**不能当背景**，拿它当表面等于背景近乎透明。

**改动**：语义色只用于**图标与边框**（门槛 3:1），文字一律 `label-primary`（浅 16.04:1 / 深 9.79:1）；danger 表面改为 `color-mix(error-primary 12%, bg-layer-1)`（浅 `#fde3e3` / 深 `#3c2a2a`），按仓库既有约定先写实心 token 兜底。**原有的 `.lg-bar.*` 与 `.lg-chip.wait` 有同样问题，一并修正。**

### 修复 — 目录弹层的面包屑与快捷入口两行被压扁重叠

**根因**：flex item 的**自动最小尺寸**在其 `overflow` 不是 `visible` 时解析为 **0**，而这两行都要横向滚动；列表又写了 `min-height`，于是内容超高时被压缩的只有这两行（实测被压到 9px / 11px，内容需要 24px / 27px，必然溢出重叠）。

**改动**：固定行显式 `flex:0 0 auto`，列表成为唯一可伸缩行（底部按钮永远不会被挤出），sheet 加 `overflow:hidden`，面包屑与快捷入口 chip 加 `white-space:nowrap`。

### 验证

- `pnpm run typecheck` ✓；`pnpm test` — **330 项全绿**（0.3.5 为 273 项，+57）；
- **逐提交隔离验证**（在独立 worktree 里检出每个提交单独跑）：`fix(proxy)` 278 项、`feat(picker)` 宿主半边 304 项、`feat(picker)` 浏览器半边 330 项，三个提交各自 typecheck 干净、测试全绿；
- 新增用例覆盖：代理 cookie 双向中转（含 gate cookie 不外泄的反证）、目录栅栏（敏感段 / 符号链接逃逸 / 截断 / 限流）、路由鉴权矩阵（本机 / 远程只读 / 需解锁 / 已解锁 / 栅栏拒绝）、slot 注册契约、错误码→可执行提示、CSS 布局不变量、设置页控件覆盖、toast 单一常量与定时器清理；
- **反证**（隔离回退后重跑）：回退 cookie 中转 → round-trip 用例失败；回退 `flex:0 0 auto` → 布局不变量用例失败；把 hover 染色当背景 → 配色用例失败；
- 配色对比度用 DSH 真实 token 取值逐项计算，**浅色/深色 10/10 通过**；弹层布局在真实 Chrome 里量过尺寸（修复前 9px/11px → 修复后 30px/36px）。

### 升级

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

然后重启一次 DSH（宿主与客户端 bundle 都变了，刷新页面不够）。

## [0.3.5] — 2026-09-26（连接层可见性：明文请求 301 + 旧设备 cookie 不再锁死）

### 修复 — 用 `http://` 打开 TLS 端口时只看到「无法访问」，日志里也什么都没有

**症状**（2026-09-26 用户报告）：把 `http://<地址>:<端口>` 交给浏览器（二维码或地址栏写成 http），页面显示「无法访问」，浏览器报 `ERR_EMPTY_RESPONSE`（-324）；**日志里没有任何记录**，完全看不出发生了什么。

**根因**：明文 HTTP 请求到达 TLS 监听端口时握手先失败，Node 在 `tlsClientError` 里默认**一个字节都不回**并直接销毁连接；而门禁运行在握手之后，所以这一层失败在门禁侧完全不可见。

**改动**（`src/proxy.ts`）：
- 监听 `tlsClientError`，记录 `tls handshake failed code=… plaintextHttp=… ip=…`；
- 对 `ERR_SSL_HTTP_REQUEST`（明文请求）回一个 **301 到同地址的 `https://…/`**，浏览器自动切到正确协议。明文应答无法通过 `TLSSocket` 发出（实测客户端收到 0 字节），因此写在底层原始 socket（`_parent`）上——该私有字段在 Node 20/22/24 上验证；字段缺失时安全降级为原来的销毁行为，不会更糟；
- 补上 `clientError`：畸形请求同样记录 `malformed request code=… ip=…`，并**原样复现** Node 默认的 `400 Bad Request`（挂监听器会替换默认处理，不能把默认响应弄丢）。

### 修复 — 删除设备记录后，这台浏览器被永久锁死

**症状**（2026-09-26 手机实测）：一台曾经配对过的手机，在管理员**删除**它的设备记录后，永远只能看到「此设备已被移除访问权限」——换免密链接、输访问密码都进不去，只有清除本站数据才行。

**根因**：门禁把「带着设备 cookie、但记录已不存在」与「被吊销/拉黑」同等处理（都走移除页）。而移除页在读取 `?auth=` **之前**就产生了，所以任何链接都救不回来。记录被删属于**浏览器侧过期状态**，不是身份。

**改动**（`src/auth/gate.ts`）：cookie 指向不存在的记录时不再拒绝，而是**按没有 cookie 继续正常认证流程**——访问密码或新链接都能恢复，配对流程会给它一条新身份。WebSocket 升级同样处理（回落到会话判定，而不是 403）。**吊销（revoke）与拉黑（block）仍然拒绝**：它们的记录还在，语义未变。

### 变更 — 移除页文案随实现修正

「若该记录已被删除，请清除本浏览器的本站数据」这条死路已不存在，文案改为只保留真正有效的一条：请联系管理员在「已授权设备」中「解除拉黑」，同一台设备会立即恢复。

### 验证

- `pnpm run typecheck` ✓；`pnpm test` — **273 项全绿**（0.3.4 为 263 项，+10）；
- 新增 `tests/proxy-tls-port.test.ts`（真实 socket：明文请求得到 301、真实 TLS 客户端不受影响、握手失败与畸形请求都进日志、畸形请求仍复现 Node 的 400）与 gate 的 5 条用例（旧 cookie 经免密链接/密码恢复、WebSocket 升级不再 403、吊销与拉黑仍拒绝、移除页文案不再提「清除本站数据」）；
- **反证**（在隔离副本里回退修复后重跑，确认用例不是空测试）：回退 `gate.ts` → 3 条恢复用例失败（3 failed / 41）；回退 `proxy.ts` → 3 条连接层用例失败（3 failed / 5），而固定"未改行为"的用例仍通过。

## [0.3.4] — 2026-09-26（局域网设备可用官方设置页）

### 新增 — 默认开启的 `settingsUnlock`：局域网设备也能用官方「模型」页

**症状**（2026-09-26 用户报告）：在局域网另一台机器（含手机）打开「设置 → 模型」，报 `加载提供商目录失败: settings are unavailable in this browser`；同一台电脑用 `127.0.0.1` 打开则完全正常。

**根因**（**不是本插件的故障**）：DSH 客户端按**页面地址栏**是否为回环决定官方设置面能否持久化 —— `persistence = ctx.remote.$host.isLoopback ? "host" : "memory"`；而 `isLoopback` 由连接客户端按 `transport?.ownsHost === true || pageLocation 为空 || isLoopbackHostname(pageLocation.hostname)` 推导，只认 `localhost`、`[::1]`、`127/8`。局域网地址不是回环 → 设置镜像永久停在 `unavailable` → 模型页拿不到 settings describe。**代理改写请求头改不到它**，因为这个判断发生在访客自己的浏览器里（服务端 `/api` fence 早已被 `host` 改写满足）。

**改动**：新增顶层 volatile 开关 `settingsUnlock`（**默认 `true`**）。开启时，host 侧通过 DSH 公开的 `webServer.tapIndex` 往 index.html 的 `<head>` 后注入一行脚本：

```html
<script>/*dsh-lan-guard:settings-unlock*/(function(){var t=globalThis.__DSH_TRANSPORT__;globalThis.__DSH_TRANSPORT__=Object.assign({},t!==null&&typeof t==="object"?t:{},{ownsHost:true});})()</script>
```

`ownsHost` 正是 DSH 桌面壳自己设置的标记，页面因此被当作宿主自身界面。tap 每次渲染都读实时开关，**改开关只需刷新页面，不重启 dsh**；关掉即恢复 DSH 原生行为。

- 新增 `src/settings/index-tap.ts`（`settingsUnlockScript` / `injectSettingsUnlock` / `registerSettingsUnlock`）：`tapIndex` 不存在时只 warn 降级，不拖垮插件；注入**只作用于 index.html**（`tapIndex` 是 `renderIndex` 的唯一入口），且早于压缩，因此**不碰代理的 `upstreamRes.pipe(res)` 热路径**，不需要缓冲/解 gzip/改 content-length；
- `src/config.ts`、`src/store/preferences.ts`、`src/settings/routes.ts`：开关接入 schema、live switches、偏好白名单与设置快照；
- `src/client.ts`：「连接与证书」tab 新增「局域网设备可用官方设置页」开关与说明（含「刷新生效」提示）；
- README（中英）：开关条目、profile patch 示例、排障条目、安全边界说明。

### 边界 — 这是界面解锁，不是新增传输权限

- 经代理的请求本就被改写成回环 `host`，DSH 的 settings 接口只由本插件的门禁与管理员策略把关（读取仍由 DSH `redactSecrets` 脱敏）；该开关只是让官方页面不再显示「不可用」；
- 注入采用 **merge 而非覆盖** `__DSH_TRANSPORT__`，保留上游将来写入的值；该 global 的另外两个消费点行为不变（API gateway 的 stream mux 回退 `document.baseURI`、账号登录回退 `window.location.origin`）；
- 依赖 DSH 内部 global 名：上游若改名，此开关**静默失效**（退回原报错，不会崩）。

### 验证

- `pnpm run typecheck` ✓；`pnpm test` — **263 项全绿**（0.3.3 为 247 项，+16）；
- 注入脚本在真实 Chrome、经**非回环地址**（`http://10.0.0.30:3998`）实测三种情况：无预置 global、预置对象（`streamBaseUrl` 保留且 `ownsHost` 翻真）、预置字符串（不抛错），三种结果都是 `ownsHost=true`；
- **未验证**：真实 DSH 页面上官方「模型」页的最终可用性 —— 需要把本版本装进运行中的 profile 并重启 dsh，属发布后的单独步骤。

## [0.3.3] — 2026-09-26（门禁体验修复：两道关说清楚 + 两处死路）

### 修复 — 失效免密链接页无法输入密码（死路）

**症状**（2026-09-26 在真实服务上实测）：扫码打开一条**已失效**的免密链接（被「重新生成」作废、或被截断丢了参数）时，页面正文写「请输入访问密码」，但 `<input id="password">` 和提交按钮**都带 `disabled`** —— 访客按提示去输密码却输不了，只能手动把地址里的 `?auth=…` 删掉才能重试，手机上很难操作。

**根因**：`src/auth/login-page.ts` 的 `blocked` 列表把 `link-inactive` 也当成"登录也没用"的状态（commit `5595204` 引入，与该状态自己的提示文案自相矛盾）。`link-inactive` 只说明**链接**失效，密码登录仍然可用。

**改动**：`blocked` 移除 `link-inactive`；`LOGIN_CAPABLE_STATES` 白名单保留它（"首次命名"提示在该页仍显示）。测试新增 2 条：该页密码框与按钮必须可用、且密码真的能从该页登录；"未设密码"这类登录也无用的状态仍保持禁用（`blocked` 不是被删掉）。

### 修复 — `device-removed` 页的"删除记录后重新确认"是死路

该页原写「或让管理员删除该记录后重新确认」。但删除记录后，浏览器仍会带着**旧的设备 cookie**，`lookup` 找不到记录 → 依旧只看到这一页，永远回不来。

**改动**：改为「请联系管理员在「已授权设备」中「解除拉黑」，同一台设备会立即恢复；若该记录已被删除，请清除本浏览器的本站数据后再访问。」——前者确实有效（解除拉黑保留记录，同一枚 cookie 立即恢复）。

### 变更 — 「拒绝并拉黑」的说明改为如实描述

**问题**（2026-09-26 用一次性探针实测）：设置页原写「拒绝并拉黑」会让设备"即使知道密码、换浏览器重新配对也被拒绝"。实测并非如此：拉黑后**旧设备 cookie** 访问确实 403，但同一台手机**清掉浏览器数据**（或换浏览器）后，用免密链接/密码可重新配对（302），拿到一条**新的 approved 记录**并进入应用（设备列表变成 `同一台手机换个浏览器:approved, 旧手机:blocked`）。

**根因**：拉黑只让**旧 token** 失效（`src/auth/gate.ts` 只比对 cookie 里的 tokenHash），`DeviceRegistry.add()` 不检查 blocked 记录，全仓没有按 IP 兜底的地方。真正能"彻底挡住"的是**同时更换访问密码**。

**改动**：`src/client.ts` 的说明改为——拉黑作废的是这台设备的身份（它在这个浏览器里会被一直拒绝），清掉浏览器数据或换浏览器后仍可用密码重新配对，要彻底挡住请同时更换访问密码。

**未实施**：按 IP 兜底（拉黑时记 IP、重新配对时拒绝同 IP）。DHCP/VPN 会换 IP，可能误伤，留待评估后再定。

### 新增 — 首次访问的两道关提前说明

**用户反馈（2026-09-26）**："手机端扫码时只让我输密码，不让我输名称"——门禁是「① 认证（免密链接或访问密码）→ ② 命名配对」两道关，但设置页只写"扫码即登录"，让人以为一步到位。

- `src/auth/login-page.ts` 新增 `pairingRequired` 选项：密码页在**提交之前**提示「首次访问：通过后还需要给这台设备起个名字，方便你在「已授权设备」里识别和单独吊销。」；只在 `LOGIN_CAPABLE_STATES`（登录确实可达的状态）显示；
- `src/auth/gate.ts`：`#sendLoginPage` 传入 `requirePairing()`——配对开关关闭时不出现该提示，不承诺做不到的事；
- `src/client.ts`：「扫码访问」tab 两处说明补上"首次访问还要给这台设备命名一次，之后才不用再问"。

### 验证

- `pnpm run typecheck` ✓；`pnpm run test:unit` **247 项全绿**（0.3.2 为 241 项，+6）；
- 两组新测试都做过**反证**：把修复回退（`link-inactive` 放回 `blocked`、关掉命名提示）→ 对应用例立刻失败，不是空测试；
- `pnpm run build` ✓；新文案已进 `lib/index.js` / `lib/client.js`，旧的误导文案 grep 计数为 0；
- 本版改动只在插件自己的页面、文案与门禁表单可用性，**未触碰任何宿主/客户端接口**；真实 DSH 上的装机验证在发布后进行。

## [0.3.2] — 2026-09-26（装完即用 + 设置页 Liquid Glass）

### 变更（安全默认值）— `listenHost` 默认改为 `0.0.0.0`，并可在设置页切换

**用户决策（2026-09-25）**：插件装完只会重启一次 dsh，若默认还是 `127.0.0.1`，用户必须改配置再重启一次才能用——体验不可接受。因此默认改为**面向局域网**。

这不是"关掉安全"的开关，默认值仍然成对成立：

- `auth.enabled` 默认 **true**；**未设访问密码时门禁拒绝所有非回环设备**（登录页可见，但不放行、不泄露数据）；
- `tls.mode` 默认 **self-signed**（不存在明文传输）；`tls.allowInsecureLan` 仍默认 false，非回环 + 关 TLS 依旧**拒绝启动**。

改动：

- `src/config.ts`：`DEFAULT_LISTEN_HOST` → `'0.0.0.0'`；`listenHost` 升为 **volatile** 字段，`LiveSwitches` 新增 `listenHost()`（`unwrapVolatileInput` / `liveSwitches` / `staticSwitches` 同步）；
- `src/store/preferences.ts`：`listenHost` 进入偏好白名单与 `toSettingsPatch`；新增 `LISTEN_HOSTS` **闭集** `['0.0.0.0','127.0.0.1']`——端点不接受任意地址字符串，具体网卡 IP 仍属 profile patch 的高级配置；
- `src/settings/routes.ts`：快照的 `preferences` 带上 `listenHost`；**新增拒绝规则**——`auth.enabled: false` 时拒绝写入非回环地址（该组合在启动时本就被 `parseConfig` 拒绝，写进去只会让下次重启起不来；宁可拒绝保存，也不要启动失败）；
- `src/client.ts`：「连接与证书」新增 **「局域网（默认） / 仅本机」** 两选一开关（标注"修改后需重启 dsh 生效"），当前值为自定义网卡 IP 时给出说明；「扫码访问」tab 在**对外可达且尚未设密码**时给出明确警示（端口可见 / 门禁拒绝所有设备 / 请先设密码）；
- **测试套件全部显式绑 `127.0.0.1`**：默认值变了之后，测试必须自己声明回环，绝不允许测试进程打开对外监听。改动前那批用例会因「非回环 + 关 TLS」被 `parseConfig` 直接拒绝而失败——失败是安全的，没有真的绑上 `0.0.0.0`；
- 测试：`pnpm test` **241 项**全绿。

### 新增 — 设置页 Liquid Glass（液体玻璃）材质（2026-09-26 用户要求）

设置页「局域网访问」分区整体改为液体玻璃质感：毛玻璃（`backdrop-filter`）+ 跟随主题的折射光晕 + 镜面渐变描边 + 分层投影。

- **全部材质由官方令牌经 `color-mix` 派生**，因此浅色/深色自动适配，**不依赖任何内部属性、不发明任何 token 名**（避免 2026-09-24 的对比度事故重演）；
- 每个表面**先声明纯色令牌回退**，再声明玻璃层：`color-mix` 或 `backdrop-filter` 不受支持时，后一条在解析期被丢弃，卡片退回为完全可读的令牌表面；
- 镜面边缘用 mask 只保留 1px 边框环（`.lg-card::after` / `.lg-choice::after`），光晕是插件自己子树内的装饰层（`inset:0`，**不会给官方设置弹窗引入溢出**）；
- **二维码底板刻意保持不透明**：半透明底板会降低对比度、可能导致扫不出来（已在 CSS 里写明禁止玻璃化）；
- 实测（真实 DSH，浏览器读 `getComputedStyle`）：深色 `--lg-tint=color-mix(in srgb,#232324 62%,transparent)`、浅色 `#fff 62%`；`backdropFilter=blur(20px) saturate(1.8)`；镜面描边的渐变与 mask 均生效；`.lg-qr` 背景为 `rgb(255,255,255)`；深浅色各截图确认。

### 修复 — 设置页尺寸偏大、提示条按钮折行（2026-09-26 用户反馈）

**症状**：液体玻璃版落地后，设置页「字体、按钮都偏大」；且「端口已对局域网开放…」这一行右侧的「去设置访问密码」按钮**折成两行**（`去设置访` / `问密码`）。

**根因（实测对比官方设置页）**：插件自定的控件尺度比 DSH 官方设置页大一档——官方实测 **控件 36px 高 / 14px-22px / 字重 400 / 圆角 12px（`--dsw-radius-md`）**，而插件是 **44px 高 / 到处 500 字重 / 10px 圆角 / 卡片标题 16px**。按钮折行则是 `.lg-bar` 里 `justify-content:space-between` + 按钮没有 `flex:0 0 auto` / `white-space:nowrap`，长文本把按钮挤窄后文字在按钮内部换行。

**改动**（全部照官方实测值对齐，不发明新尺度）：

- 控件高度 44px → **36px**；内边距 `0 16px` → `0 14px`；圆角 10px → **`var(--dsw-radius-md,12px)`**；按钮字重 500 → **400**（官方按钮/下拉均为 400）；
- 卡片标题 16px/24px → **14px/22px**（官方 section 标签就是 14px/22px，与 `.lg-label` 统一）；字段标签 13px → **14px/22px**；卡片内边距 20px → **16px 18px**；选择卡/设备行/升级面板圆角统一到 12px；
- **提示条按钮**：`.lg-bar .lg-btn` 固定 `height:32px`（官方词汇里的紧凑尺寸）、`padding:0 12px`、13px/400、`flex:0 0 auto` + `white-space:nowrap`；文本改为 `flex:1 1 16ch;min-width:0`，因此**文本在自身内部换行、按钮永远保持整行**；`.lg-bar` 加 `flex-wrap:wrap` 作降级（容器极窄时按钮整体换行而不是被压窄）；
- **触屏仍保留 44px 最小高度**：既有 `@media (hover:none) and (pointer:coarse)` 规则未动，手机上的点击目标不会变小。

**实测**（真实 DSH，`getComputedStyle` + 截图）：

| 项 | 官方设置页 | 插件（改后） |
| --- | --- | --- |
| 控件高度 | 36px | **36px** |
| 控件字号/字重 | 14px / 400 | **14px / 400** |
| 圆角 | 12px | **12px** |
| 卡片标题 | （section 标签 14px/400） | **14px/500** |
| 提示条按钮 | — | 32px / 13px / 400，`scrollWidth === clientWidth`（**不折行**） |

窗口 1100px 与 820px（弹窗内容区 536px）两档均验证按钮不折行、文字在自身内部换行。

> 顺带记录一个**不是本插件的问题**：DSH 官方设置弹窗在 390px 视口下自身就会崩（导航列不折叠、内容被挤到约 63px 逐字竖排）。手机用户用的是代理出去的官方界面，不会打开这个弹窗。

### 改进 — 可复制字段改为单行横向滚动（2026-09-26 用户要求）

**症状**：访问地址在卡片里**硬折行成两行**，占掉垂直空间，能展示的内容变少。

**改动**：新增 `.lg-mono-scroll`，应用于**所有"可复制字段"**——访问地址（扫码访问 tab）与升级命令（更新面板）：

- `white-space:nowrap` + `overflow-x:auto` + `word-break:normal`（覆盖 `.lg-mono` 的 `break-all`，规则位置放在其后以确保生效）；
- 6px 细滚动条（WebKit 伪元素 + `scrollbar-width:thin`），光标为 `cursor:text`，框内拖动即选中并自动横向滚动；
- 加 `title` 属性，悬停可见完整值；
- **复制仍然复制全文**：`copy()` 写入的是源字符串 `scanUrl`（即 DOM 里的完整值），与滚动位置、是否被裁剪无关；实测 DOM 文本长度 69，与端点返回的 `tokenUrl` 完全一致。

**实测**（真实 DSH，`getComputedStyle`）：`white-space:nowrap`、`overflow-x:auto`、`word-break:normal`、`scrollWidth 564 > clientWidth 519`（确实可滚动）；框高从两行的约 62px 降到**单行 42px**。

> 说明：macOS 的覆盖式滚动条默认只在滚动时出现；框内拖动会选中并自动横向滚动，另有 `title` 悬停提示，因此不额外加渐隐遮罩（渐隐在滚到末尾时反而像被截断）。

### 文档 — 刷新 5 张 README 截图（2026-09-26）

`assets/` 下的设置页截图按**当前代码**（液体玻璃 + 官方尺度）重拍，替换此前仍是平面样式的旧图；`screenshots.json` 声明的 5 张路径不变。

- 截图取自**零配置**的临时 DSH 实例（`dataDir`/`listenHost` 均未配置；仅固定了 `listenPort` 以免把"3081 被占用"的测试环境告警拍进去）；
- 图中免密链接的 token 是**占位值**（`dsh_0000…`），仓库内不含任何真实凭据；
- `mobile.png` 重拍后与旧图逐字节相同（官方 UI 在 390px 下未变），因此本次未产生变更。

### 修复 — 安装后设置页显示 `settings request failed: 404`，插件根本没启动

**症状**：`dsh plugin --profile web add dsh-lan-guard@0.3.1` 装好并重启 dsh 后，**设置 → 局域网访问** 只显示 `settings request failed: 404`。

**根因（实机复现，非推断）**：包内 `cordis.patch.yml` 的 insert 行**不带 config**，而 `parseConfig` 当时要求 `dataDir` 必填 → `apply` 抛 `LanGuardConfigError` → 宿主半边未加载 → `/plugins/dsh-lan-guard/*` 路由**一条都没注册**。客户端半边由 `dsh.client.inject` 独立收集，所以设置分区照常渲染，只是把裸 404 显示出来。

实测证据：

- `dsh --profile web --dump-config` 里该行只有 `id`/`name`；`~/.dsh/profiles/web/cordis.patch.yml` 里也没有本插件的行；
- 运行中的 DSH 上 `/plugins/dsh-lan-guard/config` 与 `/auth-status` → **404**；而**已注册**的路由对未认证 curl 返回 **401**（`/`、`/api/remote.mux`）⇒ 404 是"路由不存在"，不是门禁拒绝；
- 直调装好的插件：`startLanGuard(host, {})` → `LanGuardConfigError: dataDir is not set`；给定 `dataDir` 后回环 + 自签 TLS 均正常启动。

### 变更 — `dataDir` 不再必填，缺省按 profile 推导（2026-09-25 用户授权修改）

用户要求「安装上就可以使用，不需要手动写配置，如果需要可以再去改」——借鉴的 dsh-mobile / dsh-bridge 都能做到。解析优先级：

1. **条目 config 里的显式 `dataDir`**（支持 `~` 前缀）；
2. **`<profileDir>/data/dsh-lan-guard`**——来自 DSH 自己的 `profileContext` 服务（`dsh` 启动的任何 profile 都有；CLI 与桌面端共用 `runProfile`）。与同机 `dsh-notify` / `dsh-session-colors` 落点一致，**按 profile 隔离**；
3. 两者皆无 → 仍**拒绝启动**并给出可操作提示（不再"猜"一个跨 profile 共用的目录）。

实现：

- `src/config.ts`：新增 `resolveDataDir()` / `expandTilde()` / `DATA_DIR_NAME`；`parseConfig(input, profileDir?)` 接受 profile 目录；
- `src/index.ts`：`LanGuardHost` 新增 `profileDir`；`apply` 用**可选** `ctx.get('profileContext')` 取 `dir`（拿不到时退回"必须显式配置"，插件照旧能加载，不因缺服务而整体失败）；启动日志打印实际路径与来源；
- **修掉 `~` 不展开**：此前 `dataDir: ~/x` 会在进程 CWD 下建一个**字面量 `~` 目录**（实测），而 README 的示例正是 `~/.dsh/...`。现在自己实现三行展开，不新增运行时依赖；
- 顺带修掉 `src/config.ts` / `src/index.ts` 里两处与函数脱节的孤儿 JSDoc。

测试：**+6 项**（推导优先级、显式覆盖、空白与 `null` 视为未配置、`~` 展开、无任何来源仍拒绝启动、零配置也能起来并把数据落在 `<profile>/data/dsh-lan-guard`）；`pnpm test` **234 项全绿**。

### 文档与仓库整理

- **`README.md` / `README.zh.md` 重写**：改用与 `dsh-notify` 一致的版式——居中标题、徽章行、语言切换、锚点导航、功能清单、设置表、兼容性表、安全边界、排障、开发与发版；新增 **5 张真实截图**（`assets/`），并新增 `screenshots.json` 供插件市场详情页使用；
- 截图取自**零配置**的临时 DSH 实例（`dataDir` 与 `listenHost` 均未配置，profile patch 为空数组）；图中免密链接的 token 是**占位值**（`dsh_0000…`），仓库内不含任何真实凭据；
- README 明确标注「仓库包含尚未发布的改动」，避免 npm 上 `0.3.1` 的使用者被新默认值误导；
- **按用户要求删除 `docs/`（设计文档）与 `AGENTS.md`（AI 协作总纲）**：`SPEC.md` / `PLAN.md` / `RESEARCH.md` / `GUARDRAILS.md` / `RELEASE.md` 与总纲文件已移除；`src/`、`tests/`、`cordis.patch.yml`、README，以及 CHANGELOG 历史条目与 `release-notes/` 里对它们的引用一并清理（`src`/`tests` 只涉及注释、一处测试名与一处错误文案，**无行为改动**）；
- `cordis.patch.yml` 的注释同步修正：此前写着「`dataDir` 无安全默认、新装即 inert」，在本次改动后已不成立。

## [0.3.1] — 2026-09-25

### 适配 — DSH `0.1.7-rc.2` 验证版（代码零改动）

用户把 DSH 升级到 `0.1.7-rc.2`，按既有复核清单逐项核对后确认**本插件无需源码改动**：

- 依赖的宿主/客户端接口全部存在且未变：`webServer.register` / `indexTaps`、`connection.requestRejection`、`connection.authenticatedUrl`、追加型 `settings.section` 与 `shell.overlay` seat、`@deepseek-ai/schemastery@3.18.4`；
- 在 `0.1.7-rc.2` 上端到端跑通（设置页、扫码访问、门禁、代理）；
- `dsh.compatibility.dshReleases` 增加 `0.1.7-rc.2: compatible`（保留 `0.1.7-rc.1`）；`dsh.engines.dsh` 保持 `>=0.1.7-rc.1 <0.2.0`（按 semver 预发布规则本就接纳 rc.2，放宽只会接纳未测试版本）；
- **README 中英双语兼容表重写**：补上 `0.1.0 → 0.3.1` 的完整版本对应历史，并把「当前已验证的最新 DSH 版本」更新为 `0.1.7-rc.2`；

`pnpm test` 228 项全绿。

## [0.3.0] — 2026-09-25

### 修复 — 设备操作按钮折行

「吊销并拉黑」等小号按钮在设备行里被挤窄后**折成两行**（用户截图实测）。原因：小号按钮缺 `white-space:nowrap` 与 `flex-shrink:0`，设备行的文本列也没有 `min-width:0` 让位。修复后浏览器实测按钮高度 **28px（单行）**、宽度 82px、文案完整。

### 新增 — 设备批准与永久拉黑（SPEC F9，方案 A，进行中）

第一步：**数据模型与设计文档**（本轮完成）

- `DeviceRecord` 新增 `status`（`pending` / `approved` / `blocked`）与 `decidedAtMs`；
- **加载时迁移**：F9 之前写入的记录没有 `status`，加载即视为 `approved`，不打断既有设备；
- 注册表新增三态 API：`add(label, { pending })`、`setStatus(id, status)`、`lookup(token)`（不论状态都能查到，供门禁渲染等待页）、`pendingCount`；
- `verify()` 收紧为**只认 `approved`**：`pending` 不放行（门禁给等待页）、`blocked` 永不放行且记录保留（这正是「永久拉黑」的实现方式，不依赖设备指纹）；
- 测试新增 4 项（待批准不放行但可查、批准后放行、拉黑后拒绝且记录保留、解除拉黑是唯一出路、旧记录迁移为已批准、空操作不写盘）；`pnpm test` **223 项**全绿。

待续：`auth.requireApproval` 开关、门禁等待页与 `blocked` 拒绝、批准/拉黑/解除端点、设置页三组列表与两个开关、手机侧等待批准页。

### 新增 — 设备批准与永久拉黑（SPEC F9，方案 A）

「吊销」只能让设备的身份 cookie 失效；F9 让**拉黑变得永久**——不依赖设备指纹，而是把放行权交给管理员。

- **三态数据模型**：`pending` / `approved` / `blocked`；F9 之前写入的记录加载时迁移为 `approved`（不打断既有设备）；
- **开关**：`auth.requireApproval`（默认 **false**＝保持现状）；开启后新设备命名完进入「待批准」；
- **门禁**：`pending` → 手机侧「等待管理员批准」页（`/api/*` 返回 `403 pending_approval`）；`blocked` → `403`「已被移除访问权限」，**重新配对仍被拒**（唯一出路是管理员「解除拉黑」）；
- **端点**：`POST /plugins/dsh-lan-guard/devices` 新增 `action: approve | block | unblock`（沿用管理面鉴权、CSRF 与远程只读规则）；
- **设置页**：「已授权设备」tab 新增第二个开关「新设备需要管理员批准」+ 三组列表（**待批准**：批准 / 拒绝并拉黑；**已授权**：吊销并拉黑；**已拉黑**：解除拉黑）+ 待批准提醒条；
- 测试新增 4 项（待批准显示等待页且 API 返回 `pending_approval`、批准后放行、拉黑后拒绝、端点 approve/block/unblock、快照 `pendingCount`）；`pnpm test` **229 项**全绿。

## [0.2.0] — 2026-09-25

### 新增 — 升级检测（SPEC F8，方案 A）

- **只读检测**：宿主查询 `https://registry.npmjs.org/dsh-lan-guard/latest`，与运行版本比较；成功/失败都缓存 **6 小时**，「检查更新」按钮可强制刷新（`?force=1`）。
- **新端点**：`GET /plugins/dsh-lan-guard/update[?force=1]`（管理面、只读、遵守原生栅栏）。
- **版本比较自实现**：支持 `x.y.z` 与预发布后缀（遵循 semver 优先级），**不引入 `semver` 依赖**。
- **失败即报告**：离线/注册表不可用 → `error: 'registry_unavailable'`，只提示、不抛错，不影响门禁与代理。
- **设置页 UI**：分区内芯片（绿「vX ✓ 最新」/ 蓝「vX ➔ vY」/ 灰「检查失败」）+「检查更新」+ 静态链接（GitHub / 更新日志 / 反馈 Issue）；有新版时展开面板给出**可复制的升级命令**并提示「需你手动重启 dsh 才生效」。
- **明确不做**：不自动安装、不自动重启、不接 GitHub API（更新亮点改为指向仓库 CHANGELOG 的静态链接）——宿主只报告，操作权留在人手里。
- 测试：新增 `tests/update-check.test.ts`（9 项：版本解析/比较/预发布优先级、缓存与 force、注册表失败与网络异常均不抛错）；`pnpm test` **219 项**全绿。

### 移除 — 右下角「局域网访问已开启」状态胶囊（P4-f）

用户反馈后移除。原因：该胶囊（官方追加型 seat `shell.overlay`）把**免密链接（含 `dsh_` token）常驻在屏幕右下角**——截屏或共享屏幕时会一并被拍到；且 `sessionStorage` 的「不再显示」只在当前标签页会话有效，**每次新会话都会再次出现**。

- 客户端不再注册任何 `shell.overlay` 内容（`StatusOverlay`、seat 常量与相关 CSS 一并删除）；
- 局域网状态改由设置页「扫码访问」tab 呈现（状态胶囊「运行中」+ 地址 + 唯一二维码）；
- SPEC F6 与 PLAN 的 P4-f 条目已标注为「移除」，不是「未实现」。

## [0.1.1] — 2026-09-25

### 文档

- **README 重写为中英双语用户文档**（README.md / README.zh.md，各 147 行，结构与 dsh-update-status 对齐）：徽章 + 语言互链 + 锚点导航 + 「能力 / 安装 / 使用 / 兼容性（含版本对应表）/ 配置（完整键表）/ 排障 / 安全边界 / 卸载 / 开发」；原先的「计划提供的能力」等实施前规划稿措辞已全部替换为已发布状态的描述。

## [0.1.0] — 2026-09-24

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与[语义化版本](https://semver.org/lang/zh-CN/)。

### 实现 — P2 门禁 + 设置 UI（2026-09-24）

- **门禁核心** `src/auth/manager.ts`：PBKDF2-SHA256（迭代 600000、派生 32 字节、存储格式 `pbkdf2-sha256$<iterations>$<hex>`、兼容旧裸 hex 按 10000 次）、全部比较走 `timingSafeEqual`、双密码（访问 + 独立管理）、`dsh_`+36 hex 免密令牌、普通会话落盘 / 管理员会话仅内存、按 IP 失败计数与锁定、统一 `verifyRequest`、`adminPolicy` / `allowLoopback` 判定、CSRF 校验。
- **敏感数据落盘** `src/store/secrets.ts`：`<dataDir>/secrets.json`（哈希/盐/令牌）与 `sessions.json`（普通会话），原子写 + 权限 **600**；损坏的 secrets.json **拒绝启动**而不是当作空密码（避免「任意密码都能进」）。
- **登录页** `src/auth/login-page.ts` + **访客门** `src/auth/gate.ts`：HTML 导航 → 登录页、`/api/*` 与静态资源 → 401 JSON、登录 POST（CSRF + 限流）、`?auth=<token>` → 302 到去掉 token 的干净 URL、门禁自有路径不转发上游；三态提示（密码错误 / 已锁定含剩余秒数 / **尚未设置密码**）。新增状态 `token-only`。
- **设置 UI**（路线乙）：非敏感开关 `enabled` / `auth.mode` / `auth.adminPolicy` / `auth.adminProtection` / `auth.allowLoopback` 声明为 `Config` 的 **volatile** 字段；`src/settings/routes.ts` 提供 `/plugins/dsh-lan-guard/config`（GET/POST）与 `/auth-status`，**先用 `connection.requestRejection`** 复用 DSH 原生栅栏；非敏感开关经宿主 `ctx.settings.update()` 写入（**单一数据源**，落 profile patch）；`src/client.ts` 注册官方 `settings.section`（`id: dsh-lan-guard`、`order: 100`、`label: 局域网访问`），纯 `React.createElement` + 内联 CSS + `--dsw-alias-*` 变量 + 两个响应式断点。
- **相位门禁**：非 loopback 的 `listenHost` 在 P3 之前仍直接拒绝启动。
- **测试 142 项**（新增 `tests/auth.test.ts` 25 项、`tests/gate.test.ts` 21 项、`tests/settings-routes.test.ts` 22 项，另扩充 config/plugin）。

### 实现 — P3 局域网 + 自签 TLS + 二维码（2026-09-24）

- **`src/network.ts`**：枚举非内部 IPv4 网卡，虚拟网卡（Docker/VMware/VPN/Tailscale/Apple P2P）与不可路由网段**识别并降权**而非隐藏；显式配置的网卡不存在时**返回空而不是回退**到别的地址。
- **`src/tls/ca.ts`**：自签 CA（`commonName: DSH LAN Guard CA`——**用户决策**；EC P-256 / sha256 / 5 年 / `basicConstraints cA:true critical` / `keyUsage keyCertSign`）；`assertMatchingCa()` 校验自签、CA 位与公私钥 SPKI 匹配；私钥 600、证书 644；**CA 身份跨重启保留**。
- **`src/tls/leaf.ts`**：按当前网卡 IP 签发叶证书（SAN 覆盖全部当前地址 + 回环），CA 不变时**只重签叶证书**；到期前 7 天自动续期。
- **`src/qrcode.ts`**：服务端出 **SVG**（`qrcode`，无 base64 膨胀），组装访问地址集 + 普通链接二维码 + 免密链接二维码（`?auth=`）；**每次请求重建**，因此网卡/端口/TLS/令牌变化即自动刷新；仅回环绑定时**不产出二维码**并说明原因。
- **`src/proxy.ts`**：支持 HTTPS 监听（`node:https`，证书由 `tls.mode` 决定）。
- **`src/index.ts`**：放开非回环监听；`tls.mode: 'self-signed'`（默认）自动准备 CA+叶证书；**非回环 + `tls.mode: 'off'` 直接拒绝启动**（明文会泄露门禁密码与上游 cookie，局域网 HTTP 属 P4-e，需显式风险确认）。
- **设置页**：状态卡片加入访问地址、`复制链接` / `显示·隐藏二维码`、二维码（默认展开）、免密链接与其二维码（仅管理员解锁时返回）+ 重新生成、`请在私密环境下使用`、PWA 引导；连接与证书卡片加入 TLS 关闭影响提示与 CA 指纹。
- **密码策略**：按**用户决策**实施最短 8 位（`MIN_PASSWORD_LENGTH`），前端提示 + 端点校验。
- **测试 170 项**（新增 `tests/network.test.ts` 9 项、`tests/tls.test.ts` 9 项、`tests/qrcode.test.ts` 7 项，另扩充 settings-routes 与 plugin）。
- **阶段验收**：经用户批准，P1/P2/P3 的「必须验证」勾选框已勾选，并在每节标注**验证方式**与**仍未验证的部分**（浏览器视觉呈现留给手机实测）。

### 实现 — P4-a 网卡选择交互（2026-09-24，用户选定范围内）

- `networkInterface` 升为 `Config` 的 **volatile** 字段（非敏感开关，符合 SPEC F6；也是经宿主 `settings.update()` 写入的前提），并在 `LiveSwitches` 中暴露；`access` 信息每次请求读取**实时值**，因此选择变化**无需重启**即刷新地址与二维码。
- `src/store/preferences.ts`：`networkInterface` 纳入偏好白名单与校验（空串 = 自动；只接受网卡名或地址字面量，非法值拒绝；未知键仍丢弃）。
- `src/client.ts`：连接与证书卡片加入**网卡下拉**（列出全部候选地址，标注虚拟网卡及原因），写入走同一 `/config` 端点。
- 新增/扩充测试 4 项（config 的 volatile 与校验、偏好清洗、设置端点写入、未知键丢弃）；合计 **174 项**。
- 真实验收（临时 DSH 实例）：默认自动 → `https://10.0.0.20:3471/` + 二维码；选不存在的 `en9` → **即时**变为无地址、无二维码并给出原因；切回自动 → 地址与二维码恢复；选择落进 profile patch。测试期间曾短暂绑定 `0.0.0.0:3471`（门禁与自签 TLS 生效），验收后立即关闭。

### 变更 — 安装进用户真实 profile（2026-09-24，用户当次明确授权）

按用户当次明确授权把插件装入用户真实的 `web` profile，**未重启 dsh**：

- 备份：`~/.dsh/profiles/web/cordis.patch.yml.bak-lan-guard-20260924-195531`（原文件 3305 字节，权限 600 保留）；
- 软链：`~/.dsh/profiles/web/node_modules/dsh-lan-guard` → 本仓库（与该机既有约定一致，如 `dsh-free-search`、`dsh-mobile`）；
- 追加条目：`- id: dsh-lan-guard` + `name: dsh-lan-guard`，config 为 `listenHost: 0.0.0.0`、`listenPort: 3445`、`upstreamOrigin: http://127.0.0.1:3080`、`dataDir: ~/.dsh/profiles/web/data/dsh-lan-guard`（沿用该机既有约定）、`tls.mode: self-signed`、`auth.allowLoopback: true`；
- 重启前预检：patch YAML 解析通过（顶层 11 条）、模块可从 profile 目录解析、导出面与 `dsh` 元数据正确、`Config(row.config)` 解析出预期值、客户端 bundle 存在。

**修正一处不一致**：`auth.enabled`（门禁总开关）此前被标为 `.volatile()`，即可在设置页写入，但 `AuthManager` 读的是启动时的静态值——**可写却不生效**。按既定的 volatile 清单，`auth.enabled` 已改回非 volatile（门禁总开关属启动期安全字段，见默认值原则 3）。可写开关现在恰好是：`enabled`、`networkInterface`、`auth.mode`、`auth.adminPolicy`、`auth.adminProtection`、`auth.allowLoopback`。

### 修复 — 手机访问导致 dsh 崩溃（2026-09-24，用户实测「手机一访问 DS 就崩溃」）

**根因（已用日志与复现双重确认）**：`writeJson` 使用**固定临时文件名** `${path}.tmp`。手机加载页面会**并发**发出几十个请求，而门禁在**每个**设备请求上都调用 `touch()` 重写 `devices.json` → 多个写并发写同一临时文件 → 一个 `rename` 成功、其余 `rename` 报 **ENOENT** → 该 rejection 逃出请求路径成为 **unhandled rejection** → Node 24 终止进程。

日志原话：`dsh: fatal load failure: Error: ENOENT: no such file or directory, rename '.../devices.json.tmp' -> '.../devices.json'`

**复现与验证**：
- 旧构建 + 40 个并发请求（非回环来源）→ 全部 `000`（无响应）+ 日志出现上述 fatal → **稳定复现崩溃**；
- 新构建 + 60 个并发请求 → **全部 200**、进程存活、日志**零** `fatal/ENOENT/unhandled`。

**四层修复**：
1. `writeJson` 改用**唯一临时名**（`${path}.${pid}.${random}.tmp`）；
2. 同一路径的写入**串行化**（每路径一个 promise 队列，前一个失败也继续下一个）；
3. `DeviceRegistry.touch` **节流**（同一设备同一地址 5 分钟内不重复写盘）——从根上消除「每请求一次写盘」；
4. **兜底捕获**：设备 touch 失败只记日志、绝不影响请求；`proxy.ts` 里 `gate.handleHttp` 外层加 catch，任何门禁异常都回 `500` 而**不再让 rejection 逃逸**（一次坏请求绝不能带走 dsh）。

**测试**：新增并发回归（30×`touch` + 30×`saveDevices` + 30×`saveSessions` 并发不得失败）与节流行为用例；`pnpm test` **210 项**全绿。

**教训（我先前判断错误）**：我曾用**顺序** curl 复现该路径并判定为「手机网络层问题」——顺序请求不会触发竞态，所以结论是错的。已改为按「用户描述的现象（崩溃）」去找崩溃源，而不是先相信自己的复现结论。

### 变更 — 移除重复的「创建设备」入口（2026-09-24，用户反馈）

用户指出：*「我们已经有扫码输入设备的页面，不需要再创建了。创建这个按钮和输入框没有意义。」*

配对页（手机侧自己命名）已经承担了设备创建的职责，控制台里的手动创建表单是旧模型（v1：管理员预建设备）的遗留，属于重复入口。已删除：

- 客户端：「已授权设备」tab 里的**名称输入框 + 「添加设备」按钮**，以及只为它存在的一次性链接与二维码展示（含 `addDevice()` 与相关状态）；
- 服务端：`POST /devices` 的 `action: "add"` 分支，以及**仅被该流程使用**的 `GET /plugins/dsh-lan-guard/qr?text=<url>` 端点（端点总数 5 → 4）；
- 原位置改为 **「新设备需要命名确认」开关**（`requirePairing`），并在说明里写明「设备由手机首次配对时自己命名」；
- 测试同步调整（设备列表/吊销用例改由注册表直接造数据；路由清单去掉 `/qr`）。`pnpm test` **208 项**全绿。

### 新增 — P4-d mDNS 发现（2026-09-24，用户批准引入依赖）

- 引入 **`bonjour-service@1.4.4`（MIT）** 作为运行时依赖（经用户批准，AGENTS §4 灰名单）；
- 新增 `src/mdns.ts`：把运行中的监听器描述成 mDNS 记录（`_dsh-lan-guard._tcp` + TXT `scheme`/`host`/`url`）并广播；**publisher 可注入**，因此生命周期在无多播的测试环境里也能验证；
- 新增配置 `mdns.enabled`（默认 **false**）：广播是新的可发现面，与本项目「默认关闭、显式打开」一致；
- **广播失败绝不影响代理**（contained，仅告警）；插件关闭时 `unpublishAll` + `destroy`；
- **诚实限制**（写入 README 与 SPEC F5b）：iOS Safari / Android Chrome 实践中不为任意网页解析 `.local`，mDNS 主要方便发现工具与桌面浏览器，**手机上的可靠路径仍是二维码**；
- 测试新增 4 项（记录构造 ×2、发布/释放生命周期、发布失败不抛）。`pnpm test` **208 项**全绿；build / verify 通过。

### 新增 — P4-e 局域网 HTTP 的显式确认开关（2026-09-24，用户批准）

SPEC §6.2 要求「非回环 + 无 TLS 必须显式确认」，此前只是**一律拒绝**。现补上确认路径：

- 新增 `tls.allowInsecureLan`（默认 **false**）；未开启时，非回环 `listenHost` + `tls.mode: 'off'` 在**配置校验阶段直接拒绝启动**，错误信息给出三条可操作出路（开 TLS / 绑回环 / 显式接受风险）；
- 开启后允许启动，并在启动日志打印**明文警告**（门禁密码不加密）；设置页的 TLS 卡片已有关闭 HTTPS 的影响提示；
- 测试：新增 3 项（未确认时拒绝、确认后允许、回环无需确认）。`pnpm test` **204 项**全绿。

**P4-d（mDNS 发现）仍待实施**：需引入 `bonjour-service`（MIT）作为新的运行时依赖，按已批准方案排在其后。

### 变更 — P4-g 改为 dsh-mobile 式设备身份模型（2026-09-24，用户实测反馈）

用户实测反馈三点，其中两点是真缺陷、一点是模型不对：

1. **「改成需要密码，手机却不用输」**：门禁顺序是「被锁定？→ 有有效会话？→ 放行 → 否则要密码」，手机里留着之前下发的 **30 天会话 cookie**，所以不必再输——而**改密码/切模式时我没有吊销旧会话**。已修：**设置/更换访问密码、或切换验证模式时立即吊销所有访客会话**（管理员会话一并清掉）。
2. **「看不到已授权设备」**：因为当时一台设备都没配对过（`devices.json` 不存在）。原 P4-g 是「管理员先预建设备」，与用户预期不符。
3. **按 dsh-mobile 模型重做**：设备**第一次进来时自己命名**——
   - 远程访客通过门禁但没有设备身份 → **配对页**「确认这台设备」（名称按 User-Agent 预填 + 显示来源地址）；`/api/*` 返回 `428 pairing_required`；
   - 确认后服务端生成设备令牌并下发 **HttpOnly 设备 cookie**（`dsh_lan_guard_device`，一年），同时记录名称 / 创建时间 / 来源 IP；
   - 之后每个请求都校验设备 cookie：**记录被吊销或未知 → `403`「此设备已被移除访问权限」**（即「删除后它就进不来」）；有效则更新「最近使用」；
   - **本机操作者（回环直连）永远不参与配对**；
   - 新增 volatile 开关 `auth.requirePairing`（默认 **true**），设置页「已授权设备」tab 可关；
   - 设备列表新增「删除记录」（删除后该设备可重新配对），与「吊销」（保持拒绝）区分。
4. **诚实的边界**：密码是共享的，吊销只保证**那台设备的身份 cookie 立即失效**；换浏览器用密码重新登录仍可再次配对。要做到「同一台机器永久拉黑」需要设备指纹或每设备独立令牌，属更重方案。

`pnpm test` **201 项**全绿（新增配对页、设备 cookie 识别、吊销拒绝、`428` API 提示等用例）；build / verify 通过。SPEC F3/F6、PLAN 已同步。

### 新增 — P4-g 完整设备配对（2026-09-24）

总免密令牌是「全有或全无」——吊销它等于把所有手机一起踢下线。设备配对给每台手机一条**可单独吊销**的凭据：

- **`src/store/devices.ts`**（新）：`DeviceRegistry`——创建（`dsh_dev_` + 36 hex）、校验（**恒定时间**）、吊销、记录最近使用与来源 IP；**只持久化 SHA-256 哈希**，明文令牌只在创建时返回一次；`devices.json` 权限 600。
- **门禁**：`?auth=<设备令牌>` 与总令牌共用同一入口，命中即下发会话并 302 到干净 URL；**已吊销的设备一律拒绝**。
- **管理端点**：`GET/POST /plugins/dsh-lan-guard/devices`（列表 / `action: add` / `action: revoke`）+ `GET /plugins/dsh-lan-guard/qr?text=<url>`（为设备链接渲染二维码）；均复用原生栅栏与 CSRF，且遵守 `local_only` 的远程只读。列表**绝不返回令牌或哈希**。
- **设置页**：新增第 4 个 tab **「已授权设备」**——设备列表（名称 / 创建 / 最近使用 / 来源 IP）、添加设备（新链接**只显示一次**，带二维码与复制）、逐个吊销。
- **测试**：新增 `tests/devices.test.ts`（6 项：令牌格式与校验、**明文不落盘**、吊销即失效、跨重启持久化、记录最近使用、空名称兜底）+ 门禁端到端（设备链接 302 且吊销后 401）+ 端点（列表/新增/吊销、远程只读拒绝、非法 action 400）。`pnpm test` **198 项**全绿。

**说明**：P4-d（mDNS，需引入新运行时依赖）与 P4-e（局域网 HTTP，需显式接受明文风险并改 SPEC §6.2）仍未实施。

### 变更 — P4 续做：品牌蓝、端口可配 + 自动顺延、状态浮层（2026-09-24）

用户指示：「换成参考图的品牌蓝，继续完善 P4」，并要求端口可配、被占用时给提示。

**1. 主按钮改品牌蓝**（用户拍板，取代原先主题相关的近白主按钮）
- 主按钮底色 `--dsw-static-deepseek-500`（#4176e6）+ 官方白字 token `--dsw-static-neutral-bluish-00`（#fff）；开关选中态与「大卡片选择器」选中边框同用品牌蓝。**仍是官方变量，无硬编码颜色**。
- 实测（browser-skill）：主按钮 `rgb(65,118,230)` / 白字、开关选中态同色。

**2. 端口可配置 + 被占用提示 + 自动顺延**（用户明确要求）
- **默认端口 3445 → 3081**（DSH 的 3080 + 1，符合「3081/3082/3083 依次往后数」的直觉）；仍避开 3443/3444（dsh-mobile）。
- **被占用自动顺延**：从配置端口起最多再试 10 个连续端口，取第一个可用的。**真正的绑定动作本身就是探测**——不额外开探测 socket，因此没有竞态、也不会出现「无门禁的探测监听」。
- **`listenPort` 升为 volatile**（可经设置页写入），`连接与证书` tab 新增端口数字输入 + `保存端口` + 可用性检查；发生顺延时设置页与日志都会说明「配置的端口 X 已被占用，已自动改用 Y」。
- 新端点 `GET /plugins/dsh-lan-guard/port-check?port=N`（受原生栅栏保护）：探测**只绑 127.0.0.1**，绝不为探测打开对外监听。
- 用户真实 profile 的显式 `listenPort: 3445` 已移除（改由插件默认 3081 决定；该行是 DSH 在设置页写入时回写的扁平行）。**下一次重启 dsh 后生效**，届时入口变为 `https://10.0.0.20:3081/`（若被占用则自动顺延）。

**3. P4-f：帧级状态提示浮层**
- 向官方**追加型** seat `shell.overlay` 注册紧凑胶囊（`id: dsh-lan-guard-status`）：「🌐 局域网访问已开启」+ 当前链接 + 「本次会话不再显示」；**只对本机操作者显示**（手机已在控制台内，无需再告知地址）；不替换任何官方内容。
- 实测：胶囊可见，文案含真实链接。

**4. P4 范围说明**
- **P4-d mDNS 未做**：Node 无内置 mDNS，需引入新运行时依赖（AGENTS §3.5/§4 灰名单，必须用户批准）或手写 DNS 报文（难验证）。
- **P4-e 局域网 HTTP 未做**：PLAN 原文即要求用户**显式接受明文风险**，且需改 SPEC §6.2。
- **P4-g 完整设备配对待做**。

`pnpm test` **188 项**全绿（新增端口校验、端口探测、代理端口顺延、端点注册等用例）；`pnpm run build` 与 `pnpm run verify` 通过。

### 验证 — P3 手机实测全部通过（2026-09-24）

用户实机反馈：**「这条是手机发布的消息。」**

- ✅ **发消息通过**：消息从手机经「门禁鉴权 → 反向代理 → DSH → Agent」送达，而发送路径就是 `/api/remote.mux` 那条 WebSocket 通道；回复也从同一通道回流到手机 → **WebSocket 长连接实际工作**。
- ✅ P3 退出条件（扫码打开 / 信任自签 CA / 密码登录 / 发消息 / 长连接）**全部满足**；官方 UI 零改动。
- 🔎 自查顺带发现并修掉一处**自己的违规**：`.lg-lock-emoji` 里残留了自定的 `line-height:1`，违反「客户端 CSS 自定排版属性必须为 0」这条不变量（实测 1 → 现为 **0**）。`pnpm test` 184 项全绿。
- 遗留观察项（非阻塞）：长时间挂起、走出 Wi-Fi 再回来时的重连表现；以及 P4-e（局域网 HTTP）场景。

### 验证 — 手机实机登录通过（2026-09-24）

用户实机反馈：**「无痕情况下可以访问，输入一次密码后即可」**。

- ✅ 上一次的 CSRF 误拒修复在**真机**上验证通过（此前手机侧 `Origin: null` 被误判为跨站）。
- ✅ 自签 CA 被手机接受（能打开页面即证书链通过）。
- ✅ 另确认：先前「重启后不需要密码」是**手机保留了 30 天有效期的普通会话 cookie**（非门禁失效）——已用非回环来源实测复核：无 cookie 时首页 `401` + 登录页、`/api/*` 为 `401`、伪造 token 为 `401`。
- 🔧 按承诺**移除**了 CSRF 错误态页面上那行临时诊断小字；同样的诊断信息改为**只写日志**（`sec-fetch-site` / `origin` / `host`），页面恢复干净。
- ⬜ 仍待用户确认：手机端**发一条消息**与 **WebSocket 长连接不断**（P3 退出条件的最后两项）。

### 修复 — 手机登录被 CSRF 判定误拒（2026-09-24，手机实测）

用户实测：「远程访问，输入密码也不对」→ 登录页返回「请求来源校验未通过」。

- **复现与定位**：从**非回环来源**（`curl --interface <LAN IP>`）经代理模拟手机提交：带正常头（`Origin` + `Sec-Fetch-Site: same-origin`）→ 通过（回「密码错误」）；无 `Origin` → 通过；仅显式 `cross-site` → 拒绝。说明判定逻辑本身没错，问题在手机发来的**非常规 Origin**——部分应用内浏览器/隐私模式在同源表单提交时发 `Origin: null`，而原实现在 `new URL(origin)` 抛错时直接 `return false`，把正常手机挡在门外。
- **修复**（`src/auth/manager.ts` 的 `passesCsrfCheck`）：`Sec-Fetch-Site` 作为权威信号（只拒绝显式 `cross-site`；`same-origin`/`same-site`/`none` 直接放行）；无该头时才回退到 `Origin`，且 **`Origin` 缺失 / 为 `null` / 无法解析一律放行**；能解析时比较 authority 并**容忍仅端口不同**。真正跨站必然带 `cross-site`，放宽不削弱防护。
- **可诊断性**：CSRF 拒绝时，登录页在该状态附一行灰色诊断（`sec-fetch-site` / `origin` / `host`），并把同样内容写进日志——万一下次仍失败，一次就能定位（此诊断行定位后即可移除）。
- 测试：`pnpm test` **184 项**全绿，新增走**真实代理 + 真实门禁**的端到端用例（`Origin: null` → 401「密码错误」而非 CSRF 页；显式 `cross-site` → 403）与 4 项判定单测。

### 修复 — 本机免锁语义 + 一批排版/文案问题（2026-09-24，用户实测反馈）

用户逐条反馈后集中修复。**分两类：客户端半刷新即生效；服务端半需要用户重启 dsh（模块代码不走 live reload）**。

**语义（服务端）**：
- **本机物理免锁**：用户指出参考实现「本机登录直接免锁，只有远程才需要锁定」，而我们本机也锁，体验差。现按来源判定：本机直连（回环 + 无访客标记）→ 免锁可写；远程（回环 + 带 `x-dsh-lan-guard-visitor: 1`）→ 按 `adminPolicy`：`local_only` **只读**（403 `read_only_remote`）、`password_unlock` **需解锁**、`open` 不锁。
- **机制**：代理转发时**先删后写** `x-dsh-lan-guard-visitor: 1`（`VISITOR_HEADER`），这是 DSH 侧区分「本机操作者」与「经代理访客」的唯一可靠信号（代理会把 `host` 改写成回环）；直连请求无法伪造。
- 免密链接改按「**可管理**」下发（本机操作者或已解锁的远程），而不是仅「已解锁」——否则本机免锁后反而看不到免密二维码。

**排版与文案（客户端）**：
1. 「已保存」改为 **2.5 秒自动消失**的提示条（原先常驻占一行）；
2. 解锁横幅**紧凑化**（`--dsw-font-xxs-12` + 小号次按钮），文案说明用途；本机免锁时不再显示；
3. TLS 两张卡片改用 `repeat(auto-fit, minmax(190px,1fr))`，**均分整行**（实测各 256px），不再挤在三分之一列；
4. CA 指纹放进等宽框并折行（实测高 62px、`scrollWidth == clientWidth`，**不再溢出**）；
5. 安全认证卡片新增一行说明：**访问密码 = 访客设备登录用；管理密码 = 解锁设置页管理台用（未设置时退回访问密码）**；
6. **只保留一个地址**：地址框显示的就是二维码内容（解锁＝免密链接、否则＝普通链接），去掉并存的第二个地址与重复的复制按钮（实测地址框仅 1 个、二维码 1 个）；
7. 锁定卡片的「忘记访问密码？」改为参考实现风格的「🛟 找回与重置访问密码指引」（本机直连免锁修改 / 无头环境删除 `secrets.json`）；
8. 远程只读时顶部给出说明条（「请在运行本程序的电脑上打开本控制台修改」）。

`pnpm test` **178 项**全绿（新增/改写 6 项覆盖本机免锁、远程只读、远程需解锁、访客标记不可伪造）。

### 修复 — tab 着色与锁定卡片照参考实现重做（2026-09-24，用户实测反馈）

- **tab 未选项「没跟上」**：我原先把未选 tab 调成 `label-secondary` 并把选中项加粗到 500，属于自创。实测官方**分段控件**（通用设置「外观 浅色/深色/跟随系统」）的规则是：所有项**同一字体、同一 `label-primary` 颜色**，选中态用 `bg-layer-3` 填充 + 边框改 `label-tertiary`。已照此重写 tab 条（胶囊形，与官方分段控件一致）。
- **锁定卡片照参考实现重做**（用户指出参考实现在锁定态「字体间距、颜色、文字大小」都更好）：
  - **去掉重复标题**：原先卡片标题头与居中标题都把「管理控制台已锁定」写了一遍（`Card` 现支持无标题）；
  - 标题与锁图标改用官方最大字号 token `--dsw-font-xl-24`（600 24px/32px）；
  - 说明段落从 13px 升为 `--dsw-font-s-14`（14px/22px，行距更舒展）；
  - 新增绿色胶囊「🔑 使用访问密码解锁」（`state-success-*`）；
  - 输入框改**全宽左对齐**（原先窄且居中），与按钮同宽（补 `box-sizing: border-box`，实测两者均 482px）；
  - 主按钮改为**始终可用的主按钮**（原先空输入即变灰），为空时提交给提示，并支持回车提交；
  - 恢复 `SPEC.md` F6 早就要求的「❓ 忘记访问密码？」红色链接（展开恢复说明）。
- 实测（真实 DSH，browser-skill 读 `getComputedStyle`）：锁定卡片 `0` 个重复卡片标题；标题 24/600/32；胶囊 13px 绿字深绿底；段落 14/400/22；输入框与按钮均 482px 且左对齐；主按钮为官方暗色主按钮（底 `#f9fafb` + 字 `#0f1115`）。**注**：dsh-bridge 的蓝色按钮用的是官方品牌蓝 `--dsw-static-deepseek-500`（#4176e6），与 DSH 官方暗色主按钮（近白）不同；本项目当前采用官方主按钮色，如需改蓝只需换一个 token。

### 修复 — 排版改用官方 font token（2026-09-24，用户实测反馈）

用户对比参考实现后反馈「输入框的字间距、按钮颜色和文字大小都很合理……我们是否可以读取它的字体大小，而不用自己设置？……你不觉得我们的字间距很难看吗？」。根因：我在设置页里**自己发明了字号/字重/行高**（16px/600、14px/600、12px/1.6 …），与官方规范脱节——官方每个尺寸都配了固定行高，自设 `line-height: 1.6` 会让中文行距松散，600 字重也比官方的 500 重。

修正：**字号、字重、行高三项全部改为官方 `font` 简写 token**，不再出现任何 `font-size` / `font-weight` / `line-height` / `letter-spacing` 声明（`grep -c` 结果为 0）：

| 元素 | 改前 | 改后（官方 token） |
| --- | --- | --- |
| 卡片标题 | 16px / 600 / normal | `--dsw-font-base-strong-16` → 16px / **500** / **24px** |
| 副标题、底部小字 | 12px / 400 / 1.6(19.2px) | `--dsw-font-xxs-12` → 12px / 400 / **18px** |
| tab、输入框、开关行 | 14px / 400–600 / normal | `--dsw-font-s-14` / `--dsw-font-s-strong-14` → 14px / **500** / **22px** |
| 主次按钮 | 14px / 600 / normal | `--dsw-font-s-strong-14` → 14px / 500 / 22px |
| 提示条、字段标签 | 13px / 400 | `--dsw-font-xs-13` → 13px / 20px |
| 等宽信息框 | 13px + 自定 mono 栈 | `--dsw-font-xs-13` + 官方 `--ds-font-family-code` |

实测对齐（真实 DSH，browser-skill 读 `getComputedStyle`）：`.lg-title` 16/500/24、`.lg-sub` 12/400/18、`.lg-btn` 14/500/22、`.lg-tab(选中)` 14/500/22、`.lg-mono` 13/400/20（SF Mono），**字距全部 `normal`**（与官方 nav 项一致）。官方 token 清单与「不许自定排版」的硬约束已记入事实基线。

### 修复 — 二维码尺寸与白框（2026-09-24，用户实测反馈）

用户对比参考实现后反馈「别人做的二维码小而精致，你做的太大了」。根因两条：码体定成了 340px（参考实现记录的「约 340px」是把参考截图按 DPR 1 误读，按 DPR 2 重测应为约 190px），且白色底板用了 `display:flex; justify-content:center` 而**撑满整行**，视觉更笨重。

修正：码体 `190px × 190px`；白框改为 `width: fit-content` + `margin: auto` **贴合码体并居中**。实测（真实 DSH，browser-skill）：白框 212×212、码体 190×190、水平居中、卡片总高显著变短，且 `document.querySelectorAll('.lg-qr svg').length === 1` 仍成立。已同步修正规格与事实基线里的尺寸记录。

### 变更 — 设置页改为 3 个 tab + 单一二维码（2026-09-24，用户实测反馈）

用户实测反馈：「安全认证和普通扫码可以分别做成两个 tab 页」「第一次进来没设密码有一个二维码，设了密码之后底下又出现一个二维码，搞不懂为什么要给两个二维码」。据此改版（用户选定 3 tab 方案）：

- **分区内做 3 个 tab**：**扫码访问**（状态 + 地址 + 唯一二维码）/ **安全认证**（模式三选一 + 双密码 + 回环免密）/ **连接与证书**（端口 + 网卡 + TLS + CA 指纹）。锁定态下 tab 2/3 显示居中锁定卡片，tab 1 仍可读。
- **任何时刻只渲染一个二维码，且它必须能用**：未设置访问密码 → **不画码**，只给「先设置访问密码」引导 + 跳转按钮（原先那个码扫了只会看到「尚未设置访问密码」）；已设密码未解锁 → **普通链接码** + 「解锁后可显示免密二维码」提示；已解锁 → **免密码**（扫码即登录），普通链接降级为 `复制链接`。
- 同步更新页面结构（锁定态、首次配置不得被锁定态挡住）与单一二维码状态表，并记录改版说明与验收方式。
- 真实验收（用户正在运行的 DSH，`patchReload: live` 热加载后刷新页面）：3 个 tab 均可切换；**`document.querySelectorAll('.lg-qr svg').length === 1`** 在解锁态与锁定态各验证一次；锁定后二维码由免密链接切换为普通链接并给出说明文案。截图存于 `.tmp/browser-proof/`（gitignored）。

### 修复 — 真实环境（用户正在运行的 dsh）暴露的两个缺陷（2026-09-24）

- **安装形式错误导致插件未激活**：profile patch 里的扁平 `- id: dsh-lan-guard` + `name:` 行只会「按 id 覆盖已存在条目」，对不存在的 id **被静默忽略**（无报错、无监听、设置页无分区）。已改为 `insert:` 列表形式；用户的 profile 设了 `dsh.profile.patchReload: "live"`，因此修正后**热加载进正在运行的 dsh（PID 不变、3080 会话不受影响），无需重启**。事实已记入事实基线。
- **首次安装死锁**：设置页初始为锁定态，而解锁需要密码——但此时**尚无任何密码**，于是「设置访问密码」的表单被锁在锁定卡片后面，永远到不了（真实环境复现）。两处修正：① 客户端在**未设置任何密码**时不进入锁定态（此时门禁本就拒绝一切设备，没有任何东西可保护）；② 服务端在**首次**设置访问密码成功后，顺带解锁本次管理会话，避免「刚设完就被要求再输一遍」。
- 真实验证（用户正在运行的 dsh）：插件热加载后 `*:3445` 监听、证书生成于 `~/.dsh/profiles/web/data/dsh-lan-guard/tls/`（私钥 600 / 证书 644）、设置页出现「局域网访问」分区与**可扫描二维码**、`--cacert` 对局域网 IP `https://10.0.0.20:3445/` 的**证书链校验通过**、非回环来源（模拟手机）被门禁拒绝为 `403 尚未设置访问密码`（**无暴露窗口**）。

### 修复 — 浏览器实测（browser-skill）发现的两个真实缺陷（2026-09-24）

> 这两条是**源码检查与 curl 测试都发现不了**的：前者是客户端状态刷新时序，后者是 CSS 变量名静默失效。

- **解锁后页面不刷新**：`write()` 原本用 POST 响应里的快照更新界面，而该快照是在响应 `Set-Cookie` 落库**之前**计算的，因此「管理员解锁」成功后页面仍显示锁定态、「重新锁定」后仍显示已解锁。现改为写操作后**重新 GET** 一次快照。
- **设置页用了一批不存在的官方 CSS 变量名**：`--dsw-alias-bg-elevated` / `-text-primary` / `-bg-secondary` / `-border-subtle` / `-bg-success` / `-bg-info` / `-bg-brand-weak` 等在 DSH 0.1.7 中**都不存在**，`getComputedStyle` 取空 → 样式静默退回硬编码回退值 → **暗色主题下白卡 + 近白文字**（与 dsh-mobile 记录的事故同类）。已按实测出的真实变量名（`bg-layer-*` / `label-*` / `border-l*` / `state-*-primary|tertiary` / `button-primary-fill` / `label-primary-foreground`）重写设置页 CSS，并保留回退值；真实变量清单已记入事实基线。
- 复验：浏览器实测暗色（卡片 `#232324` + 文字 `#f9fafb` + 深绿提示条）与浅色（白卡 + 近黑文字）均正常；设置页分区、状态胶囊、安全提示条、访问地址、`复制链接`/`隐藏二维码`、**二维码真实渲染**、免密链接与二维码、三选一大卡片、密码不回显、网卡下拉、CA 指纹、锁定态与解锁横幅全部可见且可用。截图存于 `.tmp/browser-proof/`（gitignored）。

### 修复 — P2 实施中发现并修正的真实缺陷

- **`apply` 收到的是已解析配置**：Loader 会先用 `Config` 校验，volatile 字段此时是 `{ get() }` 引用而不是裸值，`parseConfig` 二次校验会把它当成非法布尔值。现先解包引用再校验（真实 DSH 实例上暴露，已加回归测试）。
- **首次设置密码死锁**：`setPassword` 一律要求当前密码，而首次根本没有密码（管理解锁又退回访问密码），导致全新安装无法启用门禁。现允许「未设置时」经原生栅栏引导设置。
- **`ctx.settings` 取不到**：未在 `inject` 声明时属性访问抛错，导致开关写入被降级为 400。改用 `ctx.get('settings')` 可选查询（声明依赖会让没有 settings 服务的 profile 直接无法加载插件）。
- **免密链接在 `password` 模式下挂起**：门禁把「忽略该参数」当成已处理，但实际没有写出任何响应，请求一直挂到超时。现返回「放行」由代理继续转发。
- **免密令牌没有生成入口**：改为管理员解锁时惰性生成，且只返回给已解锁的调用者。
- **插件总开关与门禁开关混淆**：`enabled`（插件，volatile）与 `auth.enabled`（门禁，静态）是两个开关，现已分开，`auth-status` 同时如实报告两者。

### 实现 — P1 骨架 + 最小反代（2026-09-24）

- **工程骨架**（`package.json` / `tsconfig.json` / `tsconfig.tests.json` / `tsdown.config.ts` / `vitest.config.ts` / `cordis.patch.yml`）：TypeScript + pnpm + tsdown + vitest，照 dsh-quick-replies 的现成模板；`dsh.engines.dsh` 为 `>=0.1.7-rc.1 <0.2.0`，peer 范围覆盖 `0.1.7-rc.1`。
- **`src/config.ts`**：非敏感配置的 Schemastery `Config`（SPEC §5 全字段）+ 语义校验。被拒的非法值：缺 `dataDir`、非 IPv4 字面量的 `listenHost`、非 loopback 或非 `http:` 的 `upstreamOrigin`、`auth.enabled: false` 配非 loopback 监听、越界端口、未知 `mode` / `adminPolicy` / `tls.mode`、非正会话时长、`tls.mode: provided` 缺证书文件。
- **`src/headers.ts`**：Host/Origin 改写为上游 authority、注入 loopback cookie、剔除 hop-by-hop 头、响应侧丢弃上游 `set-cookie`、WS 101 只放行 5 个白名单头、请求目标规范化（裸 origin → `/`）。
- **`src/upstream-auth.ts`**：路线 A 的 token→cookie 交换与缓存（303 + `Set-Cookie` + `Location: ./`），并发去重、按 launch token 变化与过期前 60s 续换、401 后失效重换；token 与 cookie 只在内存，日志只记 cookie 名。
- **`src/proxy.ts` + `src/websocket.ts`**：`node:http` 原生反代，HTTP 流式转发（不缓冲）、WS upgrade 双向 pipe、`upgrade` 前立即挂 socket `error` handler、上游不可达 → 502、安全方法 401 后重试一次。
- **`src/index.ts`**：`inject = ['webServer', 'connection']`，`apply` 异步启动并把关闭注册为 fiber effect；**P1/P2 相位门禁**——非 loopback 的 `listenHost` 直接拒绝启动（P3 才放开）；拒绝与 DSH 自身端口冲突。
- **测试 71 项**（`tests/`，假上游绑 `127.0.0.1:0`）：配置校验、头改写、cookie 交换与缓存、HTTP/WS 转发、multipart 逐字节透传、大响应不缓冲、上游不可达、WS 断连不崩进程。

### 变更 — P1（2026-09-24）

- **新增 peer 依赖 `@deepseek-ai/schemastery`**（用户当次批准）：F6「路线乙」要求把非敏感开关声明为插件 `Config`（含 `.volatile()`），这必须用 Schemastery；已同步补进 peer 依赖表。
- **新增 `src/log.ts`**（模块清单之外的结构调整）：只放一个窄化的 `LanGuardLogger` 接口与 `noopLogger`，让宿主侧模块可在测试中用桩替换，并固定「任何日志调用都不得传入凭据」这条约束。模块划分是建议性的。
- **`tsconfig.json` 的 `types` 为 `["node"]`**（模板为 `[]`）：本插件宿主侧必须用 `node:http` 等内置模块，没有 Node 类型无法通过类型检查；测试 tsconfig 继承同一设置。
- **新增事实回填**：`DSH_HOME` 覆盖、`--patch` 叠加层、`webServer` 注册签名、token 交换的精确语义、`/api` 栅栏细节、`evaluatePluginCompatibility` 只看 `@deepseek-ai/dsh*` peer、以及「loopback 上 `/plugins/*` 与 `/assets/*` 不受浏览器 cookie 栅栏保护」这一条（P2 门禁必须覆盖代理端口上的**全部**路径）。

### 新增

- 项目文档定稿（AI 协作总纲、权限边界、技术规格、实施计划、事实基线、发布流程）。
- `README.md` / `README.zh.md` / `LICENSE` / `.gitignore`

### 变更（2026-09-24）

- **门禁规格定稿**：参考 dsh-bridge 的配置模型——`enabled` / `mode` / `adminPolicy` / `adminProtection` / 双密码（访问密码 + 独立管理密码）/ `secretToken` / `allowLoopback`，PBKDF2-SHA256 迭代 600000 带算法前缀，普通会话落盘、管理员会话仅内存。
  - `scope` 字段（`all` / `public_only` / `lan_only`）**省略**：本项目只有局域网一种通道。
  - **敏感数据改存插件私有 dataDir**（权限 600），不进 config——profile patch 是文本文件，可能被分享或提交。
- **设置 UI 定稿**：要做，参考 dsh-notify 的模式——注册官方 `settings.section` seat，纯 `React.createElement`（不引入 JSX），内联 CSS 使用官方 `--dsw-alias-*` 变量，覆盖触屏与窄屏两个断点；管理端点用 `connection.requestRejection()` 复用 DSH 原生栅栏。
- **实施计划调整**：P2 由「门禁」扩为「门禁 + 设置 UI」；原 P4-b「控制面板 UI」并入 P2；P1+P2+P3 预计约 1000–1350 行。
- **明确两套认证面**：设置页属**管理面**（DSH 原生栅栏），代理端口属**访客面**（本项目密码门禁）——能打开设置页 ≠ 能通过代理访问。
- **补充官方设置机制的事实与约束**：DSH 0.1.7 移除了 `ctx.settings.register()`，改为 Config-derived forms——表单命名空间即 Loader 条目 id，`ctx.settings.describe()` 投影条目 `Config` 的 volatile 字段，客户端经 `ctx.configForms.get(entryId)` 读取，写入落 `cordis.patch.yml` 的 `<entry-id>.config`。
  - **关键约束**：官方表单在**非回环页面**（手机通过代理访问时）`mode` 被固定为 `memory`，终态 `unavailable` 且**永不写入**。
  - 由此在 F6 增设「技术路线」待确认项（甲：纯自定义端点 / 乙：混合，建议乙），并记入 SPEC §8 第 4b 项。
  - 参考实现：`dsh-quick-replies`（官方 configForms + 局域网直连兜底）与 `dsh-notify`（自定义 `/config` 端点），两者机制不同但都在本机运行。

### 复查（2026-09-24，dsh-mobile 0.3.14 → 0.4.5）

- **修正全部行号**：dsh-mobile 从 0.3.14 升到 0.4.5，代码量显著增长（`gateway.ts` 2353→2950、`plugin.ts` 831→1298、`mobile-layout.ts` 482→638），事实基线中所有引用行号已位移并逐个重新核对：证书实现 `managed-setup.ts` **217**（`assertMatchingCa`）/ **275**（`generate`）/ **369**（`refreshManagedServerCertificate`）、`cli.ts:110`、`config.ts:219`/`:256`；layout `mobile-layout.ts` **89**/`apply` **569**/`panelInfo` **586**。§5.1 已加注「行号对应 v0.4.5，引用前请重新核对」。
- **修正过时表述**：§8 原写「dsh-mobile 的 peer 止于 `^0.1.3-0`，会被 0.1.7 预检拦下」——v0.4.5 已放宽到 `^0.1.7-0`。
- **补充 dsh-mobile v0.4.5 的实战教训**：dsh-mobile v0.4.5 的四条实战教训——① WS upgrade 必须在异步鉴权**之前**挂 socket `error` handler（否则重连期断开会抛未处理错误）；② 失败的静态资源 404 不能按 `immutable` 缓存；③ 端口占用约定（`3080` DSH / `3443` 其局域网网关 / `3444` 其自带反代）；④ 它自 v0.4.2 起自带的反代 provider 与本项目的定位差异。
- **补充文档相对路由的事实**：DSH 0.1.6/0.1.7 的**文档相对路由**（外壳 index 带 `<base href="./">`，浏览器侧用 `api/x`、`plugins/x`，服务端路由键仍为绝对路径），以及对本项目的四条影响（根路径不受影响 / 必须做尾斜杠规范化 / 不做子路径挂载 / 保持透明不改写资源 URL）。
- **SPEC 相应收紧**：默认端口 `3443` → **`3445`**（避开 dsh-mobile 占用的 3443/3444）；F1 增加「只支持根路径挂载、尾部斜杠规范化、不改写资源 URL、缓存头只对 200 加 immutable」；F3 增加「异步鉴权之前必须先挂 socket `error` handler」。
- **PLAN 相应补充**：P1 验收增加「插件 bundle（含文档相对形式）能加载」「尾斜杠规范化」「资源 URL 未被改写」三条；P2 验收增加「鉴权挂起期间断开 socket 不崩进程」。

### 拍板（2026-09-24：7 项未决事项 + 二维码）

- **7 项未决事项全部拍板**，规格的「未决事项」改为「**已确认的决策**」：

  | # | 决定 |
  | --- | --- |
  | 1 | 上游认证走 **A**——用 `ctx.connection.authenticatedUrl()` 完成 token→cookie 交换，**不自签** cookie |
  | 2 | 门禁配置模型参考 dsh-bridge（此前已定） |
  | 3 | **TLS 默认开启**（`mode: 'self-signed'`），可关闭；**关闭时设置页必须提示影响**（明文传输、凭据可被嗅探、secure context 能力受限、仅限可信私有网络） |
  | 4 | 设置 UI 要做（此前已定） |
  | 4b | UI 技术路线 **乙（混合）**——非敏感配置走官方 `configForms` 自动表单（volatile `Config`），敏感交互与手机场景走自定义端点 |
  | 5 | 网卡选择：配置文件 + 自动探测 |
  | 6 | 发布策略：保守 **L0** |
  | 7 | **语言：TypeScript**（用户统一约定：今后所有项目都用 TS） |

- **新增 `SPEC.md` F7 局域网二维码访问**（P3，**必做**）：设置页内展示二维码（内容为当前可访问 URL），支持**普通链接**与**免密链接**（带 `secretToken`，展示需管理员解锁）、复制按钮，并随网卡 / TLS / 端口 / token 变化**自动刷新**；依赖 `qrcode`，**建议服务端出 SVG**（dsh-mobile 做法，`RESEARCH.md` §5.8）。**视觉细节待用户提供参考图。**
- **`SPEC.md` §4 改为 TypeScript 工程栈**：模块划分全部改为 `.ts`；工程栈照 dsh-quick-replies（`RESEARCH.md` §5.9）——`tsdown` 构建、`vitest` 测试、`tsc --noEmit` 双 tsconfig、pnpm。
- **`PLAN.md` 相应调整**：P3 扩为「局域网可达 + 自签 TLS + 二维码」（150–200 → **350–500 行**）；原 P4-c 二维码并入 P3；P2 工作项 B 明确混合路线（volatile `Config` + **保留自定义端点兜底**）；P1 加入 TS 工程配置。P1+P2+P3 预计 **1200–1650 行**。
- **`RESEARCH.md` 去代码**：§5.1 中 dsh-mobile 的 `selfsigned` 调用示例改为**参数表格**，与「只借鉴参数、不复制代码」的约束一致。

### 视觉参考定稿（2026-09-24，用户提供 5 张 dsh-bridge 实机截图）

- **提取视觉语言**：卡片分组（白底 / 1px 浅灰边框 / 圆角约 14px / 内边距约 20px / 间距 16–20px）、状态胶囊（绿=运行中、黑=已启用）、**大卡片选择器**（整卡可点、选中 2px 主色边框 + 浅主色背景）、锁定态、解锁横幅、等宽 URL 框、二维码白底卡片、内容宽度约 790px。
- **补充页面结构与视觉规范**：单分区四块——① 状态卡片 ② 安全认证卡片 ③ 连接与证书卡片 ④ 锁定态；并明确**不照搬** dsh-bridge 的横向 tab、版本升级提示、运维监控看板、配置导入导出、服务重启按钮（超出本项目范围）。
- **二维码区块由「待参考图」改为定稿**：补上二维码区块的六步布局——安全提示条 → 等宽 URL 框 → 并排按钮（复制链接 / 显示·隐藏二维码）→ 二维码（**默认展开**）→「请在私密环境下使用」→ PWA「添加到主屏幕」引导文案。
- **新增一条硬约束**：免密 token **必须用 `?auth=`，绝不能用 `?token=`**——后者是 DSH 自身的 launch token 参数，代理需把它原样转发给上游换 cookie，同名会互相覆盖。代理识别 `?auth=` 后校验、下发自己的会话 cookie、**302 到去掉 token 的干净 URL**。
- 明确手机端**不提供**「分享给其他设备」入口，避免含 token 的链接二次扩散；需要分享时由本机设置页复制。

### 审计修正（2026-09-24）

- 阶段总览表与后文不一致：P3 仍写 150–200 行且不含二维码，P4 仍把控制面板和二维码当成待选。总览已与 P2/P3/P4 正文对齐。
- P0 仍把「§8 其余五项」标成未完成。已改为全部拍板；P0 仍不退出，直到用户明确说「开始 P1」。
- F2 仍写「上游认证待确认」。已改为路线 A 已定，路线 B 不采用。
- 配置示例把 `listenHost` 写成 `0.0.0.0`，与「默认不对外监听」矛盾。示例默认改回 `127.0.0.1`，对外必须显式修改。
- README（中英）与协作文档仍把 TLS 写成「可选」。已改为默认开启、可关闭并提示影响；README 补上二维码。
- F6 的「技术路线」「挂载位置」与 F6 同级，目录上像两条独立功能。已降为 F6 的子节。

### 说明

- **尚无实现代码。** 实施从 P1 阶段开始，需用户明确确认。
- 发布授权当前为 L0（保守，不发布）。
