'use strict';
// log แบบ JSON บรรทัดเดียว (grep ง่าย) — ห้ามใส่รหัสผ่าน/โทเคน/ความลับลงใน extra
const log = (level, event, extra = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, pid: process.pid, ...extra });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
};
module.exports = { log };
