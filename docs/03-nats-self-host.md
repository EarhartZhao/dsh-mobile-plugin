# 自建 NATS 服务：从零到手机可扫码

> 面向想用自己的服务器搭一套 NATS 基础设施来跑 dsh-mobile 的部署者。
> 全文用占位符书写，照抄前先替换：`<hub-host>`（手机能访问的 Hub 地址，公网 IP 或域名）、
> `<hub-user>` / `<hub-pass>`（手机用的 C 端账号）、`<leaf-user>` / `<leaf-pass>`（各台 dsh 电脑的 Leaf 账号）、
> `<instance>`（实例名，只允许 `[a-z0-9-]`，默认 `home`）。
> 作者现有部署的实况与决策记录见 [02-nats-server.md](02-nats-server.md)；本文是可以照抄的通用流程。

## 0. 先读这一节：自建 Hub 能不能被现成的 App 用

**信任来自你扫的那个二维码。** 二维码里除了 Hub 地址与 C 端账号，还带一张 Hub 的 CA 证书；App 在配对时
把它装成「这个地址的信任锚」，之后的握手只认这一张。所以同一个 App 包能连任意自建 Hub，换 Hub、换证书
都不需要重新打包——重扫一次码就等于把信任切过去，这也是轮换时旧 CA 能被真正吊销的原因。

| 你的 Hub | 现成 release App 能连吗 | 怎么做 |
|---|---|---|
| 自建 Hub + 自签 CA，二维码带 CA | 能 | 把 `ca.crt` 全文粘进插件设置卡的「CA 证书」，发码、扫码即可。不需要改 App、不需要重新打包 |
| 自签 CA，但二维码不带 CA | 不能 | 二维码是唯一的信任来源，App 里没有备用 CA。把 `ca.crt` 粘进设置卡后重新发码 |
| 用公共 CA（如 Let's Encrypt）签发证书的 Hub | 能 | CA 字段留空即可，系统信任库会校验 |
| 局域网 stand-in（`ws://` 明文） | 只有 debug 构建能 | 见第 6 节；release 禁明文，这是刻意的安全基线 |

前提是 App 那一侧已经带上运行时锚的能力（原生模块 `DshHubTls`）；更早的 release 包只认内置 CA，
这类设备要么升级 App，要么回到「重新打包」的老路。App **不在包里放任何 CA**：二维码带了证书就用它，
没带（或那台 Hub 是公共 CA 签的）就交给系统信任库，没有第三条兜底路径。

## 1. 拓扑、端口与版本要求

```text
手机（外网）──wss://<hub-host>:8443──► Hub (nats-server, 公网)
                                        ▲ leaf 7422（出站长连接）
                          dsh 电脑上的本机 Leaf (127.0.0.1:4222)
                                        ▲ 插件连接，仅本机
                              deepseek-harness (web profile)
```

| 端口 | 谁用 | 要不要对公网开放 |
|---|---|---|
| 8443 | 手机（`wss`，带 TLS） | 要，这是唯一的手机入口 |
| 7422 | 各台 dsh 电脑的 Leaf 出站接入 | 要；能限制来源 IP 就限制 |
| 4222 | 插件控制台的「测试 Hub 账号」从 dsh 电脑直连校验 | 可选。不开只会让该检查报「无法校验」，不阻断发码 |
| 8222 | 监控（`/varz`、`/leafz`） | 不要，只绑回环或内网 |

版本：`nats-server` 2.10 以上即可（作者现有 Hub 是 v2.14.4，CI 里用的是 2.14.6）。要求 `headers` 可用——这是默认值，
设备 token 走 NATS header 传输，关掉它整套认证就失效。

## 2. Hub：公网服务器上的 nats-server

### 2.1 安装与常驻

```bash
# 单二进制（服务器不能直连 GitHub 时，先在本机下载再 scp 上去）
curl -fsSL -o /tmp/nats.tar.gz https://github.com/nats-io/nats-server/releases/download/v2.14.6/nats-server-v2.14.6-linux-amd64.tar.gz
tar -xzf /tmp/nats.tar.gz -C /tmp
install -m 0755 /tmp/nats-server-v2.14.6-linux-amd64/nats-server /usr/local/bin/nats-server
nats-server --version

# 运行身份与目录
useradd -r -s /usr/sbin/nologin nats
install -d -o nats -g nats -m 750 /etc/nats /etc/nats/tls
```

```ini
# /etc/systemd/system/nats.service
[Unit]
Description=NATS Server
After=network-online.target
Wants=network-online.target

[Service]
User=nats
Group=nats
ExecStart=/usr/local/bin/nats-server -c /etc/nats/hub.conf
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now nats
```

### 2.2 hub.conf 骨架

```hcl
# /etc/nats/hub.conf
server_name: "dsh-hub"
host: 0.0.0.0
port: 4222

# 监控只给本机/内网，绝不对公网开放
http: 127.0.0.1:8222

# 手机（C 端）和 Leaf 都是这里的 user
authorization {
  users = [
    {
      user: <hub-user>, password: <hub-pass>
      permissions = {
        publish   = ["svc.dsh.>", "_INBOX.>"]
        subscribe = ["evt.dsh.>", "_INBOX.>"]
      }
    }
    { user: <leaf-user>, password: <leaf-pass> }
  ]
}

# 每台 dsh 电脑从这里接入；一台一个账号，便于单独吊销
leafnodes {
  port: 7422
}

# 手机入口，证书见 2.3
websocket {
  listen: 0.0.0.0:8443
  tls {
    cert_file: "/etc/nats/tls/server.crt"
    key_file:  "/etc/nats/tls/server.key"
  }
}
```

两点约束：

- C 端账号的 ACL 是**命名空间围墙**：它能 pub `svc.dsh.>`、sub `evt.dsh.>`，反过来一律被拒（第 5 节有验证方法）。
  真正的权限开关是应用层设备 token，NATS 账号不承担设备级隔离。
- 如果你打算用 `../dsh-mobile/scripts/setup-hub.sh` 自动插入账号，`users = [ … ]` 就照本文这种缩进写：
  脚本靠「`authorization {` 之后第一个两空格缩进的 `]`」定位插入点（见 2.4）。

### 2.3 上 TLS：自签私有 CA

在管理机上生成，`ca.key` 永远不要上传服务器：

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 3650 -subj "/CN=dsh-mobile-root-ca" -keyout ca.key -out ca.crt

openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=<hub-host>" -keyout server.key -out server.csr

# 手机拨的是 IP 就写 IP:<hub-host>，拨域名就写 DNS:<hub-host>，两者必须一致
printf "subjectAltName=IP:<hub-host>" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -extfile san.ext -out server.crt
```

```bash
# 上传（证书目录已按 2.1 建好，属主 nats）
scp server.crt server.key root@<hub-host>:/etc/nats/tls/
ssh root@<hub-host> 'chown nats:nats /etc/nats/tls/* && chmod 600 /etc/nats/tls/* && systemctl restart nats'
```

自签 CA 的取舍：零外部依赖、零续期任务；代价是**每个客户端都要显式信任它**——手机端就是被二维码带过去的那张
CA（第 0 节），扫码即完成，不必重新打包。

### 2.4 用脚本一把过（可选）

`setup-hub.sh` 在 dsh-mobile 仓库（[../dsh-mobile/scripts/setup-hub.sh](../dsh-mobile/scripts/setup-hub.sh)），
幂等：装证书 → 追加 websocket 段（已存在则跳过）→ 插入 C 端受限账号 → `nats-server -t` 校验 → 重启 → 握手自检，
最后只打印一次新账号密码。

```bash
scp server.crt server.key setup-hub.sh root@<hub-host>:/root/dsh-mobile-setup/
ssh root@<hub-host> 'bash /root/dsh-mobile-setup/setup-hub.sh'
```

它假定：以 root 运行、配置文件固定 `/etc/nats/hub.conf`、systemd 单元名固定 `nats`、TLS 材料与脚本同目录。
最后一步只做本机握手确认（不带 `-CAfile` 时自签链会报 18/19，属预期），完整链校验用 2.5 的命令。

一处交互要注意：脚本把证书目录设成 `root:root 700`。如果你按 2.1 让服务以 `nats` 用户运行，脚本跑完还要补一句，
否则 `websocket` 监听读不到证书、`nats-server -t` 之外看不出问题：

```bash
ssh root@<hub-host> 'chown -R nats:nats /etc/nats/tls && chmod 600 /etc/nats/tls/* && systemctl restart nats'
```

### 2.5 放行端口与自检

```bash
nats-server -t -c /etc/nats/hub.conf                     # 语法
systemctl restart nats && systemctl is-active nats
curl -s http://127.0.0.1:8222/varz | head -5             # 监控存活
openssl s_client -connect <hub-host>:8443 -CAfile ca.crt </dev/null | grep 'Verify return code'   # 期望 0
```

云厂商安全组 / 防火墙按第 1 节的表放行。密码丢失或要轮换：

```bash
ssh root@<hub-host> 'bash -s show'   < ../dsh-mobile/scripts/hub-credential.sh   # 读回
ssh root@<hub-host> 'bash -s rotate' < ../dsh-mobile/scripts/hub-credential.sh   # 换新随机值
```

`rotate` 会先备份 `hub.conf`、只改那一行、`nats-server -t` 校验，任一步失败原样回滚。

## 3. Leaf：dsh 电脑上的本机节点

```hcl
# 放哪都行，插件按下面的顺序自己找（Windows: C:\nats\leaf.conf，Linux: /etc/nats/leaf.conf）
host: 127.0.0.1        # 本机客户端口没有认证，只监听回环
port: 4222
server_name: "leaf-<instance>"

leafnodes {
  remotes = [
    { url: "nats://<leaf-user>:<leaf-pass>@<hub-host>:7422" }
  ]
}
```

- 先在前台跑一次，日志里出现 `Leafnode connection created` 才算接入成功：
  `nats-server -c C:\nats\leaf.conf`（Linux 用 `nats-server -c /etc/nats/leaf.conf`）。
- 常驻：Windows 用任务计划程序（开机启动 + 失败重启）或 NSSM 注册为服务；Linux 照 2.1 的写法再来一个 systemd 单元。
- 放哪不强制：控制台「启动本地 NATS」在端口没人监听时，按 `NATS_CONFIG_PATH` →「本地 NATS 配置文件」字段 → 自动查找（`$DSH_HOME/mobile-bridge/leaf.conf`、`~/.nats-leaf/leaf.conf`、`~/.config/nats/leaf.conf`，再按平台取 Homebrew 前缀或 `/etc/nats`）定路径；端口已有监听就直接复用，状态行会显示最终选中哪条、是否存在。
- Hub 不可达由 Leaf 负责重试，插件无感知；断外网时本机浏览器与其它本地服务照常工作。

## 4. 插件侧配置

在「插件」页的 `dsh-mobile-plugin` 配置区（或回环控制台 `http://127.0.0.1:3080/mobile-bridge`）填写：

| 字段 | 填什么 | 默认 |
|---|---|---|
| `natsUrl` | 本机 Leaf 地址 | `nats://127.0.0.1:4222` |
| `hubWssUrl` | 手机要连的 `wss://<hub-host>:8443`，经二维码下发给手机；只填主机或 IP、或写 `wss://<hub-host>` 都行，缺端口一律按 8443 补 | 空 |
| `hubUser` / `hubPass` | 上面的 C 端账号；任一为空时拒绝发码 | 空 |
| `hubCaCert` | Hub 的 CA 证书（`ca.crt` 的 PEM 或 base64）；二维码带的就是它——App 不内置任何 CA，自签 Hub 留空必然连不上 | 空 |
| `hubCaFingerprint` | Hub CA 指纹，仅作展示与人工核对 | 空 |
| `instanceId` | 本实例的命名空间；一个 Hub 上多台电脑必须各不相同 | `home` |
| `instanceName` | 这台电脑在手机「连接」列表里显示的名字（`mobile.info` 上报）；留空则回退 `instanceId` | 空 |
| `tokenTtlDays` / `pairCodeTtlSec` / `maxDevices` / `chunkCoalesceMs` | 设备 token 有效期 / 配对码有效期 / 终端上限 / 弱网合帧 | 90 / 120 / 10 / 0 |
| `natsConfigPath` | 「启动本地 NATS」要读的 Leaf 配置路径；留空则自动查找（`$DSH_HOME/mobile-bridge/leaf.conf` → `~/.nats-leaf/leaf.conf` → `~/.config/nats/leaf.conf` → 平台惯例），`NATS_CONFIG_PATH` 可覆盖 | 空 |
| `natsServerPath` | 「启动本地 NATS」要跑的 `nats-server`；留空则自动查找（插件目录 → `~/.nats-leaf/nats-server` → `PATH`），`NATS_SERVER_PATH` 可覆盖 | 空 |
| `autoMigrateProfile` | 安装形态自动修复：早期用 `insert:` 手工挂的 profile 会被改回组合包形态；设 `false` 则插件不碰 profile 文件 | `true` |

配置分层：bundle 自带的 patch 只放非密默认值，控制台「保存」写进的是 profile 自己的 `cordis.patch.yml` 里那条按 id 的覆盖行（宿主 `configEditor` 落盘）；
真正的密文按官方建议走 credentials seam（现状与迁移方向见 [README](../README.md) 的「凭证放哪」一节）。

安装形态（行由组合包提供、profile patch 只留按 id 的覆盖）与旧 `insert:` 写法的自动迁移，见 [README](../README.md) 的「安装与接入」与 [00-plugin-plan](00-plugin-plan.md) 的「安装形态与自动迁移」。

控制台的「启动本地 NATS」按钮先按上面的 `natsUrl` 探测端口：已在监听就直接复用它（手工起的 Leaf、服务管理器起的、上一次 dsh 起的都算，这种情况不需要配置文件），
否则解析出可执行文件与 Leaf 配置再启动 `nats-server -c <config>`。两条路径的优先级都是
`NATS_CONFIG_PATH`/`NATS_SERVER_PATH` 环境变量 → 控制台对应字段 → 自动查找：
配置依次看 `$DSH_HOME/mobile-bridge/leaf.conf`、`~/.nats-leaf/leaf.conf`、`~/.config/nats/leaf.conf`、
平台惯例（macOS 的 Homebrew 前缀、Linux 的 `/etc/nats/leaf.conf`、Windows 的 `C:\nats\leaf.conf`）；
可执行文件依次看 `$DSH_HOME/mobile-bridge/nats-server`、`~/.nats-leaf/nats-server`、
Windows 的 `C:\nats-server\nats-server.exe`，最后是 `PATH` 上的 `nats-server`。
显式设置了就不回退，路径不存在时错误信息会列出查找过的全部候选，控制台状态行也一直显示当前选中的两条路径。

## 5. 验收：按顺序做，坏在哪段一目了然

1. **本机**：控制台状态显示「已连接」。这只说明插件连上了本机 NATS，不代表 Hub 通。
2. **账号与 ACL**：

   ```bash
   cd ../dsh-mobile
   DSH_CEND_PASS=<hub-pass> node scripts/verify-hub-acl.mjs
   ```

   期望：`sub evt.dsh.>` 成功，`sub svc.dsh.>` 与 `pub evt.dsh.>` 各吃一个 Permissions Violation。
   注意该脚本把 Hub 地址写死（`servers:` 那一行，见
   [../dsh-mobile/scripts/verify-hub-acl.mjs](../dsh-mobile/scripts/verify-hub-acl.mjs)），自建 Hub 要先改这一行。
3. **整条链路**：控制台点「测试 Hub 账号」，逐段看结论：

   | 段 | 含义 | 失败表现 |
   |---|---|---|
   | `local` | 桥 → 本机 NATS | 手机扫码连不上宿主 |
   | `credentials` | 本机 → Hub（从 WSS 主机名的 4222 明文口校验） | 密码错：发码被直接拒绝；端口不通：只警告 |
   | `hub-path` | Hub → 本机实例（Leaf 是否桥到 Hub） | 手机扫码拿到 `503` |
   | `certificate` | 二维码要带的 CA ↔ Hub 在 8443 上实际出示的证书 | 手机卡在 TLS 握手，报「无法连接公网 NATS」 |

   `rejected` 会拦住发码，`unreachable` 与 `bridge-offline` 只警告——Leaf 会自行重连，配对码 120 秒内都还有救。
   `certificate` 段里只有 `unreachable`（8443 从本机连不上）算警告；其余都判失败，因为它们意味着手机一定连不上。
4. **手机端**：扫码 → 进会话列表 → 发一条 prompt 拿到流式回复；再杀一次 Hub（或拔网线 30 秒）验证自动重连，
   期间本机浏览器不受影响。

## 6. 没有公网服务器：局域网 stand-in

```bash
# 在 dsh-mobile 仓库里
nats-server -c scripts/local-hub-standin.conf
```

它开 `4222`（插件连）与 `ws:8443`（无 TLS、无认证，仅局域网实验用）。二维码里的 `hub` 填 `ws://<局域网IP>:8443`
（Android 模拟器用 `10.0.2.2`）。限制：只有 debug 构建能走明文，release 的 `cleartextTrafficPermitted="false"` 会直接拒绝——
这是刻意的，见 [../dsh-mobile/docs/01-tech-stack.md](../dsh-mobile/docs/01-tech-stack.md) 的「传输策略」一节。

## 7. 常见故障

| 症状 | 环节 | 处置 |
|---|---|---|
| 手机报 `Authorization Violation` | C 端账号密码与 Hub 不一致 | `hub-credential.sh show` 读回真值，更新插件配置后重新发码（旧二维码里的密码不会自动更新） |
| 手机报 `503` | Hub → 本机实例没有响应者 | Leaf 没桥到 Hub：看 Leaf 日志有没有 `Leafnode connection created`、`leaf.conf` 的 remotes、7422 是否放行、Leaf 账号是否在 Hub 上 |
| 控制台「未连接」 | 桥 → 本机 NATS | 点「启动本地 NATS」，确认 `natsUrl` 与 `leaf.conf` 的 port 一致、`NATS_CONFIG_PATH` 指向的文件存在 |
| 手机 `wss` 握手失败或证书错误 | TLS | SAN 与手机拨的地址不一致（IP 写成域名或反之）、二维码没带这张 CA（把 Hub 的 `ca.crt` 粘进插件设置）、8443 未放行、证书过期 |
| 手机报「无法连接公网 NATS」但账号密码都对 | Hub 地址写法 | 地址漏了端口：`wss://<hub-host>` 会被 URL 规范补成 443。插件 0.2.21 起自动补 8443，更早的版本要手写 `wss://<hub-host>:8443` |
| 「测试 Hub 账号」的 `certificate` 段报证书不是公共 CA 签的 | 二维码不带 CA | 把 Hub 的 `ca.crt` 粘进插件设置里的 CA 字段并保存，再点「生成配对二维码」 |
| 「测试 Hub 账号」报无法通过 `nats://<hub-host>:4222` | 4222 不通 | 放行该端口或忽略：手机走 8443，此检查失败不阻断发码 |
| `nats-server -t` 通过但服务起不来 | 权限 | 跑 nats 的用户要能读 `/etc/nats/tls/*`（属主与权限按 2.1、2.3 设置） |
| 换了 Hub 地址或账号 | 迁移 | 更新插件配置并重新发码；设备 token 是应用层的、本身不受影响，但手机必须重新扫码，因为 NATS 凭证来自二维码 |

## 8. 安全与轮换

四层各管一段，轮换互不牵连：

| 凭证 | 位置 | 轮换 |
|---|---|---|
| 根 CA `ca.key` | 离线保管，任何在线设备都没有 | 泄露即换 CA、重签服务器证书、重打 App、吊销全部设备 token |
| 服务器证书 | Hub `/etc/nats/tls/`，0600 | 到期前用同一 CA 重签换上，手机无感知 |
| C 端账号 | Hub `hub.conf`，经二维码分发 | `hub-credential.sh rotate`，之后更新插件配置并重新发码 |
| 设备 token | 手机安全存储；插件侧只存哈希 | 控制台「设备」页吊销，即时生效 |

两条硬约束：`ca.key` 与 `hub.conf` 都不要进版本库；`hubPass` 是 `role('secret')` 字段，只在回环控制台按需回显，
非本机请求只能拿到「是否已配置」。

## 附：脚本与文件索引

| 文件 | 位置 | 用途 |
|---|---|---|
| `docs/02-nats-server.md` | 本仓库 | 现有部署的增量改动清单与决策记录 |
| `docs/03-nats-self-host.md` | 本仓库 | 本文 |
| `scripts/setup-hub.sh` | dsh-mobile | Hub 侧幂等安装（证书、websocket 段、C 端账号） |
| `scripts/hub-credential.sh` | dsh-mobile | 读回 / 轮换 C 端密码 |
| `scripts/verify-hub-acl.mjs` | dsh-mobile | ACL 反向验证（Hub 地址写死，自建需改） |
| `scripts/local-hub-standin.conf` | dsh-mobile | 局域网 stand-in（4222 + ws:8443 无 TLS） |
| `src/config.ts` | 本仓库 | 插件配置字段与默认值 |
| `src/hub-check.ts` | 本仓库 | 三段链路检查 |
| `src/nats-launch.ts`、`src/index.ts` | 本仓库 | 「启动本地 NATS」的端口探测与进程启动 |
