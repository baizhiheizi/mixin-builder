# mixin-builder

[English](README.md) | **简体中文**

一个深度 Agent 技能，用于在 Mixin 网络上构建应用 —— Messenger 机器人、带 Mixin 登录的 Web 应用、Safe/UTXO 支付与托管、Mixin Computer（Solana）调用，以及 MTG 可信组程序。

协议事实优先于 SDK 转述，踩坑实录优先于 API 罗列。每一个有副作用的流程，最后都会告诉你**如何验证它确实生效了**。

两种用法：[跟你的 Agent 聊着管理一个机器人钱包](#不写代码管理机器人钱包)，全程零代码；或者[基于脚手架和参考文档开发](#快速开始)。

## 安装

```bash
# 从 GitHub 安装（skills CLI）
npx skills add baizhiheizi/mixin-builder

# 或手动：把技能目录复制进你的 Agent 的技能目录
cp -r skills/mixin-builder ~/.agents/skills/   # 也可以是 .claude/skills/、.codex/skills/ 等

# 或直接克隆仓库（下方快速开始以此为准）
git clone https://github.com/baizhiheizi/mixin-builder.git
```

无需构建。各部分的环境要求：

| 部分 | 要求 |
|---|---|
| `scripts/` —— 探针、时效性审计 | Node ≥ 20，零 npm 依赖 |
| Echo 机器人脚手架 | Node ≥ 20 · 或 Go ≥ 1.27（`go run .`）· 或 Ruby ≥ 4.0 |
| 支付监听脚手架 | **Node ≥ 22**（用到 `node:sqlite`） |
| OAuth Web 脚手架 | Node ≥ 20，零依赖 |

## 快速开始

先准备一个文件：机器人的 `keystore.json`。在[开发者面板](https://developers.mixin.one)创建应用 → 你的应用 → **Secret** → 生成 keystore。务必保密 —— 谁持有其中的 `spend_private_key`，谁就持有这笔钱。

挑一个脚手架，跑起来：

```bash
SKILL=skills/mixin-builder   # 仓库克隆；若通过 skills CLI 安装：SKILL=~/.agents/skills/mixin-builder

# echo 机器人 —— Blaze 消息、ACK 语义、重连退避（Node / Go / Ruby）
cd $SKILL/assets/scaffold-bot-echo/node
npm install && KEYSTORE=/path/to/keystore.json node index.mjs
# Go:    cd ../go    && KEYSTORE=… go run .
# Ruby:  cd ../ruby  && bundle install && KEYSTORE=… ruby echo.rb   # 需要 Ruby ≥ 4.0

# 支付监听 —— Blaze 触发 + /safe/snapshots 对账，只入账一次的账本
cd ../../scaffold-payment-watcher
npm install && KEYSTORE=/path/to/keystore.json node watcher.mjs
#   默认 dry-run（只打印将入账的内容）；确认无误后再加 --no-dry-run

# OAuth Web 登录 —— 跳转授权 + code 换 token + 读取资料（零依赖）
cd ../scaffold-oauth-web
MIXIN_APP_ID=… MIXIN_CLIENT_SECRET=… PORT=3000 node server.mjs
```

验证 echo 机器人：在 Messenger 里给你的机器人发 `/ping` → 你会收到恰好一条 `echo: /ping`。杀掉进程、再发一条消息、重启 → 仍然恰好一条回复（确定性 `message_id` 对重投消息去重）。

用实测代替轻信文档 —— 所有探针均为只读（只发 GET；绝不读取支付私钥）：

```bash
node $SKILL/scripts/probe.mjs computer                                # Mixin Computer 信息（无需鉴权）
node $SKILL/scripts/probe.mjs me --keystore ks.json                   # 鉴权 + Safe 注册状态
node $SKILL/scripts/probe.mjs outputs --keystore ks.json              # 精确余额，全分页
node $SKILL/scripts/probe.mjs snapshots --keystore ks.json            # 近期账本 + 分页语义检查
node $SKILL/scripts/probe.mjs snapshot <snapshot_id> --keystore ks.json
```

注意：Node SDK 自带的 `BlazeKeystoreClient`（7.6.0）连不上 —— 它不发送 `User-Agent`，握手收到 `10006` 后静默挂死。脚手架内置了可用的替代实现（`blaze-client.mjs`）；任何手写 HTTP 客户端也必须带 `User-Agent: name/version` 请求头。

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
| 故障速查 | [`references/gotchas.md`](skills/mixin-builder/references/gotchas.md)、[`references/common-errors.md`](skills/mixin-builder/references/common-errors.md) | 21 篇踩坑实录；每个错误码 → 原因 → 修复 |
| SDK 导航 | [`references/sdk-map.md`](skills/mixin-builder/references/sdk-map.md) | 每个主题、每种语言对应的权威源码文件 |
| 事实锚点 | [`references/compatibility.md`](skills/mixin-builder/references/compatibility.md) | 已验证版本矩阵 + 重新验证步骤 |

## 它如何保持可信

历史上的 Mixin 技能大多死于凭空编造 SDK 符号。这个技能从构造上杜绝了这种情况：

- **从构造上防幻觉** —— 任何 SDK 符号只有读过锁定版本的源码才会出现在内容里（Go `bot-api-go-client/v3` v3.25.7 · Node `@mixin.dev/mixin-node-sdk` 7.6.0 · Ruby `mixin_bot` 3.0.2 · `safe` v0.28.2 · `multi-party-sig` v0.7.0 · 文档仓库 HEAD · kernel `MixinNetwork/mixin）。无法验证的内容一律内联标注 `[UNVERIFIED]`。
- **解析而非回忆** —— `references/sdk-map.md` 为每个主题指明确切的源码文件；Agent 被要求在产出代码前先读*已安装的* SDK，实在不行回退到文档化的 REST 调用。
- **自动漂移告警** —— `scripts/check-currency.mjs` 检查最新 SDK 版本、对照 `scripts/baseline.json` 比对导出符号面、对每个脚手架做语法检查，并通过 GitHub compare API 跟踪四个 Mixin 一方仓库（ios-app、android-app、flutter-app、mixin_bot_sdk_dart）—— 只有当提交触碰到技能引用的受监视文件时才算漂移。退出码非零 = 漂移；人工复核后用 `--update` 重建基线。
- **每周由 Agent 复审仓库** —— 一个定时 GitHub workflow 会运行上述检查、刷新验证日期，一旦发现漂移就自动开 PR。事实锚点是持续维护出来的，不是一句口号。
- **实时探针优先于过期数字** —— 易变的事实（Computer 注册价格、成员数/阈值、你的注册状态）在使用时通过 `scripts/probe.mjs` 实测，绝不照抄文档。

完整的已验证矩阵和重新验证步骤：[`references/compatibility.md`](skills/mixin-builder/references/compatibility.md)。

## 目录结构

```
skills/mixin-builder/
├── SKILL.md            # 入口：模型、安全护栏、路由、SDK 规则、时效块
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

Messenger 终端用户支持 · 行情/价格内容 · 复制官方 API 文档（它已经很好 —— [developers.mixin.one](https://developers.mixin.one)）· fox-one/4swap/Exin 生态（仅给指引）· 在 `SKILL.md` 内自动更新 SDK 代码片段。

## 贡献

内容规则在整个库中强制执行：每条协议论断都带来源和验证日期；没有安装在源码里的指针或可运行的脚手架，就不允许出现 SDK 符号；安全护栏只存在于两个地方（`SKILL.md` + `custody-and-ops.md`）—— 要改就两处一起改；`SKILL.md` 保持在 ~350 行以内；英文 README 为基准版本（`README.zh-CN.md` 跟随其更新）。

提交前：运行 `node skills/mixin-builder/scripts/check-currency.mjs`，并跑一遍 `evals/` 里相关的提示词。新增领域需要同时补一个参考文件、一行路由表和一条 eval。

## 许可证

[MIT](LICENSE)
