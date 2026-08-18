# dsh-cost

> 🌏 [English](README.en.md) · 中文（默认）

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在**每轮对话（turn）的末尾自动追加一行统计**——本轮 token 消耗（输入/缓存命中/输出/推理）、**缓存命中率**、按**官方峰谷分时价格**并结合**本轮每一次调用的时间**估算的费用，行尾附 **DeepSeek API 余额**。

## 功能

- **每轮末尾一行字**：每轮助手回复结束后自动出现，例如：

  `⚡ 本轮 #4 · 输入 188,843 · 缓存命中 6,494,464 · 输出 24,057 · 命中率 97.2% · 时段 高峰 · 预估 ¥1.4325 · 余额 ¥12.34`

  切换为英文后：

  `⚡ Round #4 · Input 188,843 · Cache hit 6,494,464 · Output 24,057 · Hit rate 97.2% · Period Peak · Est. $0.20 · Balance $1.73`

- **缓存命中率**：`缓存命中 tokens /（命中 + 未命中输入）`，由会话事件流实时计算。
- **官方峰谷计价**：DeepSeek-V4 系列自 2026-08-17 00:00（北京时间）起实行峰谷分时计价；高峰时段为每日 **09:00–12:00 与 14:00–18:00（北京时间）**，高峰价格为空闲时段的两倍。默认价格表（元/百万 tokens）：

  | 模型 | 时段 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
  |---|---|---|---|---|
  | deepseek-v4-flash | 高峰 | 0.10 | 3.0 | 9.0 |
  | deepseek-v4-flash | 空闲 | 0.05 | 1.5 | 4.5 |
  | deepseek-v4-pro | 高峰 | 0.30 | 9.0 | 27.0 |
  | deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |

  费用按**每次调用自身的时间**判峰/谷逐次计价（而非按轮取平均）。价格可通过 `<工作区>/dsh-cost/pricing.json`（或 `setPrices` API）调整。费用为**估算值**，实际以 DeepSeek 官方账单为准。
- **行尾余额**：使用 `DEEPSEEK_API_KEY` 请求 `GET https://api.deepseek.com/user/balance`（应用加载时查询一次，每 5 分钟刷新），在每行末尾追加 `余额 ¥…`；未配置 Key 时自动省略余额。每次查询成功都会把余额快照写入 `$DSH_HOME/dsh-cost/balance-history.json`，历史轮次显示**该轮当时的余额**（取该轮结束前最近一次快照）；暂无快照的轮次回退显示当前余额。
- **历史消息也生效**：统计行是 `conversationEvents` 投影（与官方 turn-tail / deliverables 同一机制），打开历史会话时会自动回放生成。
- **持久化（宿主侧）**：数据优先写入**会话工作区**的 `dsh-cost/` 目录（沙箱允许范围，绑定工作区而非宿主启动目录）：调用记录 `usage-records.json`（上限 20 万条）、余额快照 `balance-history.json`（上限 5 万条）、价格表 `pricing.json`。候选顺序：工作区根 → 会话 cwd → 探测路径 → `$DSH_HOME`（兜底）。散落在其他工作区 / 用户主目录 / `$DSH_HOME` 下的旧数据会在启动时自动并入（按 `time` 去重）。

## 单文件安装到其他终端

把发布产物 `dsh-cost-0.0.1.tgz`（`npm pack` 生成）拷到目标机器，在任意目录执行：

```sh
dsh plugin --profile web add ./dsh-cost-0.0.1.tgz
```

`dsh plugin` 会自动把该依赖安装进 profile 的 node_modules，并把 `dsh-cost` 追加到 `dsh.profile.bundles`（本包声明了 `dsh.bundle.patch`）。随后重启 `dsh web` 并刷新页面即可。

手动方式（不走 `dsh plugin` 时）：

```sh
cd ~/.dsh/profiles/web
pnpm add file:./dsh-cost-0.0.1.tgz
# 然后在 package.json 的 dsh.profile.bundles 里追加 "dsh-cost
```

## 国际化设置（设置页）

设置 → **dsh-cost 设置** 里可以切换：

- **显示语言**：中文 / English（统计行、设置项实时切换）
- **价格单位**：CNY ¥ / USD $（USD 按可配置汇率换算展示，默认 1 CNY = 0.14 USD，仅估算参考）

设置保存在本机浏览器（localStorage），无需改动宿主与价格表。

## 环境要求

- DeepSeek Harness Web/桌面 profile（Node.js ≥ 18）。
- 余额显示需要在 Harness「设置 → 模型」中配置 DeepSeek API Key（`DEEPSEEK_API_KEY`）。

## 安装

本包声明了 `dsh.bundle`，一条命令即可从 GitHub 直装：

```sh
dsh plugin --profile web add github:zydg/dsh-cost
```

或手动安装到 profile 并接线：

```sh
cd ~/.dsh/profiles/web
pnpm add github:zydg/dsh-cost
# 然后在 package.json 的 dsh.profile.bundles 中追加 "dsh-cost
```

重启 Web 应用并刷新页面即可——没有标签页、没有面板，每轮对话末尾自动出现统计行。

> 共存提示：如果其他用量插件占用了 `/dsh-cost/api` 路由或 `cost-summary` 聊天节点键，请先移除。

## 工作原理

### 宿主侧（`lib/index.js`）

1. 订阅 `llm/stream` waterfall，记录每次模型调用（时间、模型、服务商、用途、各 token 数、结束原因），并通过 `session/event` + `sessionId` 归属到 (session, turn, step)。
2. 提供 `POST /dsh-cost/api`：

| action | body | 返回 |
|---|---|---|
| `list` | `{ sessionId?, turn? }` | 记录/每轮汇总/总计/价格表（客户端据此取价格表） |
| `balance` | — | DeepSeek 账户余额（`/user/balance`） |
| `setPrices` / `resetPrices` | `{ prices }` / — | 更新/恢复官方价格表（持久化） |
| `clear` | — | 清空全部记录 |
| `export` | `{ kind: 'csv' | 'json' }` | 导出到 `<工作区>/dsh-cost/` |

### 客户端（`lib/client.js`）

1. 通过 `ctx.conversationEvents.register(...)` 注册 `cost-summary` 聊天节点。
2. 投影从 `assistant/chunk`（usage）与 `assistant/message`（model）事件按步累计 token，轮结束时发布节点——流式生成、历史回放都可用。
3. 渲染器汇总本轮数据、计算缓存命中率、按每次调用时间判峰/谷计价，并从宿主 API 拉取价格表与余额，渲染成一行统计。

## 声明

- 本插件**使用 dsh（DeepSeek Harness）开发**，集成其 `llm/stream` 会话事件、`session/event` 轮次跟踪与 `credentials` 凭据服务；**未验证其他模型/服务商的可用性**，仅针对 DeepSeek 官方模型与价格体系设计。
- **作者代码水平不高**，代码可能存在缺陷或考虑不周之处，欢迎提交 Issue / PR 指正。
- 费用估算依据 **DeepSeek 官方峰谷分时价格表**（费用查询口径），并按每次调用的实际时间逐次计价；估算结果**仅供参考**，实际费用以 DeepSeek 官方账单为准。
- 余额查询调用 DeepSeek 官方接口 `GET https://api.deepseek.com/user/balance`，API Key 与对话模型**共用同一个 Key**（`DEEPSEEK_API_KEY`）。
- 余额接口可能因服务端延迟导致展示滞后，**余额数据仅供参考**，不构成账户可用额度的承诺。

### 一键安装

```sh
dsh plugin --profile web add github:zydg/dsh-cost
```

## 数据与隐私

- 记录仅包含 token/用量元数据（不含消息内容、不含 API Key）。
- API Key 仅通过 Harness `credentials` 服务读取，且只用于 `/user/balance` 请求。
- 用量数据存放在工作区旁的 `dsh-cost/` 目录；删除 `usage-records.json` 即重置。

## License

MIT
