// ============================================================
// 大模型调用。两种协议覆盖常见厂商，全部从 server/.env 读配置：
//   openai     OpenAI 兼容的 /chat/completions —— DeepSeek、通义千问（百炼兼容模式）、
//              文心（千帆 v2）、智谱，以及私有化的 vLLM / Ollama / Xinference 都走这条
//   anthropic  Claude 的 /v1/messages
// AI_PROVIDER 写 anthropic / claude 走后者，写其它任何值（deepseek、qwen、openai…）都走前者，留空则关闭。
// 密钥只在这里读、只放进请求头，不写日志、不回传前端。
// ============================================================

function config() {
  const provider = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  const isClaude = provider === 'anthropic' || provider === 'claude';
  const baseUrl = String(process.env.AI_BASE_URL || (isClaude ? 'https://api.anthropic.com' : 'https://api.deepseek.com')).replace(/\/+$/, '');
  const model = String(process.env.AI_MODEL || '').trim();
  let host = '';
  try { host = new URL(baseUrl).hostname; } catch (_) {}
  return {
    provider: isClaude ? 'anthropic' : (provider ? 'openai' : ''),
    baseUrl, model, host,
    apiKey: process.env.AI_API_KEY || '',
    vendor: String(process.env.AI_VENDOR || '').trim() || host || '大模型',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 90000,
    maxTokens: Number(process.env.AI_MAX_TOKENS) || 4096,
    jsonMode: process.env.AI_JSON_MODE !== '0',
    // 内网/本机地址视为私有化部署，界面上不提示「数据出网」
    egress: !(host === 'localhost' || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '::1' || /\.(local|internal|lan)$/.test(host))
  };
}

function enabled(c) {
  c = c || config();
  if (!c.provider || !c.model) return false;
  return !!c.apiKey || !c.egress;   // 私有化部署（如 Ollama）可以不配密钥
}

// 模型偶尔会把 JSON 包在 ```json 代码块里或前后加说明，取第一个完整对象
function parseJSON(s) {
  s = String(s || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch (_) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {} }
  throw Object.assign(new Error('大模型返回的内容不是合法 JSON'), { status: 502 });
}

function httpError(status, body) {
  let detail = '';
  try { const j = JSON.parse(body); detail = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch (_) { detail = String(body || '').slice(0, 160); }
  const msg = status === 401 || status === 403 ? '大模型密钥无效或无权限，请检查 server/.env 的 AI_API_KEY'
    : status === 402 ? '大模型账户余额不足'
    : status === 429 ? '大模型调用频率或额度受限，请稍后再试'
    : status === 404 ? '大模型接口地址或模型名不对，请检查 AI_BASE_URL / AI_MODEL'
    : '大模型接口返回错误（HTTP ' + status + '）';
  return Object.assign(new Error(msg + (detail ? '：' + String(detail).slice(0, 160) : '')), { status: 502 });
}

async function post(url, headers, body, c) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body), signal: AbortSignal.timeout(c.timeoutMs) });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw Object.assign(new Error(timeout ? '大模型响应超时（' + Math.round(c.timeoutMs / 1000) + ' 秒），可减少上传的资料或调大 AI_TIMEOUT_MS'
      : '连不上大模型接口 ' + c.host + '：' + ((e && e.cause && e.cause.code) || (e && e.message) || '网络错误')), { status: 504 });
  }
  const text = await r.text();
  if (!r.ok) throw httpError(r.status, text);
  try { return JSON.parse(text); } catch (_) { throw Object.assign(new Error('大模型接口返回的不是 JSON'), { status: 502 }); }
}

// 统一成 {input, output, cacheHit}：DeepSeek 报 prompt_cache_hit_tokens，Claude 报 cache_read_input_tokens
function usageOf(u) {
  if (!u) return null;
  return {
    input: (u.prompt_tokens != null ? u.prompt_tokens : (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)) || 0,
    output: (u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0,
    cacheHit: (u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : u.cache_read_input_tokens) || 0
  };
}
const truncated = () => Object.assign(new Error('大模型输出被截断，请调大 AI_MAX_TOKENS'), { status: 502, truncated: true });

// system / user 两段提示词 → 解析好的 JSON 对象。opts.maxTokens 按本次要问的字段数给，不超过 AI_MAX_TOKENS
async function chatJSON(system, user, opts) {
  const c = config();
  if (!enabled(c)) throw Object.assign(new Error('AI 解析未启用：请在 server/.env 配置 AI_PROVIDER / AI_MODEL / AI_API_KEY'), { status: 503 });
  const maxTokens = Math.min(c.maxTokens, (opts && opts.maxTokens) || c.maxTokens);
  if (c.provider === 'anthropic') {
    const j = await post(c.baseUrl + '/v1/messages',
      { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' },
      { model: c.model, max_tokens: maxTokens, temperature: 0, system, messages: [{ role: 'user', content: user }] }, c);
    const out = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (j.stop_reason === 'max_tokens') throw truncated();
    return { data: parseJSON(out), usage: usageOf(j.usage) };
  }
  const body = { model: c.model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (c.jsonMode) body.response_format = { type: 'json_object' };
  const j = await post(c.baseUrl + '/chat/completions', c.apiKey ? { authorization: 'Bearer ' + c.apiKey } : {}, body, c);
  const ch = (j.choices || [])[0] || {};
  if (ch.finish_reason === 'length') throw truncated();
  return { data: parseJSON(ch.message && ch.message.content), usage: usageOf(j.usage) };
}

module.exports = { config, enabled, chatJSON };
