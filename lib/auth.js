const crypto = require('node:crypto');
const { db } = require('./db');
const { HttpError } = require('./http');

const hasSecret = Boolean(process.env.SESSION_SECRET);
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'sid';
const MIN_PASSWORD = 6;
const TOKEN_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const DUMMY = hashPassword('dummy-password');
function verifyLogin(user, password) {
  if (!user) { verifyPassword(password, DUMMY); return false; }
  return verifyPassword(password, user.password_hash);
}

const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function createToken(userId, version) {
  const payload = Buffer.from(JSON.stringify({ u: userId, v: version, e: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const good = sign(payload);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return p.e > Date.now() ? p : null;
  } catch { return null; }
}

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: TOKEN_DAYS * 864e5, path: '/' };
}

function loadUser(req, _res, next) {
  const raw = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(COOKIE + '='));
  const p = raw ? readToken(decodeURIComponent(raw.slice(COOKIE.length + 1))) : null;
  if (p) {
    const u = db.prepare('SELECT id, login, name, role, disabled, token_version FROM users WHERE id = ?').get(p.u);
    if (u && !u.disabled && u.token_version === p.v) req.user = { id: u.id, login: u.login, name: u.name, role: u.role };
  }
  next();
}

function setPassword(userId, pw) {
  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(pw), userId);
  return db.prepare('SELECT token_version FROM users WHERE id = ?').get(userId).token_version;
}

// حد محاولات الدخول الفاشلة: 10 محاولات لكل 15 دقيقة لكل عنوان
const failures = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 10;
function loginLimited(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW) { failures.delete(ip); return false; }
  return f.n >= MAX_FAILS;
}
function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW) failures.set(ip, { n: 1, first: Date.now() });
  else f.n++;
}
const clearFailures = (ip) => failures.delete(ip);

function requireAuth(req, _res, next) {
  if (!req.user) throw new HttpError(401, 'يجب تسجيل الدخول');
  next();
}
function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'هذه العملية للمدير العام فقط');
  next();
}

module.exports = {
  COOKIE, MIN_PASSWORD, hasSecret, hashPassword, verifyPassword, verifyLogin, createToken, cookieOptions,
  loadUser, setPassword, loginLimited, recordFailure, clearFailures, requireAuth, requireAdmin,
};
