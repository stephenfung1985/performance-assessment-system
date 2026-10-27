// 首次启动时把附件1（2026年8月版）定额基线写入存储，井库留空由团队自己录入。
// 已经有数据的 key 不会被覆盖——这个脚本可以安全地反复跑。
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });   // 单独 npm run seed 时也要读到 DATA_DIR
const store = require('./store');
const auth = require('./auth');

function seedQuota() {
  if (store.exists('quota')) {
    console.log('[seed] quota 已存在，跳过。');
    return;
  }
  const Q = require('./Q_seed.json');
  Q.version = null;
  store.writeJSON('quota', Q);
  console.log('[seed] 已写入定额库基线：' + Q.blocks.length + ' 个区块组合。');
}

function seedWells() {
  if (store.exists('wells')) {
    console.log('[seed] wells 已存在，跳过。');
    return;
  }
  store.writeJSON('wells', []);
  console.log('[seed] 已初始化空井库。');
}

function seedAdmin() {
  auth.ensureSeedAdmin();
}

if (require.main === module) {
  seedQuota();
  seedWells();
  seedAdmin();
  console.log('[seed] 完成。');
}

module.exports = { seedQuota, seedWells, seedAdmin };
