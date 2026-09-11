/**
 * dsh-cost 冒烟测试 —— 用桩服务真实的 apply(ctx)，验证：
 *   · 插件能挂载并注册 POST /dsh-cost/api
 *   · list 响应带 pricing 与 modelCatalog
 *   · syncModels 在缺少 node 子进程时优雅降级（ok:false + 错误信息，不抛异常）
 *   · balance/未知 action 的返回形状稳定
 * 运行：node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsSync from 'node:fs'

import plugin, { API_PATH, PLUGIN_NAME } from '../lib/index.js'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ok  ' + name)
}

// ── 桩服务 ────────────────────────────────────────────────────────────────
const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'dsh-cost-smoke-'))
const written = []
const routes = []
const listeners = {}

const fsStub = {
  resolve: async (p) => ({ displayPath: String(p), path: String(p) }),
  readText: async () => { throw new Error('ENOENT') },
  writeText: async (target) => { written.push(String(target.path || target)); return { ok: true } },
  stat: async () => ({ isDirectory: () => true })
}
const ctx = {
  get(name) {
    if (name === 'fs') return fsStub
    if (name === 'webServer') return { register: (r) => routes.push(r) }
    // subprocess 存在但找不到 node：模拟无子进程能力的环境
    if (name === 'subprocess') return { resolveExecutable: async () => { throw new Error('no node') }, spawn: () => { throw new Error('unreachable') } }
    if (name === 'credentials') return { resolve: async () => ({ value: 'sk-smoke-test' }) }
    if (name === 'sandboxPolicy') return { resolve: () => ({ workspaceRoot: root }) }
    if (name === 'agents') return {}
    return undefined
  },
  on(event, fn) { listeners[event] = fn }
}

plugin.apply(ctx)

const route = routes.find((r) => r.path === API_PATH)
function callApi(body) {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const res = { writeHead() {}, end(text) { try { resolve(JSON.parse(text)) } catch (e) { reject(e) } } }
    // 极简 IncomingMessage 桩：注册 'end' 时先吐一个 data 块，再触发 'end'。
    const req = {
      on(ev, fn) {
        if (ev === 'end') { req._data && req._data(payload); fn() }
        else if (ev === 'data') req._data = fn
        else if (ev === 'error') req._err = fn
        return req
      }
    }
    Promise.resolve(route.handler(req, res)).catch(reject)
  })
}

console.log('冒烟：' + PLUGIN_NAME)
check('apply() 注册了 ' + API_PATH, () => {
  assert.equal(routes.length, 1)
  assert.equal(route.kind, 'exact')
})

const list = await callApi({ action: 'list' })
if (process.env.SMOKE_DEBUG) console.log('DEBUG list =', JSON.stringify(list).slice(0, 800))
check('action=list 返回 ok + 价格表 + 模型清单字段', () => {
  assert.equal(list.ok, true)
  assert.equal(list.plugin, PLUGIN_NAME)
  assert.ok(list.pricing.models['deepseek-flash'].offPeak.cacheMiss === 1)
  assert.ok(list.modelCatalog, '缺少 modelCatalog')
  assert.deepEqual(list.modelCatalog.ids, [])
  assert.equal(list.modelCatalog.fetchedAt, 0)
  assert.equal(typeof list.modelCatalog.ttlMs, 'number')
})

// 启动时已有一次后台同步；等它落定，再手动触发一次，避免命中「同步进行中」。
await new Promise((r) => setTimeout(r, 50))
const synced = await callApi({ action: 'syncModels' })
check('syncModels 无子进程时优雅降级（ok:false + 错误，不抛异常）', () => {
  assert.equal(synced.ok, false)
  assert.match(synced.error, /node|凭据|接口|同步/)
  assert.ok(synced.modelCatalog)
  assert.deepEqual(synced.modelCatalog.ids, [])
  assert.equal(synced.modelCatalog.syncing, false)
})

const balance = await callApi({ action: 'balance' })
check('action=balance 无子进程时返回 ok:false', () => {
  assert.equal(balance.ok, false)
  assert.ok(typeof balance.error === 'string' && balance.error.length > 0)
})

const bogus = await callApi({ action: 'nope' })
check('未知 action 返回 ok:false + 未知操作', () => {
  assert.equal(bogus.ok, false)
  assert.match(bogus.error, /未知操作/)
})

check('llm/stream 已挂监听（可记录调用）', () => {
  assert.equal(typeof listeners['llm/stream'], 'function')
})

fsSync.rmSync(root, { recursive: true, force: true })
console.log('\n冒烟通过：' + passed + ' 项')
