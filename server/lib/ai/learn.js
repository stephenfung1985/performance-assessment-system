// ============================================================
// AI 学习规则：让本地词典「越用越准」。
// 每次大模型解析成功后，找出本地词典没拿到、大模型拿到了的字段，回到原文里看它叫什么，
// 把「资料写作 X → 字段 Y」「单位 u × 系数」记成候选规则，存数据目录 ai-learned.json，
// 和人工调教的 ai-rules.json 分开存、分开展示。
//
// 防污染：
//   1. 只从大模型高置信度（≥ AI_LEARN_MIN_CONF，默认 0.7）、原文依据能找到、没有任何校验告警的结果里学
//   2. 候选叫法要「复现」：只拿这个叫法跑一遍本地词典，必须得到和大模型一样的值才记下；
//      单位换算只在大模型标的原单位和本地读到的单位一致时学，系数只认 10 的整数次幂、24、60 这类常见换算（不学 ×1）
//   3. 候选先进待审核；同一条规则被不同资料印证够次数（AI_LEARN_AUTO，默认 3 份；0 = 不自动）
//      且没被反驳、没和别的字段抢同一个叫法，才自动生效。管理员可随时采纳、驳回、撤销
//   4. 已生效的学习规则让本地命中后，大模型又给出不同的值，记一次反驳；自动生效的规则被反驳就退回待审核
// 生效的规则在解析时追加在人工别名、人工单位换算之后（人工的优先），本地命中时标「AI 学习规则」。
// ============================================================
const crypto = require('crypto');
const store = require('../store');
const parse = require('./parse');

const KEY = 'ai-learned';
const MIN_CONF = Number(process.env.AI_LEARN_MIN_CONF) || 0.7;
const AUTO_DEFAULT = process.env.AI_LEARN_AUTO !== undefined && process.env.AI_LEARN_AUTO !== '' && isFinite(+process.env.AI_LEARN_AUTO)
  ? Math.max(0, Math.round(+process.env.AI_LEARN_AUTO)) : 3;
const MAX_ITEMS = 500;
const MAX_DOCS = 50;        // 每条规则最多记多少份资料的指纹（够判断「几份不同资料印证」就行）
const MAX_SAMPLES = 5;
const MAX_CANDS = 15;       // 每个字段最多试几个候选叫法
const NICE = [1, 10, 100, 1000, 10000, 100000, 0.1, 0.01, 0.001, 0.0001, 24, 1 / 24, 60, 1 / 60, 1 / 1440];
const STATUS = new Set(['pending', 'on', 'off']);

const squash = s => String(s == null ? '' : s).replace(/[\s|｜]+/g, '').toLowerCase();
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const docHash = docs => crypto.createHash('sha1').update(JSON.stringify(docs.map(d => d.text))).digest('hex').slice(0, 12);
const itemKey = x => [x.k, x.alias || '', x.conv ? x.conv.unit + '×' + x.conv.factor : ''].join('|');
const niceFactor = v => isFinite(v) && v > 0 ? NICE.find(n => Math.abs(v / n - 1) < 1e-3) : undefined;

function same(f, a, b) {
  if (f.type === 'num') return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  return squash(a) === squash(b);
}

// ---------------- 读写 ----------------
function cleanItem(x) {
  const conv = x.conv && str(x.conv.unit, 10) && isFinite(+x.conv.factor) && +x.conv.factor > 0 ? { unit: str(x.conv.unit, 10), factor: +x.conv.factor } : null;
  const docs = (Array.isArray(x.docs) ? x.docs : []).map(h => str(h, 16)).filter(Boolean).slice(-MAX_DOCS);
  return {
    id: str(x.id, 40) || ('L' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100)),
    k: str(x.k, 40),
    alias: str(x.alias, 40),
    conv,
    status: STATUS.has(x.status) ? x.status : 'pending',
    auto: x.auto === true,
    hits: Math.max(Number(x.hits) || 0, docs.length),
    docs,
    against: Math.max(0, Number(x.against) || 0),
    used: Math.max(0, Number(x.used) || 0),
    samples: (Array.isArray(x.samples) ? x.samples : []).map(s => ({
      at: Number(s && s.at) || 0, file: str(s && s.file, 120), wellNo: str(s && s.wellNo, 40),
      evidence: str(s && s.evidence, 200), value: s && typeof s.value === 'number' ? s.value : str(s && s.value, 100)
    })).slice(-MAX_SAMPLES),
    firstAt: Number(x.firstAt) || Date.now(),
    lastAt: Number(x.lastAt) || Date.now(),
    decidedBy: str(x.decidedBy, 40),
    decidedAt: Number(x.decidedAt) || 0,
    note: str(x.note, 200)
  };
}

function load() {
  const d = store.readJSON(KEY, null) || {};
  return {
    version: 1,
    autoHits: d.autoHits != null && isFinite(+d.autoHits) ? Math.max(0, Math.min(20, Math.round(+d.autoHits))) : AUTO_DEFAULT,
    items: (Array.isArray(d.items) ? d.items : []).filter(x => x && x.k && (x.alias || x.conv)).map(cleanItem).slice(-MAX_ITEMS),
    updatedAt: d.updatedAt || null
  };
}

function save(d) {
  d.updatedAt = new Date().toISOString();
  // 超出上限先丢最早的待审核/已驳回，生效的不丢
  while (d.items.length > MAX_ITEMS) {
    const i = d.items.findIndex(x => x.status !== 'on');
    d.items.splice(i < 0 ? 0 : i, 1);
  }
  store.writeJSON(KEY, d);
  return d;
}

// 人工词典里已经占用的叫法 → 字段键
function takenNames(rules) {
  const m = new Map();
  rules.fields.forEach(f => [f.label, ...f.aliases].forEach(n => { if (n && !m.has(n)) m.set(n, f.k); }));
  return m;
}

// 同一个叫法被学成了不同字段的候选（驳回的不算）
function conflicts(d) {
  const by = new Map();
  d.items.filter(x => x.alias && x.status !== 'off').forEach(x => {
    if (!by.has(x.alias)) by.set(x.alias, new Set());
    by.get(x.alias).add(x.k);
  });
  return x => x.alias && by.has(x.alias) && by.get(x.alias).size > 1 ? [...by.get(x.alias)].filter(k => k !== x.k) : [];
}

// ---------------- 解析时合并 ----------------
// 返回人工规则的副本，把生效的学习规则追加在后面；字段上挂 learned / learnedConv 供本地词典标注来源
function apply(rules) {
  const d = load();
  const out = Object.assign({}, rules, {
    fields: rules.fields.map(f => Object.assign({}, f, { aliases: f.aliases.slice(), conv: f.conv.slice() })),
    learnedAt: null
  });
  const taken = takenNames(rules);
  d.items.filter(x => x.status === 'on').forEach(x => {
    const f = out.fields.find(y => y.k === x.k);
    if (!f) return;
    if (x.alias && !taken.has(x.alias)) {
      f.aliases.push(x.alias); taken.set(x.alias, f.k);
      (f.learned = f.learned || {})[x.alias] = x.id;
    }
    if (x.conv && f.type === 'num' && !f.conv.some(c => squash(c.unit) === squash(x.conv.unit))) {
      f.conv.push(x.conv);
      (f.learnedConv = f.learnedConv || {})[x.conv.unit] = x.id;
    }
  });
  // 只随「生效的学习规则」变化，进解析缓存的键：计数、待审核候选变了不该让缓存失效
  out.learnedAt = crypto.createHash('sha1').update(JSON.stringify(d.items.filter(x => x.status === 'on').map(itemKey))).digest('hex').slice(0, 12);
  return out;
}

// ---------------- 从原文里找候选叫法 ----------------
const LEAD_NO = /^(?:[一二三四五六七八九十\d]+[、.．]|[（(][一二三四五六七八九十\d]+[）)]|第[一二三四五六七八九十\d]+[章节条])\s*/;
function cleanLabel(s) {
  s = String(s || '').trim().replace(LEAD_NO, '')
    .replace(/\s*[（(][^）)]{0,10}[）)]\s*$/, '')   // 「完钻设计深度（m）」的单位
    .replace(/\s*\/\s*\S{1,6}$/, '')                // 「井深/m」
    .replace(/[:：=]+$/, '').trim();
  if (s.length < 2 || s.length > 20 || /\d/.test(s) || !/[一-龥a-zA-Z]/.test(s)) return '';
  return s;
}

function labelsInLine(line) {
  const out = [];
  line.split(/\s*[|｜]\s*/).forEach(cell => {
    for (const m of cell.matchAll(/([^\s:：=|｜，,;；。、]{2,24}?)\s*(?:[（(][^）)]{0,10}[）)])?\s*[:：=]/g)) out.push(m[1]);
    if (!/\d/.test(cell) && cell.length <= 24) out.push(cell);
  });
  return out;
}

// 依据所在的行（连同表格的表头行）里出现过的「名称」
function labelsNear(docs, evidence) {
  const segs = String(evidence || '').split(/…|\.{3}/).map(squash).filter(s => s.length >= 2);
  const out = [];
  if (!segs.length) return out;
  labelsInLine(String(evidence)).forEach(l => out.push(l));
  docs.forEach(d => {
    const lines = String(d.text || '').split('\n');
    lines.forEach((line, i) => {
      const sl = squash(line);
      if (!sl || !segs.some(s => sl.includes(s) || (sl.length >= 4 && s.includes(sl)))) return;
      labelsInLine(line).forEach(l => out.push(l));
      if (!line.includes('|') && !line.includes('｜')) return;
      const n = line.split(/[|｜]/).length;
      for (let up = i - 1; up >= Math.max(0, i - 30); up--) {
        const h = lines[up];
        if (!/[|｜]/.test(h)) break;
        if (!/\d/.test(h) && h.split(/[|｜]/).length === n) { labelsInLine(h).forEach(l => out.push(l)); break; }
      }
    });
  });
  return [...new Set(out.map(cleanLabel).filter(Boolean))];
}

// 只拿一个候选叫法跑本地词典，看能不能复现大模型的值
function tryLabel(rules, f, label, docs, ctx) {
  const sim = Object.assign({}, rules, {
    fields: rules.fields.map(y => y.k === f.k ? Object.assign({}, y, { label, aliases: [], learned: null }) : Object.assign({}, y, { enabled: false }))
  });
  return parse.localParse(sim, docs, ctx).fields[f.k] || null;
}

// 本地读到的数单位不在词典里（unconverted）：大模型标的原单位得和本地读到的一样，系数得是常见换算
function convFrom(ai, got) {
  if (!got.unconverted || !got.unit || squash(got.unit) !== squash(ai.unit)) return null;
  const factor = niceFactor(ai.value / got.value);
  return factor && factor !== 1 ? { unit: got.unit, factor } : null;   // ×1 多半是模型没换算，不学
}

function candidates(rules, f, docs, ai, local, ctx, taken) {
  // 叫法本地认得，但单位不在词典里：只学单位换算
  if (local && local.unconverted) {
    const conv = f.type === 'num' && convFrom(ai, local);
    return conv ? [{ alias: '', conv }] : [];
  }
  if (local) return [];   // 本地认得叫法却取了别的值：不是叫法的问题，学不了
  const otherNames = [...taken.entries()].filter(([, k]) => k !== f.k).map(([n]) => n);
  const ev = squash(ai.evidence);
  const labels = labelsNear(docs, ai.evidence)
    .filter(l => !taken.has(l) && !otherNames.some(n => n !== l && n.includes(l)))   // 别的字段名的一部分（如「井深」）太泛，不学
    .sort((a, b) => (ev.includes(squash(b)) - ev.includes(squash(a))) || b.length - a.length)
    .slice(0, MAX_CANDS);
  for (const label of labels) {
    const got = tryLabel(rules, f, label, docs, ctx);
    if (!got) continue;
    if (!got.unconverted && same(f, got.value, ai.value)) return [{ alias: label, conv: null }];
    const conv = f.type === 'num' && convFrom(ai, got);
    if (conv) return [{ alias: label, conv }];
  }
  return [];
}

// 大模型给出、且没有任何校验告警的字段才拿来学。例外：只有「原单位不在词典里」一条——正是要学的单位换算，
// 这时系统把置信度压到了 0.4，按模型自评的置信度（modelConf）判断
const UNKNOWN_UNIT = /^原单位「.+」不在词典里/;
const fromModel = x => x && Array.isArray(x.flags) && (x.flags.every(t => /^已按/.test(t)) || (x.flags.length === 1 && UNKNOWN_UNIT.test(x.flags[0])));
const confOf = x => x.flags.length === 1 && UNKNOWN_UNIT.test(x.flags[0]) && x.modelConf != null ? x.modelConf : x.conf;

function autoAdopt(d) {
  if (!d.autoHits) return 0;
  const conf = conflicts(d);
  let n = 0;
  d.items.forEach(x => {
    if (x.status !== 'pending' || x.hits < d.autoHits || x.against || conf(x).length) return;
    Object.assign(x, { status: 'on', auto: true, decidedAt: Date.now(), decidedBy: '', note: '' }); n++;
  });
  return n;
}

// ---------------- 每次解析后调用 ----------------
// rules 是 apply() 合并后的规则（解析用的同一份）；返回本次学到/印证/反驳了几条，供前端提示
function observe(rules, docs, r) {
  if (!r || r.cached || !r.fields) return null;
  docs = docs.filter(d => d && String(d.text || '').trim());
  if (!docs.length) return null;
  const ctx = parse.context();
  const local = parse.localParse(rules, docs, ctx).fields;
  const d = load();
  const byId = new Map(d.items.map(x => [x.id, x]));
  const stat = { added: 0, confirmed: 0, auto: 0, against: 0, used: 0 };
  let dirty = false;

  // 学习规则在本地被用上了几次（本地模式，或 AI 模式下本地直接定下、没问大模型的）
  Object.entries(local).forEach(([k, x]) => {
    const it = x.learnedId && byId.get(x.learnedId), got = r.fields[k];
    if (!it || !got) return;
    if (r.mode === 'local' || got.flags.some(t => /本地词典直接命中/.test(t))) { it.used++; stat.used++; dirty = true; }
  });

  if (r.mode === 'ai') {
    const hash = docHash(docs), now = Date.now();
    const wellNo = r.fields.wellNo ? str(r.fields.wellNo.value, 40) : '';
    const taken = takenNames(rules);
    const byKey = new Map(d.items.map(x => [itemKey(x), x]));
    Object.entries(r.fields).forEach(([k, x]) => {
      const f = rules.fields.find(y => y.k === k);
      if (!f || !f.enabled || f.type === 'table' || !fromModel(x) || !(confOf(x) >= MIN_CONF)) return;
      const L = local[k];
      if (L && !L.unconverted && same(f, L.value, x.value)) return;   // 本地已经对了
      if (L && L.learnedId && byId.has(L.learnedId)) {                 // 学习规则让本地取错了
        // 两边只差一个常见换算系数，是单位口径没对齐，不是叫法认错了，不算反驳
        if (f.type === 'num' && niceFactor(Math.abs(x.value / L.value)) && niceFactor(Math.abs(x.value / L.value)) !== 1) return;
        const it = byId.get(L.learnedId);
        it.against++; stat.against++; dirty = true;
        if (it.status === 'on' && it.auto) Object.assign(it, { status: 'pending', auto: false, note: '自动生效后被大模型结果反驳，已退回待审核' });
        return;
      }
      candidates(rules, f, docs, x, L, ctx, taken).forEach(c => {
        const key = itemKey(Object.assign({ k }, c));
        let it = byKey.get(key);
        const sample = { at: now, file: x.file, wellNo, evidence: x.evidence, value: x.value };
        if (!it) {
          it = cleanItem({ k, alias: c.alias, conv: c.conv, docs: [hash], hits: 1, samples: [sample], firstAt: now, lastAt: now });
          d.items.push(it); byKey.set(key, it); byId.set(it.id, it); stat.added++; dirty = true;
          return;
        }
        if (it.docs.includes(hash)) return;   // 同一批资料重复解析不算多一次印证
        it.docs = it.docs.concat(hash).slice(-MAX_DOCS); it.hits++; it.lastAt = now;
        it.samples = it.samples.concat(sample).slice(-MAX_SAMPLES);
        stat.confirmed++; dirty = true;
      });
    });
    const n = autoAdopt(d);
    if (n) { stat.auto = n; dirty = true; }
  }
  if (dirty) save(d);
  return stat;
}

// ---------------- 管理页 ----------------
function view(rules) {
  const d = load(), conf = conflicts(d), taken = takenNames(rules);
  const label = Object.fromEntries(rules.fields.map(f => [f.k, f.label]));
  return {
    autoHits: d.autoHits, minConf: MIN_CONF, updatedAt: d.updatedAt,
    items: d.items.map(x => Object.assign({}, x, {
      docs: undefined,
      label: label[x.k] || x.k,
      conflict: conf(x).map(k => label[k] || k),
      inDict: !!(x.alias && taken.get(x.alias) === x.k),          // 人工词典里已经有了，这条可以删
      clash: x.alias && taken.has(x.alias) && taken.get(x.alias) !== x.k ? (label[taken.get(x.alias)] || taken.get(x.alias)) : ''
    })).reverse()
  };
}

function act(id, action, by) {
  const d = load();
  const i = d.items.findIndex(x => x.id === id);
  if (i < 0) throw Object.assign(new Error('没有这条学习规则'), { status: 404 });
  const x = d.items[i];
  const mark = (status, note) => Object.assign(x, { status, auto: false, decidedBy: by || '', decidedAt: Date.now(), note: note || '' });
  if (action === 'adopt') mark('on');
  else if (action === 'reject') mark('off');
  else if (action === 'revoke') mark('pending', '已撤销');
  else if (action === 'delete') d.items.splice(i, 1);
  else throw Object.assign(new Error('不认识的操作'), { status: 400 });
  save(d);
  return x;
}

function setAuto(n) {
  const d = load();
  d.autoHits = Math.max(0, Math.min(20, Math.round(Number(n) || 0)));
  autoAdopt(d);
  save(d);
  return d.autoHits;
}

module.exports = { load, apply, observe, view, act, setAuto, labelsNear, MIN_CONF };
