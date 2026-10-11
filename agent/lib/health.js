'use strict';
// ตรวจ health URL ของ project (HTTP GET, timeout สั้น)
const http = require('http');
const https = require('https');

const check = (url, expect = 200, timeoutMs = 4000) => new Promise((resolve) => {
  const started = Date.now();
  let lib;
  try { lib = new URL(url).protocol === 'https:' ? https : http; } catch { resolve({ url, ok: false, error: 'URL ไม่ถูกต้อง' }); return; }
  // health ภายในเครื่องมักใช้ cert ภายใน → ไม่ตรวจ CA เฉพาะ host loopback
  const local = /^https:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);
  const req = lib.get(url, { timeout: timeoutMs, rejectUnauthorized: !local, headers: { 'user-agent': 'center-hub-agent' } }, (res) => {
    res.resume();
    resolve({ url, ok: res.statusCode === expect, status: res.statusCode, ms: Date.now() - started });
  });
  req.on('timeout', () => { req.destroy(new Error('timeout')); });
  req.on('error', (e) => resolve({ url, ok: false, error: e.message, ms: Date.now() - started }));
});

const checkAll = (health) => Promise.all(health.map((h) => check(h.url, h.expect)));

module.exports = { check, checkAll };
