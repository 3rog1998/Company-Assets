// الاستخدام: npm run set-user -- <اسم-المستخدم> "<كلمة-المرور>" "<الاسم>" [--admin]
const { db } = require('../lib/db');
const auth = require('../lib/auth');

const args = process.argv.slice(2);
const admin = args.includes('--admin');
const [login, password, name] = args.filter((a) => a !== '--admin');

if (!login || !password) {
  console.error('الاستخدام: npm run set-user -- <اسم-المستخدم> "<كلمة-المرور>" "<الاسم>" [--admin]');
  process.exit(1);
}
if (password.length < auth.MIN_PASSWORD) {
  console.error(`كلمة المرور يجب ألا تقل عن ${auth.MIN_PASSWORD} أحرف`);
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE login = ?').get(login);
if (existing) {
  auth.setPassword(existing.id, password);
  if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, existing.id);
  if (admin) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
  db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(existing.id);
  console.log(`✔ تم تحديث المستخدم ${login}`);
} else {
  db.prepare('INSERT INTO users (login, name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(login, name || login, auth.hashPassword(password), admin ? 'admin' : 'viewer');
  console.log(`✔ تم إنشاء المستخدم ${login}${admin ? ' (مدير عام)' : ' (اطّلاع فقط)'}`);
}
