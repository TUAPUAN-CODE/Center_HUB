'use strict';
// อ่านไฟล์ .env แบบง่าย (KEY=VALUE ต่อบรรทัด) โดยไม่ต้องใช้ library — ค่าใน environment จริงมาก่อนเสมอ
const fs = require('fs');

const loadEnv = (file) => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
};

module.exports = { loadEnv };
