const express = require('express');
const { db, tx, logEvent, pad } = require('../lib/db');
const { HttpError, str, uploadMem } = require('../lib/http');
const { sendWorkbook, readSheet } = require('../lib/excel');

const router = express.Router();

const STATUS_AR = {
  available: 'متاحة في المستودع', reserved: 'بانتظار توقيع التسليم', issued: 'مسلّمة',
  returning: 'بانتظار توقيع الإرجاع', retired: 'خارج الخدمة',
};

const COLUMNS = [
  { key: 'ref', header: 'الرقم المرجعي', width: 14 },
  { key: 'name', header: 'الاسم', width: 28 },
  { key: 'category', header: 'التصنيف', width: 18 },
  { key: 'brand', header: 'الماركة/الموديل', width: 22 },
  { key: 'serial', header: 'الرقم التسلسلي', width: 22 },
  { key: 'notes', header: 'ملاحظات', width: 30 },
  { key: 'status_ar', header: 'الحالة (للعرض فقط)', width: 22 },
  { key: 'holder_name', header: 'الموظف الحالي (للعرض فقط)', width: 24 },
];

const SELECT = `SELECT a.*, e.name AS holder_name FROM assets a LEFT JOIN employees e ON e.id = a.holder_id`;

function mustAsset(id) {
  const a = db.prepare(`${SELECT} WHERE a.id = ?`).get(Number(id));
  if (!a) throw new HttpError(404, 'العهدة غير موجودة');
  return a;
}

function cleanFields(body) {
  const name = str(body?.name, 150);
  if (!name) throw new HttpError(400, 'اسم العهدة مطلوب');
  return { name, category: str(body?.category, 80), brand: str(body?.brand, 120), notes: str(body?.notes, 500) };
}

function serialTaken(serial, exceptId = 0) {
  return Boolean(serial && db.prepare('SELECT 1 FROM assets WHERE serial = ? AND id <> ?').get(serial, exceptId));
}

function insertAsset(f, serial) {
  const r = db.prepare('INSERT INTO assets (name, category, brand, serial, notes) VALUES (?, ?, ?, ?, ?)')
    .run(f.name, f.category, f.brand, serial, f.notes);
  const id = Number(r.lastInsertRowid);
  db.prepare('UPDATE assets SET ref = ? WHERE id = ?').run(`AST-${pad(id)}`, id);
  return id;
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  const q = str(req.query.q, 100);
  if (q) {
    const like = `%${q}%`;
    where.push('(a.name LIKE ? OR a.ref LIKE ? OR a.serial LIKE ? OR a.category LIKE ? OR a.brand LIKE ? OR e.name LIKE ?)');
    params.push(like, like, like, like, like, like);
  }
  if (req.query.status && STATUS_AR[req.query.status]) { where.push('a.status = ?'); params.push(req.query.status); }
  if (req.query.category) { where.push('a.category = ?'); params.push(str(req.query.category, 80)); }
  if (req.query.holder) { where.push('a.holder_id = ?'); params.push(Number(req.query.holder)); }
  const sql = `${SELECT}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC`;
  res.json(db.prepare(sql).all(...params));
});

router.get('/categories', (_req, res) => {
  res.json(db.prepare("SELECT DISTINCT category FROM assets WHERE category <> '' ORDER BY category").all().map((r) => r.category));
});

router.get('/export', async (_req, res) => {
  const rows = db.prepare(`${SELECT} ORDER BY a.id`).all().map((a) => ({ ...a, status_ar: STATUS_AR[a.status] }));
  await sendWorkbook(res, 'assets.xlsx', 'العهد', COLUMNS, rows);
});

router.post('/import', uploadMem.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'لم يتم إرفاق ملف');
  const rows = await readSheet(req.file.buffer, COLUMNS);
  const errors = [];
  const plan = [];
  const seen = new Map();
  for (const r of rows) {
    let f;
    try { f = cleanFields(r); } catch (e) { errors.push(`صف ${r.row}: ${e.message}`); continue; }
    const serial = str(r.serial, 100) || null;
    let id = null;
    if (r.ref) {
      const a = db.prepare('SELECT id FROM assets WHERE ref = ?').get(r.ref);
      if (!a) { errors.push(`صف ${r.row}: الرقم المرجعي ${r.ref} غير موجود`); continue; }
      id = a.id;
    }
    if (serial) {
      if (serialTaken(serial, id ?? 0)) { errors.push(`صف ${r.row}: الرقم التسلسلي ${serial} مسجل لعهدة أخرى`); continue; }
      if (seen.has(serial)) { errors.push(`صف ${r.row}: الرقم التسلسلي ${serial} مكرر في الملف (صف ${seen.get(serial)})`); continue; }
      seen.set(serial, r.row);
    }
    plan.push({ id, f, serial });
  }
  if (errors.length) return res.status(400).json({ error: 'يوجد أخطاء في الملف — لم يُطبَّق شيء', errors });
  let added = 0, updated = 0;
  tx(() => {
    for (const { id, f, serial } of plan) {
      if (id) {
        db.prepare('UPDATE assets SET name = ?, category = ?, brand = ?, serial = ?, notes = ? WHERE id = ?')
          .run(f.name, f.category, f.brand, serial, f.notes, id);
        updated++;
      } else { insertAsset(f, serial); added++; }
    }
  });
  logEvent(req.user.id, 'import', 'asset', null, `إضافة ${added} / تعديل ${updated}`);
  res.json({ ok: true, added, updated });
});

router.get('/:id', (req, res) => {
  const asset = mustAsset(req.params.id);
  const history = db.prepare(`SELECT m.id, m.ref, m.type, m.status, m.created_at, m.signed_at, e.name AS employee_name
    FROM move_items i JOIN moves m ON m.id = i.move_id JOIN employees e ON e.id = m.employee_id
    WHERE i.asset_id = ? ORDER BY m.id DESC`).all(asset.id);
  res.json({ ...asset, status_ar: STATUS_AR[asset.status], history });
});

// إضافة وحدة أو عدة وحدات: serials = قائمة أرقام تسلسلية (وحدة لكل رقم)، أو quantity لوحدات بلا رقم
router.post('/', (req, res) => {
  const f = cleanFields(req.body);
  const serials = [...new Set((Array.isArray(req.body?.serials) ? req.body.serials : []).map((s) => str(s, 100)).filter(Boolean))];
  const quantity = Math.floor(Number(req.body?.quantity) || 1);
  const count = serials.length || quantity;
  if (count < 1 || count > 500) throw new HttpError(400, 'العدد يجب أن يكون بين 1 و500');
  for (const s of serials) if (serialTaken(s)) throw new HttpError(400, `الرقم التسلسلي ${s} مسجل مسبقاً`);
  const ids = tx(() => Array.from({ length: count }, (_, i) => insertAsset(f, serials[i] ?? null)));
  logEvent(req.user.id, 'create', 'asset', ids[0], `${f.name} × ${count}`);
  res.status(201).json({ ids });
});

router.put('/:id', (req, res) => {
  const a = mustAsset(req.params.id);
  const f = cleanFields(req.body);
  const serial = str(req.body?.serial, 100) || null;
  if (serialTaken(serial, a.id)) throw new HttpError(400, `الرقم التسلسلي ${serial} مسجل لعهدة أخرى`);
  db.prepare('UPDATE assets SET name = ?, category = ?, brand = ?, serial = ?, notes = ? WHERE id = ?')
    .run(f.name, f.category, f.brand, serial, f.notes, a.id);
  logEvent(req.user.id, 'update', 'asset', a.id, a.ref);
  res.json({ ok: true });
});

router.post('/:id/retire', (req, res) => {
  const a = mustAsset(req.params.id);
  if (a.status !== 'available') throw new HttpError(400, 'يمكن إخراج العهدة من الخدمة فقط وهي في المستودع');
  db.prepare("UPDATE assets SET status = 'retired' WHERE id = ?").run(a.id);
  logEvent(req.user.id, 'retire', 'asset', a.id, `${a.ref} ${str(req.body?.reason, 200)}`);
  res.json({ ok: true });
});

router.post('/:id/restore', (req, res) => {
  const a = mustAsset(req.params.id);
  if (a.status !== 'retired') throw new HttpError(400, 'العهدة ليست خارج الخدمة');
  db.prepare("UPDATE assets SET status = 'available' WHERE id = ?").run(a.id);
  logEvent(req.user.id, 'restore', 'asset', a.id, a.ref);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const a = mustAsset(req.params.id);
  if (db.prepare('SELECT 1 FROM move_items WHERE asset_id = ?').get(a.id)) {
    throw new HttpError(400, 'للعهدة سجل نماذج — لا يمكن حذفها، يمكنك إخراجها من الخدمة');
  }
  db.prepare('DELETE FROM assets WHERE id = ?').run(a.id);
  logEvent(req.user.id, 'delete', 'asset', a.id, a.ref);
  res.json({ ok: true });
});

module.exports = { router };
