# 手机端调试 Runbook（mobile-scroll-fix 分支）

目标：在一台新机器（MacBook）上从零把插件跑起来 → 确认每一关 → 用手机定位
「看得见、拖不动」到底卡在哪一层。每一步都给出**期望输出**，不符就停在那一关。

## 第 0 关：代码与服务（MacBook 上）

```bash
git clone https://github.com/idoall/dsh-lan-guard.git && cd dsh-lan-guard
git checkout mobile-scroll-fix && git log --oneline -1
# 期望：69a0287 fix: 0.4.3 补充 — 全屏视觉层放行触摸…

pnpm install && pnpm run verify
# 期望：Tests 359 passed (359) + 4 次 Build complete

dsh plugin --profile web add link:"$PWD"
# 期望：列出的插件里有 dsh-lan-guard（版本 0.4.3）
```

> ⚠️ 不要用 `dsh plugin add dsh-lan-guard@latest`：npm 上只有 0.4.1，没有本分支的修复。

```bash
dsh web restart      # 或你的重启方式；等 10 秒
curl -sk https://127.0.0.1:3081/ | grep -o 'dsh-lan-guard:[a-z-]*' | sort -u
# 期望（settingsUnlock 关、mobileScrollFix 开时）：只有 dsh-lan-guard:mobile-scroll
curl -sk https://127.0.0.1:3081/plugins/dsh-lan-guard/config | python3 -m json.tool | grep -E 'mobileScrollFix|settingsUnlock|answerHeartbeat'
# 期望：answerHeartbeat true / mobileScrollFix true
```

## 第 1 关：手机接入

手机 Safari 打开 `https://<这台 MacBook 的局域网 IP>:3081/`。
首次接入需要：信任自签 CA（设置页扫码流程有指引）→ 输访问密码 → 给设备命名。
**期望**：能打开会话列表并进入一个消息多的会话。

## 第 2 关：手机四项体验（不带任何参数，直接刷新）

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 手指上下拖动会话内容 | 内容跟着手指走 |
| 2 | 打开会话 | 直接停在最新消息 |
| 3 | 滚到中间 | 右下角官方 ↓ 出现，点击后真回到最底 |
| 4 | 打开左侧边栏 | 无灰雾、每项可点 |

**四项全过** → 调试结束，回主线合并发版。
**任何一项不过** → 进第 3 关拿数据。

## 第 3 关：诊断（两个入口，按顺序）

**① 快速版**：地址加 `?lgdiag=1`，等 3 秒，绿字面板截图。重点两行：

```
official scroll layer already works   ← 官方滚动层可滚（触摸放行的前提）
touch passthrough layers=N            ← 放行了几层（N≥1 才说明修复跑了）
```

**② 精确版（强烈推荐）**：iPhone 用线连 MacBook →
iPhone「设置 → App → Safari → 高级 → 网页检查器」打开 →
MacBook Safari「开发 → 你的 iPhone → 10.0.0.30…/…」→ 弹出 Web Inspector。
在 **Console** 里依次跑三段探针（手指按住聊天区中间时跑第 ① 段最好）：

```js
// ① 手指位置的最上层元素链（谁在吃触摸，一眼可见）
var el=document.elementFromPoint(innerWidth/2,innerHeight/2),ch=[];
while(el&&el!==document.body){var s=getComputedStyle(el);
ch.push((typeof el.className==='string'?el.className.split(' ')[0]:'?')+' | '+s.position+' | z'+s.zIndex+' | pe'+s.pointerEvents);el=el.parentElement}
console.log(ch.join('\n'));

// ② 官方滚动层是否真的可滚
var c=document.querySelector('[data-conversation-scroll]');
console.log('conv',c.clientHeight,'/',c.scrollHeight,'ovfY='+getComputedStyle(c).overflowY,'scrollTop='+c.scrollTop);

// ③ 全屏定位层清单（拦触摸的嫌疑人）
[...document.querySelectorAll('div')].filter(e=>{var r=e.getBoundingClientRect(),s=getComputedStyle(e);
return (s.position==='fixed'||s.position==='absolute')&&r.width>innerWidth*.9&&r.height>innerHeight*.8})
.map(e=>(typeof e.className==='string'?e.className.split(' ')[0]:'?')+' z='+getComputedStyle(e).zIndex+' pe='+getComputedStyle(e).pointerEvents)
```

## 第 4 关：把结果发回来（三选一）

1. **拖动了** → 报"四项全过"，主线合并发版；
2. **仍拖不动** → 发第 3 关①的面板截图 + ②③ 的 Console 输出（截图或文本均可）；
3. **出现新异常（白屏/布局乱）** → 发 `?lgdiag=1` 面板 + Console 红色报错第一条。

## 判读速查

| 现象 | 含义 | 下一步 |
| --- | --- | --- |
| lgdiag 无面板/无 `mobile-scroll` 标记 | 注入没生效 | 查第 0 关的 curl 输出与 patch 开关 |
| `passthrough layers=0` 且拖不动 | 放行没命中（层有交互后代/文本多） | 发③的清单，我放宽条件 |
| ①里最上层 `peauto` 且不是按钮 | 还有别的层在拦 | 发整条链，我针对性放行 |
| ②里 `clientH==scrollH` | 官方层没内容（高度链又断了） | 发 lgdiag 全屏，我查链 |
| 拖动了但松手回弹/到底部不跟 | 惯性/跟随问题 | 描述现象即可 |
