# Gate 指纹浏览器全链路实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Hubstudio/CDP 连接通用化，让 Gate 复用已登录指纹浏览器，并在捕获验证后接入安全的事件合约双腿下单与成交回读。

**Architecture:** 新增通用 `FingerprintBrowserRuntime` 管理 Hubstudio 环境和 CDP 页面，保留 `MexcBrowserManager` 的外部接口并把 Gate 页面绑定到同一运行时。新增 Gate 请求捕获存储、订单适配器和执行开关；Gate 真实订单默认关闭，未捕获到真实订单 schema 时只能只读。

**Tech Stack:** Electron, Playwright Core CDP, TypeScript, Vitest, existing multi-venue `VenueAdapter` and `TwoLegExecutionMachine`.

**Spec:** `docs/superpowers/specs/2026-08-24-gate-fingerprint-execution.md`

## Global Constraints

- 不改变现有 MEXC、Polymarket、Kalshi 已有实盘路径。
- 不猜测 Gate 事件合约订单 endpoint、签名或 payload。
- Cookie、临时 token、签名和完整订单 body 不落盘。
- Gate POST 超时或未知结果只 reconcile，不自动重试。
- Gate 实盘开关默认关闭；捕获模式不自动提交订单。
- 不增加行情高频轮询；优先使用页面自身 REST/WebSocket。

---

### Task 1: 通用 Hubstudio/CDP 浏览器运行时

**Files:**
- Create: `src/main/services/fingerprint-browser-runtime.ts`
- Create: `src/main/services/fingerprint-browser-runtime.test.ts`
- Modify: `src/main/services/mexc-browser.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- `FingerprintBrowserRuntime.configure(config)` accepts provider, container code and optional startup URL map.
- `FingerprintBrowserRuntime.attach(venueId, options)` returns a connected Playwright `Page` and a `BrowserSessionStatus`.
- `FingerprintBrowserRuntime.findPage(venueId, hostnames)` adopts an existing page without creating a second browser.
- MEXC keeps its current public methods; its Hubstudio connection delegates to the runtime.

- [x] Step 1: Add failing tests for same-container reuse, host-based page discovery, and refusal to attach when the configured container is empty.
- [x] Step 2: Run `npm test -- src/main/services/fingerprint-browser-runtime.test.ts` and verify the missing-runtime failures.
- [x] Step 3: Implement the runtime by extracting the existing Hubstudio start/status/CDP logic, including single-flight attach and disconnect cleanup.
- [x] Step 4: Preserve `MexcBrowserManager.configure` and delegate only the connection lifecycle; leave selectors and MEXC order logic unchanged.
- [x] Step 5: Run the focused runtime and MEXC browser tests.
- [x] Step 6: Commit `feat: add shared fingerprint browser runtime`.

### Task 2: Gate 指纹页面接管与捕获模式

**Files:**
- Modify: `src/main/services/gate-page-capture.ts`
- Create: `src/main/services/gate-order-capture.ts`
- Create: `src/main/services/gate-order-capture.test.ts`
- Modify: `src/main/services/gate-market-data.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- `GatePageCapture` accepts an optional `FingerprintBrowserRuntime`; when configured, it attaches an existing Gate page and does not create `persist:gate-events-arbdesk`.
- `GateOrderCaptureSource.startCapture()` enables request/response observation only; `captureManualOrder()` records an in-memory `GateOrderSchema`.
- `GateOrderSchema` contains endpoint, method, non-secret field names, response status fields, and a short-lived page binding; it excludes cookies, authorization values, signatures and full body persistence.

- [x] Step 1: Add failing tests that a configured runtime is used for Gate, an existing `gate.com` page is adopted, and captured headers/body secrets are redacted.
- [x] Step 2: Run the focused capture tests and verify failures.
- [x] Step 3: Implement Gate page binding, CDP request/response hooks, capture-mode status, and secret redaction.
- [x] Step 4: Keep the current independent Electron page only as an explicit read-only fallback when no fingerprint runtime is configured.
- [x] Step 5: Run Gate page and market-data tests.
- [x] Step 6: Commit `feat: attach gate capture to fingerprint browser`.

### Task 3: Gate credentials、预检和订单适配器

**Files:**
- Create: `src/main/platforms/adapters/gate-adapter.ts`
- Create: `src/main/platforms/adapters/gate-adapter.test.ts`
- Modify: `src/main/services/gate-preparation.ts`
- Modify: `src/main/services/gate-credential-store.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/platforms/registry.ts`

**Interfaces:**
- `GateAdapter` implements `VenueAdapter` and consumes `GatePageCapture`, `GateOrderCaptureSource`, `GateMarketData`, and `GateCredentialStore`.
- `preflightOrder` validates market freshness, direction/outcome mapping, price/depth, minimum quantity, account balance, expiry guard, and explicit Gate live flag.
- `submitOrder` is single-flight and sends only a schema-validated request through the bound Gate page; no guessed endpoint is allowed.
- `waitForFill` and `reconcileOrder` use captured response/stream data and return `UNKNOWN` when evidence is insufficient.

- [x] Step 1: Add failing tests for read-only blocking, missing schema blocking, one-submit-only behavior, non-retry on ambiguous response, and successful captured fill reconciliation.
- [x] Step 2: Run the adapter tests and verify expected failures.
- [x] Step 3: Implement the minimal adapter and extend preparation reports with capture/live-readiness stages.
- [x] Step 4: Keep Gate APIv4 credentials limited to verified account reads; do not route event orders through the spot API.
- [x] Step 5: The registry advertises Gate’s guarded adapter capability; the adapter enforces capture schema, explicit confirmation, and the live setting at runtime, otherwise it remains read-only.
- [x] Step 6: Run adapter, preparation, registry, and all existing platform tests.
- [x] Step 7: Commit `feat: add guarded gate venue adapter`.

### Task 4: 双腿执行与 UI 设置

**Files:**
- Modify: `src/main/services/multi-venue-execution.ts`
- Modify: `src/main/app-controller.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Modify: relevant preload/shared IPC files
- Create: focused execution/UI tests where existing patterns allow

**Interfaces:**
- Add `gateLiveEnabled`, `gateCaptureMode`, and Gate browser binding fields with safe defaults.
- Gate participates in the existing route builder and `TwoLegExecutionMachine`; MEXC↔Polymarket, MEXC↔Kalshi, and Polymarket↔Kalshi behavior remains unchanged.
- UI shows browser session, capture schema readiness, preflight result, live switch, and explicit “捕获模式/观察模式/实盘模式” status.

- [x] Step 1: Add failing tests for default-off Gate execution, capability-based route filtering, and no automatic submit while capture mode is active.
- [x] Step 2: Run focused tests and verify failures.
- [x] Step 3: Implement settings persistence, IPC wiring, adapter registration, and route filtering.
- [x] Step 4: Add a visible Gate “接管已登录页面 / 开始捕获 / 预检 / 手动确认” flow; never hide the live-order gate behind the generic auto-open switch.
- [x] Step 5: Run UI-facing controller and execution tests.
- [x] Step 6: Commit `feat: expose guarded gate execution controls`.

### Task 5: 集成验证与实盘解锁门禁

**Files:**
- Modify: `README.md`
- Modify: `docs/` Gate setup/runbook
- Add: integration fixtures/tests for captured Gate request and response

- [x] Step 1: Add a sanitized fixture representing a user-captured Gate order request/response; assert secrets are absent.
- [x] Step 2: Run `npm test`, `npm run build`, and `git diff --check`.
- [x] Step 3: Verify Gate starts in read-only/capture mode, MEXC regression tests pass, and no network POST is emitted without explicit live confirmation.
- [x] Step 4: Document the manual capture procedure and the exact conditions that unlock Gate live capability.
- [x] Step 5: Commit `docs: document gate fingerprint capture and live guard`.
