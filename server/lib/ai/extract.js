// ============================================================
// 上传文件 → 纯文本。表格一律压成「单元格 | 单元格」一行一行，表头和数值的
// 对应关系保留下来，大模型和本地词典解析都靠它认字段。
// 类型先看文件头魔数、再看扩展名：同事常把 .xlsx 改名成 .xls、把网页另存成 .doc，
// 只认扩展名会大量误判。解析库按需加载，缺依赖时只影响本功能，不拖垮整个服务。
// ============================================================
const path = require('path');

const ACCEPT = ['.docx', '.doc', '.pdf', '.xlsx', '.xls', '.csv', '.txt'];
const MAX_CHARS = Number(process.env.AI_MAX_CHARS) || 30000;

function sniff(buf) {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4B) return 'zip';
  if (buf.length >= 4 && buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) return 'ole2';
  if (buf.length >= 5 && buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf.length >= 5 && /^\{\\rtf/.test(buf.slice(0, 5).toString('latin1'))) return 'rtf';
  return '';
}

// 中文 CSV/TXT 常见 GBK：先按 UTF-8 严格解，失败再试 GB18030
function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.slice(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) {}
  try { return new TextDecoder('gb18030').decode(buf); } catch (_) {}
  return buf.toString('utf8');
}

const decodeEntities = s => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

// mammoth 输出的 HTML → 文本：表格行转「a | b | c」（单元格里的段落先压成一行），段落换行
const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function htmlToText(html) {
  html = String(html).replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row) =>
    [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => stripTags(m[1])).filter(Boolean).join(' | ') + '\n');
  return decodeEntities(html
    .replace(/<\/(p|h\d|li|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

async function fromDocx(buf) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ buffer: buf });
  return { text: htmlToText(r.value) };
}

async function fromDoc(buf) {
  const WordExtractor = require('word-extractor');
  const doc = await new WordExtractor().extract(buf);
  // .doc 表格单元格以 \t 分隔，统一成 | 与其它格式一致
  const text = [doc.getBody(), doc.getHeaders && doc.getHeaders({ includeFooters: true })].filter(Boolean).join('\n')
    .split(/\r?\n/).map(l => l.split('\t').map(c => c.trim()).filter(Boolean).join(' | ')).filter(Boolean).join('\n');
  return { text };
}

async function fromSheet(buf, isCsv) {
  const XLSX = require('xlsx');
  const wb = isCsv
    ? XLSX.read(decodeText(buf), { type: 'string', sheetRows: 3000, raw: true })
    : XLSX.read(buf, { type: 'buffer', sheetRows: 3000, cellDates: true });
  const parts = [];
  wb.SheetNames.forEach(name => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
    const lines = rows.map(r => r.map(c => String(c).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')).filter(Boolean);
    if (lines.length) parts.push('【工作表：' + name + '】\n' + lines.join('\n'));
  });
  return { text: parts.join('\n\n'), sheets: wb.SheetNames.length };
}

// PDF：按 y 坐标把文字片段归成行，同一行里间距明显的片段之间插「|」，近似还原表格列
async function fromPdf(buf) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const pages = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 80); i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    const rows = new Map();
    tc.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], w: it.width || 0, s: it.str, h: Math.abs(it.transform[3]) || 10 });
    });
    const lines = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => {
      items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      items.forEach(t => {
        if (end != null) out += (t.x - end > t.h * 1.5) ? ' | ' : (t.x - end > t.h * 0.25 ? ' ' : '');
        out += t.s; end = t.x + t.w;
      });
      return out.trim();
    }).filter(Boolean);
    pages.push(lines.join('\n'));
  }
  const text = pages.map((p, i) => pdf.numPages > 1 ? '【第 ' + (i + 1) + ' 页】\n' + p : p).join('\n\n');
  const chars = pages.join('').replace(/\s/g, '').length;
  return { text, pages: pdf.numPages, scanned: chars < 30 * Math.min(pdf.numPages, 80) };
}

// name 只用来判断扩展名与回显，返回 { name, kind, text, chars, pages?, warnings[] }
async function extract(buf, name) {
  const ext = path.extname(name || '').toLowerCase();
  if (!ACCEPT.includes(ext)) throw Object.assign(new Error('不支持的文件类型「' + (ext || '无扩展名') + '」，请上传 ' + ACCEPT.join(' / ')), { status: 415 });
  const magic = sniff(buf), warnings = [];
  let kind, r;
  if (magic === 'pdf') { kind = 'pdf'; r = await fromPdf(buf); }
  else if (magic === 'zip' && ['.docx', '.doc'].includes(ext)) { kind = 'docx'; r = await fromDocx(buf); }
  else if (magic === 'zip') { kind = 'xlsx'; r = await fromSheet(buf); }
  else if (magic === 'ole2' && ext === '.doc') { kind = 'doc'; r = await fromDoc(buf); }
  else if (magic === 'ole2') { kind = 'xls'; r = await fromSheet(buf); }
  else if (magic === 'rtf') throw Object.assign(new Error('这是 RTF 格式文件，请在 Word 里「另存为」.docx 后再上传'), { status: 415 });
  else if (ext === '.pdf') throw Object.assign(new Error('文件扩展名是 .pdf，但内容不是 PDF，可能已损坏'), { status: 415 });
  else if (ext === '.csv') { kind = 'csv'; r = await fromSheet(buf, true); }
  else if (ext === '.xls') { kind = 'xls'; r = await fromSheet(buf); }      // Excel 2003 XML / 网页另存的 .xls
  else if (ext === '.txt') { kind = 'txt'; r = { text: decodeText(buf) }; }
  else if (ext === '.doc' && /<html|<table/i.test(buf.slice(0, 4096).toString('latin1'))) { kind = 'doc'; r = { text: htmlToText(decodeText(buf)) }; }
  else throw Object.assign(new Error('文件内容与扩展名不符，无法识别。请用 Word / Excel 打开后另存为 .docx / .xlsx 再上传'), { status: 415 });

  let text = String(r.text || '').replace(/\u0000/g, '').trim();
  if (r.scanned) warnings.push('这份 PDF 几乎没有可提取的文字，可能是扫描件，或文字用了未嵌入的字体。系统暂不支持 OCR，请上传 Word / Excel 原件，或用 Word / WPS 重新「导出为 PDF」后再上传。');
  else if (!text) warnings.push('没有提取到任何文字内容。');
  if (text.length > MAX_CHARS) {
    warnings.push('内容较长（' + text.length + ' 字），只取前 ' + MAX_CHARS + ' 字参与解析。可只上传含基本数据表的那部分资料。');
    text = text.slice(0, MAX_CHARS);
  }
  return { name: String(name).slice(0, 120), kind, text, chars: text.length, pages: r.pages, scanned: !!r.scanned, warnings };
}

module.exports = { extract, ACCEPT };
