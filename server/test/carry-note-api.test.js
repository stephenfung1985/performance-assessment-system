const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const CarryNote = require('../public/carry-note');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}

function cookieFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const hit = list.find(line => line.startsWith('kh_session='));
  if (!hit) throw new Error('登录响应没有会话 cookie');
  return hit.split(';')[0];
}

async function waitHealth(port, child) {
  const deadline = Date.now() + 20000;
  let last = '';
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('服务提前退出，输出：\n' + child.logs);
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/api/health');
      if (res.ok) return;
      last = String(res.status);
    } catch (err) {
      last = err.message;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error('服务未在时限内启动：' + last + '\n' + child.logs);
}

test('结转处理说明随井库保存，登录用户可写，刷新后仍能读回', async (t) => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-note-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      JWT_SECRET: 'test-secret-carry-note',
      SEED_ADMIN_USER: 'admin',
      SEED_ADMIN_PASSWORD: 'admin-pass-1',
      COOKIE_SECURE: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.logs = '';
  child.stdout.on('data', chunk => { child.logs += chunk; });
  child.stderr.on('data', chunk => { child.logs += chunk; });
  t.after(async () => {
    if (child.exitCode == null) {
      child.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  await waitHealth(port, child);
  const base = 'http://127.0.0.1:' + port;

  const anon = await fetch(base + '/api/wells', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ id: 'W1', carryNote: '匿名不能写' }])
  });
  assert.equal(anon.status, 401);

  const adminLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-pass-1' })
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookieFrom(adminLogin);

  const created = await fetch(base + '/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: 'editor1', password: 'editor-pass-1', role: 'editor' })
  });
  assert.equal(created.status, 200, await created.text());

  const editorLogin = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'editor1', password: 'editor-pass-1' })
  });
  assert.equal(editorLogin.status, 200);
  const editorCookie = cookieFrom(editorLogin);

  const note = '经队部确认，挂账随下口井完井后单独清算';
  const row = { rest: -3200, next: '' };
  const wells = [{
    id: 'W-carry',
    at: 1700000000000,
    status: 'approved',
    pay: 15000,
    carryNote: note,
    w: { wellNo: '板深72-H3', team: '70318' }
  }, {
    id: 'W-auto',
    at: 1700000001000,
    status: 'approved',
    pay: 8000,
    w: { wellNo: '板深72-H4', team: '70318' }
  }];
  const saved = await fetch(base + '/api/wells', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: editorCookie },
    body: JSON.stringify(wells)
  });
  assert.equal(saved.status, 200, await saved.text());

  const again = await fetch(base + '/api/wells', { headers: { cookie: editorCookie } });
  assert.equal(again.status, 200);
  const body = await again.json();
  const custom = body.find(item => item.id === 'W-carry');
  const untouched = body.find(item => item.id === 'W-auto');
  assert.ok(custom, '刷新后应仍能读到已保存的井');
  assert.equal(custom.carryNote, note);
  assert.equal(custom.pay, 15000);
  assert.equal(CarryNote.displayText(custom.carryNote, row), note);
  assert.equal(untouched.carryNote, undefined);
  assert.equal(CarryNote.displayText(untouched.carryNote, { rest: 0, next: '' }), CarryNote.defaultText({ rest: 0, next: '' }));

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'wells.json'), 'utf8'));
  assert.equal(onDisk.find(item => item.id === 'W-carry').carryNote, note);

  const longNote = '超'.repeat(CarryNote.MAX + 40);
  const truncated = await fetch(base + '/api/wells', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: editorCookie },
    body: JSON.stringify([{ id: 'W-carry', status: 'approved', pay: 15000, carryNote: longNote, w: { wellNo: '板深72-H3', team: '70318' } }])
  });
  assert.equal(truncated.status, 200);
  const afterTrim = await (await fetch(base + '/api/wells', { headers: { cookie: editorCookie } })).json();
  assert.equal(afterTrim[0].carryNote.length, CarryNote.MAX);
  assert.equal(afterTrim[0].carryNote, longNote.slice(0, CarryNote.MAX));

  const script = await fetch(base + '/carry-note.js');
  assert.equal(script.status, 200);
  assert.match(await script.text(), /function displayText/);
});
