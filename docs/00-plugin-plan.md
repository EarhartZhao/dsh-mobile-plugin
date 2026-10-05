# dsh-mobile-plugin 方案

> 状态：提案 v4（2026-08-26）。v4 变更：App 有安装版，onboarding 傻瓜化——插件提供**首次配置向导**（填服务器信息 → 测试连接 → 出二维码），每台终端扫码一次完成全部配置；App 构建不内置任何账号凭证。用户模型确认为**单用户多终端**，不做多租户隔离。v3：复用既有 Hub + 本地 Leaf。配套文档：dsh-mobile/docs/。

## 定位

安装进本地 deepseek-harness `web` profile 的**树外 Cordis 插件**。它解决一个问题：harness 在家庭内网 NAT 后，外网手机连不进来。办法是插件在 harness 进程内连接本机 NATS Leaf 节点（订阅路由经 Leaf 自动同步到公网 Hub），把 harness 已有的 `/api` 协议（一元 RPC + 下行事件帧）原样桥接到 NATS subject 上。

App wire 保持稳定，但宿主接入已迁移到 dsh 0.1.5-rc.1 的 Typert Remote（0.1.2-alpha.2 起移除 ApiProxy，此后接入面未再变化）。插件负责 Remote 参数映射、follow/control/workspace 流适配、事件回答、传输、认证与配对（映射见 dsh-mobile/docs/02-protocol.md）。

## 职责

1. **NATS 连接**：连本机 Leaf（`nats://127.0.0.1:4222`），常驻自动重连，连接状态上报到 harness 日志/设置卡。Hub 不可达由 Leaf 负责重试，插件零感知。
2. **RPC 桥**：订阅 `svc.dsh.{instance}.>`，校验设备 token + 方法白名单后，通过 `typertGateway` 调用当前 Remote；审批/提问结果经 shared `/api/$events/result` 回传。
3. **事件流桥**：消费 `$events`、`session/control`、`workspace/follow` 与按地址打开的 `session/follow`，投影为 App 的 mux/host 帧并 publish 到 `evt.dsh.{instance}.mux` / `evt.dsh.{instance}.host`。
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

  > **2026-10-05 更正**：这条已被 v2 原生模块方案取代。App 0.0.9 起不再内置任何 CA，`ca` 字段随二维码下发，由原生模块 `DshHubTls`（Android）/ iOS 侧同等实现安装为运行时信任锚，因此 App 可以连任意自建 Hub；`caFp` 仍是人工核对用的指纹。插件侧现状见 [README](../README.md)「测试 Hub 账号」一节。

## 用户模型（已定：单用户多终端）

- **只有一个用户**，但可能有多个终端（手机、平板等）。不做多租户/多机主隔离。
- Hub 上**一个 C 端受限账号**即可，所有终端共用；它经配对二维码传给每个终端，不打进 App 构建。
- 多终端的管理粒度在**设备 token**：每个终端扫码配对拿自己的 token，设备列表/吊销按终端操作（`maxDevices` 配置项即终端数上限）。
- App 二进制里**不含任何账号凭证**：反编译只能拿到 CA 公钥和 UI。

## 架构

```text
phone (外网) ──wss:8443──► NATS Hub (<hub-host>, 既有)
                               ▲ leaf :7422（出站长连接，既有模式）
                      本地 Leaf nats-server (dsh 电脑, localhost:4222)
                               ▲ 本机明文连接，不出网卡
┌──────────────────────────────┴──────────────────────┐
│ deepseek-harness (web profile, 家庭内网)              │
│  ┌──────────────────────────────────────────────┐  │
│  │ dsh-mobile-plugin                             │  │
│  │  svc sub ──► token 门 ──► 白名单 ──► typertGateway Remote │
│  │  事件源 ──► publish evt.dsh.{i}.mux / .host    │  │
│  └──────────────────────────────────────────────┘  │
│  webserver: 仍可只绑 127.0.0.1（浏览器照常，LAN 零暴露） │
└─────────────────────────────────────────────────────┘
```

关键收益：harness 主机**零入站端口**，攻击面收敛到 NATS 账号 ACL + 应用层 token 两道门；Leaf 模式下断外网时本机浏览器与其他本地服务照常工作，恢复后自动重连。

## NATS 设施（已定：复用既有 Hub + 本机 Leaf）

- **Hub**：已上线运行（v2.14.4；实测 4222/7422 可达，支持 headers，max_payload 1 MiB）。与知识库等其他服务共用同一 Hub，以 subject 命名空间隔离。地址与账号只留在部署机上，仓库里一律用 `<hub-host>` / `<account>` 占位。换 Hub 或自建见 [02](02-nats-server.md) 与 [03](03-nats-self-host.md)。
- **Hub 侧需追加**（仅此一项服务端改动）：私有 CA + `websocket` 监听 8443 原生 TLS（手机只走 wss://IP:8443，不用域名，不碰明文 4222）、dsh 专用 C 端账号。改动清单见 [02-nats-server.md](02-nats-server.md)。
- **dsh 电脑**：部署本地 Leaf 节点（沿用既有 leaf-a~d 模式，见 Hub 文档第 4.5 节），插件连接 `localhost:4222`，无需账号（本机）。

## 为什么不是其他内网穿透方案

对比表与决策理由见 dsh-mobile/docs/00-overview.md 第 2 节。简言之：Tailscale 要求手机装 VPN 客户端，Cloudflare Tunnel 依赖 CF 与域名，frp 暴露原始端口还要自建 TLS/认证；NATS 的 request-reply 与 harness 一元 RPC 语义完全吻合，且基础设施已经在线。

## 安装方式（树外插件）

`web` profile 支持树外插件。本包声明了 `dsh.bundle`（随包发布的 `cordis.patch.yml` 提供 `mobile-bridge` 那一行），所以 profile 侧只做三件事：声明依赖、把包名加进 `dsh.profile.bundles`、在 profile 自己的 patch 里**按 id 覆盖**该行。包名 0.2.27 起是 `@dsh-earhartzhao/dsh-mobile-plugin`（发到 npm 组织就得带 scope），0.2.26 及更早是裸名 `dsh-mobile-plugin`——旧的装法照 README 的 `scripts/migrate-to-scoped.mjs` 迁移，别只重装：profile 那条覆盖行按「id + 包名断言」匹配，包名换了它就不再匹配任何条目，配置会静默失效。

```json
// $DSH_HOME/profiles/web/package.json
{ "dependencies": { "@dsh-earhartzhao/dsh-mobile-plugin": "link:C:/code/deepseek/dsh-mobile-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-earhartzhao/dsh-mobile-plugin"] } } }
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: mobile-bridge
  name: '@dsh-earhartzhao/dsh-mobile-plugin'
  config:
    natsUrl: 'nats://127.0.0.1:4222'
    instanceId: 'home-pc'
```

**必须用 `link:` 而非 `file:`**（联调实测踩坑）：`file:` 是打包拷贝，源码改动后 pnpm 不重打包，旧副本静默残留；`link:` 是符号链接，指回仓库活目录，插件自身的 node_modules 随之生效（nats/qrcode 从仓库目录解析；`@deepseek-ai/cordis` 等 peer 靠 Symbol.for 全局符号与宿主互操作）。

### 从 git 安装：`prepare` 补上缺失的构建（2026-09-30）

`github:<owner>/<repo>` 拉的是源码 tarball（`https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>`），仓库 `.gitignore` 掉的 `lib/` 不在里面，装完 `main: lib/index.js` 找不到文件，宿主只报一句 `mobile-bridge (dsh-mobile-plugin): failed to import`。本包因此在 `package.json` 声明 `"prepare": "pnpm run build"`：pnpm 把 codeload 的 `.../tar.gz/<40 位 sha>` 认作 git 托管包，装好后会跑 `prepare` 当场编译出 `lib/`（这条也解释了为什么分支名/标签名的 tarball 地址不算——只有 SHA 形态命中）。

代价是 pnpm ≥10 默认拦下依赖的构建脚本：首次 `add` 会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败，并打印一条带 spec 与 commit 的精确键。把那条键抄进 profile 的 `pnpm-workspace.yaml` 后重跑一次即可（键随 commit 变化，不是包名）：

```yaml
# $DSH_HOME/profiles/<profile>/pnpm-workspace.yaml
allowBuilds:
  'dsh-mobile-plugin@https://codeload.github.com/<owner>/dsh-mobile-plugin/tar.gz/<sha>': true
```

不想让使用方加这条就换预构建产物。现在走的是 Release 资产：打 tag 时 `.github/workflows/release.yml` 先跑一遍验证（typecheck / test / build），再 `pnpm pack`——`prepare` 在这里跑，`lib/` 进包——把 `dsh-mobile-plugin-<version>.tgz` 与版本无关的 `dsh-mobile-plugin.tgz` 一起挂到该 tag 的 Release：

```bash
pnpm add https://github.com/<owner>/<repo>/releases/download/v0.2.25/dsh-mobile-plugin-0.2.25.tgz
```

Release 资产是个普通远端 tarball，不经 git 托管路径，`prepare` 不会被调用，`allowBuilds` 也不再需要——代价是安装源从源码树变成资产，且这台机器要能访问 GitHub Release（源码 tarball 走的是 codeload，两者域名不同）。控制台的更新按钮认这种 spec：`releaseAssetSpec` 把 URL 里的 tag 换成最新版本，文件名里嵌的旧版本号一并替换（`dsh-mobile-plugin-0.2.24.tgz` → `dsh-mobile-plugin-0.2.25.tgz`），换 URL 也就换掉了 pnpm 的 integrity，不会拿回旧字节。带 `-rc` 的 tag 发布时标成 pre-release，`releases/latest` 因此不会指向预发布版。

另外两条老路仍然可用：`pnpm pack` 出 tarball 让使用方 `add ./dsh-mobile-plugin-<version>.tgz`，或直接从 npm 装（见下）。本地 `link:` 引用不跑 `prepare`，所以开发机上的插件构建仍由 `pnpm run build` 决定。

**发到 npm（2026-10-05 起）。** 包名 `@dsh-earhartzhao/dsh-mobile-plugin`——npm 组织只收 scoped 包，所以 0.2.27 顺势改了名（迁移见 README 与下一段）。同一个 release job 里还有一步 `npm publish`：仓库 secrets 配了 `NPM_TOKEN` 就发，没配就打印一行跳过（GitHub Release 资产照常出），npm 上已有同版本号也跳过——所以重跑发布、或者同一个 tag 先手工发过一次，都不会失败。这一步排在「Publish release assets」**之后**，因为 token 若被 2FA/权限挡下，不该连带丢掉 Release 资产。registry 侧无需再操心 `prepare`：它在发布那一刻跑，装的人拿到的 tarball 里已经有 `lib/`。发版顺序不变：改三处版本号 → 提交 → 打 tag → 推 tag。

发布时踩到的两件事，记在这里免得下次当故障查：一是 granular token 必须勾 **Bypass 2FA**，否则 PUT 直接被 403 挡下（`Two-factor authentication or granular access token with bypass 2fa enabled is required`）；二是**新包的元数据文档（packument）会在 registry 缓存里 404 一阵子**——PUT 已经 200、`/-/package/<name>/dist-tags` 和 tarball 都能取到，只有 `registry.npmjs.org/<name>` 还是 `{"error":"Not found"}`，于是 `npm view` 和 `pnpm add` 都会报「不在 registry 上」。等缓存过期即可，不是发布失败；流水线因此把「cannot publish over the previously published versions」也当成跳过。

registry 装上之后还有一处得自己拼：pnpm 在 profile 清单里只写**版本范围**（`"@dsh-earhartzhao/dsh-mobile-plugin": "^0.2.27"`），包名只是那一行的 key。检查更新读的是「这个 profile 用什么 spec 装的」，所以读依赖时要拿 key 和值拼回完整 spec（`src/update.ts` 的 `dependencySpec`，`readProfileDependency` 调用它）——只交出值就等于交出一个没有名字的 `^0.2.27`，`parseUpdateSource` 认不出 registry，控制台只能回「从 ^0.2.27 看不出 GitHub 仓库或 npm 包名」（0.2.28 修，见 README 版本记录）。同理，range 里的空格（`>=0.2.0 <0.3.0`）也算 spec 的一部分，别在解析时按空白截断。

改名的连带效应还有一处：`pnpm pack` 对 scoped 包产出 `dsh-earhartzhao-dsh-mobile-plugin-<version>.tgz`（npm 自己会去掉 scope，pnpm 不去），而 release 资产与 `releaseAssetSpec` 认的是从来不带 scope 的 `dsh-mobile-plugin-<version>.tgz` + `dsh-mobile-plugin.tgz`——老装法的更新 URL 里嵌着这个名字，改了就等于让它们更新不到。所以 `release.yml` 的 `pnpm pack` 之后会把文件名改回去再上传。

凭据用 automation token（`NPM_TOKEN`）。想彻底不存 token，可以在 npmjs.com 该包的 Settings → Trusted Publisher 里登记本仓库与工作流名，再给 job 加 `id-token: write` 并去掉 token 那步——当前没走这条，因为首次发布时包还不存在。

### 安装形态与自动迁移（2026-09-30）

行**必须由组合包提供**，profile patch 只留按 id 的覆盖。早期文档写的是 `- insert:` 直接在 profile patch 里挂行，那种形态宿主管不了：整包开关是关的（包名不在 `dsh.profile.bundles`），行开关只在整包启用时才渲染，点卸载则报 `bundle-in-use`——`PluginManager.removeBundle` 会先关掉组合包再检查「这一行是否还活着」，而 profile patch 的 insert 与组合包无关，关掉组合包它照样在，于是判定「其他配置仍在使用这个组件的行」。

插件因此在加载时做一次幂等自迁移（`src/profile-migration.ts`），分两步走，因为组合包的 patch 层只在 dsh 启动时参与组合：

1. 把包名补进 `dsh.profile.bundles`。这一条只在下一次启动生效，本次不动正在运行的行。
2. 下一次启动时行已由组合包提供，再把 profile patch 里的 insert 行提成按 id 的覆盖行（配置原样保留，位置与块注释一起搬），并合并同 id 的重复覆盖行。

第二步只在启动时 `startedBundles` 含本包时执行——否则提走 insert 会让正在运行的行离开组合，桥会一直下线到下次启动。开关是配置项 `autoMigrateProfile`（默认 `true`，设 `false` 则插件只报告不改文件，改由控制台「修复安装形态」按钮手动触发）。卸载后那条覆盖行会留在 profile patch 里（指向已删的行，宿主启动时给一句无害的 `patch: entry "mobile-bridge" not found` 警告）——好处是重装直接复用原配置。宿主侧行为，插件不处理。

## 联调验收记录（2026-08-26，真实 dsh web profile）

- 插件随 `dsh --profile web` 挂载成功；回环控制台 `http://127.0.0.1:<port>/mobile-bridge` 可开。
- 配对 → 门控 RPC → 事件流全链路实测通过：`pair` 换 token、`host.describe` / `workspace.list`（真实工作区数据）/ `session.create` 成功，`host/session-added` 帧到达 `evt.dsh.home.host`。
- 双端同步实测：Web 端（loopback `/api`）创建的会话经事件桥推到 NATS；NATS 端创建的会话进 `session.list`。
- 无 token 调用被 `mobile-unauthenticated` 拒绝；设置卡浏览器半已被模块系统收编（`/plugins/dsh-mobile-plugin/client.js` 可服务，boot 图含 `?rev=` 注册行）。
- 设置卡状态接口与经设备 token 保护的 `mobile.health` 返回同一组运行信息：插件版本、mobileApi、功能、构建 ID、真实加载路径、实例 ID、启动时间、最近连接/重连和最近错误；任何输出都不包含 Hub 密码或设备 token。
- 控制台「插件更新」一栏：**刷新**去 GitHub 查本仓库最新版本 tag，有新版才显示**更新**按钮，点了交给宿主插件管理器按 profile 声明的依赖 spec 重装（`pluginManager.installBundle`），装完提示重启 dsh 生效。检查失败原样报原因，绝不把失败说成「已是最新」。
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
  instanceName: '工作台 Mac'         # 手机连接列表里显示的名字；留空回退 instanceId
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
  已落地（2026-10-05）：App 保存多份 profile 并随时切换，插件用 `instanceName` 告诉 App
  "这台电脑叫什么"。设计见 [dsh-mobile/docs/07-multi-connection-plan.md](../../dsh-mobile/docs/07-multi-connection-plan.md)。
- JetStream 仅用于"任务完成"类低频通知的离线补发（不做全量事件队列）。

## 明确不做

- 不在 harness 主机监听任何新端口；不碰 webserver 配置。
- 不做多用户/多租户：subject 命名空间即隔离边界。
- 不代理特权方法集（settings/credentials/agentPreset 创作面）：白名单直接不放行。
- 不传大文件（session.export 的 ZIP）：Hub max_payload 1 MiB，大文件需求未来用一次性 URL 方案。

## RPC 方法白名单（v1）

`host.describe`、`workspace.*`（受限于显式白名单）、`session.list/create/history/prompt/cancel/updateQueue/rename/fork/models/selectModel/search/attachment`、`file.upload`、`command.list/execute`、`reference.files/sessions`、`skill.list`、`goal.*`、`subagent.*`、`agentPreset.list/read/select`、`respond`。

白名单之外的请求返回 403 语义的 RPC 错误，与方法不存在区分。
