# 把新电脑接上去：一份交给 AI 的清单

这台电脑还没有本机 NATS 时，「启动本地 NATS」按钮什么也做不了——它只能启动一个**已经装在机器上**的
`nats-server`，配上**一份已经写好的** `leaf.conf`。本文就是补上那两样东西的执行清单。

它是**写给 AI 助手读的**（Codex、Claude Code 这类能在这台电脑上跑命令的助手）：把这整页丢给它，
让它照着做完并把结果回报给你。人也可以照做——每一步都写了判定标准，做完自己看一眼就知道成没成。

成功标准只有一个，别用别的东西代替：

1. 打开控制台 `http://127.0.0.1:3080/mobile-bridge`，「启动本地 NATS」之后状态显示**已连接**；
2. 「测试 Hub 账号」的 `local` / `credentials` / `hub-path` / `certificate` 四段都不是 ✗；
3. 手机扫码能进会话列表，发一条 prompt 能拿到流式回复。

本文只管「Hub 已经有人搭好了，把这台电脑接上去」。**Hub 还不存在**（没有服务器、没有 NATS、没有 CA）
是另一件事，从 [03-nats-self-host.md](03-nats-self-host.md) 的 §2 开始做——做完再回到这里。

## 0. 先要三样东西，然后再动手

这几样都在 Hub 管理员手里（就是搭那台 NATS 服务器的人）。一台机器上缺哪样都装不完，
所以**先开口要，别靠猜**：

| 要什么 | 长什么样 | 干什么用 | 备注 |
|---|---|---|---|
| Hub 地址 | `wss://203.0.113.10:8443` | 二维码带它给手机，本机也用它自检 | 只填主机或 IP 也行，缺端口按 8443 补 |
| C 端账号 + 密码 | 一组 username / password | 手机经二维码用它连 Hub | 手机侧唯一凭证，必须是那个配了 `svc.dsh.>` / `evt.dsh.>` ACL 的账号 |
| Leaf 账号 + 密码 | 另一组 username / password | 这台电脑的 Leaf 用它接进 Hub 的 7422 | 一台电脑一个，便于单独吊销；别和 C 端那组混用 |
| Hub 的 `ca.crt` | PEM 文本（`-----BEGIN CERTIFICATE-----` 起） | 二维码带给手机的信任锚 | Hub 用公共 CA 签发的可以跳过，自签 Hub 才有 |

- `ca.crt` 是**公开材料**，随二维码分发，向对方要一份没有任何风险。
- 与之相对的 `ca.key`（签发 Hub 证书的私钥）**永远不该在在线机器上出现**：不要向用户索要它，
  不要把它拷到 Hub，也不要写进任何配置文件。
- 密码不要写进仓库、文档与提交信息；示例地址一律用 RFC 5737 文档地址段（`203.0.113.0/24`）。

## 1. 先量一遍这台电脑缺什么

动手之前先看清现状，比改完再猜哪里不对便宜得多：

```bash
# 宿主在跑吗、插件挂上了吗（404 = 没启用，见根目录 README 的「装完必须启用」）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/mobile-bridge
# 本机有 nats-server 吗
nats-server -v
# 插件自己找到了哪两条路径：看控制台页面上那两行
```

| 现象 | 缺什么 | 去哪一节 |
|---|---|---|
| `dsh web` 没起，或 `/mobile-bridge` 返回 404 | 宿主没跑 / 插件没装没启用 | 根目录 [README](../README.md) 的「快速开始」「安装」 |
| 控制台显示 `✗ nats-server：…（自动查找）` | 本机没装 `nats-server` | §2 |
| 控制台显示 `✗ 配置文件：…（自动查找）` | 还没有 `leaf.conf` | §3 |
| 两条都是 `✓`，状态却还是「未连接」 | 端口或配置对不上 | §3 末尾的对照表 |

## 2. 装 nats-server

三条路选一条，判定标准都是 `nats-server -v` 能打印版本（2.x 即可，2.14 这条线最稳）。

**macOS**

```bash
brew install nats-server && nats-server -v
```

没有 Homebrew、或想和本项目其它机器保持一致（二进制与配置同放 `~/.nats-leaf/`，插件自动查找的第二顺位）：

```bash
mkdir -p ~/.nats-leaf && cd ~/.nats-leaf
curl -fsSL -o nats.tar.gz https://github.com/nats-io/nats-server/releases/download/v2.14.6/nats-server-v2.14.6-darwin-arm64.tar.gz
tar -xzf nats.tar.gz --strip-components=1 nats-server-v2.14.6-darwin-arm64/nats-server
./nats-server -v     # Intel Mac 把上面的 darwin-arm64 换成 darwin-amd64
```

**Linux**

只给这台机器自己当 Leaf 用，不需要 root：把上面那段换成 `linux-amd64` 的资产，解到 `~/.nats-leaf/`。
要让 `systemctl` 管（Hub 那种做法），按 [03-nats-self-host.md](03-nats-self-host.md) 的 §2.1 装到
`/usr/local/bin/nats-server` 并写单元文件。

**Windows**

从 [nats-io/nats-server releases](https://github.com/nats-io/nats-server/releases) 下 zip，解到
`C:\nats-server\`（插件的自动查找认得这个路径），或把 `nats-server.exe` 放进 `PATH` 上的任意目录。
新开一个终端跑 `nats-server -v` 验证。

## 3. 写这台电脑的 leaf.conf

`leaf.conf` 描述「本机开一个客户端口，并主动接进 Hub」：

```hcl
# ~/.dsh/mobile-bridge/leaf.conf
host: 127.0.0.1        # 本机客户端口不做认证，只监听回环，别改成 0.0.0.0
port: 4222
server_name: "leaf-<这台电脑的实例 ID>"

leafnodes {
  remotes = [
    { url: "nats://<leaf-user>:<leaf-pass>@<hub-host>:7422" }
  ]
}
```

- 三个占位符换成 §0 要来的值；`<leaf-user>` / `<leaf-pass>` 是**这台电脑专用**的那组。
- `port` 要和插件里的 `natsUrl` 对得上（默认 `nats://127.0.0.1:4222`；两边一致就不用改任何配置）。
- 密码里有 `@`、`/`、`:` 这类字符时按 URL 规则做百分号转义，否则会被当成地址的一部分。

**放哪**：控制台「本地 NATS 配置文件」字段留空时，插件按这个顺序找第一份存在的文件——
`$DSH_HOME/mobile-bridge/leaf.conf` → `~/.nats-leaf/leaf.conf` → `~/.config/nats/leaf.conf` →
平台惯例（macOS 的 Homebrew 前缀、Linux 的 `/etc/nats/leaf.conf`、Windows 的 `C:\nats\leaf.conf`）。
`$DSH_HOME` 默认是 `~/.dsh`；写第一顺位那条最省事，什么都不用再配。

**判定**：先在前台跑一次，日志里出现 `Leafnode connection created` 才算接上（这一次也会顺手把 Hub 验了）：

```bash
nats-server -c ~/.dsh/mobile-bridge/leaf.conf
```

| 日志里看到 | 结论 | 处置 |
|---|---|---|
| `Leafnode connection created` | Leaf 已接进 Hub | 继续 §4 或 §5 |
| `Authorization Violation` | Leaf 账号密码不对 | 找 Hub 管理员核对那组 Leaf 凭证 |
| 连接被拒 / 超时 / `no responders` | 7422 不通或地址写错 | 核对 `<hub-host>`，让 Hub 侧放行 7422（云主机还要看安全组） |
| 域名解析失败 | `<hub-host>` 不是可解析的名字 | 换成 IP，或确认这台机器的 DNS |
| `TLS required` 之类 | Hub 的 leafnodes 要求 TLS，本机没配 | 两侧要么都开 TLS 要么都不开，见 [03](03-nats-self-host.md) 的 §2.2 |

## 4. 让 Leaf 常驻（可选，但推荐）

不做也能用：控制台那个按钮会在没人在监听时现场起一个。做了的好处是**重启电脑后不用等人点按钮**。

**macOS**（launchd，文件放 `~/Library/LaunchAgents/com.dshmobile.nats-leaf.plist`，路径按实际情况改）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dshmobile.nats-leaf</string>
  <key>ProgramArguments</key><array>
    <string>/Users/&lt;你&gt;/.nats-leaf/nats-server</string>
    <string>-c</string><string>/Users/&lt;你&gt;/.dsh/mobile-bridge/leaf.conf</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/nats-leaf.log</string>
  <key>StandardErrorPath</key><string>/tmp/nats-leaf.log</string>
</dict></plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/com.dshmobile.nats-leaf.plist
```

**Linux**：照 [03](03-nats-self-host.md) 的 §2.1 再写一个 systemd 单元，把 `ExecStart` 换成
`/usr/local/bin/nats-server -c <leaf.conf>`。
**Windows**：用任务计划程序（开机启动 + 失败重启）或 NSSM 注册成服务。

判定：端口连得上，或控制台状态变「已连接」（`nc -z 127.0.0.1 4222` / PowerShell 里
`Test-NetConnection 127.0.0.1 -Port 4222`）。

## 5. 在插件里接上 Hub

打开控制台 `http://127.0.0.1:3080/mobile-bridge`，按顺序做——顺序不能颠倒，二维码里带的就是这里配的凭证。
页面最上面就是**开箱清单**（1 填 Hub 凭证 → 2 拿 CA 证书 → 3 启动本机 NATS → 4 手机扫码），做完一步打一个勾、并汇总还差哪几项；
下面的四个面板与清单一一对应，「去填写 / 去获取 / 去启动 / 去配对」直接跳到对应控件：

| # | 做什么 | 判定 |
|---|---|---|
| 1 | 在「1. 连接 Hub」里填 Hub 地址与 C 端账号密码 | 三项都有值；开箱清单第 1 条打勾 |
| 2 | 在同一面板的「Hub CA 证书」里点「从 Hub 获取 CA」，或把管理员给的 `ca.crt` 粘进去（这一步不必先保存：按钮按你此刻填在「Hub 地址」里的地址取证书——dsh 插件页里的面板和独立控制台走同一条路，两者都是按框里的值取） | 显示指纹与主体——成功就说明拿到了真正的信任锚（Hub 用公共 CA 签发的证书时可跳过，清单那条保持灰色即可） |
| — | 需要时在「实例与身份（一般不用改）」里填本机名称；**实例 ID 不用管**（这次安装第一次启动就自动生成一个 8 位 ID，升级、重装都不变，控制台里只读展示），只有同一台机器上多个 dsh 实例共用同一份检出时才需要在 profile 里手写 | 实例 ID 那行显示 `(8 位 ID)（本次安装自动生成）` |
| 3 | 点「保存并测试」 | 字段不再被清空 |
| 4 | 在「2. 本机 NATS（Leaf）」里点「启动本地 NATS」（Leaf 已被服务管理器管着时会直接复用） | 状态行变「正在运行」、顶部状态变「已连接」 |
| 5 | 点右上角「测试连接」（即「测试 Hub 账号」） | 四段（`local` / `credentials` / `hub-path` / `certificate`）都不是 ✗ |
| 6 | 在「3. 配对新设备」里点「生成配对二维码」，用手机 App 扫 | 进会话列表，发一条 prompt 有流式回复 |

## 6. 出问题时的对照表

只列这台电脑上会撞到的；Hub 侧的更多故障见 [03](03-nats-self-host.md) 的 §7。

| 症状 | 环节 | 先做什么 |
|---|---|---|
| 点「启动本地 NATS」报找不到 `nats-server` 或配置文件 | 本机 NATS | 回到 §2、§3；控制台状态行会列出查找过的全部候选路径 |
| 状态一直「未连接」 | 桥 → 本机 NATS | 确认 `natsUrl` 的端口与 `leaf.conf` 的 `port` 一致 |
| 「测试 Hub 账号」的 `hub-path` 段报 `503` / `bridge-offline` | Hub → 本机实例 | Leaf 没桥到 Hub：看 Leaf 日志有没有 `Leafnode connection created`、7422 是否放行、Leaf 账号在 Hub 上存不存在 |
| 同一处 `credentials` 段报 `rejected` | 本机 → Hub | C 端账号密码不对，找 Hub 管理员读回真值 |
| 手机卡在 TLS 握手 / 报「无法连接公网 NATS」 | 二维码里的 CA | 重新点「从 Hub 获取 CA」或粘 `ca.crt`，保存后**重新发码**（旧二维码里的证书不会自动更新） |
| 手机报 `Authorization Violation` | 手机 → Hub | 同上：二维码里的 C 端凭证与 Hub 不一致，改完要重发码 |
| 升级插件后功能没变 | 换包没生效 | 重启 dsh；控制台「插件版本」旁边的红字会写明「磁盘上已装 X，当前运行的是 Y」 |
| 重装插件后版本号还是旧的 | npm 装法撞上 pnpm 的发布年龄门禁 | pnpm 11 默认 `minimumReleaseAge`（24 小时）：当天新发的版本会被跳过，裸包名会落到窗口外的旧版本。把整包名 `'@dsh-earhartzhao/dsh-mobile-plugin'` 写进 profile 的 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`，并用 `pnpm add <包名>@latest` 或钉死版本号重装；只改白名单不重算 lockfile 不会换版本。详见 [README](../README.md) 的「方式 A」 |

## 7. 给 AI 的硬约束

这几条都是踩过的坑，别省：

- **不要**把真实 Hub 地址、账号、密码写进任何仓库文件、文档或提交信息；示例一律用文档地址段。
- **不要**碰 `ca.key`：它不该出现在这台机器上，更不该被拷到 Hub。
- 改 Hub 上的文件前先 `cp -p` 备份，并**就地**改——新建文件是 root 属主，而以 `nats` 用户运行的服务
  读不到它时，只是那一段端口静默起不来。
- 重写文件的命令里**输出不能指向输入**：`cat server.crt ca.crt > server.crt` 会在 `cat` 读到之前先把
  `server.crt` 清空。先把来源另存一份（`cp -p server.crt server.leaf.crt`）再拼。

做完把「改了哪些文件 / 每一步的验证输出 / 还差什么」回报给用户。只回一句「已配置好」等于没做。

## 附：路径与命令速查

| 东西 | 位置或顺序 |
|---|---|
| 控制台 | `http://127.0.0.1:3080/mobile-bridge` |
| `leaf.conf` 自动查找 | `$DSH_HOME/mobile-bridge/leaf.conf` → `~/.nats-leaf/leaf.conf` → `~/.config/nats/leaf.conf` → macOS Homebrew 前缀 / Linux `/etc/nats/leaf.conf` / Windows `C:\nats\leaf.conf` |
| `nats-server` 自动查找 | `$DSH_HOME/mobile-bridge/nats-server` → `~/.nats-leaf/nats-server` → (Windows `C:\nats-server\nats-server.exe`) → `PATH` |
| 覆盖查找 | 环境变量 `NATS_CONFIG_PATH` / `NATS_SERVER_PATH`，或控制台「本地 NATS 配置文件」/「nats-server 路径」字段（显式设置后不再回退） |
| 前台试跑 | `nats-server -c <leaf.conf>`，看 `Leafnode connection created` |
| 本机端口 | `nats://127.0.0.1:4222`（要与插件 `natsUrl` 一致） |
| Hub 从零搭 | [03-nats-self-host.md](03-nats-self-host.md) |
| 复用既有 Hub 的改动清单 | [02-nats-server.md](02-nats-server.md) |
