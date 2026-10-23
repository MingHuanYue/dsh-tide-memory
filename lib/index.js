// dsh-tide-memory · 宿主半边
//
// 三件事：存 / 取 / 注。
//   存：每条记忆带「鲜活度」，事件会淡忘，事实不淡忘；过时的不是删掉，是被「取代」（留链）。
//   取：先看「证据够不够」（C），再看「值不值得排前面」（P）。证据不够就不进，宁可少想。
//   注：以 systemPrompt.context 追加到对话末尾（不污染系统提示词缓存），每条带时间。
//
// 设计上刻意不做的事：不每轮让模型抽取记忆（贵、且会把原话磨平）、不做自动改写（debug 地狱）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ───────────── 宿主依赖：defineTool ─────────────
// ⚠️ 2026-10-23 18:03 那次「注入全不生效」的真凶就在这儿：
//   桌面版 profile 是 autoInstallPeers:false，`@deepseek-ai/dsh-tools` **常常不在解析路径上**
//   （本项目实测就是解析失败）→ 掉进本地兜底 → 兜底返回的 spec 少了 `output.render`
//   → DSH 把工具递给模型时要读 `tool.output.render` → `Cannot read properties of undefined (reading 'render')`
//   → 整个 mountFor 抛错 → 注入、工具一起挂，而且每 2 秒重来一次刷屏。
// 所以两条一起走：① 先照 dsh-fish-memory 的办法去宿主树里翻那份 defineTool；
//   ② 翻不到就用本地等价实现 —— 但本地实现必须**自己补 output.render**，否则等于没修。
function hostModuleRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai'))
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
    } catch { /* 没有就算了 */ }
  }
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch { /* 没有就算了 */ }
  push(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai'))
  return out
}

async function loadHostDefineTool() {
  for (const root of hostModuleRoots()) {
    try {
      const pkgFile = join(root, 'dsh-tools', 'package.json')
      if (!existsSync(pkgFile)) continue
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      const dot = pkg.exports && pkg.exports['.']
      const rel = typeof dot === 'string' ? dot : (dot && (dot.import || dot.default)) || pkg.module || pkg.main
      if (!rel) continue
      const file = join(root, 'dsh-tools', String(rel).replace(/^\.\//, ''))
      if (!existsSync(file)) continue
      const mod = await import(pathToFileURL(file).href)
      const fn = mod.defineTool || (mod.default && mod.default.defineTool)
      if (typeof fn === 'function') return fn
    } catch { /* 换下一个候选根 */ }
  }
  return null
}

// parameters 简写 → 标准 JSON Schema（只在本地兜底时用；宿主那份 defineTool 自己会转）
function paramsToSchema(params) {
  const properties = {}
  const required = []
  for (const [k, v] of Object.entries(params || {})) {
    const p = { ...(v || {}) }
    if (p.required) { required.push(k); delete p.required }
    if (!p.type) p.type = 'string'
    properties[k] = p
  }
  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length) schema.required = required
  return schema
}

const localDefineTool = (spec) => {
  const tool = {
    name: spec.name,
    description: spec.description || '',
    parameters: paramsToSchema(spec.parameters || {}),
    async execute(args, exec) { return spec.execute ? spec.execute(args, exec) : {} },
  }
  if (spec.output) tool.output = spec.output
  return tool
}

const defineTool = (await loadHostDefineTool()) || localDefineTool

export const name = 'tide-memory'
export const inject = ['agents', 'tools', 'webServer', 'systemPrompt', 'timer']

const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'tide-memory')
const STORE_DIR = join(DIR, 'stores')
const COLD_DIR = join(DIR, 'cold')
const CFG_PATH = join(DIR, 'config.json')
const TRACE_PATH = join(DIR, 'trace.jsonl')
const DAY = 86400000
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '?' } catch { return '?' }
})()

const DEFAULTS = {
  enabled: true,
  halfLifeEventDays: 30,
  halfLifeEmoDays: 7,
  maxInject: 6,
  threshold: 0.35,
  maxChars: 800,
}

// ───────────────────────── 基础设施 ─────────────────────────

function ensureDirs() {
  for (const d of [DIR, STORE_DIR, COLD_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true })
}

function readJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

function writeJson(p, v) {
  ensureDirs()
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8')
}

function loadCfg() {
  const raw = readJson(CFG_PATH, {}) || {}
  return { ...DEFAULTS, ...raw }
}

function saveCfg(patch) {
  const cfg = { ...loadCfg(), ...(patch || {}) }
  writeJson(CFG_PATH, cfg)
  return cfg
}

const safeKey = (k) => String(k || '').replace(/[^\w\-.]/g, '_').slice(0, 120) || 'default'
const storePath = (key) => join(STORE_DIR, safeKey(key) + '.jsonl')
const coldPath = (key) => join(COLD_DIR, safeKey(key) + '.jsonl')

function readRows(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try { out.push(JSON.parse(s)) } catch { /* 坏行跳过，不让一行毁掉整库 */ }
    }
    return out
  } catch { return [] }
}

function writeRows(file, rows) {
  ensureDirs()
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
}

const loadStore = (key) => readRows(storePath(key))
const saveStore = (key, rows) => writeRows(storePath(key), rows)

function appendTrace(entry) {
  try { ensureDirs(); appendFileSync(TRACE_PATH, JSON.stringify(entry) + '\n', 'utf8') } catch { /* 日志坏了不影响主流程 */ }
}

function diag(msg) {
  try {
    ensureDirs()
    appendFileSync(join(DIR, 'tide.log'), new Date().toISOString() + '  ' + msg + '\n', 'utf8')
  } catch { /* 同上 */ }
}

// ───────────────────────── 分词与证据 ─────────────────────────

const STOP = new Set([
  '的', '了', '是', '在', '和', '我', '你', '他', '她', '它', '们', '这', '那', '就', '都', '也', '不', '有',
  '会', '要', '说', '吧', '啊', '呢', '吗', '把', '被', '给', '还', '又', '很', '太', '个', '上', '下', '里',
  '着', '过', '得', '地', '一', '二', '三', '与', '及', '但', '而', '或', '我', '你', '他', '那', '这', '些',
  '什么', '怎么', '一个', '一下', '就是', '不是', '没有', '可以', '我们', '你们', '他们', '现在', '今天',
])

// 中文没空格 ⇒ 二元组 + 单字一起索引。
// 二元组是「词」，权重 1；单字是「部件」，权重 0.5 —— 光靠二元组会漏掉换了个说法的单字名词
// （「车修好了吗」撞不上「车送去修了」，因为 车修/修好 和 车送/送去 一个都不重合）。
// 不做「通用词典」，靠库里自己的 df 算 idf —— 少一份 900KB 词典，跨领域也不怕。
const CJK_RE = /[\u4e00-\u9fff]/
const weightOf = (tok) => (tok.length === 1 && CJK_RE.test(tok) ? 0.5 : 1)

function tokensOf(text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0])
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) { if (!STOP.has(run)) out.add(run); continue }
    for (let i = 0; i < run.length; i++) {
      const ch = run[i]
      if (!STOP.has(ch)) out.add(ch)                       // 单字：只当部件
      if (i + 1 < run.length) {
        const bg = run.slice(i, i + 2)
        if (!STOP.has(bg)) out.add(bg)                     // 二元组：当词
      }
    }
  }
  for (const t of STOP) out.delete(t)
  return out
}

const rowTokens = (row) => tokensOf([row.text || '', (row.keys || []).join(' ')].join(' '))

function idfOf(rows) {
  const df = new Map()
  for (const r of rows) for (const w of rowTokens(r)) df.set(w, (df.get(w) || 0) + 1)
  const N = Math.max(rows.length, 1)
  const idf = new Map()
  for (const [w, d] of df) idf.set(w, Math.log(1 + N / Math.max(d, 1)))
  return idf
}

const isFact = (row) => row.kind === 'fact'

function aliveness(row, cfg, now) {
  if (isFact(row)) return 1
  const days = Math.max(0, (now - Number(row.last || row.t || now)) / DAY)
  const half = Number(row.emo) > 0 ? cfg.halfLifeEmoDays : cfg.halfLifeEventDays
  return Math.pow(0.5, days / Math.max(half, 0.5))
}

function evidence(row, qTokens, idf) {
  const rt = rowTokens(row)
  let s = 0
  let hit = 0
  for (const w of qTokens) {
    if (rt.has(w)) { s += (idf.get(w) || 1) * weightOf(w); hit++ }
  }
  if (!hit) return { s: 0, C: 0, hit: 0 }
  // s/(s+2)：一条明确命中就过半，越稀疏的词越值钱（idf 自带）
  return { s, C: s / (s + 2), hit }
}

function recall(rows, query, cfg, now = Date.now()) {
  const q = tokensOf(query)
  if (!q.size || !rows.length) return { picked: [], scored: [], q }
  const idf = idfOf(rows)
  const scored = []
  for (const row of rows) {
    if (row.supersededBy || row.hidden) continue
    const ev = evidence(row, q, idf)
    if (ev.C <= 0) continue
    const act = aliveness(row, cfg, now)
    const P = ev.C * (0.55 + 0.25 * act + 0.15 * Math.min(Math.max(Number(row.imp) || 0, 0), 1) + 0.05 * Math.min(Math.max(Number(row.emo) || 0, 0), 1))
    scored.push({ row, C: ev.C, act, P, hit: ev.hit })
  }
  scored.sort((a, b) => b.P - a.P)
  const picked = []
  let chars = 0
  for (const it of scored) {
    if (it.C < Number(cfg.threshold || 0)) continue
    const len = String(it.row.text || '').length
    if (picked.length >= Number(cfg.maxInject || 6)) break
    if (chars + len > Number(cfg.maxChars || 800) && picked.length) break
    picked.push(it)
    chars += len
  }
  return { picked, scored, q }
}

// ───────────────────────── 读写一条记忆 ─────────────────────────

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function remember(key, input) {
  const rows = loadStore(key)
  const now = Date.now()
  const text = String(input.text || '').trim()
  if (!text) throw new Error('text 不能为空')
  const kind = input.kind === 'fact' ? 'fact' : 'event'
  const keys = Array.isArray(input.keys) ? input.keys.filter(Boolean).map(String).slice(0, 12) : []
  // 同一句话不重复记：命中活着的同文就刷新时间/重要度（不然一天说三遍就三条，涨得比谁都快）
  const norm = (s) => String(s || '').replace(/[\s，。,.!！?？、；;：:~…—-]+/g, '')
  const same = rows.find((r) => !r.supersededBy && norm(r.text) === norm(text))
  if (same) {
    same.last = now
    same.hits = Number(same.hits) || 0
    same.imp = Math.max(Number(same.imp) || 0, Number(input.imp ?? same.imp) || 0)
    same.keys = Array.from(new Set([...(same.keys || []), ...keys])).slice(0, 12)
    saveStore(key, rows)
    appendTrace({ at: now, key, op: 'remember-dup', id: same.id, text: same.text.slice(0, 80) })
    return Object.assign(same, { dup: true })
  }
  const row = {
    id: newId(),
    t: input.at ? Number(input.at) : now,
    last: now,
    kind,
    text: text.slice(0, 1000),
    keys,
    imp: Math.min(Math.max(Number(input.imp ?? 0.5) || 0, 0), 1),
    emo: Math.min(Math.max(Number(input.emo ?? 0) || 0, 0), 1),
    hits: 0,
    pinned: !!input.pinned,
    src: String(input.src || ''),
    dir: String(input.dir || ''),
  }
  // 「取代」：同一条事实的新版本进来时，旧的不删，标 supersededBy（留链，可回看）
  const sup = String(input.supersedes || '').trim()
  if (sup) {
    const old = rows.find((r) => r.id === sup)
    if (old) { old.supersededBy = row.id; old.last = now }
    else row.supersedesMissing = sup
  }
  rows.push(row)
  saveStore(key, rows)
  appendTrace({ at: now, key, op: 'remember', id: row.id, text: row.text.slice(0, 80) })
  return row
}

function updateRow(key, id, patch) {
  const rows = loadStore(key)
  const row = rows.find((r) => r.id === id)
  if (!row) return null
  const allowed = ['text', 'imp', 'emo', 'kind', 'pinned', 'hidden', 'supersededBy', 'keys', 'last']
  for (const k of allowed) if (k in (patch || {})) row[k] = patch[k]
  if (Array.isArray(patch?.keys)) row.keys = patch.keys.map(String).slice(0, 12)
  if (patch?.imp !== undefined) row.imp = Math.min(Math.max(Number(patch.imp) || 0, 0), 1)
  if (patch?.emo !== undefined) row.emo = Math.min(Math.max(Number(patch.emo) || 0, 0), 1)
  saveStore(key, rows)
  return row
}

function deleteRow(key, id) {
  const rows = loadStore(key)
  const i = rows.findIndex((r) => r.id === id)
  if (i < 0) return false
  rows.splice(i, 1)
  saveStore(key, rows)
  return true
}

// 冷宫：淡到快没了、又没被想起来的，挪去 cold（不删，能翻回来）
function archiveCold(key, cfg, now = Date.now()) {
  const rows = loadStore(key)
  const keep = []
  const cold = []
  for (const r of rows) {
    const act = aliveness(r, cfg, now)
    if (!isFact(r) && !r.pinned && act < 0.05 && !(Number(r.hits) > 0)) cold.push(r)
    else keep.push(r)
  }
  if (!cold.length) return 0
  saveStore(key, keep)
  const old = readRows(coldPath(key))
  writeRows(coldPath(key), old.concat(cold))
  return cold.length
}

// ───────────────────────── 会话 / 作用域 ─────────────────────────

function sessionIdOf(session) {
  try {
    for (const k of ['id', 'sessionId', 'sid']) if (session && typeof session[k] === 'string' && session[k]) return session[k]
    if (session && session.info && typeof session.info.id === 'string') return session.info.id
  } catch { /* 拿不到就算 */ }
  return ''
}

function workspaceOf(agent) {
  try {
    if (agent && typeof agent.cwd === 'string' && agent.cwd) return agent.cwd
    const s = agent && agent.session
    // DSH 真正的答案在 session.header.cwd（fish-memory 那条经验：header 才是文件系统的答案）
    const hd = s && s.header
    if (hd && typeof hd === 'object') {
      for (const k of ['cwd', 'workspace', 'workspaceDir', 'dir']) if (typeof hd[k] === 'string' && hd[k]) return hd[k]
    }
    if (s && typeof s.requestContext === 'function') {
      const rc = s.requestContext() || {}
      for (const k of ['cwd', 'workspace', 'workspaceDir', 'dir']) if (typeof rc[k] === 'string' && rc[k]) return rc[k]
    }
    for (const k of ['cwd', 'workspace', 'workspaceDir']) if (s && typeof s[k] === 'string' && s[k]) return s[k]
  } catch { /* 同上 */ }
  return ''
}

// 作用域：能认出工作区就按工作区共享（跨会话记得同一件事），认不出退回会话 id
function scopeOf(agent, sid) {
  const ws = workspaceOf(agent)
  if (ws) {
    const base = ws.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
    if (base) return { key: 'ws-' + base, dir: ws }
  }
  return { key: 'sid-' + (sid || 'default'), dir: '' }
}

function allStoreKeys() {
  try {
    ensureDirs()
    return readdirSync(STORE_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6))
  } catch { return [] }
}

// ───────────────────────── 工具（每个 agent 各挂一份）─────────────────────────

function sessionIdFromExec(exec) {
  try {
    const a = exec && (exec.agent || exec.caller || exec.agentRef)
    if (a && a.session) return sessionIdOf(a.session)
  } catch { /* 忽略 */ }
  return ''
}

function makeTools(ctx, agent, sid, scope) {
  const key = scope.key
  return [
    defineTool({
      name: 'tide_remember',
      description: '把一件值得长期记住的事写进记忆（以后相关的时候会被想起来）。'
        + '一条只装一件事；只记长期有价值的：主人明确说的重要的话、约定、喜好、状态、发生过的事。'
        + '日常琐事不用记。安静地记，不要在回复里说「记下了」。'
        + '如果这条是在更新一条旧的同类事实（比如「车还在修」→「车修好了」），把旧那条的 id 填进 supersedes，'
        + '旧的不删、会被标记为「已过时」。',
      parameters: {
        text: { type: 'string', required: true, description: '一句话说清。人称：你自己是「我」，用户是「主人」。' },
        kind: { type: 'string', description: 'event（会淡忘，默认）或 fact（长期事实，永不衰减：喜好、身份、约定）。' },
        importance: { type: 'number', description: '0 随口提过 / 0.5 比较重要 / 1 非常重要。不确定就 0.5。' },
        tags: { type: 'array', items: { type: 'string' }, description: '几个关键词，方便以后被想起来。' },
        emotion: { type: 'number', description: '0~1，这条带多少情绪（带情绪的事淡得更快，但记得更响）。' },
        supersedes: { type: 'string', description: '被这条更新掉的旧记忆 id（可省略）。' },
      },
      // ⚠️ DSH 的 tool 必须有 output.render —— 少了它，注册当场抛
      //    `Cannot read properties of undefined (reading 'render')`（2026-10-23 踩过）
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          if (value && value.ok === false) return [{ type: 'text', text: '✗ ' + String(value.error || '没记上') }]
          return [{ type: 'text', text: '✓' }] // 不能返回空，空结果会让界面卡住
        },
      },
      async execute(args) {
        if (!loadCfg().enabled) return { ok: false, error: '潮汐记忆现在是关着的（设置 → 潮汐记忆）' }
        const row = remember(key, {
          text: args?.text,
          kind: args?.kind,
          imp: args?.importance,
          emo: args?.emotion,
          keys: args?.tags,
          supersedes: args?.supersedes,
          src: sid,
          dir: scope.dir,
        })
        return { ok: true, id: row.id }
      },
    }),
    defineTool({
      name: 'tide_recall',
      description: '主动翻记忆。给一句话当线索，返回最相关的几条（带时间和鲜活度）。',
      parameters: {
        query: { type: 'string', required: true, description: '要找什么，一句话。' },
        limit: { type: 'number', description: '最多几条，默认 6。' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const n = value && Number(value.count)
          if (value && value.ok === false) return [{ type: 'text', text: '✗ 翻不动' }]
          if (!n) return [{ type: 'text', text: '（没翻到相关的）' }]
          const head = (value.rows || []).slice(0, 3).map((r) => String(r.text || '').slice(0, 40)).join(' / ')
          return [{ type: 'text', text: n + ' 条：' + head }]
        },
      },
      async execute(args) {
        const cfg = loadCfg()
        const rows = loadStore(key)
        const { picked } = recall(rows, String(args?.query || ''), cfg)
        const limit = Math.max(1, Math.min(Number(args?.limit) || cfg.maxInject, 20))
        const out = picked.slice(0, limit).map((it) => ({
          id: it.row.id,
          text: it.row.text,
          kind: it.row.kind,
          at: new Date(it.row.t).toISOString(),
          aliveness: Number(it.act.toFixed(2)),
          score: Number(it.C.toFixed(2)),
          importance: it.row.imp,
        }))
        if (out.length) {
          const rows2 = loadStore(key)
          const now = Date.now()
          for (const o of out) {
            const r = rows2.find((x) => x.id === o.id)
            if (r) { r.hits = (Number(r.hits) || 0) + 1; r.last = now }
          }
          saveStore(key, rows2)
        }
        return { ok: true, count: out.length, rows: out }
      },
    }),
    defineTool({
      name: 'tide_forget',
      description: '删掉一条记忆（真删）。不改历史、不留链，除非你确定这条是错的。',
      parameters: { id: { type: 'string', required: true, description: '记忆的 id' } },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: value && value.deleted ? '✓ 删了' : '✗ 没这条' }]
        },
      },
      async execute(args) {
        const ok = deleteRow(key, String(args?.id || ''))
        return { ok, deleted: ok }
      },
    }),
    defineTool({
      name: 'tide_stats',
      description: '看看记忆库里有多少条、最鲜活的是哪几条。',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          if (!value) return [{ type: 'text', text: '（空）' }]
          return [{ type: 'text', text: (value.scope || '') + '：活着的 ' + value.live + ' / 总共 ' + value.total + '（事实 ' + value.facts + '）' }]
        },
      },
      async execute() {
        const cfg = loadCfg()
        const rows = loadStore(key)
        const now = Date.now()
        const live = rows.filter((r) => !r.supersededBy && !r.hidden)
        const ranked = live
          .map((r) => ({ id: r.id, text: r.text.slice(0, 60), kind: r.kind, aliveness: Number(aliveness(r, cfg, now).toFixed(2)) }))
          .sort((a, b) => b.aliveness - a.aliveness)
          .slice(0, 8)
        return { ok: true, scope: key, total: rows.length, live: live.length, facts: live.filter(isFact).length, top: ranked }
      },
    }),
  ]
}

// ───────────────────────── 注入 ─────────────────────────

function renderInjection(picked) {
  if (!picked.length) return ''
  const fmt = (t) => {
    const d = new Date(t)
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  const lines = picked.map((it) => '- ' + fmt(it.row.t) + ' · ' + String(it.row.text).replace(/\s+/g, ' '))
  return '【潮汐记忆】从我自己的记忆库里翻出这几条（按相关度，不是按时间）：\n' + lines.join('\n')
    + '\n只在真的相关时用上；不相关就别硬提，更别说「我记得」。'
}

// ───────────────────────── 插件主体 ─────────────────────────

export function apply(ctx) {
  ensureDirs()
  const mounted = new Map() // sid -> { off, key }
  diag('tide-memory ' + VERSION + ' 启动')

  // ⚠️ offs 由调用方持有：中途任何一步抛错，前面已经挂上的也能被卸掉。
  //    （以前 offs 是这里的局部变量，一旦 makeTools 抛错就整个丢失 → 下一轮 tick 重挂
  //     → `prompt context "tide-memory" is already registered` → 每 2 秒刷一次，永不自愈）
  function mountFor(agent, sid, scope, offs) {
    let lastText = ''

    try {
      offs.push(agent.ctx.on('agent/inbox/inserted', (payload) => {
        const msg = payload && payload.message ? payload.message : payload
        const txt = textOfMessage(msg)
        if (txt) lastText = txt
      }))
    } catch (e) { diag('监听消息失败：' + (e && e.message)) }

    try {
      const disposer = agent.ctx.systemPrompt.context({
        name: 'tide-memory',
        order: 905,
        text: () => {
          try {
            const cfg = loadCfg()
            if (!cfg.enabled || !lastText) return ''
            const rows = loadStore(scope.key)
            if (!rows.length) return ''
            const { picked } = recall(rows, lastText, cfg)
            if (!picked.length) return ''
            appendTrace({
              at: Date.now(), key: scope.key, op: 'inject', query: lastText.slice(0, 120),
              ids: picked.map((p) => p.row.id), why: picked.map((p) => ({ id: p.row.id, C: Number(p.C.toFixed(2)), P: Number(p.P.toFixed(2)), act: Number(p.act.toFixed(2)) })),
            })
            return renderInjection(picked)
          } catch (e) { diag('注入出错：' + (e && e.message)); return '' }
        },
      })
      if (typeof disposer === 'function') offs.push(disposer)
    } catch (e) { diag('注入挂不上：' + (e && e.message)) }

    let tools = []
    try { tools = makeTools(ctx, agent, sid, scope) } catch (e) { diag('造工具失败：' + (e && e.message) + ' / ' + (e && e.stack ? String(e.stack).split('\n')[1] : '')) }
    for (const tool of tools) {
      try {
        const off = agent.ctx.tools.register(tool)
        if (typeof off === 'function') offs.push(off)
      } catch (e) { diag('工具 ' + tool.name + ' 挂不上：' + (e && e.message)) }
    }
    diag('挂好 ' + sid + ' → ' + scope.key + '（工具 ' + tools.length + ' 个，副作用 ' + offs.length + ' 个）')
  }

  function tick() {
    try {
      const cfg = loadCfg()
      const list = ctx.agents.list() || []
      for (const agent of list) {
        const sid = sessionIdOf(agent.session)
        if (!sid) continue
        const scope = scopeOf(agent, sid)
        if (!cfg.enabled) {
          const v = mounted.get(sid)
          if (v) { try { v.off() } catch { /* 忽略 */ } mounted.delete(sid) }
          continue
        }
        const cur = mounted.get(sid)
        if (cur && cur.key === scope.key) continue
        if (cur) { try { cur.off() } catch { /* 忽略 */ } mounted.delete(sid) }
        // 先把收集器放进 mounted，再挂 —— 这样即使挂到一半抛错，
        // 已经注册的副作用也还在手上，下一轮能干净地卸掉重来。
        const offs = []
        const entry = { key: scope.key, off: () => { for (const o of offs) { try { o() } catch { /* 卸不掉就算了，别连坐 */ } } } }
        mounted.set(sid, entry)
        try {
          mountFor(agent, sid, scope, offs)
        } catch (e) {
          diag('挂 ' + sid + ' 失败：' + (e && e.message))
          try { entry.off() } catch { /* 忽略 */ }
          mounted.delete(sid)
        }
      }
    } catch (e) { diag('tick 出错：' + (e && e.message)) }
  }

  try { ctx.timer.interval(tick, 2000) } catch { setTimeout(tick, 500) }

  // 每天清一次冷宫（放 timer 里，插件活着就一直转）
  try {
    ctx.timer.interval(() => {
      try {
        const cfg = loadCfg()
        for (const k of allStoreKeys()) archiveCold(k, cfg)
      } catch { /* 忽略 */ }
    }, 6 * 3600 * 1000)
  } catch { /* 没有 timer 就不清 */ }

  // ───────────── 设置页的 HTTP 接口 ─────────────
  const BASE = '/dsh-tide-memory'
  const mroute = (path, handler) => ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: BASE + path,
    handler: async (req, res) => {
      try { await handler(req, res) } catch (e) {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String(e && e.message) }))
        } catch { /* 客户端断了 */ }
      }
    },
  }))

  const send = (res, v) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(v))
  }

  const readBody = (req) => new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })

  const rowView = (r, cfg, now) => ({
    id: r.id, text: r.text, kind: r.kind, keys: r.keys || [], imp: r.imp || 0, emo: r.emo || 0,
    pinned: !!r.pinned, hits: r.hits || 0, hidden: !!r.hidden, supersededBy: r.supersededBy || '',
    t: r.t, last: r.last, aliveness: Number(aliveness(r, cfg, now).toFixed(3)), dir: r.dir || '', src: r.src || '',
  })

  // 会话 / 作用域列表
  mroute('/sessions', async (req, res) => {
    const cfg = loadCfg()
    const now = Date.now()
    // 文件名会把非 ASCII 折成下划线（ws-DSH插件 → ws-DSH__），
    // 所以按 safeKey 归并，否则同一个库会在列表里出现两行
    const keys = new Map()
    for (const k of allStoreKeys()) keys.set(safeKey(k), k)
    const agents = (ctx.agents.list() || []).map((a) => {
      const sid = sessionIdOf(a.session)
      const scope = scopeOf(a, sid)
      if (scope.key) keys.set(safeKey(scope.key), scope.key)
      return { sid, key: scope.key, dir: scope.dir }
    })
    const rows = [...keys.entries()].map(([sk, key]) => {
      const list = loadStore(sk)
      const live = list.filter((r) => !r.supersededBy && !r.hidden)
      const lastAt = live.reduce((m, r) => Math.max(m, Number(r.last || r.t || 0)), 0)
      const alive = agents.find((a) => safeKey(a.key) === sk) || null
      return { key, count: list.length, live: live.length, lastAt, alive }
    })
    rows.sort((a, b) => b.lastAt - a.lastAt)
    send(res, { ok: true, version: VERSION, cfg, sessions: rows, home: DIR, now })
  })

  mroute('/memories', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = url.searchParams.get('key') || ''
    const q = String(url.searchParams.get('q') || '').trim()
    const filter = String(url.searchParams.get('filter') || 'all')
    const cfg = loadCfg()
    const now = Date.now()
    const rows = loadStore(key)
    let view = rows.map((r) => rowView(r, cfg, now))
    if (filter === 'fact') view = view.filter((r) => r.kind === 'fact')
    else if (filter === 'event') view = view.filter((r) => r.kind !== 'fact')
    else if (filter === 'pinned') view = view.filter((r) => r.pinned)
    else if (filter === 'superseded') view = view.filter((r) => r.supersededBy)
    else if (filter === 'live') view = view.filter((r) => !r.supersededBy && !r.hidden)
    if (q) {
      const qs = tokensOf(q)
      view = view.map((r) => {
        const rt = tokensOf(r.text + ' ' + (r.keys || []).join(' '))
        let s = 0
        for (const w of qs) if (rt.has(w)) s++
        return { ...r, _m: s }
      }).filter((r) => r._m > 0).sort((a, b) => b._m - a._m || b.last - a.last)
    } else {
      view.sort((a, b) => (b.pinned - a.pinned) || (b.last - a.last))
    }
    send(res, { ok: true, key, rows: view, coldCount: readRows(coldPath(key)).length })
  })

  mroute('/remember', async (req, res) => {
    const body = await readBody(req)
    const key = String(body.key || '')
    const row = remember(key, { text: body.text, kind: body.kind, imp: body.imp, emo: body.emo, keys: body.keys, pinned: body.pinned })
    send(res, { ok: true, row })
  })

  mroute('/update', async (req, res) => {
    const body = await readBody(req)
    const row = updateRow(String(body.key || ''), String(body.id || ''), body.patch || {})
    send(res, { ok: !!row, row })
  })

  mroute('/delete', async (req, res) => {
    const body = await readBody(req)
    send(res, { ok: deleteRow(String(body.key || ''), String(body.id || '')) })
  })

  mroute('/archive-now', async (req, res) => {
    const body = await readBody(req)
    const n = archiveCold(String(body.key || ''), loadCfg())
    send(res, { ok: true, moved: n })
  })

  mroute('/trace', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const key = url.searchParams.get('key') || ''
    const all = readRows(TRACE_PATH).filter((t) => !key || t.key === key).slice(-40).reverse()
    send(res, { ok: true, rows: all })
  })

  mroute('/config', async (req, res) => {
    if (req.method === 'GET') return send(res, { ok: true, cfg: loadCfg() })
    const body = await readBody(req)
    const patch = {}
    for (const k of Object.keys(DEFAULTS)) if (k in body) patch[k] = body[k]
    if ('enabled' in patch) patch.enabled = !!patch.enabled
    for (const k of ['halfLifeEventDays', 'halfLifeEmoDays', 'maxInject', 'threshold', 'maxChars']) {
      if (k in patch) patch[k] = Number(patch[k])
    }
    send(res, { ok: true, cfg: saveCfg(patch) })
  })

  diag('路由已挂：' + BASE + '/…')
}

// 给测试用（也是给别人改这个插件时的入口）：不挂在插件上，不影响宿主
export const __test = { tokensOf, recall, remember, loadStore, aliveness, archiveCold, idfOf, scopeOf, weightOf }

function textOfMessage(msg) {
  try {
    if (!msg) return ''
    if (typeof msg === 'string') return msg
    const c = msg.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x && x.text ? x.text : '')).join(' ').trim()
    if (msg.text) return String(msg.text)
  } catch { /* 忽略 */ }
  return ''
}
