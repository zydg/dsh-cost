# Changelog / 更新日志

## [0.0.1] - 2026-08-18

### 中文

- 首个版本：在 DeepSeek Harness（dsh）每轮对话（turn）末尾自动追加一行统计——输入 / 缓存命中 / 输出 / 命中率 / 时段（高峰·空闲）/ 预估费用（官方峰谷价，按每次调用时间计价）/ 余额（`/user/balance`，与对话模型共用 `DEEPSEEK_API_KEY`）。
- 国际化设置（设置 → dsh-cost 设置）：显示语言（中文 / English）与价格单位（CNY ¥ / USD $，汇率可配置，默认 1 CNY = 0.14 USD）。
- 数据基于 `conversationEvents` 投影，流式生成并支持历史回放；仅 GitHub 直装：`dsh plugin --profile web add github:zydg/dsh-cost`。

### English

- Initial release: appends one summary line at the end of every conversation round — input / cache hit / output / hit rate / period (peak·off-peak) / estimated cost (official 峰谷 pricing, each call priced by its own timestamp) / balance (`/user/balance`, reusing the chat model's `DEEPSEEK_API_KEY`).
- Internationalization settings (Settings → dsh-cost settings): display language (中文 / English) and price unit (CNY ¥ / USD $, configurable rate, default 1 CNY = 0.14 USD).
- Data is built on a `conversationEvents` projection (streaming + historical replay); GitHub-only install: `dsh plugin --profile web add github:zydg/dsh-cost`.
