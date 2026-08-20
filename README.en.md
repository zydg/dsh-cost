# dsh-cost

> 🌏 [中文](README.md) · English (default is Chinese)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that appends **one summary line at the end of every conversation round (turn)**: token consumption (input / cache-hit / output / reasoning), **cache hit rate**, **estimated cost from the official peak/off-peak price table** (each model call priced by its own timestamp), and the **DeepSeek account balance** at the end of the line.

## Installation

The package declares `dsh.bundle`, so it auto-activates with a single GitHub install command:

```sh
dsh plugin --profile web add github:zydg/dsh-cost
```

Or install by hand into a profile and wire the patch row:

```sh
cd ~/.dsh/profiles/web
pnpm add github:zydg/dsh-cost
# then append "dsh-cost" to dsh.profile.bundles in package.json
```

Restart the web app and refresh the page — no tabs, no panels: every completed round simply shows its footer line.

**💡 Or just tell the AI**: in the DeepSeek Harness web chat, simply say the line below — the AI runs the install and restart for you:

```sh
帮我安装一下这个dsh plugin --profile web add github:zydg/dsh-cost并重启
```

The install and restart are done by the AI; **refreshing the page is a manual step the AI can't do** — refresh it yourself and you're done.

> Coexistence: if another usage plugin owns the `/dsh-cost/api` route or the `cost-summary` chat-node key, remove it first.

## Features

- **Per-round footer line (每轮对话末尾一行字)** — after every completed assistant turn you get, e.g.:

  `⚡ Round #4 · Input 188,843 · Cache hit 6,494,464 · Output 24,057 · Hit rate 97.2% · Period Peak · Est. $0.20 · Balance $1.73`

  (Chinese default: `⚡ 本轮 #4 · 输入 188,843 · 缓存命中 6,494,464 · 输出 24,057 · 命中率 97.2% · 时段 高峰 · 预估 ¥1.4325 · 余额 ¥12.34`)

- **Cache hit rate**: `cache-read tokens / (cache-read + cache-miss input tokens)`, computed per turn from the live event stream.
- **Official peak/off-peak pricing**: DeepSeek-V4 series uses 峰谷分时计价 (effective 2026-08-17 00:00 Beijing time). Peak windows: daily **09:00–12:00 and 14:00–18:00 (Beijing time)**; peak prices are double the off-peak prices. Default price table (元/1M tokens):

  | Model | Period | Input cache hit | Input cache miss | Output |
  |---|---|---|---|---|
  | deepseek-v4-flash | Peak | 0.10 | 3.0 | 9.0 |
  | deepseek-v4-flash | Off-peak | 0.05 | 1.5 | 4.5 |
  | deepseek-v4-pro | Peak | 0.30 | 9.0 | 27.0 |
  | deepseek-v4-pro | Off-peak | 0.15 | 4.5 | 13.5 |

  The estimate prices **each call by its own timestamp** (`isPeak(time)`), not by the turn average; a turn with **both peak and off-peak calls shows 「Peak+off-peak」** and is priced per period. Prices are configurable via the `pricing` field of `<workspace>/dsh-cost/data.json` (or the `setPrices` API action) and can be restored with `resetPrices`. The estimate is a **projection**, not the official bill.
- **Balance at the end of the line**: queries `GET https://api.deepseek.com/user/balance` with your `DEEPSEEK_API_KEY` **once per completed turn, whenever a footer line is emitted** (no fixed refresh interval; concurrent mounts such as history replay are coalesced into a single request) and appends `余额 ¥…` to each footer line. No API key configured → the line simply omits the balance. Every successful query writes a balance snapshot into `<workspace>/dsh-cost/data.json` (the same file as the call records); historical rounds show **the balance at that round** (the first snapshot taken after the round's end — the balance that round queried in real time), falling back to the current balance when no snapshot exists.
- **Live balance bar above the input box**: shows **current balance + query timestamp** (e.g. `⚡ Current balance $1.66 · updated 16:07:03`), auto-refreshed on every successful balance query (i.e. at the end of each round); turns **red when the balance drops below a configurable threshold**. The threshold is set in the settings page (stored in CNY, converts automatically when the price unit changes; default ¥10).
- **Historical turns included**: the footer is a `conversationEvents` projection (same mechanism as the built-in turn-tail / deliverables), so it replays for past turns when a session is opened.
- **Persistence (host)**: data is written to the **session workspace** `dsh-cost/` directory first (sandbox-allowed, bound to the workspace rather than the host launch cwd): **call records, balance snapshots and price overrides all live in one file `data.json`** (shape `{version, records, balanceHistory, pricing}`; records bounded at 200k, balance snapshots bounded at 50k). Candidate order: workspace root → session cwd → probe path → `$DSH_HOME` (fallback). Legacy split files (`usage-records.json` / `balance-history.json` / `pricing.json`) left in other workspaces / the user home / `$DSH_HOME` are merged into the new file automatically at startup (deduped by `time`).
- **Export records**: the `export` API action writes all call records to a **CSV or JSON** file under `<workspace>/dsh-cost/` (e.g. `dsh-cost-20260820-091530.csv`) for offline analysis.
- **One-click wipe**: the `clear` action empties all call records (balance snapshots and price overrides are kept).

## Internationalization (settings page)

Settings → **dsh-cost settings** lets you switch:

- **Display language**: 中文 / English (footer lines and the settings page switch live)
- **Price unit**: CNY ¥ / USD $ (USD is converted with a configurable rate, default 1 CNY = 0.14 USD, approximate)
- **Balance alert threshold**: the current balance above the input box turns red below this value (default ¥10, stored in CNY; the displayed/entered value converts automatically when the price unit changes)

Settings persist in the browser's localStorage — no host or price-table changes needed.

## Requirements

- DeepSeek Harness web/desktop profile (Node.js ≥ 18).
- For the balance: a DeepSeek API key configured in the harness settings (`DEEPSEEK_API_KEY`).

## How it works

### Host (`lib/index.js`)

1. Subscribes to the `llm/stream` waterfall and records every model call: time, model, provider, purpose, token counts, finish reason; attributes calls to (session, turn, step) via `session/event` + `sessionId`.
2. Serves `POST /dsh-cost/api`:

| action | body | returns |
|---|---|---|
| `list` | `{ sessionId?, turn? }` | records / per-turn summaries / totals / pricing (used by the client for the price table) |
| `balance` | — | DeepSeek account balance (via `/user/balance`) |
| `setPrices` / `resetPrices` | `{ prices }` / — | update / restore the official price table (persisted) |
| `clear` | — | wipe all records |
| `export` | `{ kind: 'csv' | 'json' }` | export file under `<workspace>/dsh-cost/` |

### Client (`lib/client.js`)

1. Registers a `cost-summary` chat node through `ctx.conversationEvents.register(...)`.
2. The projection accumulates per-step token usage from `assistant/chunk` (usage) + `assistant/message` (model) events and publishes one node when the turn ends — so it works for streaming turns and replays for history.
3. The renderer computes totals, cache hit rate, per-call peak/off-peak cost (using each call's timestamp), fetches pricing + balance once from the host API, and renders the single footer line.

## Disclaimer

- This plugin is developed **using dsh (DeepSeek Harness)**, integrating its `llm/stream` session events, `session/event` turn tracking and the `credentials` service. **Compatibility with other models/providers is not verified**; it is designed for official DeepSeek models and pricing.
- **The author's coding skill is limited** — the code may contain flaws or oversights; Issues / PRs are welcome.
- Cost estimates are based on the **official DeepSeek peak/off-peak price table** (the official cost-quote basis) and price each call by its actual timestamp. Estimates are **for reference only** — the official DeepSeek bill prevails.
- The balance query calls the official DeepSeek endpoint `GET https://api.deepseek.com/user/balance` and **reuses the same API key as the chat model** (`DEEPSEEK_API_KEY`).
- The balance endpoint may lag due to server-side latency; **balance figures are indicative only** and do not constitute a commitment of account credit.

## Data & privacy

- Records contain only token/usage metadata (no message content, no API keys).
- The API key is read through the harness `credentials` service and used only for `/user/balance`.
- Usage data lives next to your workspace (`dsh-cost/`); delete `data.json` to reset.

## License

MIT
