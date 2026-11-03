const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CarryNote = require('../public/carry-note');

const surplus = { rest: 8000, next: '板深72-H4' };
const deficit = { rest: -3200, next: '' };
const settled = { rest: 0.2, next: '下一井' };

test('未改过时回显自动结转说明', () => {
  assert.equal(CarryNote.defaultText(settled), '本井无余额结转，下口井按自身考核额单独清算');
  assert.equal(CarryNote.defaultText(surplus), '自动结转至本队下口井「板深72-H4」，并入其终考核一并清算');
  assert.equal(CarryNote.defaultText(deficit), '自动结转至本队下口井，待下口井入库审核后自动并入');
  assert.equal(CarryNote.displayText(undefined, surplus), CarryNote.defaultText(surplus));
  assert.equal(CarryNote.displayText(null, deficit), CarryNote.defaultText(deficit));
});

test('自定义说明原样保存，刷新后按保存值回显', () => {
  const typed = '经队部确认，挂账随下口井「板深72-H4」完井后单独清算';
  const stored = CarryNote.toStored(typed, surplus);
  assert.equal(stored, typed);
  assert.equal(CarryNote.displayText(stored, surplus), typed);
});

test('留空或改回自动原文时不冻结说明，回显仍跟随结转结果', () => {
  const auto = CarryNote.defaultText(surplus);
  assert.equal(CarryNote.toStored('', surplus), null);
  assert.equal(CarryNote.toStored('   ', surplus), null);
  assert.equal(CarryNote.toStored(auto, surplus), null);
  assert.equal(CarryNote.displayText(CarryNote.toStored('', deficit), deficit), CarryNote.defaultText(deficit));
});

test('金额尚未算出时不把说明写成已结清', () => {
  assert.equal(
    CarryNote.defaultText({ rest: NaN, next: '下一井' }),
    '自动结转至本队下口井「下一井」，并入其终考核一并清算'
  );
});

test('说明最长 500 字', () => {
  const long = '注'.repeat(620);
  const stored = CarryNote.toStored(long, settled);
  assert.equal(stored.length, CarryNote.MAX);
  assert.equal(CarryNote.displayText(stored, settled), stored);
});

test('兑现登记页面把结转处理说明做成可保存的输入框', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /<script src="\/carry-note\.js"><\/script>/);
  assert.match(html, /data-cn=/);
  assert.match(html, /CarryNote\.displayText\(r\.rec&&r\.rec\.carryNote, r\)/);
  assert.match(html, /CarryNote\.toStored\(inp\.value, row\)/);
  assert.match(html, /commitCarryNote\(inp, rows, true\)/);
  assert.match(html, /saveWells\(\{keepalive:true\}\)/);
});
