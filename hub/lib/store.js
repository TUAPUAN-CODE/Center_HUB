'use strict';
// เก็บข้อมูลของ Hub เป็นไฟล์ JSON ใน hub/data (ไม่ต้องมีฐานข้อมูล) — โฟลเดอร์นี้ห้ามขึ้น git
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CENTER_HUB_DATA_DIR || path.join(__dirname, '..', 'data');

const file = (name) => path.join(DATA_DIR, `${name}.json`);

const read = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`อ่าน data/${name}.json ไม่ได้: ${e.message}`);
  }
};

const write = (name, data) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
};

module.exports = { read, write, DATA_DIR };
