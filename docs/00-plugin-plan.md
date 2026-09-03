# dsh-mobile-plugin 方案

> 状态：提案 v4（2026-08-26）。v4 变更：App 有安装版，onboarding 傻瓜化——插件提供**首次配置向导**（填服务器信息 → 测试连接 → 出二维码），每台终端扫码一次完成全部配置；App 构建不内置任何账号凭证。用户模型确认为**单用户多终端**，不做多租户隔离。v3：复用既有 Hub + 本地 Leaf。配套文档：dsh-mobile/docs/。

## 定位

安装进本地 deepseek-harness `web` profile 的**树外 Cordis 插件**。它解决一个问题：harness 在家庭内网 NAT 后，外网手机连不进来。办法是插件在 harness 进程内连接本机 NATS Leaf 节点（订阅路由经 Leaf 自动同步到公网 Hub），把 harness 已有的 `/api` 协议（一元 RPC + 下行事件帧）原样桥接到 NATS subject 上。

业务协议零重写：信封、Zod schema、快照/重放语义全部复用 harness 现有契约（映射见 dsh-mobile/docs/02-protocol.md）。插件只做传输搬运 + 认证 + 配对。

## 职责

1. **NATS 连接**：连本机 Leaf（`nats://127.0.0.1:4222`），常驻自动重连，连接状态上报到 harness 日志/设置卡。Hub 不可达由 Leaf 负责重试，插件零感知。
2. **RPC 桥**：订阅 `svc.dsh.{instance}.>`，校验设备 token + 方法白名单后，进程内调 `toFetchHandler(ctx.apiProxy)`，把响应作为 request-reply 回复。
3. **事件流桥**：把 `events.mux` / `events.host` 两条下行帧流（复用 connection 插件同源的事件源）publish 到 `evt.dsh.{instance}.mux` / `evt.dsh.{instance}.host`。
4. **配对与设备管理**：配对码签发（仅本机操作可领）、核销换 token、token 校验与吊销。
5. **首次配置向导**：dsh Web 设置页注册一张"移动端"设置卡（harness 的 settings 扩展点），字段只有 Hub 地址 + 账号 + 密码；提供"测试连接"按钮，连通了才允许生成配对二维码。CLI 路径：`dsh` 输出同款信息与终端二维码。

## 新用户 onboarding（傻瓜流程）

```text
dsh 机主                                手机
1. 安装插件（profile 加两行配置）
2. 打开 dsh Web 设置页 → "移动端"卡
3. 填 Hub 地址/账号/密码 → [测试连接] ✅
4. 点 [生成配对二维码] ──扫码────► 5. App 得到 { hub地址, 账号, instanceId, 配对码 }
                                    6. 自动连 Hub → 核销配对码 → 得到设备 token
                                    7. 进入会话列表，完成
```

- App 侧**零输入**：全部参数来自二维码，扫错不了。
- 二维码是唯一的信息出口，只在机主本人屏幕上出现；配对码 120 秒一次性。
- **CA 不走二维码**：Android 的 WebSocket TLS 校验在系统层，运行时下发的 CA 无法注入（stock RN 限制）。CA 是公钥、非机密，直接打进 App 构建（networkSecurityConfig 圈定 Hub IP）；二维码里只带 CA 指纹做展示校验。BYO 自建 Hub 的 CA 不在构建内 → v1 不支持 BYO Hub 的 TLS 校验，列为 v2（届时写原生模块或要求 BYO Hub 使用产品 CA 体系）。

## 用户模型（已定：单用户多终端）

- **只有一个用户**，但可能有多个终端（手机、平板等）。不做多租户/多机主隔离。
- Hub 上**一个 C 端账号**（`c-end-dsh`）即可，所有终端共用；它经配对二维码传给每个终端，不打进 App 构建。
- 多终端的管理粒度在**设备 token**：每个终端扫码配对拿自己的 token，设备列表/吊销按终端操作（`maxDevices` 配置项即终端数上限）。
- App 二进制里**不含任何账号凭证**：反编译只能拿到 CA 公钥和 UI。

## 架构

```text
phone (外网) ──wss:8443──► NATS Hub (115.159.57.137, 既有)
                               ▲ leaf :7422（出站长连接，既有模式）
                      本地 Leaf nats-server (dsh 电脑, localhost:4222)
                               ▲ 本机明文连接，不出网卡
┌──────────────────────────────┴──────────────────────┐
│ deepseek-harness (web profile, 家庭内网)              │
│  ┌──────────────────────────────────────────────┐  │
│  │ dsh-mobile-plugin                             │  │
│  │  svc sub ──► token 门 ──► 白名单 ──► toFetchHandler(ctx.apiProxy) │
│  │  事件源 ──► publish evt.dsh.{i}.mux / .host    │  │
│  └──────────────────────────────────────────────┘  │
│  webserver: 仍可只绑 127.0.0.1（浏览器照常，LAN 零暴露） │
└─────────────────────────────────────────────────────┘
```

关键收益：harness 主机**零入站端口**，攻击面收敛到 NATS 账号 ACL + 应用层 token 两道门；Leaf 模式下断外网时本机浏览器与其他本地服务照常工作，恢复后自动重连。

## NATS 设施（已定：复用既有 Hub + 本机 Leaf）

- **Hub**：已上线运行（腾讯云 115.159.57.137，v2.14.4；实测 4222/7422 可达，支持 headers，max_payload 1 MiB）。与知识库等其他服务共用同一 Hub，以 subject 命名空间隔离。
- **Hub 侧需追加**（仅此一项服务端改动）：私有 CA + `websocket` 监听 8443 原生 TLS（手机只走 wss://IP:8443，不用域名，不碰明文 4222）、dsh 专用 C 端账号。改动清单见 [02-nats-server.md](02-nats-server.md)。
- **dsh 电脑**：部署本地 Leaf 节点（沿用既有 leaf-a~d 模式，见 Hub 文档第 4.5 节），插件连接 `localhost:4222`，无需账号（本机）。

## 为什么不是其他内网穿透方案

对比表与决策理由见 dsh-mobile/docs/00-overview.md 第 2 节。简言之：Tailscale 要求手机装 VPN 客户端，Cloudflare Tunnel 依赖 CF 与域名，frp 暴露原始端口还要自建 TLS/认证；NATS 的 request-reply 与 harness 一元 RPC 语义完全吻合，且基础设施已经在线。

## 安装方式（树外插件）

`web` profile 支持树外插件（profile 目录的 `package.json` 声明依赖 + `cordis.patch.yml` 加行）：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: mobile-bridge
      name: 'dsh-mobile-plugin'
      config:
        natsUrl: 'nats://127.0.0.1:4222'
        instanceId: 'home-pc'
```

```json
// $DSH_HOME/profiles/web/package.json
{ "dependencies": { "dsh-mobile-plugin": "link:C:/code/deepseek/dsh-mobile-plugin" } }
```

**必须用 `link:` 而非 `file:`**（联调实测踩坑）：`file:` 是打包拷贝，源码改动后 pnpm 不重打包，旧副本静默残留；`link:` 是符号链接，指回仓库活目录，插件自身的 node_modules 随之生效（nats/qrcode 从仓库目录解析；`@deepseek-ai/cordis` 等 peer 靠 Symbol.for 全局符号与宿主互操作）。

## 联调验收记录（2026-08-26，真实 dsh web profile）

- 插件随 `dsh --profile web` 挂载成功；回环控制台 `http://127.0.0.1:<port>/mobile-bridge` 可开。
- 配对 → 门控 RPC → 事件流全链路实测通过：`pair` 换 token、`host.describe` / `workspace.list`（真实工作区数据）/ `session.create` 成功，`host/session-added` 帧到达 `evt.dsh.home.host`。
- 双端同步实测：Web 端（loopback `/api`）创建的会话经事件桥推到 NATS；NATS 端创建的会话进 `session.list`。
- 无 token 调用被 `mobile-unauthenticated` 拒绝；设置卡浏览器半已被模块系统收编（`/plugins/dsh-mobile-plugin/client.js` 可服务，boot 图含 `?rev=` 注册行）。
- 设置卡状态接口与经设备 token 保护的 `mobile.health` 返回同一组运行信息：插件版本、mobileApi、功能、构建 ID、真实加载路径、实例 ID、启动时间、最近连接/重连和最近错误；任何输出都不包含 Hub 密码或设备 token。
- 踩坑记录：① 同一实例曾被挂出两个响应者——boot effect 与 settings watch 并发触发 start 导致重复 NATS 订阅，生命周期已串行化（kick/cycle 队列）；② 见上 `file:` vs `link:`。

### 追加：broker 硬重启恢复（2026-08-27，实测）

- 问题：broker 被强杀（kill 级）后，nats.js 2.29.x 客户端陷入静默 `reconnecting`——状态流持续上报但从不真正拨号，订阅不恢复，RPC 全部 503（独立复现脚本 + 插件实测双重确认）。
- 修复：`trackStatus` 加重连看门狗（`disconnect` 后 10s 无 `reconnect` 即走串行生命周期 `restart()`，fresh `connect()` 立即恢复）；`stop()` 的 `nc.drain()` 加 2s 上限防 wedged socket 挂死生命周期。
- 实测：杀 broker → 看门狗触发（状态转 `connecting`）→ 拉起 → RPC 恢复（`host.describe` 返回真实数据）。App 侧（nats.ws over WebSocket）无此问题，同场景自动重连正常。

## 配置草案

```yaml
config:
  natsUrl: 'nats://127.0.0.1:4222'  # 本机 Leaf；Leaf 挂了插件自动重连
  instanceId: 'home-pc'             # subject 命名空间 svc.dsh.{instance}.* / evt.dsh.{instance}.*
  tokenTtlDays: 90
  pairCodeTtlSec: 120
  maxDevices: 10
  chunkCoalesceMs: 0                # >0 时对 assistant/chunk 合帧降频，弱网友好
```

## 里程碑

### v1.0（对齐 dsh-mobile M1/M2）

- NATS 连接（本机 Leaf）+ 自动重连 + 状态日志。
- RPC 桥（token 门 + 白名单）+ 事件流桥。
- 配对：PC 本机经 web UI 设置卡 / CLI 领配对码（二维码内容 `{ natsWss, instance, code }`），手机经 `svc.dsh.{instance}.pair` 核销换长期 token。
- token 存储：`$DSH_HOME/mobile-bridge/tokens.json`（哈希存储，明文只在签发时出现一次）。

### v1.1

- 设备管理（列表/吊销）经 RPC 暴露给移动端设置页。
- `chunkCoalesceMs` 合帧；弱网指标日志。

### v2（可选）

- 多 harness 实例（多个 `instanceId` 共存于同一 Hub，App 侧多主机切换）。
- JetStream 仅用于"任务完成"类低频通知的离线补发（不做全量事件队列）。

## 明确不做

- 不在 harness 主机监听任何新端口；不碰 webserver 配置。
- 不做多用户/多租户：subject 命名空间即隔离边界。
- 不代理特权方法集（settings/credentials/agentPreset 创作面）：白名单直接不放行。
- 不传大文件（session.export 的 ZIP）：Hub max_payload 1 MiB，大文件需求未来用一次性 URL 方案。

## RPC 方法白名单（v1）

`host.describe`、`workspace.list`、`workspace.create`、`session.list`、`session.create`、`session.history`、`session.prompt`、`session.cancel`、`session.updateQueue`、`session.rename`、`session.fork`、`session.models`、`session.selectModel`、`session.search`、`command.list`、`command.execute`、`skill.list`、`respond`。

白名单之外的请求返回 403 语义的 RPC 错误，与方法不存在区分。
