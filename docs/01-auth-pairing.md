# 认证与配对设计（外网拓扑）

> v2（2026-08-25）：威胁模型从"局域网"升级为"公网"。所有流量经 NATS broker 跨越互联网，TLS 与凭证分层成为硬性要求。

## 威胁模型

- 防：拿到 NATS broker 接入凭证的人直接操作 harness（例如凭证从 App 里被提取）。
- 防：无关 NATS 账号扫到 / 乱碰本实例的 subject。
- 防：配对码被旁观者抢兑（高熵码 + 短时效 + 一次性 + 同时待用码上限）。
- 依赖前提：手机↔Hub 全程 WSS/TLS；Hub 本身可信（复用既有服务器）。不防 Hub 被攻陷——那是部署侧的事，靠最小权限账号限制爆炸半径。

## 双层凭证

| 层 | 凭证 | 决定什么 | 签发方 |
|---|---|---|---|
| NATS 层 | Hub 的 C 端受限账号（单用户唯一） | 能否连 Hub、能否 pub `svc.dsh.>` / sub `evt.dsh.>` | 插件向导里配置一次，经配对二维码传给每个终端 |
| 应用层 | 设备 token（配对时签发） | 能否调用这台 harness 的 RPC；吊销的真实开关 | 插件（配对流程） |

为什么不让插件给每台设备签独立的 NATS NKEY：那要求插件持有 NATS operator/account 的签发权，等于把 broker 的根权力放进了被保护对象内部。设备级隔离用应用层 token 实现，NATS 账号只做命名空间围墙。

NATS 账号 ACL 最小集：

```text
App 账号(<account>):  allow pub  svc.dsh.> _INBOX.>
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
   │  { version: 1, expiresAt: 1760000000000,
   │    hub: "wss://<hub-host>:8443",
   │    user, pass,                    │
   │    instance: "home-pc",           │
   │    gatewayId, gatewayName,        │
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
- **二维码携带 Hub 账号凭证**（v4 起）：发布版 App 不内置任何账号，机主向导里配置的服务器信息经二维码一次性传给手机。二维码只在机主本人屏幕出现，是认证的带外通道；`caFp` 是 Hub CA 的指纹，`ca` 是 CA 本体（base64 DER），App 0.0.9 起由原生模块把它装成运行时信任锚，所以同一个 App 包能连任意自建 Hub——详见 README「测试 Hub 账号」与 [03](03-nats-self-host.md)。
- **配对前必须先配好 Hub 账号密码**：二维码里的 `hub`/`user`/`pass` 是手机唯一的接入凭证，任一为空时插件拒绝发码（`/mobile-bridge/api/pair` 返回未配置字段清单，控制台同时禁用生成按钮），因为这样的码扫进 App 后只有两种表现——`二维码内容缺少字段：pass`（App 侧字段校验先拦下），或连 Hub 时被拒 `Authorization Violation`（密码填了但不是 Hub 上的那个）。
- **密码的可见范围**：`hubPass` 是 `role('secret')` 字段，明文落在 profile 的 `cordis.patch.yml`（那条 `- id: mobile-bridge` 覆盖行，跟着 profile 一起备份/搬迁），不进 `settings.describe(redactSecrets)` 这类 wire 响应。**唯一例外**是回环控制台：`/mobile-bridge/api/status` 只回 `hubPassConfigured` 布尔值，点「显示」时走一次 `POST /mobile-bridge/api/reveal`（同样要求回环 + 同源 + 自定义头）取回原文，页面据此预填并默认明文显示（带「隐藏」切换），这样机主能一眼看出存的是不是 Hub 上那个密码。非回环请求两条路都拿不到值。
- 配对码：8 位随机字符，120 秒有效，一次性；同一时间最多 3 个待核销。当前**没有**“失败 5 次锁定该码”：错误猜测不指向某个已存在的 code，无法给不存在的记录计数。实际保护是 `32^8 ≈ 1.1e12` 的码空间、短有效期、同时最多 3 个待用码。满 3 个时再领码不会报错，而是让最早的那个作废——重新生成正是机主在扫码不顺时的常规动作，同时有效的码数始终不超过 3，猜码窗口不变。
- `svc.dsh.{instance}.pair` 是唯一**不需要 token** 的 RPC subject。无效或过期配对码返回 `mobile-pair-failed`；有效码因有效设备达到 `maxDevices` 被拒绝时返回 `mobile-device-limit`，App 会提示先在电脑端吊销旧设备。两类失败均不泄露宿主信息。
- token：32 字节随机，base64url；RPC 请求放在信封外的传输头字段（NATS headers），不进业务载荷。
- 配对成功后还会返回 `eventKey`（每设备随机 18 字节）和 `installationId`（安装级 UUID，旧 App 或旧插件可缺失）。`eventKey` 用于设备隔离事件主题；`installationId` 只用于把同一安装的重新配对归类到同一条设备记录，并轮换该记录的 token，不是鉴权凭证。

## 下行事件隔离

旧协议只有共享主题：

```text
evt.dsh.{instance}.mux
evt.dsh.{instance}.host
```

配对返回 `eventKey` 后，插件额外发布到：

```text
evt.dsh.{instance}.{eventKey}.mux
evt.dsh.{instance}.{eventKey}.host
```

`eventKey` 是随机、不可猜的主题段，不是新的 NATS 凭证，也不取代设备 token；它的作用是避免同一 Hub 账号下的手机订阅到其他手机的事件。迁移期为兼容未升级 App，插件在仍有“没有 eventKey 的有效设备”时继续双发旧共享主题；当所有有效设备都升级并重新配对后，共享主题自动停止，设备级隔离才完全生效。NATS 账号 ACL 仍只做到 `sub evt.dsh.>` 的命名空间围墙，设备隔离由随机主题段加上设备 token 两层共同完成。

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
    {
      "id": "...",
      "name": "Pixel 8",
      "tokenHash": "sha256:...",
      "eventKey": "...",
      "installationId": "...",
      "createdAt": "...",
      "expiresAt": "...",
      "lastSeenAt": "...",
      "revoked": false
    }
  ]
}
```

- 写入用临时文件 + rename，避免半截文件。
- 并发写入串行化，并为每次写入使用唯一临时文件名；最后一次变更不会被较旧的快照覆盖。
- 文件权限 0600（Windows 下尽力而为）。
- 插件卸载/禁用时不删 token 文件，重新启用后已配对设备继续可用。
- 吊销即时生效：校验走内存索引，吊销即除名；进行中的一次性调用不受影响，新请求立即拒绝。
- `lastSeenAt` 表示最近一次通过 token 校验的请求时间，不是在线状态；内存中实时更新，磁盘写入按分钟节流，桥停止时补写。

## 与 v1（局域网方案）的差异备忘

| 项 | v1（LAN，已废弃） | v2（外网 + NATS） |
|---|---|---|
| 载体 | `/mobile/*` HTTP 路由 + WS upgrade | NATS subject（插件零端口） |
| TLS | 明文可接受 | 强制（WSS） |
| 发码接口 | `/mobile/pair` 限回环 | web UI 设置卡 / CLI（同样本机限定） |
| token 传输 | Authorization 头 / WS 查询参数 | NATS headers |
| 发现 | 二维码 / 可选 mDNS | 仅二维码（mDNS 跨网无意义） |
