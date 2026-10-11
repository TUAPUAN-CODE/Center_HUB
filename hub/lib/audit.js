'use strict';
// บันทึกทุกการสั่งงาน (ใคร/ทำอะไร/ที่ไหน/ผล) ลง data/audit.log แบบ JSON บรรทัดละรายการ
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./store');

const FILE = path.join(DATA_DIR, 'audit.log');
const MAX_SIZE = 20 * 1024 * 1024;

const write = (entry) => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try { if (fs.statSync(FILE).size > MAX_SIZE) fs.renameSync(FILE, `${FILE}.1`); } catch { /* ยังไม่มีไฟล์ */ }
    fs.appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    process.stderr.write(`audit_write_failed ${e.message}\n`);
  }
};

/** อ่านรายการล่าสุด (ใหม่ก่อน) */
const recent = (limit = 200, filter = '') => {
  let text = '';
  try {
    const fd = fs.openSync(FILE, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return []; }
  const f = String(filter || '').toLowerCase();
  return text.split('\n').filter(Boolean).reverse()
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && (!f || JSON.stringify(e).toLowerCase().includes(f)))
    .slice(0, Math.min(1000, Number(limit) || 200));
};

module.exports = { write, recent };
