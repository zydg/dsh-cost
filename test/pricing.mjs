/**
 * dsh-cost 价格编辑器宿主逻辑测试：
 *   · setPrices replaceModels 整表替换（新增/删除模型、label、峰谷价）
 *   · 高峰时段 peakWindows 校验/归一/整表持久化恢复
 *   · isPeak：显式数组优先，[] 表示全天低谷
 *   · 空表被拒绝、非法价格归零、旧版局部更新兼容
 *   · resetPrices 恢复官方默认
 */
import assert from 'node:assert/strict'
import plugin, { API_PATH, DEFAULT_PRICING, isPeak } from '../lib/index.js'

let passed = 0
function check(name, fn) { fn(); passed++; console.log('  ok  ' + name) }

const ROOT = '/tmp/dsh-cost-pricing-test'
function makeHarness(store) {
  const files = store || new Map()
  const routes = []
  const fsStub = {
    resolve: async (p) => ({ displayPath: String(p), path: String(p) }),
    readText: async (t) => { const p = (t && t.path) || String(t); if (files.has(p)) return files.get(p); throw new Error('ENOENT') },
    writeText: async (t, content) => { const p = (t && t.path) || String(t); files.set(p, content); return { ok: true } },
    stat: async () => ({ isDirectory: () => true })
  }
  const ctx = {
    get(name) {
      if (name === 'fs') return fsStub
      if (name === 'webServer') return { register: (r) => routes.push(r) }
      if (name === 'subprocess') return { resolveExecutable: async () => { throw new Error('no node') }, spawn: () => { throw new Error('unreachable') } }
      if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test' }) }
      if (name === 'sandboxPolicy') return { resolve: () => ({ workspaceRoot: ROOT }) }
      if (name === 'agents') return {}
      return undefined
    },
    on() {}
  }
  plugin.apply(ctx)
  const route = routes.find((r) => r.path === API_PATH)
  function callApi(body) {
    const payload = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const res = { writeHead() {}, end(text) { try { resolve(JSON.parse(text)) } catch (e) { reject(e) } } }
      const req = { on(ev, fn) { if (ev === 'end') { req._data && req._data(payload); fn() } else if (ev === 'data') req._data = fn; return req } }
      Promise.resolve(route.handler(req, res)).catch(reject)
    })
  }
  return { files, callApi }
}

// ── isPeak 语义 ──────────────────────────────────────────────────────────
const monday10 = Date.UTC(2026, 8, 7, 2, 0, 0) // 周一 10:00 北京时间
check('构造的探测时间是周一 10:00 北京时间', () => {
  assert.equal(new Date(monday10 + 8 * 3600 * 1000).getUTCDay(), 1)
  assert.equal(new Date(monday10 + 8 * 3600 * 1000).getUTCHours(), 10)
})
check('isPeak：默认窗口命中高峰；[] 表示全天低谷；自定义窗口生效', () => {
  assert.equal(isPeak(monday10, DEFAULT_PRICING.peakWindows, false), true)
  assert.equal(isPeak(monday10, [], false), false)
  assert.equal(isPeak(monday10, [{ start: 0, end: 1440 }], false), true)
  assert.equal(isPeak(monday10, [{ start: 660, end: 720 }], false), false)
  assert.equal(isPeak(monday10, [{ start: 600, end: 660 }], false), true)
})

const h1 = makeHarness()
await h1.callApi({ action: 'list' })

const set1 = await h1.callApi({ action: 'setPrices', prices: {
  replaceModels: true,
  weekendOffPeak: false,
  peakWindows: [{ start: 600, end: 720 }, { start: 900, end: 1020 }],
  models: {
    'my-model': { label: '我的模型', offPeak: { cacheHit: 0.01, cacheMiss: 0.5, output: 2 }, peak: { cacheHit: 0.02, cacheMiss: 1, output: 4 } },
    'deepseek-flash': { label: 'F', offPeak: { cacheHit: 0.03, cacheMiss: 1.1, output: 4.4 }, peak: { cacheHit: 0.06, cacheMiss: 2.2, output: 8.8 } }
  }
} })
check('replaceModels 整表替换成功（模型 + 高峰时段 + weekendOffPeak）', () => {
  assert.equal(set1.ok, true)
  assert.deepEqual(Object.keys(set1.pricing.models).sort(), ['deepseek-flash', 'my-model'])
  assert.equal(set1.pricing.models['my-model'].peak.output, 4)
  assert.equal(set1.pricing.models['my-model'].label, '我的模型')
  assert.equal(set1.pricing.weekendOffPeak, false)
  assert.deepEqual(set1.pricing.peakWindows, [{ start: 600, end: 720 }, { start: 900, end: 1020 }])
})

check('空模型表被拒绝', async () => {})
const badEmpty = await h1.callApi({ action: 'setPrices', prices: { replaceModels: true, models: {} } })
check('空模型表被拒绝（结果）', () => { assert.equal(badEmpty.ok, false) })

const badWin = await h1.callApi({ action: 'setPrices', prices: { peakWindows: [{ start: 600, end: 600 }] } })
check('非法高峰时段被拒绝（start>=end）', () => { assert.equal(badWin.ok, false) })
const badWin2 = await h1.callApi({ action: 'setPrices', prices: { peakWindows: [{ start: -1, end: 100 }] } })
check('非法高峰时段被拒绝（越界）', () => { assert.equal(badWin2.ok, false) })
const emptyWin = await h1.callApi({ action: 'setPrices', prices: { peakWindows: [] } })
check('空高峰时段被接受（= 全天低谷）', () => { assert.equal(emptyWin.ok, true); assert.deepEqual(emptyWin.pricing.peakWindows, []) })

const del = await h1.callApi({ action: 'setPrices', prices: { replaceModels: true, models: { x: { peak: { cacheHit: -1 } } } } })
check('整表替换删除未列出的模型；非法价格归一为 0', () => {
  assert.equal(del.ok, true)
  assert.deepEqual(Object.keys(del.pricing.models), ['x'])
  assert.equal(del.pricing.models.x.peak.cacheHit, 0)
})
const legacy = await h1.callApi({ action: 'setPrices', prices: { models: { x: { peak: { cacheHit: 0.5, cacheMiss: 3, output: 9 } } } } })
check('旧版局部更新更新已有模型', () => { assert.equal(legacy.ok, true); assert.equal(legacy.pricing.models.x.peak.output, 9) })
const legacyNew = await h1.callApi({ action: 'setPrices', prices: { models: { 'brand-new': { label: 'N', offPeak: { cacheHit: 1, cacheMiss: 2, output: 3 }, peak: { cacheHit: 1, cacheMiss: 2, output: 3 } } } } })
check('旧版局部更新可新增未知模型键', () => { assert.equal(legacyNew.ok, true); assert.ok(legacyNew.pricing.models['brand-new']) })

// 设置一个自定义高峰时段用于跨“重启”恢复验证
await h1.callApi({ action: 'setPrices', prices: { peakWindows: [{ start: 600, end: 660 }, { start: 840, end: 1020 }] } })
await new Promise((r) => setTimeout(r, 80))

const h2 = makeHarness(new Map([...h1.files.entries()]))
await h2.callApi({ action: 'list' })
const list2 = await h2.callApi({ action: 'list' })
check('重启后恢复自定义完整模型表', () => {
  assert.deepEqual(Object.keys(list2.pricing.models).sort(), ['brand-new', 'x'])
  assert.equal(list2.pricing.models.x.peak.output, 9)
})
check('重启后恢复自定义高峰时段', () => {
  assert.deepEqual(list2.pricing.peakWindows, [{ start: 600, end: 660 }, { start: 840, end: 1020 }])
})

const reset = await h2.callApi({ action: 'resetPrices' })
check('resetPrices 恢复官方默认（含高峰时段）', () => {
  assert.equal(reset.ok, true)
  assert.deepEqual(Object.keys(reset.pricing.models).sort(), Object.keys(DEFAULT_PRICING.models).sort())
  assert.deepEqual(reset.pricing.peakWindows, DEFAULT_PRICING.peakWindows)
})

console.log('\n价格编辑测试通过：' + passed + ' 项')
