# 手机端验收清单（dsh-lan-guard）

每次改动代理、门禁、index 注入或手机相关行为后，按这份清单在**真机**上过一遍。
本清单的实测基线数据来自 2026-10-01（插件 `0.4.6` / DSH `0.2.0-rc.2`）。

电脑上先跑得动的**几何回归**（两个入口、四个量化判据、免 token 直连 3080 的方法）见
[mobile-regression.md](mobile-regression.md)；本页只留真机才做得准的部分：**触摸**、锁屏/切后台、语音。

## 0. 前置

- 手机与运行 DSH 的电脑在同一 Wi-Fi；
- 手机已信任自签 CA（否则 `wss://` 会被拦，页面能开但会话不加载）；
- 电脑侧：`lsof -nP -iTCP:3081 -sTCP:LISTEN` 有监听（默认 `*:3081`）。

## 1. 页面与注入（服务器侧先看，最快）

```sh
# 页面里实际注入了什么（按开关而定）
curl -sk https://127.0.0.1:3081/ | grep -o 'dsh-lan-guard:[a-z-]*' | sort -u
# 四个注入：settings-unlock / mobile-compat / mobile-scroll / socket-watchdog，
# 各自只在对应开关为 true 时出现。代码里四个默认都是 true，但本机 profile 显式关掉了
# settingsUnlock / mobileCompat / socketWatchdog，所以通常只看到 mobile-scroll。

# 开关现值 + 代理侧计数（回环免锁）
curl -sk https://127.0.0.1:3081/plugins/dsh-lan-guard/config | python3 -m json.tool | head -20
```

## 2. 真机必过项

| # | 操作 | 期望 | 实测 |
| --- | --- | --- | --- |
| 1 | 打开一个**消息很多**的会话 | 能看到最新内容，**可上下滑动**到更早消息（出现「加载更早」） | ✅ 2026-09-28 |
| 2 | **锁屏 60 秒**后解锁回来 | 会话仍在、**无需重连**；直接发一条消息成功 | ✅ 2026-09-28（连接存活 86.4s，正常 Close） |
| 3 | 切到别的 App 一分钟再回来 | 同上 | ✅ 2026-09-28 |
| 4 | 发一条消息（可用语音转文字） | 送入并收到回复 | ✅ 2026-09-28 |
| 5 | 长会话里快速上下滑动 | 不出现「卡死/白屏」；输入框与浮层不遮挡正文 | ✅ 2026-09-28 |
| 6 | 点会话头部的**「展开右侧栏」** | 按钮消失、右侧面板铺满屏幕、面板内容可滚动 | ⏳ 2026-10-01 电脑侧几何回归通过（可见面积 100%，3080/3081 一致）；**真机待确认** |

## 3. 代理侧对账（电脑上跑）

```sh
curl -sk https://127.0.0.1:3081/plugins/dsh-lan-guard/config | python3 -m json.tool
```

- `connection.heartbeatAnswered` 应随手机使用**持续增长**（代理在替挂起的页面回心跳）；
- `connection.recent[*].sawCloseFrame` 应为 `true`（正常关闭）；出现大量 `false`（`1006` 无 Close 帧）= 又回到被心跳回收的老毛病；
- 单条连接存活时间应能随使用超过 60 秒（0.3.6 基线：静默 ~6 秒）。

## 4. 出问题时的自检

- 页面地址后加 `?lgdiag=1` → 顶部显示一屏诊断（脚本每 1.5 秒追加一行）。重点看这三行：
  - `clipping=N` —— 找到几层「`overflow:hidden`/`clip` 且内容溢出」的层。**DSH `0.2.0-rc.2` 上应为 `0`**；
    出现 ≥1 才说明官方裁剪回归复发（`0.2.0-rc.1` 时该值为 `1`，被裁的是 `EvIC1a_frame`）。
  - `official scroll layer works; waiting for late clip` 或 `ineffective -> reverted (stock page)`
    —— 两条都表示「官方滚动层健康、补偿没有介入」，这在 rc.2 上是**正常**形态，不是故障。
  - `clip grow layers=N max A->B` —— 只有补偿真的动手才会出现。出现即说明有层被裁，
    记下 `N` 与 `A->B` 再报（对照：rc.1 上真机实测 336px → 6889px）。
- 会话停在「载入历史…」不出内容：先看 `connection.recent` 是否有 `1006`，再看手机是否需要重新登录门禁。

## 5. 已知边界

- `mobileCompat` / `socketWatchdog` 默认关闭（0.4.0 曾致手机整页空白）。要支持 iOS < 17.4 的老设备时，
  先单独打开 `mobileCompat`，用老设备验证 `AbortSignal.any` / `Promise.withResolvers` / `Iterator` 三项可用后再保留。
- 经代理的页面（3081）管理台受 `auth.adminPolicy` 约束；本机直连 `127.0.0.1:3080` 免锁。
