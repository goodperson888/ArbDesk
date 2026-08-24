# 多平台套利架构

## 目标形态

同一个桌面应用集中展示所有已接入平台的 5 分钟、15 分钟互补结果组合。机会榜使用固定路由顺序，实时更新价格、可执行数量和净利润；系统推荐可执行净利润最大的组合，用户可以跟随推荐或锁定当前组合。

## 兼容边界

- MEXC 与 Polymarket 当前实盘流程继续由 `LEGACY_MEXC_POLY` 执行器负责。
- 新机会榜通过 `legacyOpportunityId` 映射回现有 `Opportunity`，不改变下单 IPC、订单状态机和持久化订单格式。
- 新平台默认只能提供行情和比较数据；未完成回放、模拟和受控实盘验证前，不能获得交易能力。
- Legacy 与新执行器不能同时接管同一套利组。

## 数据流

```text
平台连接器
  -> 标准化市场与盘口
  -> 结算规则指纹匹配
  -> 本地枚举 UP平台 × DOWN平台
  -> 深度、费用、滑点与资金上限计算
  -> MultiVenueBoardSnapshot
  -> 固定顺序机会榜
  -> Legacy 或 MultiVenue 执行器
```

平台之间的组合计算只发生在本地。每个平台共享一份市场缓存和一条行情流，不为每个平台组合重复请求行情。

## 当前第一阶段

- `src/shared/multi-venue.ts`：多平台、能力、腿和比较结果的共享契约。
- `src/main/domain/canonical-event.ts`、`event-catalog.ts`：统一事件身份和 BTC 5m/15m 目录；以后新增 ETH 只增加配置和映射。
- `src/main/domain/route-builder.ts`：在内存中生成所有平台组合的双向路线，不为每个比较重复请求平台。
- `src/main/platforms/venue-adapter.ts` 及 `platforms/adapters/*`：平台执行能力边界；MEXC、Polymarket、Kalshi 通过薄适配器复用成熟服务。
- `src/main/domain/two-leg-execution.ts`：通用首腿成交、第二腿对冲和未知状态恢复状态机。
- `src/main/services/execution-session-store.ts`：版本化执行会话和重启后的恢复审计。
- `src/main/platforms/contracts.ts`：市场数据、结算指纹和交易连接器接口。
- `src/main/platforms/registry.ts`：平台注册与能力声明。
- `src/main/platforms/legacy-board-adapter.ts`：把现有 MEXC/Polymarket 机会只读映射为通用机会榜。
- `src/main/services/limitless-market-data.ts`：Limitless BTC 5m/15m 市场发现与盘口，只读。
- `src/main/services/predict-fun-market-data.ts`：Predict.fun BTC 5m/15m 市场发现与盘口，只读。
- `src/main/services/gate-market-data.ts`：Gate 事件合约网页响应/推送的容错解析和 BTC 5m/15m 双向盘口标准化。
- `src/main/services/gate-page-capture.ts`、`gate-order-capture.ts`、`gate-order-transport.ts`：复用通用指纹浏览器页面，捕获用户手动订单结构并在显式门禁下执行一次页面会话订单。
- `src/main/services/kalshi-market-data.ts`：读取 KXBTC15M 开放市场、YES/NO 互补盘口并接入默认只读扫描；当前不纳入 5 分钟周期。
- `src/main/services/kalshi-preparation.ts`：Kalshi API 身份、余额、持仓、委托只读联调和本地 RSA-PSS 草稿签名；该准备流程仍保持只读。
- `src/main/services/kalshi-trading.ts`：供双腿协调器调用的 Kalshi V2 FOK 第二腿；不再暴露独立单腿 IPC 入口。
- `src/main/services/multi-venue-execution.ts`：当前实盘路线的门禁和兼容入口；具体双腿状态机由通用执行器负责，先回读首腿实际成交，再按实际数量发送第二腿，失败进入恢复态。
- `src/main/services/multi-venue-market-data.ts`：跨平台刷新去重和最近成功快照保留。
- `src/main/services/venue-preparation.ts`：两平台身份/账户只读联调、链上余额与授权检查、官方 SDK 离线构单签名，以及真实提交请求硬禁令。
- `src/main/domain/opportunity-ranking.ts`：按资金和数量模式计算可执行净利润。
- `AppSnapshot.multiVenueBoard`：向页面提供通用机会数据，同时保留原 `opportunities`。

## 后续接入约束

每个新平台按三种能力拆分：

1. 市场数据：市场发现、规则、快照和 WebSocket。
2. 交易执行：下单、撤单、订单查询、成交推送和余额。
3. 结算规则：数据源、起止时间、采样、比较符号、平局、作废和异常规则。

新接入平台只有规则匹配为 `EXACT` 或经过证明的 `COVERED`，才允许进入新执行器的自动候选集合。`CONDITIONAL`、`CORRELATED` 和规则缺失的组合只展示或记录。现有 MEXC/Polymarket Legacy 执行器继续遵守当前已经配置并验证的结算距离和条件型风控，不在本阶段改变行为。

## 上线阶段

1. 只读连接器与统一机会榜。
2. 影子比较，不发送订单。
3. 历史回放和模拟执行。
4. 手动确认的小额受控实盘。
5. 达到成交确认、幂等、请求限速和风险验收条件后才开放自动模式。

## 当前只读连接策略

- Limitless 公开 API 不需要密钥。只读取 `automationType=lumy`、CLOB、BTC、5m/15m 市场。
- Predict.fun 主网没有 API Key 时只启动一个持久网页，并通过 Electron CDP 被动读取网页自身的 categories/orderbook 响应与 WebSocket 帧；不复制网页凭据、不额外调用内部接口。配置官方 Key 后优先使用请求头鉴权 WebSocket，REST 只访问 categories 与 orderbook。
- Predict.fun API Key 使用系统钥匙串加密，不进入普通设置、日志或页面快照。
- Gate 没有在项目中确认的公开事件合约 API。软件优先接管用户已登录的 `/trade-events` 页面并被动读取页面自身流量；APIv4 Key 只用于官方 `GET /api/v4/spot/accounts` 身份/USDT 余额检查。订单必须来自用户手动捕获的真实请求，不能猜端点或改用现货订单接口。
- Kalshi 默认读取 KXBTC15M 的公开 Markets/Orderbook；当前不纳入 5 分钟周期。配置 API Key ID + RSA 私钥后，准备按钮仍只允许签名读取余额、持仓和活动委托；真实路径仅开放 MEXC↔Kalshi、Polymarket↔Kalshi 双腿人工 FOK，撤单、自动下单、充值、提现和划转均未接入。
- Limitless 的 HMAC Token ID/Secret、Profile ID、Base 钱包私钥，以及 Predict.fun 的账户类型、Deposit Address、Privy/EOA 私钥都从软件设置页录入；秘密字段由 Electron 系统安全存储加密，渲染进程只接收掩码、派生地址和配置状态。
- Limitless/Predict.fun 的市场目录缓存 15 秒、盘口快照缓存 4 秒；Kalshi 市场目录和盘口使用 15 秒缓存；所有来源同一轮刷新使用 in-flight Promise 去重。Gate/Predict.fun 默认各保持一个后台被动页面，用户可在设置页停止并销毁页面；不会按机会组合重复开页或请求。
- Limitless/Predict.fun 的盘口由 WebSocket 实时推送；Predict.fun 无 API Key 时完全沿用单页面自身流量。Gate/Predict.fun 默认各启动一个后台单页面，停止按钮会销毁页面并释放资源。Kalshi 默认使用两个系列目录请求和有界盘口读取；配置 Key 后才建立 ticker WebSocket，保持单轮去重和缓存上限。
- Predict.fun 没有 API Key 时仍使用网页被动监听；页面帧先按 orderbook/生命周期 topic 过滤再解析，Gate 的响应树使用线性队列遍历，避免无关心跳和 `Array.shift()` 带来的额外 CPU。设置页停止监听会销毁窗口并释放 Chromium 页面资源，Cookie/session 分区仍可复用。
- Limitless 的 YES 盘口来自官方 orderbook，NO 买价由 YES 买盘按 `1-price` 推导；数量按其 6 位抵押资产精度归一化。
- Predict.fun 官方 orderbook 是 YES 侧，NO 买价按市场 `decimalPrecision` 从 YES 买盘互补推导。

## 非下单完整联调

- 设置页的联调按钮只在用户点击时运行；同一时刻调用共享 in-flight Promise，15 秒内复用结果，不进入后台轮询。
- Limitless 读取 `/profiles/me`、持仓、历史和当前市场委托；Predict.fun 只额外调用动态 JWT 鉴权、账户、持仓和委托接口。
- Predict.fun JWT 仅保存在主进程内存并按过期时间复用，不持久化、不发送给渲染进程。
- 两个平台使用各自官方 SDK 生成订单字段并完成本地 EIP-712 签名。页面只收到签名哈希和阶段结果，不收到私钥、JWT、签名原文或完整订单载荷。
- 安全传输层仅允许 GET；Predict.fun 额外只允许 `POST /v1/auth`。`POST /orders`、撤单、授权、赎回和提现请求会在发出前直接抛错。
- Gate 余额联调使用独立白名单，只放行 `GET https://api.gateio.ws/api/v4/spot/accounts`；事件订单则只允许已捕获 schema 对应的 Gate 页面请求，未知 endpoint、字段不完整、超时和未知回执都拒绝或进入回读，不自动重试。
- Kalshi 准备联调只允许 `GET /portfolio/balance`、`GET /portfolio/positions`、`GET /portfolio/orders`；订单草稿和 RSA-PSS 签名只在内存中生成。独立实盘服务只允许官方 V2 `POST /portfolio/events/orders`，使用 FOK、单次提交和请求前价格/深度/到期校验。
- 零余额、零 Gas 和缺少 allowance 记为待资金，不妨碍验证身份、账户读取和本地构单签名。链上 RPC 暂时不可用也不会退化为真实提交。

## 结算兼容性现状

- Polymarket BTC 5m/15m：开盘基准与最终结算均使用 Chainlink BTC/USD 60 秒 TWAP；通过官方 RTDS 单 WebSocket读取实时值，平价归 Up。
- Limitless BTC 5m/15m：Chainlink BTC/USD 精确时点，结束价大于或等于起始价时 Up，平价归 Up。
- Predict.fun BTC Up/Down：Chainlink BTC/USDT，使用结束前一根 5 分钟 K 线收盘，平价按 50/50 处理。
- Gate BTC 事件合约：周期起点目标价与到期 Chainlink BTC/USD TWAP 比较，`TWAP >= 起点` 为 Up，平价归 Up；手续费仍需按单市场/账户实测，因此只显示毛边际。
- 因取价对、观察方法和平价规则不同，两者与现有市场默认归类为 `CONDITIONAL`，只显示毛边际并强制 `BLOCKED`。
- 新平台跨平台比较不会进入自动开单；现有 MEXC + Polymarket 对冲执行器保持不变。比较票据包含 Kalshi 且另一腿为 MEXC/Polymarket/Gate 时显示双腿人工执行按钮，Gate 仍需完成捕获和实盘开关。
