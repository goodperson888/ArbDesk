# 多平台多事件套利架构设计

## 目标

在不改变现有 MEXC↔Polymarket 成熟实盘链路行为的前提下，把项目重构为可扩展的多平台、多事件、双向套利系统。当前只启用 BTC 的 5 分钟和 15 分钟事件；以后加入 ETH、SOL 或其他事件时，只增加事件配置和平台市场映射，不修改套利核心。

## 范围与非目标

本阶段包含：

- 统一平台适配器接口，封装行情、预检、下单、成交回读和订单状态确认。
- 统一 BTC 事件模型，支持 5m/15m，并预留任意资产和事件类别字段。
- 由机会引擎自动计算所有已连接平台组合的两个方向，而不是在执行器中硬编码平台组合。
- 通用两腿执行状态机，支持首腿成交后按实际成交量对冲第二腿。
- 持久化执行会话、未知订单状态和恢复需求，避免重启后重复下单。
- 保留旧 MEXC↔Polymarket 执行入口作为兼容路线，并增加回归测试。
- 继续把 Limitless、Predict.fun、Gate 作为观察平台，只有适配器声明完整执行能力后才允许开放真实下单。

本阶段不包含：

- 新增 ETH 或非加密事件的实际市场抓取；只完成可配置模型和 BTC 配置。
- 跨平台原子交易；各平台没有共同事务，系统不会虚假承诺原子性。
- 默认开启自动实盘；所有新路线默认观察或人工确认。
- 重写 MEXC 页面拦截、MEXC 直连签名、Polymarket 冷签名或现有成交回读实现。

## 核心模型

### CanonicalEvent

所有平台市场先映射为统一事件：

```ts
interface CanonicalEvent {
  eventId: string
  category: 'CRYPTO' | 'SPORTS' | 'POLITICS' | 'FINANCE' | 'OTHER'
  subject: string
  interval?: string
  startTime: number
  endTime: number
  settlementSource?: string
  outcomes: CanonicalOutcome[]
}
```

BTC 5m 和 BTC 15m 的 `eventId` 由主体、周期、开始时间、结束时间、结果集合和结算来源共同确定。只有这些字段完全兼容的市场才可进入自动执行路线；相关但结算含义不完全相同的市场只能作为观察或人工机会。

### VenueAdapter

平台细节只存在于平台适配器：

```ts
interface VenueAdapter {
  readonly venueId: string
  readonly capabilities: VenueCapabilities
  discoverMarkets(): Promise<CanonicalMarket[]>
  subscribeQuotes(markets: string[]): Promise<void>
  preflightOrder(request: OrderRequest): Promise<PreflightResult>
  submitOrder(request: OrderRequest): Promise<OrderReceipt>
  waitForFill(orderId: string): Promise<FillResult>
  reconcileOrder(orderId: string): Promise<OrderState>
  cancelOrder?(orderId: string): Promise<CancelResult>
}
```

MEXC、Polymarket 和 Kalshi 先以包装适配器接入，内部复用原有实现。Limitless、Predict.fun 和 Gate 只实现行情适配器，不能通过缺少能力声明的路线提交订单。

### ArbitrageRoute

机会引擎输出标准化路线，而不是输出某两个平台的特殊结构：

```ts
interface ArbitrageRoute {
  routeId: string
  eventId: string
  direction: 'A_TO_B' | 'B_TO_A'
  legs: ExecutionLeg[]
  expectedEdge: string
  executableQuantity: string
  feeModel: FeeModel
  settlementRisk: RiskLevel
  executionPolicy: ExecutionPolicy
}
```

有 N 个平台时，系统在内存中生成最多 N×(N-1) 个有向路线，行情每个平台只采集一次，不为每个比较重复请求平台接口。

## 执行策略

策略枚举：

```ts
type ExecutionPolicy =
  | 'OBSERVE_ONLY'
  | 'MANUAL_TWO_LEG'
  | 'SEQUENTIAL_FILL_THEN_HEDGE'
  | 'PARALLEL_FOK'
  | 'AUTO_WITH_RECOVERY'
```

默认规则：

- 新平台和能力不完整的平台：`OBSERVE_ONLY`。
- 已确认可下单但没有原子能力的平台组合：`MANUAL_TWO_LEG`。
- MEXC、Polymarket 的成熟组合保持兼容执行逻辑。
- Kalshi 采用首腿成交后发送 FOK 第二腿。
- `PARALLEL_FOK` 和 `AUTO_WITH_RECOVERY` 不在本阶段默认启用，必须按平台组合单独授权。

通用状态机：

```text
PRECHECK → SUBMIT_LEG_A → WAIT_FILL_A
                         ├─ FULL_FILL → SUBMIT_LEG_B → WAIT_FILL_B → HEDGED
                         ├─ PARTIAL   → RECOVERY_REQUIRED
                         ├─ UNKNOWN   → RECONCILE_REQUIRED
                         └─ FAILED    → CANCELED
```

任意含糊的 POST 结果都禁止自动重试。每个订单使用路线级幂等键，恢复流程先查询订单状态，再决定是否补单或人工处理。

## 持久化与恢复

新增版本化的执行会话记录：

```ts
interface ExecutionSession {
  sessionId: string
  routeId: string
  eventId: string
  status: ExecutionStatus
  legs: ExecutionLegSession[]
  createdAt: number
  updatedAt: number
  recoveryAction?: RecoveryAction
}
```

应用启动时读取未完成会话，逐腿调用 `reconcileOrder`。系统不会因为启动恢复而再次提交未知订单；只有明确确认订单不存在，且用户完成二次确认后，才允许人工补单。

## 数据流与性能约束

- 每个平台维护一个行情适配器和一个市场缓存。
- 采集层负责去重、超时、退避和 in-flight 合并。
- 比较层只消费内存中的标准化行情，不直接请求平台。
- UI 只订阅节流后的快照，不参与行情轮询。
- 下单热路径只使用已缓存的市场 ID、余额、费用和签名材料；预检发现过期则拒绝执行。
- 每个平台有独立速率限制和熔断状态，任何平台触发封控只暂停该平台路线。

## UI 结构

继续使用机会表格，但把“路线”和“方向”作为一等字段：

```text
事件 | 周期 | 路线 | 第一腿 | 第二腿 | 方向 | 深度 | 净利润 | 状态
```

排序固定；有机会时自动选中最优路线，但利润微小波动不会频繁切换当前选中项。机会详情显示每一腿的报价、深度、行情年龄、执行策略和恢复风险。

## 迁移顺序

1. 增加统一共享类型和平台适配器边界，不改变现有下单实现。
2. 用适配器包装 MEXC、Polymarket、Kalshi，接入能力矩阵。
3. 建立 BTC 5m/15m 的 CanonicalEvent 和市场映射。
4. 将机会比较改为 N×N 有向路线，保留旧榜单字段兼容渲染器。
5. 将 Kalshi 专用双腿协调器抽象为通用两腿状态机。
6. 加入执行会话持久化和启动恢复审计。
7. 逐个平台运行观察、模拟、人工小额和实盘门禁测试。
8. 最后才开放新的平台执行能力；Limitless、Predict.fun、Gate 在没有完整成交回读前保持只读。

## 验收标准

- 现有 MEXC↔Polymarket 测试和真实执行入口的行为不变。
- BTC 5m/15m 产生统一事件 ID，至少能计算已接入平台的所有双向路线。
- 新增一个资产只需要新增资产配置和市场映射测试，不修改机会引擎或执行状态机。
- 首腿部分成交、第二腿失败、订单状态未知、市场过期和重复请求均有独立测试。
- 重启后可以显示未完成执行会话，且不会自动重复发送未知订单。
- 全量类型检查、单元测试和 Electron 构建通过。
