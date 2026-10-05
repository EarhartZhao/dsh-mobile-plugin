# dsh-mobile-plugin Agent 指南

## 项目概览

dsh-mobile-plugin 是 deepseek-harness（dsh）的 cordis 插件，提供 NATS outbound bridge、设备配对和 RPC 代理，让 dsh-mobile App 通过 NATS 与宿主通信。

- `src/index.ts`：插件入口，注册 cordis 服务与生命周期。
- `src/bridge.ts`：RPC 桥接层（含 `mobile.info` 兼容性接口、方法白名单）。
- `src/events.ts`：事件流转发与下行帧投影。
- `src/tokens.ts`：设备令牌生成、校验与台账。
- `src/config.ts`：配置 schema（`natsUrl`/`hubWssUrl`/`hubUser`/`hubPass`/`instanceId` 等字段与默认值）。
- `src/hub-check.ts`：发码前的三段链路校验（桥→本机 NATS→Hub→本机实例），控制台「测试 Hub 账号」就是它。
- `src/nats-launch.ts`：本机 NATS 客户端口的探测（「启动本地 NATS」按钮据此决定复用还是启动）。
- `src/tool-views.ts`：为 `session/event` 帧填 `view` 槽（工具卡）。
- `src/console.ts`：回环控制台页面与 JSON 路由。
- `src/client/`：浏览器半边（插件页里的配置区）。
- `src/harness-shims.d.ts`：宿主包类型 shim。
- `cordis.patch.yml`：本包作为组合包（`dsh.bundle`）自带的那一行，只放非密默认值，凭证由部署方覆盖。
- `skills/`：dsh 兼容性检查技能。

## 文档

`docs/` 下四份，职责不同，别把内容写错地方：

| 文档 | 写什么 |
|---|---|
| `00-plugin-plan.md` | 定位、架构、安装方式与里程碑（方案与决策记录） |
| `01-auth-pairing.md` | 双层凭证模型、配对流程、token 存储 |
| `02-nats-server.md` | **现有部署**的 NATS 增量改动清单与实况记录 |
| `03-nats-self-host.md` | 自建 NATS 服务教程（Hub 从零 → 本机 Leaf → 插件配置 → 验收 → 故障排查），面向部署者 |

写文档时的约定：

- `README.md` 顶部的文档索引与 `docs/` 保持一致，新增文档要一起加进去。
- 面向部署者的命令与配置写通用形式：Hub 地址用 `<hub-host>`、C 端账号用 `<account>` 占位，示例 IP 用 RFC 5737 文档地址（`203.0.113.0/24`）。**仓库里不放部署实况**——真实地址、账号名、机器名、本机路径都只留在部署机上（2026-09-30 起，原先允许「集中在 02 开头标注一处」的例外也取消了）；测试夹具用 `hub.test`、`c-end-test`、`home-test` 这类明显假值。
- NATS 服务端脚本**不在本仓库**：`setup-hub.sh`、`hub-credential.sh`、`verify-hub-acl.mjs`、`local-hub-standin.conf` 都在 `../dsh-mobile/scripts/`。引用它们时写跨仓库路径，别写成 `scripts/...`（这处笔误已经修过一次）。
- 改动了 NATS 相关行为——配置字段、`hub-check` 的结论或文案、控制台的提示、服务端脚本的用法——要同步更新 02/03 以及 `src/hub-check.ts`、`src/console.ts` 里的提示文案，别让文档和运行时说法不一致。

## 常用命令

```bash
pnpm install
pnpm run typecheck
pnpm run typecheck:client
pnpm test
pnpm run build
```

CI（`.github/workflows/ci.yml`）跑的就是这四条，另外内置了一个真实 `nats-server` 进程给 `tests/integration.spec.ts` 用；本地跑集成用例需要 PATH 里有 `nats-server`（2.14.6 与 CI 一致）。

发版走 `.github/workflows/release.yml`（tag `v*` 触发，tag 推送不触发 `ci.yml`，所以它自己把这四条再跑一遍）：先校验 tag、`package.json` 的 `version` 与 `src/bridge.ts` 的 `PLUGIN_VERSION` 三者一致，再 `pnpm pack` 把预构建包挂成 Release 资产（`dsh-mobile-plugin-<version>.tgz` + 版本无关的 `dsh-mobile-plugin.tgz`），带 `-rc` 的 tag 标成 pre-release。顺序因此是：改三处版本号 → 提交 → `git tag v<version>` → 推 tag。别的机器的安装源就是这些资产（见 README「安装与接入」），改安装形态或资产命名要同步 `src/update.ts` 的 `releaseAssetSpec` 与那份文档。

对运行中的宿主做端到端验收（需要本机 NATS 与已加载插件的 dsh web profile）：

```bash
node scripts/fake-app.mjs nats://127.0.0.1:4222 <pairCode> home
node scripts/watch-probe.mjs nats://127.0.0.1:4222 home <scratchPath>
```

本机依赖检查不稳定时加 `$env:CI='true'`。

## 安全与兼容性约定

- 不要把设备令牌、NATS 凭据或 dsh 宿主内部 API 密钥提交到仓库。
- 文档、示例配置与错误提示里同样不放真实凭据；Hub 地址用占位符，示例 IP 用文档地址段。
- `src/harness-shims.d.ts` 中的类型声明必须与 dsh 实际运行时接口保持一致。
- 修改 `mobile.info` 返回值（`mobileApi`/`pluginVersion`/`features`）后，同步更新 `package.json` version 和 dsh-mobile 的 `packages/core/src/compatibility.ts` 中的支持区间。

## dsh 上游发版

deepseek-harness 发版后按 `skills/dsh-compat-check/SKILL.md` 检查插件是否兼容。
