# NATS 设施改动清单（复用既有 Hub）

> 想从零自建一套 NATS（Hub + Leaf）请看 [03-nats-self-host.md](03-nats-self-host.md)；
> 本文是现有部署的**增量改动清单**与决策记录。
>
> 决策记录（2026-08-25）：不新建 NATS 服务器，复用已上线的 Hub（见
> distributed-knowledge-architecture.md）。本文列出为接入 dsh-mobile 所需的**增量改动**。
> 下文用 `<hub-host>` 指代 Hub 地址、`<account>` 指代 dsh 专用的 C 端受限账号，照抄时替换成自己的值；
> 示例地址一律用 RFC 5737 文档地址段（`203.0.113.0/24`）。具体部署的地址与账号只留在部署机上，不进本仓库。
>
> Hub 实测（2026-08-25，从本机）：4222 / 7422 端口可达；`nats-hub` v2.14.4；
> `auth_required: true`；`headers: true`（设备 token 走 NATS headers 的前提成立）；
> `max_payload: 1 MiB`（确认不传大文件）；8443 未开放（websocket 未启用，需本次追加）。

## 一、Hub 侧改动（唯一的服务端改动）

目的：让手机能用 `nats.ws` 经 **wss** 接入。现状 Hub 只有明文 4222（客户端）和 7422（Leaf），手机不能走明文。

### 1. 生成私有 CA 与服务器证书（一次性）

不使用域名，因此公共 CA 路径只剩 Let's Encrypt 短寿命 IP 证书（shortlived profile，160 小时有效期，自动续期依赖重）。**决策：自建私有 CA**——零外部依赖、零续期 treadmill，且安全性更强：App 只信任我们自己的 CA，任何公共 CA 签的证书对我们的连接都无效。

```bash
# 根 CA（离线保管私钥，10 年有效）
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -days 3650 -subj "/CN=dsh-mobile-root-ca" \
  -keyout ca.key -out ca.crt

# 服务器证书（SAN 必须是 IP，825 天——主流客户端对服务端证书的最长接受期）
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=<hub-host>" -keyout server.key -out server.csr

# 拨 IP 写 IP:<hub-host>，拨域名写 DNS:<hub-host>
printf "subjectAltName=IP:<hub-host>" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -extfile san.ext -out server.crt
```

- `ca.key`：**离线保管**（密码管理器/加密盘），它是整个信任体系的根，绝不放服务器。
- `server.crt` + `server.key`：放服务器 `/etc/nats/tls/`，权限 0600。
- `ca.crt`：打进 App 构建（见第四节），也存一份备份。

### 1.1 密钥泄露后的轮换与作废（2026-09-30）

> 事故记录：`certs/ca.key` 与 `certs/server.key` 曾在 dsh-mobile 的 `1c7930b`
> 提交里入库，`3fc2171` 只把它们从 HEAD 删掉。仓库 `EarhartZhao/dsh-mobile`
> 是公开的，因此这两把私钥在 git 历史里长期可见，且泄漏的正是当前生产用的
> 那一对（`ca.key` 的公钥与 `certs/ca.crt` 一致，指纹就是 App 里 pin 的
> `caFp`）。**结论：必须轮换。**

**为什么严重**：App 的两端 pinning（Android `network_security_config.xml`、
iOS `SRSecurityPolicy`）锚的都是这把 CA，不是叶子证书。拿到 `ca.key` 的人可以
为任意地址现签一张服务器证书，让 App 照单全收；拿到 `server.key` 的人只要占住
到 Hub 的链路，就能冒充 Hub 完成握手，把手机的设备 token（`x-dsh-token`）骗过去。
注意它**不影响** 4222 与 7422——那两条是明文，靠账号/ACL，与这对密钥无关。

**一键轮换**（`dsh-mobile/scripts/rotate-hub-tls.sh`，在管理机上跑）：

```bash
# 1. 生成新 CA + 新服务器证书（含 extendedKeyUsage=serverAuth），私钥写到仓库外
dsh-mobile/scripts/rotate-hub-tls.sh

# 2. 按脚本打印的命令把 server.crt/server.key 装到 Hub 的 /etc/nats/tls/ 并重启
#    3. 用 openssl s_client -CAfile <新的 ca.crt> 验证链
# 4. Hub 已经在用新证书之后，再更新仓库里被 pin 的公开 CA：
dsh-mobile/scripts/rotate-hub-tls.sh --apply

# 5. 把新的 ca.crt 粘进插件设置卡，手机重扫二维码（见下）
```

顺带修好了老证书缺 `extendedKeyUsage=serverAuth` 的问题：补上之后 Apple 的
SSL 策略直接走严格路径，iOS 不再需要 01-tech-stack 里描述的那条回退分支。

实测（2026-09-30）：线上 Hub 115.159.57.137 换成新 CA 签的服务器证书后，
`openssl s_client -CAfile <新 ca.crt>` 返回 `Verify return code: 0 (ok)`，用旧
（泄露的）`ca.crt` 校验返回 `21 (unable to verify the first certificate)`；
带上新 CA 的设备直连线上 Hub 时 iOS 侧打印 `[dsh-tls] 115.159.57.137 pinned=1`。

**怎么"作废"这两把密钥**——这套体系里没有 CRL/OCSP，两端 pinning 只看链和锚，
所以"吊销"不是发一条吊销记录，而是三步：

| 要作废的东西 | 怎么做 | 生效条件 |
|---|---|---|
| `server.key`（Hub 服务器私钥） | 换新 key + 新证书，替换 `/etc/nats/tls/` 后重启 nats | Hub 不再出示旧证书 |
| `ca.key`（根 CA 私钥） | 换 CA + 重签服务器证书；二维码会带上新 CA，App 配对时把它装成该 Hub 的信任锚 | 每台手机重扫一次码即完成切换 |
| 旧 CA 签出的任何证书 | 同上；没重扫的设备仍留着旧锚，连不上就说明它需要重扫 | 直至设备重扫（或换新包） |

也正因为如此，**只换 `server.crt` 而不换 CA 是无效的**：拿到 `ca.key` 的人随时
能再签一张新的服务器证书。

值得强调的是**重扫不等于重新打包**：App 信任的是"这个地址的锚"，锚来自二维码，
App 包里不带任何 CA，所以换 CA 的代价从"所有人重装 App"降到"所有人重扫一次码"，
作废的根也不会在别处残留。（App 侧运行时锚之前的旧包仍认包内 CA，那些设备必须升级 App。）

> 老包（原生模块 `DshHubTls` 之前构建的）读不懂二维码里的 CA，只能靠重打 App。

**清理 git 历史**（密钥已公开，清理是卫生而不是安全，安全靠上面的轮换）：

```bash
git clone --mirror https://github.com/EarhartZhao/dsh-mobile.git harden-history.git
cd harden-history.git
git filter-repo --invert-paths --path certs/ca.key --path certs/server.key --force
git remote add origin https://github.com/EarhartZhao/dsh-mobile.git
git push --force origin 'refs/heads/*:refs/heads/*'
git push --force origin 'refs/tags/*:refs/tags/*' || true
```

- 该仓库目前 **0 个 fork**，所以没有需要一并处理的副本；仍有 fork 的话它们会保留旧历史。
- 强推后旧提交不可达，但 GitHub 侧的对象要等 GC；需要立刻消除可考虑联系 GitHub Support。
- 历史哈希会全部重写，本地克隆要重新拉取。

**已执行（2026-09-30）**，实测记录：

| 项 | 值 |
|---|---|
| 重写前 | `dev f1ceabd` / `master 8098e49` / `v0.0.8 b3cf940` |
| 重写后 | `dev 5a4ce7f` / `master 6a7f18b` / `v0.0.8 38717ac` |
| 全历史差异 | 只少了 `certs/ca.key`、`certs/server.key` 两个 blob 及其目录树；其余 1485 条对象逐字节一致 |
| 扫描结果 | 全历史只有这两个私钥对象，没有 `.env`、没有 `cordis.patch.yml`、没有高熵密码；兄弟仓库 dsh-mobile-plugin 全历史 0 个私钥 |

两个坑记一下：

1. **GitHub 仍允许按 SHA 取到旧对象。** 强推后重新克隆确认 ref 已干净，但
   `git fetch origin 53115f99…`（旧的 `certs/ca.key` blob）依然成功——GitHub 的对象库要等 GC，
   在此之前知道 SHA 的人仍能取回。密钥已经轮换作废，取回也没用；要立刻消除只能开
   GitHub Support 工单（该仓库 0 fork，也可以考虑删库重建，代价是 issue/star 全丢）。
2. **本地克隆要对齐**，否则要么推不上去、要么把旧历史推回去。做法：`git fetch --prune --tags --force`，
   然后 `git reset --soft origin/dev`（保住未提交的改动），本地 `master` 跟到 `origin/master`，
   最后 `git reflog expire --expire=now --all && git gc --prune=now` 把 reflog 里兜着的旧对象也清掉。
   本地标签若指向旧历史（本例 `v0.0.2/3/4` 未推到远端），要用 `filter-repo` 留下的
   `.git/filter-repo/commit-map` 把它们重新指向重写后的提交，否则它们会继续把旧对象留在本地。

**同时轮换凭证**：冒充期间手机可能把设备 token 交给了对方。

```bash
# 轮换 Hub 账号密码（'show' 读回，'rotate' 换新；记得同步插件设置卡）
ssh root@<hub-host> 'bash -s rotate' < dsh-mobile/scripts/hub-credential.sh
```

再到插件设置卡 → 已配对设备 → 逐个**吊销**（对应控制台 `/mobile-bridge/api/revoke`），
然后让手机重新扫码配对。

**防复发**：`certs/**/*.key`、`certs/**/*.pem`、`certs/**/*.srl` 已加入
`dsh-mobile/.gitignore`；`ca.key` 按上文本来就不该出现在任何在线设备上；建议给两个
仓库开 GitHub secret scanning + push protection，CI 里加一道 gitleaks。

### 2. nats-server 开 websocket + 原生 TLS（不需要 Caddy）

编辑 `/etc/nats/hub.conf` 追加：

```hcl
websocket {
    listen: 0.0.0.0:8443
    tls {
        cert_file: "/etc/nats/tls/server.crt"
        key_file:  "/etc/nats/tls/server.key"
    }
}
```

手机只连 `wss://<hub-host>:8443`。没有 Caddy、没有域名、没有证书续期任务——服务端证书到期前（约 2 年）用同一 CA 重签一张换上即可，App 无感知。

> 备选（如未来想要"零 App 侧配置"）：Let's Encrypt shortlived profile 支持 IP 证书（2026-08 核实），但 160 小时有效期意味着续期自动化必须绝对可靠，且 ACME 客户端对 RFC 8738 IP 标识的支持参差。个人部署不值得。

### 3. 追加 dsh 专用 C 端账号（可选但推荐）

现有 `c-end-1/2` 权限（pub `svc.>`、sub `evt.>`）与手机需求精确吻合，可直接复用；但独立账号便于单独吊销、不影响其他 C 端：

```hcl
{
  user: <account>, password: <32位随机>
  permissions = {
    publish = ["svc.dsh.>", "_INBOX.>"]
    subscribe = ["evt.dsh.>", "_INBOX.>"]
  }
}
```

改完 `systemctl restart nats`。

### 密码丢了怎么办

`setup-hub.sh` 只在创建时打印一次密码（`openssl rand -hex 16`，32 位十六进制），之后不再回显；它存在的唯一位置是 Hub 上的 `/etc/nats/hub.conf`。用 `../dsh-mobile/scripts/hub-credential.sh` 在 Hub 上读回或轮换（这两个脚本都在 dsh-mobile 仓库，不在本仓库）：

```bash
ssh root@<hub-host> 'bash -s show'   < ../dsh-mobile/scripts/hub-credential.sh   # 读回当前密码
ssh root@<hub-host> 'bash -s rotate' < ../dsh-mobile/scripts/hub-credential.sh   # 换成新随机密码
```

`rotate` 会先备份 `hub.conf`、只改那一个账号行、用 `nats-server -t` 校验，任何一步失败都原样回滚。轮换不打断已有配对：App 不内置该凭证（经二维码下发），Leaf 用的是独立账号（`leaf-a`），设备持有的是应用层 token。但要记得两件事：把新值填进插件设置卡，并让手机**重新扫一次码**——手机里的 NATS 凭证来自配对时的二维码，不会自动更新。

> **单用户多终端**（2026-08-26 确认）：只有一个用户，所有终端共用这一个 C 端账号，无需按机主/实例拆分账号。终端粒度的管理在应用层设备 token（见 01-auth-pairing.md）。账号不打进 App——经配对二维码传递。

### 4. 安全组

- 放行 **8443**（wss，手机入口）。
- **不放行** 8222；4222/7422 维持现状（Leaf 与其他本地电脑仍需要）。
- 既有 TODO（leaf 7422 启用 TLS）不受本项目阻塞，但建议一并做。

## 二、dsh 电脑侧：部署 Leaf 节点

沿用 Hub 文档第 4.5 节的既有模式（以分配到的 leaf 账号为例，如 leaf-c）：

1. 安装 nats-server 单二进制（Windows：GitHub Releases 下载；注意该服务器不可直连 GitHub 的约束只影响服务器侧）。
2. `C:\nats\leaf.conf`：

```hcl
host: 127.0.0.1        # 本机客户端口没有认证，只监听回环
port: 4222
server_name: "leaf-<instance>"

leafnodes {
  remotes = [
    { url: "nats://leaf-c:<密码>@<hub-host>:7422" }
  ]
}
```

通用写法与 Linux 侧的写法见 [03-nats-self-host.md](03-nats-self-host.md) 第 3 节。

3. 常驻运行（Windows：任务计划程序 / NSSM 注册为服务），日志出现 `Leafnode connection created` 即接入成功。
4. 插件连接 `nats://127.0.0.1:4222`（本机无认证），Hub 不可达时 Leaf 自动重试，插件无感知。

## 三、验收清单

- [ ] 服务器上 `openssl s_client -connect <hub-host>:8443 -CAfile ca.crt` 校验通过，且**不带** `-CAfile` 时校验失败（确认不是公共 CA 签的）。
- [ ] 手机网络（关 WiFi 用蜂窝）下 App 内 `nats.ws` 连 `wss://<hub-host>:8443` 用该账号能连上。
- [ ] 该账号 sub `svc.dsh.>` 被拒、pub `evt.dsh.>` 被拒（ACL 生效）。
- [ ] dsh 电脑 Leaf 日志显示已连 Hub；服务器上 `curl http://127.0.0.1:8222/leafz` 能看到该 Leaf。
- [ ] 拔掉 dsh 电脑外网 2 分钟再恢复，Leaf 自动重连，期间本机 `nats sub`/`pub` 不受影响。
- [ ] Hub 重启后 Leaf 与手机均自动重连。

## 四、App 侧信任配置与凭证分发

### Android / iOS：私有 CA 不再打进构建

**这段已经不存在了**（2026-09-30 移除）：`network_security_config.xml` 现在只剩
`<base-config cleartextTrafficPermitted="false" />`，工程里的 `res/raw/dsh_root_ca.crt` 也已删除。
原因见 [03-nats-self-host.md](03-nats-self-host.md) 第 0 节：信任只来自二维码，App 不带自己的 CA。
RN 的 WebSocket 走 OkHttp，私有 CA 的校验由 `HubTlsTrust`（原生模块 `DshHubTls`）在
配对时安装的信任管理器完成；其它任何站点仍走系统公共 CA，私有 CA 不扩大系统攻击面。

### iOS

iOS 没有 `network_security_config.xml` 的等价物，原先靠 `SRSecurityPolicy` 锚定包内的
`dsh_root_ca.crt`；现在两端的锚都换成二维码带来的那张证书（`DshHubTlsModule.mm` 存储、
`DshWebSocketSecurity.mm` 校验），包内证书与 `resources/` 条目已一并删除。
（鸿蒙端已明确不做，2026-08-26。）

### 轮换策略

- 服务器证书（~2 年）：用同一 CA 重签换上，`systemctl restart nats`，App 无感知——锚的是 CA，不是叶子证书。
- 根 CA（10 年）：换 CA 后把新的 `ca.crt` 粘进各主机的插件设置卡，手机重扫二维码即可，不必重新打包。
- `ca.key` 泄露 = 整个信任体系失效：立即换 CA + 重签服务器证书 + 重启 nats + 各主机换 CA + 手机全部重扫，
  最后吊销全部设备 token。App 包里没有内置 CA，所以不需要重新打包。
  轮换脚本 `dsh-mobile/scripts/rotate-hub-tls.sh`：新私钥只写在仓库外，`--apply` 回写公开材料。

### 凭证分发路径

| 凭证 | 在哪配置 |
|---|---|
| 私有 CA 公钥 `ca.crt` | 插件设置卡的「CA 证书」（随二维码发给手机）；服务器 `/etc/nats/tls/`、`/etc/dsh-hub/` |
| 服务器私钥 `server.key` | 仅服务器 `/etc/nats/tls/`，0600 |
| 根 CA 私钥 `ca.key` | **离线保管**，不在任何在线设备上 |
| leaf 账号 | dsh 电脑 `leaf.conf`（本机文件，不进代码库） |
| C 端账号（唯一） | 插件向导里配置；经配对二维码传给每个终端。**不**打进 App 构建 |
| 设备 token | 配对流程签发，仅存手机安全存储 |

补充说明：App 二进制里**不含任何凭证**（只有 CA 公钥），反编译拿不到可用机密。即使 Hub 账号泄露，攻击者也只拿到 `svc.dsh.>` 命名空间的"围墙钥匙"，没有设备 token 仍调不动 harness——双层凭证的设计目标就是这个。
