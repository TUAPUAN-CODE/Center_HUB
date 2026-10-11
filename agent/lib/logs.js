'use strict';
// อ่านท้ายไฟล์ log ของ PM2 (อ่านแค่ส่วนท้าย ไม่โหลดทั้งไฟล์) แล้วปิดค่าความลับก่อนส่ง
const fs = require('fs');
const { mask } = require('./mask');

const tail = (file, lines = 200) => {
  const n = Math.min(2000, Math.max(10, Number(lines) || 200));
  if (!file) return { file: null, lines: [] };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    const len = Math.min(size, n * 400);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const all = buf.toString('utf8').split(/\r?\n/);
    if (len < size) all.shift(); // บรรทัดแรกอาจขาดครึ่ง
    return { file, size, lines: all.filter((l, i) => l || i < all.length - 1).slice(-n).map(mask) };
  } catch (e) {
    return { file, lines: [], error: e.code === 'ENOENT' ? 'ยังไม่มีไฟล์ log' : e.message };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
};

module.exports = { tail };
