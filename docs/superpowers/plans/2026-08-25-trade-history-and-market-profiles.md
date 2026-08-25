# 交易记录与市场 Profile 实施计划

> **供智能开发代理使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施。每个步骤使用复选框（`- [ ]`）跟踪。

**目标：** 修复双腿精度误报、展示跨平台交易历史，并让打包产物按市场 Profile 隔离运行范围。

**架构：** 保留旧 MEXC/Polymarket 订单存储和执行入口，新增多平台历史只读视图；通用执行状态机在第二腿边界统一数量精度。构建脚本校验 `config/market-profiles` 并把一个 Profile 作为成品资源，运行时由统一白名单约束平台启动和市场路线。

**技术栈：** TypeScript、Electron、React、Vitest、electron-builder、Node.js 脚本。

**设计文档：** `docs/superpowers/specs/2026-08-25-trade-history-and-market-profiles-design.md`

## 全局约束

- 不修改成熟 MEXC↔Polymarket 旧订单记录格式、下单 IPC 或恢复状态机。
- 不在下单热路径增加余额或额外市场请求。
- 第二腿数量必须向下归一化，不能因为显示精度造成超额对冲。
- Profile 只允许缩小运行范围，不能绕过现有平台能力和实盘门禁。
- 用户密钥、订单数据和运行时设置继续保存在系统用户目录，不打包进 Profile。

### 任务 1：修复第二腿成交精度对齐

**文件：**
- 修改：`src/main/domain/two-leg-execution.ts`
- 测试：`src/main/services/multi-venue-execution.test.ts`

- [ ] **步骤 1：编写失败测试**

增加测试：首腿返回 `7.192`、第二腿返回 `7.19` 时断言状态为 `HEDGED`，并增加第二腿返回 `7.18` 时断言为 `RECOVERY_REQUIRED`。

- [ ] **步骤 2：运行测试并确认第一个用例失败**

运行：`npm test -- src/main/services/multi-venue-execution.test.ts`
预期：`7.192` 对齐测试失败，因为当前状态机把第二腿成交量与未取整的首腿成交量比较。

- [ ] **步骤 3：实现最小数量归一化**

在 `TwoLegExecutionMachine` 中将第二腿数量定义为 `filledQuantity.toDecimalPlaces(2, Decimal.ROUND_DOWN)`，并用同一变量构造第二腿请求、回执目标和完成比较；低于 1 份时保持恢复态。

- [ ] **步骤 4：运行定向测试和全量测试**

运行：`npm test -- src/main/services/multi-venue-execution.test.ts` 和 `npm test`。
预期：两者全部通过。

- [ ] **步骤 5：提交**

```bash
git add src/main/domain/two-leg-execution.ts src/main/services/multi-venue-execution.test.ts
git commit -m "fix: normalize second-leg fill quantities"
```

### 任务 2：将跨平台会话接入历史记录

**文件：**
- 修改：`src/main/services/execution-session-store.ts`
- 修改：`src/shared/multi-venue.ts`
- 修改：`src/shared/types.ts`
- 修改：`src/main/app-controller.ts`
- 修改：`src/renderer/src/App.tsx`
- 修改：`src/renderer/src/styles.css`
- 测试：`src/main/services/execution-session-store.test.ts`

- [ ] **步骤 1：编写存储层失败测试**

记录一个已完成会话和一个恢复会话，断言 `list()` 返回两条、`listUnfinished()` 只返回恢复会话。

- [ ] **步骤 2：实现全部会话读取接口**

增加 `ExecutionSessionStore.listAll()`，保留现有 `listUnfinished()` 的筛选行为；在 AppSnapshot 增加多平台历史数组并从 controller 填充。

- [ ] **步骤 3：增加历史视图模型与 IPC 操作**

复用现有 `multi-venue:list-sessions` IPC 返回全部记录，新增 `multi-venue:mark-session-recovered` 后刷新快照；不改变旧订单 `orderHistory`。

- [ ] **步骤 4：渲染多平台历史记录**

历史弹窗增加多平台记录区，显示路线、窗口、两腿请求/成交数量、均价、订单号、状态和恢复备注；恢复会话提供核对后标记按钮。

- [ ] **步骤 5：验证界面类型和测试**

运行：`npm test` 和 `npm run typecheck`。

- [ ] **步骤 6：提交**

```bash
git add src/main/services/execution-session-store.ts src/shared/multi-venue.ts src/shared/types.ts src/main/app-controller.ts src/renderer/src/App.tsx src/renderer/src/styles.css src/main/services/execution-session-store.test.ts
git commit -m "feat: show multi-venue execution history"
```

### 任务 3：增加市场 Profile 与构建入口

**文件：**
- 新建：`src/shared/market-profile.ts`
- 新建：`src/main/services/market-profile.ts`
- 新建：`config/market-profiles/btc-all.json`
- 新建：`scripts/package-profile.mjs`
- 修改：`src/main/index.ts`
- 修改：`src/main/services/multi-venue-market-data.ts`
- 修改：`src/main/platforms/registry.ts`
- 修改：`src/main/domain/route-builder.ts`
- 修改：`package.json`
- 测试：`src/main/services/market-profile.test.ts`

- [ ] **步骤 1：编写 Profile 失败测试**

覆盖加载 `btc-all`、拒绝未知 Profile、拒绝非法周期和拒绝不在 Profile 中的平台路线。

- [ ] **步骤 2：实现 Profile 结构与加载器**

定义 `MarketProfile` 的 `id`、`subjects`、`intervals`、`venues`、`routes`；开发环境加载 `btc-all`，打包环境从 `process.resourcesPath/market-profile.json` 加载并严格校验。

- [ ] **步骤 3：在启动和机会比较阶段应用白名单**

创建平台连接器前筛选允许的平台；市场快照和路线构建再次按 Profile 过滤，防止单个平台返回其他资产或周期时污染机会榜。

- [ ] **步骤 4：增加打包脚本**

`npm run package:profile -- --profile=btc-all --target=mac` 校验 Profile、运行测试/构建，并为 electron-builder 生成只包含当前 Profile 的资源配置；输出放到 `release/<profile>`。

- [ ] **步骤 5：验证 Profile 打包链路**

运行：`npm test`、`npm run typecheck`、`npm run build`，并试运行 `node scripts/package-profile.mjs --profile=btc-all --target=dir`。

- [ ] **步骤 6：提交**

```bash
git add src/shared/market-profile.ts src/main/services/market-profile.ts config/market-profiles/btc-all.json scripts/package-profile.mjs src/main/index.ts src/main/services/multi-venue-market-data.ts src/main/platforms/registry.ts src/main/domain/route-builder.ts package.json src/main/services/market-profile.test.ts
git commit -m "feat: add build-time market profiles"
```

### 任务 4：最终验证

- [ ] **步骤 1：** 运行 `npm test`。
- [ ] **步骤 2：** 运行 `npm run typecheck`。
- [ ] **步骤 3：** 运行 `npm run build`。
- [ ] **步骤 4：** 运行 `git diff --check`，并检查 `git status --short`，保留无关的 `.App.tsx.swp`。
