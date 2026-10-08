const express = require('express');
const { db, tx, logEvent, pad } = require('../lib/db');
const { HttpError, str, upload, removeFile } = require('../lib/http');

const router = express.Router();
const PREFIX = { handover: 'HO', return: 'RT' };

function mustMove(id) {
  const m = db.prepare(`SELECT m.*, e.name AS employee_name, u.name AS created_by_name
    FROM moves m JOIN employees e ON e.id = m.employee_id LEFT JOIN users u ON u.id = m.created_by WHERE m.id = ?`).get(Number(id));
  if (!m) throw new HttpError(404, 'النموذج غير موجود');
  return m;
}

const itemsOf = (moveId) => db.prepare(`SELECT i.asset_id, i.returned, i.reason, a.ref, a.name, a.category, a.brand, a.serial
  FROM move_items i JOIN assets a ON a.id = i.asset_id WHERE i.move_id = ? ORDER BY a.id`).all(moveId);

const ids = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map(Number).filter(Number.isInteger))];

// يطبّق أثر نموذج جديد/معدّل (حجز العهد) بعد التحقق منها
function applyItems(move, body) {
  const emp = move.employee_id;
  const selected = ids(body?.asset_ids);
  if (!selected.length) throw new HttpError(400, 'اختر عهدة واحدة على الأقل');
  const get = db.prepare('SELECT * FROM assets WHERE id = ?');

  if (move.type === 'handover') {
    for (const id of selected) {
      const a = get.get(id);
      if (!a) throw new HttpError(400, 'عهدة غير موجودة');
      if (a.status !== 'available') throw new HttpError(400, `العهدة ${a.ref} غير متاحة للتسليم`);
    }
    for (const id of selected) {
      db.prepare('INSERT INTO move_items (move_id, asset_id) VALUES (?, ?)').run(move.id, id);
      db.prepare("UPDATE assets SET status = 'reserved', holder_id = ? WHERE id = ?").run(emp, id);
    }
    return;
  }

  // إرجاع: المحددة تُرجَع، وبقية عهد الموظف الفعالة تُسجَّل «لم تُرجَع» مع السبب
  for (const id of selected) {
    const a = get.get(id);
    if (!a || a.holder_id !== emp || a.status !== 'issued') throw new HttpError(400, `العهدة ${a?.ref ?? id} ليست في ذمة هذا الموظف`);
  }
  const reasons = new Map((Array.isArray(body?.excluded) ? body.excluded : []).map((x) => [Number(x.asset_id), str(x.reason, 200)]));
  const remaining = db.prepare("SELECT id FROM assets WHERE holder_id = ? AND status = 'issued'").all(emp)
    .map((r) => r.id).filter((id) => !selected.includes(id));
  for (const id of selected) {
    db.prepare('INSERT INTO move_items (move_id, asset_id, returned) VALUES (?, ?, 1)').run(move.id, id);
    db.prepare("UPDATE assets SET status = 'returning' WHERE id = ?").run(id);
  }
  for (const id of remaining) {
    db.prepare('INSERT INTO move_items (move_id, asset_id, returned, reason) VALUES (?, ?, 0, ?)').run(move.id, id, reasons.get(id) || '');
  }
}

// يعيد العهد لوضعها قبل النموذج (عند الإلغاء/التعديل)
function revertItems(move) {
  const col = move.type === 'handover'
    ? "UPDATE assets SET status = 'available', holder_id = NULL WHERE id = ? AND status = 'reserved'"
    : "UPDATE assets SET status = 'issued' WHERE id = ? AND status = 'returning'";
  for (const i of db.prepare('SELECT asset_id FROM move_items WHERE move_id = ? AND returned = 1').all(move.id)) {
    db.prepare(col).run(i.asset_id);
  }
  db.prepare('DELETE FROM move_items WHERE move_id = ?').run(move.id);
}

router.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (PREFIX[req.query.type]) { where.push('m.type = ?'); params.push(req.query.type); }
  if (['pending', 'signed', 'cancelled'].includes(req.query.status)) { where.push('m.status = ?'); params.push(req.query.status); }
  if (req.query.employee) { where.push('m.employee_id = ?'); params.push(Number(req.query.employee)); }
  const q = str(req.query.q, 100);
  if (q) { where.push('(m.ref LIKE ? OR e.name LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  res.json(db.prepare(`SELECT m.id, m.ref, m.type, m.status, m.employee_id, m.created_at, m.signed_at, e.name AS employee_name,
      (SELECT COUNT(*) FROM move_items WHERE move_id = m.id AND returned = 1) AS items_count,
      (SELECT COUNT(*) FROM move_items WHERE move_id = m.id AND returned = 0) AS kept_count
    FROM moves m JOIN employees e ON e.id = m.employee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.id DESC`).all(...params));
});

router.get('/:id', (req, res) => {
  const move = mustMove(req.params.id);
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(move.employee_id);
  const officer = db.prepare(`SELECT id, name, (signature_file IS NOT NULL) AS has_signature FROM users
    WHERE disabled = 0 AND role = 'admin' ORDER BY id LIMIT 1`).get() || null;
  res.json({ ...move, employee, officer, items: itemsOf(move.id) });
});

router.post('/', (req, res) => {
  const type = req.body?.type;
  if (!PREFIX[type]) throw new HttpError(400, 'نوع النموذج غير صحيح');
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(Number(req.body?.employee_id));
  if (!employee) throw new HttpError(400, 'اختر الموظف');
  const id = tx(() => {
    const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM moves WHERE type = ?').get(type).n;
    const r = db.prepare('INSERT INTO moves (ref, type, seq, employee_id, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${PREFIX[type]}-${pad(seq)}`, type, seq, employee.id, str(req.body?.notes, 500), req.user.id);
    const move = { id: Number(r.lastInsertRowid), type, employee_id: employee.id };
    applyItems(move, req.body);
    return move.id;
  });
  const m = mustMove(id);
  logEvent(req.user.id, 'create', 'move', id, m.ref);
  res.status(201).json({ id, ref: m.ref });
});

router.put('/:id', (req, res) => {
  const m = mustMove(req.params.id);
  if (m.status !== 'pending') throw new HttpError(400, 'لا يمكن تعديل نموذج موقّع أو ملغى');
  tx(() => {
    revertItems(m);
    db.prepare('UPDATE moves SET notes = ? WHERE id = ?').run(str(req.body?.notes, 500), m.id);
    applyItems(m, req.body);
  });
  logEvent(req.user.id, 'update', 'move', m.id, m.ref);
  res.json({ ok: true });
});

// إرفاق النموذج الموقّع (أو استبداله): يُنهي النموذج
router.post('/:id/sign', upload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'لم يتم إرفاق ملف');
  const m = mustMove(req.params.id);
  if (m.status === 'cancelled') throw new HttpError(400, 'النموذج ملغى');
  const old = m.signed_file;
  tx(() => {
    if (m.status === 'pending') {
      if (m.type === 'handover') {
        for (const i of itemsOf(m.id)) db.prepare("UPDATE assets SET status = 'issued' WHERE id = ? AND status = 'reserved'").run(i.asset_id);
      } else {
        for (const i of itemsOf(m.id).filter((x) => x.returned)) {
          db.prepare("UPDATE assets SET status = 'available', holder_id = NULL WHERE id = ? AND status = 'returning'").run(i.asset_id);
        }
      }
      db.prepare("UPDATE moves SET status = 'signed', signed_at = datetime('now'), signed_file = ? WHERE id = ?").run(req.file.filename, m.id);
    } else {
      db.prepare('UPDATE moves SET signed_file = ? WHERE id = ?').run(req.file.filename, m.id);
    }
  });
  removeFile(old);
  logEvent(req.user.id, m.status === 'pending' ? 'sign' : 'replace-file', 'move', m.id, m.ref);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const m = mustMove(req.params.id);
  if (m.status !== 'pending') throw new HttpError(400, 'لا يمكن إلغاء نموذج موقّع');
  tx(() => {
    revertItems(m);
    db.prepare("UPDATE moves SET status = 'cancelled' WHERE id = ?").run(m.id);
  });
  logEvent(req.user.id, 'cancel', 'move', m.id, m.ref);
  res.json({ ok: true });
});

module.exports = { router };
