'use strict';
// ติดตั้งไฟล์ config ของ nginx ที่ Hub สร้าง (เฉพาะเครื่องที่ตั้งเป็น Load Balancer ใน agent.json)
// ขั้นตอน: สำรองไฟล์เดิม → เขียนใหม่ → nginx -t → reload; ถ้า -t ไม่ผ่านคืนไฟล์เดิมทันที
const fs = require('fs');
const path = require('path');
const { run } = require('./exec');

const MAX_CONF = 256 * 1024;

const settings = (agentCfg) => {
  const n = agentCfg.nginx;
  if (!n || !n.exe || !n.confFile) throw Object.assign(new Error('เครื่องนี้ไม่ได้ตั้งเป็น Load Balancer (ใส่ nginx.exe / nginx.confFile ใน agent.json)'), { status: 400 });
  const prefix = n.prefix || path.dirname(n.exe);
  const args = (extra) => [...(n.prefix || process.platform === 'win32' ? ['-p', prefix] : []), ...(n.mainConf ? ['-c', n.mainConf] : []), ...extra];
  return { exe: n.exe, confFile: n.confFile, args };
};

const status = async (agentCfg) => {
  const s = settings(agentCfg);
  const current = fs.existsSync(s.confFile) ? fs.readFileSync(s.confFile, 'utf8') : '';
  const t = await run(s.exe, s.args(['-t']), { cwd: path.dirname(s.exe), timeoutMs: 20000 }).catch((e) => ({ code: -1, stderr: e.message }));
  return { confFile: s.confFile, current, testOk: t.code === 0, test: (t.stderr || t.stdout || '').trim() };
};

const apply = async (agentCfg, text) => {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_CONF) throw Object.assign(new Error('config ว่างหรือใหญ่เกินไป'), { status: 400 });
  if (!text.startsWith('# Managed by Center_HUB')) throw Object.assign(new Error('รับเฉพาะ config ที่ Center_HUB สร้าง'), { status: 400 });
  const s = settings(agentCfg);
  const backup = `${s.confFile}.bak`;
  const had = fs.existsSync(s.confFile);
  if (had) fs.copyFileSync(s.confFile, backup);
  fs.writeFileSync(s.confFile, text);
  const cwd = path.dirname(s.exe);
  const test = await run(s.exe, s.args(['-t']), { cwd, timeoutMs: 20000 });
  if (test.code !== 0) {
    if (had) fs.copyFileSync(backup, s.confFile); else fs.unlinkSync(s.confFile);
    throw Object.assign(new Error(`nginx -t ไม่ผ่าน (คืนไฟล์เดิมแล้ว): ${(test.stderr || test.stdout).trim()}`), { status: 409 });
  }
  const reload = await run(s.exe, s.args(['-s', 'reload']), { cwd, timeoutMs: 20000 });
  if (reload.code !== 0) throw Object.assign(new Error(`nginx reload ไม่สำเร็จ (ไฟล์ใหม่ผ่าน -t แล้ว): ${(reload.stderr || reload.stdout).trim()}`), { status: 409 });
  return { ok: true, test: (test.stderr || test.stdout).trim() };
};

module.exports = { status, apply };
