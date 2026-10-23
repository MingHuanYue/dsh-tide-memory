import { rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
process.env.DSH_HOME = 'D:/DSH插件/projects/dsh-tide-memory/_tmp_smoke'
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const mod = await import('../lib/index.js')
const handlers = new Map()
const tools = []
const ctx = {
  effect: (fn) => { const r = fn(); return typeof r === 'function' ? r : () => {} },
  get: () => null,
  agents: { list: () => [] },
  tools: { register: (t) => { tools.push(t.name); return () => {} } },
  timer: { interval: () => () => {} },
  systemPrompt: { context: () => () => {} },
  webServer: { register: (spec) => { handlers.set(spec.path, spec.handler); return () => handlers.delete(spec.path) } },
}
mod.apply(ctx)
console.log('routes:', [...handlers.keys()].join(' '))

function call(path, { method = 'GET', body = null } = {}) {
  const req = new EventEmitter()
  req.url = path
  req.method = method
  let status = 0, payload = ''
  const res = { writeHead: (s) => { status = s }, end: (b) => { payload = b } }
  const p = handlers.get(path.split('?')[0])(req, res)
  return Promise.resolve(p).then(() => {
    if (body) { req.emit('data', JSON.stringify(body)); }
    req.emit('end')
    return new Promise((r) => setTimeout(() => r({ status, json: payload ? JSON.parse(payload) : null }), 30))
  })
}

// 先 POST remember
const post = async (path, body) => {
  const req = new EventEmitter(); req.url = path; req.method = 'POST'
  let payload = ''
  const res = { writeHead: () => {}, end: (b) => { payload = b } }
  const p = handlers.get(path)(req, res)
  req.emit('data', JSON.stringify(body)); req.emit('end')
  await Promise.resolve(p)
  await new Promise((r) => setTimeout(r, 20))
  return JSON.parse(payload)
}

const a = await post('/dsh-tide-memory/remember', { key: 'ws-smoke', text: '主人怕吵，晚上十一点以后别弹通知', kind: 'fact', imp: 1 })
console.log('remember:', a.ok, a.row.id, 'dup=' + !!a.row.dup)
const b = await post('/dsh-tide-memory/remember', { key: 'ws-smoke', text: '主人怕吵，晚上十一点以后别弹通知', kind: 'fact', imp: 1 })
console.log('dup check:', !!b.row.dup, 'same id:', a.row.id === b.row.id)

const req = new EventEmitter(); req.url = '/dsh-tide-memory/sessions?x=1'; req.method = 'GET'
let payload = ''
await handlers.get('/dsh-tide-memory/sessions')(req, { writeHead: () => {}, end: (x) => { payload = x } })
const s = JSON.parse(payload)
console.log('sessions:', s.ok, JSON.stringify(s.sessions))
console.log('cfg:', JSON.stringify(s.cfg))

const r2 = new EventEmitter(); r2.url = '/dsh-tide-memory/memories?key=ws-smoke&filter=live'
let pl2 = ''
await handlers.get('/dsh-tide-memory/memories')(r2, { writeHead: () => {}, end: (x) => { pl2 = x } })
const m = JSON.parse(pl2)
console.log('memories:', m.ok, m.rows.length, 'alive=' + m.rows[0].aliveness)

const r3 = new EventEmitter(); r3.url = '/dsh-tide-memory/config'; r3.method = 'GET'
let pl3 = ''
await handlers.get('/dsh-tide-memory/config')(r3, { writeHead: () => {}, end: (x) => { pl3 = x } })
console.log('config get:', pl3.slice(0, 160))

const c2 = await post('/dsh-tide-memory/config', { threshold: 0.5, maxInject: 4 })
console.log('config post:', c2.ok, JSON.stringify(c2.cfg))
