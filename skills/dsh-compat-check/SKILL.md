---
name: dsh-compat-check
description: 检查 dsh 上游更新对 dsh-mobile-plugin 宿主 API 依赖的影响，确认兼容性。
---

# DSH Compat Check

dsh（deepseek-harness）发版后，用本 skill 确认 dsh-mobile-plugin 是否仍能正常注入和桥接。

## 第一步：检查宿主包依赖

插件运行时依赖 dsh 内部的 cordis 服务。检查这些依赖是否仍然存在：

```bash
cd dsh-mobile-plugin
rg -n "ctx\.get\(|from '@deepseek-ai" src/index.ts src/events.ts src/bridge.ts
```

当前依赖面（截至插件 0.2.0）：

| 导入 | 用途 | dsh 版本要求 |
|------|------|-------------|
| `@deepseek-ai/dsh-client-connection` (`HostConnectionHandle`) | 创建 shared `/api` handler，提交 `$events/result` | 0.1.2-alpha.5 |
| `@deepseek-ai/dsh-api-gateway` (`TypertGateway`) | 调用 unary/stream Remote 与 `$events` | 0.1.2-alpha.5 |
| `@deepseek-ai/cordis` (`Context`, `Service`) | 插件生命周期 | ^4.0.1 |
| `@deepseek-ai/schemastery` (`Config`) | 插件配置 schema | ^3.18.1 |

## 第二步：对比上游变化

```bash
cd ../deepseek-harness
git log --oneline HEAD~10..HEAD -- packages/client/connection/ packages/api/ packages/interaction/ packages/goal/ packages/preset/ packages/subagent/ packages/context/
```

重点检查 Typert Gateway、Remote owner、session/workspace 流和转发事件 allowlist。

## 第三步：确认 shims 仍然准确

插件使用 `src/harness-shims.d.ts` 声明宿主包的类型。如果上游改了接口签名，需要更新 shim。

```bash
rg -n "createSharedFetchHandler|TypertGateway|wireStream" ../deepseek-harness/packages/ --glob "!node_modules" -l
```

如果没有结果，说明宿主接入点已移动，插件需要迁移。

## 第四步：运行测试

```bash
cd dsh-mobile-plugin
pnpm test
```

测试通过只说明插件自身逻辑没有回归，不保证与最新 dsh 运行时兼容。
最终确认需要在真实 dsh 0.1.2-alpha.2 环境中加载插件并验证 mobile.info RPC。

## 第五步：版本兼容性声明

更新 `package.json` 中的版本号和 `src/bridge.ts` 中的 `mobile.info` 返回值：

```typescript
const MOBILE_PLUGIN_INFO = {
  mobileApi: 1,          // 递增当 RPC 协议有 breaking change
  pluginVersion: '0.2.0', // 与 package.json version 一致
  features: ['plus-menu', 'multi-image', 'durable-attachment-order'],
}
```

app 侧的 `packages/core/src/compatibility.ts` 会通过 `mobile.info` RPC 校验这三个字段。

## 已知迁移场景

### dsh 0.1.2-alpha.2：移除 ApiProxy

**问题**：`toFetchHandler` 和 `HostApiProxy` 不再存在，`ctx.get('apiProxy')` 返回 undefined。

**新架构**：dsh 使用 `packages/api/gateway` 的 `TypertGatewayService` + `packages/client/connection` 的 `HostConnectionService`。

**已完成迁移**（插件 0.2.1+）：

1. `src/index.ts` 的 `static inject` 已从 `['apiProxy']` 改为 `['connection', 'typertGateway']`。
2. 单次 RPC 通过 `connection.createSharedFetchHandler('/api')` → `handler.fetch(request)` 转发。
3. 事件流通过 `GatewayEventAdapter`（`src/events.ts`）打开 gateway 的 `$events` 流，将 `emit`/`waterfall`/`cancel` 帧适配为旧 `StreamFrame` 格式，NATS wire protocol 不变。
4. `src/harness-shims.d.ts` 已更新为声明 `@deepseek-ai/dsh-client-connection` 和 `@deepseek-ai/dsh-api-gateway` 的结构类型。

## 防止遗漏

- 每次上游 dsh tag 发版（`dsh-v*`）至少跑一次本 skill。
- 如果 dsh 移除了插件依赖的某个包，在 src/ 中搜索所有 `from '@deepseek-ai/dsh-*'` 导入并逐一确认。
- 插件的 `peerDependencies` 中的 `@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery` 版本范围应覆盖 dsh 实际使用的版本。
