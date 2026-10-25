import test from 'node:test'
import assert from 'node:assert'
import { rmSync } from 'node:fs'

const HOME = 'D:/DSH插件/projects/dsh-tide-memory/_tmp_conflict_home'
rmSync(HOME, { recursive: true, force: true })
process.env.DSH_HOME = HOME
const m = await import('../lib/index.js')
const T = m.__test
const CFG = { halfLifeEventDays: 30, halfLifeEmoDays: 7, maxInject: 6, threshold: 0.35, maxChars: 800 }

test('同关键词、不同说法的两条事实，新的会带 conflict 指向旧的', () => {
  const key = 'ws-conflict'
  const a = T.remember(key, { text: '车还在修，说是周三能取', kind: 'fact', keys: ['车'] })
  const b = T.remember(key, { text: '车修好了，比说的早两天', kind: 'fact', keys: ['车'] })
  assert.ok(Array.isArray(b.conflicts), '应该有 conflicts')
  assert.equal(b.conflicts[0].id, a.id)
  // 旧的没被删、也没被自动作废 —— 谁对由模型看着时间先后自己判
  const rows = T.loadStore(key)
  const old = rows.find((r) => r.id === a.id)
  assert.equal(old.supersededBy, undefined)
})

test('不同 kind 或者没共享关键词，不算冲突', () => {
  const key = 'ws-noconflict'
  T.remember(key, { text: '主人喜欢猫', kind: 'fact', keys: ['猫'] })
  const ev = T.remember(key, { text: '今天下雨，伞忘在学校了', keys: ['猫'] })
  assert.equal(ev.conflicts, undefined)
  const other = T.remember(key, { text: '主人喜欢狗', kind: 'fact', keys: ['狗'] })
  assert.equal(other.conflicts, undefined)
})

test('传了 supersedes：旧那条挂上 supersededBy，新那条记住自己替掉了谁', () => {
  const key = 'ws-supersede'
  const a = T.remember(key, { text: '车还在修', kind: 'fact', keys: ['车'] })
  const b = T.remember(key, { text: '车修好了', kind: 'fact', keys: ['车'], supersedes: a.id })
  const rows = T.loadStore(key)
  assert.equal(rows.find((r) => r.id === a.id).supersededBy, b.id)
  assert.equal(b.supersedes, a.id)
  // 已经指定取代了，就别再同时挂在 conflicts 里
  assert.ok(!(b.conflicts || []).some((c) => c.id === a.id))
})

test('注入时两条对不上：只留新的那条，把旧的说法缩成一句附在括号里', () => {
  const key = 'ws-render'
  const a = T.remember(key, { text: '车还在修', kind: 'fact', keys: ['车'] })
  const b = T.remember(key, { text: '车修好了', kind: 'fact', keys: ['车'] })
  const picked = [
    { row: a, C: 0.8, P: 0.8, act: 1 },
    { row: b, C: 0.8, P: 0.8, act: 1 },
  ]
  const out = T.renderInjection(picked)
  assert.ok(out.includes('车修好了'))
  assert.equal(out.split('车还在修').length, 2, '旧的说法只该出现一次，就在括号里')
  assert.ok(out.indexOf('更早那条是') < out.indexOf('车还在修'), '括号要跟在新的那条后面')
})

test('脉搏：命中累加，白翻单独计，文件不存在时从零开始', () => {
  const p0 = T.loadPulse()
  assert.equal(p0.hits, 0)
  T.bumpPulse({ injects: 1, hits: 2 })
  T.bumpPulse({ hit: 1 })
  T.bumpPulse({ miss: 1 })
  const p1 = T.loadPulse()
  assert.equal(p1.injects, 1)
  assert.equal(p1.hits, 3)
  assert.equal(p1.misses, 1)
  assert.ok(p1.lastHitAt > 0)
})