'use strict';
// สร้าง/แก้ผู้ใช้จาก command line (ใช้ตอนตั้งระบบครั้งแรก หรือลืมรหัส admin)
//   node hub/scripts/user.js <username> [viewer|operator|admin]
// จะถามรหัสผ่านแบบไม่แสดงบนจอ
const path = require('path');
const readline = require('readline');
const { loadEnv } = require('../../shared/env');

loadEnv(path.join(__dirname, '..', '.env'));
const auth = require('../lib/auth');

const [username, role = 'viewer'] = process.argv.slice(2);
if (!username) {
  console.error('วิธีใช้: node hub/scripts/user.js <username> [viewer|operator|admin]');
  process.exit(1);
}

const askHidden = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
});

(async () => {
  const pw = process.env.CENTER_HUB_NEW_PASSWORD || await askHidden('รหัสผ่าน (≥10 ตัว มีตัวอักษร+ตัวเลข): ');
  if (!process.env.CENTER_HUB_NEW_PASSWORD) {
    const again = await askHidden('ยืนยันรหัสผ่าน: ');
    if (pw !== again) { console.error('รหัสผ่านไม่ตรงกัน'); process.exit(1); }
  }
  try {
    const u = auth.upsertUser({ username, password: pw, role });
    console.log(`บันทึกผู้ใช้ ${u.username} (${u.role}) แล้ว — ถ้า Hub รันอยู่ ไม่ต้อง restart`);
  } catch (e) {
    console.error(`ไม่สำเร็จ: ${e.message}`);
    process.exit(1);
  }
})();
