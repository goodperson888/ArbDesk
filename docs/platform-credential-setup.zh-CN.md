# Limitless、Predict.fun 与 Gate 凭据配置指南

更新日期：2026-08-22

这份文档说明如何取得 ArbDesk 设置页需要的凭据。平台菜单和接口仍可能变化；如果页面名称与本文略有不同，以本文链接的官方文档为准。

## 先看安全要求

- 不要把 Token Secret、API Key 或钱包私钥发到聊天、邮件、截图或工单中。
- 只在 ArbDesk 的 `设置 → 账户与环境 → Limitless / Predict.fun / Gate` 中输入秘密值。
- 建议为自动交易使用独立小额钱包，不要使用保存主要资产的钱包。
- API Token 只开交易所需权限。不要开启提现权限。
- ArbDesk 使用 Electron 系统安全存储加密秘密字段；保存后页面只显示掩码、派生地址和验证状态。
- 如果怀疑凭据泄漏，请立即在平台撤销 Token/API Key，并把旧钱包资金转移到新钱包。

## 一、Limitless

### 需要准备什么

ArbDesk 需要三个值：

1. `Token ID`
2. `Token Secret`
3. Limitless 当前 EOA 交易钱包的私钥

`Profile ID` 和钱包地址由 ArbDesk 保存时自动读取/派生，不需要用户手工查找。

Limitless 已停止向新用户签发旧式静态 API Key。新用户必须使用 Scoped API Token，并用 Token Secret 对请求做 HMAC-SHA256 签名。官方说明：[Limitless Authentication](https://docs.limitless.exchange/developers/authentication)。

### 第一步：确认钱包与交易模式

1. 打开 [Limitless](https://limitless.exchange/) 并连接准备用于交易的 Base 钱包。
2. 确认账户已经完成初始化，网页可以正常查看市场。
3. 确认账户的 Trading Wallet Mode 是 `EOA`。
4. 如果以前启用过 1-click / Smart Wallet，需要先在 Limitless 的 Profile/Settings 中切换回 EOA 交易模式。

ArbDesk 当前采用 EOA EIP-712 自签名路线；Token 所属账户、Profile 返回的钱包地址和输入私钥派生地址必须一致，否则验证会拒绝通过。

### 第二步：派生 Scoped API Token

1. 在 Limitless 打开个人资料或 API Token 弹窗。
2. 进入 `API Tokens` 标签页。
3. 点击 `Derive`。
4. Scope 只选择 `trading`。
5. 不要选择 `withdrawal`。
6. 普通个人账户不需要 `account_creation` 或 `delegated_signing`。
7. 创建后立即复制：
   - `tokenId` → 填入 ArbDesk 的 `Limitless Token ID`
   - `secret` → 填入 ArbDesk 的 `Limitless Token Secret`

`Token Secret` 只在创建时显示一次。关闭窗口前必须先安全保存；丢失后无法再次查看，只能撤销旧 Token 并重新 Derive。

### 第三步：取得 EOA 钱包私钥

从你连接 Limitless 的钱包应用中导出当前 EOA 账户私钥：

- 必须是 `0x` 开头、后面 64 个十六进制字符。
- 必须对应 Limitless 当前 EOA 交易钱包。
- 不要填助记词。
- 不要填交易所充值地址、智能钱包地址或其他链的钱包地址。

不同钱包的导出入口不同，通常位于 `账户详情 → 显示私钥/导出私钥`。导出时应关闭录屏和剪贴板同步。

### 第四步：在 ArbDesk 保存并验证

进入：

```text
设置 → 账户与环境 → Limitless / Predict.fun → Limitless 交易身份
```

依次填写：

- Limitless Token ID
- Limitless Token Secret
- Limitless Base 钱包私钥

点击 `加密保存并验证 Limitless 身份`。软件会：

1. 本地派生钱包地址；
2. 用 Token ID/Secret 签名请求；
3. 调用官方 `GET /profiles/me`；
4. 自动读取 Profile ID；
5. 检查 Token 所属账户与私钥地址是否一致；
6. 使用同一 HMAC 凭据重建认证 WebSocket。

验证成功后应显示 Profile ID、缩写钱包地址和“身份已配置”。

没有余额也可以点击 `完整联调 Limitless（绝不下单）`。软件会读取身份、持仓、历史、当前市场委托、Base 余额和动态 allowance，并用官方 SDK 在本地构建、签名一笔测试载荷。签名不会提交，软件也没有真实下单、撤单或授权交易入口。

### 第五步：准备小额资金

- 网络：Base Mainnet，chain ID `8453`。
- 交易抵押物：USDC。
- Gas：少量 Base ETH，用于首次授权等链上操作。
- 首次测试建议只准备 5～20 USDC。

Limitless 不同市场可能返回不同 `venue.exchange`；ArbDesk 后续会按市场动态检查/设置 USDC allowance，不能把单个授权地址写死。

## 二、Predict.fun

只做机会扫描时，Predict.fun API Key 是可选项：ArbDesk 可以启动一个持久 Predict.fun 页面，被动监听该页面自身的 REST 响应和 WebSocket 帧。这个模式不会复制网页内部 Key，也不会额外调用内部接口。需要官方订单、持仓、成交事件和自动下单时，仍应申请主网 API Key。

### 不申请 Key，只扫描行情

1. 正常启动 ArbDesk，软件会在后台创建且只创建一个持久 Predict.fun 页面。
2. 进入 `设置 → 账户与环境 → Limitless / Predict.fun` 查看“页面”状态。
3. 如果提示页面加载超时，点击 `打开 Predict.fun 单页面行情`，在该窗口检查网络或完成人机验证；不要复制开发者工具里的任何 Key。
4. 页面成功加载后，ArbDesk 自动读取该页面已经产生的 categories、orderbook 和 WebSocket 行情，不会另发一套轮询请求。
5. 关闭该窗口只会隐藏，后台监听仍继续；配置官方 API Key 后软件会优先切换到官方 REST/WebSocket。

这个模式只提供公开机会扫描，不提供余额、持仓、订单状态或下单。若网页改版导致目标响应不再出现，设置页会保留明确诊断，不会用猜测的内部端点反复请求。

### 需要准备什么

Predict.fun 主网需要：

1. 主网 API Key
2. 账户类型：`Predict Account` 或 `EOA`
3. 对应账户地址
4. 对应的签名私钥

如果你平时直接使用 Predict.fun 网页，通常应选择 `Predict Account（网页智能钱包）`。

### 第一步：申请主网 API Key

Predict.fun 当前不在网页中自动生成主网 API Key，需要通过官方 Discord 申请：

1. 加入 [Predict.fun 官方 Discord](https://discord.gg/predictdotfun)。
2. 在 Discord 中创建 Support Ticket。
3. 说明需要 Predict.fun Mainnet API Key，用途是个人账户的行情读取和自动交易。
4. 收到 Key 后填入 ArbDesk 的 `Predict.fun 主网 API Key`。

不要在公开频道粘贴钱包私钥。官方申请说明：[Predict.fun API FAQ](https://dev.predict.fun/)。

### 第二步：网页账户选择 Predict Account

如果你一直通过 Predict.fun 网页交易：

1. 打开 [Predict.fun Account Settings](https://predict.fun/account/settings)。
2. 找到 Predict Account / Deposit Address，复制到 ArbDesk 的 `Predict Deposit Address`。
3. 在同一设置页导出 Privy Wallet 私钥。
4. 把 Privy 私钥填入 ArbDesk 的 `Privy Wallet 私钥`。

注意：

- Deposit Address 是持有 USDT 和预测份额的智能账户地址。
- Privy Wallet 是控制智能账户、签名和发起授权交易的 signer。
- 两个地址通常不同，不能互换。
- Predict Account 模式下，ArbDesk 会把订单 maker/signer 设置为 Deposit Address，再使用 Privy signer 完成智能账户签名流程。

官方说明：[Predict Account 与私钥导出](https://dev.predict.fun/) 和 [API 鉴权](https://dev.predict.fun/doc-663127)。

### 第三步：普通钱包选择 EOA

只有你明确用普通 EOA 钱包直接连接 Predict.fun 时才选择 EOA：

- `EOA 钱包地址` 必须和输入私钥派生地址完全一致。
- ArbDesk 会在保存时本地校验，不一致就拒绝保存。
- 不要把 Predict Deposit Address 填到 EOA 地址栏。

### 第四步：在 ArbDesk 保存

进入：

```text
设置 → 账户与环境 → Limitless / Predict.fun → Predict.fun 交易身份
```

填写 API Key、账户类型、账户地址和私钥，点击 `加密保存 Predict.fun 身份`。

保存后：

- API Key 会立即用于 Predict.fun 主网 REST/WebSocket；
- 软件只显示 API Key 掩码、账户地址和 signer 缩写；
- JWT 不需要用户填写，后续由软件通过官方签名挑战自动获取和刷新；
- 已保存的私钥不会回显，留空再次保存不会覆盖旧值。

配置完整后可以点击 `完整联调 Predict.fun（绝不下单）`。软件会获取内存 JWT，读取账户、持仓和委托，检查 BNB/USDT/授权，并用官方 SDK 构建和签名测试载荷。请求白名单只允许读取接口和 `POST /v1/auth`，会拒绝真实订单、撤单与链上授权交易。

### 第五步：准备小额资金

- 网络：BNB Chain Mainnet。
- 交易抵押物：USDT，放在 Predict Account/EOA 交易账户中。
- Gas：Predict Account 模式下，在 Privy signer 地址准备少量 BNB；EOA 模式下，在 EOA 地址准备少量 BNB。
- 首次测试建议只准备 5～20 USDT。

首次交易前还需要 ERC-20 USDT allowance 和 ERC-1155 ConditionalTokens operator approval。当前非下单联调只读取并展示缺失项，不会发起授权交易；以后开放小额受控实盘时也必须只对缺失项发起一次授权，不能每次下单重复授权。官方说明：[Predict.fun 下单与授权](https://dev.predict.fun/doc-679306)。

## 三、Gate 事件合约

Gate 的 BTC/ETH 事件合约支持 5分钟、15分钟、1小时和4小时。ArbDesk 当前只纳入 BTC 5分钟和15分钟；Gate 订单执行使用已登录的 Hubstudio 指纹浏览器页面，默认关闭。官方网页入口是 [Gate Event Contracts](https://www.gate.com/trade-events)。

### 只扫描行情，不配置 Key

1. 正常启动 ArbDesk；如果设置中已有 Hubstudio 环境 ID，软件会在该指纹环境中接管现有 Gate 标签页，不会复制 Cookie 或新建第二个指纹环境。
2. 进入 `设置 → 账户与环境 → Limitless / Predict.fun / Gate` 查看 `GATE页` 状态。
3. 若页面超时，点击 `打开 Gate 事件合约单页面`，在指纹浏览器中检查网络、地区资格或登录状态。
4. 软件只被动解析该页面自身事件合约 REST/WebSocket 流量，不另发内部行情轮询。

### 捕获 Gate 事件订单结构

1. 确认 Gate 指纹浏览器已登录并打开目标 BTC 5m/15m 事件页。
2. 点击 `开启 Gate 订单捕获模式（只等你手动下单）`。
3. 由你本人在 Gate 页面完成一次最小金额订单。此动作不是程序自动提交；程序只记录 endpoint、方法、字段名和返回状态。
4. 页面显示“已捕获订单结构”后，先点击 `完整联调 Gate（绝不下单）` 检查行情、余额和捕获字段，再按需开启 Gate 实盘开关。
5. 捕获结构只保存在本次运行内存中；Cookie、Authorization、签名和完整请求体不会写入文件。订单 POST 超时或状态不明只进入回读，不自动重发。

### 配置 APIv4 只读身份

完整的账户余额联调需要 Gate APIv4 Key 与 Secret：

1. 登录 Gate，进入 `个人中心 → API管理 → APIv4 Keys`。
2. 创建专用于 ArbDesk 的 Key。
3. 权限只开启 `现货/保证金 → 只读`；不要开启读写交易、合约交易或提现。
4. 条件允许时设置固定 IP 白名单。
5. 将 Key 和只显示一次的 Secret 填入 ArbDesk，点击 `加密保存 Gate 只读身份`。
6. 点击 `完整联调 Gate（绝不下单）`。软件只会签名调用官方 `GET /api/v4/spot/accounts`，验证身份并读取 USDT 可用/锁定余额。

Gate 公开 APIv4 文档目前没有已确认的事件合约专用市场、持仓、委托或订单端点。ArbDesk 不会猜端点，也不会使用 `/spot/orders` 冒充事件合约订单；订单请求必须来自用户手动捕获的 Gate 页面真实请求。若页面需要动态签名而捕获请求无法在当前会话复用，Gate 会继续保持只读并提示人工处理。

官方参考：[Gate APIv4 鉴权](https://www.gate.com/docs/developers/apiv4/en/)；[Gate 事件合约 FAQ](https://www.gate.com/zh/help/event-contracts/faq/100550/gate-event-contracts-faq)。

## 四、Kalshi（市场扫描与人工 FOK 下单）

Kalshi 的 KXBTC15M 系列已确认存在，ArbDesk 会用官方公开 Markets/Orderbook 接口扫描 KXBTC15M；当前不纳入 5 分钟周期。市场数据请求有缓存和 in-flight 去重。真实入口只支持机会面板中的 MEXC↔Kalshi 或 Polymarket↔Kalshi 双腿人工 FOK，默认关闭；不会自动下单、撤单、充值、提现或划转，也不会在网络超时后重试。

### 只扫描行情，不配置 Key

只看行情不需要配置 Key；软件会按系列各发起一个有界的公开市场目录请求，并按当前候选读取盘口。页面拦截仍可作为网络异常时的诊断回退。

### 配置 API 身份

1. 登录 [Kalshi](https://kalshi.com/)，进入账户设置中的 API Keys 页面。
2. 创建一个 API Key，复制 `Key ID`。
3. 下载或复制对应的 RSA 私钥 PEM。私钥通常以 `-----BEGIN RSA PRIVATE KEY-----` 或 `-----BEGIN PRIVATE KEY-----` 开头。
4. 在 ArbDesk 的 `设置 → 账户与环境 → Kalshi` 填写 Key ID 和 RSA 私钥，点击 `加密保存 Kalshi 身份`。
5. 点击 `完整联调 Kalshi（绝不下单）`，先确认余额、持仓和委托读取正常。
6. 将应用切换到“人工监督”模式后，单独开启“Kalshi 双腿实盘执行”。这个开关不会立即发单；每次机会面板点击按钮都会再次显示两边方向、数量、价格和首腿成交后再发 Kalshi 的确认框。

软件会签名读取余额、持仓和活动委托，并在本地用 RSA-PSS 生成一份订单草稿签名，验证到真实提交前的流程。不会发送 `POST /portfolio/events/orders`，也不会调用撤单、充值、提现或划转接口。

官方参考：[Kalshi API Environments](https://docs.kalshi.com/getting_started/api_environments)、[API Keys](https://docs.kalshi.com/getting_started/api_keys)、[Get Markets](https://docs.kalshi.com/api-reference/market/get-markets)、[Get Market Orderbook](https://docs.kalshi.com/api-reference/market/get-market-orderbook)、[Create Order V2](https://docs.kalshi.com/api-reference/orders/create-order-v2)。

## 五、常见问题

### Limitless 找不到旧式 API Key

这是正常的。官方已经弃用旧式静态 API Key；请进入 `API Tokens → Derive` 获取 Token ID + Token Secret。

### Limitless 提示 Token 和钱包地址不一致

检查：

- 创建 Token 时登录的是不是同一个钱包；
- 当前 Limitless Trading Wallet Mode 是否为 EOA；
- 是否误填了其他账户私钥；
- 是否启用过 1-click/Smart Wallet 但还没有切回 EOA。

### Predict.fun 找不到 API Key 页面

Predict.fun 主网 Key 当前通过官方 Discord Support Ticket 申请，不是在账户设置页直接生成。

### Predict.fun 的 Deposit Address 和 Privy 地址为什么不同

网页账户是智能钱包结构。Deposit Address 是 Predict Account，Privy 地址是控制它的 signer；应分别按字段填写，不能要求两者相同。

### 是否把密钥发给开发者验证

不要。只在 ArbDesk 设置页输入。需要排错时提供页面显示的脱敏状态、HTTP 状态码和错误文字，不提供任何秘密值。

## 六、配置完成检查表

- [ ] Limitless Trading Wallet Mode 已设为 EOA
- [ ] Limitless Token Scope 只有 `trading`
- [ ] Limitless Token ID/Secret 已在 ArbDesk 加密保存
- [ ] Limitless 自动读取到 Profile ID，钱包地址匹配
- [ ] Base 钱包有小额 USDC 和 ETH
- [ ] 若要接入订单/持仓/自动下单，Predict.fun Mainnet API Key 已取得（仅页面行情扫描可跳过）
- [ ] Predict Account/EOA 类型选择正确
- [ ] Predict 账户地址与签名私钥填写正确
- [ ] BNB Chain 账户有小额 USDT 和 BNB Gas
- [ ] Gate 单页面已能捕获 BTC 5m/15m 双向盘口
- [ ] 如需账户余额联调，Gate APIv4 Key 仅开现货只读且已加密保存
- [ ] Gate 联调报告只出现 `GET /api/v4/spot/accounts`，没有订单、撤单或划转请求
- [ ] Kalshi Key ID 与 RSA 私钥已在 ArbDesk 加密保存
- [ ] Kalshi 联调报告只出现余额、持仓和活动委托 GET
- [ ] 如需人工实盘，已明确开启开关并理解先首腿成交、再发 Kalshi FOK；网络超时不自动重试
- [ ] 没有在聊天、截图或代码仓库中暴露任何秘密值
