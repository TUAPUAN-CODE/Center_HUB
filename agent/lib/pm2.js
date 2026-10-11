'use strict';
// คุม PM2 ผ่าน programmatic API (ใช้ daemon เดียวกับคำสั่ง pm2 ใน cmd — Agent ต้องรันด้วย Windows user เดียวกับ PM2)
const fs = require('fs');
const path = require('path');
const pm2 = require('pm2');

let connecting = null;
const connect = () => {
  if (!connecting) {
    connecting = new Promise((resolve, reject) => {
      pm2.connect((err) => { if (err) { connecting = null; reject(err); } else resolve(); });
    });
  }
  return connecting;
};

const callOnce = (fn, args) => new Promise((resolve, reject) => {
  pm2[fn](...args, (err, out) => (err ? reject(err) : resolve(out)));
});

// daemon อาจถูก kill/restart ระหว่างทาง → ต่อใหม่แล้วลองอีกครั้ง
const call = async (fn, ...args) => {
  await connect();
  try { return await callOnce(fn, args); } catch (err) {
    if (!/connect|ECONNREFUSED|EPIPE|not connected/i.test(String(err && err.message))) throw err;
    connecting = null;
    try { pm2.disconnect(); } catch { /* ไม่สนใจ */ }
    await connect();
    return callOnce(fn, args);
  }
};

// ทำทีละคำสั่ง — start ต้อง chdir ชั่วคราว จึงห้ามซ้อนกัน
let chain = Promise.resolve();
const serial = (job) => { const p = chain.then(job, job); chain = p.catch(() => {}); return p; };

const toInfo = (p) => {
  const env = p.pm2_env || {};
  return {
    name: p.name,
    pmId: p.pm_id,
    pid: p.pid || null,
    status: env.status || 'unknown',
    mode: env.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
    cpu: p.monit ? p.monit.cpu : 0,
    memory: p.monit ? p.monit.memory : 0,
    uptime: env.status === 'online' && env.pm_uptime ? Date.now() - env.pm_uptime : 0,
    restarts: env.restart_time || 0,
    unstableRestarts: env.unstable_restarts || 0,
    cwd: env.pm_cwd || null,
    outLog: env.pm_out_log_path || null,
    errLog: env.pm_err_log_path || null,
  };
};

const list = async () => (await call('list')).map(toInfo);

/** pid ของ PM2 daemon — ใน cluster mode ตัว daemon เป็นผู้ถือพอร์ต */
const daemonPid = () => {
  const home = process.env.PM2_HOME || path.join(process.env.HOME || process.env.USERPROFILE || '', '.pm2');
  try { return Number(fs.readFileSync(path.join(home, 'pm2.pid'), 'utf8').trim()) || null; } catch { return null; }
};

/** สรุปสถานะ app ต่อชื่อ (cluster หลาย instance รวมเป็นแถวเดียว) */
const summarize = (all, names) => names.map((name) => {
  const procs = all.filter((p) => p.name === name);
  if (!procs.length) return { name, status: 'missing', instances: 0, online: 0, cpu: 0, memory: 0, restarts: 0, pids: [] };
  const online = procs.filter((p) => p.status === 'online').length;
  const status = online === procs.length ? 'online' : online > 0 ? 'degraded' : procs.some((p) => p.status === 'errored') ? 'errored' : procs[0].status;
  return {
    name,
    status,
    mode: procs[0].mode,
    instances: procs.length,
    online,
    cpu: procs.reduce((s, p) => s + p.cpu, 0),
    memory: procs.reduce((s, p) => s + p.memory, 0),
    restarts: procs.reduce((s, p) => s + p.restarts, 0),
    uptime: Math.min(...procs.map((p) => p.uptime)),
    pids: procs.map((p) => p.pid).filter(Boolean),
    outLog: procs[0].outLog,
    errLog: procs[0].errLog,
  };
});

/** start จาก ecosystem — ทำเหมือนพิมพ์ `pm2 start <ecosystem> --only <apps>` จากโฟลเดอร์ของไฟล์ ecosystem */
const startFromEcosystem = (project, apps) => serial(async () => {
  const file = path.resolve(project.repoDir, project.ecosystem);
  if (!fs.existsSync(file)) throw Object.assign(new Error(`ไม่พบไฟล์ ${project.ecosystem}`), { status: 400 });
  const cwd = project.startCwd ? path.resolve(project.repoDir, project.startCwd) : path.dirname(file);
  const api = new pm2.custom({ cwd });
  await new Promise((resolve, reject) => api.connect((e) => (e ? reject(e) : resolve())));
  const prev = process.cwd();
  try {
    process.chdir(cwd); // cwd แบบ relative ใน ecosystem ถูก resolve จาก process.cwd()
    return await new Promise((resolve, reject) => {
      api.start(file, { only: apps.join(',') }, (err, out) => (err ? reject(err) : resolve(out)));
    });
  } finally {
    process.chdir(prev);
    try { api.disconnect(); } catch { /* ไม่สนใจ */ }
  }
});

const ACTIONS = ['start', 'stop', 'restart', 'reload'];

/** สั่ง action กับ app ของ project — คืนสถานะหลังสั่ง */
const act = async (project, action, onlyApp) => {
  if (!ACTIONS.includes(action)) throw Object.assign(new Error('action ไม่ถูกต้อง'), { status: 400 });
  if (onlyApp && !project.apps.includes(onlyApp)) throw Object.assign(new Error(`app ${onlyApp} ไม่อยู่ใน project นี้`), { status: 400 });
  const apps = onlyApp ? [onlyApp] : project.apps;
  const all = await list();
  const existing = apps.filter((a) => all.some((p) => p.name === a));
  const missing = apps.filter((a) => !existing.includes(a));

  if (action === 'start') {
    const stopped = existing.filter((a) => all.some((p) => p.name === a && p.status !== 'online'));
    if (missing.length || stopped.length) await startFromEcosystem(project, [...missing, ...stopped]);
  } else {
    // app ที่ยังไม่เคยอยู่ใน PM2: restart/reload = start ครั้งแรก, stop = ไม่ต้องทำอะไร
    if (missing.length && action !== 'stop') await startFromEcosystem(project, missing);
    for (const name of existing) {
      // reload ใน fork mode PM2 จะ restart แทนอยู่แล้ว; singleton (เช่น RFID) ใช้ restart เสมอ
      const fn = action === 'reload' && project.singleton.includes(name) ? 'restart' : action;
      await serial(() => call(fn, name));
    }
  }
  return summarize(await list(), project.apps);
};

module.exports = { list, summarize, act, daemonPid, ACTIONS, disconnect: () => { try { pm2.disconnect(); } catch { /* ไม่สนใจ */ } } };
