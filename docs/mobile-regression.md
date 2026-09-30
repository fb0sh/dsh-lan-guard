# 电脑侧窄屏回归验证台

真机验收清单见 [mobile-acceptance.md](mobile-acceptance.md)，真机排障手册见 [mobile-debug-runbook.md](mobile-debug-runbook.md)。
本页解决第三个问题：**不碰手机，在电脑上就能判断「窄屏 + 经代理」下的 DSH 是否正常**。

适用时机：DSH 升级后、改动代理或 index 注入后、发版前的自检。

> ⚠️ **边界**：本机 headless Chromium 只能验**布局与几何**。滚轮与手指走不同的事件路径，
> 所以「手指拖不动」这类**触摸**问题本地永远复现不出来 —— 那类问题仍以真机为准。
> 本页的价值是把「看起来不对」变成可比对的数字，并在发版前把回归挡在电脑上。

## 一、两个入口，缺一不可

| 入口 | 地址 | 认证方式 | 角色 |
| --- | --- | --- | --- |
| 3080 直连 | `http://127.0.0.1:3080/` | 需要会话 cookie（见第二节） | **干净对照组**：证明不经代理时官方本来就是这样 |
| 3081 代理 | `https://<局域网IP>:3081/` | 回环免锁 | **被测对象**：手机实际走的那条路 |

判定方式不是「3081 看起来正常」，而是 **3081 与 3080 逐项一致**。只有单独看 3081，无法区分
「官方就坏了」和「代理把它弄坏了」。

## 二、3080 怎么进（免 token）

`dsh web` 只在启动终端打印一次带 `?token=` 的地址，token 是**进程级随机值**（`randomBytes(32)`，
只存在内存里），重启即变、**无法从磁盘读到**。所以自动化访问要么向人索取，要么自己签一个 cookie ——
后者可复跑，用本机凭据签名即可：

- cookie 名 = `dsh-auth-` + base64url(sha256(authority))，`authority` 就是请求的 host（如 `127.0.0.1:3080`）
- cookie 值 = `v1.<base64url(payload)>.<base64url(HMAC-SHA256(secret, body))>`，`body` 即中间那段
- payload = `{version:1, authority, issuedAt, expiresAt}`（毫秒时间戳）
- secret = `~/.dsh/.credentials.yaml` → `records["client-connection/browser-session"].payload.secret`（base64url，先解码成 32 字节 Buffer）

可直接用的签名脚本（全程不打印 secret）：

```sh
# 生成一个 3080 的会话 cookie
COOKIE="$(node -e '
const fs=require("fs"),{createHash,createHmac}=require("crypto");
const yaml=fs.readFileSync(process.env.HOME+"/.dsh/.credentials.yaml","utf8");
const m=yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/);
if(!m) throw new Error("browser-session secret not found in ~/.dsh/.credentials.yaml");
const raw=m[1], pad="=".repeat((4-raw.length%4)%4);
const secret=Buffer.from(raw.replaceAll("-","+").replaceAll("_","/")+pad,"base64");
if(secret.byteLength!==32) throw new Error("secret is not 32 bytes");
const b64u=b=>Buffer.from(b).toString("base64").replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const authority="127.0.0.1:3080";
const name="dsh-auth-"+b64u(createHash("sha256").update(authority).digest());
const now=Date.now();
const body=b64u(Buffer.from(JSON.stringify({version:1,authority,issuedAt:now,expiresAt:now+86400000}),"utf8"));
console.log(name+"="+"v1."+body+"."+b64u(createHmac("sha256",secret).update(body).digest()));
')"

curl -s -o /dev/null -w "3080 with cookie -> %{http_code}\n" -H "Cookie: $COOKIE" http://127.0.0.1:3080/
# 期望 200；同一个请求不带 cookie 应为 401
```

> 🔐 secret 是凭据：不要写进文档、不要提交、不要粘贴到对话里。`authority` 必须与实际访问的 host 完全一致
> （`127.0.0.1:3080` 与 `localhost:3080` 是两个不同的 audience）。

## 三、视口与 UA

```
viewport 390 × 844   ← iPhone 16 Pro Max 的逻辑分辨率量级
isMobile: true, hasTouch: true, deviceScaleFactor: 2
UA: Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) ... Version/27.0 Mobile/15E148 Safari/604.1
```

3081 是自签 HTTPS，浏览器上下文需 `ignoreHTTPSErrors: true`。

## 四、四个量化判据

| # | 判据 | 取值 | 通过标准 |
| --- | --- | --- | --- |
| 1 | **右侧栏可见面积** | `[data-sidebar-right-panel]` 与视口的相交面积 ÷ 视口面积 | **≥ 90%**，且屏幕正中 `elementFromPoint` 的结果落在面板内部 |
| 2 | **会话可滚范围** | `[data-conversation-scroll]` 的 `scrollHeight - clientHeight` | 远大于 0（rc.2 长会话实测 **17433px**） |
| 3 | **被裁层数** | 滚动层内部所有 `overflow-y` 为 `hidden`/`clip` 且内容溢出的 `div` 个数 | **0** |
| 4 | **`?lgdiag=1` 尾部** | 诊断面板末几行 | 全是 `official scroll layer works` 或 `ineffective -> reverted (stock page)`；出现 `clip grow` 才说明补偿真的动手了 |

判据 1 的失败形态很好认：**按钮点了会消失（`data-sidebar-right-open` 出现、`expandButtonGone = true`），
但面板可见面积 0%** —— 说明状态切换成功、几何错位，是布局问题不是事件问题。此时看
`[data-rightbar-col]` 的 rect：官方 rc.2 的正常值是 `[390, 0, 0, 844]`（宽 0、高满、贴右边缘），
面板靠内联 `width:100vw` + `position:absolute; top:0; bottom:0; right:0` 铺满。
**只要这个列的高度塌成 0 或它的 y 被推到视口外，面板就必然看不见**（外层 `.frame` 还有 `overflow:hidden` 会把它裁掉）。

## 五、实测基线（DSH 0.2.0-rc.2 / dsh-lan-guard 0.4.6，2026-10-01）

| 判据 | 3080 直连 | 3081 代理 |
| --- | --- | --- |
| 右侧栏可见面积 | **100%**（面板 `[0,0,390,844]`） | **100%** |
| 屏幕正中命中面板内 | ✓ | ✓ |
| 收起 → 再展开 | — | ✓ / ✓（可反复交互） |
| 会话可滚范围 | **17433px**（client 736 / scroll 18169） | — |
| 被裁层数 | **0** | — |
| `?lgdiag=1` 尾部 | `official scroll layer works` | — |
| `html` / `#root` 上的内联样式 | 只有 `color-scheme` / 空 ⇒ 补偿**零介入** | — |
| JS 报错 | 0 | 0 |

对照历史基线：DSH `0.2.0-rc.1` 上同一判据是「被裁层 1（`EvIC1a_frame`，796 高）、可滚范围 336px」，
`mobileScrollFix` 会真的动手。**rc.2 修掉该回归后，判据 3/4 反而变成「补偿不介入」才算健康。**

## 六、复跑步骤

```sh
# 1) 确认在跑、且装的是预期版本
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':3080|:3081'
grep '"version"' ~/.dsh/profiles/web/node_modules/dsh-lan-guard/package.json

# 2) 注入与开关（回环免锁）
curl -sk https://127.0.0.1:3081/ | grep -o 'dsh-lan-guard:[a-z-]*' | sort -u
curl -sk https://127.0.0.1:3081/plugins/dsh-lan-guard/config | python3 -m json.tool | grep -E 'mobileScrollFix|settingsUnlock'

# 3) 按第二、三、四节用浏览器（headless 或 DevTools 设备模拟）分别跑 3080 与 3081，抄下四个判据

# 4) 两个入口逐项比对，一致即通过；不一致时先看 3080（它是基线）
```

## 七、判读速查

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| 3080 就不正常 | 与代理无关，是官方或别的插件 | 用干净的 0.2.0-rc.2 复现，参照 [upstream-dsh-0.2.0-rc.1-session-scroll.md](upstream-dsh-0.2.0-rc.1-session-scroll.md) 的写法整理证据 |
| 3080 正常、3081 不正常 | 代理或 index 注入引入的 | 逐个关掉四个注入开关复测（`settingsUnlock` / `mobileCompat` / `mobileScrollFix` / `socketWatchdog`） |
| 抽屉按钮消失但可见面积 0% | 状态切换成功、几何错位 | 量 `[data-rightbar-col]` 的 rect 与 `display`（应为 `grid`，高满、贴右缘） |
| 判据 4 出现 `clip grow layers=N` | 补偿真的动手了 ⇒ 官方裁剪回归又回来了 | 记下 N 与 `A->B`，对照 rc.1 的 336px 基线 |
| `lgdiag` 无面板 | 注入没生效 | 查第 2 步的 curl 输出 |
