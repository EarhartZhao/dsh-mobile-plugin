# dsh-mobile-plugin

安装进本地 deepseek-harness `web` profile 的树外 Cordis 插件，为 [dsh-mobile](../dsh-mobile) 提供外网接入能力：出站连接 NATS，桥接当前 Typert Remote（RPC + 实时事件流），外加扫码配对与设备 token 认证。harness 主机零入站端口。

方案文档见 [docs/](docs/)：

- [00-plugin-plan.md](docs/00-plugin-plan.md) — 定位（NATS 出站桥）、架构、安装与里程碑
- [01-auth-pairing.md](docs/01-auth-pairing.md) — 认证与配对设计
- [02-nats-server.md](docs/02-nats-server.md) — 复用既有 NATS Hub 的改动清单（websocket/TLS/账号/Leaf 部署）

## 移动端兼容自述

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

plugin 0.2.6 通过 `connection.createSharedFetchHandler('/api')` 与 `typertGateway` 接入 dsh 0.1.5-rc.1（0.1.3-alpha.1 起接入面未变）；一元调用映射到当前 Remote，`session/follow`/`page` 提供主会话和完整 subagent address 历史，`session/follow` 额外适配 assistant stream，`session/control`/`workspace/follow` 提供实时 baseline，审批与提问通过同一 `$events` generation 的 `$events/result` 核销。`file.upload` 将移动端的小文件 base64 请求映射到 `fileUploads/upload`，返回 Agent-scoped receipt 供后续 prompt 使用。0.2.3 起接入三组 0.1.5 新面：`goal.get` → `goals/get`（进程内 activation）、`file.list|read|bytes|stat|related` → `workspaceFiles/list|read|readBytes|stat|readRelated`（workspace 相对路径，作用域由 `workspaceFileScopeId` 解析到会话 workspace root；`readRelated` 以某文件目录为基准，`stat` 只取版本与大小）、`file.reveal` 与 `host.openPath` → `session/openWorkspacePath`（`reveal` 定位 / 默认应用打开）。0.2.4 再接入 `file.watch` → `workspaceFiles/changes` 流：插件为会话保持一条变更流，并把它作为 `workspace-files/ready|change|watch-error` 转发事件投到宿主域下行帧（复用已发布的 `host/remote-event`，因为新增 mux 帧类型会被 App 的冻结 schema 丢弃）；开流前用 `session/list` 的 `cwd` 把变更的绝对路径补成 workspace 相对 `path`，App 据此只刷新受影响目录，取不到 `cwd` 时该字段缺省、客户端按"位置未知"一律重列。变更流按 LRU 上限 4 条管理：超限时释放最早接入的会话，`file.unwatch` 供 App 关闭浏览器时显式释放，Host generation 结束时统一释放并在重连后按最近接入顺序重武装。宿主未挂载 `workspaceFiles` 时这些方法按 Gateway 错误原样回传，App 侧按可选能力隐藏入口。

## 首次配置（顺序不能颠倒）

手机连 Hub 用的是**插件里配置的 Hub 账号凭证**——它随配对二维码下发，App 不内置任何账号。所以首次必须先配置、再发码：

1. 打开设置里的「移动端」卡片（或 `http://127.0.0.1:3080/mobile-bridge`），填写 Hub 地址、账号、密码并保存。密码是 `role('secret')` 字段，落在 `$DSH_HOME/settings.yaml`；回环控制台会把已保存的密码预填并默认明文显示（带「隐藏」切换），方便当场核对是不是 Hub 上那个值——非本机请求只拿到"是否已配置"。
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

第三段是**只有凭证检查看不见**的故障：账号密码都对、插件状态也显示「已连接」（那只说明它连上了本机 NATS），但本机 Leaf 没连上 Hub，于是 Hub 上 `svc.dsh.{instance}.pair` 没有订阅者。检查的做法是另开一条直连 Hub 的连接，请 Hub 去请求本机实例的配对主题——复刻手机扫码走的那条路：有应答就是通，`503` 就是 Leaf 那段断了。

生成二维码时会自动跑这套检查：凭证被拒直接拒绝发码；`hub-path` 不通只警告不拦截，因为 Leaf 可能自行重连，而配对码 120 秒内都还有救。

配置页提供“启动本地 NATS”按钮：它会在本机启动 `nats-server -c C:\\nats\\leaf.conf`，随后插件自动连接 `natsUrl`。可用 `NATS_SERVER_PATH` 和 `NATS_CONFIG_PATH` 环境变量覆盖默认的可执行文件和配置路径；该操作仅允许回环请求。

plugin 0.2 起提供可选的 `mobile.inventory`（需要设备 token），桥接宿主 `pluginInventory.list()`；App 在 `features` 含 `plugin-inventory` 时会在设置页显示只读插件清单。宿主未挂载清单服务时，设置页显示“当前桥未提供插件清单”，不影响连接和其它功能。

`mobile.health` 是需要设备 token 的只读诊断 RPC，返回当前桥连接状态、实际加载路径、构建 ID、实例 ID、有效设备数、启动及最近重连时间。NATS 连接要在 `flush()` 成功后才标记为已连接；Gateway 事件流失败时在同一 NATS generation 内退避重开，避免启动期服务抖动反复重建桥，并在对应流重新取得 ready/baseline 后清除已经恢复的最近错误。Web 设置卡显示同一份状态；响应和复制诊断均不包含 NATS 密码或设备 token。

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
