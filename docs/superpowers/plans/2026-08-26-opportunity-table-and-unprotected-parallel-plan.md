# 机会表格精简与无保护并行执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精简多平台机会表格和右侧面板，并让现有全局无保护开关控制 Gate↔Kalshi 的同量并行提交，同时保留普通保护模式和必要技术护栏。

**Architecture:** 在现有 `TwoLegExecutionMachine` 中增加显式的并行无保护策略分支，普通路线继续走 `SEQUENTIAL_FILL_THEN_HEDGE`。共享回执和执行会话新增 `UNPROTECTED_SUBMITTED` 状态，UI 根据策略显示同量提交结果；页面展示只改 `App.tsx` 及相关样式，不改变行情捕获适配器。

**Tech Stack:** TypeScript, React, Electron, Vitest, Decimal.js, existing venue adapter interfaces.

**Spec:** `docs/superpowers/specs/2026-08-26-opportunity-table-and-unprotected-parallel-design.md`

## Global Constraints

- 无保护模式默认关闭，且仅在人工监督模式下可用。
- 无保护模式提交两条用户明确要求的订单，不复制请求、不重放请求、不自动重试。
- 无保护模式不等待首腿成交，不按首腿成交量修改第二腿数量。
- 普通保护模式继续首腿实际成交后再提交第二腿，并保留原精度对齐。
- Gate 最低 5 USDT、Kalshi 最低份额、市场/周期/方向匹配和单笔执行互斥仍然是硬条件。
- 保留未提交、未知订单、失败和部分成交的人工恢复/核对语义。

## File Map

- Modify `src/shared/multi-venue.ts`: add the explicit unprotected-submitted receipt/session status.
- Modify `src/main/domain/two-leg-execution.ts`: add the parallel strategy branch and result collection.
- Test `src/main/domain/two-leg-execution.test.ts`: prove concurrent submissions, equal target quantity, no fill wait, and failure handling.
- Modify `src/main/services/multi-venue-execution.ts`: select the strategy from `unprotectedExecutionEnabled` and retain hard checks while skipping configurable economic gates only in the parallel mode.
- Test `src/main/services/multi-venue-execution.test.ts`: verify the global setting selects the strategy and ordinary mode is unchanged.
- Modify `src/main/services/execution-session-store.ts` and `src/main/app-controller.ts`: persist and classify `UNPROTECTED_SUBMITTED` without treating it as hedged.
- Test `src/main/services/execution-session-store.test.ts` and `src/main/app-controller.test.ts`: cover persistence, unfinished-session visibility, and event mapping.
- Modify `src/renderer/src/App.tsx` and `src/renderer/src/styles.css`: remove redundant columns/panel elements, add the emphasized cost column, and expose the global unprotected state on multi-platform execution.
- Create `src/renderer/src/opportunity-table.test.ts`: test the extracted table-column and multi-platform status/button helpers without mounting Electron.

### Task 1: Add shared receipt state and parallel execution tests

**Files:**
- Modify: `src/shared/multi-venue.ts`
- Test: `src/main/domain/two-leg-execution.test.ts`

**Interfaces:**
- Add `UNPROTECTED_SUBMITTED` to `MultiVenueExecutionReceipt.status` and `MultiVenueExecutionSessionStatus`.
- Add a test-only adapter whose `submitOrder` records invocation and returns deferred promises; `waitForFill` must throw if called in unprotected mode.

- [ ] **Step 1: Write failing tests**

Add tests that start an unprotected execution request with `executionPolicy: 'PARALLEL_UNPROTECTED'`, assert both `submitOrder` functions have started before either deferred result resolves, both receive `quantity: '2.00'`, and neither adapter's `waitForFill` is called. Add a second test where one submission rejects and assert the receipt is `RECOVERY_REQUIRED` with both leg outcomes preserved and no retry.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
npx vitest run src/main/domain/two-leg-execution.test.ts
```

Expected: failure because the policy and status do not yet exist.

- [ ] **Step 3: Add the shared status types**

Update both shared unions to include `UNPROTECTED_SUBMITTED` without changing existing status names or serialized field shapes.

- [ ] **Step 4: Implement the minimal parallel branch**

Add a branch before the current sequential fill path:

```ts
if (request.executionPolicy === 'PARALLEL_UNPROTECTED') {
  return await this.executeParallelUnprotected(request, firstAdapter, secondAdapter, sessionId)
}
```

The helper must call both `submitOrder` methods in the same synchronous turn, await `Promise.allSettled`, create one receipt per leg using the requested quantity, return `UNPROTECTED_SUBMITTED` only when both responses have order IDs, and return `RECOVERY_REQUIRED` or `RECONCILE_REQUIRED` when a response is rejected, unknown, or lacks an order ID. It must never call `waitForFill` or submit a replacement.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run the same Vitest command and confirm the new parallel tests and all existing two-leg tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared/multi-venue.ts src/main/domain/two-leg-execution.ts src/main/domain/two-leg-execution.test.ts
git commit -m "feat: add parallel unprotected execution receipt"
```

### Task 2: Select the strategy in the multi-venue service and persist it

**Files:**
- Modify: `src/main/services/multi-venue-execution.ts`
- Modify: `src/main/services/execution-session-store.ts`
- Modify: `src/main/app-controller.ts`
- Test: `src/main/services/multi-venue-execution.test.ts`
- Test: `src/main/services/execution-session-store.test.ts`
- Test: `src/main/app-controller.test.ts`

**Interfaces:**
- `MultiVenueExecutionService` sets `executionPolicy` to `PARALLEL_UNPROTECTED` only when `settings.unprotectedExecutionEnabled === true`; otherwise it keeps `SEQUENTIAL_FILL_THEN_HEDGE`.
- `ExecutionSessionStore` accepts and persists the new status; `listUnfinished()` includes it because actual fills still need manual verification.
- `AppController.recordMultiVenueReceipt` maps `UNPROTECTED_SUBMITTED` to a non-hedged execution event and keeps the session visible in the recovery banner.

- [ ] **Step 1: Write failing service and persistence tests**

Add one service test with `unprotectedExecutionEnabled: true` and deferred Gate/Kalshi submissions; assert both start before either resolves and the request reaches the machine with `executionPolicy: 'PARALLEL_UNPROTECTED'`. Add store tests that write a receipt with `status: 'UNPROTECTED_SUBMITTED'`, read it back, and expect it from `listUnfinished()`. Add controller mapping coverage that calls `recordMultiVenueReceipt()` and asserts the appended event state is `RECOVERY_REQUIRED`, never `HEDGED`.

- [ ] **Step 2: Run focused tests to verify RED**

```bash
npx vitest run src/main/services/multi-venue-execution.test.ts src/main/services/execution-session-store.test.ts src/main/app-controller.test.ts
```

Expected: failures for policy selection and the new status validation.

- [ ] **Step 3: Implement strategy selection and hard-gate behavior**

Use the existing global setting to choose the policy. In unprotected mode, pass the same validated quantity to both legs and skip only configurable economic checks (profit, settlement signal, slippage/freshness conditions) while retaining credential, live-switch, market identity, minimum quantity/notional, expiry safety, and execution mutex checks.

- [ ] **Step 4: Implement persistence and event mapping**

Add `UNPROTECTED_SUBMITTED` to session validation and unfinished filtering. Set `recoveryNote` for this state. Map it to the existing non-hedged recovery event state while using a distinct message, so the UI can show “成交待核对” and the session cannot silently disappear.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run the command from Step 2 and confirm all focused files pass.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/multi-venue-execution.ts src/main/services/execution-session-store.ts src/main/app-controller.ts src/main/services/multi-venue-execution.test.ts src/main/services/execution-session-store.test.ts src/main/app-controller.test.ts
git commit -m "feat: wire global unprotected mode to multi-venue execution"
```

### Task 3: Simplify the opportunity table and right execution panel

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: existing renderer pure helper tests or a focused new renderer test file under `src/renderer/src/`

**Interfaces:**
- Table header and row rendering use the eight columns from the spec, with `allInCostPerShare` as the final emphasized column.
- Multi-platform execution button uses `snapshot.settings.unprotectedExecutionEnabled` and does not introduce a second setting.

- [ ] **Step 1: Add failing pure rendering/helper assertions**

Create `src/renderer/src/opportunity-table.test.ts` and add assertions against exported helpers such as `multiVenueTableColumns()`, `multiVenueStatusLabel('UNPROTECTED_SUBMITTED')`, and `multiVenueExecuteLabel(true)`. The expected column array must contain `双腿成本` as its last item and must not contain `路线/方向` or `数量/深度`.

- [ ] **Step 2: Run focused renderer tests to verify RED**

```bash
npx vitest run src/renderer/src/opportunity-table.test.ts src/renderer/src/route-display.test.ts src/renderer/src/multi-venue-entry-gates.test.ts
```

Expected: failures until the column/status helpers are updated.

- [ ] **Step 3: Implement table and panel changes**

Remove the redundant table cells and the selected-ticket duplicate header/status block. Keep leg platform, direction, price, available quantity and execution inputs in the right panel. Remove the disabled bottom button for depth/stale routes. Add a final `双腿成本` cell with a dedicated large/bold class. Add concise unprotected warning and button text while leaving the existing conditions help available.

- [ ] **Step 4: Update styles**

Add the cost-cell emphasis and adjust table grid/colspan values after removing columns. Keep responsive overflow behavior and do not change the fixed ordering or selection styles.

- [ ] **Step 5: Run focused tests to verify GREEN**

Run:

```bash
npx vitest run src/renderer/src/opportunity-table.test.ts src/renderer/src/route-display.test.ts src/renderer/src/multi-venue-entry-gates.test.ts
```

Confirm the helper assertions pass; Task 4's `npm run build` will type-check the complete renderer source.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/styles.css src/renderer/src/opportunity-table.test.ts
git commit -m "ui: simplify opportunity table and execution ticket"
```

### Task 4: Full verification and handoff

**Files:**
- No source changes expected; inspect the complete diff and generated build output.

- [ ] **Step 1: Run the complete verification suite**

```bash
npm test
npm run build
git diff --check
```

Expected: all Vitest files pass, TypeScript and Electron production build exit with code 0, and `git diff --check` produces no output.

- [ ] **Step 2: Review the final diff**

Confirm the only changed tracked files are the shared status, execution strategy, persistence/controller mapping, renderer UI/styles, tests, and this plan/spec. Keep `src/renderer/src/.App.tsx.swp` untracked and unstaged.

- [ ] **Step 3: Commit any verification-only correction**

If verification exposes a correction, add only the named source/test files and use a focused commit message; do not stage unrelated files.

- [ ] **Step 4: Push the current branch**

```bash
git push
```

If the local proxy blocks the default push, rerun the same command with the approved escalated Git push permission.
