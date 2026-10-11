'use strict';
// รันคำสั่งภายนอกแบบไม่ผ่าน shell (กัน command injection) พร้อม timeout และจำกัดขนาด output
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const MAX_OUTPUT = 4 * 1024 * 1024;

// npm บน Windows เป็นไฟล์ .cmd ซึ่ง execFile เรียกตรงไม่ได้ → เรียก node + npm-cli.js แทน (ไม่ต้องเปิด shell)
let npmCache = null;
const resolveNpm = () => {
  if (npmCache) return npmCache;
  const candidates = [
    process.env.NPM_CLI_JS,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const cli = candidates.find((p) => fs.existsSync(p));
  npmCache = cli ? { file: process.execPath, pre: [cli] } : { file: IS_WIN ? null : 'npm', pre: [] };
  return npmCache;
};

/**
 * รันคำสั่ง — ไม่ reject เมื่อ exit code ไม่ใช่ 0 (ดูที่ result.code) แต่ reject เมื่อหาโปรแกรมไม่เจอ
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, ms:number, timedOut:boolean}>}
 */
const run = (cmd, args = [], { cwd, timeoutMs = 10 * 60 * 1000, env } = {}) => new Promise((resolve, reject) => {
  let file = cmd;
  let fullArgs = args;
  if (cmd === 'npm') {
    const npm = resolveNpm();
    if (!npm.file) { reject(new Error('หา npm-cli.js ไม่เจอ — ตั้งค่า NPM_CLI_JS ใน agent/.env')); return; }
    file = npm.file;
    fullArgs = [...npm.pre, ...args];
  } else if (cmd === 'node') {
    file = process.execPath;
  }
  const started = Date.now();
  execFile(file, fullArgs, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...env },
  }, (err, stdout, stderr) => {
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) { reject(new Error(`เรียกโปรแกรม ${cmd} ไม่ได้ (${err.code})`)); return; }
    const timedOut = Boolean(err && err.killed);
    const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
    resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - started, timedOut });
  });
});

module.exports = { run, IS_WIN };
