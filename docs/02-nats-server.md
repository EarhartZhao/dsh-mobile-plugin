# NATS 设施改动清单（复用既有 Hub）

> 决策记录（2026-08-25）：不新建 NATS 服务器，复用已上线的 Hub（腾讯云 115.159.57.137，见
> distributed-knowledge-architecture.md）。本文列出为接入 dsh-mobile 所需的**增量改动**。
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
  -subj "/CN=115.159.57.137" -keyout server.key -out server.csr

printf "subjectAltName=IP:115.159.57.137" > san.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 825 -extfile san.ext -out server.crt
```

- `ca.key`：**离线保管**（密码管理器/加密盘），它是整个信任体系的根，绝不放服务器。
- `server.crt` + `server.key`：放服务器 `/etc/nats/tls/`，权限 0600。
- `ca.crt`：打进 App 构建（见第四节），也存一份备份。

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

手机只连 `wss://115.159.57.137:8443`。没有 Caddy、没有域名、没有证书续期任务——服务端证书到期前（约 2 年）用同一 CA 重签一张换上即可，App 无感知。

> 备选（如未来想要"零 App 侧配置"）：Let's Encrypt shortlived profile 支持 IP 证书（2026-08 核实），但 160 小时有效期意味着续期自动化必须绝对可靠，且 ACME 客户端对 RFC 8738 IP 标识的支持参差。个人部署不值得。

### 3. 追加 dsh 专用 C 端账号（可选但推荐）

现有 `c-end-1/2` 权限（pub `svc.>`、sub `evt.>`）与手机需求精确吻合，可直接复用；但独立账号便于单独吊销、不影响其他 C 端：

```hcl
{
  user: c-end-dsh, password: <32位随机>
  permissions = {
    publish = ["svc.dsh.>", "_INBOX.>"]
    subscribe = ["evt.dsh.>", "_INBOX.>"]
  }
}
```

改完 `systemctl restart nats`。

> **单用户多终端**（2026-08-26 确认）：只有一个用户，所有终端共用 `c-end-dsh` 这一个账号，无需按机主/实例拆分账号。终端粒度的管理在应用层设备 token（见 01-auth-pairing.md）。账号不打进 App——经配对二维码传递。

### 4. 安全组

- 放行 **8443**（wss，手机入口）。
- **不放行** 8222；4222/7422 维持现状（Leaf 与其他本地电脑仍需要）。
- 既有 TODO（leaf 7422 启用 TLS）不受本项目阻塞，但建议一并做。

## 二、dsh 电脑侧：部署 Leaf 节点

沿用 Hub 文档第 4.5 节的既有模式（以分配到的 leaf 账号为例，如 leaf-c）：

1. 安装 nats-server 单二进制（Windows：GitHub Releases 下载；注意该服务器不可直连 GitHub 的约束只影响服务器侧）。
2. `C:\nats\leaf.conf`：

```hcl
port: 4222
server_name: "leaf-dsh-pc"

leafnodes {
  remotes = [
    { url: "nats://leaf-c:<密码>@115.159.57.137:7422" }
  ]
}
```

3. 常驻运行（Windows：任务计划程序 / NSSM 注册为服务），日志出现 `Leafnode connection created` 即接入成功。
4. 插件连接 `nats://127.0.0.1:4222`（本机无认证），Hub 不可达时 Leaf 自动重试，插件无感知。

## 三、验收清单

- [ ] 服务器上 `openssl s_client -connect 115.159.57.137:8443 -CAfile ca.crt` 校验通过，且**不带** `-CAfile` 时校验失败（确认不是公共 CA 签的）。
- [ ] 手机网络（关 WiFi 用蜂窝）下 App 内 `nats.ws` 连 `wss://115.159.57.137:8443` 用 `c-end-dsh` 能连上。
- [ ] `c-end-dsh` 账号 sub `svc.dsh.>` 被拒、pub `evt.dsh.>` 被拒（ACL 生效）。
- [ ] dsh 电脑 Leaf 日志显示已连 Hub；服务器上 `curl http://127.0.0.1:8222/leafz` 能看到该 Leaf。
- [ ] 拔掉 dsh 电脑外网 2 分钟再恢复，Leaf 自动重连，期间本机 `nats sub`/`pub` 不受影响。
- [ ] Hub 重启后 Leaf 与手机均自动重连。

## 四、App 侧信任配置与凭证分发

### Android：把私有 CA 打进构建（只对我们的服务器生效）

```xml
<!-- android/app/src/main/res/xml/network_security_config.xml -->
<network-security-config>
  <domain-config>
    <domain includeSubdomains="false">115.159.57.137</domain>
    <trust-anchors>
      <certificates src="@raw/dsh_root_ca" />   <!-- ca.crt 放 res/raw/dsh_root_ca.crt -->
    </trust-anchors>
  </domain-config>
</network-security-config>
```

作用域只圈定 `115.159.57.137`：App 访问其他任何站点仍走系统公共 CA，我们的私有 CA 不会扩大系统攻击面。RN 的 WebSocket 走 OkHttp，遵守该配置。

### iOS

- M4 阶段：本地签名安装后可用同一张 CA 按描述文件方式信任，届时再补。（鸿蒙端已明确不做，2026-08-26。）

### 轮换策略

- 服务器证书（~2 年）：用同一 CA 重签换上，`systemctl restart nats`，App 无感知。
- 根 CA（10 年）：到期前重新打包 App 即可（本地安装，无审核流程）。
- `ca.key` 泄露 = 整个信任体系失效：立即换 CA + 重签服务器证书 + 重打 App + 吊销全部设备 token。

### 凭证分发路径

| 凭证 | 在哪配置 |
|---|---|
| 私有 CA 公钥 `ca.crt` | 打进 App 构建（res/raw）；服务器 `/etc/nats/tls/` |
| 服务器私钥 `server.key` | 仅服务器 `/etc/nats/tls/`，0600 |
| 根 CA 私钥 `ca.key` | **离线保管**，不在任何在线设备上 |
| leaf 账号 | dsh 电脑 `leaf.conf`（本机文件，不进代码库） |
| C 端账号（`c-end-dsh`，唯一） | 插件向导里配置；经配对二维码传给每个终端。**不**打进 App 构建 |
| 设备 token | 配对流程签发，仅存手机安全存储 |

补充说明：App 二进制里**不含任何凭证**（只有 CA 公钥），反编译拿不到可用机密。即使 Hub 账号泄露，攻击者也只拿到 `svc.dsh.>` 命名空间的"围墙钥匙"，没有设备 token 仍调不动 harness——双层凭证的设计目标就是这个。
