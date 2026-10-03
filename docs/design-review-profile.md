# 设计评审 profile：在真实 DSH 里看插件界面

这份文档记录一次性、可复现的"设计评审"环境：起一个**独立 profile**，装本仓库的本地构建，
把界面截图出来。它**不碰**你正在用的那个 `web` profile。

用于：改完设置页 / 门禁页的样式后，在真实 DSH 里核对，并重新生成 `assets/*.png`。

## 为什么不能直接改 `web` profile

- 运行中的 DSH 用的是 `~/.dsh/profiles/web/node_modules/dsh-lan-guard`（npm 版，pnpm 硬链接）。
  就地覆盖会写穿 pnpm store。
- 客户端产物虽然能被 HMR 轮询发现，但**宿主半侧**（门禁页 HTML、路由）只有重启才生效，
  而重启会把当前会话一起带走。

所以另起一个 `DSH_HOME`，整套环境都落在仓库内的 `.tmp/`（已在 `.gitignore` 里）。

## 一次性搭起来

```sh
cd <repo>
export DSH_HOME="$PWD/.tmp/dsh-home"
# 仓库内的 pnpm 家目录，避免写 ~/.local/share/pnpm
export PNPM_HOME="$PWD/.tmp/pnpm" XDG_DATA_HOME="$PWD/.tmp/xdg" \
       XDG_CACHE_HOME="$PWD/.tmp/cache" XDG_CONFIG_HOME="$PWD/.tmp/config" \
       npm_config_store_dir="$PWD/.tmp/store"

dsh --profile designcheck --from-default-profile web --dump-config   # 建 profile
pnpm run build                                                      # 先构建
dsh plugin --profile designcheck add "link:$PWD"                     # 装本地构建
```

然后写 `.tmp/dsh-home/profiles/designcheck/cordis.patch.yml`：

```yaml
- id: dsh-lan-guard
  name: dsh-lan-guard
  config:
    # DSH 自己拒绝非回环 bind（0.0.0.0 会被明确拒绝），
    # 所以要**借本插件的代理**把界面发布到局域网，评审浏览器才够得着。
    listenHost: 0.0.0.0
    listenPort: 3091
    # 必填：默认值写死 3080，不指向本 profile 的 web 端口就会代理到你自己那个 DSH。
    upstreamOrigin: http://127.0.0.1:3090
    networkInterface: ens37        # 按机器改；换成评审浏览器能路由到的网卡
    tls:
      mode: off                    # 免掉自签证书的信任拦截
      allowInsecureLan: true       # 非回环 + 关 TLS 需要它，否则启动即拒绝
    auth:
      mode: token_and_password
      adminPolicy: open
      requirePairing: false        # 想看配对页就设 true
```

## 起服务、拿访问链接

```sh
dsh --profile designcheck --port 3090 --host 127.0.0.1 --no-open
# 输出形如 dsh web: http://127.0.0.1:3090/?token=<TOKEN>

# 回环访问享有物理免锁，所以用回环会话做管理写：
TOKEN=<TOKEN>
curl -s -c /tmp/lg.txt -o /dev/null "http://127.0.0.1:3090/?token=$TOKEN"
curl -s -b /tmp/lg.txt -X POST -H 'content-type: application/json' \
     -d '{"setPassword":{"next":"review-pass-123"}}' \
     "http://127.0.0.1:3090/plugins/dsh-lan-guard/config"
# 免密链接（给评审浏览器用，省掉登录页）：
curl -s -b /tmp/lg.txt "http://127.0.0.1:3090/plugins/dsh-lan-guard/config" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access"]["tokenUrl"])'
```

**门禁页**（登录页 / 配对页）的两种看法：

- 浏览器已持有访客会话时看不到登录页 → 改一次 `auth.mode` 会吊销所有访客会话：
  `-d '{"preferences":{"mode":"password"}}'`，再打开代理地址即可。
- 之后用访问密码登录；`requirePairing: true` 时会接着出现配对页。

## 截图

用 browser-skill（`bsk`）驱动浏览器：本机回环端口对评审浏览器不可达，**必须走局域网地址**
（`http://<网卡IP>:3091/`）。`assets/` 里的四张图是 `1100x723 @1x`：

```sh
bsk session start --json                     # 记下 session_id
bsk emulate --width 1100 --height 723 --dpr 1 --session <id>
bsk navigate "http://<网卡IP>:3091/" --session <id>
# 设置 → 局域网访问 → 逐个 tab
bsk screenshot --session <id> --out assets/settings-access.png
bsk session stop <id>
```

截图前把 `assets/settings-access.png` 里那条访问链接换成示例串（页面上的 `.lg-mono-scroll`），
别把真实 token 提交上去。

## 收尾

```sh
rm -rf .tmp
```

`.tmp` 里的 profile 一删，那条免密 token 就彻底失效了——截图里残留的二维码扫不出任何东西。
