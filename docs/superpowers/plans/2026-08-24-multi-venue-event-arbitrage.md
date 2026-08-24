# 多平台多事件套利架构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有 MEXC↔Polymarket 实盘行为的前提下，建立可扩展的 BTC 多平台双向路线、统一事件模型、通用双腿执行状态机和可恢复执行会话。

**Architecture:** 平台适配器负责平台细节，事件目录负责 BTC 5m/15m 的标准化身份，机会引擎在内存中生成 N×N 有向路线，执行编排器按路线策略运行两腿状态机。旧 MEXC↔Polymarket 执行入口保留为兼容 provider，新的 MEXC/Polymarket/Kalshi 路线通过统一接口逐步接入；Limitless、Predict.fun、Gate 仍由能力矩阵限制为观察。

**Tech Stack:** TypeScript, Electron, React, Vitest, decimal.js, 现有 EventStore 和 IPC/preload 边界。

**Spec:** `docs/superpowers/specs/2026-08-24-multi-venue-event-arbitrage-design.md`

## Global Constraints

- 不修改 MEXC 页面拦截、MEXC 直连签名、Polymarket 冷签名和现有成交回读算法，只通过适配器包装。
- 默认不开放新的自动真实下单；Limitless、Predict.fun、Gate 没有完整成交回读时必须保持只读。
- 未知 POST 结果不得自动重试；每条路线使用幂等键并记录执行会话。
- 事件匹配必须校验主体、周期、起止时间、结果集合和结算来源；不兼容市场不得进入自动执行。
- 每个任务按 TDD 执行：先写一个会失败的行为测试，运行确认失败，再写最小实现，最后运行相关测试。
- 不使用大范围 git reset、checkout 或覆盖用户已有未提交修改。

### Task 1: 建立统一事件、市场和平台能力类型

**Files:**
- Modify: `src/shared/multi-venue.ts`
- Modify: `src/shared/types.ts`
- Create: `src/main/domain/canonical-event.ts`
- Test: `src/main/domain/canonical-event.test.ts`

**Interfaces:**
- Produces `CanonicalEvent`, `CanonicalOutcome`, `CanonicalMarket`, `MarketMatchKey`, `VenueAdapterCapabilities` and a deterministic `canonicalEventId(input)` function.
- Keeps existing `MultiVenueComparison` and `MultiVenueExecution*` types source-compatible through optional fields and string venue IDs.

- [ ] Step 1: Add failing tests for deterministic IDs, BTC 5m/15m distinction, and rejection of mismatched settlement/source fields.
- [ ] Step 2: Run `npm test -- src/main/domain/canonical-event.test.ts` and verify the new tests fail because the module is absent.
- [ ] Step 3: Implement normalized uppercase subject, interval, outcome set and stable SHA-256/hex event ID generation without network access.
- [ ] Step 4: Add adapter capability types for quote/depth/submit/fill/reconcile/cancel and a typed execution policy.
- [ ] Step 5: Run the focused test and existing shared/domain tests; refactor only after green.

### Task 2: Add BTC event catalog and platform market mapping

**Files:**
- Create: `src/main/domain/event-catalog.ts`
- Create: `src/main/domain/event-catalog.test.ts`
- Modify: `src/main/platforms/contracts.ts`
- Modify: `src/main/platforms/registry.ts`
- Test: `src/main/platforms/registry.test.ts`

**Interfaces:**
- Produces `EventCatalog`, `MarketMapping`, `registerBtcCryptoEvents()`, and `resolveMarketMapping(eventId, venueId)`.
- Registry descriptors expose `supportedSubjects`, `supportedIntervals`, and execution capabilities without changing existing UI labels.

- [ ] Step 1: Write failing tests that register BTC 5m/15m, resolve a venue market, and reject a 5m-to-15m mapping.
- [ ] Step 2: Run the focused tests and confirm failure.
- [ ] Step 3: Implement an in-memory catalog with immutable mapping keys; initialize only BTC 5m/15m.
- [ ] Step 4: Extend registry descriptors with optional subject/interval fields and fill current platform values, keeping Kalshi 5m unsupported if no market exists.
- [ ] Step 5: Run catalog and registry tests.

### Task 3: Introduce platform adapter contracts and compatibility wrappers

**Files:**
- Create: `src/main/platforms/venue-adapter.ts`
- Create: `src/main/platforms/venue-adapter.test.ts`
- Create: `src/main/platforms/adapters/mexc-adapter.ts`
- Create: `src/main/platforms/adapters/polymarket-adapter.ts`
- Create: `src/main/platforms/adapters/kalshi-adapter.ts`
- Modify: `src/main/services/multi-venue-execution.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- `VenueAdapter` exposes `venueId`, `capabilities`, `preflightOrder`, `submitOrder`, `waitForFill`, `reconcileOrder`, and optional `cancelOrder`.
- MEXC adapter delegates to `MexcBrowserManager.prepareOrder/waitForFill`.
- Polymarket adapter delegates to `PolymarketLiveBroker.hedge` and maps fill receipts.
- Kalshi adapter delegates to `KalshiTradingService.placeOrder` and maps FOK receipts.

- [ ] Step 1: Add contract tests for capability gating and adapter receipt normalization, using deterministic fakes.
- [ ] Step 2: Run the focused tests and confirm missing adapters fail.
- [ ] Step 3: Implement thin wrappers only; do not move or rewrite existing signing or page interception logic.
- [ ] Step 4: Wire adapters in `src/main/index.ts` behind the existing live-execution gate.
- [ ] Step 5: Run adapter, Kalshi, MEXC and Polymarket tests.

### Task 4: Generate N×N bidirectional routes from normalized comparisons

**Files:**
- Create: `src/main/domain/route-builder.ts`
- Create: `src/main/domain/route-builder.test.ts`
- Modify: `src/main/platforms/read-only-board-adapter.ts`
- Modify: `src/shared/multi-venue.ts`
- Test: `src/main/platforms/read-only-board-adapter.test.ts`

**Interfaces:**
- Produces `buildBidirectionalRoutes(markets, config)` and `routeToComparison(route)`.
- Every compatible pair creates `A_TO_B` and `B_TO_A`; incompatible or stale legs are retained as blocked/observational comparisons.
- Route IDs are deterministic for event, venue pair, direction and outcome.

- [ ] Step 1: Write failing tests for three venues producing six directed routes, fixed route IDs, and filtering incompatible event keys.
- [ ] Step 2: Run focused tests and verify failure.
- [ ] Step 3: Implement in-memory route building using one normalized quote per venue; do not issue platform requests from the builder.
- [ ] Step 4: Integrate the board adapter while preserving existing comparison fields used by the renderer.
- [ ] Step 5: Run route, board, ranking and existing opportunity tests.

### Task 5: Replace Kalshi-specific coordinator with generic two-leg execution state machine

**Files:**
- Create: `src/main/domain/two-leg-execution.ts`
- Create: `src/main/domain/two-leg-execution.test.ts`
- Modify: `src/main/services/multi-venue-execution.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/multi-venue.ts`
- Test: `src/main/services/multi-venue-execution.test.ts`

**Interfaces:**
- `TwoLegExecutionMachine.execute(route, adapters, settings)` returns a typed receipt with `HEDGED`, `RECOVERY_REQUIRED`, `RECONCILE_REQUIRED` or `CANCELED`.
- First-leg selection is route-policy driven; no `if (venue === 'KALSHI')` pairing logic in the generic machine.
- The existing MEXC↔Polymarket legacy provider remains callable and is not replaced in this task.

- [ ] Step 1: Add failing tests for full fill, partial fill, unknown POST, stale quote, unsupported capability and second-leg partial fill.
- [ ] Step 2: Run focused tests and verify failure.
- [ ] Step 3: Implement the smallest explicit state machine with no automatic retry and idempotency key propagation.
- [ ] Step 4: Adapt Kalshi/MEXC/Polymarket route calls to the machine and preserve current Kalshi FOK behavior.
- [ ] Step 5: Run all execution and legacy execution tests.

### Task 6: Persist execution sessions and expose recovery audit

**Files:**
- Create: `src/main/services/execution-session-store.ts`
- Create: `src/main/services/execution-session-store.test.ts`
- Modify: `src/main/services/event-store.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- `ExecutionSessionStore.create/update/listUnfinished/markRecovered` uses the existing event-store persistence directory and versioned JSON records.
- App snapshot exposes unfinished sessions and the latest recovery receipt.
- IPC adds read-only `listExecutionSessions` and user-confirmed `markExecutionSessionRecovered`; no IPC silently submits orders.

- [ ] Step 1: Write failing tests for atomic create/update, unfinished-session listing, corrupt-record isolation and no duplicate session IDs.
- [ ] Step 2: Run focused tests and verify failure.
- [ ] Step 3: Implement versioned persistence using temp-write/rename semantics and bounded record count.
- [ ] Step 4: Record every state transition from the two-leg machine and load unfinished sessions on startup without resubmitting.
- [ ] Step 5: Run store, controller and IPC type tests.

### Task 7: Generalize renderer route display and execution controls

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: `src/shared/global.d.ts`
- Test: existing renderer/typecheck coverage plus a route formatting test if available.

**Interfaces:**
- Table columns become event, interval, route, first leg, second leg, direction, depth, edge and state while preserving fixed ordering and selection lock behavior.
- Detail panel shows per-leg quote age, capabilities, execution policy and recovery state.
- Only routes whose adapter capabilities and settings permit execution show an enabled action; all other routes remain observation-only.

- [ ] Step 1: Add a focused formatting test or pure helper test for bidirectional labels and stable route keys.
- [ ] Step 2: Run the focused test and confirm failure.
- [ ] Step 3: Update pure display helpers and JSX without changing the existing mature MEXC↔Polymarket action handler.
- [ ] Step 4: Add explicit route policy and recovery notices, preserving manual confirmation and fixed sorting.
- [ ] Step 5: Run typecheck and renderer build.

### Task 8: Document BTC configuration and add migration/verification coverage

**Files:**
- Modify: `README.md`
- Modify: `docs/multi-venue-architecture.md`
- Modify: `docs/platform-readiness-audit.zh-CN.md`
- Create: `docs/multi-venue-event-config.zh-CN.md`
- Test: full repository test suite

**Interfaces:**
- Documentation explains how BTC 5m/15m event IDs and market mappings work, how to add a future asset without code branching, and which platforms are observation-only.

- [ ] Step 1: Add documentation assertions to the config examples and update stale Kalshi single-leg wording.
- [ ] Step 2: Run `rg` for stale single-leg claims and unresolved placeholders.
- [ ] Step 3: Run `npm run typecheck`.
- [ ] Step 4: Run `npm test` and record the complete pass count.
- [ ] Step 5: Run `npm run build`.
- [ ] Step 6: Run `git diff --check` and review only task-owned files; do not stage unrelated user changes.

