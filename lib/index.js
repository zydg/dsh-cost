/**
 * dsh-cost — HOST half.
 *
 * A DeepSeek Harness plugin that:
 *
 *  1. listens to the `llm/stream` waterfall and records every model call:
 *     time, model, provider, purpose, token counts (input / cache-read /
 *     cache-write / output / reasoning), finish reason, and — when the call
 *     belongs to an agent session — the session id, turn (conversation round)
 *     and step (call index inside the round);
 *  2. attributes calls to conversation rounds via `session/event`
 *     (turn/start, step/start, turn/end) plus the request `sessionId`;
 *  3. estimates the cost of each call using the official DeepSeek
 *     peak/off-peak (峰谷) price table, choosing the period from the call's
 *     own timestamp (Beijing time);
 *  4. persists everything to ONE store file <workspace>/dsh-cost/data.json:
 *     call records, balance snapshots, price overrides and the cached model
 *     catalogue (legacy split files usage-records.json / balance-history.json /
 *     pricing.json are auto-merged);
 *  5. serves a JSON API at POST /dsh-cost/api for the web client
 *     (per-turn aggregates, cache hit rate, cost, and the DeepSeek balance
 *     query via GET https://api.deepseek.com/user/balance);
 *  6. keeps the *model names* current automatically: it syncs the official
 *     list via GET https://api.deepseek.com/models (at boot, at most once per
 *     TTL, and on demand through action `syncModels`), and normalises retired
 *     ids (deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-chat,
 *     deepseek-reasoner) onto the current price buckets. The endpoint carries
 *     no prices, so the price table itself stays local and manual.
 *
 * The apply body is instrumented with a diagnostics buffer flushed to
 * dsh-cost-boot.log so activation failures are visible without app logs.
 */
import path from 'node:path'
import os from 'node:os'

export const PLUGIN_NAME = 'dsh-cost'
export const API_PATH = '/dsh-cost/api'
export const DATA_DIR = 'dsh-cost'
// 单一持久化存储文件：调用记录 + 余额快照 + 价格覆盖 合并在一个 JSON 里
export const DATA_FILE = 'data.json'
export const MAX_RECORDS = 200000
export const MAX_BALANCE_RECORDS = 50000
// 旧版分散文件（仅用于自动迁移，迁移后不再读写）
export const LEGACY_RECORDS_FILE = 'usage-records.json'
export const LEGACY_BALANCE_FILE = 'balance-history.json'
export const LEGACY_PRICING_FILE = 'pricing.json'
export const BEIJING_OFFSET_MS = 8 * 3600 * 1000

/**
 * Official DeepSeek price table (per 1M tokens, CNY 元/百万tokens).
 * Source: DeepSeek 官方公告 — DeepSeek-V4.1-Flash 于 2026-09-10 发布，API 价格
 * 同步下调（北京时间 2026-09-10 12:00 起生效）：空闲时段缓存命中 0.02 元 /
 * 缓存未命中 1 元 / 输出 4 元，高峰时段为空闲时段价格的两倍。
 * 峰谷规则：高峰时段为北京时间周一至周五 09:00–12:00、14:00–18:00，
 * 其余时间（含周六/周日全天）均为空闲时段（weekendOffPeak: true）。
 * 模型名：新模型名为 deepseek-flash；旧名 deepseek-v4-flash 与
 * deepseek-v4-flash-vision-exp 已下线，请求由 V4.1 Flash 提供服务并按
 * Flash 价格计费。V4 Pro 有序下线：北京时间 2026-09-14 12:00 起至
 * V4.1 Pro 上线前，deepseek-v4-pro 的请求全部路由到 V4.1 Flash 并按
 * Flash 单价计费（见 proRoute）。
 */
export const DEFAULT_PRICING = Object.freeze({
  effectiveAt: '2026-09-10T12:00:00+08:00',
  weekendOffPeak: true,
  peakWindows: [
    { start: 9 * 60, end: 12 * 60 },
    { start: 14 * 60, end: 18 * 60 }
  ],
  // V4 Pro 有序下线：北京时间 2026-09-14 12:00 起，至 V4.1 Pro 上线前，
  // deepseek-v4-pro 的请求全部路由到 V4.1 Flash，并按 V4.1 Flash 单价计费。
  proRoute: Object.freeze({
    at: '2026-09-14T12:00:00+08:00',
    to: 'deepseek-flash'
  }),
  models: Object.freeze({
    'deepseek-flash': Object.freeze({
      label: 'deepseek-flash (V4.1 Flash)',
      offPeak: Object.freeze({ cacheHit: 0.02, cacheMiss: 1, output: 4 }),
      peak: Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 })
    }),
    'deepseek-v4-pro': Object.freeze({
      label: 'deepseek-v4-pro',
      offPeak: Object.freeze({ cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }),
      peak: Object.freeze({ cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 })
    })
  })
})

/**
 * Official model id → price bucket (canonical naming lineage).
 *   deepseek-flash                    V4.1 Flash，2026-09-10 起的在售名
 *   deepseek-v4-flash                 旧名，已下线，请求由 V4.1 Flash 承接
 *   deepseek-v4-flash-vision-exp      旧识图名，同上
 *   deepseek-chat / deepseek-reasoner 更早的通用名，2026-07-24 停用，
 *                                     分别迁移到 V4 Flash / V4 Pro
 *   deepseek-v4-pro                   仍按 Pro 价计费，直到 pricing.proRoute.at 生效
 */
export const MODEL_ALIASES = Object.freeze({
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek-v4-pro'
})

/** Clone the default price table into a mutable working copy. */
export function clonePricing() {
  return JSON.parse(JSON.stringify(DEFAULT_PRICING))
}

/**
 * Map a provider model name to a known price bucket. Names are normalised
 * through MODEL_ALIASES first, then matched loosely, so a future id such as
 * `deepseek-flash-2` or `deepseek-v4-pro-2` still lands in the right bucket.
 */
export function modelKey(model) {
  const m = String(model || '').trim().toLowerCase()
  if (!m) return 'unknown'
  if (MODEL_ALIASES[m]) return MODEL_ALIASES[m]
  if (m.includes('pro')) return 'deepseek-v4-pro'
  if (m.includes('flash')) return 'deepseek-flash'
  return 'unknown'
}

/**
 * Price bucket actually billed for a call: normally `modelKey(model)`, except
 * that deepseek-v4-pro requests are routed to V4.1 Flash — and billed at the
 * Flash price — from `pricing.proRoute.at` until V4.1 Pro ships.
 */
export function billedModelKey(model, time, pricing) {
  const mk = modelKey(model)
  const route = pricing && pricing.proRoute
  if (mk === 'deepseek-v4-pro' && route && route.at && route.to) {
    const at = Date.parse(route.at)
    if (Number.isFinite(at) && Number(time) >= at) return route.to
  }
  return mk
}

/** Beijing-minute-of-day from a unix timestamp (ms). */
export function beijingMinutes(ts) {
  const d = new Date(Number(ts) + BEIJING_OFFSET_MS)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/**
 * True when the call time falls inside a peak window (Beijing time).
 * Windows are configured in pricing.peakWindows as {start, end} minutes.
 */
export function isPeak(ts, peakWindows, weekendOffPeak = true) {
  // 显式传入数组（含空数组 []）即以此为准：[] 表示全天低谷；未传时才回退默认。
  const windows = Array.isArray(peakWindows)
    ? peakWindows
    : DEFAULT_PRICING.peakWindows
  // 自 2026-08-23 起，周六/周日全天按低谷价计费（weekendOffPeak 默认开启）。
  if (weekendOffPeak !== false) {
    const d = new Date(Number(ts) + BEIJING_OFFSET_MS)
    const day = d.getUTCDay()
    if (day === 0 || day === 6) return false
  }
  const t = beijingMinutes(ts)
  for (const w of windows) {
    const start = Number(w && w.start)
    const end = Number(w && w.end)
    if (Number.isFinite(start) && Number.isFinite(end) && t >= start && t < end) return true
  }
  return false
}

/**
 * Estimated cost of one call in CNY (元), from the official peak/off-peak
 * table. Token semantics follow the harness convention (disjoint counts):
 *  - cacheReadTokens: input served from cache (billed at cacheHit price)
 *  - inputTokens:     input cache misses (billed at cacheMiss price)
 *  - outputTokens:    completion tokens (billed at output price; reasoning
 *                     tokens are included in outputTokens and NOT double-charged)
 */
export function costFor(rec, pricing) {
  const p = pricing && pricing.models ? pricing : DEFAULT_PRICING
  const mk = billedModelKey(rec && rec.model, rec && rec.time, p)
  const row = p.models && p.models[mk]
  if (!row) return 0
  const hit = Number(rec.cacheReadTokens) || 0
  const miss = Number(rec.inputTokens) || 0
  const out = Number(rec.outputTokens) || 0
  const rates = isPeak(rec && rec.time, p.peakWindows, p.weekendOffPeak) ? row.peak : row.offPeak
  return (hit * rates.cacheHit + miss * rates.cacheMiss + out * rates.output) / 1e6
}

/** Cache hit rate = cache-read tokens / total input tokens (0..1). */
export function hitRateOf(cacheRead, inputMiss) {
  const total = (Number(cacheRead) || 0) + (Number(inputMiss) || 0)
  return total > 0 ? (Number(cacheRead) || 0) / total : 0
}

/** Parse the DeepSeek /user/balance response body. */
export function parseBalance(text) {
  let data
  try { data = JSON.parse(text) } catch { return { ok: false, error: '无法解析余额响应' } }
  const raw = data && Array.isArray(data.balance_infos) ? data.balance_infos : []
  const infos = raw.map((b) => ({
    currency: String(b.currency || 'CNY'),
    totalBalance: String(b.total_balance == null ? '0' : b.total_balance),
    grantedBalance: String(b.granted_balance == null ? '0' : b.granted_balance),
    toppedUpBalance: String(b.topped_up_balance == null ? '0' : b.topped_up_balance)
  }))
  return {
    ok: true,
    queriedAt: Date.now(),
    isAvailable: data.is_available === true,
    infos
  }
}

/** How long a fetched model catalogue stays fresh (auto refresh is best effort). */
export const MODEL_CATALOG_TTL_MS = 24 * 3600 * 1000
/** Minimum gap between two automatic refreshes triggered by an unknown model. */
export const MODEL_CATALOG_MIN_GAP_MS = 10 * 60 * 1000

/**
 * Parse the DeepSeek `GET /models` body:
 * `{ object: 'list', data: [{ id, object, owned_by }, ...] }`.
 * The endpoint is the authoritative source for model *names* only — it carries
 * no prices, so the price table stays local (pricing.models / setPrices).
 */
export function parseModels(text) {
  let data
  try { data = JSON.parse(text) } catch { return { ok: false, error: '无法解析模型清单响应' } }
  const rows = data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : [])
  const ids = []
  const seen = new Set()
  for (const row of rows) {
    const id = String((row && (row.id || row.model)) || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) return { ok: false, error: '模型清单为空' }
  return { ok: true, fetchedAt: Date.now(), ids }
}

/** True when a cached catalogue is missing or older than `ttlMs`. */
export function catalogStale(catalog, now = Date.now(), ttlMs = MODEL_CATALOG_TTL_MS) {
  const at = Number(catalog && catalog.fetchedAt)
  if (!Number.isFinite(at) || at <= 0) return true
  return Number(now) - at >= Number(ttlMs)
}

/**
 * Merge freshly fetched ids into a cached catalogue (fresh ids first, cached
 * ids kept so a model that just disappeared from the API is still recognised
 * in historical records). Returns the merged id list.
 */
export function mergeCatalogIds(catalog, ids, fetchedAt = Date.now()) {
  const target = catalog && typeof catalog === 'object' ? catalog : {}
  const merged = []
  const seen = new Set()
  const incoming = Array.isArray(ids) ? ids : []
  const cached = Array.isArray(target.ids) ? target.ids : []
  for (const raw of incoming.concat(cached)) {
    const id = String(raw || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    merged.push(id)
  }
  target.ids = merged
  target.fetchedAt = Number(fetchedAt) || Date.now()
  target.error = ''
  return merged
}

export default {
  inject: ['fs', 'webServer', 'subprocess', 'credentials', 'sandboxPolicy', 'agents'],
  apply(ctx) {
    const diag = { ok: true, steps: [], error: null }
    const push = (s) => { try { diag.steps.push(String(s)) } catch {} }
    const msg = (e) => String((e && e.message) || e)
    const flushDiag = () => {
      try {
        const fs = ctx.get('fs')
        if (fs && typeof fs.resolve === 'function' && typeof fs.writeText === 'function') {
          fs.resolve('dsh-cost-boot.log')
            .then((target) => fs.writeText(target, JSON.stringify({ time: Date.now(), plugin: PLUGIN_NAME, ...diag }, null, 2)))
            .catch(() => {})
        }
      } catch {}
    }

    try {
      push('apply-start')

      // ── state ─────────────────────────────────────────────────────────────
      const records = []
      // Balance snapshots, ascending by time: [{ time, totalBalance, currency }]
      const balanceHistory = []
      // sessionId -> { turn, step, startedAt, endedAt } (live turn tracking)
      const sessionState = new Map()
      let pricing = clonePricing()
      // 官方模型清单缓存（来自 GET /models）：只含模型名，不含价格。
      // { ids: string[], fetchedAt: number, lastAttemptAt: number, error: string, syncing: boolean }
      const modelCatalog = { ids: [], fetchedAt: 0, lastAttemptAt: 0, error: '', syncing: false }

      const fs = ctx.get('fs')
      const webServer = ctx.get('webServer')
      const subprocess = ctx.get('subprocess')
      const credentials = ctx.get('credentials')
      const agents = ctx.get('agents')
      push('services fs/webServer/subprocess/credentials/agents=' +
        [fs ? 1 : 0, webServer ? 1 : 0, subprocess ? 1 : 0, credentials ? 1 : 0, agents ? 1 : 0].join(''))

      // ── path helpers (cross-platform) ─────────────────────────────────────
      const IS_WIN = typeof process !== 'undefined' && process.platform === 'win32'
      const BS = String.fromCharCode(92)
      const normPath = (p) => {
        const s = String(p == null ? '' : p)
        return IS_WIN ? s.split(BS).join('/') : s
      }
      const joinPath = (...parts) => path.join(...parts.map((p) => String(p == null ? '' : p)))

      /** Stable data root: $DSH_HOME (default ~/.dsh) so data follows dsh, not the launch cwd. */
      function homeDshDir() {
        const env = typeof process !== 'undefined' ? process.env : undefined
        if (env && env.DSH_HOME) return String(env.DSH_HOME)
        try {
          return path.join(os.homedir(), '.dsh')
        } catch { return undefined }
      }

      // ── persistence ───────────────────────────────────────────────────────
      let root = ''
      let dataPath = ''
      let persistOk = false
      let persistError = ''
      let initPromise = null
      let writeChain = Promise.resolve()
      let cachedPolicy = null

      const dirs = () => ({
        data: joinPath(root, DATA_DIR)
      })

      function currentAgent() {
        try {
          if (agents && typeof agents.currentInitiator === 'function') return agents.currentInitiator()
        } catch {}
        return undefined
      }

      function sessionPolicy() {
        if (cachedPolicy) return cachedPolicy
        try {
          const agent = currentAgent()
          const sp = ctx.get('sandboxPolicy')
          if (sp && typeof sp.resolve === 'function' && agent && agent.session) {
            const policy = sp.resolve({ session: agent.session })
            if (policy && policy.workspaceRoot) { cachedPolicy = policy; return policy }
          }
        } catch {}
        return undefined
      }

      /** 序列化整个 store（调用记录 + 余额快照 + 价格覆盖 + 模型清单缓存）。 */
      function storeText() {
        return JSON.stringify({
          version: 2,
          updatedAt: Date.now(),
          records,
          balanceHistory,
          pricing,
          modelCatalog: { ids: modelCatalog.ids, fetchedAt: modelCatalog.fetchedAt }
        })
      }

      function persistNow() {
        if (!fs || !dataPath || !persistOk) return Promise.resolve()
        const text = storeText()
        const policy = sessionPolicy()
        writeChain = writeChain
          .then(() => fs.resolve(dataPath))
          .then((target) => fs.writeText(target, text, undefined, undefined, policy || undefined))
          .catch(() => {})
        return writeChain
      }

      function trimBalanceHistory() {
        if (balanceHistory.length > MAX_BALANCE_RECORDS) {
          balanceHistory.splice(0, balanceHistory.length - MAX_BALANCE_RECORDS)
        }
      }

      // 余额/价格落盘与调用记录共用同一 store 文件
      function persistBalanceNow() { return persistNow() }
      function persistPricing() { return persistNow() }

      /** 校验并归一单个模型的价格行：label + 高峰/空闲三档价（非负数字）。 */
      function normalizeModelRates(row) {
        const src = row && typeof row === 'object' ? row : {}
        const out = { label: String(src.label || '').trim() }
        for (const period of ['offPeak', 'peak']) {
          const rate = src[period] && typeof src[period] === 'object' ? src[period] : {}
          const dst = {}
          for (const k of ['cacheHit', 'cacheMiss', 'output']) {
            const v = Number(rate[k])
            dst[k] = Number.isFinite(v) && v >= 0 ? v : 0
          }
          out[period] = dst
        }
        return out
      }

      /** 校验整张模型价格表：键去空白、去重、每行归一；非法或空表返回 null。 */
      function normalizeModelTable(models) {
        if (!models || typeof models !== 'object' || Array.isArray(models)) return null
        const out = {}
        for (const key of Object.keys(models)) {
          const k = String(key).trim()
          if (!k || out[k]) continue
          out[k] = normalizeModelRates(models[k])
        }
        return Object.keys(out).length ? out : null
      }

      /**
       * 校验高峰时段：每项 {start,end} 为当天分钟数，需 0 ≤ start < end ≤ 1440。
       * 空数组 [] 表示全天低谷；存在非法项但没有任何合法项时返回 null。
       */
      function normalizePeakWindows(arr) {
        if (!Array.isArray(arr)) return null
        const out = []
        for (const item of arr) {
          if (!item || typeof item !== 'object') continue
          const start = Math.round(Number(item.start))
          const end = Math.round(Number(item.end))
          if (!Number.isFinite(start) || !Number.isFinite(end)) continue
          if (start < 0 || end > 1440 || start >= end) continue
          out.push({ start, end })
        }
        if (arr.length > 0 && out.length === 0) return null
        out.sort((a, b) => a.start - b.start)
        return out
      }

      /**
       * 把 store 里的价格覆盖合并进当前 pricing（非负数字才接受）。
       * replaceModels=true 时整表替换（用于恢复用户自定义的完整模型表）。
       */
      function applyPricing(src, replaceModels) {
        if (!src || typeof src !== 'object') return
        if (typeof src.effectiveAt === 'string') pricing.effectiveAt = src.effectiveAt
        if (typeof src.weekendOffPeak === 'boolean') pricing.weekendOffPeak = src.weekendOffPeak
        if (Array.isArray(src.peakWindows)) {
          const windows = normalizePeakWindows(src.peakWindows)
          if (windows) pricing.peakWindows = windows
        }
        const route = src.proRoute
        if (route && typeof route === 'object' && pricing.proRoute) {
          if (typeof route.at === 'string' && route.at) pricing.proRoute.at = route.at
          if (typeof route.to === 'string' && route.to) pricing.proRoute.to = route.to
        }
        const models = src.models
        if (!models || typeof models !== 'object') return
        if (replaceModels) {
          const table = normalizeModelTable(models)
          if (table) pricing.models = table
          return
        }
        for (const mk of Object.keys(models)) {
          const row = models[mk]
          if (!row || typeof row !== 'object') continue
          if (!pricing.models[mk]) { pricing.models[mk] = normalizeModelRates(row); continue }
          if (typeof row.label === 'string' && row.label) pricing.models[mk].label = row.label
          for (const period of ['peak', 'offPeak']) {
            const rates = row[period]
            const dst = pricing.models[mk][period]
            if (!rates || typeof rates !== 'object' || !dst) continue
            for (const k of ['cacheHit', 'cacheMiss', 'output']) {
              const v = Number(rates[k])
              if (Number.isFinite(v) && v >= 0) dst[k] = v
            }
          }
        }
      }

      /** 把 store 里的模型清单缓存合并进内存（只接受非空字符串 id）。 */
      function applyCatalog(src) {
        if (!src || typeof src !== 'object' || !Array.isArray(src.ids)) return
        const at = Number(src.fetchedAt)
        mergeCatalogIds(modelCatalog, src.ids, Number.isFinite(at) && at > 0 ? at : Date.now())
      }

      /** 从旧版独立 pricing.json 迁移价格覆盖。 */
      async function loadPricingFromFile(target) {
        if (!fs || !target) return
        try {
          const resolved = await fs.resolve(target)
          const data = JSON.parse(await fs.readText(resolved))
          if (data && typeof data === 'object') applyPricing(data)
        } catch {}
      }

      function normalizeRecord(raw) {
        if (!raw || typeof raw !== 'object') return null
        const time = Number(raw.time)
        if (!Number.isFinite(time) || time <= 0) return null
        const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
        return {
          time,
          model: String(raw.model || ''),
          provider: String(raw.provider || ''),
          purpose: String(raw.purpose || ''),
          sessionId: String(raw.sessionId || ''),
          turn: Number.isFinite(Number(raw.turn)) ? Number(raw.turn) : 0,
          step: Number.isFinite(Number(raw.step)) ? Number(raw.step) : 0,
          inputTokens: toNum(raw.inputTokens),
          outputTokens: toNum(raw.outputTokens),
          cacheReadTokens: toNum(raw.cacheReadTokens),
          cacheWriteTokens: toNum(raw.cacheWriteTokens),
          reasoningTokens: toNum(raw.reasoningTokens),
          finishReason: String(raw.finishReason || '')
        }
      }

      function normalizeBalance(raw) {
        if (!raw || typeof raw !== 'object') return null
        const time = Number(raw.time)
        if (!Number.isFinite(time) || time <= 0) return null
        return {
          time,
          totalBalance: String(raw.totalBalance == null ? '0' : raw.totalBalance),
          currency: String(raw.currency || 'CNY')
        }
      }



      async function mergeRecordsFile(target) {
        if (!fs || !target) return
        let arr = null
        try {
          const resolved = await fs.resolve(target)
          arr = JSON.parse(await fs.readText(resolved))
        } catch { return }
        if (!Array.isArray(arr) || arr.length === 0) return
        const existing = new Set(records.map((r) => r.time))
        let added = 0
        for (const raw of arr) {
          const rec = normalizeRecord(raw)
          if (!rec || existing.has(rec.time)) continue
          existing.add(rec.time)
          records.push(rec)
          added++
        }
        if (added > 0) {
          if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
          records.sort((a, b) => a.time - b.time)
          await persistNow()
        }
      }

      async function mergeBalanceFile(target) {
        if (!fs || !target) return
        let arr = null
        try {
          const resolved = await fs.resolve(target)
          arr = JSON.parse(await fs.readText(resolved))
        } catch { return }
        if (!Array.isArray(arr) || arr.length === 0) return
        const existing = new Set(balanceHistory.map((b) => b.time))
        let added = 0
        for (const raw of arr) {
          const rec = normalizeBalance(raw)
          if (!rec || existing.has(rec.time)) continue
          existing.add(rec.time)
          balanceHistory.push(rec)
          added++
        }
        if (added > 0) {
          trimBalanceHistory()
          balanceHistory.sort((a, b) => a.time - b.time)
          await persistBalanceNow()
        }
      }

      /** One-time import of legacy records kept under the launch-cwd dsh-cost/ dirs. */
      async function migrateLegacyFiles() {
        if (!fs || !dataPath) return
        const legacyDirs = []
        const agent = currentAgent()
        if (agent && agent.session && agent.session.header && agent.session.header.cwd) {
          legacyDirs.push(normPath(String(agent.session.header.cwd)))
        }
        try {
          const sp = ctx.get('sandboxPolicy')
          if (sp && sp.workspaceRoot) legacyDirs.push(normPath(String(sp.workspaceRoot)))
        } catch {}
        try {
          legacyDirs.push(normPath(os.homedir()))
        } catch {}
        try {
          if (homeDshDir()) legacyDirs.push(normPath(homeDshDir()))
        } catch {}
        try {
          const t = await fs.resolve('dsh-cost-probe')
          const p = String(t.displayPath || '')
          const i = p.lastIndexOf('dsh-cost-probe')
          if (i > 0) legacyDirs.push(p.slice(0, i))
        } catch {}
        for (const dir of legacyDirs) {
          if (!dir || normPath(dir) === normPath(root)) continue
          // 旧版分散文件
          await mergeRecordsFile(joinPath(dir, DATA_DIR, LEGACY_RECORDS_FILE))
          await mergeBalanceFile(joinPath(dir, DATA_DIR, LEGACY_BALANCE_FILE))
          // 其他位置的新版 store（去重并入）
          await mergeStoreFile(joinPath(dir, DATA_DIR, DATA_FILE))
        }
      }

      /** 把另一个 store 文件的 records/balanceHistory/pricing 并入内存（按 time 去重）。 */
      async function mergeStoreFile(target) {
        if (!fs || !target) return
        let store = null
        try {
          const resolved = await fs.resolve(target)
          store = JSON.parse(await fs.readText(resolved))
        } catch { return }
        if (!store || typeof store !== 'object') return
        let changed = false
        if (Array.isArray(store.records)) {
          const existing = new Set(records.map((r) => r.time))
          for (const raw of store.records) {
            const rec = normalizeRecord(raw)
            if (!rec || existing.has(rec.time)) continue
            existing.add(rec.time)
            records.push(rec)
            changed = true
          }
          if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
          records.sort((a, b) => a.time - b.time)
        }
        if (Array.isArray(store.balanceHistory)) {
          const existing = new Set(balanceHistory.map((b) => b.time))
          for (const raw of store.balanceHistory) {
            const rec = normalizeBalance(raw)
            if (!rec || existing.has(rec.time)) continue
            existing.add(rec.time)
            balanceHistory.push(rec)
            changed = true
          }
          trimBalanceHistory()
          balanceHistory.sort((a, b) => a.time - b.time)
        }
        if (store.pricing && typeof store.pricing === 'object') applyPricing(store.pricing)
        if (store.modelCatalog) applyCatalog(store.modelCatalog)
        if (changed) await persistNow()
      }

      async function tryInitWithRoot(candidate, policy) {
        const tryPath = joinPath(normPath(candidate), DATA_DIR, DATA_FILE)
        let loaded = false
        try {
          const target = await fs.resolve(tryPath)
          const store = JSON.parse(await fs.readText(target))
          if (store && typeof store === 'object' && Array.isArray(store.records)) {
            const existing = new Set(records.map((r) => r.time))
            for (const raw of store.records) {
              const rec = normalizeRecord(raw)
              if (!rec || existing.has(rec.time)) continue
              existing.add(rec.time)
              records.push(rec)
            }
            if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
            records.sort((a, b) => a.time - b.time)
            if (Array.isArray(store.balanceHistory)) {
              balanceHistory.length = 0
              for (const raw of store.balanceHistory) {
                const rec = normalizeBalance(raw)
                if (rec) balanceHistory.push(rec)
              }
              trimBalanceHistory()
              balanceHistory.sort((a, b) => a.time - b.time)
            }
            if (store.pricing && typeof store.pricing === 'object') applyPricing(store.pricing, true)
            if (store.modelCatalog) applyCatalog(store.modelCatalog)
            loaded = true
          }
        } catch {}
        // 旧版分散文件迁移：同目录下的 usage-records.json / balance-history.json / pricing.json
        if (!loaded) {
          const dir = path.dirname(tryPath)
          await mergeRecordsFile(joinPath(dir, LEGACY_RECORDS_FILE))
          await mergeBalanceFile(joinPath(dir, LEGACY_BALANCE_FILE))
          await loadPricingFromFile(joinPath(dir, LEGACY_PRICING_FILE))
        }
        try {
          const target = await fs.resolve(tryPath)
          await fs.writeText(target, storeText(), undefined, undefined, policy || undefined)
          root = normPath(candidate)
          dataPath = tryPath
          persistOk = true
          persistError = ''
          return { ok: true }
        } catch (e) {
          return { ok: false, error: msg(e) }
        }
      }

      async function initPersistence() {
        if (!fs) { persistError = '文件服务不可用'; return }
        const candidates = []
        const homeDsh = homeDshDir()
        try {
          const sp = ctx.get('sandboxPolicy')
          if (sp && sp.workspaceRoot) candidates.push(normPath(String(sp.workspaceRoot)))
        } catch {}
        const agent = currentAgent()
        if (agent && agent.session && agent.session.header && agent.session.header.cwd) {
          const cwd = normPath(String(agent.session.header.cwd))
          if (!candidates.includes(cwd)) candidates.push(cwd)
        }
        try {
          const t = await fs.resolve('dsh-cost-probe')
          const p = String(t.displayPath || '')
          const i = p.lastIndexOf('dsh-cost-probe')
          if (i > 0) candidates.push(p.slice(0, i))
        } catch {}
        // Last resort when the workspace/sandbox rejects every candidate.
        if (homeDsh) candidates.push(normPath(homeDsh))
        const seen = new Set()
        let lastError = ''
        for (const c of candidates) {
          if (!c || seen.has(c)) continue
          seen.add(c)
          const r = await tryInitWithRoot(c, sessionPolicy())
          if (r.ok) {
            persistNow()
            await migrateLegacyFiles()
            return
          }
          lastError = r.error || '写入失败'
        }
        persistError = lastError || '未找到可写的持久化目录'
        persistOk = false
        root = ''
        dataPath = ''
      }

      const ensureInit = () => (initPromise ||= initPersistence())
      try { ensureInit() } catch (e) { push('ensureInit-threw: ' + msg(e)) }

      // ── turn tracking via session events ──────────────────────────────────
      try {
        ctx.on('session/event', (session, event) => {
          if (!session || !event) return
          const id = String(session.id || '')
          if (!id) return
          let st = sessionState.get(id)
          if (!st) { st = { turn: 0, step: 0, startedAt: 0, endedAt: 0 }; sessionState.set(id, st) }
          if (event.type === 'turn/start') {
            st.turn = Number(event.data && event.data.turn) || 0
            st.step = 0
            st.startedAt = Number(event.time) || 0
            st.endedAt = 0
          } else if (event.type === 'step/start') {
            st.step = Number(event.data && event.data.step) || 0
          } else if (event.type === 'turn/end') {
            st.endedAt = Number(event.time) || st.endedAt
          }
        })
        push('session-event-listener-ok')
      } catch (e) {
        push('session-event-listener-threw: ' + msg(e))
      }

      // ── capture ────────────────────────────────────────────────────────────
      try {
        ctx.on('llm/stream', function (options, next) {
          const source = next()
          const startedAt = Date.now()
          const sessionId = options && options.sessionId ? String(options.sessionId) : ''
          const model = (options && options.model) || ''
          const provider = (options && options.provider) || ''
          const purpose = options && options.purpose ? String(options.purpose) : ''
          let usage = null
          let finishReason = ''

          async function* observe() {
            try {
              for await (const chunk of source) {
                if (chunk && chunk.type === 'usage' && chunk.usage) {
                  usage = chunk.usage
                } else if (chunk && chunk.type === 'finish') {
                  const r = chunk.reason
                  finishReason = r ? String(r.kind || '') : ''
                }
                yield chunk
              }
            } finally {
              if (usage) {
                const st = sessionId ? sessionState.get(sessionId) : undefined
                records.push({
                  time: startedAt,
                  model,
                  provider,
                  purpose,
                  sessionId,
                  turn: st ? st.turn : 0,
                  step: st ? st.step : 0,
                  inputTokens: usage.inputTokens || 0,
                  outputTokens: usage.outputTokens || 0,
                  cacheReadTokens: usage.cacheReadTokens || 0,
                  cacheWriteTokens: usage.cacheWriteTokens || 0,
                  reasoningTokens: usage.reasoningTokens || 0,
                  finishReason
                })
                if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
                // 官方清单里没有这个模型名（例如官方刚上新模型）→ 触发一次自动同步。
                noteModelSeen(model)
                try {
                  const agent = currentAgent()
                  const sp = ctx.get('sandboxPolicy')
                  if (sp && typeof sp.resolve === 'function' && agent && agent.session) {
                    const policy = sp.resolve({ session: agent.session })
                    if (policy && policy.workspaceRoot) cachedPolicy = policy
                  }
                } catch {}
                ensureInit().then(() => persistNow()).catch(() => {})
              }
            }
          }

          return observe()
        })
        push('llm-stream-listener-ok')
      } catch (e) {
        push('llm-stream-listener-threw: ' + msg(e))
      }

      // ── balance ────────────────────────────────────────────────────────────
      const IS_MAC = typeof process !== 'undefined' && process.platform === 'darwin'
      const isElectron = typeof process !== 'undefined' && !!(process.versions && process.versions.electron)

      async function safeCwd() {
        if (root && fs) {
          try {
            const t = await fs.resolve(root)
            const info = await fs.stat(t)
            if (info) return root
          } catch {}
        }
        return (typeof process !== 'undefined' && typeof process.cwd === 'function' && process.cwd()) || '.'
      }

      async function runCollect(argv, opts) {
        if (!subprocess) return { ok: false, error: '命令执行服务不可用' }
        let handle
        try {
          handle = subprocess.spawn({
            argv,
            cwd: await safeCwd(),
            stdio: opts && opts.stdinData != null
              ? { stdin: { data: opts.stdinData }, stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } }
              : { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
            graceMs: (opts && opts.graceMs) || 15000,
            ...(opts && opts.env ? { env: opts.env } : {})
          })
        } catch (e) { return { ok: false, error: '启动失败：' + msg(e) } }
        let outcome
        try { outcome = await handle.done } catch (e) { return { ok: false, error: '执行失败：' + msg(e) } }
        const outText = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const errText = handle.collected && handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, out: outText, err: errText }
      }

      function nodeCandidates() {
        const list = IS_WIN ? ['node.exe', 'node', 'C:\\Program Files\\nodejs\\node.exe'] : ['node']
        if (typeof process !== 'undefined' && process.execPath && !list.includes(process.execPath)) list.push(process.execPath)
        return list
      }

      async function spawnNode(script, stdinData, env) {
        if (!subprocess) return { ok: false, error: '命令执行服务不可用' }
        let exe = null
        for (const c of nodeCandidates()) {
          try { exe = await subprocess.resolveExecutable(c); if (exe) break } catch {}
        }
        if (!exe) return { ok: false, error: '未找到 node 可执行文件' }
        const finalEnv = env || {}
        if (isElectron && exe === process.execPath && !('ELECTRON_RUN_AS_NODE' in finalEnv)) {
          finalEnv.ELECTRON_RUN_AS_NODE = '1'
        }
        const r = await runCollect([exe, '-e', script], { stdinData, env: finalEnv })
        if (!r.ok) {
          if (r.exitCode != null) return { ok: false, error: 'node 退出码 ' + r.exitCode + (r.err ? '：' + r.err.trim() : '') }
          return { ok: false, error: r.error || '执行失败' }
        }
        return { ok: true, out: r.out }
      }

      /** 读取 DeepSeek API Key（余额、模型清单与对话模型共用同一凭据）。 */
      async function resolveApiKey() {
        if (!credentials) return { ok: false, error: '凭据服务不可用' }
        let hit
        try { hit = await credentials.resolve('DEEPSEEK_API_KEY') } catch (e) { return { ok: false, error: '读取凭据失败：' + msg(e) } }
        if (!hit || !hit.value) return { ok: false, error: '未配置 DEEPSEEK_API_KEY，请在「设置 → 模型」中配置后重试' }
        return { ok: true, key: String(hit.value) }
      }

      /** 允许访问的官方接口路径白名单（避免把任意路径拼进子进程脚本）。 */
      const API_PATHS = ['/user/balance', '/models']

      /** GET 一个 DeepSeek 开放接口（走 node https 子进程，不依赖宿主 fetch）。 */
      async function deepseekGet(pathname) {
        if (!API_PATHS.includes(pathname)) return { ok: false, error: '不允许的接口路径：' + pathname }
        const cred = await resolveApiKey()
        if (!cred.ok) return cred
        const script = [
          'const https=require("https");',
          'const key=process.env.DEEPSEEK_API_KEY||"";',
          'const req=https.get("https://api.deepseek.com' + pathname + '",{headers:{Authorization:"Bearer "+key}},function(res){',
          'var body="";',
          'res.on("data",function(c){body+=c});',
          'res.on("end",function(){process.stdout.write(JSON.stringify({statusCode:res.statusCode,body:body}))});',
          '});',
          'req.on("error",function(e){process.stdout.write(JSON.stringify({error:String(e&&e.message||e)}))});',
          'req.setTimeout(20000,function(){req.destroy(new Error("timeout"))});'
        ].join('\n')
        const r = await spawnNode(script, null, { DEEPSEEK_API_KEY: cred.key })
        if (!r.ok) return { ok: false, error: r.error }
        let parsed
        try { parsed = JSON.parse(r.out) } catch { return { ok: false, error: '无法解析 node 输出' } }
        if (parsed.error) return { ok: false, error: parsed.error }
        if (parsed.statusCode !== 200) return { ok: false, error: '接口返回 HTTP ' + parsed.statusCode + '：' + String(parsed.body || '').slice(0, 300) }
        return { ok: true, statusCode: parsed.statusCode, body: parsed.body }
      }

      async function queryBalance() {
        const r = await deepseekGet('/user/balance')
        if (!r.ok) return r
        return parseBalance(r.body)
      }

      /**
       * GET /models — 官方模型名清单（自动同步的来源）。官方没有机器可读的
       * 价目接口，因此价格仍以本地价格表为准（pricing / setPrices）。
       */
      async function queryModels() {
        const r = await deepseekGet('/models')
        if (!r.ok) return r
        return parseModels(r.body)
      }

      function catalogView() {
        return {
          ids: modelCatalog.ids.slice(),
          fetchedAt: modelCatalog.fetchedAt,
          error: modelCatalog.error,
          syncing: modelCatalog.syncing,
          ttlMs: MODEL_CATALOG_TTL_MS
        }
      }

      /**
       * 同步官方模型清单。force=false（自动触发）受 TTL 与最小间隔约束，
       * force=true（设置面板手动按钮）立即拉取。失败只记录错误，不抛异常。
       */
      async function syncModels(force) {
        const now = Date.now()
        if (modelCatalog.syncing) {
          return { ...catalogView(), ok: false, throttled: true, error: modelCatalog.error || '同步进行中' }
        }
        if (!force) {
          if (!catalogStale(modelCatalog, now)) return { ...catalogView(), ok: true, cached: true }
          if (modelCatalog.lastAttemptAt && now - modelCatalog.lastAttemptAt < MODEL_CATALOG_MIN_GAP_MS) {
            return { ...catalogView(), ok: true, cached: true, throttled: true }
          }
        }
        modelCatalog.syncing = true
        modelCatalog.lastAttemptAt = now
        try {
          const r = await queryModels()
          if (r && r.ok) {
            const merged = mergeCatalogIds(modelCatalog, r.ids, r.fetchedAt)
            modelCatalog.error = ''
            try { await ensureInit(); await persistNow() } catch {}
            return { ...catalogView(), ok: true, count: merged.length, added: r.ids.length }
          }
          modelCatalog.error = String((r && r.error) || '同步失败')
          return { ...catalogView(), ok: false, error: modelCatalog.error }
        } catch (e) {
          modelCatalog.error = msg(e)
          return { ...catalogView(), ok: false, error: modelCatalog.error }
        } finally {
          modelCatalog.syncing = false
        }
      }

      /** 记录到一个不在官方清单里的模型名 → 触发一次（受节流的）自动同步。 */
      function noteModelSeen(model) {
        const id = String(model || '').trim().toLowerCase()
        if (!id) return
        if (modelCatalog.ids.some((x) => String(x).toLowerCase() === id)) return
        try { syncModels(false).catch(() => {}) } catch {}
      }

      // ── aggregates ─────────────────────────────────────────────────────────
      const pad2 = (n) => (n < 10 ? '0' : '') + n

      function bjDateTime(ts) {
        const d = new Date(Number(ts) + BEIJING_OFFSET_MS)
        return pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
          pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds())
      }

      function bjKey(ts) {
        const d = new Date(Number(ts) + BEIJING_OFFSET_MS)
        return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
      }

      function enrich(rec) {
        const cost = costFor(rec, pricing)
        return {
          time: rec.time,
          timeText: bjDateTime(rec.time),
          day: bjKey(rec.time),
          model: rec.model,
          provider: rec.provider,
          purpose: rec.purpose,
          sessionId: rec.sessionId,
          turn: rec.turn,
          step: rec.step,
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cacheReadTokens: rec.cacheReadTokens,
          cacheWriteTokens: rec.cacheWriteTokens,
          reasoningTokens: rec.reasoningTokens,
          finishReason: rec.finishReason,
          modelKey: modelKey(rec.model),
          // 价格表里找不到该模型时为 false（费用按 0 计入，需要人工补齐价格）。
          modelPriced: !!(pricing.models && pricing.models[billedModelKey(rec.model, rec.time, pricing)]),
          // 是否出现在官方清单里；清单为空（未同步/未配置 Key）时为 null。
          modelListed: modelCatalog.ids.length === 0
            ? null
            : modelCatalog.ids.some((x) => String(x).toLowerCase() === String(rec.model || '').trim().toLowerCase()),
          peak: isPeak(rec.time, pricing.peakWindows, pricing.weekendOffPeak),
          cost
        }
      }

      function emptyAgg() {
        return {
          calls: 0, inputMiss: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0,
          peakCalls: 0, offPeakCalls: 0, cost: 0, peakCost: 0, offPeakCost: 0
        }
      }

      function addAgg(agg, rec, cost) {
        agg.calls++
        agg.inputMiss += rec.inputTokens
        agg.cacheRead += rec.cacheReadTokens
        agg.cacheWrite += rec.cacheWriteTokens
        agg.output += rec.outputTokens
        agg.reasoning += rec.reasoningTokens
        agg.cost += cost
        if (rec.peak) { agg.peakCalls++; agg.peakCost += cost } else { agg.offPeakCalls++; agg.offPeakCost += cost }
      }

      function finalizeAgg(agg) {
        const totalInput = agg.inputMiss + agg.cacheRead
        return {
          ...agg,
          totalInput,
          hitRate: totalInput > 0 ? agg.cacheRead / totalInput : 0,
          cost: roundMoney(agg.cost),
          peakCost: roundMoney(agg.peakCost),
          offPeakCost: roundMoney(agg.offPeakCost)
        }
      }

      function roundMoney(n) {
        return Math.round(n * 10000) / 10000
      }

      /** Group records into per-session turn summaries (records must be enriched). */
      function buildTurns(recs) {
        const map = new Map()
        for (const rec of recs) {
          const key = rec.sessionId + '\u0000' + rec.turn
          let t = map.get(key)
          if (!t) {
            t = {
              sessionId: rec.sessionId,
              turn: rec.turn,
              startedAt: rec.time,
              endedAt: rec.time,
              steps: [],
              agg: emptyAgg()
            }
            map.set(key, t)
          }
          if (rec.time < t.startedAt) t.startedAt = rec.time
          if (rec.time > t.endedAt) t.endedAt = rec.time
          t.steps.push(rec.step)
          addAgg(t.agg, rec, rec.cost)
        }
        const turns = []
        for (const t of map.values()) {
          turns.push({
            sessionId: t.sessionId,
            turn: t.turn,
            startedAt: t.startedAt,
            endedAt: t.endedAt,
            startedText: bjDateTime(t.startedAt),
            endedText: bjDateTime(t.endedAt),
            stepCount: new Set(t.steps).size,
            ...finalizeAgg(t.agg)
          })
        }
        turns.sort((a, b) => b.startedAt - a.startedAt)
        return turns
      }

      function buildSessions(recs) {
        const map = new Map()
        for (const rec of recs) {
          const id = rec.sessionId || '(无会话)'
          let s = map.get(id)
          if (!s) { s = { sessionId: id, agg: emptyAgg(), turnCount: 0, firstTime: rec.time, lastTime: rec.time }; map.set(id, s) }
          if (rec.time < s.firstTime) s.firstTime = rec.time
          if (rec.time > s.lastTime) s.lastTime = rec.time
          addAgg(s.agg, rec, rec.cost)
        }
        const sessions = []
        for (const s of map.values()) {
          sessions.push({
            sessionId: s.sessionId,
            firstTime: s.firstTime,
            lastTime: s.lastTime,
            firstText: bjDateTime(s.firstTime),
            lastText: bjDateTime(s.lastTime),
            ...finalizeAgg(s.agg)
          })
        }
        sessions.sort((a, b) => b.lastTime - a.lastTime)
        return sessions
      }

      function buildDays(recs) {
        const map = new Map()
        for (const rec of recs) {
          const key = bjKey(rec.time)
          let d = map.get(key)
          if (!d) { d = { day: key, agg: emptyAgg() }; map.set(key, d) }
          addAgg(d.agg, rec, rec.cost)
        }
        const days = []
        for (const d of map.values()) days.push({ day: d.day, ...finalizeAgg(d.agg) })
        days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
        return days
      }

      // ── export ─────────────────────────────────────────────────────────────
      function csvCell(s) {
        s = String(s == null ? '' : s)
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
        return s
      }

      function buildCsv(recs) {
        const header = ['time', 'timeText', 'day', 'sessionId', 'turn', 'step', 'model', 'provider', 'purpose', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'finishReason', 'period', 'cost']
        const lines = [header.join(',')]
        for (const rec of recs) {
          lines.push([
            rec.time, rec.timeText, rec.day, rec.sessionId, rec.turn, rec.step, rec.model, rec.provider,
            rec.purpose, rec.inputTokens, rec.cacheReadTokens, rec.cacheWriteTokens,
            rec.outputTokens, rec.reasoningTokens, rec.finishReason,
            rec.peak ? 'peak' : 'offPeak', rec.cost
          ].map(csvCell).join(','))
        }
        return lines.join('\r\n')
      }

      async function writeTextFileViaNode(content, outPath) {
        const script = [
          'const fs=require("fs");',
          'let d="";',
          'process.stdin.on("data",function(c){d+=c});',
          'process.stdin.on("end",function(){',
          '  fs.mkdirSync(require("path").dirname(process.env.OUT_PATH),{recursive:true});',
          '  fs.writeFileSync(process.env.OUT_PATH, Buffer.from(d,"utf8"));',
          '  process.stdout.write(JSON.stringify({ok:true}));',
          '});'
        ].join('\n')
        const r = await spawnNode(script, content, { OUT_PATH: outPath })
        return r.ok ? { ok: true } : { ok: false, error: r.error }
      }

      const stamp = () => {
        const d = new Date()
        return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
          pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
      }

      // ── API ────────────────────────────────────────────────────────────────
      async function routeApi(body) {
        const action = body && body.action ? String(body.action) : ''
        try { await ensureInit() } catch {}
        switch (action) {
          case 'list': {
            const wantSession = body && body.sessionId ? String(body.sessionId) : ''
            const wantTurn = body && body.turn !== undefined && body.turn !== null ? Number(body.turn) : undefined
            const enriched = records.map(enrich)
            let scope = enriched
            if (wantSession) scope = scope.filter((r) => r.sessionId === wantSession)
            const turns = buildTurns(scope)
            const sessions = buildSessions(enriched)
            const totals = finalizeAgg(scope.reduce((agg, r) => { addAgg(agg, r, r.cost); return agg }, emptyAgg()))
            const workspaceTotals = finalizeAgg(enriched.reduce((agg, r) => { addAgg(agg, r, r.cost); return agg }, emptyAgg()))
            const days = buildDays(scope)
            let turnRecords = []
            if (wantSession && wantTurn !== undefined) {
              turnRecords = scope.filter((r) => r.sessionId === wantSession && r.turn === wantTurn).sort((a, b) => a.time - b.time)
            }
            return {
              ok: true,
              count: scope.length,
              records: turnRecords,
              turns,
              sessions,
              totals,
              workspaceTotals,
              days,
              sessionId: wantSession,
              dataPath,
              persistOk,
              persistError,
              pricing,
              modelCatalog: catalogView(),
              plugin: PLUGIN_NAME
            }
          }
          case 'syncModels': {
            const r = await syncModels(true)
            return {
              ok: r.ok !== false,
              modelCatalog: catalogView(),
              error: r.error || '',
              count: r.count || 0
            }
          }
          case 'balance': {
            const r = await queryBalance()
            if (r && r.ok && Number.isFinite(r.queriedAt) && Array.isArray(r.infos) && r.infos.length > 0) {
              const first = r.infos[0]
              if (first && first.totalBalance != null) {
                balanceHistory.push({
                  time: r.queriedAt,
                  totalBalance: String(first.totalBalance),
                  currency: String(first.currency || 'CNY')
                })
                trimBalanceHistory()
                persistBalanceNow()
              }
            }
            return { ...r, history: balanceHistory.slice(-5000) }
          }
          case 'clear': {
            const n = records.length
            records.length = 0
            persistNow()
            return { ok: true, cleared: n }
          }
          case 'setPrices': {
            const prices = body && body.prices
            if (!prices || typeof prices !== 'object') return { ok: false, error: '缺少价格数据' }
            let changed = false
            if (typeof prices.effectiveAt === 'string' && prices.effectiveAt) { pricing.effectiveAt = prices.effectiveAt; changed = true }
            if (typeof prices.weekendOffPeak === 'boolean') { pricing.weekendOffPeak = prices.weekendOffPeak; changed = true }
            if (Array.isArray(prices.peakWindows)) {
              const windows = normalizePeakWindows(prices.peakWindows)
              if (!windows) return { ok: false, error: '高峰时段不合法（需 0 ≤ 开始 < 结束 ≤ 1440 分钟）' }
              pricing.peakWindows = windows
              changed = true
            }
            const route = prices.proRoute
            if (route && typeof route === 'object') {
              if (typeof route.at === 'string' && route.at) { pricing.proRoute.at = route.at; changed = true }
              if (typeof route.to === 'string' && route.to) { pricing.proRoute.to = route.to; changed = true }
            }
            const src = prices.models
            if (src && typeof src === 'object') {
              if (prices.replaceModels === true) {
                // 整表替换：设置页“模型与价格”编辑器一次提交完整模型表（支持增删改）。
                const table = normalizeModelTable(src)
                if (!table) return { ok: false, error: '至少需要一个模型，且价格必须为非负数字' }
                pricing.models = table
                changed = true
              } else {
                // 兼容旧的局部更新：新增未知模型键，更新已有模型的三档价与显示名。
                for (const mk of Object.keys(src)) {
                  const row = src[mk]
                  if (!row || typeof row !== 'object') continue
                  if (!pricing.models[mk]) { pricing.models[mk] = normalizeModelRates(row); changed = true; continue }
                  if (typeof row.label === 'string' && row.label) { pricing.models[mk].label = row.label; changed = true }
                  for (const period of ['peak', 'offPeak']) {
                    const rates = row[period]
                    const dst = pricing.models[mk][period]
                    if (!rates || typeof rates !== 'object' || !dst) continue
                    for (const k of ['cacheHit', 'cacheMiss', 'output']) {
                      const v = Number(rates[k])
                      if (Number.isFinite(v) && v >= 0) { dst[k] = v; changed = true }
                    }
                  }
                }
              }
            }
            if (!changed) return { ok: false, error: '没有可用的价格更新（价格必须是非负数字）' }
            persistPricing()
            return { ok: true, pricing }
          }
          case 'resetPrices': {
            pricing = clonePricing()
            persistPricing()
            return { ok: true, pricing }
          }
          case 'export': {
            if (!root) return { ok: false, error: '未找到工作区路径，无法导出' }
            const kind = (body && body.kind) === 'json' ? 'json' : 'csv'
            const enriched = records.map(enrich)
            const name = 'dsh-cost-' + stamp() + (kind === 'json' ? '.json' : '.csv')
            if (kind === 'json') {
              const content = JSON.stringify({ exportedAt: Date.now(), plugin: PLUGIN_NAME, pricing, records: enriched }, null, 2)
              const r = await writeTextFileViaNode(content, joinPath(dirs().data, name))
              return r.ok ? { ok: true, name, dir: dirs().data, path: joinPath(dirs().data, name) } : r
            }
            const r = await writeTextFileViaNode(buildCsv(enriched), joinPath(dirs().data, name))
            return r.ok ? { ok: true, name, dir: dirs().data, path: joinPath(dirs().data, name) } : r
          }
          default:
            return { ok: false, error: '未知操作：' + action }
        }
      }

      function readBody(req) {
        return new Promise((resolve) => {
          let d = ''
          req.on('data', (c) => { d += c })
          req.on('end', () => { try { resolve(JSON.parse(d)) } catch { resolve({}) } })
          req.on('error', () => resolve({}))
        })
      }

      function sendJson(res, obj) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(obj))
      }

      if (webServer && typeof webServer.register === 'function') {
        try {
          webServer.register({
            kind: 'exact',
            path: API_PATH,
            handler: async (req, res) => {
              try {
                const body = await readBody(req)
                sendJson(res, await routeApi(body))
              } catch (e) {
                sendJson(res, { ok: false, error: msg(e) })
              }
            }
          })
          push('route-registered: ' + API_PATH)
        } catch (e) {
          push('route-register-threw: ' + (e && e.stack ? e.stack : msg(e)))
        }
      } else {
        push('route-not-registered (no webServer)')
      }

      // 启动后后台同步一次官方模型清单（最佳努力：失败只记录，不影响插件功能）。
      try { ensureInit().then(() => syncModels(false)).catch(() => {}) } catch {}

      push('apply-end')
      diag.ok = true
    } catch (e) {
      diag.ok = false
      diag.error = (e && e.stack) ? e.stack : String(e)
    }
    flushDiag()
  }
}


