import { rmSync, readFileSync } from 'node:fs'
process.env.DSH_HOME = 'D:/DSH插件/projects/dsh-tide-memory/_tmp_inject'
rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const mod = await import('./lib/index.js')
const T = mod.__test
const KEY = 'ws-dsh-tide-memory'
T.remember(KEY, { text: '主人不喜欢别人替他做决定，什么事都要先问一句', kind: 'fact', imp: 1 })
T.remember(KEY, { text: '车送去修了，说是周三能取', imp: 0.5 })
T.remember(KEY, { text: '主人在做一个小鲸鱼挂件，用 Electron', imp: 0.5 })

const events = {}
const specs = []
const tools = []
let tickFn = null
const agent = {
  cwd: 'D:/DSH插件/projects/dsh-tide-memory',
  session: { id: 'sess-1' },
  ctx: {
    on: (evt, fn) => { events[evt] = fn; return () => {} },
    systemPrompt: { context: (spec) => { specs.push(spec); return () => {} } },
    tools: { register: (t) => { tools.push(t.name); return () => {} } },
  },
}
const ctx = {
  effect: (fn) => { const r = fn(); return typeof r === 'function' ? r : () => {} },
  get: () => null,
  agents: { list: () => [agent] },
  tools: { register: () => () => {} },
  timer: { interval: (fn) => { if (!tickFn) tickFn = fn; return () => {} } },
  systemPrompt: { context: () => () => {} },
  webServer: { register: () => () => {} },
}
mod.apply(ctx)
tickFn()
console.log('events:', Object.keys(events).join(','), '| specs:', specs.length, '| tools:', tools.join(','))
console.log('empty before message:', JSON.stringify(specs[0].text()))
events['agent/inbox/inserted']({ message: { role: 'user', content: [{ type: 'text', text: '车修好了吗？今天能取吗' }] } })
const out = specs[0].text()
console.log('--- injection ---')
console.log(out)
console.log('--- trace keys ---')
const tr = readFileSync(process.env.DSH_HOME + '/tide-memory/trace.jsonl', 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.op === 'inject')
console.log(JSON.stringify(tr[tr.length - 1]))
