# 平台接入验收记录

更新日期：2026-08-22

| 平台 | 行情/市场 | 账户只读 | 非下单验证 | 真实执行状态 |
|---|---|---|---|---|
| MEXC | 5m/15m 页面 REST + WebSocket | 余额、流水、成交回读 | 现有实盘链路已保留 | `LIVE`，仅 Legacy MEXC→Polymarket 执行器 |
| Polymarket | Gamma + CLOB 深度/费率 | 余额、授权、委托、成交 | 身份与容量验证 | `LIVE`，仅 Legacy 对冲腿 |
| Limitless | 官方市场、订单簿、实时推送 | Profile、持仓、历史、委托、链上余额/allowance | 官方 SDK 离线构单签名 | `READ_ONLY`，提交/撤单/授权禁用 |
| Predict.fun | 官方 API 或单网页被动 REST/WebSocket | JWT、账户、持仓、委托、链上余额/授权 | 官方 SDK 离线构单签名 | `READ_ONLY`，提交/撤单/授权禁用 |
| Gate | 单个 `/trade-events` 页面被动 REST/WebSocket；已适配真实 `contract_events/list` 与事件详情字段 | APIv4 只读 USDT 余额；已登录页面产生的事件持仓/委托只做被动计数 | APIv4 HMAC 身份验证 | `READ_ONLY`，仅允许一个余额 GET；事件订单 API 未公开 |
| Kalshi | KXBTC15M 开放市场与 YES/NO 互补盘口扫描（当前不纳入5m） | API Key ID + RSA-PSS 签名读取余额、持仓、活动委托 | MEXC↔Kalshi、Polymarket↔Kalshi 先回读首腿，再发送 Kalshi FOK | `LIVE`（仅人工双腿）；默认关闭，自动下单、撤单、充值、提现和划转禁用 |

## 统一安全检查

- 新平台机会统一由 `read-only-board-adapter` 生成，状态固定为 `BLOCKED`，不会进入跟随最优、手动下单或自动下单。
- Limitless/Predict.fun/Gate 仍为 `placeOrder=false`；Kalshi 为 `placeOrder=true` 但仅支持人工确认 FOK，`cancelOrder=false`、`fillStream=false`。
- 非下单联调有 in-flight 去重和 15 秒结果缓存，不因重复点击叠加账户请求。
- Gate 页面只创建一个持久窗口；跨平台组合计算完全使用内存快照，不按平台组合重复请求。
- Gate API 联调只允许 `GET https://api.gateio.ws/api/v4/spot/accounts`。任何其他域名、路径或非 GET 方法在发送前拒绝。
- Kalshi 准备联调只允许余额、持仓和活动委托三个 GET 路径；独立真实入口只允许官方 V2 创建订单 POST，任何撤单、充值、提现或划转请求在发送前拒绝。
- Gate 深度未出现时只展示价格并将可用量保持为 0；不以总流动性、最低单量或价格反推虚假深度。
- MEXC + Polymarket 原执行状态机、订单持久化和恢复流程未迁移到新执行器。

## 仍需真实资金/平台正式接口才能完成的项目

- Kalshi 的真实订单接受/部分成交和 FOK 结果只能用受控小额双腿订单验证；撤单、成交推送和实际手续费仍未接入，首腿成交而第二腿失败会进入恢复态。
- Gate 公开 APIv4 尚未提供事件合约专用持仓、委托、构单与成交端点；当前账户详情只能从已登录单页面自身响应被动读取，不能主动补请求。
- Gate 网页盘口若只返回最优价格、不返回档位数量，机会榜会显示价格但数量为 0；只有捕获到真实 CLOB 深度后才显示可比较数量。

## 本次自动化结果

- TypeScript 类型检查通过。
- 24 个测试文件、130 项测试通过。
- 生产构建通过。
- 生产运行检查中五个平台均成功注册；Gate 单页面实际捕获到事件合约 REST 与 WebSocket 流量。
