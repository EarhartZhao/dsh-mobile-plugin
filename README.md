# dsh-mobile-plugin

安装进本地 deepseek-harness `web` profile 的树外 Cordis 插件，为 [dsh-mobile](../dsh-mobile) 提供外网接入能力：出站连接 NATS，桥接当前 Typert Remote（RPC + 实时事件流），外加扫码配对与设备 token 认证。harness 主机零入站端口。

方案文档见 [docs/](docs/)：

- [00-plugin-plan.md](docs/00-plugin-plan.md) — 定位（NATS 出站桥）、架构、安装与里程碑
- [01-auth-pairing.md](docs/01-auth-pairing.md) — 认证与配对设计
- [02-nats-server.md](docs/02-nats-server.md) — 复用既有 NATS Hub 的改动清单（websocket/TLS/账号/Leaf 部署）

## 移动端兼容自述

`mobile.info` 是插件自有 RPC（需要设备 token），返回 `pluginVersion`、`mobileApi` 和 `features`。App 0.2.0 要求 plugin 0.2.1、`mobileApi: 2`，并校验 Typert Remote v2、分页历史、`session/control`、`workspace/follow` 和 `$events/result` 等能力。这个字段独立于 `host.describe.version`——后者表示宿主 dsh 版本，不能用于判断移动桥能力。

plugin 0.2.1 通过 `connection.createSharedFetchHandler('/api')` 与 `typertGateway` 接入 dsh 0.1.2-alpha.5；一元调用映射到当前 Remote，`session/follow`/`page` 提供主会话和完整 subagent address 历史，`session/control`/`workspace/follow` 提供实时 baseline，审批与提问通过同一 `$events` generation 的 `$events/result` 核销。

plugin 0.2 起提供可选的 `mobile.inventory`（需要设备 token），桥接宿主 `pluginInventory.list()`；App 在 `features` 含 `plugin-inventory` 时会在设置页显示只读插件清单。宿主未挂载清单服务时，设置页显示“当前桥未提供插件清单”，不影响连接和其它功能。

`mobile.health` 是需要设备 token 的只读诊断 RPC，返回当前桥连接状态、实际加载路径、构建 ID、实例 ID、有效设备数、启动及最近重连时间。NATS 连接要在 `flush()` 成功后才标记为已连接；Gateway 事件流失败时在同一 NATS generation 内退避重开，避免启动期服务抖动反复重建桥，并在对应流重新取得 ready/baseline 后清除已经恢复的最近错误。Web 设置卡显示同一份状态；响应和复制诊断均不包含 NATS 密码或设备 token。
