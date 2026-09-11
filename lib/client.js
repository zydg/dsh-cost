/**
 * dsh-cost — WEB CLIENT half (per-round footer line + i18n settings).
 *
 * Registers a "cost-summary" chat node via the conversationEvents
 * projection system, rendered as ONE text line at the end of every
 * completed conversation round (turn):
 *
 *   ⚡ 本轮 #N · 输入 … · 缓存命中 … · 输出 … · 命中率 … · 时段 … · 预估 ¥… · 余额 ¥…
 *   ⚡ Round #N · Input … · Cache hit … · Output … · Hit rate … · Period … · Est. $… · Balance $…
 *
 * A settings.section entry lets users switch the display language
 * (中文 / English) and the price unit (CNY ¥ / USD $, with a configurable
 * exchange rate). Settings persist in localStorage and footer lines follow
 * immediately. Token/cache numbers aggregate from the live session event
 * stream (assistant/chunk usage + assistant/message), so they replay for
 * historical turns; costs price each call by its own timestamp against the
 * official DeepSeek 峰谷 price table; the balance comes from the host API.
 */
window.__ModuleLoader__.load({
  id: "dsh-cost",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var el = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

    // ── official price table fallback (host pricing.json wins when present) ──
    var DEFAULT_PRICING = {
      effectiveAt: "2026-09-10T12:00:00+08:00",
      weekendOffPeak: true,
      peakWindows: [
        { start: 9 * 60, end: 12 * 60 },
        { start: 14 * 60, end: 18 * 60 }
      ],
      // V4 Pro 有序下线：北京时间 2026-09-14 12:00 起路由到 V4.1 Flash 并按 Flash 单价计费。
      proRoute: {
        at: "2026-09-14T12:00:00+08:00",
        to: "deepseek-flash"
      },
      models: {
        "deepseek-flash": {
          offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
          peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 }
        },
        "deepseek-v4-pro": {
          offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
          peak: { cacheHit: 0.30, cacheMiss: 9.0, output: 27.0 }
        }
      }
    };

    // ── i18n dictionaries ───────────────────────────────────────────────────
    var I18N = {
      zh: {
        round: "本轮 #",
        input: "输入",
        cacheHit: "缓存命中",
        output: "输出",
        hitRate: "命中率",
        period: "时段",
        peak: "高峰",
        offPeak: "空闲",
        mixed: "高峰+空闲",
        estimate: "预估",
        unpriced: "价格未收录（按 ¥0 估算）",
        balance: "余额",
        currentBalance: "当前余额",
        settingsTitle: "dsh-cost 设置",
        langLabel: "显示语言",
        langZh: "中文",
        langEn: "English",
        unitLabel: "价格单位",
        unitCny: "CNY ¥",
        unitUsd: "USD $",
        rateLabel: "美元汇率（1 CNY = ? USD）",
        rateHint: "用于把人民币金额换算为美元展示，仅为估算参考。",
        alertThresholdLabel: "余额告警阈值",
        alertHint: "余额低于该阈值时，当前余额显示为红色（切换价格单位后阈值自动换算）。",
        updatedAt: "更新于",
        saved: "设置保存在本机浏览器，统计行立即生效。",
        modelCatalogLabel: "官方模型清单（自动同步）",
        modelSyncNow: "立即同步",
        modelSyncing: "同步中…",
        modelSyncedAt: "上次同步",
        modelNeverSynced: "尚未同步",
        modelCountSuffix: " 个模型",
        modelListHint: "模型名来自官方 GET /models：插件在启动时自动同步，遇到清单外的新模型名也会再同步一次；价格不在该接口里，仍以本地价格表为准（data.json 的 pricing 或 setPrices）。"
      },
      en: {
        round: "Round #",
        input: "Input",
        cacheHit: "Cache hit",
        output: "Output",
        hitRate: "Hit rate",
        period: "Period",
        peak: "Peak",
        offPeak: "Off-peak",
        mixed: "Peak+off-peak",
        estimate: "Est.",
        unpriced: "Price not in table (counted as 0)",
        balance: "Balance",
        currentBalance: "Current balance",
        settingsTitle: "dsh-cost settings",
        langLabel: "Display language",
        langZh: "中文",
        langEn: "English",
        unitLabel: "Price unit",
        unitCny: "CNY ¥",
        unitUsd: "USD $",
        rateLabel: "USD rate (1 CNY = ? USD)",
        rateHint: "Used to display CNY amounts in USD; approximate.",
        alertThresholdLabel: "Balance alert threshold",
        alertHint: "Shown in red when the balance drops below this value (converts automatically when the price unit changes).",
        updatedAt: "updated",
        saved: "Settings are stored locally in this browser and apply to footer lines immediately.",
        modelCatalogLabel: "Official model list (auto-sync)",
        modelSyncNow: "Sync now",
        modelSyncing: "Syncing…",
        modelSyncedAt: "Last sync",
        modelNeverSynced: "Not synced yet",
        modelCountSuffix: " models",
        modelListHint: "Model names come from the official GET /models endpoint: synced at boot, and again when a model outside the list shows up. Prices are not part of that endpoint — the local price table still governs (pricing in data.json or setPrices)."
      }
    };

    // ── settings store (localStorage + listeners) ───────────────────────────
    var SETTINGS_KEY = "dsh-cost.settings.v1";
    var DEFAULT_SETTINGS = { lang: "zh", unit: "CNY", usdRate: 0.14, alertThreshold: 10 };
    var settingsListeners = [];

    function loadSettings() {
      var base = { lang: "zh", unit: "CNY", usdRate: 0.14, alertThreshold: 10 };
      try {
        var raw = window.localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p.lang === "en" || p.lang === "zh") base.lang = p.lang;
          if (p.unit === "USD" || p.unit === "CNY") base.unit = p.unit;
          var r = Number(p.usdRate);
          if (Number.isFinite(r) && r > 0) base.usdRate = r;
          var th = Number(p.alertThreshold);
          if (Number.isFinite(th) && th >= 0) base.alertThreshold = th;
        }
      } catch (e) {}
      return base;
    }

    var currentSettings = loadSettings();

    function saveSettings(next) {
      currentSettings = next;
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (e) {}
      for (var i = 0; i < settingsListeners.length; i++) {
        try { settingsListeners[i](next); } catch (e) {}
      }
    }

    function subscribeSettings(fn) {
      settingsListeners.push(fn);
      return function () {
        var i = settingsListeners.indexOf(fn);
        if (i >= 0) settingsListeners.splice(i, 1);
      };
    }

    function api(payload) {
      return fetch("/dsh-cost/api", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); });
    }

    // ── module-level caches (one fetch per app load, balance refreshes) ──────
    var pricingPromise = null;

    // 官方模型清单（宿主自动同步 GET /models 的结果）：设置面板展示 + 状态广播。
    var catalogState = { ids: [], fetchedAt: 0, error: "", syncing: false };
    var catalogListeners = [];

    function subscribeCatalog(fn) {
      catalogListeners.push(fn);
      return function () {
        var i = catalogListeners.indexOf(fn);
        if (i >= 0) catalogListeners.splice(i, 1);
      };
    }

    function setCatalog(next) {
      catalogState = {
        ids: Array.isArray(next && next.ids) ? next.ids : [],
        fetchedAt: Number(next && next.fetchedAt) || 0,
        error: String((next && next.error) || ""),
        syncing: !!(next && next.syncing)
      };
      for (var i = 0; i < catalogListeners.length; i++) {
        try { catalogListeners[i](catalogState); } catch (e) {}
      }
      return catalogState;
    }

    function getPricing() {
      if (!pricingPromise) {
        pricingPromise = api({ action: "list" }).then(function (res) {
          if (res && res.modelCatalog) setCatalog(res.modelCatalog);
          return res && res.ok && res.pricing ? res.pricing : DEFAULT_PRICING;
        }).catch(function () { return DEFAULT_PRICING; });
      }
      return pricingPromise;
    }

    // 手动同步：宿主立即 GET /models（不受 24h TTL 约束）。
    function syncCatalog() {
      if (catalogState.syncing) return Promise.resolve(catalogState);
      setCatalog({ ids: catalogState.ids, fetchedAt: catalogState.fetchedAt, error: "", syncing: true });
      return api({ action: "syncModels" }).then(function (res) {
        var next = (res && res.modelCatalog) || {};
        return setCatalog({
          ids: next.ids || [],
          fetchedAt: next.fetchedAt || 0,
          error: res && res.ok === false ? String(res.error || "同步失败") : String(next.error || ""),
          syncing: false
        });
      }).catch(function (e) {
        return setCatalog({
          ids: catalogState.ids,
          fetchedAt: catalogState.fetchedAt,
          error: String((e && e.message) || e),
          syncing: false
        });
      });
    }

    // Balance is re-queried every time a cost-summary row mounts — i.e. once
    // per completed turn — so the footer's balance is never older than the
    // last round (no fixed 5-minute refresh interval anymore). Concurrent
    // mounts (e.g. replaying a long history) share a single in-flight query;
    // once it settles, the next row mount queries again.
    var balanceCache = { promise: null, value: null, error: "", inflight: false };
    function queryBalance() {
      if (balanceCache.inflight) return balanceCache.promise;
      balanceCache.inflight = true;
      balanceCache.promise = api({ action: "balance" }).then(function (res) {
        balanceCache.inflight = false;
        if (res && res.ok) { balanceCache.value = res; balanceCache.error = ""; notifyBalance(res); }
        else { balanceCache.value = null; balanceCache.error = (res && res.error) || "查询失败"; }
        return balanceCache;
      }).catch(function (e) {
        balanceCache.inflight = false;
        balanceCache.value = null;
        balanceCache.error = String((e && e.message) || e);
        return balanceCache;
      });
      return balanceCache.promise;
    }

    // ── balance broadcast: every successful query updates the input-box bar ──
    var balanceListeners = [];
    var balanceState = { time: 0, totalBalance: "", currency: "CNY" };
    function notifyBalance(res) {
      try {
        var first = res && res.infos && res.infos.length ? res.infos[0] : null;
        balanceState = {
          time: Date.now(),
          totalBalance: String(first && first.totalBalance != null ? first.totalBalance : ""),
          currency: String((first && first.currency) || "CNY")
        };
      } catch (e) {
        balanceState = { time: 0, totalBalance: "", currency: "CNY" };
      }
      for (var i = 0; i < balanceListeners.length; i++) {
        try { balanceListeners[i](balanceState); } catch (e) {}
      }
    }
    function subscribeBalance(fn) {
      balanceListeners.push(fn);
      return function () {
        var i = balanceListeners.indexOf(fn);
        if (i >= 0) balanceListeners.splice(i, 1);
      };
    }

    // ── alert threshold helpers (stored in CNY, displayed/edited in current unit) ──
    function safeRate(settings) {
      var r = Number(settings && settings.usdRate);
      return Number.isFinite(r) && r > 0 ? r : 0.14;
    }
    /** 当前价格单位下应显示的阈值数值（USD = CNY × 汇率）。 */
    function thresholdForDisplay(settings) {
      var base = Number(settings && settings.alertThreshold);
      if (!Number.isFinite(base) || base < 0) base = 10;
      return settings && settings.unit === "USD" ? base * safeRate(settings) : base;
    }
    /** 把用户在设置页输入的阈值数值换算回 CNY 基准存储。 */
    function thresholdFromInput(value, settings) {
      var v = Number(value);
      if (!Number.isFinite(v) || v < 0) v = 0;
      return settings && settings.unit === "USD" ? v / safeRate(settings) : v;
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    var fmtInt = function (n) {
      var s = String(Math.round(Number(n) || 0));
      var out = "";
      var count = 0;
      for (var i = s.length - 1; i >= 0; i--) {
        out = s[i] + out;
        count++;
        if (count % 3 === 0 && i > 0) out = "," + out;
      }
      return out;
    };
    var fmtMoneyValue = function (n) {
      var v = Number(n) || 0;
      if (v === 0) return "0";
      if (v < 0.0001) return v.toExponential(2);
      if (v < 1) return v.toFixed(4);
      return v.toFixed(3);
    };
    function fmtCost(cny, settings) {
      var s = settings || currentSettings;
      if (s.unit === "USD") return "$" + fmtMoneyValue(Number(cny) * s.usdRate);
      return "¥" + fmtMoneyValue(cny);
    }

    // 官方模型名 → 计价桶（与宿主 lib/index.js 的 MODEL_ALIASES 保持一致）：
    // deepseek-v4-flash / -vision-exp 为已下线旧名，请求由 V4.1 Flash 承接；
    // deepseek-chat / deepseek-reasoner 于 2026-07-24 停用，迁移到 V4 Flash / Pro。
    var MODEL_ALIASES = {
      "deepseek-flash": "deepseek-flash",
      "deepseek-v4-flash": "deepseek-flash",
      "deepseek-v4-flash-vision-exp": "deepseek-flash",
      "deepseek-chat": "deepseek-flash",
      "deepseek-reasoner": "deepseek-v4-pro",
      "deepseek-v4-pro": "deepseek-v4-pro"
    };

    function modelKey(model) {
      var m = String(model || "").trim().toLowerCase();
      if (!m) return "unknown";
      if (MODEL_ALIASES[m]) return MODEL_ALIASES[m];
      if (m.indexOf("pro") >= 0) return "deepseek-v4-pro";
      if (m.indexOf("flash") >= 0) return "deepseek-flash";
      return "unknown";
    }

    // V4 Pro 自 2026-09-14 12:00（北京时间）起路由到 V4.1 Flash，按 Flash 单价计费。
    function billedModelKey(model, time, pricing) {
      var mk = modelKey(model);
      var route = pricing && pricing.proRoute;
      if (mk === "deepseek-v4-pro" && route && route.at && route.to) {
        var at = Date.parse(route.at);
        if (!isNaN(at) && Number(time) >= at) return route.to;
      }
      return mk;
    }

    function isPeak(ts, peakWindows, weekendOffPeak) {
      var windows = peakWindows && peakWindows.length ? peakWindows : DEFAULT_PRICING.peakWindows;
      var d = new Date(Number(ts) + 8 * 3600 * 1000);
      var day = d.getUTCDay();
      // 自 2026-08-23 起，周六/周日全天按低谷价计费（weekendOffPeak 默认开启）。
      if (weekendOffPeak !== false && (day === 0 || day === 6)) return false;
      var t = d.getUTCHours() * 60 + d.getUTCMinutes();
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (t >= w.start && t < w.end) return true;
      }
      return false;
    }

    function costFor(call, pricing) {
      var p = pricing && pricing.models ? pricing : DEFAULT_PRICING;
      var mk = billedModelKey(call && call.model, call && call.time, p);
      var row = p.models && p.models[mk];
      if (!row) return 0;
      var u = (call && call.usage) || {};
      var rates = isPeak(call && call.time, p.peakWindows, p.weekendOffPeak) ? row.peak : row.offPeak;
      return ((u.cacheReadTokens || 0) * rates.cacheHit +
              (u.inputTokens || 0) * rates.cacheMiss +
              (u.outputTokens || 0) * rates.output) / 1e6;
    }

    function addUsage(current, next) {
      var c = current || {};
      var n = next || {};
      return {
        inputTokens: (c.inputTokens || 0) + (n.inputTokens || 0),
        outputTokens: (c.outputTokens || 0) + (n.outputTokens || 0),
        cacheReadTokens: (c.cacheReadTokens || 0) + (n.cacheReadTokens || 0),
        cacheWriteTokens: (c.cacheWriteTokens || 0) + (n.cacheWriteTokens || 0),
        reasoningTokens: (c.reasoningTokens || 0) + (n.reasoningTokens || 0)
      };
    }

    function turnCoordinates(event) {
      if (event.type === "step/start" || event.type === "assistant/chunk" ||
          event.type === "assistant/message" || event.type === "step/end") {
        return { turn: event.data.turn, step: event.data.step };
      }
      return undefined;
    }

    function chatNode(context, kind, anchorSeq, data) {
      return {
        key: context.key,
        kind: kind,
        id: context.id,
        target: "chat",
        anchorSeq: anchorSeq,
        location: context.start ? context.start.location : (context.matches[0] ? context.matches[0].location : { kind: "unresolved" }),
        visibility: "visible",
        data: data
      };
    }

    // ── balance history helpers ─────────────────────────────────────────────
    // Latest snapshot at or before ts (history ascending by time).
    function balanceAt(history, ts) {
      if (!Array.isArray(history) || history.length === 0 || !(ts > 0)) return undefined;
      var best = null;
      for (var i = 0; i < history.length; i++) {
        var h = history[i];
        if (!h || !(Number(h.time) > 0)) continue;
        if (Number(h.time) > ts) break;
        best = h;
      }
      return best;
    }
    // FIRST snapshot strictly after ts. A completed round's own balance query
    // runs right after its turn/end, so this is the balance taken at that
    // round's end — the round's "real-time" balance. Live rounds therefore
    // show the query this row just fired, and replayed rounds show the
    // snapshot taken by the query that followed that round.
    function balanceAfter(history, ts) {
      if (!Array.isArray(history) || history.length === 0 || !(ts > 0)) return undefined;
      for (var i = 0; i < history.length; i++) {
        var h = history[i];
        if (!h || !(Number(h.time) > 0)) continue;
        if (Number(h.time) > ts) return h;
      }
      return undefined;
    }

    // ── projection: one cost-summary node per completed turn ────────────────
    var costSummaryDefinition = {
      kind: "cost-summary",
      target: "chat",
      match: function (event) {
        if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
        var c = turnCoordinates(event);
        if (c !== undefined) return { id: String(c.turn), role: "update" };
        if (event.type === "turn/end") return { id: String(event.data.turn), role: "update" };
        return null;
      },
      start: function (_context, match) {
        if (match.event.type !== "turn/start") throw new Error("cost-summary start requires turn/start");
        return { turn: match.event.data.turn, steps: {}, endedAt: undefined };
      },
      update: function (context, match) {
        var state = context.state;
        if (!state) return state;
        var event = match.event;
        var step, prev, model;
        if (event.type === "turn/end") return { ...state, endedAt: event.time };
        if (event.type === "step/start") {
          step = event.data.step;
          prev = state.steps[step];
          return {
            ...state,
            steps: { ...state.steps, [step]: prev || { model: "", time: event.time, usage: null } }
          };
        }
        if (event.type === "assistant/chunk" && event.data.chunk.type === "usage") {
          step = event.data.step;
          prev = state.steps[step] || { model: "", time: event.time, usage: null };
          return {
            ...state,
            steps: {
              ...state.steps,
              [step]: { model: prev.model, time: event.time, usage: addUsage(prev.usage, event.data.chunk.usage) }
            }
          };
        }
        if (event.type === "assistant/message") {
          step = event.data.step;
          prev = state.steps[step] || { model: "", time: event.time, usage: null };
          model = "";
          try { model = String((event.data.message && event.data.message.source && event.data.message.source.model) || ""); } catch (e) {}
          return {
            ...state,
            steps: {
              ...state.steps,
              [step]: { model: model, time: event.time, usage: prev.usage || event.data.usage || null }
            }
          };
        }
        return state;
      },
      publication: function (match) {
        return match.event.type === "turn/end" ? "immediate" : "none";
      },
      buildViewNode: function (context) {
        var state = context.state;
        if (!state || !state.steps) return null;
        var calls = [];
        for (var k in state.steps) {
          var s = state.steps[k];
          if (s && s.usage) calls.push({ time: s.time, model: s.model || "", usage: s.usage });
        }
        if (calls.length === 0) return null;
        var anchor = 0;
        for (var i = 0; i < context.matches.length; i++) {
          if (context.matches[i].event.type === "turn/end") anchor = context.matches[i].event.seq;
        }
        if (!anchor && context.start) anchor = context.start.event.seq;
        return chatNode(context, "cost-summary", anchor + 0.15, { turn: state.turn, endedAt: state.endedAt, calls: calls });
      }
    };

    // ── renderer: the one-line footer ───────────────────────────────────────
    var st = {
      line: {
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        fontSize: 11.5,
        lineHeight: "20px",
        color: "inherit",
        opacity: 0.62,
        padding: "2px 4px",
        marginTop: 1,
        userSelect: "text"
      },
      dot: { flex: "none", fontSize: 11 }
    };

    function CostSummaryRow(props) {
      var node = props.node;
      var data = node && node.data;
      var [pricing, setPricing] = useState(null);
      var [bal, setBal] = useState(null);
      var [settings, setSettings] = useState(currentSettings);

      useEffect(function () {
        return subscribeSettings(function (s) { setSettings(s); });
      }, []);

      useEffect(function () {
        var alive = true;
        getPricing().then(function (p) { if (alive) setPricing(p); });
        // Fresh balance query on every row mount (= every completed turn).
        queryBalance().then(function (b) { if (alive) setBal(b); });
        return function () { alive = false; };
      }, []);

      if (!data || !data.calls || data.calls.length === 0) return null;

      var t = I18N[settings.lang] || I18N.zh;
      var totals = { inputMiss: 0, cacheRead: 0, cacheWrite: 0, output: 0, peak: 0, offPeak: 0, cost: 0, unpriced: false };
      var p = pricing || DEFAULT_PRICING;
      for (var i = 0; i < data.calls.length; i++) {
        var call = data.calls[i];
        var u = call.usage || {};
        totals.inputMiss += u.inputTokens || 0;
        totals.cacheRead += u.cacheReadTokens || 0;
        totals.cacheWrite += u.cacheWriteTokens || 0;
        totals.output += u.outputTokens || 0;
        totals.cost += costFor(call, p);
        // 价格表里没有这个模型名（官方上新、价格未跟）→ 本轮标注「价格未收录」，
        // 而不是让这一轮的 ¥0 看起来像真的免费。
        if (!p.models || !p.models[billedModelKey(call.model, call.time, p)]) totals.unpriced = true;
        if (isPeak(call.time, p.peakWindows, p.weekendOffPeak)) totals.peak++; else totals.offPeak++;
      }

      var totalInput = totals.inputMiss + totals.cacheRead;
      var hitPct = totalInput > 0 ? (totals.cacheRead / totalInput * 100).toFixed(1) + "%" : "—";
      var period = totals.peak > 0 && totals.offPeak > 0 ? t.mixed : (totals.peak > 0 ? t.peak : t.offPeak);
      var parts = [
        t.input + " " + fmtInt(totals.inputMiss),
        t.cacheHit + " " + fmtInt(totals.cacheRead),
        t.output + " " + fmtInt(totals.output),
        t.hitRate + " " + hitPct,
        t.period + " " + period,
        t.estimate + " " + fmtCost(totals.cost, settings)
      ];
      if (totals.unpriced) parts.push("⚠ " + t.unpriced);
      var hist = (bal && bal.value && bal.value.history) || [];
      // 该轮结束后的第一次查询快照 = 该轮结束时实时查到的余额（最新一轮即本次查询）
      var balAt = balanceAfter(hist, data.endedAt) || balanceAt(hist, data.endedAt);
      var b0 = balAt || (bal && bal.value && bal.value.infos && bal.value.infos.length ? bal.value.infos[0] : null);
      if (b0) {
        parts.push(t.balance + " " + fmtCost(b0.totalBalance, settings));
      }

      return el("div", { style: st.line, "data-cost-summary": "true", "data-turn": data.turn },
        el("span", { style: st.dot }, "⚡"),
        el("span", null, t.round + data.turn + " · " + parts.join(" · "))
      );
    }

    // ── input-box balance bar: live balance + query timestamp + low-balance warning ──
    var stBar = {
      // 单行文本（不用 flex，避免子元素被换行），width:100% 独占一行
      root: { textAlign: "center", width: "100%", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontSize: 11.5, lineHeight: "18px", padding: "1px 4px 3px", color: "inherit", opacity: 0.72, userSelect: "text" },
      warn: { color: "rgb(232, 84, 84)", opacity: 1, fontWeight: 600 }
    };

    function BalanceBar(props) {
      var [bal, setBal] = useState(balanceState);
      var [settings, setSettings] = useState(currentSettings);

      useEffect(function () {
        return subscribeSettings(function (s) { setSettings(s); });
      }, []);

      useEffect(function () {
        var alive = true;
        // 挂载时立即查一次；之后每次余额查询成功自动更新（每轮结束都会查询）
        queryBalance().then(function () { if (alive && balanceState.time) setBal(balanceState); });
        return subscribeBalance(function (v) { if (alive) setBal(v); });
      }, []);

      // 插槽容器默认不换行（统计行与余额条并排）。向上遍历祖先 DOM，
      // 把这条链路上的 flex 容器都设为允许换行，余额条（width:100%）即可换到统计行下一行。
      var barRef = React.useRef(null);
      useEffect(function () {
        var n = barRef.current;
        for (var i = 0; i < 4 && n; i++) {
          n = n.parentElement;
          if (n && n.style) { try { n.style.flexWrap = "wrap"; } catch (e) {} }
        }
      }, []);

      if (!bal || !bal.time || !bal.totalBalance) return null;
      var t = I18N[settings.lang] || I18N.zh;
      var cny = Number(bal.totalBalance);
      var threshold = Number(settings.alertThreshold);
      var low = Number.isFinite(cny) && threshold > 0 && cny < threshold;
      var d = new Date(bal.time);
      var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
      var timeStr = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
      var style = low ? Object.assign({}, stBar.root, stBar.warn) : stBar.root;
      return el("div", { ref: barRef, style: style, "data-balance-bar": "true" },
        el("span", null, "⚡ " + t.currentBalance + " " + fmtCost(cny, settings) + " · " + t.updatedAt + " " + timeStr)
      );
    }

    // ── settings panel (language + price unit + USD rate) ───────────────────
    var stSet = {
      root: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 0", width: "100%", maxWidth: 680, boxSizing: "border-box" },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
      label: { fontSize: 13, fontWeight: 500 },
      seg: { display: "inline-flex", border: "1px solid rgba(128,128,128,.35)", borderRadius: 6, overflow: "hidden" },
      segBtn: { border: 0, background: "transparent", padding: "6px 14px", fontSize: 12, cursor: "pointer", color: "inherit" },
      segOn: { border: 0, background: "rgba(90,140,255,.22)", padding: "6px 14px", fontSize: 12, cursor: "pointer", color: "inherit", fontWeight: 600 },
      input: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "5px 10px", fontSize: 12, color: "inherit", width: 90, textAlign: "right" },
      note: { fontSize: 11, opacity: 0.55 },
      btn: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "5px 12px", fontSize: 12, cursor: "pointer", color: "inherit" },
      btnBusy: { opacity: 0.6, cursor: "default" },
      catalog: { fontSize: 11, opacity: 0.72, lineHeight: "17px", maxHeight: 96, overflowY: "auto", wordBreak: "break-all" }
    };

    // 模型清单状态行：上次同步时间 + 模型数量（出错时附带错误信息）。
    function catalogStatusText(catalog, t) {
      var text;
      if (catalog.fetchedAt > 0) {
        var d = new Date(catalog.fetchedAt);
        var pad2 = function (n) { return (n < 10 ? "0" : "") + n; };
        text = t.modelSyncedAt + " " + (d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
          pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " · " + catalog.ids.length + t.modelCountSuffix;
      } else {
        text = t.modelNeverSynced;
      }
      if (catalog.error) text += " · " + catalog.error;
      return text;
    }

    function SettingsPanel() {
      var [settings, setSettings] = useState(currentSettings);
      var [catalog, setCatalogState] = useState(catalogState);
      useEffect(function () {
        return subscribeSettings(function (s) { setSettings(s); });
      }, []);
      useEffect(function () {
        // 打开设置面板即拉一次（走缓存）：宿主已同步过就立刻显示结果。
        getPricing();
        return subscribeCatalog(function (c) { setCatalogState(c); });
      }, []);
      var t = I18N[settings.lang] || I18N.zh;

      function update(patch) {
        saveSettings(Object.assign({}, currentSettings, patch));
      }

      function Seg(props) {
        return el("div", { style: stSet.seg }, props.options.map(function (opt) {
          var on = opt.value === props.value;
          return el("button", {
            key: opt.value,
            type: "button",
            style: on ? stSet.segOn : stSet.segBtn,
            onClick: function () { props.onChange(opt.value); }
          }, opt.label);
        }));
      }

      var note = settings.unit === "USD" ? t.rateHint + " " + t.saved : t.saved;

      return el("div", { style: stSet.root },
        el("div", { style: stSet.row },
          el("span", { style: stSet.label }, t.langLabel),
          el(Seg, {
            value: settings.lang,
            options: [
              { value: "zh", label: t.langZh },
              { value: "en", label: t.langEn }
            ],
            onChange: function (v) { update({ lang: v }); }
          })
        ),
        el("div", { style: stSet.row },
          el("span", { style: stSet.label }, t.unitLabel),
          el(Seg, {
            value: settings.unit,
            options: [
              { value: "CNY", label: t.unitCny },
              { value: "USD", label: t.unitUsd }
            ],
            onChange: function (v) { update({ unit: v }); }
          })
        ),
        settings.unit === "USD"
          ? el("div", { style: stSet.row },
              el("span", { style: stSet.label }, t.rateLabel),
              el("input", {
                type: "number",
                min: "0.0001",
                step: "0.0001",
                style: stSet.input,
                value: String(settings.usdRate),
                onChange: function (e) {
                  var v = Number(e.target.value);
                  if (Number.isFinite(v) && v > 0) update({ usdRate: v });
                }
              })
            )
          : null,
        el("div", { style: stSet.row },
          el("span", { style: stSet.label }, t.alertThresholdLabel + (settings.unit === "USD" ? "（$）" : "（¥）")),
          el("input", {
            type: "number",
            min: "0",
            step: "0.5",
            style: stSet.input,
            value: String(thresholdForDisplay(settings)),
            onChange: function (e) {
              var v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0) update({ alertThreshold: thresholdFromInput(v, settings) });
            }
          })
        ),
        el("div", { style: stSet.note }, t.alertHint + " " + t.saved),
        el("div", { style: stSet.row },
          el("span", { style: stSet.label }, t.modelCatalogLabel),
          el("button", {
            type: "button",
            style: catalog.syncing ? Object.assign({}, stSet.btn, stSet.btnBusy) : stSet.btn,
            disabled: catalog.syncing,
            onClick: function () { syncCatalog(); }
          }, catalog.syncing ? t.modelSyncing : t.modelSyncNow)
        ),
        el("div", { style: stSet.note }, catalogStatusText(catalog, t)),
        catalog.ids.length > 0
          ? el("div", { style: stSet.catalog }, catalog.ids.join(" · "))
          : null,
        el("div", { style: stSet.note }, t.modelListHint)
      );
    }

    // ── plugin ──
    var inject = ["slots", "conversationEvents"];

    // 样式表注入（!important 不会被 React 重渲染覆盖）：
    // 插槽容器默认 flex 不换行，余额条（width:100%）可能被并排压缩。
    // 用一二级 :has() 命中余额条外层 wrapper 和插槽容器，强制换行独占一行。
    // 切勿加更高级 :has，否则会命中页面级祖先、打乱聊天区布局。
    if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="dsh-cost-slot-wrap-v2"]')) {
      var wrapTag = document.createElement("style");
      wrapTag.dataset.pluginCss = "dsh-cost-slot-wrap-v2";
      wrapTag.textContent = [
        ":has(> [data-balance-bar]) { flex-wrap: wrap !important; }",
        ":has(> * > [data-balance-bar]) { flex-wrap: wrap !important; }"
      ].join("\n");
      document.head.appendChild(wrapTag);
    }

    function apply(ctx) {
      var slots = ctx.get("slots");
      var conversationEvents = ctx.get("conversationEvents");
      if (slots === undefined || conversationEvents === undefined) return;
      try { conversationEvents.register(costSummaryDefinition); } catch (e) {}
      slots.inject("conversation.chat.node", function () {
        return slots.register({
          name: "conversation.chat.node",
          key: "cost-summary",
          order: 5
        }, CostSummaryRow);
      });
      slots.inject("conversation.input.dock", function () {
        // 显示在输入框上方（order 30，排在内置 queue 条之后）
        return slots.register({
          name: "conversation.input.dock",
          id: "dsh-cost-balance",
          order: 30
        }, BalanceBar);
      });
      slots.inject("settings.section", function () {
        return slots.register({
          name: "settings.section",
          id: "dsh-cost",
          order: 30,
          label: function () { return I18N[currentSettings.lang].settingsTitle; }
        }, SettingsPanel);
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});