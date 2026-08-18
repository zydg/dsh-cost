# Changelog / 更新日志

## [0.0.3] - 2026-08-18

### 中文

- 输入框上方新增**实时余额条**：显示当前余额与查询时间戳（如 `⚡ 当前余额 ¥11.85 · 更新于 16:07:03`），每次余额查询成功自动更新（每轮对话结束即刷新）。
- 余额条**低余额红色告警**：余额低于设置页配置的阈值时显示为红色；阈值以 CNY 为基准存储（默认 ¥10），**切换价格单位（CNY/USD）时显示与输入自动换算**，并随汇率联动。

### English

- Added a **live balance bar above the input box**: shows current balance + query timestamp (e.g. `⚡ Current balance ¥11.85 · updated 16:07:03`), auto-updated on every successful balance query (i.e. at the end of each round).
- **Low-balance warning**: the bar turns red below a configurable threshold (stored in CNY, default ¥10); the displayed/entered value **converts automatically when the price unit (CNY/USD) changes** and follows the exchange rate.

## [0.0.2] - 2026-08-18

### 中文

- 余额刷新策略：从「应用加载时查询一次 + 每 5 分钟定时刷新」改为「**每轮对话完成、统计行输出时查询一次**」；历史回放等并发挂载合并为单次在途请求，不再有固定刷新间隔；每轮脚注显示**该轮自己**实时查询到的余额（修复滞后一轮的取快照问题）。
- 余额历史快照：每次余额查询成功后与调用记录一起持久化到**同一个文件** `<工作区>/dsh-cost/data.json`（上限 5 万条）；历史轮次的统计行显示**该轮当时的余额**（取该轮结束后第一次查询的快照，即该轮结束时实时查到的余额），无快照时回退显示当前余额。
- 数据目录稳定化：调用记录 / 余额快照 / 价格表优先写入**会话工作区** `dsh-cost/`（沙箱允许范围，绑定工作区而非宿主启动目录），`$DSH_HOME` 作兜底；散落在其他工作区 / 用户主目录 / `$DSH_HOME` 下的旧数据启动时自动并入（按 `time` 去重）。

### English

- Balance refresh policy: replaced the old "query once at app load + 5-minute timer" with **one fresh query per completed turn, whenever a footer line is emitted**; concurrent mounts (history replay) share a single in-flight request. No fixed refresh interval anymore — the balance is at most one round stale.
- Balance history snapshots: every successful balance query is persisted together with the call records into **one file** `<workspace>/dsh-cost/data.json` (bounded at 50k snapshots); historical rounds now show **the balance at that round** (the first snapshot taken after the round's end — the balance that round queried in real time), falling back to the current balance when no snapshot exists.

## [0.0.1] - 2026-08-18

### 中文

- 首个版本：在 DeepSeek Harness（dsh）每轮对话（turn）末尾自动追加一行统计——输入 / 缓存命中 / 输出 / 命中率 / 时段（高峰·空闲）/ 预估费用（官方峰谷价，按每次调用时间计价）/ 余额（`/user/balance`，与对话模型共用 `DEEPSEEK_API_KEY`）。
- 国际化设置（设置 → dsh-cost 设置）：显示语言（中文 / English）与价格单位（CNY ¥ / USD $，汇率可配置，默认 1 CNY = 0.14 USD）。
- 数据基于 `conversationEvents` 投影，流式生成并支持历史回放；仅 GitHub 直装：`dsh plugin --profile web add github:zydg/dsh-cost`。

### English

- Initial release: appends one summary line at the end of every conversation round — input / cache hit / output / hit rate / period (peak·off-peak) / estimated cost (official 峰谷 pricing, each call priced by its own timestamp) / balance (`/user/balance`, reusing the chat model's `DEEPSEEK_API_KEY`).
- Internationalization settings (Settings → dsh-cost settings): display language (中文 / English) and price unit (CNY ¥ / USD $, configurable rate, default 1 CNY = 0.14 USD).
- Data is built on a `conversationEvents` projection (streaming + historical replay); GitHub-only install: `dsh plugin --profile web add github:zydg/dsh-cost`.
