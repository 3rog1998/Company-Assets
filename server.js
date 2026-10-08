const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { db, UPLOAD_DIR } = require('./lib/db');
const { HttpError, str, upload, removeFile } = require('./lib/http');
const auth = require('./lib/auth');

const app = express();
app.disable('x-powered-by');
// خلف خادم وسيط (Nginx/استضافة) فقط: TRUST_PROXY=1 — وإلا يمكن تزوير عنوان IP وتجاوز حد محاولات الدخول
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(auth.loadUser);

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
const setSetting = (key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);

// ---------- الدخول ----------

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (auth.loginLimited(ip)) throw new HttpError(429, 'محاولات كثيرة — حاول بعد 15 دقيقة');
  const login = str(req.body?.login, 200);
  const password = String(req.body?.password ?? '');
  const user = db.prepare('SELECT * FROM users WHERE login = ? AND disabled = 0').get(login);
  if (!auth.verifyLogin(user, password)) {
    auth.recordFailure(ip);
    throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
  }
  auth.clearFailures(ip);
  res.cookie(auth.COOKIE, auth.createToken(user.id, user.token_version), auth.cookieOptions());
  res.json({ id: user.id, login: user.login, name: user.name, role: user.role });
});

app.post('/api/logout', (_req, res) => {
  res.clearCookie(auth.COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const sig = db.prepare('SELECT signature_file FROM users WHERE id = ?').get(req.user.id)?.signature_file;
  res.json({ user: { ...req.user, has_signature: Boolean(sig) } });
});

// كل ما بعد هذا السطر يتطلب تسجيل الدخول
app.use('/api', auth.requireAuth);

// صلاحيتان فقط: المدير العام يدير كل شيء، وأي مستخدم آخر «اطّلاع فقط»
// (يُسمح له فقط بتغيير اسمه وكلمة مروره)
app.use('/api', (req, res, next) => {
  if (req.user.role === 'admin' || req.method === 'GET' || ['/me', '/me/password'].includes(req.path)) return next();
  res.status(403).json({ error: 'حسابك للاطلاع فقط — لا يمكنك تنفيذ هذه العملية' });
});

app.post('/api/me/password', (req, res) => {
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(current, row.password_hash)) throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة');
  if (next.length < auth.MIN_PASSWORD) throw new HttpError(400, `كلمة المرور الجديدة يجب ألا تقل عن ${auth.MIN_PASSWORD} أحرف`);
  // تنتهي جلسات الأجهزة الأخرى، ونجدد جلسة هذا الجهاز
  const version = auth.setPassword(req.user.id, next);
  res.cookie(auth.COOKIE, auth.createToken(req.user.id, version), auth.cookieOptions());
  res.json({ ok: true });
});

// الاسم الكامل والتوقيع (يظهران في خانة مسؤول العهدة بالنماذج)
app.put('/api/me', (req, res) => {
  const name = str(req.body?.name, 120);
  if (!name) throw new HttpError(400, 'الاسم مطلوب');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true });
});

app.post('/api/me/signature', upload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'لم يتم إرفاق ملف');
  if (req.file.mimetype !== 'image/png') {
    removeFile(req.file.filename);
    throw new HttpError(400, 'التوقيع يجب أن يكون صورة PNG');
  }
  const old = db.prepare('SELECT signature_file FROM users WHERE id = ?').get(req.user.id)?.signature_file;
  db.prepare('UPDATE users SET signature_file = ? WHERE id = ?').run(req.file.filename, req.user.id);
  removeFile(old);
  res.json({ ok: true });
});

app.delete('/api/me/signature', (req, res) => {
  removeFile(db.prepare('SELECT signature_file FROM users WHERE id = ?').get(req.user.id)?.signature_file);
  db.prepare('UPDATE users SET signature_file = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.get('/api/signatures/:userId', (req, res) => {
  const file = db.prepare('SELECT signature_file FROM users WHERE id = ?').get(Number(req.params.userId))?.signature_file;
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'private, no-cache');
  res.sendFile(path.join(UPLOAD_DIR, path.basename(file)));
});

// ---------- إدارة المستخدمين (المدير العام فقط) ----------

const usersRouter = express.Router();
usersRouter.use(auth.requireAdmin);

const activeAdmins = (exceptId) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?").get(exceptId).n;
function mustUser(id) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
  if (!u) throw new HttpError(404, 'المستخدم غير موجود');
  return u;
}
function checkPassword(p) {
  if (String(p ?? '').length < auth.MIN_PASSWORD) throw new HttpError(400, `كلمة المرور يجب ألا تقل عن ${auth.MIN_PASSWORD} أحرف`);
}

usersRouter.get('/', (_req, res) => {
  res.json(db.prepare(`SELECT id, login, name, role, disabled, created_at,
    (SELECT MAX(created_at) FROM events WHERE user_id = users.id) AS last_activity
    FROM users ORDER BY role = 'admin' DESC, disabled, id`).all());
});

usersRouter.post('/', (req, res) => {
  const login = str(req.body?.login, 100);
  const name = str(req.body?.name, 120);
  if (!login || /\s/.test(login)) throw new HttpError(400, 'اسم المستخدم مطلوب وبدون مسافات');
  if (!name) throw new HttpError(400, 'الاسم مطلوب');
  checkPassword(req.body?.password);
  if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw new HttpError(400, 'اسم المستخدم مستخدم مسبقاً');
  // كل المستخدمين الجدد «اطّلاع فقط»
  db.prepare("INSERT INTO users (login, name, password_hash, role) VALUES (?, ?, ?, 'viewer')")
    .run(login, name, auth.hashPassword(String(req.body.password)));
  res.status(201).json({ ok: true });
});

usersRouter.put('/:id', (req, res) => {
  const u = mustUser(req.params.id);
  const name = str(req.body?.name, 120) || u.name;
  const disabled = req.body?.disabled === undefined ? u.disabled : (req.body.disabled ? 1 : 0);
  if (u.id === req.user.id && disabled) throw new HttpError(400, 'لا يمكنك إيقاف حسابك');
  if (u.role === 'admin' && disabled && !activeAdmins(u.id)) throw new HttpError(400, 'يجب أن يبقى مدير عام واحد على الأقل');
  if (req.body?.password) checkPassword(req.body.password);
  db.prepare('UPDATE users SET name = ?, disabled = ? WHERE id = ?').run(name, disabled, u.id);
  if (req.body?.password) auth.setPassword(u.id, String(req.body.password)); // يُخرج المستخدم من كل أجهزته
  res.json({ ok: true });
});

app.use('/api/users', usersRouter);

// ---------- الأقسام ----------

app.use('/api/assets', require('./routes/assets').router);
app.use('/api/employees', require('./routes/employees').router);
app.use('/api/moves', require('./routes/moves').router);

app.get('/api/stats', (_req, res) => {
  const assets = { available: 0, reserved: 0, issued: 0, returning: 0, retired: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM assets GROUP BY status').all()) assets[r.status] = r.n;
  const pending = { handover: 0, return: 0 };
  for (const r of db.prepare("SELECT type, COUNT(*) AS n FROM moves WHERE status = 'pending' GROUP BY type").all()) pending[r.type] = r.n;
  const employees = db.prepare("SELECT COUNT(DISTINCT holder_id) AS n FROM assets WHERE status IN ('issued', 'returning')").get().n;
  res.json({ assets, pending, employees_with_custody: employees });
});

// ---------- الإعدادات ----------

const SETTING_KEYS = ['company_address', 'company_phone'];

// مسؤول العهدة في النماذج = المدير العام
function getOfficer() {
  return db.prepare(`SELECT id, name, (signature_file IS NOT NULL) AS has_signature FROM users
    WHERE disabled = 0 AND role = 'admin' ORDER BY id LIMIT 1`).get() || null;
}

app.get('/api/settings', (_req, res) => {
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, getSetting(k)]));
  out.has_logo = Boolean(getSetting('logo_file'));
  out.officer = getOfficer();
  res.json(out);
});

app.put('/api/settings', (req, res) => {
  for (const k of SETTING_KEYS) if (k in (req.body || {})) setSetting(k, str(req.body[k], 500));
  res.json({ ok: true });
});

app.post('/api/settings/logo', upload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'لم يتم إرفاق ملف');
  if (!req.file.mimetype.startsWith('image/')) {
    removeFile(req.file.filename);
    throw new HttpError(400, 'الشعار يجب أن يكون صورة');
  }
  const old = getSetting('logo_file');
  setSetting('logo_file', req.file.filename);
  removeFile(old);
  res.json({ ok: true });
});

app.delete('/api/settings/logo', (_req, res) => {
  removeFile(getSetting('logo_file'));
  setSetting('logo_file', '');
  res.json({ ok: true });
});

app.get('/api/logo', (_req, res) => {
  const name = getSetting('logo_file');
  if (!name) return res.status(404).end();
  res.sendFile(path.join(UPLOAD_DIR, path.basename(name)));
});

// ---------- المرفقات (محمية بتسجيل الدخول) ----------

app.get('/api/files/:name', (req, res) => {
  const name = path.basename(req.params.name);
  if (!db.prepare('SELECT 1 FROM moves WHERE signed_file = ?').get(name)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(UPLOAD_DIR, name));
});

// ---------- الواجهة ----------

// no-cache: المتصفح يتحقق من وجود نسخة أحدث في كل مرة (مع ETag) حتى تظهر التحديثات فوراً
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, file) => { if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache'); },
}));

app.use((err, req, res, _next) => {
  // ملف رُفع ثم فشل الطلب: لا نترك ملفاً يتيماً على القرص
  if (req.file?.filename) removeFile(req.file.filename);
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من المسموح' : 'خطأ في رفع الملف';
    return res.status(400).json({ error: msg });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const body = { error: status >= 500 ? 'حدث خطأ غير متوقع في الخادم' : err.message };
  res.status(status).json(body);
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`✔ نظام العهد يعمل على http://localhost:${PORT}`);
  if (!auth.hasSecret) console.warn('⚠️  SESSION_SECRET غير مضبوط في .env — سيتم استخدام سر مؤقت (ستنتهي الجلسات عند إعادة التشغيل).');
  if (!users) console.log('ℹ️  لا يوجد مستخدمون بعد. أنشئ المدير العام:  npm run set-user -- <اسم-المستخدم> "<كلمة-المرور>" "<الاسم>" --admin');
});
