// ============================================================
// 解析规则的读写：存数据目录 ai-rules.json（走 store.js，随数据备份一起打包）。
// 读取时与出厂默认合并——代码里新增的字段会自动出现在词典里，不会因为旧文件缺项而漏解析；
// 写入前统一清洗，管理页提交的脏数据（超长、类型不对）不会落盘。
// ============================================================
const store = require('../store');
const { defaults } = require('./defaults');

const KEY = 'ai-rules';
const TYPES = new Set(['num', 'text', 'bool', 'enum', 'table']);
const STATUS = new Set(['on', 'pending', 'off']);

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const strList = (a, max, n) => (Array.isArray(a) ? a : String(a || '').split(/[,，、;；\n]/))
  .map(x => str(x, max)).filter(Boolean).slice(0, n);

function cleanField(f, base) {
  const out = {
    k: base.k,
    label: str(f.label, 40) || base.label,
    type: TYPES.has(f.type) ? f.type : base.type,
    unit: str(f.unit, 10),
    enabled: f.enabled !== false,
    aliases: [...new Set(strList(f.aliases, 40, 60))],
    conv: (Array.isArray(f.conv) ? f.conv : []).map(c => ({ unit: str(c && c.unit, 10), factor: Number(c && c.factor) }))
      .filter(c => c.unit && isFinite(c.factor) && c.factor > 0).slice(0, 20),
    pick: ['actual', 'design'].includes(f.pick) ? f.pick : '',
    note: str(f.note, 500)
  };
  if (base.options) out.options = base.options;
  if (base.cols) out.cols = base.cols;
  out.type = base.type;   // 类型决定前端控件和取值清洗，不允许在管理页改
  return out;
}

function cleanExample(e) {
  const items = (Array.isArray(e.items) ? e.items : []).map(it => ({
    k: str(it && it.k, 40),
    value: it && (typeof it.value === 'number' || typeof it.value === 'boolean') ? it.value : str(it && it.value, 100),
    wrong: it && it.wrong != null && it.wrong !== '' ? str(it.wrong, 100) : '',
    evidence: str(it && it.evidence, 300)
  })).filter(it => it.k).slice(0, 60);
  return {
    id: str(e.id, 40) || ('E' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100)),
    at: Number(e.at) || Date.now(),
    by: str(e.by, 40),
    status: STATUS.has(e.status) ? e.status : 'pending',
    wellNo: str(e.wellNo, 40),
    note: str(e.note, 300),
    items
  };
}

// 清洗 + 与默认合并。fields 保留默认集合中的键，顺序以默认为准，内容以传入为准。
function sanitize(r) {
  const d = defaults();
  r = r && typeof r === 'object' ? r : {};
  const byK = new Map((Array.isArray(r.fields) ? r.fields : []).filter(f => f && f.k).map(f => [f.k, f]));
  return {
    version: 1,
    fields: d.fields.map(base => cleanField(byK.get(base.k) || base, base)),
    terms: (Array.isArray(r.terms) ? r.terms : d.terms)
      .map(t => ({ term: str(t && t.term, 60), kind: str(t && t.kind, 10) || '其他', meaning: str(t && t.meaning, 300) }))
      .filter(t => t.term).slice(0, 500),
    rules: (Array.isArray(r.rules) ? r.rules : d.rules)
      .map(x => ({ text: str(x && x.text, 800), enabled: !(x && x.enabled === false) }))
      .filter(x => x.text).slice(0, 100),
    examples: (Array.isArray(r.examples) ? r.examples : []).filter(e => e && typeof e === 'object').map(cleanExample).slice(-500),
    updatedAt: r.updatedAt || null,
    updatedBy: str(r.updatedBy, 40)
  };
}

function load() {
  return sanitize(store.readJSON(KEY, null) || defaults());
}

function save(r, by) {
  const clean = sanitize(Object.assign({}, r, { updatedAt: new Date().toISOString(), updatedBy: by || '' }));
  store.writeJSON(KEY, clean);
  return clean;
}

// 恢复默认：示例是人工沉淀下来的，不随「恢复默认」清掉
function reset(by) {
  const keep = load().examples;
  return save(Object.assign(defaults(), { examples: keep }), by);
}

function addExample(e, by, isAdmin) {
  const r = load();
  const ex = cleanExample(Object.assign({}, e, { id: '', at: Date.now(), by, status: isAdmin ? 'on' : 'pending' }));
  if (!ex.items.length) throw new Error('示例没有可用的字段纠正');
  r.examples.push(ex);
  store.writeJSON(KEY, sanitize(r));   // 沉淀示例不算一次规则修改，不动修改人/修改时间
  return ex;
}

module.exports = { load, save, reset, addExample, sanitize, defaults };
