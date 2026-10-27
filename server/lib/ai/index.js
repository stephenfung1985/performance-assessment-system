// ============================================================
// AI 解析导入的接口。全部要求登录；规则管理只给 admin。
//   GET  /api/ai/status          是否启用、厂商与模型名（不含密钥），前端据此决定显示哪些入口
//   POST /api/ai/extract?name=   上传单个文件（请求体就是文件本身），返回抽取的文本
//   POST /api/ai/parse           {docs:[{name,text}], mode:'ai'|'local', scope?:'full', only?:[字段键]} → 字段候选值
//   GET/PUT /api/ai/rules        解析规则（字段词典 / 术语 / 理解规则 / 少样本示例）
//   POST /api/ai/rules/reset     恢复出厂规则（保留已沉淀的示例）
//   POST /api/ai/prompt          预览按已保存规则拼出的提示词（admin，试解析用）
//   POST /api/ai/examples        把人工纠正结果沉淀为示例；editor 提交的需 admin 审核后才生效
// 上传不用 multipart：前端逐个文件直接 POST 二进制，省掉 multer 一整套依赖。
// ============================================================
const express = require('express');
const auth = require('../auth');
const rules = require('./rules');
const llm = require('./llm');
const parse = require('./parse');
const { extract, ACCEPT } = require('./extract');

const MAX_FILE_MB = Number(process.env.AI_MAX_FILE_MB) || 15;
const MAX_DOCS = 8;
const MAX_TOTAL_CHARS = (Number(process.env.AI_MAX_CHARS) || 30000) * 3;

const router = express.Router();
router.use(auth.requireAuth);

function fail(res, e) {
  const status = (e && e.status) || 500;
  if (status >= 500) console.error('[ai] ' + ((e && e.message) || e));
  res.status(status).json({ error: (e && e.message) || '内部错误' });
}

router.get('/status', (req, res) => {
  const c = llm.config();
  res.json({
    ai: llm.enabled(c), local: true,
    provider: c.provider, vendor: c.vendor, model: c.model, egress: c.egress,
    accept: ACCEPT, maxFileMB: MAX_FILE_MB, maxDocs: MAX_DOCS,
    admin: req.user.role === 'admin'
  });
});

router.post('/extract', express.raw({ type: () => true, limit: MAX_FILE_MB + 'mb' }), async (req, res) => {
  const name = String(req.query.name || '').slice(0, 200);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: '文件为空' });
  try {
    res.json(await extract(req.body, name));
  } catch (e) {
    if (!e.status) e = Object.assign(new Error('文件解析失败：' + (e.message || e) + '。文件可能已损坏或加了密码'), { status: 422 });
    fail(res, e);
  }
});

const BUSY = new Set();   // 每个账号同一时间只跑一个解析，防止连点把额度刷光
router.post('/parse', async (req, res) => {
  const b = req.body || {};
  const mode = b.mode === 'local' ? 'local' : 'ai';
  const docs = (Array.isArray(b.docs) ? b.docs : []).slice(0, MAX_DOCS)
    .map(d => ({ name: String((d && d.name) || '资料').slice(0, 120), text: String((d && d.text) || '') }));
  const total = docs.reduce((s, d) => s + d.text.length, 0);
  if (!docs.length) return res.status(400).json({ error: '没有资料' });
  if (total > MAX_TOTAL_CHARS) return res.status(413).json({ error: '资料文字总量 ' + total + ' 字，超过上限 ' + MAX_TOTAL_CHARS + ' 字，请减少文件' });
  if (BUSY.has(req.user.username)) return res.status(429).json({ error: '上一次解析还没结束，请稍候' });
  // scope=full + only=[字段键]：「扩大范围重试」，只问片段里没找到的那几个字段，整份资料发过去
  const opts = { scope: b.scope === 'full' ? 'full' : 'snippet', only: Array.isArray(b.only) ? b.only.map(k => String(k).slice(0, 40)).slice(0, 80) : null };
  if (opts.scope === 'full' && !(opts.only && opts.only.length)) return res.status(400).json({ error: '扩大范围重试需要指定字段' });
  BUSY.add(req.user.username);
  try {
    const r = await parse.run(rules.load(), docs, mode, opts);
    const s = r.stats, u = r.usage;
    console.log('[ai] ' + req.user.username + ' 解析 ' + docs.length + ' 份资料（' + total + ' 字）→ ' + Object.keys(r.fields).length + ' 个字段，' + r.model + '，' + r.ms + 'ms' +
      (r.cached ? '，命中缓存' : '') +
      (s ? '；' + (s.scope === 'full' ? '扩大范围' : '本地定 ' + s.local + ' 项，') + '问 ' + s.asked + ' 项，发送 ' + s.snippets + ' 段 ' + s.sentChars + ' 字' : '') +
      (u ? '；token 输入 ' + u.input + '（缓存命中 ' + u.cacheHit + '）输出 ' + u.output : ''));
    res.json(r);
  } catch (e) { fail(res, e); }
  finally { BUSY.delete(req.user.username); }
});

router.get('/rules', auth.requireAdmin, (req, res) => res.json(rules.load()));
router.get('/rules/defaults', auth.requireAdmin, (req, res) => res.json(rules.sanitize(rules.defaults())));
router.put('/rules', auth.requireAdmin, (req, res) => {
  if (!req.body || typeof req.body !== 'object' || !Array.isArray(req.body.fields)) return res.status(400).json({ error: '规则格式不对' });
  res.json(rules.save(req.body, req.user.username));
});
// 看看按当前已保存的规则，发给大模型的提示词长什么样（只给 admin，调教用）
router.post('/prompt', auth.requireAdmin, (req, res) => {
  const docs = (Array.isArray((req.body || {}).docs) ? req.body.docs : []).slice(0, MAX_DOCS)
    .map(d => ({ name: String((d && d.name) || '资料').slice(0, 120), text: String((d && d.text) || '') }));
  res.json(parse.buildPrompt(rules.load(), docs, parse.context()));
});
router.post('/rules/reset', auth.requireAdmin, (req, res) => res.json(rules.reset(req.user.username)));

router.post('/examples', (req, res) => {
  try { res.json(rules.addExample(req.body || {}, req.user.username, req.user.role === 'admin')); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
