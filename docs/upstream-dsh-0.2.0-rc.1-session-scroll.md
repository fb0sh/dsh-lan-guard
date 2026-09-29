# [0.2.0-rc.1] 会话正文被内部 `overflow:hidden` 层裁剪，移动端官方滚动层只剩 ~336px 可滚范围

> 本文是准备投递到 `deepseek-ai/deepseek-harness` 的回归报告底稿（该仓库 issues 关闭，走 Discussions）。
> 观察工具：数据线连接的 iPhone + Safari 远程检查器（WebKit 远程检查协议），全部数值为真机实测。

## TL;DR

DSH `0.2.0-rc.1` 在窄屏/移动端把会话正文包在一个 `overflow:hidden` 且高度被锁死（≈视口高）的层里，内容高度传不到官方滚动层 `[data-conversation-scroll]`。结果是滚动层「有溢出」却几乎没有可滚范围：**打开会话不停在最新消息、手指几乎拖不动**。`0.1.7-rc.2` 在同一台手机、同一会话形态下没有这个问题。

## 环境

- 设备：iPhone 16 Pro Max（iPhone17,2），iOS 27.0
- 浏览器：Chrome for iOS（WKWebView）与 Safari，行为一致
- 页面：DSH Web UI（经局域网反向代理访问，页面 DOM 与 DSH 原生一致；对比用的 `0.1.7-rc.2` 亦同）
- 会话：长会话（81–91 条消息）
- 同一台手机、同一会话形态、同一插件版本，**唯一变量是 DSH 版本**

## 现象

会话内容看得见，但手指上下拖动几乎无效；打开会话不定位到最新消息；官方「回到底部」按钮位置异常。

## 关键测量（真机，滚到中段）

官方滚动层 `[data-conversation-scroll]`（`.wSkVaW_scrollBody`）：

| DSH 版本 | clientHeight / scrollHeight | 可滚范围 | flow 项数 | 最后一条消息 top |
| --- | --- | --- | --- | --- |
| `0.1.7-rc.2` | 720 / 15925 | **15205px** | 91 | 574（视口内） |
| `0.2.0-rc.1` | 668 / **1004** | **336px** | 81 | **21215（视口外）** |

`0.2.0-rc.1` 上该滚动层的内部结构：

```
[data-conversation-scroll] .wSkVaW_scrollBody   oy=auto   ch/sh = 668/1004   display:flex; flex-direction:column
└─ (div, display:contents)
   └─ .EvIC1a_frame    oy=hidden  ch/sh = 796/21135     ← 高度锁死在视口高，内容 21135px 被裁
      └─ .EvIC1a_root  oy=clip    ch/sh = 21083/21083   ← 这层自身尺寸正确（= 内容高度）
         └─ …81 个 .EvIC1a_flowItem（最高一条 5257px）
```

即：**内容层的尺寸是正确的（21083px），但它外面套了一层 `overflow:hidden` + 高度锁死的框**，高度在框处被截断，官方滚动层只拿到「框的高度 + 输入框座位高度」≈1004px。

## 排除项（都不是嫌疑）

- 把扩展注入的内联样式**全部清空**后，上述 `ch/sh=796/21135` 与裁剪行为**逐字节复原** ⇒ 裁剪来自 DSH 自身 CSS，不是注入造成。
- 触摸点（视口中心）的元素链自上而下全部 `pointer-events:auto`，最上层就是会话正文；三个全屏装饰层（`.pI_x6G_overlayLayer`、`.dsh-sc-layer`、`.P3OORG_panel`）在两个版本里都是 `pointer-events:none`。
- 触摸点最近的「可滚祖先」就是官方滚动层本身 —— 元素没错，错的是它的可滚范围。

## 临时补偿（dsh-lan-guard 0.4.4，开关 `mobileScrollFix`）

对**官方滚动层内部**满足「`overflow:hidden/clip` 且内容溢出」的层同时设 `height:auto` 与 `overflow:visible`：

- `height:auto`：让该层长高到内容高度，高度才能回流到官方滚动层 —— 可滚范围 336 → **20675px**；
- `overflow:visible`：让该层不再是滚动容器。**这一条不能省**：官方「回到底部」的槽 `EvIC1a_toBottomSlot` 是该层的 `position:sticky; bottom:208px` 子元素，若该层仍是滚动容器，槽会以「该层自己的底边」为参照 —— 该层长到 21135px 后按钮从 y≈514 掉到 y≈10683 而消失。

补偿后真机验收：输入框在顶部/中段/靠底/到底四处均固定 `[588,780]`；官方 ↓ 按钮四处均在 `[538,572]`；滚到底时最后一条消息可见。补偿带自检（可滚范围必须真的变大）与整体回退，且只动滚动层内部那一层。

## 想请上游确认的问题

1. 窄屏/移动端下 `EvIC1a_frame` 的 `overflow:hidden` + 高度锁死是否是 `0.2.0-rc.1` 的预期行为？`0.1.7-rc.2` 上同一层与内容同高。
2. 若裁剪是预期的，会话正文在移动端应如何滚动？其内部的 `.EvIC1a_scroll` 名为 scroll 实际 `overflow:visible`。
