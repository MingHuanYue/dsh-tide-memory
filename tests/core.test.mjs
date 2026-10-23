import { rmSync } from 'node:fs'
rmSync(new URL('./_tmp_dshhome', import.meta.url), { recursive: true, force: true })
process.env.DSH_HOME = 'D:/DSH插件/projects/dsh-tide-memory/_tmp_dshhome'
const m = await import('../lib/index.js')
const T = m.__test

const key = 'ws-test'
T.remember(key, { text: '主人不喜欢别人替他做决定，什么事都要先问一句', kind: 'fact', imp: 1, keys: ['决定', '边界'] })
T.remember(key, { text: '车送去修了，说是周三能取', imp: 0.5, keys: ['车'] })
T.remember(key, { text: '主人在做一个小鲸鱼挂件，用的是 Electron', imp: 0.5, keys: ['小鲸鱼'] })

const rows = T.loadStore(key)
console.log('rows', rows.length)
const r1 = T.recall(rows, '车修好了吗', { halfLifeEventDays: 30, halfLifeEmoDays: 7, maxInject: 6, threshold: 0.35, maxChars: 800 })
console.log('车 query ->', r1.picked.map(x => [x.row.text.slice(0, 12), x.C.toFixed(2), x.P.toFixed(2)]))
const r2 = T.recall(rows, '今天天气怎么样', { halfLifeEventDays: 30, halfLifeEmoDays: 7, maxInject: 6, threshold: 0.35, maxChars: 800 })
console.log('无关 query ->', r2.picked.length)
const r3 = T.recall(rows, '做决定之前要先问他', { halfLifeEventDays: 30, halfLifeEmoDays: 7, maxInject: 6, threshold: 0.35, maxChars: 800 })
console.log('边界 query ->', r3.picked.map(x => [x.row.text.slice(0, 12), x.C.toFixed(2)]))
console.log('tokens:', [...T.tokensOf('主人不喜欢别人替他做决定')].slice(0, 12).join('|'))
