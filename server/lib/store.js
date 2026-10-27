// ============================================================
// 极简 JSON 文件存储层。
// 每个 key 对应 data/<key>.json 一个文件；整份写入、原子替换（先写临时文件再 rename），
// 避免进程崩溃或断电导致文件半写损坏。不引入数据库依赖，便于在任意能跑 Node 的
// 服务器上部署——数据量级（井档案、定额表、月度填报）JSON 单文件完全够用；
// 井数量若未来涨到数千以上，可把本文件的 read/write 换成真实数据库，上层
// routes 代码不用改。
// ============================================================
const fs = require('fs');
const path = require('path');

// 线上部署在 .env 里设 DATA_DIR 指到代码目录之外（如 /var/lib/kaohe/data），
// 重新上传/覆盖代码文件夹时碰不到数据；不设则沿用 server/data，本机双击启动不受影响。
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(__dirname, '..', process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function keyPath(key) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(key)) throw new Error('非法存储键: ' + key);
  return path.join(DATA_DIR, key + '.json');
}

function readJSON(key, fallback) {
  const p = keyPath(key);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // 文件存在但损坏：备份现场，返回 fallback，不让一次损坏拖垮整个服务
    try {
      fs.copyFileSync(p, p + '.corrupt-' + Date.now());
    } catch (_) {}
    console.error('[store] 读取 ' + key + ' 失败，已备份损坏文件并回退默认值：', e.message);
    return fallback;
  }
}

function writeJSON(key, value) {
  const p = keyPath(key);
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, p); // 同目录 rename 在主流文件系统上是原子操作
  return true;
}

function exists(key) {
  return fs.existsSync(keyPath(key));
}

module.exports = { readJSON, writeJSON, exists, DATA_DIR };
