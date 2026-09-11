# dsh-cost

> 🌏 [English](README.en.md) · 中文（默认）

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在**每轮对话（turn）的末尾自动追加一行统计**——本轮 token 消耗（输入/缓存命中/输出/推理）、**缓存命中率**、按**官方峰谷分时价格**并结合**本轮每一次调用的时间**估算的费用，行尾附 **DeepSeek API 余额**。

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

**💡 也可以直接告诉 AI**：在 DeepSeek Harness 的对话中直接说下面这句话，AI 会自动执行安装并重启：

```sh
帮我安装一下这个dsh plugin --profile web add github:zydg/dsh-cost并重启
```

安装、重启由 AI 自动完成；**刷新页面需要你手动操作**，刷新后即完成安装。

> 共存提示：如果其他用量插件占用了 `/dsh-cost/api` 路由或 `cost-summary` 聊天节点键，请先移除。

## 功能

- **每轮末尾一行字**：每轮助手回复结束后自动出现，例如：

  `⚡ 本轮 #4 · 输入 188,843 · 缓存命中 6,494,464 · 输出 24,057 · 命中率 97.2% · 时段 高峰 · 预估 ¥1.4325 · 余额 ¥12.34`

  切换为英文后：

  `⚡ Round #4 · Input 188,843 · Cache hit 6,494,464 · Output 24,057 · Hit rate 97.2% · Period Peak · Est. $0.20 · Balance $1.73`

- **缓存命中率**：`缓存命中 tokens /（命中 + 未命中输入）`，由会话事件流实时计算。
- **官方峰谷计价**：DeepSeek **V4.1 Flash**（模型名 `deepseek-flash`）于 2026-09-10 发布，API 价格同步下调，**北京时间 2026-09-10 12:00 起生效**；高峰时段为**周一至周五 09:00–12:00 与 14:00–18:00（北京时间）**，高峰价格为空闲时段的两倍，**其余时间（含周六/周日全天）均按低谷（空闲）时段价格计费**。默认价格表（元/百万 tokens）：

  | 模型 | 时段 | 输入·缓存命中 | 输入·缓存未命中 | 输出 |
  |---|---|---|---|---|
  | deepseek-flash（V4.1 Flash） | 高峰 | 0.04 | 2 | 8 |
  | deepseek-flash（V4.1 Flash） | 空闲 | 0.02 | 1 | 4 |
  | deepseek-v4-pro | 高峰 | 0.30 | 9.0 | 27.0 |
  | deepseek-v4-pro | 空闲 | 0.15 | 4.5 | 13.5 |

  费用按**每次调用自身的时间**判峰/谷逐次计价（而非按轮取平均）；**同一轮高峰/空闲调用并存时，时段显示「高峰+空闲」**，并按各自单价分别计价汇总；**周末调用统一按低谷价计费**（价格表 `weekendOffPeak` 开关，默认开启；周六/周日全天为低谷价）。**模型名兼容**：旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 已下线，请求由 V4.1 Flash 提供服务并按 Flash 价格计费；**V4 Pro 有序下线**：北京时间 2026-09-14 12:00 起至 V4.1 Pro 上线前，`deepseek-v4-pro` 的请求全部路由到 V4.1 Flash，**按 Flash 单价计费**（价格表 `proRoute`，默认 `{at: '2026-09-14T12:00:00+08:00', to: 'deepseek-flash'}`）。价格可通过 `<工作区>/dsh-cost/data.json` 里的 `pricing` 字段（或 `setPrices` API）调整，`resetPrices` 可随时恢复官方默认价。费用为**估算值**，实际以 DeepSeek 官方账单为准。
- **模型名自动同步（0.0.6 新增）**：插件通过官方 `GET https://api.deepseek.com/models` 自动同步**官方模型名清单**——**插件启动时同步一次**，之后 24 小时内复用缓存；一旦统计到**清单里没有的模型名**（官方上新模型）会再自动同步一次（最小间隔 10 分钟，避免频繁请求）。已下线旧名在本地归一：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-chat` → V4.1 Flash 计价桶，`deepseek-reasoner` → V4 Pro 计价桶，未来形如 `deepseek-flash-2` 的名字按关键字兜底。**该接口只提供模型名、不提供价格**，所以价格仍以本地价格表为准（`data.json` 的 `pricing` / `setPrices`）；价格表里没有的模型名，统计行会追加 `⚠ 价格未收录（按 ¥0 估算）`，避免把「没价格」误当成「免费」。设置页新增「官方模型清单（自动同步）」一栏：显示上次同步时间与模型名列表，并可点「立即同步」。清单缓存写入 `data.json` 的 `modelCatalog` 字段。
- **行尾余额**：使用 `DEEPSEEK_API_KEY` 请求 `GET https://api.deepseek.com/user/balance`（**每轮对话完成、统计行输出时查询一次**，无固定刷新间隔；并发挂载如回放历史时合并为单次请求），在每行末尾追加 `余额 ¥…`；未配置 Key 时自动省略余额。每次查询成功都会把余额快照写入 `<工作区>/dsh-cost/data.json`（与调用记录同一个文件），历史轮次显示**该轮当时的余额**（取该轮结束后第一次查询的快照，即该轮结束时实时查到的余额）；暂无快照的轮次回退显示当前余额。
- **输入框上方实时余额条**：显示**当前余额 + 查询时间戳**（如 `⚡ 当前余额 ¥11.85 · 更新于 16:07:03`），每次余额查询成功自动更新（每轮对话结束即刷新）；**余额低于可配置阈值时显示为红色**，阈值在设置页调整（以 CNY 为基准存储，切换价格单位时自动换算，默认 ¥10）。
- **历史消息也生效**：统计行是 `conversationEvents` 投影（与官方 turn-tail / deliverables 同一机制），打开历史会话时会自动回放生成。
- **持久化（宿主侧）**：数据优先写入**会话工作区**的 `dsh-cost/` 目录（沙箱允许范围，绑定工作区而非宿主启动目录）：**调用记录、余额快照、价格覆盖全部存进同一个文件 `data.json`**（结构 `{version, records, balanceHistory, pricing, modelCatalog}`；调用记录上限 20 万条、余额快照上限 5 万条）。候选顺序：工作区根 → 会话 cwd → 探测路径 → `$DSH_HOME`（兜底）。散落在其他工作区 / 用户主目录 / `$DSH_HOME` 下的旧格式数据（`usage-records.json` / `balance-history.json` / `pricing.json`）会在启动时自动并入新文件（按 `time` 去重）。
- **导出调用记录**：通过 `/dsh-cost/api` 的 `export` 操作，将全部调用记录导出为 **CSV / JSON** 文件到 `<工作区>/dsh-cost/`（文件名如 `dsh-cost-20260820-091530.csv`），便于离线分析。
- **一键清空记录**：`clear` 操作清空全部调用记录（余额快照与价格覆盖保留）。

## 国际化设置（设置页）

设置 → **dsh-cost 设置** 里可以切换：

- **显示语言**：中文 / English（统计行、设置项实时切换）
- **价格单位**：CNY ¥ / USD $（USD 按可配置汇率换算展示，默认 1 CNY = 0.14 USD，仅估算参考）
- **余额告警阈值**：低于该值时输入框上方的当前余额显示为红色（默认 ¥10，以 CNY 为基准存储；切换价格单位时阈值显示与输入自动换算为对应单位）
- **官方模型清单（自动同步）**：显示上次同步时间、已同步的模型名列表，以及「立即同步」按钮；未配置 `DEEPSEEK_API_KEY` 或同步失败时显示原因（不影响计价，价格仍来自本地价格表）

设置保存在本机浏览器（localStorage），无需改动宿主与价格表。

## 环境要求

- DeepSeek Harness Web/桌面 profile（Node.js ≥ 18）。
- 余额显示需要在 Harness「设置 → 模型」中配置 DeepSeek API Key（`DEEPSEEK_API_KEY`）。

## 工作原理

### 宿主侧（`lib/index.js`）

1. 订阅 `llm/stream` waterfall，记录每次模型调用（时间、模型、服务商、用途、各 token 数、结束原因），并通过 `session/event` + `sessionId` 归属到 (session, turn, step)。
2. 提供 `POST /dsh-cost/api`：

| action | body | 返回 |
|---|---|---|
| `list` | `{ sessionId?, turn? }` | 记录/每轮汇总/总计/价格表 + 模型清单缓存（客户端据此取价格表与清单） |
| `balance` | — | DeepSeek 账户余额（`/user/balance`） |
| `syncModels` | — | 立即同步官方模型名清单（`GET /models`，忽略 TTL；失败返回 `ok:false` 与原因，不影响计价） |
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

## 数据与隐私

- 记录仅包含 token/用量元数据（不含消息内容、不含 API Key）。
- API Key 仅通过 Harness `credentials` 服务读取，且只用于 `/user/balance` 请求。
- 用量数据存放在工作区旁的 `dsh-cost/` 目录；删除 `data.json` 即重置。

## License

MIT
