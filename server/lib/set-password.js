// 命令行重置账号密码（前端没有改密码页面）。在 server/ 目录运行：
//   npm run passwd            # 默认改 admin
//   npm run passwd -- 用户名
// 输入时每个字符显示为 *，输两遍确认；直接改 data/users.json，服务不用重启。
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });   // 要读到 DATA_DIR，才改得到线上那份 users.json
const auth = require('./auth');

const MIN_LEN = 8;

function askHidden(prompt) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    if (!stdin.isTTY) {
      console.error('\n请在终端里直接运行（需要能键盘输入）。');
      process.exit(1);
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { // Ctrl-C
          stdin.setRawMode(false);
          process.stdout.write('\n已取消。\n');
          process.exit(1);
        }
        if (ch === '\u007f' || ch === '\b') { // 退格
          if (value.length) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue; // 忽略其他控制字符
        value += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const username = process.argv[2] || 'admin';
  if (!auth.findUser(username)) {
    console.error('用户不存在：' + username);
    process.exit(1);
  }
  const p1 = await askHidden('为 ' + username + ' 设置新密码（至少 ' + MIN_LEN + ' 位）：');
  if (p1.length < MIN_LEN) {
    console.error('密码太短，至少 ' + MIN_LEN + ' 位。未修改。');
    process.exit(1);
  }
  const p2 = await askHidden('再输入一次：');
  if (p1 !== p2) {
    console.error('两次输入不一致。未修改。');
    process.exit(1);
  }
  auth.setPassword(username, p1);
  console.log('已更新 ' + username + ' 的密码。');
})();
