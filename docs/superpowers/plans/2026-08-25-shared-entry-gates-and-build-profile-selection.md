# 共用入场门禁与可选打包 Profile 实施计划

> **供智能开发代理使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施。每个步骤使用复选框（`- [ ]`）跟踪。

**目标：** 让 GitHub Actions 可选择 Gate+Kalshi 专用包或全平台包，并让 Gate/Kalshi 复用现有手动入场阀值、问号条件弹窗和提示音，同时由主进程使用最新标准化行情再次校验。

**架构：** 在 `src/shared` 增加纯函数入场门禁计算器，页面和主进程共同使用同一份门禁报告。多平台执行服务只接受用户意图，并通过主进程提供的最新 `comparisonId` 解析结果构造真实执行请求，避免信任页面中的价格和深度。GitHub Workflow 只选择 Profile，继续复用统一打包脚本。

**技术栈：** TypeScript 7、Electron 43、React 19、Decimal.js、Vitest 4、GitHub Actions、PowerShell、electron-builder。

**设计文档：** `docs/superpowers/specs/2026-08-25-shared-entry-gates-and-build-profile-selection-design.md`

## 全局约束

- Gate/Kalshi 本次只支持人工监督下的手动双腿执行，不接入 `autoOpenEnabled`。
- 下单热路径不得增加新的远程预检请求；凭据检查只能读取本地状态或缓存。
- 手动关闭条件只影响手动下单；任何自动执行始终使用全部适用条件。
- Gate 最低委托金额固定为 5 USD；数量按两位小数向上计算。
- 表格保持固定顺序；自动选择最优机会不能重排表格。
- 页面提交的价格、深度、市场身份、结算匹配和手续费状态都不能作为主进程权威数据。
- 保留现有 MEXC/Polymarket 实盘执行顺序、风控和自动开单行为。

---

### 任务 1：GitHub Actions 可选择打包 Profile

**文件：**
- 修改：`.github/workflows/build-windows.yml`
- 修改：`scripts/package-profile.mjs`
- 修改：`src/main/services/market-profile.test.ts`
- 检查：`config/market-profiles/btc-gate-kalshi.json`
- 检查：`config/market-profiles/btc-all.json`

**接口：**
- 输入：GitHub `workflow_dispatch.inputs.market_profile`，值只能是 `btc-gate-kalshi` 或 `btc-all`。
- 输出：`release/<profile>/ArbDesk-<profile>-Setup-<version>.exe`。

- [ ] **步骤 1：补充两个 Profile 的失败测试**

在 `market-profile.test.ts` 中加载两个 JSON，断言专用 Profile 只允许 `GATE:KALSHI` / BTC 15m，全量 Profile 仍允许 MEXC/Polymarket 和 5m：

```ts
it('保留专用和全量两个可打包 Profile', async () => {
  const gateKalshi = await loadMarketProfile(resolve(process.cwd(), 'config/market-profiles/btc-gate-kalshi.json'))
  const all = await loadMarketProfile(resolve(process.cwd(), 'config/market-profiles/btc-all.json'))
  expect(profileAllowsRoute(gateKalshi, 'GATE', 'KALSHI')).toBe(true)
  expect(profileAllowsRoute(gateKalshi, 'MEXC', 'POLYMARKET')).toBe(false)
  expect(profileAllowsWindow(gateKalshi, { asset: 'BTC/USD', durationMinutes: 5 })).toBe(false)
  expect(profileAllowsRoute(all, 'MEXC', 'POLYMARKET')).toBe(true)
  expect(profileAllowsWindow(all, { asset: 'BTC/USD', durationMinutes: 5 })).toBe(true)
})
```

- [ ] **步骤 2：运行测试并确认当前选择能力未实现完整**

运行：`npx vitest run src/main/services/market-profile.test.ts`

预期：Profile JSON 测试通过，但 Workflow 仍没有下拉输入，安装包名称也没有 Profile ID。

- [ ] **步骤 3：增加 Workflow 下拉选择**

将工作流触发器和环境变量改为：

```yaml
on:
  workflow_dispatch:
    inputs:
      market_profile:
        description: 选择安装包包含的平台
        required: true
        default: btc-gate-kalshi
        type: choice
        options:
          - btc-gate-kalshi
          - btc-all

env:
  MARKET_PROFILE: ${{ inputs.market_profile }}
```

上传路径、摘要和 Release 发布继续使用 `$env:MARKET_PROFILE`，不得写死 `btc-gate-kalshi`。

- [ ] **步骤 4：让安装包文件名包含 Profile ID**

在 `scripts/package-profile.mjs` 生成的 builder 配置中增加：

```js
const builderConfig = {
  ...packageJson.build,
  artifactName: `ArbDesk-${profileId}-Setup-\${version}.\${ext}`,
  directories: { ...packageJson.build.directories, output: outputDirectory },
  extraResources: [{ from: profileResourcePath, to: 'market-profile.json' }]
}
```

Workflow 的 Artifact 名称使用 `${{ inputs.market_profile }}`，同版本不同 Profile 上传到同一 Release 时不会覆盖文件。

- [ ] **步骤 5：验证 Profile 与 Workflow**

运行：

```bash
npx vitest run src/main/services/market-profile.test.ts
node --check scripts/package-profile.mjs
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/build-windows.yml'); puts 'workflow yaml ok'"
```

预期：测试通过、脚本语法正确、输出 `workflow yaml ok`。

- [ ] **步骤 6：提交任务 1**

```bash
git add .github/workflows/build-windows.yml scripts/package-profile.mjs src/main/services/market-profile.test.ts config/market-profiles
git commit -m "feat: select market profile in packaging workflow"
```

---

### 任务 2：实现平台无关的共用入场门禁计算器

**文件：**
- 新建：`src/shared/entry-gates.ts`
- 新建：`src/shared/entry-gates.test.ts`
- 修改：`src/shared/multi-venue.ts`

**接口：**
- 产出：`evaluateEntryGates(input: EntryGateInput): EntryGateReport`。
- 产出：`entryGateMinimumQuantity(legs: EntryGateLeg[]): Decimal`。
- 供任务 3、4、5 使用：`EntryGateCheck`、`EntryGateReport`、`EntryGateEvaluationMode`。

- [ ] **步骤 1：写硬条件失败测试**

覆盖正数、Gate 5 USD、深度、本金、市场身份、实盘就绪和执行空闲：

```ts
it('把 Gate 5 USD、深度和本金作为不可关闭的硬条件', () => {
  const report = evaluateEntryGates(input({ quantity: '4.99', legs: [gate('1.00', '20'), kalshi('0.01', '20')] }))
  expect(report.allowed).toBe(false)
  expect(report.checks.find((check) => check.id === 'minimum-order')).toMatchObject({ passed: false, locked: true })
  expect(report.firstBlockReason).toContain('Gate 最低金额')
})
```

- [ ] **步骤 2：写手动开关与自动严格模式失败测试**

```ts
it('手动模式允许明确忽略毛边际手续费检查，自动模式不允许', () => {
  const manual = evaluateEntryGates(input({ edgeKind: 'GROSS_ONLY', manualConditions: { ...conditions(), feeVerification: false }, mode: 'MANUAL' }))
  const automatic = evaluateEntryGates(input({ edgeKind: 'GROSS_ONLY', manualConditions: { ...conditions(), feeVerification: false }, mode: 'AUTO' }))
  expect(manual.checks.find((check) => check.id === 'fee-verification')?.enabled).toBe(false)
  expect(manual.allowed).toBe(true)
  expect(automatic.allowed).toBe(false)
})
```

同时覆盖：条件收益率、行情时效、到期截止、`matchClass !== 'EXACT'`、不适用检查不阻塞。

- [ ] **步骤 3：运行测试并确认失败**

运行：`npx vitest run src/shared/entry-gates.test.ts`

预期：FAIL，提示找不到 `./entry-gates` 或导出函数不存在。

- [ ] **步骤 4：定义门禁输入和输出类型**

在 `src/shared/entry-gates.ts` 定义：

```ts
export type EntryGateEvaluationMode = 'MANUAL' | 'AUTO'

export interface EntryGateLeg {
  venueId: string
  venueLabel: string
  marketId?: string
  outcomeId?: string
  price: string
  availableQuantity: string
  quoteAgeMs: number
  minimumQuantity?: string
  minimumNotionalUsd?: string
}

export interface EntryGateReadiness {
  id: string
  label: string
  passed: boolean
  blockReason: string
}

export interface EntryGateInput {
  mode: EntryGateEvaluationMode
  quantity: string
  allInCostPerShare: string
  conditionalReturnPct: string
  edgeKind: 'NET_VERIFIED' | 'GROSS_ONLY'
  matchClass: MultiVenueMatchClass
  endTime: number
  now: number
  maxCapitalPerTrade: string
  minConditionalReturnPct: string
  maxQuoteAgeMs: number
  stopBeforeExpirySeconds: number
  manualConditions: ManualExecutionConditions
  executionIdle: boolean
  readiness: EntryGateReadiness[]
  legs: EntryGateLeg[]
}

export interface EntryGateCheck {
  id: string
  label: string
  passed: boolean
  applicable: boolean
  locked: boolean
  condition?: keyof ManualExecutionConditions
  enabled: boolean
  blockReason?: string
}

export interface EntryGateReport {
  allowed: boolean
  checks: EntryGateCheck[]
  activeCount: number
  passedCount: number
  ignoredCount: number
  firstBlockReason?: string
  minimumQuantity: string
  requestedCapital: string
}
```

- [ ] **步骤 5：实现最小门禁计算逻辑**

使用 Decimal.js 完成所有金额和数量比较。Gate 最低份额按 `5 / price` 向上保留两位；`AUTO` 模式强制所有适用可配置条件 `enabled = true`。`allowed` 只看适用且启用的检查项。

- [ ] **步骤 6：运行门禁测试**

运行：`npx vitest run src/shared/entry-gates.test.ts`

预期：全部通过。

- [ ] **步骤 7：提交任务 2**

```bash
git add src/shared/entry-gates.ts src/shared/entry-gates.test.ts src/shared/multi-venue.ts
git commit -m "feat: add shared entry gate evaluator"
```

---

### 任务 3：主进程使用最新标准化机会强制校验

**文件：**
- 修改：`src/shared/multi-venue.ts`
- 修改：`src/main/services/multi-venue-execution.ts`
- 修改：`src/main/services/multi-venue-execution.test.ts`
- 修改：`src/main/index.ts`

**接口：**
- 消费：任务 2 的 `evaluateEntryGates`。
- 新增：`comparisonProvider: (comparisonId: string) => MultiVenueComparison | undefined`。
- 页面命令只包含：`comparisonId`、`quantity`、`confirmed`。

- [ ] **步骤 1：写“不信任页面行情”的失败测试**

在测试中让页面命令声称价格新鲜，但 `comparisonProvider` 返回过期行情：

```ts
it('使用主进程最新 comparison 并在过期时不提交第一腿', async () => {
  const mocked = deps()
  const service = serviceWithComparison(mocked, comparison({ quoteAgeMs: 9_000 }))
  await expect(service.execute({ comparisonId: 'cmp-1', quantity: '13.00', confirmed: true })).rejects.toThrow('行情')
  expect(mocked.gate.submit).not.toHaveBeenCalled()
  expect(mocked.kalshi.placeOrder).not.toHaveBeenCalled()
})
```

再增加 comparison 不存在、市场 ID 变化、Gate 最低金额、条件收益率和手动忽略手续费检查测试。

- [ ] **步骤 2：运行测试并确认失败**

运行：`npx vitest run src/main/services/multi-venue-execution.test.ts`

预期：FAIL，因为服务仍从页面 `request.legs` 读取行情。

- [ ] **步骤 3：拆分页面命令与内部已解析请求**

在 `multi-venue.ts` 增加：

```ts
export interface MultiVenueExecutionCommand {
  comparisonId: string
  quantity: string
  confirmed: boolean
}
```

保留 `MultiVenueExecutionRequest` 给 `TwoLegExecutionMachine` 使用。预加载桥和渲染页改用 `MultiVenueExecutionCommand`。

- [ ] **步骤 4：服务端解析最新 comparison 并生成门禁报告**

`MultiVenueExecutionService.execute(command)` 执行顺序：

1. 用 `comparisonProvider(command.comparisonId)` 读取最新机会；
2. 确认 `executionProvider === 'MULTI_VENUE'`、恰好两条腿且包含 Kalshi；
3. 根据最新 comparison、设置和本地实盘就绪状态调用 `evaluateEntryGates`；
4. 未通过时抛出 `firstBlockReason`，不调用任何适配器；
5. 通过后才构造内部 `MultiVenueExecutionRequest` 并交给 `TwoLegExecutionMachine`。

传输层现有检查保留，但 `MAX_QUOTE_AGE_MS` 改为使用 `settings.maxQuoteAgeMs`，到期门槛改为 `settings.stopBeforeExpirySeconds`。

- [ ] **步骤 5：在主进程注入权威 comparisonProvider**

`src/main/index.ts` 构造服务时传入：

```ts
comparisonProvider: (comparisonId) => controller.getSnapshot().multiVenueBoard.comparisons
  .find((comparison) => comparison.id === comparisonId)
```

凭据就绪只读本地存储或已有缓存，不调用 Kalshi/Gate 远程接口。

- [ ] **步骤 6：运行执行服务测试**

运行：`npx vitest run src/main/services/multi-venue-execution.test.ts src/main/domain/two-leg-execution.test.ts`

预期：权威数据测试和现有双腿顺序、精度、恢复测试全部通过。

- [ ] **步骤 7：提交任务 3**

```bash
git add src/shared/multi-venue.ts src/main/services/multi-venue-execution.ts src/main/services/multi-venue-execution.test.ts src/main/index.ts src/preload/index.ts src/preload/types.d.ts
git commit -m "feat: enforce shared gates before multi venue execution"
```

---

### 任务 4：Gate/Kalshi 下单面板复用问号条件和禁用原因

**文件：**
- 修改：`src/renderer/src/App.tsx`
- 修改：`src/renderer/src/styles.css`
- 新建：`src/renderer/src/multi-venue-entry-gates.ts`
- 新建：`src/renderer/src/multi-venue-entry-gates.test.ts`

**接口：**
- 消费：任务 2 的 `EntryGateReport` 和 `evaluateEntryGates`。
- 产出：`buildMultiVenueEntryGateReport(args): EntryGateReport`，供页面展示和任务 5 的候选选择使用。

- [ ] **步骤 1：写 Gate/Kalshi 页面门禁适配失败测试**

```ts
it('把全局设置和 Gate/Kalshi 路线转换成共用门禁报告', () => {
  const report = buildMultiVenueEntryGateReport({
    comparison: gateKalshiComparison(), quantity: '13.00', settings,
    now: 10_000, executionIdle: true, kalshiReady: true, gateReady: true
  })
  expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
    'minimum-order', 'depth-limit', 'capital-limit', 'conditional-return',
    'fee-verification', 'settlement-risk', 'quote-freshness', 'expiry-cutoff'
  ]))
})
```

再断言关闭 `feeVerification` 后毛边际路线可手动执行，但 Gate 5 USD 和深度仍不能关闭。

- [ ] **步骤 2：运行测试并确认失败**

运行：`npx vitest run src/renderer/src/multi-venue-entry-gates.test.ts`

预期：FAIL，模块尚不存在。

- [ ] **步骤 3：实现多平台页面适配器**

将 `MultiVenueComparison`、`RiskSettings`、凭据/实盘开关和执行空闲状态转换为任务 2 的标准输入。Gate 腿设置 `minimumNotionalUsd: '5'`，Kalshi 设置 `minimumQuantity: '1'`。

- [ ] **步骤 4：重排 Gate/Kalshi 下单区域**

删除市场摘要顶部原有的孤立“执行双腿”按钮。在份额、容量和两腿计划之后增加与旧路线一致的：

```tsx
<div className="execute-action-row">
  <button className="execute-button" disabled={!multiVenueGateReport.allowed}>
    <Zap aria-hidden="true" />执行双腿（{selectedKalshiLeg.direction} → Kalshi）
  </button>
  <ExecutionConditionsHelp
    checks={multiVenueGateReport.checks}
    busy={busy}
    onToggle={(condition) => void toggleManualExecutionCondition(condition)}
  />
</div>
```

按钮下方显示 `multiVenueGateReport.firstBlockReason`。问号弹窗忽略 `applicable === false` 的检查，硬条件保持锁定。

- [ ] **步骤 5：页面命令只发送用户意图**

`executeSelectedMultiVenue` 只发送：

```ts
const command: MultiVenueExecutionCommand = {
  comparisonId: selectedComparison.id,
  quantity: orderQuantity.toFixed(2),
  confirmed: true
}
```

页面本地判断用于即时反馈，主进程仍按任务 3 重新校验。

- [ ] **步骤 6：运行页面适配测试与类型检查**

运行：

```bash
npx vitest run src/renderer/src/multi-venue-entry-gates.test.ts
npm run typecheck
```

预期：测试和类型检查通过。

- [ ] **步骤 7：提交任务 4**

```bash
git add src/renderer/src/App.tsx src/renderer/src/styles.css src/renderer/src/multi-venue-entry-gates.ts src/renderer/src/multi-venue-entry-gates.test.ts src/shared/multi-venue.ts src/preload
git commit -m "feat: share execution controls with Gate Kalshi"
```

---

### 任务 5：所有路线共用最优机会选择与提示音

**文件：**
- 新建：`src/renderer/src/opportunity-alert.ts`
- 新建：`src/renderer/src/opportunity-alert.test.ts`
- 修改：`src/renderer/src/App.tsx`

**接口：**
- 消费：任务 4 的 `buildMultiVenueEntryGateReport`。
- 产出：`selectReadyComparisons(args): MultiVenueComparison[]`。
- 产出：`shouldPlayOpportunityAlert(previousId, currentId, lastPlayedAt, now, cooldownMs): boolean`。

- [ ] **步骤 1：写候选选择与提示音失败测试**

```ts
it('同时接受旧路线和通过门禁的 Gate/Kalshi 路线', () => {
  const ready = selectReadyComparisons({ comparisons: [legacy, gateKalshi], gateReports, legacyReadyIds: new Set([legacy.id]) })
  expect(ready.map((item) => item.id)).toEqual([legacy.id, gateKalshi.id])
})

it('同一候选持续合格时不重复播放，新候选冷却后播放', () => {
  expect(shouldPlayOpportunityAlert(undefined, 'a', 0, 10_000, 30_000)).toBe(true)
  expect(shouldPlayOpportunityAlert('a', 'a', 10_000, 20_000, 30_000)).toBe(false)
  expect(shouldPlayOpportunityAlert('a', 'b', 10_000, 41_000, 30_000)).toBe(true)
})
```

- [ ] **步骤 2：运行测试并确认失败**

运行：`npx vitest run src/renderer/src/opportunity-alert.test.ts`

预期：FAIL，模块尚不存在。

- [ ] **步骤 3：实现纯候选与提示音状态函数**

旧路线以现有 `opportunityReady` 结果为准；多平台路线必须是 `MANUAL_EXECUTABLE` 且其门禁报告 `allowed === true`。排序继续按利润、单份边际、`fixedSortKey`，不改变原 comparisons 数组。

- [ ] **步骤 4：改造 App 的最优选择**

`readyComparisons` 不再要求 `legacyOpportunityId`。`FOLLOW_BEST` 模式下直接使用 `bestComparison.id`；如果它没有 `legacyOpportunityId`，将 `selectedId` 设为 `undefined`，并正常显示多平台下单区域。

- [ ] **步骤 5：改造提示音 Effect**

提示音键从 `selected.id` 改为 `bestComparison.id`，仅在 `shouldPlayOpportunityAlert` 返回 true 时调用 `playOpportunityChime`。继续使用现有 `opportunitySoundEnabled`、音量和冷却秒数。

- [ ] **步骤 6：运行提示音测试与类型检查**

运行：

```bash
npx vitest run src/renderer/src/opportunity-alert.test.ts src/renderer/src/multi-venue-entry-gates.test.ts
npm run typecheck
```

预期：测试和类型检查通过。

- [ ] **步骤 7：提交任务 5**

```bash
git add src/renderer/src/App.tsx src/renderer/src/opportunity-alert.ts src/renderer/src/opportunity-alert.test.ts
git commit -m "feat: share opportunity selection and alerts"
```

---

### 任务 6：完整验证与中文文档收尾

**文件：**
- 修改：`README.md`
- 检查：`docs/superpowers/specs/2026-08-25-shared-entry-gates-and-build-profile-selection-design.md`
- 检查：本计划涉及的全部文件

**接口：**
- 输出：可由 GitHub 选择 Profile 的 Windows 构建，以及共用手动入场控制。

- [ ] **步骤 1：更新中文 README**

说明 GitHub Actions 下拉选项、默认专用包、全平台包、本地命令、共用门禁的适用范围，并明确 Gate/Kalshi 自动开单仍未开放。

- [ ] **步骤 2：运行全量测试**

运行：`npm test`

预期：全部测试通过，无跳过和失败。

- [ ] **步骤 3：运行生产构建**

运行：`npm run build`

预期：TypeScript、主进程、预加载和渲染进程均构建成功。

- [ ] **步骤 4：校验打包脚本、Workflow 和差异格式**

运行：

```bash
node --check scripts/package-profile.mjs
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/build-windows.yml'); puts 'workflow yaml ok'"
git diff --check
```

预期：输出 `workflow yaml ok`，其余命令无错误。

- [ ] **步骤 5：确认未误改成熟执行路线**

运行：

```bash
npx vitest run src/main/app-controller.test.ts src/main/domain/execution-machine.test.ts src/main/services/multi-venue-execution.test.ts
```

预期：MEXC/Polymarket 旧路线、Gate/Kalshi 顺序执行、部分成交精度和恢复测试全部通过。

- [ ] **步骤 6：提交任务 6**

```bash
git add README.md
git commit -m "docs: document shared entry gates and build profiles"
```
