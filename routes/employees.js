const express = require('express');
const { db, tx, logEvent } = require('../lib/db');
const { HttpError, str, uploadMem } = require('../lib/http');
const { sendWorkbook, readSheet } = require('../lib/excel');

const router = express.Router();

const COLUMNS = [
  { key: 'id', header: 'رقم النظام', width: 12 },
  { key: 'emp_no', header: 'الرقم الوظيفي', width: 16 },
  { key: 'name', header: 'الاسم', width: 28 },
  { key: 'job_title', header: 'المسمى الوظيفي', width: 24 },
  { key: 'department', header: 'القسم', width: 20 },
  { key: 'phone', header: 'الجوال', width: 16 },
  { key: 'notes', header: 'ملاحظات', width: 30 },
];

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const phoneDigits = (v) => String(v ?? '')
  .replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d))
  .replace(/\D/g, '')
  .slice(0, 20);

function clean(body) {
  const name = str(body?.name, 120);
  if (!name) throw new HttpError(400, 'اسم الموظف مطلوب');
  return {
    emp_no: str(body?.emp_no, 50) || null,
    name,
    job_title: str(body?.job_title, 120),
    department: str(body?.department, 120),
    phone: phoneDigits(body?.phone),
    notes: str(body?.notes, 500),
  };
}

function mustEmployee(id) {
  const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(Number(id));
  if (!e) throw new HttpError(404, 'الموظف غير موجود');
  return e;
}

function checkEmpNo(empNo, exceptId = 0) {
  if (empNo && db.prepare('SELECT 1 FROM employees WHERE emp_no = ? AND id <> ?').get(empNo, exceptId)) {
    throw new HttpError(400, `الرقم الوظيفي ${empNo} مسجل لموظف آخر`);
  }
}

const LIST_SQL = `SELECT e.*, (SELECT COUNT(*) FROM assets a WHERE a.holder_id = e.id AND a.status IN ('issued', 'returning')) AS assets_count
  FROM employees e`;

router.get('/', (req, res) => {
  const q = str(req.query.q, 100);
  const like = `%${q}%`;
  const rows = q
    ? db.prepare(`${LIST_SQL} WHERE e.name LIKE ? OR e.emp_no LIKE ? OR e.department LIKE ? OR e.phone LIKE ? OR e.job_title LIKE ? ORDER BY e.name`).all(like, like, like, like, like)
    : db.prepare(`${LIST_SQL} ORDER BY e.name`).all();
  res.json(rows);
});

router.get('/export', async (_req, res) => {
  await sendWorkbook(res, 'employees.xlsx', 'الموظفون', COLUMNS, db.prepare('SELECT * FROM employees ORDER BY id').all());
});

router.post('/import', uploadMem.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'لم يتم إرفاق ملف');
  const rows = await readSheet(req.file.buffer, COLUMNS);
  const errors = [];
  const plan = [];
  const seenNos = new Map();
  for (const r of rows) {
    let data;
    try { data = clean(r); } catch (e) { errors.push(`صف ${r.row}: ${e.message}`); continue; }
    let target = null;
    if (r.id) {
      target = db.prepare('SELECT id FROM employees WHERE id = ?').get(Number(r.id));
      if (!target) { errors.push(`صف ${r.row}: رقم النظام ${r.id} غير موجود`); continue; }
    } else if (data.emp_no) {
      target = db.prepare('SELECT id FROM employees WHERE emp_no = ?').get(data.emp_no) || null;
    }
    if (data.emp_no) {
      const other = db.prepare('SELECT id FROM employees WHERE emp_no = ?').get(data.emp_no);
      if (other && other.id !== target?.id) { errors.push(`صف ${r.row}: الرقم الوظيفي ${data.emp_no} مسجل لموظف آخر`); continue; }
      if (seenNos.has(data.emp_no)) { errors.push(`صف ${r.row}: الرقم الوظيفي ${data.emp_no} مكرر في الملف (صف ${seenNos.get(data.emp_no)})`); continue; }
      seenNos.set(data.emp_no, r.row);
    }
    plan.push({ target: target?.id ?? null, data });
  }
  if (errors.length) return res.status(400).json({ error: 'يوجد أخطاء في الملف — لم يُطبَّق شيء', errors });
  let added = 0, updated = 0;
  tx(() => {
    for (const { target, data } of plan) {
      if (target) {
        db.prepare('UPDATE employees SET emp_no = ?, name = ?, job_title = ?, department = ?, phone = ?, notes = ? WHERE id = ?')
          .run(data.emp_no, data.name, data.job_title, data.department, data.phone, data.notes, target);
        updated++;
      } else {
        db.prepare('INSERT INTO employees (emp_no, name, job_title, department, phone, notes) VALUES (?, ?, ?, ?, ?, ?)')
          .run(data.emp_no, data.name, data.job_title, data.department, data.phone, data.notes);
        added++;
      }
    }
  });
  logEvent(req.user.id, 'import', 'employee', null, `إضافة ${added} / تعديل ${updated}`);
  res.json({ ok: true, added, updated });
});

router.get('/:id', (req, res) => {
  const employee = mustEmployee(req.params.id);
  const assets = db.prepare(`SELECT id, ref, name, category, serial, status FROM assets
    WHERE holder_id = ? AND status IN ('reserved', 'issued', 'returning') ORDER BY id`).all(employee.id);
  const moves = db.prepare('SELECT id, ref, type, status, created_at, signed_at FROM moves WHERE employee_id = ? ORDER BY id DESC').all(employee.id);
  res.json({ ...employee, assets, moves });
});

router.post('/', (req, res) => {
  const d = clean(req.body);
  checkEmpNo(d.emp_no);
  const r = db.prepare('INSERT INTO employees (emp_no, name, job_title, department, phone, notes) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.emp_no, d.name, d.job_title, d.department, d.phone, d.notes);
  logEvent(req.user.id, 'create', 'employee', r.lastInsertRowid, d.name);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/:id', (req, res) => {
  const e = mustEmployee(req.params.id);
  const d = clean(req.body);
  checkEmpNo(d.emp_no, e.id);
  db.prepare('UPDATE employees SET emp_no = ?, name = ?, job_title = ?, department = ?, phone = ?, notes = ? WHERE id = ?')
    .run(d.emp_no, d.name, d.job_title, d.department, d.phone, d.notes, e.id);
  logEvent(req.user.id, 'update', 'employee', e.id, d.name);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const e = mustEmployee(req.params.id);
  if (db.prepare('SELECT 1 FROM moves WHERE employee_id = ?').get(e.id)) {
    throw new HttpError(400, 'لا يمكن حذف موظف له نماذج مسجلة');
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(e.id);
  logEvent(req.user.id, 'delete', 'employee', e.id, e.name);
  res.json({ ok: true });
});

module.exports = { router };
