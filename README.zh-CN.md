# mixin-builder

[English](README.md) | **简体中文**

一个 Agent 技能，用于在 Mixin 网络上构建产品 —— Messenger 机器人、带 Mixin 登录的 Web 应用、Safe/UTXO 支付与托管、Mixin Computer（Solana）调用，以及 MTG 可信组程序。

协议论断均对照锁定版本的 SDK 源码验证并注明日期。每一个有副作用的流程都以**如何验证它生效**收尾。

这是一个 Agent 技能：装进你的 Agent，然后通过对话来构建。[通过你的 Agent 构建](#通过你的-agent-构建)是主路径；想动手的直接[运行工具](#直接运行工具)；[管理机器人钱包](#不写代码管理机器人钱包)则完全不需要写代码。

## 安装（装进你的 Agent）

```bash
# 从 GitHub 安装（skills CLI）
npx skills add baizhiheizi/mixin-builder

# 或手动：把技能目录复制进你的 Agent 的技能目录
cp -r skills/mixin-builder ~/.agents/skills/   # 也可以是 .claude/skills/、.codex/skills/ 等
```

无需构建。Claude Code、Codex、opencode 以及任何兼容 skills 的 Agent 都可用。

## 通过你的 Agent 构建

在你的项目里打开 Agent，直接描述你要构建的东西。技能会让 Agent 路由到相关参考文档、从脚手架起步、用只读探针读取实时事实，并执行安全护栏：先 dry-run 再产生实际效果，签名前需获得你的明确确认。

先准备一个文件：keystore。在[开发者面板](https://developers.mixin.one)创建应用 → 你的应用 → **Secret** → 生成 `keystore.json`。务必保密 —— 谁持有其中的 `spend_private_key`，谁就持有这笔钱。

下面这些提示词可以直接用：

| 你说 | Agent 会做什么 |
|---|---|
| “用 Node 给我做一个 Mixin Messenger 机器人，keystore 在 `~/ks.json`。” | 从 `assets/scaffold-bot-echo/node` 起步 —— Blaze 连接、处理完才 ACK、重连退避 —— 把回复逻辑改成你的产品需要的样子，跑起来，然后和你一起验证：发 `/ping` 收到恰好一条 `echo: /ping`，`kill -9` 重启后依然恰好一条。 |
| “我的 Web 应用需要 Mixin 登录。” | 按 `references/identity-and-keys.md` 执行：带 PKCE 的 OAuth、选择 scope、在服务端完成 code 换 token。从 `assets/scaffold-oauth-web` 起步，client secret 绝不进浏览器。 |
| “我的商店用 USDT 卖课程 —— 收款并给订单入账。” | 按 `references/payments.md` + `reconciliation.md` 执行：锁定 `asset_id`（同一符号 ≠ 同一资产）、每个订单用稳定的 `trace_id` 签发支付链接、按 `snapshot_id` 只入账一次（基于 `assets/scaffold-payment-watcher`）、先 dry-run；处理少付/多付和退款。 |
| “给 `bc1q…` 转 0.01 BTC” | 金额用十进制字符串、`trace_id` 保持稳定、先通过 `/safe/transaction/requests` 免费验证原始交易，**经你确认**资产/金额/收款方/trace 后才签名，随后轮询到 `spent` 并把快照作为凭证展示给你。 |
| “我懂 Solidity —— Mixin 和它有什么不同？” | `references/concepts.md`：把 kernel / sequencer / Safe / Blaze 映射到 EVM 概念，UTXO 对比账户模型，为什么没有 gas。 |
| “我的机器人 Blaze 连接报 `10006 Update required`。” | `references/gotchas.md` #19：网关要求 `User-Agent: name/version`；Node SDK 的 `BlazeKeystoreClient`（7.6.0）不发这个头 —— 用脚手架的 `blaze-client.mjs`。 |
| “错误码 `30102` 是什么意思？” | `references/common-errors.md`：错误码 → 最可能的原因 → 修复。 |

任何涉及资金移动的请求都需要确认（`SKILL.md` 护栏 #7）：Agent 会展示资产（`asset_id`，而不只是符号）、金额、收款方和 trace，得到你的明确同意后才签名。

### 命令

针对重复性工作流，技能在 [`commands/`](skills/mixin-builder/commands/) 里附带五个斜杠命令提示词。复制进你 Agent 的命令目录（`.claude/commands/`、`~/.config/opencode/command/` 等），即可用 `/mixin-*` 调用：

| 命令 | 作用 |
|---|---|
| `/mixin-audit` | 审计当前项目的 Mixin API 用法 —— 编造的 SDK 符号、安全护栏违规、错误处理、对账模式 —— 按严重程度列出发现，附文件:行号 |
| `/mixin-fit` | 分析当前产品，映射到合适的 Mixin 能力：现在用/以后用什么、读什么、从哪个脚手架起步、按什么顺序构建 |
| `/mixin-probe` | 只读实测：注册状态（`has_safe`）、精确余额、账本分页语义 |
| `/mixin-drift` | 把项目已安装的 SDK 版本与技能的已验证矩阵比对；版本不同处重新读取已安装源码 |
| `/mixin-error <错误码\|症状>` | 查错误码或症状（错误码 → 原因 → 修复），然后在代码库里定位引发问题的模式 |

## 直接运行工具

脚手架和脚本都是朴素、少依赖的文件 —— 可以当示例读，也可以脱离 Agent 直接跑。环境要求：`scripts/` 需 Node ≥ 20（零 npm 依赖）· 监听器需 Node ≥ 22（`node:sqlite`）· Go ≥ 1.27 · Ruby ≥ 4.0。

```bash
git clone https://github.com/baizhiheizi/mixin-builder.git && cd mixin-builder
SKILL=skills/mixin-builder

# echo 机器人（node/ go/ ruby/）—— Blaze 消息、ACK 语义、重连退避
cd $SKILL/assets/scaffold-bot-echo/node && npm install
KEYSTORE=/path/to/keystore.json node index.mjs    # 验证：/ping → 恰好一条 echo，kill -9 重启后依然如此

# 支付监听 —— Blaze 触发 + /safe/snapshots 对账，只入账一次
cd ../../scaffold-payment-watcher && npm install
KEYSTORE=/path/to/keystore.json node watcher.mjs  # 默认 dry-run；输出确认无误后才加 --no-dry-run

# OAuth Web 登录 —— 跳转授权 + code 换 token + 读取资料（零依赖）
cd ../scaffold-oauth-web
MIXIN_APP_ID=… MIXIN_CLIENT_SECRET=… PORT=3000 node server.mjs

# 只读实时探针（只发 GET；绝不读取支付私钥）
node $SKILL/scripts/probe.mjs computer                       # Mixin Computer 信息（无需鉴权）
node $SKILL/scripts/probe.mjs me --keystore ks.json          # 鉴权 + Safe 注册状态
node $SKILL/scripts/probe.mjs outputs --keystore ks.json     # 精确余额，全分页
node $SKILL/scripts/probe.mjs snapshots --keystore ks.json   # 近期账本 + 分页语义检查
node $SKILL/scripts/probe.mjs snapshot <id> --keystore ks.json
```

注意：如果不用脚手架、自己写客户端，每个 HTTP 请求和 Blaze 握手都必须带 `User-Agent: name/version` 请求头 —— 否则 API 返回 `10006 Update required`（→ `references/gotchas.md` #19）。

## 不写代码管理机器人钱包

不需要脚手架，也不需要懂 SDK。把技能装进你的 Agent（Claude Code、Codex 或任何兼容 skills 的 Agent），然后直接对话。

你只需要一个文件：机器人的 `keystore.json`，来自你创建机器人的[开发者面板](https://developers.mixin.one)。务必保密 —— 谁持有其中的 `spend_private_key`，谁就持有这笔钱。

下面这些提示词可以直接用；技能会把 Agent 引导到正确的参考文档和安全护栏：

| 你说 | Agent 会做什么 |
|---|---|
| “我的 keystore 在 `~/keystores/my-bot.json`，查一下机器人余额？” | 运行 `scripts/probe.mjs me`（注册状态）和 `outputs`（把所有未花费 UTXO 按 `asset_id` 精确求和 —— Mixin 没有余额字段）。全程只读：绝不读取支付私钥。 |
| “给 `bc1q…` 转 0.01 BTC” | 按 `references/payments.md` 执行：金额用十进制字符串、`trace_id` 保持稳定、先通过 `/safe/transaction/requests` 免费验证原始交易、经你确认后才签名，随后轮询到 `spent` 并把快照作为凭证展示给你。 |
| “昨天以来有没有人给机器人付款？” | 按 `references/reconciliation.md` 遍历快照：付款人、资产、金额、trace —— 按 `snapshot_id` 去重。 |

转账要求机器人已完成 Sequencer 注册；如果 `probe.mjs me` 显示 `has_safe: false`，Agent 会依据 `references/identity-and-keys.md` 带你完成注册。

## 覆盖范围

15 个参考文件、约 2100 行，每一条论断都注明来源和验证日期：

| 领域 | 参考文件 | 要点 |
|---|---|---|
| 心智模型、EVM/Telegram/金融科技对照 | [`references/concepts.md`](skills/mixin-builder/references/concepts.md) | kernel / sequencer / Safe / Blaze、各角色、资产模型（同一符号 ≠ 同一资产） |
| 密钥、鉴权、身份 | [`references/identity-and-keys.md`](skills/mixin-builder/references/identity-and-keys.md) | keystore 结构 + 新旧格式、密钥分离、JWT、TIP PIN、Sequencer 注册、OAuth（PKCE + secret）、子账户、app-security |
| Blaze WebSocket | [`references/blaze.md`](skills/mixin-builder/references/blaze.md) | 线协议、ACK 契约、重连守则、IP 封禁事件 |
| 消息 | [`references/messaging.md`](skills/mixin-builder/references/messaging.md) | 全部消息类别、APP_CARD 结构、群组/圈子、附件、加密消息 |
| 支付 | [`references/payments.md`](skills/mixin-builder/references/payments.md) | UTXO 模型、转账生命周期、多签、提现及费率分支、粉尘、铭文、存储条目 |
| 对账 | [`references/reconciliation.md`](skills/mixin-builder/references/reconciliation.md) | 以快照为账本、只入账一次、前向游标分页、订单支付（trace → 订单、少付/多付、退款）、监控 |
| 托管与运维 | [`references/custody-and-ops.md`](skills/mixin-builder/references/custody-and-ops.md) | 密钥存储、泄露应急预案、测试、部署、限频 |
| Mixin Computer | [`references/computer.md`](skills/mixin-builder/references/computer.md) | 注册、系统调用（invoice 模式）、费用、nonce 账户 —— 依据 Computer 仓库源码编写；官方文档没有 Computer 章节 |
| MTG 可信组 | [`references/mtg.md`](skills/mixin-builder/references/mtg.md) | observer/signer/worker、确定性规则、阈值、FROST |
| 机器人即应用 | [`references/webview.md`](skills/mixin-builder/references/webview.md) | 卡片 → webview 交接、JS 桥（iOS/Android/桌面端差异）、设计惯例 |
| 链接与编码 | [`references/schemas.md`](skills/mixin-builder/references/schemas.md) | `mixin://` 各系列（已对照三个 Messenger 客户端逐一验证）、支付 URI、MIX/MIN 地址、codes |
| 故障速查 | [`references/gotchas.md`](skills/mixin-builder/references/gotchas.md)、[`references/common-errors.md`](skills/mixin-builder/references/common-errors.md) | 21 个失败案例；每个错误码 → 原因 → 修复 |
| SDK 导航 | [`references/sdk-map.md`](skills/mixin-builder/references/sdk-map.md) | 每个主题、每种语言对应的权威源码文件 |
| 验证记录 | [`references/compatibility.md`](skills/mixin-builder/references/compatibility.md) | 已验证版本矩阵 + 重新验证步骤 |

## 内容如何保持准确

- 内容中出现的任何 SDK 符号都读自锁定版本的源码（Go `bot-api-go-client/v3` v3.25.7 · Node `@mixin.dev/mixin-node-sdk` 7.6.0 · Ruby `mixin_bot` 3.0.2 · `safe` v0.28.2 · `multi-party-sig` v0.7.0 · 文档仓库 HEAD · kernel `MixinNetwork/mixin`）。无法验证的内容内联标注 `[UNVERIFIED]`。
- `references/sdk-map.md` 为每个主题指明各语言对应的确切源码文件；Agent 被要求在产出代码前先读*已安装的* SDK，必要时回退到文档化的 REST 调用。
- `scripts/check-currency.mjs` 检查最新 SDK 版本、对照 `scripts/baseline.json` 比对导出符号面、对每个脚手架做语法检查，并通过 GitHub compare API 跟踪四个 Mixin 一方仓库（ios-app、android-app、flutter-app、mixin_bot_sdk_dart）—— 只有当提交触碰到技能引用的受监视文件时才报告漂移。退出码非零即漂移；人工复核后用 `--update` 重建基线。
- 一个定时 GitHub workflow 每周运行这些检查，刷新验证日期，发现漂移即提交 PR。
- 易变的事实（Computer 注册价格、成员数/阈值、你的注册状态）在使用时通过 `scripts/probe.mjs` 实测，不照抄文档。

完整的已验证矩阵和重新验证步骤：[`references/compatibility.md`](skills/mixin-builder/references/compatibility.md)。

## 目录结构

```
skills/mixin-builder/
├── SKILL.md            # 入口：模型、安全护栏、路由、SDK 规则、时效块
├── commands/           # 5 个可选斜杠命令提示词（audit / fit / probe / drift / error）
├── references/         # 15 个领域文件（见上表）
├── scripts/
│   ├── check-currency.mjs   # 版本 + 导出面 + 脚手架审计（漂移时退出码 ≠ 0）
│   ├── baseline.json        # 期望的符号面，经 --update 重建
│   └── probe.mjs            # 只读实时探针（computer / me / outputs / snapshots / snapshot）
├── assets/
│   ├── scaffold-bot-echo/        # echo 机器人：go/ node/ ruby/
│   ├── scaffold-oauth-web/       # 后端 secret 的 OAuth 登录，零依赖
│   └── scaffold-payment-watcher/ # Blaze + 快照对账，只入账一次
└── evals/              # 7 个发布门禁提示词 + 各领域预期行为
```

## 不覆盖的内容

Messenger 终端用户支持 · 行情/价格内容 · 复制官方 API 文档（[developers.mixin.one](https://developers.mixin.one)）· fox-one/4swap/Exin 生态（仅给指引）· 在 `SKILL.md` 内自动更新 SDK 代码片段。

## 贡献

内容规则在整个库中强制执行：每条协议论断都带来源和验证日期；没有安装在源码里的指针或可运行的脚手架，就不允许出现 SDK 符号；安全护栏只存在于两个地方（`SKILL.md` + `custody-and-ops.md`）—— 要改就两处一起改；`SKILL.md` 保持在 ~350 行以内；英文 README 为基准版本（`README.zh-CN.md` 跟随其更新）。

提交前：运行 `node skills/mixin-builder/scripts/check-currency.mjs`，并跑一遍 `evals/` 里相关的提示词。新增领域需要同时补一个参考文件、一行路由表和一条 eval。

## 许可证

[MIT](LICENSE)
