# dsh-mobile-plugin

安装进本地 deepseek-harness `web` profile 的树外 Cordis 插件，为 [dsh-mobile](../dsh-mobile) 提供外网接入能力：出站连接公网 NATS 做内网穿透，桥接 harness `/api` 协议（RPC + 实时事件流），外加扫码配对与设备 token 认证。harness 主机零入站端口。

方案文档见 [docs/](docs/)：

- [00-plugin-plan.md](docs/00-plugin-plan.md) — 定位（NATS 出站桥）、架构、安装与里程碑
- [01-auth-pairing.md](docs/01-auth-pairing.md) — 认证与配对设计
- [02-nats-server.md](docs/02-nats-server.md) — 复用既有 NATS Hub 的改动清单（websocket/TLS/账号/Leaf 部署）
