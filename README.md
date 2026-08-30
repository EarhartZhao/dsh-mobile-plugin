# dsh-mobile-plugin

安装进本地 deepseek-harness `web` profile 的树外 Cordis 插件，为 [dsh-mobile](../dsh-mobile) 提供外网接入能力：出站连接公网 NATS 做内网穿透，桥接 harness `/api` 协议（RPC + 实时事件流），外加扫码配对与设备 token 认证。harness 主机零入站端口。

方案文档见 [docs/](docs/)：

- [00-plugin-plan.md](docs/00-plugin-plan.md) — 定位（NATS 出站桥）、架构、安装与里程碑
- [01-auth-pairing.md](docs/01-auth-pairing.md) — 认证与配对设计
- [02-nats-server.md](docs/02-nats-server.md) — 复用既有 NATS Hub 的改动清单（websocket/TLS/账号/Leaf 部署）

## 移动端兼容自述

`mobile.info` 是插件自有 RPC（需要设备 token），返回 `pluginVersion`、`mobileApi` 和 `features`。App 0.1.x 接受 plugin 0.1.x / 0.2.x / `mobileApi: 1`；缺失该响应按插件过旧处理。这个字段独立于 `host.describe.version`——后者表示宿主 dsh 版本，不能用于判断移动桥能力。

plugin 0.2 起提供可选的 `mobile.inventory`（需要设备 token），桥接宿主 `pluginInventory.list()`；App 在 `features` 含 `plugin-inventory` 时会在设置页显示只读插件清单。宿主未挂载清单服务时，设置页显示“当前桥未提供插件清单”，不影响连接和其它功能。
