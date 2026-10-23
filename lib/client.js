// dsh-tide-memory · 客户端半边（设置 → 潮汐记忆）
window.__ModuleLoader__.load({
  id: 'dsh-tide-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']
    const B = '/dsh-tide-memory'

    const get = (p) => fetch(B + p, { cache: 'no-store' }).then((r) => r.json())
    const post = (p, body) => fetch(B + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json())

    const pad = (n) => String(n).padStart(2, '0')
    const fmt = (t) => {
      if (!t) return '—'
      const d = new Date(Number(t))
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    const rel = (t) => {
      if (!t) return '—'
      const days = Math.floor((Date.now() - Number(t)) / 86400000)
      if (days <= 0) return '今天 ' + fmt(t).slice(6)
      if (days === 1) return '昨天 ' + fmt(t).slice(6)
      if (days < 30) return days + ' 天前'
      const m = Math.floor(days / 30)
      return m + ' 个月前'
    }

    const S = {
      wrap: { padding: '2px 0 24px', fontSize: 13, lineHeight: 1.6 },
      h: { fontWeight: 600, margin: '16px 0 6px', fontSize: 13 },
      dim: { color: 'var(--dsh-text-secondary, #888)', fontSize: 12 },
      card: { border: '1px solid var(--dsh-border, #e3e3e3)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: { border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '5px 8px', fontSize: 13, background: 'transparent', color: 'inherit' },
      ta: { width: '100%', minHeight: 52, border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '6px 8px', fontSize: 13, fontFamily: 'inherit', background: 'transparent', color: 'inherit', resize: 'vertical' },
      btn: { border: '1px solid var(--dsh-border, #ddd)', borderRadius: 6, padding: '3px 9px', fontSize: 12, cursor: 'pointer', background: 'transparent', color: 'inherit' },
      btnPri: { border: '1px solid var(--dsh-accent, #4a7dff)', borderRadius: 6, padding: '5px 12px', fontSize: 12, cursor: 'pointer', background: 'var(--dsh-accent, #4a7dff)', color: '#fff' },
      badge: { display: 'inline-block', fontSize: 11, padding: '0 6px', borderRadius: 999, border: '1px solid currentColor', opacity: 0.75, marginRight: 4 },
      bar: { height: 4, borderRadius: 2, background: 'var(--dsh-border, #eee)', overflow: 'hidden', width: 80, display: 'inline-block', verticalAlign: 'middle' },
    }

    const Bars = (props) => {
      const pct = Math.max(0, Math.min(1, Number(props.v) || 0)) * 100
      const color = pct > 60 ? '#3fa96a' : pct > 25 ? '#d5a020' : '#b06060'
      return h('span', { style: S.bar, title: '鲜活度 ' + Math.round(pct) + '%' },
        h('span', { style: { display: 'block', height: '100%', width: pct + '%', background: color } }))
    }

    function MemoryRow(props) {
      const { m, onAct } = props
      const [editing, setEditing] = React.useState(false)
      const [text, setText] = React.useState(m.text)
      React.useEffect(() => { setText(m.text) }, [m.id])
      const dead = !!m.supersededBy
      return h('div', { style: Object.assign({}, S.card, dead ? { opacity: 0.55 } : null) },
        editing
          ? h('div', null,
            h('textarea', { style: S.ta, value: text, onChange: (e) => setText(e.target.value) }),
            h('div', { style: Object.assign({}, S.row, { marginTop: 6 }) },
              h('button', { style: S.btnPri, onClick: () => { onAct('update', m, { text }); setEditing(false) } }, '保存'),
              h('button', { style: S.btn, onClick: () => setEditing(false) }, '取消')))
          : h('div', { style: { whiteSpace: 'pre-wrap' } }, m.text),
        h('div', { style: Object.assign({}, S.row, { marginTop: 6 }) },
          h('span', { style: S.badge }, m.kind === 'fact' ? '事实' : '事件'),
          m.pinned ? h('span', { style: S.badge }, '钉住') : null,
          dead ? h('span', { style: S.badge }, '已过时') : null,
          m.emo > 0 ? h('span', { style: S.badge }, '带情绪') : null,
          h('span', { style: S.dim }, rel(m.last || m.t)),
          h('span', { style: S.dim }, '冲动 ' + Math.round(m.aliveness * 100) + '%'),
          h(Bars, { v: m.aliveness }),
          h('span', { style: S.dim }, '被想起 ' + (m.hits || 0) + ' 次'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: () => onAct('update', m, { pinned: !m.pinned }) }, m.pinned ? '取消钉住' : '钉住'),
          h('button', { style: S.btn, onClick: () => setEditing(true) }, '改'),
          dead ? null : h('button', { style: S.btn, onClick: () => onAct('supersede', m) }, '标过时'),
          h('button', { style: S.btn, onClick: () => { if (confirm('真删？删了就找不回来了。\n（想保留历史用「标过时」）')) onAct('delete', m) } }, '删'))
      )
    }

    function Section() {
      const [loading, setLoading] = React.useState(true)
      const [cfg, setCfg] = React.useState(null)
      const [sessions, setSessions] = React.useState([])
      const [key, setKey] = React.useState('')
      const [rows, setRows] = React.useState([])
      const [cold, setCold] = React.useState(0)
      const [q, setQ] = React.useState('')
      const [filter, setFilter] = React.useState('live')
      const [draft, setDraft] = React.useState('')
      const [kind, setKind] = React.useState('event')
      const [imp, setImp] = React.useState(0.5)
      const [msg, setMsg] = React.useState('')
      const [trace, setTrace] = React.useState([])
      const [showTrace, setShowTrace] = React.useState(false)
      const [showCfg, setShowCfg] = React.useState(false)

      const loadSessions = React.useCallback(async () => {
        const r = await get('/sessions')
        if (!r || !r.ok) { setMsg('读不到：' + (r && r.error)); setLoading(false); return }
        setCfg(r.cfg)
        setSessions(r.sessions || [])
        setLoading(false)
        setKey((cur) => cur || (r.sessions && r.sessions[0] && r.sessions[0].key) || '')
      }, [])

      const loadRows = React.useCallback(async (k, query, f) => {
        if (!k) return
        const r = await get('/memories?key=' + encodeURIComponent(k) + '&q=' + encodeURIComponent(query || '') + '&filter=' + (f || 'all'))
        if (r && r.ok) { setRows(r.rows || []); setCold(r.coldCount || 0) }
      }, [])

      React.useEffect(() => { loadSessions() }, [])
      React.useEffect(() => { loadRows(key, q, filter) }, [key, filter])
      React.useEffect(() => {
        const t = setTimeout(() => loadRows(key, q, filter), 250)
        return () => clearTimeout(t)
      }, [q])

      const act = async (what, m, patch) => {
        if (what === 'delete') await post('/delete', { key, id: m.id })
        else if (what === 'update') await post('/update', { key, id: m.id, patch: patch || {} })
        else if (what === 'supersede') {
          const nid = prompt('这条被哪条新的决定了？填新记忆的 id（没有就先在下面添加新的一条，再把 id 填这里）')
          if (!nid) return
          await post('/update', { key, id: m.id, patch: { supersededBy: String(nid).trim() } })
        }
        loadRows(key, q, filter)
        loadSessions()
      }

      const add = async () => {
        const text = draft.trim()
        if (!text) return
        const r = await post('/remember', { key, text, kind, imp })
        if (r && r.ok) { setDraft(''); setMsg('记下了 —— ' + r.row.id) }
        else setMsg('没记上：' + (r && r.error))
        loadRows(key, q, filter)
        loadSessions()
      }

      const saveCfg = async (patch) => {
        const r = await post('/config', patch)
        if (r && r.ok) { setCfg(r.cfg); setMsg('设置已保存') } else setMsg('保存失败')
      }

      if (loading) return h('div', { style: S.wrap }, h('div', { style: S.dim }, '正在读记忆库…'))
      if (!cfg) return h('div', { style: S.wrap }, h('div', { style: S.dim }, '读不到配置：' + msg))

      const cur = sessions.find((s) => s.key === key) || {}
      const live = rows.filter((r) => !r.supersededBy && !r.hidden).length
      const facts = rows.filter((r) => r.kind === 'fact' && !r.supersededBy).length

      const filterBtns = [
        ['live', '还在的'], ['fact', '事实'], ['event', '事件'], ['pinned', '钉住的'], ['superseded', '已过时'], ['all', '全部'],
      ]

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('div', { style: { fontWeight: 600, fontSize: 14 } }, '潮汐记忆'),
          h('span', { style: S.dim }, cfg.enabled ? '开着' : '关着'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: () => { setShowTrace(!showTrace); if (!showTrace) get('/trace?key=' + encodeURIComponent(key)).then((r) => setTrace((r && r.rows) || [])) } }, showTrace ? '收起「怎么想起来的」' : '看它怎么想起来的'),
          h('button', { style: S.btn, onClick: () => setShowCfg(!showCfg) }, showCfg ? '收起设置' : '设置')),

        h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
          h('span', { style: S.dim }, '记忆库'),
          h('select', { style: S.input, value: key, onChange: (e) => setKey(e.target.value) },
            sessions.length
              ? sessions.map((s) => h('option', { key: s.key, value: s.key },
                s.key + '（' + s.live + ' 条' + (s.lastAt ? ' · ' + rel(s.lastAt) : '') + '）'))
              : h('option', { value: '' }, '（还没有记忆库）')),
          h('span', { style: S.dim }, '共 ' + rows.length + ' 条 · 还在的 ' + live + ' · 事实 ' + facts + ' · 冷宫 ' + cold)),

        h('div', { style: Object.assign({}, S.card, { marginTop: 10 }) },
          h('div', { style: S.h, marginTop: 0 }, '手动记一条'),
          h('textarea', {
            style: S.ta, value: draft, placeholder: '一条只装一件事。例：主人不喜欢别人替他做决定，要先问。',
            onChange: (e) => setDraft(e.target.value),
          }),
          h('div', { style: Object.assign({}, S.row, { marginTop: 6 }) },
            h('select', { style: S.input, value: kind, onChange: (e) => setKind(e.target.value) },
              h('option', { value: 'event' }, '事件（会淡忘）'),
              h('option', { value: 'fact' }, '事实（不淡忘）')),
            h('select', { style: S.input, value: String(imp), onChange: (e) => setImp(Number(e.target.value)) },
              h('option', { value: '0.2' }, '随口提过'),
              h('option', { value: '0.5' }, '比较重要'),
              h('option', { value: '1' }, '非常重要')),
            h('button', { style: S.btnPri, onClick: add }, '记下'),
            msg ? h('span', { style: S.dim }, msg) : null)),

        h('div', { style: Object.assign({}, S.row, { marginTop: 12 }) },
          h('input', { style: Object.assign({}, S.input, { flex: 1, minWidth: 140 }), value: q, placeholder: '搜记忆里的词…', onChange: (e) => setQ(e.target.value) }),
          filterBtns.map(([v, label]) => h('button', {
            key: v,
            style: Object.assign({}, S.btn, filter === v ? { borderColor: 'var(--dsh-accent, #4a7dff)', color: 'var(--dsh-accent, #4a7dff)' } : null),
            onClick: () => setFilter(v),
          }, label)),
          h('button', { style: S.btn, onClick: () => post('/archive-now', { key }).then(() => { loadRows(key, q, filter); setMsg('清过冷宫了') }) }, '清冷宫')),

        h('div', { style: { marginTop: 10 } },
          rows.length
            ? rows.map((m) => h(MemoryRow, { key: m.id, m, onAct: act }))
            : h('div', { style: S.dim }, q ? '没搜到。' : '这个库里还没有记忆 —— 跟它说点值得记住的事，或者在上面手动记一条。')),

        showTrace ? h('div', { style: Object.assign({}, S.card, { marginTop: 12 }) },
          h('div', { style: S.h, marginTop: 0 }, '它最近是怎么想起东西的'),
          h('div', { style: S.dim }, '「C」是证据够不够（低于阈值的根本不进），「P」是排多前。'),
          (trace || []).map((t, i) => h('div', { key: i, style: { marginTop: 6, fontSize: 12 } },
            h('div', { style: S.dim }, fmt(t.at) + ' · ' + (t.op === 'inject' ? '注入' : t.op) + (t.query ? ' · 线索：' + t.query : '')),
            t.ids && t.ids.length ? h('div', null, '想起来 ' + t.ids.length + ' 条：' + (t.why || []).map((w) => w.id + '(C' + w.C + ' P' + w.P + ')').join('、')) : null)),
          !(trace || []).length ? h('div', { style: S.dim }, '还没有记录。') : null) : null,

        showCfg ? h('div', { style: Object.assign({}, S.card, { marginTop: 12 }) },
          h('div', { style: S.h, marginTop: 0 }, '设置'),
          h('div', { style: S.row },
            h('label', { style: S.row },
              h('input', { type: 'checkbox', checked: !!cfg.enabled, onChange: (e) => saveCfg({ enabled: e.target.checked }) }),
              h('span', null, '开启潮汐记忆'))),
          h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
            h('span', { style: S.dim }, '事件半衰期（天）'),
            h('input', { style: Object.assign({}, S.input, { width: 70 }), type: 'number', value: cfg.halfLifeEventDays, onChange: (e) => setCfg(Object.assign({}, cfg, { halfLifeEventDays: Number(e.target.value) })), onBlur: (e) => saveCfg({ halfLifeEventDays: Number(e.target.value) }) }),
            h('span', { style: S.dim }, '带情绪的半衰期'),
            h('input', { style: Object.assign({}, S.input, { width: 70 }), type: 'number', value: cfg.halfLifeEmoDays, onChange: (e) => setCfg(Object.assign({}, cfg, { halfLifeEmoDays: Number(e.target.value) })), onBlur: (e) => saveCfg({ halfLifeEmoDays: Number(e.target.value) }) })),
          h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
            h('span', { style: S.dim }, '每轮最多想起来'),
            h('input', { style: Object.assign({}, S.input, { width: 70 }), type: 'number', value: cfg.maxInject, onChange: (e) => setCfg(Object.assign({}, cfg, { maxInject: Number(e.target.value) })), onBlur: (e) => saveCfg({ maxInject: Number(e.target.value) }) }),
            h('span', { style: S.dim }, '条 · 证据阈值'),
            h('input', { style: Object.assign({}, S.input, { width: 80 }), type: 'number', step: '0.05', value: cfg.threshold, onChange: (e) => setCfg(Object.assign({}, cfg, { threshold: Number(e.target.value) })), onBlur: (e) => saveCfg({ threshold: Number(e.target.value) }) }),
            h('span', { style: S.dim }, '· 字数上限'),
            h('input', { style: Object.assign({}, S.input, { width: 80 }), type: 'number', value: cfg.maxChars, onChange: (e) => setCfg(Object.assign({}, cfg, { maxChars: Number(e.target.value) })), onBlur: (e) => saveCfg({ maxChars: Number(e.target.value) }) })),
          h('div', { style: Object.assign({}, S.dim, { marginTop: 8 }) },
            '证据不够的记忆不会进上下文（宁可少想）；鲜活度只决定排多前。事实类不衰减，事件会慢慢淡下去，淡到底的会被挪进冷宫（没删）。')) : null
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'tide-memory', order: 52, label: () => '潮汐记忆' },
        () => h('div', null, h(Section)),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
