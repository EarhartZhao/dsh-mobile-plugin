# 认证与配对设计（外网拓扑）

> v2（2026-08-25）：威胁模型从"局域网"升级为"公网"。所有流量经 NATS broker 跨越互联网，TLS 与凭证分层成为硬性要求。

## 威胁模型

- 防：拿到 NATS broker 接入凭证的人直接操作 harness（例如凭证从 App 里被提取）。
- 防：无关 NATS 账号扫到 / 乱碰本实例的 subject。
- 防：配对码被旁观者抢兑（短时效 + 一次性 + 限流）。
- 依赖前提：手机↔Hub 全程 WSS/TLS；Hub 本身可信（既有腾讯云服务器）。不防 Hub 被攻陷——那是部署侧的事，靠最小权限账号限制爆炸半径。

## 双层凭证

| 层 | 凭证 | 决定什么 | 签发方 |
|---|---|---|---|
| NATS 层 | Hub 的 C 端受限账号（`c-end-dsh`，单用户唯一） | 能否连 Hub、能否 pub `svc.dsh.>` / sub `evt.dsh.>` | 插件向导里配置一次，经配对二维码传给每个终端 |
| 应用层 | 设备 token（配对时签发） | 能否调用这台 harness 的 RPC；吊销的真实开关 | 插件（配对流程） |

为什么不让插件给每台设备签独立的 NATS NKEY：那要求插件持有 NATS operator/account 的签发权，等于把 broker 的根权力放进了被保护对象内部。设备级隔离用应用层 token 实现，NATS 账号只做命名空间围墙。

NATS 账号 ACL 最小集：

```text
App 账号(c-end-dsh):  allow pub  svc.dsh.> _INBOX.>
                      allow sub  evt.dsh.> _INBOX.>
插件侧: 本机 Leaf 无认证；Hub 侧 Leaf 账号(leaf-x)受 Leaf 信任模型约束
```

## 配对流程

```text
PC（本机操作）                      手机（外网）
   │  web UI 设置卡 / CLI 领码        │
   │  ◄── { code, expires }          │
   │  屏幕显示二维码                   │
   │  qr 内容（JSON，base64url）：      │
   │  { hub: "wss://115.159.57.137:8443",
   │    user, pass,                    │
   │    instance: "home-pc",           │
   │    caFp: "sha256:...",            │
   │    code: "XXXXXXXX" }             │
   │        ──────扫码─────────────►  │
   │                    连 NATS（qr 里的账号凭证）│
   │                    校验 Hub 证书 CA 指纹 = caFp│
   │                    request svc.dsh.{instance}.pair
   │                      { code, deviceName }
   │        ◄────────────────────── { token, expiresAt }
   │                    之后每个 RPC/respond 帧头携带 token
```

- **领码必须本机操作**：配对码从 web UI 的设置卡或 `dsh` CLI 输出领取，两者都要求人在电脑前。配对码本身绝不经 NATS 外传——二维码是唯一出口。
- **二维码携带 Hub 账号凭证**（v4 起）：发布版 App 不内置任何账号，机主向导里配置的服务器信息经二维码一次性传给手机。二维码只在机主本人屏幕出现，是认证的带外通道；`caFp` 是 Hub CA 的指纹，App 连接后展示/校验用（CA 本体打进 App 构建，见 02 文档）。
- 配对码：8 位随机字符，120 秒有效，一次性；同一时间最多 3 个待核销；核销失败 5 次锁定该码。
- `svc.dsh.{instance}.pair` 是唯一**不需要 token** 的 RPC subject。无效或过期配对码返回 `mobile-pair-failed`；有效码因有效设备达到 `maxDevices` 被拒绝时返回 `mobile-device-limit`，App 会提示先在电脑端吊销旧设备。两类失败均不泄露宿主信息。
- token：32 字节随机，base64url；RPC 请求放在信封外的传输头字段（NATS headers），不进业务载荷。

## 请求校验顺序（插件 RPC 桥内）

1. NATS headers 取 token → 查哈希表（失败：统一 `unauthenticated`，不区分"不存在/过期/已吊销"）
2. 方法白名单（失败：`forbidden`）
3. `toFetchHandler(ctx.apiProxy)` 进程内分发

## token 存储

```json
// $DSH_HOME/mobile-bridge/tokens.json
{
  "version": 1,
  "devices": [
    { "id": "...", "name": "Pixel 8", "tokenHash": "sha256:...", "createdAt": "...", "expiresAt": "...", "revoked": false }
  ]
}
```

- 写入用临时文件 + rename，避免半截文件。
- 文件权限 0600（Windows 下尽力而为）。
- 插件卸载/禁用时不删 token 文件，重新启用后已配对设备继续可用。
- 吊销即时生效：校验走内存索引，吊销即除名；进行中的一次性调用不受影响，新请求立即拒绝。

## 与 v1（局域网方案）的差异备忘

| 项 | v1（LAN，已废弃） | v2（外网 + NATS） |
|---|---|---|
| 载体 | `/mobile/*` HTTP 路由 + WS upgrade | NATS subject（插件零端口） |
| TLS | 明文可接受 | 强制（WSS） |
| 发码接口 | `/mobile/pair` 限回环 | web UI 设置卡 / CLI（同样本机限定） |
| token 传输 | Authorization 头 / WS 查询参数 | NATS headers |
| 发现 | 二维码 / 可选 mDNS | 仅二维码（mDNS 跨网无意义） |
