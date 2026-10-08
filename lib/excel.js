const ExcelJS = require('exceljs');
const { HttpError } = require('./http');

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.text != null) return String(v.text).trim();
    if (v.result != null) return String(v.result).trim();
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    return '';
  }
  return String(v).trim();
}

// columns: [{ key, header, width }]
async function sendWorkbook(res, filename, sheetName, columns, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 20 }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}

// يقرأ أول ورقة، والصف الأول عناوين. يرجع [{ row, <key>: text }]
async function readSheet(buffer, columns) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw new HttpError(400, 'الملف ليس ملف Excel (.xlsx) صالحاً'); }
  const ws = wb.worksheets[0];
  if (!ws) throw new HttpError(400, 'الملف فارغ');
  const byHeader = new Map(columns.map((c) => [c.header, c.key]));
  const idx = {};
  ws.getRow(1).eachCell((cell, n) => {
    const key = byHeader.get(cellText(cell.value));
    if (key) idx[key] = n;
  });
  const out = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const item = { row: rowNum };
    let any = false;
    for (const c of columns) {
      item[c.key] = idx[c.key] ? cellText(row.getCell(idx[c.key]).value) : '';
      if (item[c.key]) any = true;
    }
    if (any) out.push(item);
  });
  return out;
}

module.exports = { sendWorkbook, readSheet };
