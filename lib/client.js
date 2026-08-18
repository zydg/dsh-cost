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
      effectiveAt: "2026-08-17T00:00:00+08:00",
      peakWindows: [
        { start: 9 * 60, end: 12 * 60 },
        { start: 14 * 60, end: 18 * 60 }
      ],
      models: {
        "deepseek-v4-flash": {
          offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
          peak: { cacheHit: 0.10, cacheMiss: 3.0, output: 9.0 }
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
        balance: "余额",
        settingsTitle: "dsh-cost 设置",
        langLabel: "显示语言",
        langZh: "中文",
        langEn: "English",
        unitLabel: "价格单位",
        unitCny: "CNY ¥",
        unitUsd: "USD $",
        rateLabel: "美元汇率（1 CNY = ? USD）",
        rateHint: "用于把人民币金额换算为美元展示，仅为估算参考。",
        saved: "设置保存在本机浏览器，统计行立即生效。"
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
        balance: "Balance",
        settingsTitle: "dsh-cost settings",
        langLabel: "Display language",
        langZh: "中文",
        langEn: "English",
        unitLabel: "Price unit",
        unitCny: "CNY ¥",
        unitUsd: "USD $",
        rateLabel: "USD rate (1 CNY = ? USD)",
        rateHint: "Used to display CNY amounts in USD; approximate.",
        saved: "Settings are stored locally in this browser and apply to footer lines immediately."
      }
    };

    // ── settings store (localStorage + listeners) ───────────────────────────
    var SETTINGS_KEY = "dsh-cost.settings.v1";
    var DEFAULT_SETTINGS = { lang: "zh", unit: "CNY", usdRate: 0.14 };
    var settingsListeners = [];

    function loadSettings() {
      var base = { lang: "zh", unit: "CNY", usdRate: 0.14 };
      try {
        var raw = window.localStorage.getItem(SETTINGS_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p.lang === "en" || p.lang === "zh") base.lang = p.lang;
          if (p.unit === "USD" || p.unit === "CNY") base.unit = p.unit;
          var r = Number(p.usdRate);
          if (Number.isFinite(r) && r > 0) base.usdRate = r;
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
    function getPricing() {
      if (!pricingPromise) {
        pricingPromise = api({ action: "list" }).then(function (res) {
          return res && res.ok && res.pricing ? res.pricing : DEFAULT_PRICING;
        }).catch(function () { return DEFAULT_PRICING; });
      }
      return pricingPromise;
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
        if (res && res.ok) { balanceCache.value = res; balanceCache.error = ""; }
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

    function modelKey(model) {
      var m = String(model || "").toLowerCase();
      if (m.indexOf("pro") >= 0) return "deepseek-v4-pro";
      if (m.indexOf("flash") >= 0) return "deepseek-v4-flash";
      return "unknown";
    }

    function isPeak(ts, peakWindows) {
      var windows = peakWindows && peakWindows.length ? peakWindows : DEFAULT_PRICING.peakWindows;
      var d = new Date(Number(ts) + 8 * 3600 * 1000);
      var t = d.getUTCHours() * 60 + d.getUTCMinutes();
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i];
        if (t >= w.start && t < w.end) return true;
      }
      return false;
    }

    function costFor(call, pricing) {
      var p = pricing && pricing.models ? pricing : DEFAULT_PRICING;
      var mk = modelKey(call && call.model);
      var row = p.models && p.models[mk];
      if (!row) return 0;
      var u = (call && call.usage) || {};
      var rates = isPeak(call && call.time, p.peakWindows) ? row.peak : row.offPeak;
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
      var totals = { inputMiss: 0, cacheRead: 0, cacheWrite: 0, output: 0, peak: 0, offPeak: 0, cost: 0 };
      var p = pricing || DEFAULT_PRICING;
      for (var i = 0; i < data.calls.length; i++) {
        var call = data.calls[i];
        var u = call.usage || {};
        totals.inputMiss += u.inputTokens || 0;
        totals.cacheRead += u.cacheReadTokens || 0;
        totals.cacheWrite += u.cacheWriteTokens || 0;
        totals.output += u.outputTokens || 0;
        totals.cost += costFor(call, p);
        if (isPeak(call.time, p.peakWindows)) totals.peak++; else totals.offPeak++;
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

    // ── settings panel (language + price unit + USD rate) ───────────────────
    var stSet = {
      root: { display: "flex", flexDirection: "column", gap: 12, padding: "4px 0", width: "100%", maxWidth: 680, boxSizing: "border-box" },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
      label: { fontSize: 13, fontWeight: 500 },
      seg: { display: "inline-flex", border: "1px solid rgba(128,128,128,.35)", borderRadius: 6, overflow: "hidden" },
      segBtn: { border: 0, background: "transparent", padding: "6px 14px", fontSize: 12, cursor: "pointer", color: "inherit" },
      segOn: { border: 0, background: "rgba(90,140,255,.22)", padding: "6px 14px", fontSize: 12, cursor: "pointer", color: "inherit", fontWeight: 600 },
      input: { border: "1px solid rgba(128,128,128,.35)", background: "transparent", borderRadius: 6, padding: "5px 10px", fontSize: 12, color: "inherit", width: 90, textAlign: "right" },
      note: { fontSize: 11, opacity: 0.55 }
    };

    function SettingsPanel() {
      var [settings, setSettings] = useState(currentSettings);
      useEffect(function () {
        return subscribeSettings(function (s) { setSettings(s); });
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
        el("div", { style: stSet.note }, note)
      );
    }

    // ── plugin ──
    var inject = ["slots", "conversationEvents"];

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