// ============================================================
// 解析编排：拼提示词 → 调大模型 → 校验/换算/打置信度；
// 另有一套不出网的「本地词典解析」，只按字段词典的叫法在表格和「名称：数值」里找值，
// 用于没配大模型、或资料涉密不愿外发时兜底。两条路输出同一结构：
//   fields: { <S.w 键>: { value, conf, evidence, file, unit, flags[] } }
// ============================================================
const store = require('../store');
const llm = require('./llm');

const MAX_EXAMPLES = Number(process.env.AI_MAX_EXAMPLES) || 12;
const squash = s => String(s == null ? '' : s).replace(/[\s|｜]+/g, '').toLowerCase();
const round = n => Math.round(n * 10000) / 10000;
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
const WELLTYPE_SYN = [[/水平/, '水平井'], [/定向|斜/, '定向井'], [/直井|垂直/, '直井']];

// 定额库里的队号、区块是动态的，解析时现取，给大模型当候选
function context() {
  const q = store.readJSON('quota', null) || {};
  return {
    teams: (q.rigs || []).map(r => String(r.team)),
    blocks: [...new Set((q.blocks || []).map(b => String(b.block)))]
  };
}

function optionsOf(f, ctx) {
  if (f.k === 'team') return ctx.teams;
  return f.options || null;
}

// ---------------- 提示词 ----------------
function describeField(f, ctx) {
  const t = f.type === 'num' ? '数值' + (f.unit ? '，单位：' + f.unit : '') : f.type === 'bool' ? '是/否（输出 true/false）' : f.type === 'enum' ? '枚举' : '文本';
  const parts = [f.k + '｜' + f.label + '｜' + t];
  const opts = optionsOf(f, ctx);
  if (opts && opts.length) parts.push('候选值：' + opts.join('、'));
  if (f.k === 'block' && ctx.blocks.length) parts.push('定额库已有区块：' + ctx.blocks.join('、'));
  if (f.aliases.length) parts.push('也叫：' + f.aliases.join('、'));
  if (f.conv.length) parts.push('单位换算：' + f.conv.map(c => c.unit + '×' + round(c.factor)).join('，'));
  if (f.pick) parts.push(f.pick === 'design' ? '取设计值' : '取实际值');
  if (f.note) parts.push(f.note);
  return '- ' + parts.join('｜');
}

function buildPrompt(rules, docs, ctx) {
  const fields = rules.fields.filter(f => f.enabled);
  const label = Object.fromEntries(rules.fields.map(f => [f.k, f.label]));
  const exs = rules.examples.filter(e => e.status === 'on').slice(-MAX_EXAMPLES);
  const sys = [
    '你是渤海钻探第三钻井公司（大港油区）单井经营考核的资料录入助手，任务是从单井资料中抽取「单井参数录入表」的字段值。',
    '要求：',
    '1. 只依据资料原文，不推测、不补全；资料里找不到的字段不要输出。',
    '2. 每个字段输出 value（换算到目标单位后的值）、unit（资料中的原始单位）、conf（0~1 的置信度）、evidence（从原文逐字摘录的依据，不超过 80 字，必须能在原文中原样找到）、file（依据所在的文件名）。',
    '3. 严格遵守下面的字段词典、术语表和数据理解规则。「人工纠正示例」是考核办公室确认过的口径，与你的常识冲突时以示例为准。',
    '4. 只输出一个 JSON 对象：{"fields":{"<字段键>":{"value":…,"unit":"…","conf":0.9,"evidence":"…","file":"…"}},"notes":["需要人工注意的问题"]}',
    '',
    '## 字段词典（字段键｜名称｜类型｜…）',
    ...fields.map(f => describeField(f, ctx)),
    '',
    '## 行业术语与专有名词',
    ...(rules.terms.length ? rules.terms.map(t => '- [' + t.kind + '] ' + t.term + '：' + t.meaning) : ['（无）']),
    '',
    '## 数据理解规则',
    ...rules.rules.filter(r => r.enabled).map((r, i) => (i + 1) + '. ' + r.text)
  ];
  if (exs.length) {
    sys.push('', '## 人工纠正示例');
    exs.forEach((e, i) => {
      sys.push('示例 ' + (i + 1) + (e.wellNo ? '（井号 ' + e.wellNo + '）' : '') + (e.note ? '：' + e.note : ''));
      e.items.forEach(it => sys.push('  - ' + (it.evidence ? '原文「' + it.evidence + '」→ ' : '') + it.k + '（' + (label[it.k] || it.k) + '）= ' +
        JSON.stringify(it.value) + (it.wrong !== '' ? '（AI 曾解析为 ' + it.wrong + '，已纠正）' : '')));
    });
  }
  const user = '以下是本次上传的 ' + docs.length + ' 份资料，请按要求抽取字段：\n\n' +
    docs.map(d => '===== 文件：' + d.name + ' =====\n' + d.text + '\n===== 文件结束：' + d.name + ' =====').join('\n\n');
  return { system: sys.join('\n'), user };
}

// ---------------- 取值清洗 ----------------
function convert(f, num, unit, flags) {
  const u = String(unit || '').trim();
  if (!u || u === f.unit || squash(u) === squash(f.unit)) return num;
  const c = f.conv.find(x => squash(x.unit) === squash(u));
  if (c) { if (c.factor !== 1) flags.push('已按 1' + c.unit + '=' + round(c.factor) + f.unit + ' 换算'); return num * c.factor; }
  flags.push('原单位「' + u + '」不在词典里，未换算，请核对');
  return null;   // 交给调用方降置信度
}

const NUM_RE = /(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*([a-zA-Z³²%一-龥]{0,4})/;

function coerce(f, raw, unit, ctx, flags) {
  if (raw == null || raw === '') return undefined;
  if (f.type === 'num') {
    let n = typeof raw === 'number' ? raw : NaN, u = unit;
    if (typeof raw === 'string') {
      const m = NUM_RE.exec(raw.replace(/，/g, ','));
      if (!m) return undefined;
      n = parseFloat(m[1].replace(/,/g, ''));
      if (!u && m[2]) u = (f.conv.find(c => m[2].startsWith(c.unit)) || {}).unit || (f.unit && m[2].startsWith(f.unit) ? f.unit : '');
    }
    if (!isFinite(n)) return undefined;
    const v = convert(f, n, u, flags);
    return v == null ? Object.assign(new Number(round(n)), { unconverted: true }) : round(v);
  }
  if (f.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    const s = String(raw).trim();
    if (/^(true|是|有|√|✓|yes|y|1)$/i.test(s) || /^是/.test(s)) return true;
    if (/^(false|否|无|没有|×|✗|no|n|0)$/i.test(s) || /^(否|无)/.test(s)) return false;
    return undefined;
  }
  let s = String(raw).trim();
  if (f.k === 'phase') {
    const m = /([2-4])|([二三四])/.exec(s);
    return m ? (m[1] ? +m[1] : CN_NUM[m[2]]) : undefined;
  }
  if (f.k === 'wellType') {
    const hit = WELLTYPE_SYN.find(([re]) => re.test(s));
    return hit ? hit[1] : undefined;
  }
  if (f.k === 'team') {
    const opts = optionsOf(f, ctx) || [];
    const hit = opts.filter(o => s.toUpperCase().includes(o.toUpperCase())).sort((a, b) => b.length - a.length)[0];
    if (hit) return hit;
    flags.push('队号「' + s + '」不在定额库队伍名单中');
    const m = /[A-Z]{0,3}\d{5}/i.exec(s);
    return m ? m[0].toUpperCase() : undefined;
  }
  if (f.k === 'wellNo') s = s.replace(/井$/, '');
  if (f.k === 'block' && ctx.blocks.length && !ctx.blocks.includes(s)) flags.push('区块「' + s + '」不是定额库已有区块名，请核对或补定额');
  return s.slice(0, 60);
}

function locate(evidence, docs) {
  const ev = squash(evidence);
  if (ev.length < 2) return null;
  return docs.find(d => squash(d.text).includes(ev)) || null;
}

// 大模型原始输出 → 统一结构。依据在原文里找不到的，置信度压到 0.4 以下
function normalize(raw, rules, docs, ctx) {
  const byK = new Map(rules.fields.filter(f => f.enabled).map(f => [f.k, f]));
  let src = raw && raw.fields;
  if (Array.isArray(src)) src = Object.fromEntries(src.filter(x => x && (x.k || x.key)).map(x => [x.k || x.key, x]));
  const out = {};
  Object.entries(src && typeof src === 'object' ? src : {}).forEach(([k, item]) => {
    const f = byK.get(k); if (!f) return;
    if (item == null || typeof item !== 'object') item = { value: item };
    const flags = [];
    let value = coerce(f, item.value, item.unit, ctx, flags);
    if (value === undefined) return;
    let conf = Math.max(0, Math.min(1, Number(item.conf != null ? item.conf : item.confidence)));
    if (!isFinite(conf)) conf = 0.5;
    if (value instanceof Number) { value = +value; conf = Math.min(conf, 0.4); }
    if (flags.some(x => /不在定额库队伍名单/.test(x))) conf = Math.min(conf, 0.3);
    const evidence = String(item.evidence || '').trim().slice(0, 300);
    let file = String(item.file || '').trim();
    const hit = locate(evidence, docs);
    if (!evidence) { flags.push('未给出原文依据'); conf = Math.min(conf, 0.5); }
    else if (!hit) { flags.push('依据在原文中未找到，可能是模型改写或编造'); conf = Math.min(conf, 0.4); }
    if (hit && !docs.some(d => d.name === file)) file = hit.name;
    if (!file && docs.length === 1) file = docs[0].name;
    out[k] = { value, conf: round(conf), evidence, file, unit: String(item.unit || '').slice(0, 10), flags };
  });
  const notes = (Array.isArray(raw && raw.notes) ? raw.notes : []).map(x => String(x).slice(0, 300)).slice(0, 20);
  return { fields: out, notes };
}

// ---------------- 本地词典解析 ----------------
const SKIP_TAIL = /尺寸|外径|规格|钢级|壁厚|英寸|mm/i;

function headerUnit(rest) {
  const m = /[（(\/]\s*([^）)\s]{1,6})\s*[）)]?/.exec(rest);
  return m ? m[1] : '';
}

function localParse(rules, docs, ctx) {
  const out = {};
  const NAMES = rules.fields.flatMap(f => [f.label, ...f.aliases]).filter(n => n && n.length >= 2);
  const docLines = docs.map(d => ({ d, lines: String(d.text || '').split('\n').map(l => l.split(/\s*[|｜]\s*/).map(c => c.trim())) }));
  rules.fields.filter(f => f.enabled).forEach(f => {
    const names = [f.label, ...f.aliases].filter(n => n && n.length >= 2);
    for (const name of names) {
      for (const { d, lines } of docLines) {
        for (let i = 0; i < lines.length; i++) {
          const cells = lines[i];
          for (let j = 0; j < cells.length; j++) {
            const cell = cells[j];
            const at = cell.indexOf(name);
            // 叫法要在单元格开头，前面只容许「1.」「（二）」这类编号——否则「完井周期」会误中「钻完井周期」
            if (at < 0 || !/^[\d一二三四五六七八九十、.．:：()（）\s]*$/.test(cell.slice(0, at))) continue;
            const rest = cell.slice(at + name.length);
            if (SKIP_TAIL.test(rest) || (f.pick === 'actual' && /^设计|^计划/.test(cell))) continue;
            let raw, unit = headerUnit(rest), how, evidence;
            const inline = /^\s*(?:[（(][^）)]*[）)])?\s*[:：=为是]\s*(.+)$/.exec(rest);
            const bare = /^\s*([（(\/][^）)]*[）)]?)?\s*$/.test(rest);
            // 表头行：整行无数字、下一行列数相同，且右邻也是字段名（或没有右邻）——「井型 | 水平井 | 所属区块 | 板桥」这种键值行不算
            const isHeader = !cells.some(c => /\d/.test(c)) && lines[i + 1] && lines[i + 1].length === cells.length &&
              (cells[j + 1] == null || NAMES.some(n => cells[j + 1].startsWith(n)));
            if (inline) { raw = inline[1]; how = 'inline'; evidence = cell; }
            else if (bare && isHeader && lines[i + 1][j]) {   // 表头行：取下一行同一列
              raw = lines[i + 1][j]; how = 'col'; evidence = cell + ' … ' + raw;
            } else if (bare && f.type === 'num' && cells.slice(j + 1).some(c => /\d/.test(c))) {
              // 「网电 | 万度 | 41.6」：往右找第一个数，中间的短文本当单位；都没有就去上方表头找「数量（吨）」这类单位
              const m = cells.findIndex((c, x) => x > j && /\d/.test(c));
              raw = cells[m]; how = 'kv'; evidence = cells.slice(j, m + 1).join(' | ');
              const mid = cells.slice(j + 1, m).find(c => c.length <= 4);
              if (!unit && mid) unit = mid;
              for (let up = i - 1; !unit && up >= Math.max(0, i - 30); up--) {
                const h = lines[up];
                if (h.length === cells.length && !h.some(c => /\d/.test(c))) { unit = headerUnit(h[m] || ''); break; }
              }
            } else if (bare && cells[j + 1] != null && cells[j + 1] !== '') {
              raw = cells[j + 1]; how = 'kv'; evidence = cell + ' | ' + raw;
            } else continue;
            const flags = [];
            let value = coerce(f, raw, unit, ctx, flags);
            if (value === undefined) continue;
            let conf = how === 'inline' ? 0.45 : 0.55;
            if (value instanceof Number) { value = +value; conf = 0.3; }
            if (flags.some(x => /不在定额库队伍名单/.test(x))) conf = 0.3;
            if (name !== f.label) flags.push('按别名「' + name + '」匹配');
            out[f.k] = { value, conf, evidence: evidence.slice(0, 200), file: d.name, unit, flags };
            return;
          }
        }
      }
    }
  });
  return { fields: out, notes: ['本地词典解析只认表格和「名称：数值」写法，不理解上下文，请逐项核对。'] };
}

// ---------------- 入口 ----------------
async function run(rules, docs, mode) {
  const ctx = context();
  docs = docs.filter(d => d && String(d.text || '').trim());
  if (!docs.length) throw Object.assign(new Error('没有可解析的文字内容'), { status: 400 });
  const t0 = Date.now();
  if (mode === 'local') return Object.assign(localParse(rules, docs, ctx), { mode: 'local', model: '本地词典', ms: Date.now() - t0 });
  const { system, user } = buildPrompt(rules, docs, ctx);
  const { data, usage } = await llm.chatJSON(system, user);
  const c = llm.config();
  return Object.assign(normalize(data, rules, docs, ctx), { mode: 'ai', model: c.vendor + ' · ' + c.model, ms: Date.now() - t0, usage });
}

module.exports = { run, buildPrompt, normalize, localParse, context };
