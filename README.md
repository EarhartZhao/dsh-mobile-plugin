# dsh-mobile-plugin

安装进本地 deepseek-harness `web` profile 的树外 Cordis 插件，为 [dsh-mobile](../dsh-mobile) 提供外网接入能力：出站连接 NATS，桥接当前 Typert Remote（RPC + 实时事件流），外加扫码配对与设备 token 认证。harness 主机零入站端口。

方案文档见 [docs/](docs/)：

- [00-plugin-plan.md](docs/00-plugin-plan.md) — 定位（NATS 出站桥）、架构、安装与里程碑
- [01-auth-pairing.md](docs/01-auth-pairing.md) — 认证与配对设计
- [02-nats-server.md](docs/02-nats-server.md) — 复用既有 NATS Hub 的改动清单（websocket/TLS/账号/Leaf 部署）

## 移动端兼容自述

`mobile.info` 是插件自有 RPC（需要设备 token），返回 `pluginVersion`、`mobileApi` 和 `features`。App 0.0.3 起要求 plugin 0.2.2、`mobileApi: 2`，并校验 Typert Remote v2、分页历史、`session/control`、`workspace/follow`、`$events/result` 和 `file-uploads` 等能力。0.2.3 起额外声明可选能力 `workspace-files`、`goal-state`、`open-path`，0.2.4 加 `workspace-watch`，0.2.5 加 `workspace-stat`，0.2.6 加 `message-feedback`；它们缺席时 App 只隐藏对应入口（例如浏览器不自动刷新、预览不比对版本直接重读、消息动作条不出现评分项），不判不兼容。这个字段独立于 `host.describe.version`——后者表示宿主 dsh 版本，不能用于判断移动桥能力。

0.2.6 另接入消息反馈：`feedback.list|put|delete` → `messageFeedback/list|put|delete`。宿主把 Like/Dislike 作为 durable 事实写入会话日志（`feedback/message-put|delete` 事件），并返回业务结果而非 Remote 错误；插件只做参数搬运，`ifVersion` 原样透传，冲突重试由 App 按返回的 `current.version` 完成。

plugin 0.2.6 通过 `connection.createSharedFetchHandler('/api')` 与 `typertGateway` 接入 dsh 0.1.5-rc.1（0.1.3-alpha.1 起接入面未变）；一元调用映射到当前 Remote，`session/follow`/`page` 提供主会话和完整 subagent address 历史，`session/follow` 额外适配 assistant stream，`session/control`/`workspace/follow` 提供实时 baseline，审批与提问通过同一 `$events` generation 的 `$events/result` 核销。`file.upload` 将移动端的小文件 base64 请求映射到 `fileUploads/upload`，返回 Agent-scoped receipt 供后续 prompt 使用。0.2.3 起接入三组 0.1.5 新面：`goal.get` → `goals/get`（进程内 activation）、`file.list|read|bytes|stat|related` → `workspaceFiles/list|read|readBytes|stat|readRelated`（workspace 相对路径，作用域由 `workspaceFileScopeId` 解析到会话 workspace root；`readRelated` 以某文件目录为基准，`stat` 只取版本与大小）、`file.reveal` 与 `host.openPath` → `session/openWorkspacePath`（`reveal` 定位 / 默认应用打开）。0.2.4 再接入 `file.watch` → `workspaceFiles/changes` 流：插件为会话保持一条变更流，并把它作为 `workspace-files/ready|change|watch-error` 转发事件投到宿主域下行帧（复用已发布的 `host/remote-event`，因为新增 mux 帧类型会被 App 的冻结 schema 丢弃）；开流前用 `session/list` 的 `cwd` 把变更的绝对路径补成 workspace 相对 `path`，App 据此只刷新受影响目录，取不到 `cwd` 时该字段缺省、客户端按"位置未知"一律重列。变更流按 LRU 上限 4 条管理：超限时释放最早接入的会话，`file.unwatch` 供 App 关闭浏览器时显式释放，Host generation 结束时统一释放并在重连后按最近接入顺序重武装。宿主未挂载 `workspaceFiles` 时这些方法按 Gateway 错误原样回传，App 侧按可选能力隐藏入口。

配置页提供“启动本地 NATS”按钮：它会在本机启动 `nats-server -c C:\\nats\\leaf.conf`，随后插件自动连接 `natsUrl`。可用 `NATS_SERVER_PATH` 和 `NATS_CONFIG_PATH` 环境变量覆盖默认的可执行文件和配置路径；该操作仅允许回环请求。

plugin 0.2 起提供可选的 `mobile.inventory`（需要设备 token），桥接宿主 `pluginInventory.list()`；App 在 `features` 含 `plugin-inventory` 时会在设置页显示只读插件清单。宿主未挂载清单服务时，设置页显示“当前桥未提供插件清单”，不影响连接和其它功能。

`mobile.health` 是需要设备 token 的只读诊断 RPC，返回当前桥连接状态、实际加载路径、构建 ID、实例 ID、有效设备数、启动及最近重连时间。NATS 连接要在 `flush()` 成功后才标记为已连接；Gateway 事件流失败时在同一 NATS generation 内退避重开，避免启动期服务抖动反复重建桥，并在对应流重新取得 ready/baseline 后清除已经恢复的最近错误。Web 设置卡显示同一份状态；响应和复制诊断均不包含 NATS 密码或设备 token。

## 已知边界

- **大文件不出网桥。** NATS 单条消息约 1 MiB：`file.read`/`file.bytes` 只传有界的页与窗口，而宿主的 `/api/file` HTTP 路由位于宿主机本地，手机经公网 Hub 够不到。要支持大文件需要 Hub 侧中继或局域网专用下载端点（带设备 token），目前未实现；App 对超出窗口的图片会明确提示，而不是渲染半张图。
- **目录列表没有游标。** `workspaceFiles/list` 按宿主 `maxEntries`（默认 2000）截断，插件只透传 `truncated`；缓解方式是调大宿主的 `workspaceFiles.maxEntries`。真正的续读需要上游先给文件系统 seam 的 `listDir` 加上限，再给 Remote 加 offset/游标。
- **CA 指纹没有强制。** 配对二维码里的 `caFp` 会被保存并出现在诊断里，但 RN 的 WebSocket 拿不到对端证书，校验需要原生实现；诊断 payload 显式带 `caFpEnforced: false`，不要把它当作已生效的信任锚。
- **后台推送未接入。** 审批/提问提醒目前只在 App 前台有效；系统级推送需要 FCM/APNs 凭据与宿主到推送服务的链路，插件只有 NATS 出站，没有可用凭据。
