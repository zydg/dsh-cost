# Changelog / 更新日志

## [0.0.7] - 2026-09-11

### 中文

- **设置页新增「模型与价格」编辑器**：可在 设置 → dsh-cost 设置 里手动管理价格表——添加/删除模型、编辑模型名与显示名，分别设置**高峰**与**空闲**的「缓存命中 / 缓存未命中 / 输出」三档单价（元/百万 tokens），并提供「周六/周日全天按低谷价」开关。保存后按每次调用时间逐次计价，已打开的统计行立即用新价重算。
- **高峰时段可手动编辑**：可添加/删除高峰时段并编辑每段的开始与结束时间（`HH:MM`，北京时间）；保存时校验 `0 ≤ 开始 < 结束 ≤ 1440` 并自动排序；**全部删除表示全天低谷**。`isPeak()` 语义修正为：显式传入数组（含空数组 `[]`）即以此为准，仅未传时才回退默认时段。
- **新增 `setPrices` 整表模式**：`setPrices` 支持 `replaceModels: true`，一次提交完整模型表（支持新增/删除/改显示名/改价）；旧的局部更新语义保留（更新已有模型、按需新增未知键）。新增 `normalizeModelTable()` / `normalizeModelRates()` / `normalizePeakWindows()` 做校验与归一。`applyPricing` 支持整表恢复，重启后自定义模型与高峰时段不丢失。
- **兼容性修复**：客户端会话事件注册表改用当前 DSH 的 `ctx.uiConversation.events.register(...)`（原 `ctx.conversationEvents` 已不存在，会导致客户端半边被 `inject` 门控而整体不加载）。
- **测试**：新增 `test/pricing.mjs`（14 项：`replaceModels` 整表替换/删除、空表拒绝、非法价格归零、旧接口兼容、`isPeak` 默认/空数组/自定义窗口、非法时段拒绝、跨重启恢复模型表与高峰时段、`resetPrices`），`npm test` 一并运行。

### English

- **New "Models & prices" editor in the settings page**: from Settings → dsh-cost settings you can manage the price table by hand — add/remove models, edit the model id and label, and set the peak and off-peak **cache-hit / cache-miss / output** rates (CNY per 1M tokens), plus a "Saturday/Sunday all off-peak" toggle. Saving prices each call by its own timestamp, and open footer lines re-render with the new prices immediately.
- **Peak windows are editable**: add/remove peak windows and edit each window's start and end time (`HH:MM`, Beijing time). The host validates `0 ≤ start < end ≤ 1440` and sorts them; **removing every window means all-day off-peak**. `isPeak()` semantics were fixed: an explicit array (including `[]`) now wins, and only an absent value falls back to the default windows.
- **New whole-table `setPrices` mode**: `setPrices` accepts `replaceModels: true` to submit the complete model table in one call (add / remove / relabel / reprice). The legacy partial-update semantics are preserved. New validators `normalizeModelTable()` / `normalizeModelRates()` / `normalizePeakWindows()`; `applyPricing` restores the whole table so custom models and peak windows survive a restart.
- **Compatibility fix**: the client now registers conversation events through the current DSH service `ctx.uiConversation.events.register(...)` (the old `ctx.conversationEvents` no longer exists, which left the whole client half gated by `inject` and never loaded).
- **Tests**: new `test/pricing.mjs` (14 checks: `replaceModels` add/remove, empty-table rejection, invalid rates clamped to 0, legacy-update compatibility, `isPeak` default/empty/custom windows, invalid-window rejection, restore of models and peak windows across a restart, `resetPrices`), run by `npm test`.

## [0.0.6] - 2026-09-11

### 中文

- **模型名自动同步**：新增官方模型清单同步（`GET https://api.deepseek.com/models`）。插件启动后自动同步一次；24 小时 TTL 内复用缓存；统计到**清单外的模型名**（官方上新）时再自动同步一次，最小间隔 10 分钟以免频繁请求；也可在设置页点「立即同步」（`syncModels`）。同步失败只记录原因，不影响计价与其余功能。新增导出 `parseModels()` / `catalogStale()` / `mergeCatalogIds()` 与常量 `MODEL_CATALOG_TTL_MS` / `MODEL_CATALOG_MIN_GAP_MS`。
- **旧模型名归一（`MODEL_ALIASES`）**：`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-chat` → `deepseek-flash` 计价桶；`deepseek-reasoner` → `deepseek-v4-pro` 计价桶。`modelKey` 现在先去空格、转小写，精确别名优先、关键字兜底，因此 `deepseek-flash-2` / `deepseek-v4-pro-2` 这类未来名字仍能正确归桶。宿主与客户端各有一份别名表，由自检脚本断言两者完全一致。
- **「价格未收录」提示**：`list` 返回的每条记录新增 `modelPriced` / `modelListed` 字段；价格表里找不到的模型名，统计行会追加 `⚠ 价格未收录（按 ¥0 估算）`，避免把「没有价格」误当成「免费」。
- **设置页新增「官方模型清单（自动同步）」**：显示上次同步时间、已同步的模型名列表和「立即同步」按钮；未配置 Key 或同步失败时显示原因。
- **持久化**：`data.json` 增加 `modelCatalog: { ids, fetchedAt }`（旧文件无需迁移，缺该字段按未同步处理）。
- **接口白名单**：新增 `API_PATHS`（`/user/balance`、`/models`），只允许访问这两个官方接口；余额与模型清单复用同一个 `DEEPSEEK_API_KEY`。
- **测试**：新增 `test/selftest.mjs`（21 项断言：峰谷计价、周末低谷、V4 Pro 路由、旧名归一、清单解析/TTL/合并、宿主与客户端别名表及价格表一致性）与 `test/smoke.mjs`（6 项：`apply` 挂载、路由注册、`list`/`syncModels`/`balance`/未知 action 的返回形状与降级、`llm/stream` 监听），`npm test` 一键运行。

### English

- **Automatic model-name sync**: the plugin now syncs the official model list (`GET https://api.deepseek.com/models`) — once at startup, cached for 24 hours, and again whenever a call shows a **model name outside the list** (a fresh release; minimum gap 10 minutes so it never hammers the API). A **Sync now** button in the settings page (action `syncModels`) forces a refresh. Failures only record a reason and never affect costing. New exports `parseModels()` / `catalogStale()` / `mergeCatalogIds()` and constants `MODEL_CATALOG_TTL_MS` / `MODEL_CATALOG_MIN_GAP_MS`.
- **Retired-name normalisation (`MODEL_ALIASES`)**: `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` and `deepseek-chat` → the `deepseek-flash` bucket; `deepseek-reasoner` → `deepseek-v4-pro`. `modelKey` now trims and lowercases, prefers exact aliases and falls back to keywords, so future ids such as `deepseek-flash-2` / `deepseek-v4-pro-2` still land in the right bucket. Host and client each carry a copy of the alias table and the self-test asserts they are identical.
- **"Price not in table" marker**: every record returned by `list` gains `modelPriced` / `modelListed`; when a model has no price the footer line appends `⚠ Price not in table (counted as 0)` instead of silently looking free.
- **New settings row "Official model list (auto-sync)"**: last sync time, the synced model names and a **Sync now** button; a missing key or a failed sync shows the reason.
- **Persistence**: `data.json` gains `modelCatalog: { ids, fetchedAt }` (no migration needed — a missing field simply means "not synced yet").
- **Endpoint allow-list**: new `API_PATHS` (`/user/balance`, `/models`) restricts outbound calls to those two official endpoints; balance and model list share the same `DEEPSEEK_API_KEY`.
- **Tests**: new `test/selftest.mjs` (21 assertions: peak/off-peak pricing, weekend off-peak, V4 Pro routing, retired-name mapping, catalogue parsing/TTL/merge, host↔client alias and price-table parity) and `test/smoke.mjs` (6 checks: `apply` mounting, route registration, response shapes and graceful degradation for `list`/`syncModels`/`balance`/unknown actions, `llm/stream` listener). Run both with `npm test`.

## [0.0.5] - 2026-09-10

### 中文

- **新模型 DeepSeek-V4.1-Flash**：默认价格表新增 `deepseek-flash` 计费桶（原 `deepseek-v4-flash` 桶移除）；`modelKey` 仍按 `flash` 关键字匹配，因此新模型名 `deepseek-flash` 及旧名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`（均已下线，请求由 V4.1 Flash 提供服务）统一按 Flash 价格计费。
- **Flash 系列降价**：北京时间 2026-09-10 12:00 起，空闲时段 输入·缓存命中 **¥0.02** / 输入·缓存未命中 **¥1** / 输出 **¥4**（元/百万 tokens），高峰时段为空闲时段的两倍（¥0.04 / ¥2 / ¥8）；默认价格表生效日期 `effectiveAt` 更新为 `2026-09-10T12:00:00+08:00`。
- **V4 Pro 有序下线路由**：价格表新增 `proRoute` 字段（默认 `{at: '2026-09-14T12:00:00+08:00', to: 'deepseek-flash'}`）。自北京时间 2026-09-14 12:00 起至 V4.1 Pro 上线前，`deepseek-v4-pro` 的请求全部路由到 V4.1 Flash，费用按 **V4.1 Flash 单价**估算；新增导出函数 `billedModelKey()`，宿主与客户端计价逻辑保持一致，`setPrices` 亦可覆盖 `proRoute`。
- 峰谷规则确认不变：高峰时段为北京时间**周一至周五** 09:00–12:00、14:00–18:00，其余时间（含周六/周日全天）为空闲时段。
- 兼容性提示：若 `data.json` 中存在旧 key `deepseek-v4-flash` 的自定义价格覆盖，升级后将不再被读取（该桶已更名为 `deepseek-flash`），如需保留自定义价请用 `setPrices` 重新设置，或用 `resetPrices` 恢复官方默认价。

### English

- **New model DeepSeek-V4.1-Flash**: the default price table now has a `deepseek-flash` bucket (the old `deepseek-v4-flash` bucket is gone). `modelKey` still matches on the `flash` keyword, so the new name `deepseek-flash` and the legacy names `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` (both retired, now served by V4.1 Flash) are all billed at the Flash price.
- **Flash price cut**: effective 12:00 Beijing time on 2026-09-10, off-peak rates are **¥0.02** input cache hit / **¥1** input cache miss / **¥4** output (元 per 1M tokens), with peak rates at double (¥0.04 / ¥2 / ¥8); the default `effectiveAt` is now `2026-09-10T12:00:00+08:00`.
- **Orderly V4 Pro retirement routing**: the price table gains a `proRoute` field (default `{at: '2026-09-14T12:00:00+08:00', to: 'deepseek-flash'}`). From 12:00 Beijing time on 2026-09-14 until V4.1 Pro ships, `deepseek-v4-pro` requests are routed to V4.1 Flash and estimated at the **V4.1 Flash price**; the new exported `billedModelKey()` keeps host and client costing in sync, and `setPrices` can override `proRoute`.
- Peak rules are unchanged: peak means **Monday–Friday** 09:00–12:00 and 14:00–18:00 Beijing time; every other hour (including all weekend) is off-peak.
- Compatibility note: a custom price override stored under the old `deepseek-v4-flash` key in `data.json` is no longer read after this upgrade (the bucket was renamed to `deepseek-flash`); re-apply it with `setPrices`, or use `resetPrices` to restore the official defaults.

## [0.0.4] - 2026-08-23

### 中文

- **周末低谷价**：自 2026-08-23 00:00（北京时间）起，周六/周日全天统一按低谷（空闲）时段价格计费；价格表新增 `weekendOffPeak` 开关（默认开启），可通过 `<工作区>/dsh-cost/data.json` 的 `pricing.weekendOffPeak` 或 `setPrices` API 关闭。`isPeak` 现在结合调用时间与星期判断高峰/低谷，费用估算随周末价自动生效。
- 默认价格表生效日期 `effectiveAt` 同步更新为 `2026-08-23T00:00:00+08:00`。

### English

- **Weekend off-peak pricing**: effective 2026-08-23 00:00 (Beijing time), Saturdays/Sundays are billed at the off-peak rate all day; the price table gains a `weekendOffPeak` flag (on by default — disable via `pricing.weekendOffPeak` in `<workspace>/dsh-cost/data.json` or the `setPrices` API). `isPeak` now also considers the weekday, so estimates follow the weekend rate automatically.
- The default pricing `effectiveAt` is updated to `2026-08-23T00:00:00+08:00`.

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
