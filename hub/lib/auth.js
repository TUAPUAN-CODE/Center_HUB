'use strict';
// ผู้ใช้ของ Hub: รหัสผ่าน scrypt, session cookie (HttpOnly, SameSite=Strict), ล็อกหลัง login ผิด 5 ครั้งใน 15 นาที
// สิทธิ์: viewer (ดู) < operator (start/stop/reload/pull/deploy ปกติ) < admin (ตั้งค่า, commit, checkout, force deploy, LB, ผู้ใช้)
const crypto = require('crypto');
const store = require('./store');

const ROLES = ['viewer', 'operator', 'admin'];
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const LOCK_FAILS = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const USER_RE = /^[A-Za-z0-9._-]{3,40}$/;

const sessions = new Map(); // sid → { username, role, created, seen }
const fails = new Map(); // key → [timestamps]

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
};
const verifyPassword = (password, user) => {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
};

const users = () => store.read('users', []);
const saveUsers = (list) => store.write('users', list);
const publicUser = (u) => ({ username: u.username, role: u.role, disabled: Boolean(u.disabled), createdAt: u.createdAt });

const checkPassword = (pw) => {
  if (typeof pw !== 'string' || pw.length < 10) return 'รหัสผ่านต้องยาวอย่างน้อย 10 ตัว';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'รหัสผ่านต้องมีทั้งตัวอักษรและตัวเลข';
  return null;
};

const upsertUser = ({ username, password, role, disabled }) => {
  if (!USER_RE.test(String(username || ''))) throw Object.assign(new Error('ชื่อผู้ใช้ต้องเป็น A-Z a-z 0-9 . _ - (3-40 ตัว)'), { status: 400 });
  if (role !== undefined && !ROLES.includes(role)) throw Object.assign(new Error(`role ต้องเป็น ${ROLES.join(' | ')}`), { status: 400 });
  const list = users();
  let u = list.find((x) => x.username === username);
  if (!u) {
    if (!password) throw Object.assign(new Error('ผู้ใช้ใหม่ต้องมีรหัสผ่าน'), { status: 400 });
    u = { username, role: role || 'viewer', createdAt: new Date().toISOString() };
    list.push(u);
  }
  if (password !== undefined && password !== '') {
    const why = checkPassword(password);
    if (why) throw Object.assign(new Error(why), { status: 400 });
    Object.assign(u, hashPassword(password));
  }
  if (role) u.role = role;
  if (disabled !== undefined) u.disabled = Boolean(disabled);
  if (!list.some((x) => x.role === 'admin' && !x.disabled)) throw Object.assign(new Error('ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คน'), { status: 400 });
  saveUsers(list);
  // เปลี่ยนรหัส/สิทธิ์/ปิดใช้งาน → ตัด session เดิมของคนนั้น
  for (const [sid, s] of sessions) if (s.username === username) sessions.delete(sid);
  return publicUser(u);
};

const deleteUser = (username) => {
  const list = users().filter((u) => u.username !== username);
  if (!list.some((x) => x.role === 'admin' && !x.disabled)) throw Object.assign(new Error('ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คน'), { status: 400 });
  saveUsers(list);
  for (const [sid, s] of sessions) if (s.username === username) sessions.delete(sid);
};

const recentFails = (key) => {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < LOCK_WINDOW_MS);
  fails.set(key, list);
  return list;
};

/** login — คืน { sid, user } หรือ throw (401/429) */
const login = (username, password, ip) => {
  const keys = [`u:${String(username).toLowerCase()}`, `ip:${ip}`];
  if (keys.some((k) => recentFails(k).length >= (k.startsWith('ip:') ? LOCK_FAILS * 4 : LOCK_FAILS))) {
    throw Object.assign(new Error('ลองผิดหลายครั้งเกินไป รอ 15 นาที'), { status: 429 });
  }
  const u = users().find((x) => x.username === username);
  // ตรวจรหัสเสมอแม้ไม่มีผู้ใช้ เพื่อไม่ให้เดาชื่อผู้ใช้จากเวลาตอบ
  const ok = verifyPassword(password || '', u || { salt: 'x', hash: '0'.repeat(128) }) && u && !u.disabled;
  if (!ok) {
    keys.forEach((k) => recentFails(k).push(Date.now()));
    throw Object.assign(new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'), { status: 401 });
  }
  keys.forEach((k) => fails.delete(k));
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { username: u.username, role: u.role, created: Date.now(), seen: Date.now() });
  return { sid, user: publicUser(u) };
};

const getSession = (sid) => {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) { sessions.delete(sid); return null; }
  s.seen = now;
  return s;
};

const logout = (sid) => sessions.delete(sid);
const atLeast = (role, need) => ROLES.indexOf(role) >= ROLES.indexOf(need);

setInterval(() => { for (const [sid] of sessions) getSession(sid); }, 10 * 60 * 1000).unref();

module.exports = { ROLES, login, logout, getSession, atLeast, upsertUser, deleteUser, listUsers: () => users().map(publicUser), hashPassword, verifyPassword, checkPassword };
