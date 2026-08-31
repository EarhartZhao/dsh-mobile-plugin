# dsh-mobile-plugin Agent 指南

## 项目概览

dsh-mobile-plugin 是 deepseek-harness（dsh）的 cordis 插件，提供 NATS outbound bridge、设备配对和 RPC 代理，让 dsh-mobile App 通过 NATS 与宿主通信。

- `src/index.ts`：插件入口，注册 cordis 服务。
- `src/bridge.ts`：RPC 桥接层（含 `mobile.info` 兼容性接口）。
- `src/tokens.ts`：设备令牌生成与存储。
- `src/events.ts`：事件流转发。
- `src/console.ts`：Web 设置页面路由。
- `src/harness-shims.d.ts`：宿主包类型 shim。
- `skills/`：dsh 兼容性检查技能。

## 常用命令

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

本机依赖检查不稳定时加 `$env:CI='true'`。

## 安全与兼容性约定

- 不要把设备令牌、NATS 凭据或 dsh 宿主内部 API 密钥提交到仓库。
- `src/harness-shims.d.ts` 中的类型声明必须与 dsh 实际运行时接口保持一致。
- 修改 `mobile.info` 返回值（`mobileApi`/`pluginVersion`/`features`）后，同步更新 `package.json` version 和 dsh-mobile 的 `packages/core/src/compatibility.ts` 中的支持区间。

## dsh 上游发版

deepseek-harness 发版后按 `skills/dsh-compat-check/SKILL.md` 检查插件是否兼容。
