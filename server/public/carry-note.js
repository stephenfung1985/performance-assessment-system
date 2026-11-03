// 兑现登记 · 单井兑现情况「结转处理说明」
// 未改过、留空、或与自动说明完全一致时不落自定义文本，界面继续按节余/挂账现算；
// 其余文字按原样保存（最长 500 字）。浏览器与测试共用这一份。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CarryNote = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX = 500;

  function defaultText(row) {
    const rest = Number(row && row.rest);
    // 金额还没算出来时不要写成「已结清」；只有真正结平才用这句
    if (Number.isFinite(rest) && Math.abs(rest) < 1) return '本井无余额结转，下口井按自身考核额单独清算';
    const next = row && row.next;
    return '自动结转至本队' + (next
      ? '下口井「' + next + '」，并入其终考核一并清算'
      : '下口井，待下口井入库审核后自动并入');
  }

  // saved：井记录上的 carryNote。不是字符串（缺省 / null）时回显自动说明。
  function displayText(saved, row) {
    return typeof saved === 'string' ? saved.slice(0, MAX) : defaultText(row);
  }

  // 写回井记录的值。null = 继续用自动说明，不要把原文冻结进库。
  function toStored(raw, row) {
    const text = String(raw == null ? '' : raw).slice(0, MAX);
    if (text.trim() === '' || text === defaultText(row)) return null;
    return text;
  }

  return { MAX: MAX, defaultText: defaultText, displayText: displayText, toStored: toStored };
});
