/**
 * dsh-cost self-test — 纯 Node，无第三方依赖：node test/selftest.mjs
 *
 * 覆盖：官方峰谷计价、V4 Pro 路由、旧模型名归一、模型清单同步的纯函数，
 * 以及「宿主与客户端别名表一致」这一不变量（两半代码必须同步改）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  DEFAULT_PRICING,
  MODEL_ALIASES,
  MODEL_CATALOG_TTL_MS,
  billedModelKey,
  catalogStale,
  costFor,
  hitRateOf,
  isPeak,
  mergeCatalogIds,
  modelKey,
  parseModels
} from '../lib/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ok  ' + name)
}

const PEAK_MON = Date.parse('2026-09-14T10:00:00+08:00')      // 周一 10:00 → 高峰
const OFF_MON = Date.parse('2026-09-14T13:00:00+08:00')       // 周一 13:00 → 空闲
const WEEKEND = Date.parse('2026-09-12T10:00:00+08:00')       // 周六 10:00 → 周末低谷
const PRE_ROUTE = Date.parse('2026-09-14T11:00:00+08:00')     // 路由生效前（高峰）
const POST_ROUTE = Date.parse('2026-09-14T13:00:00+08:00')    // 路由生效后（空闲）
const M = 1e6

console.log('计价 / 峰谷')
check('Flash 高峰：缓存命中 ¥0.04、未命中 ¥2、输出 ¥8 / 百万 tokens', () => {
  assert.equal(costFor({ model: 'deepseek-flash', time: PEAK_MON, cacheReadTokens: M, inputTokens: M, outputTokens: M }, DEFAULT_PRICING), 0.04 + 2 + 8)
})
check('Flash 空闲：缓存命中 ¥0.02、未命中 ¥1、输出 ¥4 / 百万 tokens', () => {
  assert.equal(costFor({ model: 'deepseek-flash', time: OFF_MON, cacheReadTokens: M, inputTokens: M, outputTokens: M }, DEFAULT_PRICING), 0.02 + 1 + 4)
})
check('周末全天按低谷价（weekendOffPeak 默认开启）', () => {
  assert.equal(isPeak(WEEKEND, DEFAULT_PRICING.peakWindows, DEFAULT_PRICING.weekendOffPeak), false)
  assert.equal(costFor({ model: 'deepseek-flash', time: WEEKEND, inputTokens: M }, DEFAULT_PRICING), 1)
})
check('连续峰谷窗口外（12:00–14:00 午休）为空闲', () => {
  assert.equal(isPeak(Date.parse('2026-09-14T12:30:00+08:00'), DEFAULT_PRICING.peakWindows, true), false)
})
check('命中率 = 缓存读 / 总输入', () => {
  assert.equal(hitRateOf(750, 250), 0.75)
  assert.equal(hitRateOf(0, 0), 0)
})

console.log('模型名归一 / 计价桶')
check('在售名 deepseek-flash → flash 桶', () => {
  assert.equal(modelKey('deepseek-flash'), 'deepseek-flash')
})
check('已下线旧名归一：v4-flash / -vision-exp / chat → flash 桶', () => {
  assert.equal(modelKey('deepseek-v4-flash'), 'deepseek-flash')
  assert.equal(modelKey('deepseek-v4-flash-vision-exp'), 'deepseek-flash')
  assert.equal(modelKey('deepseek-chat'), 'deepseek-flash')
})
check('reasoner → Pro 桶，v4-pro 保持 Pro 桶', () => {
  assert.equal(modelKey('deepseek-reasoner'), 'deepseek-v4-pro')
  assert.equal(modelKey('deepseek-v4-pro'), 'deepseek-v4-pro')
})
check('大小写/空格不影响归一', () => {
  assert.equal(modelKey('  DeepSeek-Flash '), 'deepseek-flash')
})
check('未来版本名按子串兜底：deepseek-flash-2 / deepseek-v4-pro-2', () => {
  assert.equal(modelKey('deepseek-flash-2'), 'deepseek-flash')
  assert.equal(modelKey('deepseek-v4-pro-2'), 'deepseek-v4-pro')
})
check('未知模型名 → unknown，费用按 0 计（需人工补价格）', () => {
  assert.equal(modelKey('deepseek-whatever'), 'unknown')
  assert.equal(costFor({ model: 'deepseek-whatever', time: OFF_MON, inputTokens: M }, DEFAULT_PRICING), 0)
})

console.log('V4 Pro 有序下线路由')
check('路由生效前 deepseek-v4-pro 按 Pro 高峰价计费', () => {
  assert.equal(billedModelKey('deepseek-v4-pro', PRE_ROUTE, DEFAULT_PRICING), 'deepseek-v4-pro')
  assert.equal(costFor({ model: 'deepseek-v4-pro', time: PRE_ROUTE, inputTokens: M }, DEFAULT_PRICING), 9)
})
check('路由生效后 deepseek-v4-pro 落到 Flash 单价', () => {
  assert.equal(billedModelKey('deepseek-v4-pro', POST_ROUTE, DEFAULT_PRICING), 'deepseek-flash')
  assert.equal(costFor({ model: 'deepseek-v4-pro', time: POST_ROUTE, inputTokens: M }, DEFAULT_PRICING), 1)
})
check('路由只影响 Pro：deepseek-reasoner 同样在路由后落到 Flash', () => {
  assert.equal(billedModelKey('deepseek-reasoner', POST_ROUTE, DEFAULT_PRICING), 'deepseek-flash')
})

console.log('官方模型清单（GET /models）')
check('解析标准响应并按 id 去重', () => {
  const r = parseModels(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }))
  assert.equal(r.ok, true)
  assert.deepEqual(r.ids, ['deepseek-flash', 'deepseek-v4-pro'])
  assert.ok(Number.isFinite(r.fetchedAt))
})
check('兼容裸数组与 model 字段', () => {
  const r = parseModels(JSON.stringify([{ model: 'deepseek-flash' }]))
  assert.deepEqual(r.ids, ['deepseek-flash'])
})
check('空清单 / 非 JSON → ok:false（不清空已有缓存）', () => {
  assert.equal(parseModels(JSON.stringify({ data: [] })).ok, false)
  assert.equal(parseModels('<html>502</html>').ok, false)
})
check('TTL：未同步过视为过期，同步过 24h 内视为新鲜', () => {
  const now = Date.now()
  assert.equal(catalogStale({ ids: [], fetchedAt: 0 }, now), true)
  assert.equal(catalogStale({ ids: ['a'], fetchedAt: now }, now), false)
  assert.equal(catalogStale({ ids: ['a'], fetchedAt: now - MODEL_CATALOG_TTL_MS - 1 }, now), true)
})
check('合并清单：新 id 在前、去重、保留缓存里已下线的历史 id', () => {
  const cat = { ids: ['deepseek-v4-flash', 'deepseek-flash'], fetchedAt: 1 }
  const merged = mergeCatalogIds(cat, ['deepseek-flash', 'deepseek-v4-pro'], 12345)
  assert.deepEqual(merged, ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'])
  assert.equal(cat.fetchedAt, 12345)
  assert.equal(cat.error, '')
})

console.log('宿主 / 客户端一致性')
check('client.js 的 MODEL_ALIASES 与宿主导出完全一致', () => {
  const src = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  const m = src.match(/var MODEL_ALIASES = \{([\s\S]*?)\};/)
  assert.ok(m, '未在 client.js 中找到 MODEL_ALIASES')
  const clientAliases = new Function('return {' + m[1] + '}')()
  assert.deepEqual(clientAliases, MODEL_ALIASES)
})
check('client.js 的默认定价表与宿主 DEFAULT_PRICING 一致（忽略仅宿主使用的 label）', () => {
  const src = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  const m = src.match(/var DEFAULT_PRICING = (\{[\s\S]*?\n    \});/)
  assert.ok(m, '未在 client.js 中找到 DEFAULT_PRICING')
  const clientPricing = new Function('return ' + m[1])()
  const stripLabels = (p) => {
    const copy = JSON.parse(JSON.stringify(p))
    for (const key of Object.keys(copy.models || {})) delete copy.models[key].label
    return copy
  }
  assert.deepEqual(stripLabels(clientPricing), stripLabels(DEFAULT_PRICING))
})

console.log('\n全部通过：' + passed + ' 项断言')
