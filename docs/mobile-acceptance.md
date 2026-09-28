# 手机端验收清单（dsh-lan-guard）

每次改动代理、门禁、index 注入或手机相关行为后，按这份清单在**真机**上过一遍。
本清单的实测基线数据来自 2026-09-28（0.4.1）。

## 0. 前置

- 手机与运行 DSH 的电脑在同一 Wi-Fi；
- 手机已信任自签 CA（否则 `wss://` 会被拦，页面能开但会话不加载）；
- 电脑侧：`lsof -nP -iTCP:3081 -sTCP:LISTEN` 有监听（默认 `*:3081`）。

## 1. 页面与注入（服务器侧先看，最快）

```sh
# 0.4.1 起：应看到 mobile-scroll 与 settings-unlock；mobile-compat / socket-watchdog 默认关闭
curl -sk https://127.0.0.1:3081/ | grep -c 'dsh-lan-guard:mobile-scroll'

# 开关现值 + 代理侧计数（回环免锁）
curl -sk https://127.0.0.1:3081/plugins/dsh-lan-guard/config
```

## 2. 真机必过项

| # | 操作 | 期望 | 2026-09-28 实测 |
| --- | --- | --- | --- |
| 1 | 打开一个**消息很多**的会话 | 能看到最新内容，**可上下滑动**到更早消息（出现「加载更早」） | ✅ |
| 2 | **锁屏 60 秒**后解锁回来 | 会话仍在、**无需重连**；直接发一条消息成功 | ✅（连接存活 86.4s，正常 Close） |
| 3 | 切到别的 App 一分钟再回来 | 同上 | ✅ |
| 4 | 发一条消息（可用语音转文字） | 送入并收到回复 | ✅ |
| 5 | 长会话里快速上下滑动 | 不出现「卡死/白屏」；输入框与浮层不遮挡正文 | ✅ |

## 3. 代理侧对账（电脑上跑）

```sh
curl -sk https://127.0.0.1:3081/plugins/dsh-lan-guard/config | python3 -m json.tool
```

- `connection.heartbeatAnswered` 应随手机使用**持续增长**（代理在替挂起的页面回心跳）；
- `connection.recent[*].sawCloseFrame` 应为 `true`（正常关闭）；出现大量 `false`（`1006` 无 Close 帧）= 又回到被心跳回收的老毛病；
- 单条连接存活时间应能随使用超过 60 秒（0.3.6 基线：静默 ~6 秒）。

## 4. 出问题时的自检

- 页面地址后加 `?lgdiag=1` → 顶部显示一屏诊断：
  `narrow / mobile / innerHeight / visualViewport / pageScrolls / clippingLayers / patched`。
  判定：`pageScrolls=false` 且 `clippingLayers>0` 说明"内容被裁剪、滑不动"这个老毛病复发了，
  且脚本应当自动 `patched`；若 `patched=0`，把这一屏截图即可定位。
- 会话停在「载入历史…」不出内容：先看 `connection.recent` 是否有 `1006`，再看手机是否需要重新登录门禁。

## 5. 已知边界

- `mobileCompat` / `socketWatchdog` 默认关闭（0.4.0 曾致手机整页空白）。要支持 iOS < 17.4 的老设备时，
  先单独打开 `mobileCompat`，用老设备验证 `AbortSignal.any` / `Promise.withResolvers` / `Iterator` 三项可用后再保留。
- 经代理的页面（3081）管理台受 `auth.adminPolicy` 约束；本机直连 `127.0.0.1:3080` 免锁。
