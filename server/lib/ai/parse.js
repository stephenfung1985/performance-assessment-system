// ============================================================
// 解析编排。两条路输出同一结构：
//   fields: { <S.w 键>: { value, conf, evidence, file, unit, flags[] } }
//
// AI 解析走「本地优先 + 片段精读 + 只问缺口」，尽量少花 token：
//   1. 本地词典先扫一遍（不花 token），表格 / 「名称：数值」里直接命中、又不需要理解上下文的字段就此定下
//   2. 剩下的字段里，资料中连叫法（或线索词）都没出现的不问，留给「扩大范围重试」
//   3. 只把命中这些字段叫法的表格行、段落、章节截成片段（默认共 4000 字）发给大模型，
//      提示词里也只放这些字段的词典条目、相关术语、相关规则和示例
//   4. 输出用紧凑数组，依据只写片段号 + 不超过 40 字原文
//   同一批资料、同一版规则的结果在内存里缓存，重复解析不再调用大模型。
// 不出网的「本地词典解析」（mode=local）只做第 1 步，用于没配大模型或资料涉密时兜底。
// 本地词典 = 人工调教的规则 + 已生效的 AI 学习规则（learn.js 从大模型结果里学来，追加在人工规则之后）。
// ============================================================
const crypto = require('crypto');
const store = require('../store');
const llm = require('./llm');

const MAX_EXAMPLES = Number(process.env.AI_MAX_EXAMPLES) || 12;
const MAX_EXAMPLE_ITEMS = 6;                                       // 片段模式下最多带几条相关纠正
const SNIPPET_CHARS = Number(process.env.AI_SNIPPET_CHARS) || 4000;
const MAX_CHARS = Number(process.env.AI_MAX_CHARS) || 30000;       // 扩大范围时单份资料最多取多少字
const squash = s => String(s == null ? '' : s).replace(/[\s|｜]+/g, '').toLowerCase();
const round = n => Math.round(n * 10000) / 10000;
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5 };
const WELLTYPE_SYN = [[/水平/, '水平井'], [/定向|斜/, '定向井'], [/直井|垂直/, '直井']];

// 只用来判断资料里有没有这个字段的线索、以及截片段，不发给大模型。
// 有些字段要靠别的量推出来（钻完井周期 = 钻井周期 + 完井周期），光看它自己的叫法会漏问。
const CLUES = {
  cycleDays: ['钻井周期', '完井周期', '建井周期'],
  preDays: ['建井周期', '搬安'],
  footage: ['井深', '进尺'],
  phase: ['一开', '二开', '三开', '四开', '开次'],
  wellType: ['水平井', '定向井', '直井', '井型', '斜井'],
  block: ['区块', '构造', '油田'],
  team: ['钻井队', '井队'],
  hasAccident: ['事故', '复杂'],
  winter: ['冬季', '冬防'],
  e2o: ['网电', '电代油'],
  diesel: ['柴油', '网电'],
  rigModel: ['ZJ50', 'ZJ70', 'ZJ'],
  powerMode: ['网电', '柴油', '电动钻机'],
  designSections: ['一开', '二开', '套管', '钻头']
};
// 本地词典命中也不能直接定下的字段：要理解上下文（实际/设计、拆分、合计），交给大模型
const NEED_CONTEXT = new Set(['footage', 'cycleDays', 'assessedCycleDays', 'preDays', 'testDays', 'coreDays', 'kickDays',
  'lossDays', 'waitDays', 'sidetrack', 'phase', 'wellType', 'block']);
// 章节标题：「二、井身结构设计」「3.2 钻井周期」「（三）钻机选型」「第四章 …」，不超过 30 字、不带表格分隔
const HEADING = /^(?:[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十\d]+[)）]|\d+(?:\.\d+)*[、.．\s]|第[一二三四五六七八九十\d]+[章节])[^|｜]{1,28}$/;
const TOC = /\.{4,}|…{2,}|·{4,}/;   // 目录行：「3.2 井身结构 ........ 12」

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

const namesOf = f => [...new Set([f.label, ...f.aliases, ...(CLUES[f.k] || [])])].filter(n => n && n.length >= 2);

// ---------------- 提示词 ----------------
function describeField(f, ctx) {
  const t = f.type === 'num' ? '数值' + (f.unit ? '，单位：' + f.unit : '') : f.type === 'bool' ? '是/否（输出 true/false）'
    : f.type === 'enum' ? '枚举' : f.type === 'table' ? '表格，列：' + (f.cols || []).map(c => c[1] + (c[2] ? '(' + c[2] + ')' : '')).join('，') : '文本';
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

// 固定不变的开头放最前面：DeepSeek / Claude 的前缀缓存能命中，这部分按缓存价计费
const HEAD = [
  '你是渤海钻探第三钻井公司（大港油区）单井经营考核的资料录入助手，从资料片段中抽取指定字段。',
  '1. 只依据片段原文，不推测、不补全；找不到的字段不要输出。',
  '2. 只输出一个 JSON：{"f":{"<字段键>":[值,"原单位",置信度,"依据","片段号"]},"n":["需要人工注意的问题"]}',
  '   值：换算到目标单位后的数字、文本或 true/false；表格字段的值是二维数组，每行一个开次、按列顺序，缺的单元格写 null。',
  '   原单位：资料里写的单位，没有写 ""。置信度：0~1。依据：从片段逐字摘录，不超过 40 字，必须能原样找到。片段号：如 "S2"。',
  '3. 遵守下面的字段词典、术语和数据理解规则；「纠正示例」是考核办公室确认过的口径，与常识冲突时以示例为准。'
].join('\n');

function prompt(rules, p, ctx) {
  const label = Object.fromEntries(rules.fields.map(f => [f.k, f.label]));
  const askKeys = new Set(p.ask.map(f => f.k));
  const text = p.snippets.map(s => s.text).join('\n');
  // 规则里点了名的字段都不在这次要问的范围内，就不带这条规则；没点名任何字段的是通用规则，照带
  const named = r => rules.fields.filter(f => r.includes(f.k) || r.includes(f.label));
  const rs = rules.rules.filter(r => r.enabled).map(r => r.text).filter(r => { const n = named(r); return !n.length || n.some(f => askKeys.has(f.k)); });
  const KIND_FIELD = { 队号: 'team', 井型: 'wellType', 区块: 'block', 井号: 'wellNo' };
  const terms = rules.terms.filter(t => askKeys.has(KIND_FIELD[t.kind]) ||
    t.term.split(/[、,，]/).map(x => x.trim()).some(x => x.length >= 2 && text.includes(x)));
  const exItems = [];
  rules.examples.filter(e => e.status === 'on').slice(-MAX_EXAMPLES).reverse().forEach(e => e.items.forEach(it => {
    if (askKeys.has(it.k) && exItems.length < MAX_EXAMPLE_ITEMS) exItems.push(Object.assign({ wellNo: e.wellNo }, it));
  }));
  const sys = [HEAD, '', '## 字段词典（字段键｜名称｜类型｜…）', ...p.ask.map(f => describeField(f, ctx))];
  if (terms.length) sys.push('', '## 术语', ...terms.map(t => '- [' + t.kind + '] ' + t.term + '：' + t.meaning));
  if (rs.length) sys.push('', '## 数据理解规则', ...rs.map((r, i) => (i + 1) + '. ' + r));
  if (exItems.length) sys.push('', '## 纠正示例', ...exItems.map(it => '- ' + (it.wellNo ? '[' + it.wellNo + '] ' : '') +
    (it.evidence ? '原文「' + it.evidence + '」→ ' : '') + it.k + '（' + (label[it.k] || it.k) + '）= ' + JSON.stringify(it.value) +
    (it.wrong !== '' ? '（曾误解析为 ' + it.wrong + '）' : '')));
  const user = '资料片段：\n\n' + p.snippets.map(s => '[' + s.id + ' · ' + s.file + ']\n' + s.text).join('\n\n');
  return { system: sys.join('\n'), user };
}

// ---------------- 片段 ----------------
// 长段落只截命中叫法前后的一小段，不整段带上
function lineText(l, names) {
  if (l.length <= 400) return l;
  const spans = [];
  names.forEach(n => { let at = l.indexOf(n); if (at >= 0) spans.push([Math.max(0, at - 120), Math.min(l.length, at + n.length + 120)]); });
  if (!spans.length) return l.slice(0, 200) + '…';
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  spans.forEach(s => { const m = merged[merged.length - 1]; if (m && s[0] <= m[1]) m[1] = Math.max(m[1], s[1]); else merged.push(s.slice()); });
  return merged.map(([a, b]) => (a > 0 ? '…' : '') + l.slice(a, b) + (b < l.length ? '…' : '')).join(' ');
}

function pickSnippets(docs, fields, budget) {
  const names = [...new Set(fields.flatMap(namesOf))];
  const ranges = [];
  docs.forEach((d, di) => {
    const lines = String(d.text || '').split('\n');
    const score = new Array(lines.length).fill(0);
    const mark = (i, s) => { if (i >= 0 && i < lines.length && s > score[i]) score[i] = s; };
    lines.forEach((l, i) => {
      if (!l.trim() || TOC.test(l)) return;
      const hit = names.reduce((n, x) => n + (l.includes(x) ? 1 : 0), 0);
      if (hit) {
        mark(i, 2 * hit); mark(i - 1, 1); mark(i + 1, 1);
        // 表格数据行：往上找最近的表头（无数字的表格行）一起带上，不然列名丢了
        if (l.includes('|')) for (let up = i - 1; up >= Math.max(0, i - 40) && lines[up].includes('|'); up--) {
          if (!/\d/.test(lines[up])) { mark(up, 2 * hit); break; }
        }
      }
      // 点了要问字段的章节标题：带上后面一小节（井身结构、钻井周期这类表格常常只在标题里点名），到下一个标题为止
      if (hit && HEADING.test(l.trim())) {
        for (let x = i + 1, n = 0; x < lines.length && x <= i + 8 && n < 400 && !HEADING.test(lines[x].trim()); x++) { mark(x, 1); n += lines[x].length; }
      }
    });
    for (let i = 0; i < lines.length; i++) {
      if (!score[i]) continue;
      let j = i, s = 0;
      while (j < lines.length && score[j]) s += score[j++];
      const text = lines.slice(i, j).map(l => lineText(l, names)).filter(l => l.trim()).join('\n');
      if (text) ranges.push({ di, start: i, score: s, text, file: d.name });
      i = j;
    }
  });
  // 先挑命中多的，凑满预算后按原文顺序排回去
  const picked = [];
  let used = 0;
  ranges.sort((a, b) => b.score / Math.sqrt(b.text.length) - a.score / Math.sqrt(a.text.length)).forEach(r => {
    if (used >= budget) return;
    const text = used + r.text.length > budget ? r.text.slice(0, budget - used) + '…' : r.text;
    if (text.length < 20 && picked.length) return;
    picked.push(Object.assign({}, r, { text })); used += text.length;
  });
  return picked.sort((a, b) => a.di - b.di || a.start - b.start).map((r, i) => ({ id: 'S' + (i + 1), file: r.file, text: r.text }));
}

// 本次要发给大模型的内容：哪些字段本地已定、问哪些、截哪些片段
function plan(rules, docs, ctx, opts) {
  const enabled = rules.fields.filter(f => f.enabled);
  const only = Array.isArray(opts.only) && opts.only.length ? new Set(opts.only) : null;
  if (opts.scope === 'full') {
    // 扩大范围：只问指定字段，整份资料（每份最多 MAX_CHARS 字）发过去，不走本地词典
    const ask = enabled.filter(f => !only || only.has(f.k));
    const snippets = docs.map((d, i) => ({ id: 'D' + (i + 1), file: d.name, text: d.text.length > MAX_CHARS ? d.text.slice(0, MAX_CHARS) + '…（后略）' : d.text }));
    return { scope: 'full', local: {}, settled: {}, ask, skipped: [], snippets };
  }
  const local = localParse(rules, docs, ctx).fields;
  const settled = {};
  Object.entries(local).forEach(([k, x]) => {
    const f = enabled.find(y => y.k === k);
    const warn = x.flags.filter(t => !/^按别名|^已按/.test(t));
    if (!f || f.type === 'bool' || NEED_CONTEXT.has(k) || warn.length || x.unconverted) return;
    settled[k] = Object.assign({}, x, { conf: Math.max(x.conf, 0.7), flags: x.flags.concat('本地词典直接命中，未发给大模型') });
  });
  const all = docs.map(d => d.text).join('\n');
  const gap = enabled.filter(f => !settled[f.k] && (!only || only.has(f.k)));
  const ask = gap.filter(f => namesOf(f).some(n => all.includes(n)));
  const skipped = gap.filter(f => !ask.includes(f));
  const snippets = ask.length ? pickSnippets(docs, ask, SNIPPET_CHARS) : [];
  return { scope: 'snippet', local, settled, ask: snippets.length ? ask : [], skipped: snippets.length ? skipped : gap, snippets };
}

function buildPrompt(rules, docs, ctx, opts) {
  const p = plan(rules, docs, ctx, opts || {});
  const out = p.ask.length ? prompt(rules, p, ctx) : { system: HEAD, user: '' };
  return Object.assign(out, { stats: statsOf(p) });
}

const statsOf = p => ({ scope: p.scope, local: Object.keys(p.settled).length, asked: p.ask.length, skipped: p.skipped.length,
  snippets: p.snippets.length, sentChars: p.snippets.reduce((s, x) => s + x.text.length, 0) });

// ---------------- 取值清洗 ----------------
function convert(f, num, unit, flags) {
  const u = String(unit || '').trim();
  if (!u || u === f.unit || squash(u) === squash(f.unit)) return num;
  const c = f.conv.find(x => squash(x.unit) === squash(u));
  if (c) {
    if (c.factor !== 1) flags.push('已按 1' + c.unit + '=' + round(c.factor) + f.unit + ' 换算' + (f.learnedConv && f.learnedConv[c.unit] ? '（AI 学习规则）' : ''));
    return num * c.factor;
  }
  flags.push('原单位「' + u + '」不在词典里，未换算，请核对');
  return null;   // 交给调用方降置信度
}

const NUM_RE = /(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*([a-zA-Z³²%°一-龥/]{0,6})/;
const phaseOf = v => {
  if (typeof v === 'number') return v >= 1 && v <= 6 ? Math.round(v) : null;
  const m = /([1-6])|([一二三四五])/.exec(String(v == null ? '' : v));
  return m ? (m[1] ? +m[1] : CN_NUM[m[2]]) : null;
};

// 表格字段：二维数组（或对象数组）→ [{phase, from, to, …}]，按开次排序
function coerceTable(f, raw) {
  if (!Array.isArray(raw)) return undefined;
  const cols = f.cols || [];
  const rows = raw.map(r => {
    if (r && !Array.isArray(r) && typeof r === 'object') r = cols.map(c => r[c[0]]);
    if (!Array.isArray(r)) return null;
    const o = {};
    cols.forEach(([ck], i) => {
      const v = r[i];
      if (ck === 'phase') { o.phase = phaseOf(v); return; }
      const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[,，]/g, ''));
      o[ck] = isFinite(n) ? round(n) : null;
    });
    return o.phase ? o : null;
  }).filter(Boolean).sort((a, b) => a.phase - b.phase);
  return rows.length ? rows : undefined;
}

function coerce(f, raw, unit, ctx, flags) {
  if (raw == null || raw === '') return undefined;
  if (f.type === 'table') return coerceTable(f, raw);
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
  if (f.k === 'rigModel') {
    const m = /([57])0/.exec(s);
    if (m) return m[1] + '0型';
    flags.push('钻机「' + s + '」不是 50/70 型');
    return undefined;
  }
  if (f.k === 'powerMode') {
    const e = /网电|电动|电驱/.test(s), d = /柴油/.test(s);
    return e && d ? '网电+柴油' : e ? '网电' : d ? '柴油' : undefined;
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

// 提示词让大模型给「换算后的值 + 原单位」，可模型不总照做。词典里有这个原单位的换算时，拿依据里的原数判断：
// 依据里只有这个值本身 → 模型没换算，照常换算；否则（依据里是换算前的数，或看不出来）按约定当作已换算，不再乘系数
const EV_NUM_RE = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;
function modelConverted(f, item) {
  if (f.type !== 'num' || item.value == null) return null;
  const u = String(item.unit || '').trim();
  if (!u || squash(u) === squash(f.unit)) return null;
  const c = f.conv.find(x => squash(x.unit) === squash(u));
  if (!c || c.factor === 1) return null;
  const s = String(item.value).replace(/[，,]/g, '').trim();
  const v = typeof item.value === 'number' ? item.value : /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;   // 「125万元」这种带单位的字符串是原数，照常换算
  if (!isFinite(v)) return null;
  const nums = (String(item.evidence || '').replace(/，/g, ',').match(EV_NUM_RE) || []).map(x => parseFloat(x.replace(/,/g, '')));
  const has = x => nums.some(n => Math.abs(n - x) <= Math.max(1e-9, Math.abs(x) * 0.01));
  return has(v) && !has(v / c.factor) ? null : { value: v, conv: c };
}

// 大模型原始输出 → 统一结构。认紧凑数组 [值, 单位, 置信度, 依据, 片段号]，也认旧的对象写法。
// 依据在原文里找不到的，置信度压到 0.4 以下
function normalize(raw, rules, docs, ctx, snippets, askKeys) {
  const byK = new Map(rules.fields.filter(f => f.enabled && (!askKeys || askKeys.has(f.k))).map(f => [f.k, f]));
  const fileOf = Object.fromEntries((snippets || []).map(s => [s.id, s.file]));
  let src = raw && (raw.f || raw.fields);
  if (Array.isArray(src)) src = Object.fromEntries(src.filter(x => x && (x.k || x.key)).map(x => [x.k || x.key, x]));
  const out = {};
  Object.entries(src && typeof src === 'object' ? src : {}).forEach(([k, item]) => {
    const f = byK.get(k); if (!f) return;
    const rowLike = r => r != null && typeof r === 'object' && (!Array.isArray(r) || !Array.isArray(r[0]));
    if (Array.isArray(item) && f.type !== 'table') item = { value: item[0], unit: item[1], conf: item[2], evidence: item[3], file: item[4] };
    else if (Array.isArray(item) && item.length && item.every(rowLike)) item = { value: item };   // 表格值直接给成行数组，没带单位/依据
    else if (Array.isArray(item)) item = { value: item[0], unit: item[1], conf: item[2], evidence: item[3], file: item[4] };
    if (item == null || typeof item !== 'object') item = { value: item };
    const flags = [], pre = modelConverted(f, item);
    if (pre) flags.push('已按 1' + pre.conv.unit + '=' + round(pre.conv.factor) + f.unit + ' 换算（大模型已换算）');
    let value = pre ? round(pre.value) : coerce(f, item.value, item.unit, ctx, flags);
    if (value === undefined) return;
    let conf = Math.max(0, Math.min(1, Number(item.conf != null ? item.conf : item.confidence)));
    if (!isFinite(conf)) conf = 0.5;
    const modelConf = conf;
    if (value instanceof Number) { value = +value; conf = Math.min(conf, 0.4); }
    if (flags.some(x => /不在定额库队伍名单/.test(x))) conf = Math.min(conf, 0.3);
    const evidence = String(item.evidence || '').trim().slice(0, 300);
    let file = String(item.file || '').trim();
    file = fileOf[file] || file;
    const hit = locate(evidence, docs);
    if (!evidence) { flags.push('未给出原文依据'); conf = Math.min(conf, 0.5); }
    else if (!hit) { flags.push('依据在原文中未找到，可能是模型改写或编造'); conf = Math.min(conf, 0.4); }
    if (hit && !docs.some(d => d.name === file)) file = hit.name;
    if (!file && docs.length === 1) file = docs[0].name;
    out[k] = { value, conf: round(conf), evidence, file, unit: String(item.unit || '').slice(0, 10), flags };
    Object.defineProperty(out[k], 'modelConf', { value: round(modelConf) });   // 模型自评、压低前的置信度，不进 JSON，给 learn.observe 判断能不能学
  });
  const notes = (Array.isArray(raw && (raw.n || raw.notes)) ? (raw.n || raw.notes) : []).map(x => String(x).slice(0, 300)).slice(0, 20);
  return { fields: out, notes };
}

// ---------------- 字段间互相核对 ----------------
// 自相矛盾的值打上提示、置信度压到 0.45 以下（默认不勾选回填）
function crossCheck(out) {
  const num = k => out[k] && typeof out[k].value === 'number' && out[k].value > 0 ? out[k].value : null;
  const bad = (k, msg) => { if (!out[k]) return; out[k].flags.push(msg); out[k].conf = Math.min(out[k].conf, 0.45); };
  [['designVertDepth', 'designDepth', '设计垂深大于设计井深'], ['designHorizLen', 'designDepth', '设计水平段长不小于设计井深'],
    ['designTechCasing', 'designDepth', '设计技套下深不小于设计井深'], ['vertDepth', 'footage', '垂深大于实际进尺'],
    ['horizLen', 'footage', '水平段长不小于实际进尺'], ['techCasing', 'footage', '技套下深不小于实际进尺']]
    .forEach(([a, b, msg]) => { const x = num(a), y = num(b); if (x && y && (a.endsWith('VertDepth') || a === 'vertDepth' ? x > y : x >= y)) bad(a, msg); });
  const range = (k, lo, hi, msg) => { const v = num(k); if (v != null && (v < lo || v > hi)) bad(k, msg); };
  range('maxIncl', 0, 100, '最大井斜超出 0～100°');
  range('pressureCoef', 0.5, 2.5, '地层压力系数超出常见范围 0.5～2.5');
  range('mudDensity', 0.8, 2.6, '钻井液密度超出常见范围 0.8～2.6 g/cm³');
  const rows = out.designSections && out.designSections.value;
  if (Array.isArray(rows)) {
    const msgs = [];
    rows.forEach((r, i) => {
      if (r.phase !== i + 1) msgs.push('开次不连续（第 ' + (i + 1) + ' 行是 ' + r.phase + ' 开）');
      if (r.from != null && r.to != null && r.to <= r.from) msgs.push(r.phase + ' 开井段止点不大于起点');
      const prev = rows[i - 1];
      if (prev && prev.to != null && r.from != null && Math.abs(r.from - prev.to) > 1) msgs.push(r.phase + ' 开起点与上一开止点不衔接');
    });
    const last = rows[rows.length - 1], dd = num('designDepth');
    if (dd && last.to != null && Math.abs(last.to - dd) > Math.max(5, dd * 0.01)) msgs.push('最后一开止点 ' + last.to + ' 米与设计井深 ' + dd + ' 米不一致');
    const ph = num('phase');
    if (ph && rows.length !== ph) msgs.push('井身结构 ' + rows.length + ' 开，与开次 ' + ph + ' 不一致');
    msgs.forEach(m => bad('designSections', m));
  }
  return out;
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
  rules.fields.filter(f => f.enabled && f.type !== 'table').forEach(f => {   // 表格字段本地认不全，只交给大模型
    const names = [f.label, ...f.aliases].filter(n => n && n.length >= 2);
    const learned = f.learned || {};   // learn.apply() 追加的 AI 学习叫法 → 规则 id
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
            let conf = how === 'inline' ? 0.45 : 0.55, unconverted = false;
            if (value instanceof Number) { value = +value; conf = 0.3; unconverted = true; }
            if (flags.some(x => /不在定额库队伍名单/.test(x))) conf = 0.3;
            if (name !== f.label) flags.push('按别名「' + name + '」匹配' + (learned[name] ? '（AI 学习规则）' : ''));
            out[f.k] = { value, conf, evidence: evidence.slice(0, 200), file: d.name, unit, flags };
            if (unconverted) Object.defineProperty(out[f.k], 'unconverted', { value: true });   // 不进 JSON，只给 plan 判断
            if (learned[name]) Object.defineProperty(out[f.k], 'learnedId', { value: learned[name] });   // 给 learn.observe 记用量、记反驳
            return;
          }
        }
      }
    }
  });
  return { fields: out, notes: ['本地词典解析只认表格和「名称：数值」写法，不理解上下文，请逐项核对。'] };
}

// ---------------- AI 解析 ----------------
async function aiRun(rules, docs, ctx, opts) {
  const p = plan(rules, docs, ctx, opts);
  const fields = Object.assign({}, p.settled);
  const notes = [];
  let usage = null;
  if (p.ask.length) {
    const { system, user } = prompt(rules, p, ctx);
    // 输出预算按要问的字段数给：普通字段约 70 token，表格约 420 token；被截断就放开到 AI_MAX_TOKENS 再试一次
    const budget = 200 + p.ask.reduce((s, f) => s + (f.type === 'table' ? 420 : 70), 0);
    let res;
    try { res = await llm.chatJSON(system, user, { maxTokens: budget }); }
    catch (e) { if (!e.truncated) throw e; res = await llm.chatJSON(system, user); }
    usage = res.usage;
    const n = normalize(res.data, rules, docs, ctx, p.snippets, new Set(p.ask.map(f => f.k)));
    Object.assign(fields, n.fields);
    notes.push(...n.notes);
  }
  // 大模型没给出、本地词典有候选的，退回本地结果（低置信度，默认不勾）
  p.ask.forEach(f => {
    const x = p.local[f.k];
    if (!fields[f.k] && x) fields[f.k] = Object.assign({}, x, { conf: Math.min(x.conf, 0.4), flags: x.flags.concat('大模型未给出，取本地词典结果') });
  });
  crossCheck(fields);
  const missing = [...p.ask, ...p.skipped].map(f => f.k).filter(k => !fields[k]);
  const c = llm.config();
  return { fields, notes, missing, stats: statsOf(p), usage, mode: 'ai', model: c.vendor + ' · ' + c.model };
}

// 同一批资料 + 同一版规则 + 同样的问法，直接复用上次结果
const CACHE = new Map();
const CACHE_MAX = 50;
function cacheKey(rules, docs, opts) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify([opts.scope || 'snippet', opts.only || null, rules.updatedAt, rules.learnedAt || null, rules.examples.length,
    rules.examples.filter(e => e.status === 'on').length, docs.map(d => [d.name, d.text])]));
  return h.digest('hex');
}

// ---------------- 入口 ----------------
async function run(rules, docs, mode, opts) {
  opts = opts || {};
  const ctx = context();
  docs = docs.filter(d => d && String(d.text || '').trim());
  if (!docs.length) throw Object.assign(new Error('没有可解析的文字内容'), { status: 400 });
  const t0 = Date.now();
  if (mode === 'local') {
    const r = localParse(rules, docs, ctx);
    crossCheck(r.fields);
    return Object.assign(r, { mode: 'local', model: '本地词典', ms: Date.now() - t0 });
  }
  const key = cacheKey(rules, docs, opts);
  if (CACHE.has(key)) return Object.assign(JSON.parse(CACHE.get(key)), { cached: true, usage: null, ms: Date.now() - t0 });
  const r = await aiRun(rules, docs, ctx, opts);
  r.ms = Date.now() - t0;
  CACHE.set(key, JSON.stringify(r));
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return r;
}

module.exports = { run, buildPrompt, normalize, localParse, context, plan, pickSnippets, crossCheck };
