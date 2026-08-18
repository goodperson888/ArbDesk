# ArbDesk — MEXC × Polymarket

一个本地优先、有人监督的 BTC 预测市场跨平台执行桌面应用。界面使用 React，桌面运行时使用 Electron，核心逻辑使用 TypeScript 与十进制定点数。

> 当前版本是可运行的安全 MVP。扫描器只显示 MEXC 与 Polymarket 官方接口返回的真实盘口，不再生成模拟行情；任一数据源断开时显示空列表和错误原因。模拟模式只模拟成交过程。真实资金模式必须在完成账户、页面、盘口和失败恢复测试后手动启用。

## 已实现

- macOS / Windows 桌面应用结构，无需用户安装 Node 或数据库；
- BTC 5 分钟、15 分钟机会看板；
- Polymarket 当前滚动市场发现、真实 CLOB 卖盘和按市场查询的费率；
- 精确金额、份额与预计利润计算；
- 页面内可悬浮/点击查看手续费、条件收益率、最坏亏损率与结算距离公式；
- 可增删“剩余秒数 → 最低 bps”规则节点，节点间线性插值并持久保存（默认 `120秒 → 2bps`、`20秒 → 0.5bps`）；
- 最低净边际可由用户调整（默认 `$0.0100/份`），机会刚满足全部门槛时按市场与方向播放带冷却的提示音；
- 核心判断区适配最小桌面窗口一屏，MEXC/Polymarket连接状态始终可见，日志改为按需展开；
- 按套利组持久保存双腿历史、成交与剩余持仓，支持MEXC单腿、Polymarket单腿及双腿中途平仓；
- `CONDITIONAL` 结算风险标识；
- MEXC 内嵌登录窗口与持久 Cookie 容器；
- 可选 Hubstudio 指纹浏览器环境，通过 Local API + CDP 监控和操作页面；
- 从 MEXC 页面同源公开接口读取当前 BTC 5m/15m 事件、UP/DOWN symbolId 和盘口深度；
- MEXC 金额框、UP、DOWN、提交按钮的可视化校准；
- `MEXC 成交 → Polymarket 对冲` 强制状态机；
- Polymarket BUY 使用精确份额的可立即成交限价 FAK：接受限价内更优价格和部分成交，按 MEXC 实际成交量自动补齐；未补齐时显示双腿实际成交与剩余敞口，可人工重试或平仓处理；
- 恢复对冲的最大可接受亏损和自动补单次数均可由用户配置，不会无限价追单；
- 双腿中途平仓遵循 `MEXC自动卖出并回读实际成交 → Polymarket SELL FOK同量平仓`，失败进入恢复状态；
- 部分成交只按实际成交量对冲；
- 模拟交易、人工成交确认、审计日志和风险限制；
- 同一开始/结束时间窗的 MEXC 与 Polymarket 报价才会配对；
- Polymarket 签名类型、funder、签名私钥和 L2 API 凭据配置页；秘密凭据由 Electron `safeStorage` 使用系统钥匙串加密，渲染进程只看到状态和掩码；
- 默认关闭真实资金与 MEXC 实验自动点击。
- 启动前限时授权门禁：未授权或到期时不挂载交易主界面；若到期时仍有未处理敞口，只保留最小化的恢复与平仓页面。

## 当前安全边界

1. MEXC 和 Polymarket 使用不同结算源，机会不是保证锁利。
2. MEXC 网页自动化属于实验能力。验证码、登录过期或页面元素变化时不得继续。
3. Polymarket 公共行情不需要登录或钱包地址；真实下单需要钱包签名、funder 地址和 API 凭据，当前未配置，所以人工监督模式不会伪造第二腿成交。
4. 不保存 MEXC 密码，不绕过验证码或 2FA。
5. 任何真实资金测试都应使用独立小额账户，并关闭提现权限。
6. 两腿开仓和平仓都不具备跨平台原子性；单腿平仓会主动形成方向性敞口，必须经过风险确认。

## 本地开发

```bash
npm install
npm run dev
```

测试与生产构建：

```bash
npm test
npm run build
```

生成 macOS 安装包：

```bash
npm run package:mac
```

生成 Windows 安装包需要在 Windows 或对应 CI 环境运行：

```bash
npm run package:win
```

## 使用流程

1. 启动应用，先复制机器码并输入管理员签发的限时授权码；授权通过前不会加载交易主界面。
2. 进入主界面后默认处于“模拟模式”，选择机会与对齐份额，先完整跑通模拟执行。
3. 在设置中切换“人工监督”。
4. 在设置中选择“内嵌浏览器”或“Hubstudio”。Hubstudio 用户需填写环境 ID，并由 ArbDesk 打开该环境。
5. 打开 MEXC 监督窗口并正常登录。
6. 依次校准金额输入框、UP 按钮、DOWN 按钮、确认下单按钮。两种浏览器模式分别保存校准结果。
7. 准备 MEXC 第一腿后，以 MEXC 页面实际成交记录为准填写成交量和均价。
8. 应用只按实际成交份额触发第二腿对冲。

## MEXC 浏览器模式

### 内嵌浏览器

无需安装 Hubstudio。ArbDesk 使用 Electron 独立窗口和 `persist:mexc-arbdesk` Session 保存 MEXC Cookie，不读取或保存密码。

### Hubstudio

1. 在 Hubstudio 客户端启用 Local API；
2. 在 ArbDesk 设置中填写目标环境 ID（`containerCode`）；
3. 点击“保存并使用Hubstudio”，再点击“打开Hubstudio环境”；
4. ArbDesk 调用 `http://127.0.0.1:6873/api/v1/browser/start`，取得 `debuggingPort` 后通过 Playwright CDP 连接；环境已经运行时也会尝试从其进程监听端口直接附加；
5. 在 Hubstudio 窗口中登录并完成该模式独立的四项网页元素校准。连接后软件会分别预热当前 5 分钟和 15 分钟交易页，实际执行优先复用对应页面，不在下单热路径临时切换周期。

当前本地工作副本已预填环境 ID `1643173278`。ArbDesk 不保存 Hubstudio `app_id` 或 `app_secret`，这些凭证由 Hubstudio Local API 自己管理。

## 真实数据来源

- MEXC：事件轮次先从页面已有响应读取，UP/DOWN 深度和 5m/15m BTC 指数通过 Prediction WebSocket 持续订阅；仅在首次快照、跨盘、推送静默或开仓前所选盘口超过 500 毫秒未更新时使用 REST 补充校验。首档卖价和首档数量用于机会计算。
- Polymarket：Gamma API 按 `btc-updown-5m-{startUnix}` / `btc-updown-15m-{startUnix}` 发现市场，CLOB API 获取每个 outcome token 的卖盘和费率。
- Chainlink：目前只作为 Polymarket 结算规则来源，应用未单独接入 Chainlink 实时报价，因此状态会明确显示“未接入”。
- Binance：可以以后增加为参考现货价，但不能替代 MEXC Prediction 盘口，因为二者不是同一可成交合约。

## Polymarket 网络代理

设置页可以填写 HTTP/HTTPS 代理，例如 `http://127.0.0.1:7890`，并点击“保存并测试公开行情”。代理用于 Gamma、CLOB 和后续官方 SDK 请求，不会修改 Hubstudio 环境自己的代理。留空表示直连。

当前本地配置已使用 `http://127.0.0.1:7890` 完成真实联调：BTC 5m/15m 市场发现、CLOB 双边订单簿均可访问。Polymarket 费用读取 V2 CLOB 市场详情的 `fd.r`（曲线费率）与 `fd.e`（曲线指数）；参数缺失或请求失败时不会生成机会。`/fee-rate` 的 `base_fee` 不再被误作 V2 曲线参数。

MEXC 费用只采用账户最近 7 天最新一笔买入流水：存在配对手续费流水时按实际比例计算，不存在手续费流水时视为该笔零费。页面已有流水、账户完整读取和成交回读都会合并进本地滚动缓存；短分页中的孤立成交不会被误判为零手续费。后台每15秒只轻量刷新MEXC余额；开启真实对冲后每20秒预热一次Polymarket交易容量。下单热路径只读不超过30秒的账户缓存，不再临时执行完整身份验证。手续费最多每10分钟兜底校验一次，无法验证时会标为“待校验”并禁止执行。

“最大”使用两边当前 WebSocket 多档盘口、缓存余额、费用、单笔本金和收益门槛计算，不再触发完整 Polymarket 身份验证。系统会分别给出“账户可支付上限”和“收益可执行上限”，账户余额预留1%安全垫；如果当前没有满足收益门槛的数量，点击“最大”仍会把旧输入纠正到账户可支付上限，但保持执行按钮禁用并明确说明原因。深度计算会逐档累计均价与手续费，只允许吃到仍满足最低净边际和最低条件收益率的位置；开仓前会按同一模型再次复核。

实盘控制可以单独布防自动开单：全部执行条件连续满足用户设置的 `0–1000ms` 后触发，默认 `100ms`；期间只读取内存中的实时推送和后台预热的账户缓存。MEXC金额输入后通过DOM变化监听按钮可用状态，50ms检查仅作兜底，不再累计固定等待；自动提交时跳过高亮动画。每个周期轮次最多自动开一单；同一盘口复核失败会等待新盘口，新盘口可立即重新触发，不再附加全局2秒退避。连接或执行异常会自动停用，应用重启后不会自动恢复布防。

MEXC实际成交优先从网页自身产生的第一页流水响应中被动识别；若未匹配到，才按逐步放缓的间隔主动读取短分页，并在捕获到对应成交后立即停止轮询。执行状态条会显示复核、页面/按钮、MEXC成交、Polymarket对冲和总耗时，便于判断延迟来自哪一段。

## 限时授权

授权采用离线 Ed25519 签名，不需要部署服务器，也不会在每次下单时联网验证。客户端只内置公钥；管理员私钥只保存在本机 `.license-private/`，该目录已加入 Git 忽略规则。

首次生成发行密钥：

```bash
npm run license:keygen
```

生成后必须离线备份 `.license-private/license-private-key.pem`。私钥丢失后无法给已经发布、内置当前公钥的软件续期；私钥泄漏则需要轮换公钥并重新发布客户端。不要提交、截图或发送该文件。

客户把授权页显示的机器码发给管理员后，可按天数签发：

```bash
npm run license:issue -- --machine ARB-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX --days 30 --customer "客户名"
```

也可使用固定到期时间：

```bash
npm run license:issue -- --machine ARB-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX --until 2026-12-31T23:59:59+08:00 --customer "客户名"
```

授权码绑定机器并使用系统安全存储加密保存。软件每15秒检查到期状态和明显的系统时钟回退；到期后立即停止自动开单并退出交易主界面。若当时存在已成交、未知成交或恢复中敞口，只显示应急恢复/平仓功能，处理完成后返回授权页。离线授权能阻止普通复制使用，但 Electron 客户端仍可被有能力的攻击者修改，因此它属于商业使用约束，不等同于不可破解的 DRM。

## 实验与实盘开关

MEXC 自动点击在完成四项校准后，可以从设置页明确确认开启。开发环境的 Polymarket 真实资金总开关使用环境变量，防止误用普通开发启动命令：

```bash
ARB_ENABLE_LIVE_EXECUTION=true
```

`npm run dev:live` 会自动设置该变量。正式安装包内置发行版能力开关，但仍只能在“人工监督”模式中由用户依次开启 MEXC 自动点击、Polymarket 真实对冲，并经过界面确认；BUY 对冲使用精确份额 FAK，SELL 平仓仍使用 FOK。凭据验证、金额、行情时效和结算信号等风控不会绕过。

Polymarket 设置页允许用户自行选择签名类型（EOA、POLY_PROXY、GNOSIS_SAFE、POLY_1271）并填写 funder、订单签名私钥、API key、secret 和 passphrase。秘密值不会写入普通 `settings.json`，也不会回显。配置完成只表示本地材料齐全，不代表已验证余额、allowance 或下单权限；在官方 CLOB 网络连通并完成只读验证前，真实提交仍保持禁用。

## 项目结构

```text
src/
  main/
    domain/              # 机会公式和执行状态机
    services/            # MEXC 浏览器、Polymarket、审计存储
    app-controller.ts    # 风控与执行协调
    index.ts              # Electron 主进程和安全 IPC
  preload/
    index.ts              # 主界面受限桥接
    mexc.ts               # 内嵌 MEXC 页面校准与受控 DOM 操作
  renderer/
    src/                  # React 交易控制台
  shared/                 # 跨进程类型
design-system/            # UI 设计系统
```

## 下一阶段

- 将当前 Polymarket REST 轮询升级为订单簿 WebSocket 和用户成交流；
- 继续使用真实 token ID 扩充分笔成交、订单状态和恢复路径核验；
- 增加凭据只读验证、pUSD/POL 余额与 allowance 检查；
- 在登录账户中验证 MEXC Prediction Markets 实际 DOM 和成交记录结构；
- 增加 MEXC 成交状态自动读取与页面版本指纹；
- 故障注入：部分成交、拒单、超时、页面变化、网络断线；
- 使用小额纸面/沙盒数据校准滑点和停止交易窗口。
