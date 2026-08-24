# Gate 指纹浏览器全链路设计

## 目标

让 Gate 复用用户已经登录的 Hubstudio/指纹浏览器环境，完成 BTC 5m/15m 事件合约的被动行情、账户状态、订单请求捕获、预检、手动/自动下单和成交回读；不改变现有 MEXC、Polymarket 和 Kalshi 的成熟实盘路径。

## 约束

- 现有 MEXC 的 Hubstudio 连接、页面选择器、行情监听和自动下单行为必须保持兼容。
- Gate 事件合约不能用现货 `/api/v4/spot/orders` 冒充下单接口。
- 未经用户手动触发的捕获动作，不得发送 Gate 订单。
- 捕获到的 Cookie、临时 token、签名值和完整请求体不得落盘。
- 订单 POST 超时或响应不明确时只允许 reconcile，不允许盲目重试。
- Gate 实盘默认关闭；必须经过捕获验证、预检和显式确认。
- 行情优先复用页面自身 REST/WebSocket，不增加固定高频轮询。

## 架构

新增通用 `FingerprintBrowserRuntime`，负责 Hubstudio Local API、CDP 连接、环境接管、标签页发现和生命周期；MEXC 与 Gate 通过各自的 `VenueBrowserSession` 使用它。Gate 页面监听、请求捕获和订单执行是 Gate 专属代码，不能复用 MEXC 选择器。

Gate 下单采用页面会话驱动：在捕获模式中记录用户手动最小订单实际使用的 endpoint、方法、请求字段和响应字段，运行时在同一登录页面内动态生成/复用身份信息发送一次订单；随后通过页面响应、WebSocket 或已捕获的查询响应完成回读。没有捕获到可验证的订单结构时，Gate 继续只读。

## 状态流程

`ATTACH_BROWSER -> FIND_GATE_PAGE -> CAPTURE_MARKET -> CAPTURE_ORDER_SCHEMA -> PREFLIGHT -> CONFIRM -> SUBMIT_ONCE -> RECONCILE -> FILLED/PARTIAL/REJECTED/UNKNOWN`

`UNKNOWN` 不自动再次提交，必须由 reconcile 或用户处理。

