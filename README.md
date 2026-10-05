# dsh-mobile-plugin

装进本地 deepseek-harness（dsh）`web` profile 的**树外 Cordis 插件**，为 [dsh-mobile](../dsh-mobile) 提供外网接入：插件主动出站连 NATS Hub，把宿主的 Typert Remote（RPC + 实时事件流）桥给手机，外加扫码配对与设备 token 认证。宿主不开任何入站端口、不需要公网 IP。

装好之后手机的链路是：手机 App —`wss://<hub-host>:8443`→ NATS Hub —`leaf:7422`→ 本机 NATS Leaf → 本插件 → 宿主的会话、审批、提问、文件与工具事件。Hub 从零搭到验收的完整教程见 [docs/03-nats-self-host.md](docs/03-nats-self-host.md)。

本仓库文档（怎么装、怎么配、为什么这么设计）：

- [00-plugin-plan.md](docs/00-plugin-plan.md) — 定位（NATS 出站桥）、架构、安装方式与里程碑
- [01-auth-pairing.md](docs/01-auth-pairing.md) — 双层凭证模型、配对流程、token 存储
- [02-nats-server.md](docs/02-nats-server.md) — 复用既有 NATS Hub 的改动清单（websocket/TLS/账号/Leaf 部署）
- [03-nats-self-host.md](docs/03-nats-self-host.md) — 自建 NATS 服务教程（Hub 从零 → 本机 Leaf → 插件配置 → 验收 → 故障排查）

## 快速开始

先备好三样东西：**能跑 `dsh web` 的这台电脑**、**Hub 地址 + C 端账号密码**（部署 NATS Hub 的人给）、**Hub 的 `ca.crt`**（Hub 用公共 CA 签发就跳过）。然后四步：

1. **装。** 侧边栏 →「插件」，在安装框里填包名 `@dsh-earhartzhao/dsh-mobile-plugin`（也可以填 git 地址或本地路径，见[安装](#安装)），宿主先 inspect 再交给 pnpm 安装。
2. **启用。** 装好后点「启用」——它把包名写进 profile 的 `dsh.profile.bundles`，bundle 自带的 `mobile-bridge` 那一行这才生效（没启用时 `/mobile-bridge` 直接 404）。
3. **配置。** 打开「插件 → `@dsh-earhartzhao/dsh-mobile-plugin`」的配置区，或直接开回环控制台 `http://127.0.0.1:3080/mobile-bridge`，填 Hub 地址、账号、密码、CA 后保存。
4. **发码。** 状态显示「已连接」后点「生成配对二维码」，用手机 App 扫。

顺序不能颠倒：手机用的是**插件里配的那组 Hub 凭证**，它随二维码下发，App 不内置任何账号。每一步的字段与排错见[首次配置](#首次配置顺序不能颠倒)。

## 安装

本仓库是**树外插件**，不在 dsh 官方 bundle 里。本包声明了 `dsh.bundle`（随包发布的 `cordis.patch.yml` 提供 `mobile-bridge` 那一行），所以安装要做的就是**把包放进 profile 依赖并启用它**。四种装法，按省事程度排：

### 方式 A：npm（推荐）

```bash
pnpm add @dsh-earhartzhao/dsh-mobile-plugin
# 或钉住某个版本：
pnpm add @dsh-earhartzhao/dsh-mobile-plugin@0.2.27
```

registry 上放的是发包时打好的 tarball，里面已经有 `lib/`——`prepare` 只在**发布那一刻**跑，安装时不跑，所以没有任何构建脚本要批准（不需要 `allowBuilds`），也完全不碰 GitHub（registry 还能走镜像）。插件页的「按包名安装」走的就是这条路。控制台的「检查更新」对 registry spec 去问 `dist-tags.latest`，再按 `<包名>@<最新版>` 重装（`registrySpec` / `updateSpec`）。

### 方式 B：Release 预构建 tarball

```bash
pnpm add https://github.com/EarhartZhao/dsh-mobile-plugin/releases/download/v0.2.25/dsh-mobile-plugin-0.2.25.tgz
```

打 tag 时 CI（`.github/workflows/release.yml`）会 `pnpm pack` 出带 `lib/` 的包，把 `dsh-mobile-plugin-<version>.tgz` 与版本无关的 `dsh-mobile-plugin.tgz` 一起挂到该 tag 的 Release。装它不需要任何 `allowBuilds`，`…/releases/latest/download/dsh-mobile-plugin.tgz` 永远指向最新稳定版（带 `-rc` 的 tag 标成 pre-release，不会顶掉它）。控制台的「检查更新」认这种装法：更新时把 URL 里的 tag 换成最新版本，文件名里嵌的旧版本号一并替换（`src/update.ts` 的 `releaseAssetSpec`）——不换 URL 就换不掉 pnpm 的 integrity，会拿回旧字节。代价是那台机器得够得着 GitHub（源码 tarball 走 codeload、资产走 releases，两个域名）。

### 方式 C：git 源码（每台机器、每个 commit 都要批准一次构建）

```bash
pnpm add github:EarhartZhao/dsh-mobile-plugin          # 或 https://github.com/EarhartZhao/dsh-mobile-plugin.git
```

仓库 `.gitignore` 忽略 `lib/`，所以本包用 `prepare` 在安装时现场编译。pnpm ≥10 默认拦下依赖的构建脚本：第一次装必然失败（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），并打印一条带 spec 与 commit 的精确键，把它抄进 profile 的 `pnpm-workspace.yaml` 再装一次：

```yaml
# $DSH_HOME/profiles/<profile>/pnpm-workspace.yaml
allowBuilds:
  'dsh-mobile-plugin@https://codeload.github.com/<owner>/dsh-mobile-plugin/tar.gz/<sha>': true
```

这条键跟着 **commit** 走，**每发一个新版本都会再来一次**——所以给别人机器装优先 A 或 B。细节见 [00-plugin-plan.md](docs/00-plugin-plan.md#从-git-安装prepare-补上缺失的构建2026-09-30)。

### 方式 D：开发机用 `link:` 引用本仓库

```jsonc
// $DSH_HOME/profiles/<profile>/package.json
{
  "dependencies": { "@dsh-earhartzhao/dsh-mobile-plugin": "link:<本仓库路径>" }
}
```

必须用 `link:` 而不是 `file:`：`file:` 是打包拷贝，源码改动后 pnpm 不重打包，旧副本会静默残留；`link:` 指回仓库活目录（`nats`/`qrcode` 从仓库 `node_modules` 解析，`@deepseek-ai/cordis` 这些 peer 靠 `Symbol.for` 全局符号与宿主互操作）。另外宿主启动时会按 profile 依赖做一次同步安装，pnpm 可能把它物化成**副本**而不是 junction——副本让后续源码改动不生效，症状是插件版本不跟随或 `/mobile-bridge` 404，在 profile 目录里重跑一次 `pnpm install` 即可恢复成 junction。**Windows 上用 `link:` 时本仓库 `node_modules` 必须无符号链接**：profile 的 `nodeLinker` 是 `hoisted`，每次安装都会复制整个仓库目录，复制里遇到符号链接就要重建，而非提权的 dsh 宿主没有建符号链接的权限，会以 `ERR_PNPM_EPERM` 失败（界面只显示「没有写入权限，无法安装」）。本仓库因此在 `pnpm-workspace.yaml` 固定 `nodeLinker: hoisted`，别把它删掉。

### 装完必须「启用」

bundle 的 patch 层只在包名被列进 profile 的 `dsh.profile.bundles` 时才应用——插件页的「启用」写的就是这个列表，手工装的话就自己加进去。没启用时那一行根本不存在，`/mobile-bridge` 会直接 404，宿主启动日志里则是一句 `skipping profile bundle "@dsh-earhartzhao/dsh-mobile-plugin"`（如果原因写的是 `declares no dsh.bundle`，意味着 profile 里物化的那份包是旧副本，见方式 D）。

装好后 `mobile-bridge` 这一行由包自带的 patch 提供（只有非密默认值：`natsUrl` 与 `instanceId`，凭证留空）。**每个部署的值用 profile patch 按 id 覆盖**：写成 `- id: mobile-bridge` 加 `name: @dsh-earhartzhao/dsh-mobile-plugin` 加 `config:`，**不要再套 `insert:`**——无 id 的 insert 是追加，会和包自带那行变成两行同 id。控制台「保存」写的是**同一个 profile patch** 里那条覆盖行的 `config:`（宿主 `configEditor` 落盘），优先于组合层；因为字段都声明为 schema-volatile，保存不会重启宿主，插件就地重建 NATS 桥。

**旧写法由插件自动修正。** 如果 profile 是用 `insert:` 手工挂的这一行（早期文档和从 `$DSH_HOME/settings.yaml.imported` 搬迁都这么写），宿主的整包与行开关都管不了它：包名不在 `dsh.profile.bundles` 里，所以整包开关是关的；行开关只在整包启用时才渲染，于是也看不到；点卸载则直接报 `bundle-in-use`，因为这一行不是组合包提供的，关掉组合包它仍然在。插件加载时会把这种形态改回组合包形态，分两步、只改 profile 的两个文件、配置值一个不丢：① 把包名补进 `dsh.profile.bundles`（这一条到下**一次启动**才生效，本次不动正在运行的行）；② 重启后行已由组合包提供，再把 profile patch 里的 `insert` 改成按 id 的覆盖行。关掉配置项 `autoMigrateProfile` 可以让插件完全不碰 profile 文件，改由控制台页上的「修复安装形态」按钮手动触发。

### 从裸包名迁移（0.2.26 及更早装过的话）

0.2.26 之前包名是 `dsh-mobile-plugin`，0.2.27 起是 `@dsh-earhartzhao/dsh-mobile-plugin`（npm 组织只收 scoped 包）。这一步**重装不够**：profile 里那条覆盖行是**按 id 加包名断言**匹配的（宿主 `packages/boot/plugin-manager/README.md`：*Matching uses the entry id and any module-name assertion*），裸名的 `name: 'dsh-mobile-plugin'` 换了包就不再匹配任何条目，它下面的 Hub 地址、账号、密码、CA 会**静默失效**——而且插件自己修不了，失配的那一轮里插件根本没被加载。停掉 dsh 后跑一次迁移脚本即可：

```bash
# 先停掉 dsh；脚本会把 dsh.profile.bundles 里的裸名原地换成 scoped 名
node scripts/migrate-to-scoped.mjs ~/.dsh/profiles/web
```

脚本做四件事：装 scoped 包、把 `dsh.profile.bundles` 里的裸名**原地**换掉（列表顺序就是配置优先级，不能改位置）、改写 profile patch 里每一处 `id: mobile-bridge` 行的 `name`（顶层覆盖行与 `insert:` 里的行都改，注释不丢）、移除旧依赖。改 patch 之前会把原文件备份成 `cordis.patch.yml.bak`（那里面有明文密码）。只改文件、安装自己负责就加 `--no-install`；换安装源用 `--spec <spec>`，默认是 npm 上的 scoped 包。

### 手工写 profile（不用插件页）

在 `$DSH_HOME/profiles/<profile>` 里做三件事：把本包加成依赖、把包名加进 `dsh.profile.bundles`、在 profile 自己的 `cordis.patch.yml` 写一条**按 id 的覆盖**：

```jsonc
// package.json
{
  "dependencies": { "@dsh-earhartzhao/dsh-mobile-plugin": "link:<本仓库路径>" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@dsh-earhartzhao/dsh-mobile-plugin"
  ] } }
}
```

```yaml
# cordis.patch.yml：这一行由组合包提供，这里只覆盖它的配置
- id: mobile-bridge
  name: '@dsh-earhartzhao/dsh-mobile-plugin'
  config:
    natsUrl: 'nats://127.0.0.1:4222'
    hubWssUrl: 'wss://<hub-host>:8443'
    hubUser: '<c-end 账号>'
    instanceId: 'home'
```

依赖用 `link:<本仓库路径>`（开发机）或 git/tarball/npm spec（其它机器）。

## 首次配置（顺序不能颠倒）

手机连 Hub 用的是**插件里配置的 Hub 账号凭证**——它随配对二维码下发，App 不内置任何账号。所以首次必须先配置、再发码：

1. 打开**侧边栏 → 插件 → `@dsh-earhartzhao/dsh-mobile-plugin`** 的配置区（dsh 0.1.7 起插件配置从「设置」搬到了插件页，旧的 `settings.plugin.item` 卡片槽位已退役；也可以直接打开回环控制台 `http://127.0.0.1:3080/mobile-bridge`），填写 Hub 地址、账号、密码，并把 Hub 的 `ca.crt` 粘进 CA 字段后保存。密码是 `role('secret')` 字段，明文落在 profile 的 `cordis.patch.yml`；回环控制台会把已保存的密码预填并默认明文显示（带「隐藏」切换），方便当场核对是不是 Hub 上那个值——非本机请求只拿到"是否已配置"（点「显示」时才走一次 `/api/reveal`）。Hub 地址可以直接粘 `wss://<host>:8443`，也可以只填主机或 IP：缺 scheme 补 `wss://`，`wss://` 缺端口补 `8443`。
2. 确认状态为「已连接」（本地 NATS 就绪）。
3. 再点「生成配对二维码」。

任一凭证没配时，「生成配对二维码」按钮会被禁用，`/mobile-bridge/api/pair` 也会直接返回未配置的字段清单。这是刻意的：否则二维码虽然扫得进 App，手机连 Hub 只会拿到 `Authorization Violation`，还白白占掉一个待核销配对码。

### 「测试 Hub 账号」查的是整条链路

配对跨三段，任何一段断了手机都会失败，所以这个按钮逐段检查、分别给结论：

| 段 | 含义 | 断了的表现 |
|---|---|---|
| `local` | 本机移动端桥 → 本机 NATS | 手机扫码连不上宿主 |
| `credentials` | 本机 → Hub（二维码里那组账号） | 手机报 `Authorization Violation` |
| `hub-path` | Hub → 本机实例（本机 Leaf 是否已桥接到 Hub） | 手机报 `503`（NATS 无人响应） |
| `certificate` | 二维码要带的 CA ↔ Hub 实际出示的证书 | 手机卡在 TLS 握手，报「无法连接公网 NATS」 |

第三段是**只有凭证检查看不见**的故障：账号密码都对、插件状态也显示「已连接」（那只说明它连上了本机 NATS），但本机 Leaf 没连上 Hub，于是 Hub 上 `svc.dsh.{instance}.pair` 没有订阅者。检查的做法是另开一条直连 Hub 的连接，请 Hub 去请求本机实例的配对主题——复刻手机扫码走的那条路：有应答就是通，`503` 就是 Leaf 那段断了。

第四段是**只有手机能遇到、也只有手机看不见原因**的故障：App 不内置任何 CA，信任完全来自二维码里的 `ca` 字段，所以 Hub 用自签证书而字段是空的，每次扫码都会死在握手上，手机上只显示一句「无法连接公网 NATS」。因此 CA 字段为空时这个按钮不会直接放过：它会拿系统信任库向 Hub 的 WSS 端口做一次握手，公共 CA 签发的报 `public-ca`（二维码不带证书也能连），自签的报告「手机每次扫码都会卡在 TLS 握手上」并把这一行判为失败。

生成二维码时会自动跑这套检查：凭证被拒直接拒绝发码；`hub-path` 不通只警告不拦截，因为 Leaf 可能自行重连，而配对码 120 秒内都还有救。

### 本机 NATS：配置页的「启动本地 NATS」

这个按钮先探测 `natsUrl` 的端口，已经在监听就直接复用（本机 Leaf 可能是手工、服务管理器或上一次 dsh 启动的，那种情况根本不需要配置文件）；否则在本机启动 `nats-server -c <配置文件>`，随后插件自动连接 `natsUrl`。**两条路径都不写死**，按 `NATS_CONFIG_PATH` / `NATS_SERVER_PATH` 环境变量 → 控制台「本地 NATS 配置文件」/「nats-server 路径」字段 → 自动查找的顺序定；自动查找依次看 `$DSH_HOME/mobile-bridge/`、本项目的 `~/.nats-leaf/`（配置与二进制同目录）、`~/.config/nats/`，再按平台补 macOS 的 Homebrew 前缀、Linux 的 `/etc/nats`、Windows 的 `C:\\nats`（可执行文件最后回落到 `PATH`）。控制台状态行显示最终选中的两条路径以及它们是否存在，找不到时报错会列出查找过的全部候选。该操作仅允许回环请求。

### 插件自述与诊断（App 侧）

plugin 0.2 起提供可选的 `mobile.inventory`（需要设备 token），桥接宿主 `pluginInventory.list()`；App 在 `features` 含 `plugin-inventory` 时会在设置页显示只读插件清单。宿主未挂载清单服务时，设置页显示“当前桥未提供插件清单”，不影响连接和其它功能。

`mobile.health` 是需要设备 token 的只读诊断 RPC，返回当前桥连接状态、实际加载路径、构建 ID、实例 ID、有效设备数、启动及最近重连时间。NATS 连接要在 `flush()` 成功后才标记为已连接；Gateway 事件流失败时在同一 NATS generation 内退避重开，避免启动期服务抖动反复重建桥，并在对应流重新取得 ready/baseline 后清除已经恢复的最近错误。Web 设置卡显示同一份状态；响应和复制诊断均不包含 NATS 密码或设备 token。

## 凭证放哪：配置分层与推荐做法

各层各司其职：

| 层 | 位置 | 该放什么 |
|---|---|---|
| 组合层 | bundle / profile 的 `cordis.patch.yml` | 结构与非密默认值：`natsUrl`、`hubWssUrl`、`instanceId`、TTL。**不放真实密码** |
| 用户层 | profile 自己的 `cordis.patch.yml` 里 `- id: mobile-bridge` 覆盖行的 `config:` | 本机用户自己的值；控制台「保存」写的就是这一层（宿主 `configEditor` 落盘） |
| 引用层（官方推荐） | credentials seam：`dsh-credentials-local`（`.credentials.yaml`）、进程环境或 `.env` | 真正的密文；配置里只留引用名 |

`hubPass` 是 `z.string().role('secret')`（见 `src/config.ts`）。`role('secret')` 只保证**不把默认值带进表单、不下发到 wire**——宿主 `redactSecrets` 会把值换成占位，所以非本机请求只拿得到「是否已配置」。值本身仍以明文写在 profile 的 `cordis.patch.yml`（就是上面那条覆盖行），跟着 profile 一起被备份/搬迁，别把这份文件提交到任何仓库。

dsh 另有一条专门的凭据 seam（`docs/subsystems/credentials.md`），原则是「**secret 不进配置**」：settings 与 `cordis.yml` 只写引用名（环境变量名），值由 `@deepseek-ai/dsh-credentials-local` 这类 provider 持有，消费方按需 `ctx.credentials.resolve(ref)`，配置 UI 只用 `describe(ref)` 报「是否配置 / 来源 / 可写」，永不回显值。需要同步、共享或渲染配置 UI 的部署，官方推荐走这条。

按 seam 迁移的方向（**尚未实现**）：

| 现在 | 迁移后 |
|---|---|
| `hubPass: z.string().role('secret')` | `hubPassRef: z.string().default('DSH_MOBILE_HUB_PASS')`，值走 `ctx.credentials.set/unset` |
| 控制台预填并明文显示密码 | 控制台显示「已配置 / 来源 / 可写」+「设置 / 清除」按钮 |
| 启动时读一次配置 | 每次发码与 hub-check 前 `resolve` 一次，轮换凭证无需重启 |

代价也要说清楚：现在的回环控制台会把已保存的密码预填、默认明文显示，方便当场核对是不是 Hub 上那个值；改走 seam 之后这条路没有了，只能看到「已配置」，值只能由 bridge 自己在发码时 resolve。

## 已知边界

- **大文件不出网桥。** NATS 单条消息约 1 MiB：`file.read`/`file.bytes` 只传有界的页与窗口，而宿主的 `/api/file` HTTP 路由位于宿主机本地，手机经公网 Hub 够不到。要支持大文件需要 Hub 侧中继或局域网专用下载端点（带设备 token），目前未实现；App 对超出窗口的图片会明确提示，而不是渲染半张图。
- **目录列表没有游标。** `workspaceFiles/list` 按宿主 `maxEntries`（默认 2000）截断，插件只透传 `truncated`；缓解方式是调大宿主的 `workspaceFiles.maxEntries`。真正的续读需要上游先给文件系统 seam 的 `listDir` 加上限，再给 Remote 加 offset/游标。
- **CA 指纹没有强制。** 配对二维码里的 `caFp` 会被保存并出现在诊断里，但 RN 的 WebSocket 拿不到对端证书，校验需要原生实现；诊断 payload 显式带 `caFpEnforced: false`，不要把它当作已生效的信任锚。
- **后台推送未接入。** 审批/提问提醒目前只在 App 前台有效；系统级推送需要 FCM/APNs 凭据与宿主到推送服务的链路，插件只有 NATS 出站，没有可用凭据。
- **变更流不是文件系统监视器。** 宿主只把它自己 instrumented 的 `fs/observed` 操作（agent 工具读写）变成 `workspace-files/change` 帧，不监听操作系统；别的程序在宿主上直接改文件不会触发刷新。真机联调实测确认，探针见 `scripts/watch-probe.mjs`。

## 联调验收

两脚本对**运行中的宿主 + 本地 NATS**做端到端验收（token 用 `DSH_MOBILE_TOKEN` 或 `DSH_MOBILE_TOKEN_FILE`，后者由 `fake-app.mjs` 首次配对后写入，避免反复占用 `maxDevices`）：

```sh
node scripts/fake-app.mjs      nats://127.0.0.1:4222 <pairCode> home   # 门控 + mobile.info/goal.get/feedback.list/file.list|read|stat|watch|unwatch
node scripts/watch-probe.mjs   nats://127.0.0.1:4222 home <scratchPath> # file.watch → ready 转发 → file.unwatch 释放
```

## 移动端兼容与版本记录

`mobile.info` 是插件自有 RPC（需要设备 token），返回 `pluginVersion`、`mobileApi` 和 `features`。App 0.0.3 起要求 plugin 0.2.2、`mobileApi: 2`，并校验 Typert Remote v2、分页历史、`session/control`、`workspace/follow`、`$events/result` 和 `file-uploads` 等能力。0.2.3 起额外声明可选能力 `workspace-files`、`goal-state`、`open-path`，0.2.4 加 `workspace-watch`，0.2.5 加 `workspace-stat`，0.2.6 加 `message-feedback`，0.2.7 加 `workspace-unarchive`；它们缺席时 App 只隐藏对应入口（例如浏览器不自动刷新、预览不比对版本直接重读、消息动作条不出现评分项），不判不兼容。这个字段独立于 `host.describe.version`——后者表示宿主 dsh 版本，不能用于判断移动桥能力。

0.2.6 另接入消息反馈：`feedback.list|put|delete` → `messageFeedback/list|put|delete`。宿主把 Like/Dislike 作为 durable 事实写入会话日志（`feedback/message-put|delete` 事件），并返回业务结果而非 Remote 错误；插件只做参数搬运，`ifVersion` 原样透传，冲突重试由 App 按返回的 `current.version` 完成。

0.2.7 接入 `workspace.unarchiveSession` → `workspace/unarchiveSession`（dsh 0.1.6 新增的 Remote），把归档会话恢复到列表；白名单与 direct-request 映射同步更新，能力位 `workspace-unarchive` 让 App 在旧插件上隐藏该入口。

0.2.8 适配 dsh 0.1.6-alpha.2 删除的 `session/control` 队列帧：宿主改为只发布会话的 `inbox` 投影（Web 端就读它），插件把该投影翻译回既有的 `session/queue` 帧，App 的队列 UI 与冻结 wire 都不用改；`inbox` 投影只在会话挂着活动 Agent 时存在，与 alpha.1 的 `queues[session]` 语义一致。同时把宿主 0.1.6-alpha.2 新增转发的 `plugin-manager/changed|install-state|install-log` 事件透传到既有的 `host/remote-event`（本身无需改动，只是登记在案），App 插件页据此免手动刷新。

0.2.9 适配 dsh 0.1.7（`dsh-v0.1.7-rc.2` 及之后的 dev）四处破坏性变更，全部收在桥内，移动 wire 不变：

1. `TypertGatewayWireStream.open` 在 signal 之前新增了 Client uplink 与 Peer，第三个位置参数从 signal 变成 uplink。插件按声明 arity 选择调用形状（`openEventStream`），旧宿主仍走三参数形式——否则宿主会拿 AbortSignal 当 uplink，`$events` 报 `signals[0] must be an instance of AbortSignal`，审批、提问与全部转发事件一起失效。
2. `workspaceFiles/readBytes` 把字节窗口从顶层 `range` 移进 `options`，并把 `data` 从 base64 字符串改成原生字节；`readRelated` 被折进 `readBytes` 的 `options.baseFile`。插件改用新形状并把 `data` 重新编码成 base64，宿主回 `gateway/arguments-invalid` 或 `gateway/invocation-unavailable` 时自动退回旧形状（`readBytes` 顶层 range / `readRelated`）。
3. `workspaceFiles/changes` 现在按**单个目标**（文件或某目录自身）watch，`path` 必填。`file.watch`/`file.unwatch` 因此接受可选的 workspace 相对 `path`（默认工作区根），桥按 (session, path) 保留最多 4 条流、LRU 释放；App 浏览目录时会带着当前目录重新挂流。
4. `subagents/list` 被删除：子代理目录改为父会话的 `subagentCatalog` 投影（durable 事件 `subagent/catalog`），可由 `session/projections` 在不激活 Agent 的情况下读取。插件把投影行与 `session/list` 的 `running`/`agentAvailable`/`parentSessionId` 合成 App 冻结的目录（`kind`/`mode`/`label`/`activity`/`hasChildren`/`parentAvailable`）；宿主不认识 `session/projections` 时回退到旧的 `subagents/list`。
5. `session/control` 的 jobs 基线表与 `{type:'jobs'}` 帧被删除，改为 `job` 命名空间（Service 名 `jobController`）的 `list` 流：整集替换、开流即首帧。插件在 App 打开某个会话时（`session.history`）挂一条 roster 流，翻译回既有的 `session/jobs` 帧，旧宿主仍走 control 帧。

0.2.10 开始填 `session/event` 帧的 `view` 槽（`src/tool-views.ts`）：宿主进程内按 Agent scope 调用每个工具声明的 `presentCall`/`presentResult`，把 Terminal/Diff/Read/Search/Web 这些声明式卡片真正送给 App。此前该槽无人填——Web 端用自己的 `ui-tool` 卡片模型从工具名、参数与结果 `meta` 现场推导，手机没有工具定义，于是所有工具卡在真机上都退化成了原文。要点有二：

1. 工具注册表按 **Agent scope** 注册（内置 `read`/`pwsh` 等都在 scope 层），只查 `ctx.tools.get(name)` 会得到"未注册"；桥用 `ctx.agents.get(sessionId)` 取该会话的 Agent 作为 scope，全局层仅作兜底。
2. 不猜：无注册表、未注册、无 presenter、参数不是 JSON、presenter 抛错，一律返回"无 view"，App 回退原文；每种原因在宿主日志里各打一行（首次出现才打），便于定位"某个工具为什么显示成原文"。

0.2.22 修好「控制台保存后不落盘、重启就回到空配置」的真 bug，移动端 wire 不变：

1. 写入路径原来是 `settings.register(ns, schema, { base })`。dsh 0.2.0-rc.2 的 `settings` 服务（`SettingsForms`）没有这个方法——它按 profile entry 的 Config schema 自动派生命名空间——所以那句在 `ctx.inject` 回调里抛错被吞掉，插件退回内存分支，保存只改内存。现在走宿主既有的面：schema 里每个字段声明 `.volatile()`，保存改成 `settings.update('mobile-bridge', patch)`，由宿主 `configEditor` 写进 profile 的 `cordis.patch.yml`（按 id 的覆盖行）。
2. 保存不再重启宿主插件：字段是 schema-volatile，宿主把新值**就地**提交进运行实例的配置引用并发 `loader/volatile-update`，插件重读引用、只重建 NATS 桥。`configure({ auto: false })` 让这个实例不出现在自动生成的设置页上——回环控制台仍是唯一表单，避免两份配置界面。
3. 配置落盘位置随之改变：不再写 `$DSH_HOME/settings.yaml`（那是宿主早期版本的行为），而是 profile 自己的 `cordis.patch.yml`。
4. 依赖面抬到宿主真正实现这条路径的版本：`@deepseek-ai/cordis ^4.0.4`、`@deepseek-ai/schemastery ^3.18.4`、`@deepseek-ai/cosmokit ^1.8.5`（`.volatile()` / `isVolatile`）。

0.2.14 在 dsh **0.2.0-rc.2**（2026-09-30 核对）上复核通过，**零破坏**：冻结移动 wire（36 文件）与 51 个 Remote endpoint 全部命中，移动端相关包无删除/重命名，durable 事件词汇表（`known-event-types.ts`）、宿主可转发事件名单（`remote-events.ts`）、会话格式（仍是 v4）与 `agent-tool-presentation` 均未变；`api/gateway` 只新增 `hasLiveClient()`，移动侧不依赖。区间内唯一实质变化在宿主 interaction：新增 `questions` 会话投影与 `ask_user_question` 的 timed 模式（`mode: 'legacy' | 'timed'`，默认 legacy；请求多一个可选 `wait`；超时后工具返回 `{ pending: true, callId }`，答复改为进 inbox 的 `user-question-reply`），当前没有 bundle 打开它，故移动端行为不变——若要接投影或补手机端倒计时 UI，见 dsh-mobile 的 `docs/04-feature-gap.md`。

plugin 0.2.6 通过 `connection.createSharedFetchHandler('/api')` 与 `typertGateway` 接入 dsh 0.1.5-rc.1（0.1.3-alpha.1 起接入面未变）；一元调用映射到当前 Remote，`session/follow`/`page` 提供主会话和完整 subagent address 历史，`session/follow` 额外适配 assistant stream，`session/control`/`workspace/follow` 提供实时 baseline，审批与提问通过同一 `$events` generation 的 `$events/result` 核销。`file.upload` 将移动端的小文件 base64 请求映射到 `fileUploads/upload`，返回 Agent-scoped receipt 供后续 prompt 使用。0.2.3 起接入三组 0.1.5 新面：`goal.get` → `goals/get`（进程内 activation）、`file.list|read|bytes|stat|related` → `workspaceFiles/list|read|readBytes|stat|readRelated`（workspace 相对路径，作用域由 `workspaceFileScopeId` 解析到会话 workspace root；`readRelated` 以某文件目录为基准，`stat` 只取版本与大小）、`file.reveal` 与 `host.openPath` → `session/openWorkspacePath`（`reveal` 定位 / 默认应用打开）。0.2.4 再接入 `file.watch` → `workspaceFiles/changes` 流：插件为会话保持一条变更流，并把它作为 `workspace-files/ready|change|watch-error` 转发事件投到宿主域下行帧（复用已发布的 `host/remote-event`，因为新增 mux 帧类型会被 App 的冻结 schema 丢弃）；开流前用 `session/list` 的 `cwd` 把变更的绝对路径补成 workspace 相对 `path`，App 据此只刷新受影响目录，取不到 `cwd` 时该字段缺省、客户端按"位置未知"一律重列。变更流按 LRU 上限 4 条管理：超限时释放最早接入的会话，`file.unwatch` 供 App 关闭浏览器时显式释放，Host generation 结束时统一释放并在重连后按最近接入顺序重武装。宿主未挂载 `workspaceFiles` 时这些方法按 Gateway 错误原样回传，App 侧按可选能力隐藏入口。

0.2.14 让这个包成为可被插件页管理的组合包（bundle），移动端 wire 不变：

1. 包内新增 `cordis.patch.yml`，声明 `mobile-bridge` 那一行（只带非密的 `natsUrl` 与 `instanceId`，凭证留空）；package.json 补 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，并把该文件加进 `files`。此前宿主在插件页 inspect 时会以「这个包没有声明组合包，不能作为插件管理」拒掉。
2. 每个部署的 Hub 凭证仍由部署方提供：profile patch 按 id 覆盖这一行（`- id: mobile-bridge` + `name` + `config:`，不要用 `insert:`），或者装好后在控制台里填（同样写进 profile patch 的那条覆盖行）。

0.2.13 三处收口，移动端 wire 不变：

1. Hub 密码不再随每 5 秒的状态轮询下发：`/api/status` 只回「是否已配置」，新增 `POST /api/reveal`（走改状态那道门）供控制台点「显示」时按需取一次。密码此前常年挂在后台响应里，本机任意进程随时可以读到。
2. 迟到回答的消解帧改成回真实结果：审批按 App 的词表回 `allowed-once`/`rejected`/`cancelled`/`unavailable`（此前一律 `cancelled`，把「允许一次」标成了取消），提问按 `answered`/`cancelled`；词表外的值仍降级为 `cancelled`，避免 App 的 schema 拒帧。
3. 下行流重试改成指数退避（1 秒起、逐次翻倍、上限 30 秒），且一次故障只发一帧 `stream/error`（原来每次重试都发，流长期挂掉时每秒刷一帧）；流恢复后再次故障会重新计一次。

0.2.12 收口一轮评审发现的问题，移动端 wire 不变：

1. 回环控制台的每个 JSON 路由都要过统一的门：peer 必须是回环、`Host` 必须是本机名（挡 DNS rebinding）、`Origin` 必须同源；改状态的请求还要带 `x-dsh-mobile-console: 1` 和 JSON body（浏览器里属非简单请求，跨站页面无法盲发）。此前只有「启动本地 NATS」检查来源，改配置、吊销设备、发配对码三条路都没有。
2. 「启动本地 NATS」改成按端口就绪判定：先探测客户端端口是否已在监听（已有 NATS 就不再起第二个进程），启动后等它真正开始监听；子进程提前退出会带回退出码和排查提示，不再把「进程随后退出」报成成功。
3. 删掉配对码里从未自增的 `failures` 计数——`MAX_PAIRING_FAILURES` 是一道不存在的保护。实际保护是 32^8 的码空间、120 秒有效期、同时最多 3 个待用码。
4. `session/follow` 流加上 16 条上限（LRU，按最近打开淘汰）：此前浏览大量会话与子代理会一直累积宿主流，文件（4）和作业（8）本来就有上限。
5. `$events` 打开的 arity 嗅探补了兜底：声明参数个数骗人时（例如 rest 参数报 0），第一种调用形状被拒就改用另一种，不再让审批、提问和全部转发事件一起失效。
6. 设备台账上限 200 条（吊销/过期记录仍保留作历史，只是不再无限增长）、历史游标上限 64 条、子代理目录改成一次遍历加 Map（原来是每个子项扫一遍会话列表）、`host.describe` 的版本改读宿主 `package.json`（之前恒为 `dev`）。

0.2.11 修两处跟宿主演进有关的接入问题，移动端 wire 不变：

1. dsh 0.1.7 起把插件配置从「设置」搬到了侧边栏的「插件」页，`settings.plugin.item` 槽位退役。浏览器半边改为注册进 `plugins.bundle.config`（以包名为 key），渲染在 bundle 详情页的配置区；`dsh.client.inject` 相应改为 `@deepseek-ai/dsh-client-ui-plugin-manager`。
2. profile 用 `nodeLinker: hoisted` 加 `link:` 引用本仓库时，pnpm 会把整个目录复制进 profile，本仓库 `node_modules` 里的符号链接在非提权的 dsh 宿主上无法重建，安装会以 `ERR_PNPM_EPERM` 失败。本仓库因此改用 `nodeLinker: hoisted`，保持目录无符号链接。

0.2.27 把这个包发到 npm（组织 `dsh-earhartzhao`），包名随之从 `dsh-mobile-plugin` 改成 `@dsh-earhartzhao/dsh-mobile-plugin`，移动端 wire 不变：npm 组织只收 scoped 包，而「装 npm 包」是别的机器最省事的一条路——git 源要 `allowBuilds`，Release 资产要那台机器够得着 GitHub，registry 两者都不用。改名对已装的 profile 不是无痛的：那条覆盖行按「id + 包名断言」匹配，裸名的 `name:` 行换了包就不再匹配任何条目，它下面的 Hub 地址、账号、密码、CA 会**静默失效**，而插件在失配的那一轮里根本没被加载、无从自愈——所以换法是迁移 profile（`scripts/migrate-to-scoped.mjs`），见上文「从裸包名迁移」。
