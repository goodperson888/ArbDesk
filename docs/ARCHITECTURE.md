# ArbDesk 架构与执行约束

## 进程边界

```text
React Renderer
    │ 受限 IPC
Electron Main ── AppController ── Execution State Machine
    │                                │
    ├── MEXC Browser Manager         ├── Risk checks
    │   ├── Embedded BrowserWindow   └── Audit events
    │   └── Hubstudio API → CDP
    ├── Polymarket broker
    └── Local data directory
```

- Renderer 不拥有 Node 权限，也不直接接触密钥。
- 内嵌 MEXC 页面运行在独立持久 Session 中，preload 只接受明确的校准、填充和点击指令。
- Hubstudio 模式只连接用户指定的 `containerCode`，通过其 Local API 返回的调试端口建立 CDP 会话。
- 两种浏览器模式分别保存选择器，不会跨模式复用校准结果。
- 所有不可逆操作由 Main 进程状态机协调。

## 执行状态机

```text
IDLE
  -> MEXC_OPENING
  -> MEXC_SUBMITTING
  -> MEXC_SUBMITTED
  -> MEXC_PARTIAL | MEXC_FILLED
  -> POLY_HEDGING
  -> HEDGED | RECOVERY_REQUIRED
```

硬约束：

- `MEXC_SUBMITTED` 不能直接进入 `POLY_HEDGING`；
- 只有 `MEXC_PARTIAL` 或 `MEXC_FILLED` 能触发对冲；
- 对冲数量等于 MEXC 实际成交数量；
- 状态迁移先写审计日志，再向 UI 广播；
- 已有未完成执行组时拒绝重复开仓。

## 机会计算

```text
all_in_cost_per_share
= mexc_price
+ polymarket_price
+ polymarket_fee
+ risk_buffer

polymarket_fee
= price × 0.07 × (1 - price)

conditional_profit
= quantity × (1 - all_in_cost_per_share)
```

该利润仅在两平台判定相反结果时成立。由于结算源不同，系统始终显示 `CONDITIONAL`。

## MEXC 校准

每种浏览器模式首次使用时，分别由用户选择四类元素：

- 金额输入框；
- UP 按钮；
- DOWN 按钮；
- 提交按钮。

校准点击在捕获阶段被阻止，不会传递给网页。生成的选择器优先使用 `id`、`data-testid`、`name` 和 `aria-label`，否则才使用有限层级 CSS 路径。

校准并不等于成交确认。订单提交后仍需以实际成交记录为准。
