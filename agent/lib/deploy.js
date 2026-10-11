'use strict';
// ขั้นตอน deploy: ตรวจ → fetch → pull --ff-only → npm ci (ถ้า lockfile เปลี่ยน) → build → test → pm2 reload → health → (ล้มเหลว = rollback)
// และตัวจับเวลา auto deploy (ตรวจ remote ทุก N นาที → แจ้ง / deploy ตามตาราง / deploy ทันที)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { run, IS_WIN } = require('./exec');
const git = require('./git');
const pm2 = require('./pm2');
const ports = require('./ports');
const health = require('./health');
const sched = require('./scheduler');
const { notify } = require('./notify');
const { mask } = require('./mask');
const config = require('./config');
const { log } = require('../../shared/log');

const DATA_DIR = process.env.CENTER_AGENT_DATA_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'deploys.json');
const MAX_HISTORY = 300;
const MAX_STEP_OUTPUT = 8 * 1024;

const state = config.readJson(STATE_FILE, {});
const history = config.readJson(HISTORY_FILE, []);
const jobs = new Map(); // id → job (ในหน่วยความจำ)
const running = new Map(); // projectId → job

const saveState = () => { try { config.writeJsonAtomic(STATE_FILE, state); } catch (e) { log('error', 'state_save_failed', { error: e.message }); } };
const projState = (id) => { if (!state[id]) state[id] = {}; return state[id]; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tailText = (s) => mask(s.length > MAX_STEP_OUTPUT ? `…${s.slice(-MAX_STEP_OUTPUT)}` : s);
const hhmm = (d = new Date()) => d.toLocaleString('th-TH', { hour12: false });

class StepError extends Error {}

const summarizeJob = (j) => ({
  id: j.id, project: j.project, trigger: j.trigger, user: j.user, force: j.force, status: j.status,
  startedAt: j.startedAt, finishedAt: j.finishedAt, from: j.from, to: j.to, error: j.error, steps: j.steps,
});

const record = (job) => {
  history.unshift(summarizeJob(job));
  history.length = Math.min(history.length, MAX_HISTORY);
  try { config.writeJsonAtomic(HISTORY_FILE, history); } catch (e) { log('error', 'history_save_failed', { error: e.message }); }
};

/** รันหนึ่งขั้นตอน เก็บเวลา/ผลลัพธ์ลง job */
const step = async (job, name, fn) => {
  const s = { name, status: 'running', startedAt: new Date().toISOString(), ms: 0, output: '' };
  job.steps.push(s);
  const t = Date.now();
  try {
    const out = await fn(s);
    s.status = 'ok';
    if (typeof out === 'string') s.output = tailText(out);
    return out;
  } catch (e) {
    s.status = 'failed';
    s.output = tailText(`${s.output ? `${s.output}\n` : ''}${e.message}`);
    throw e instanceof StepError ? e : new StepError(`${name}: ${e.message}`);
  } finally {
    s.ms = Date.now() - t;
  }
};

const runCommands = async (project, list, s) => {
  let out = '';
  for (const c of list) {
    const cwd = config.insideDir(project.repoDir, c.cwd);
    if (!cwd) throw new Error(`cwd ${c.cwd} อยู่นอก repo`);
    out += `$ (${c.cwd}) ${c.cmd.join(' ')}\n`;
    s.output = tailText(out);
    const r = await run(c.cmd[0], c.cmd.slice(1), { cwd, timeoutMs: c.timeoutMin * 60 * 1000, env: { CI: 'true', NODE_ENV: undefined } });
    out += r.stdout + r.stderr;
    s.output = tailText(out);
    if (r.timedOut) throw new Error(`${c.cmd.join(' ')} เกินเวลา ${c.timeoutMin} นาที\n${tailText(out)}`);
    if (r.code !== 0) throw new Error(`${c.cmd.join(' ')} จบด้วย code ${r.code}\n${tailText(out)}`);
  }
  return out;
};

/** install ขั้นไหนต้องรันบ้าง: package.json/lockfile เปลี่ยน หรือยังไม่มี node_modules */
const installsNeeded = (project, changed, forceAll) => project.deploy.install.filter((c) => {
  if (forceAll) return true;
  const dir = c.cwd === '.' ? '' : `${c.cwd.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  if (!fs.existsSync(path.join(project.repoDir, c.cwd, 'node_modules'))) return true;
  return (changed || []).some((f) => f === `${dir}package-lock.json` || f === `${dir}package.json`);
});

/** รอจน health ผ่านติดกัน 3 รอบ และ app online ครบ และไม่ restart วนซ้ำ */
const waitHealthy = async (project, s) => {
  const deadline = Date.now() + project.deploy.healthTimeoutSec * 1000;
  let baseline = null;
  let passes = 0;
  let last = '';
  while (Date.now() < deadline) {
    const apps = pm2.summarize(await pm2.list(), project.apps);
    const restarts = apps.reduce((n, a) => n + a.restarts, 0);
    if (baseline === null) baseline = restarts;
    const down = apps.filter((a) => a.status !== 'online');
    const checks = await health.checkAll(project.health);
    const bad = checks.filter((c) => !c.ok);
    if (restarts > baseline + 1) throw new Error(`app restart วนซ้ำ (${restarts - baseline} ครั้งระหว่างตรวจ) — น่าจะ crash ตอนเริ่ม`);
    if (!down.length && !bad.length) {
      passes += 1;
      if (passes >= 3) return `ผ่าน: ${apps.map((a) => `${a.name}=${a.online}/${a.instances}`).join(', ')}${checks.length ? ` | ${checks.map((c) => `${c.url} ${c.status} (${c.ms}ms)`).join(', ')}` : ''}`;
    } else {
      passes = 0;
      last = [...down.map((a) => `${a.name}=${a.status}`), ...bad.map((c) => `${c.url} → ${c.status || c.error}`)].join(', ');
      s.output = `ยังไม่ผ่าน: ${last}`;
    }
    await sleep(2000);
  }
  throw new Error(`health ไม่ผ่านภายใน ${project.deploy.healthTimeoutSec} วินาที: ${last}`);
};

const restartApps = async (project, startAfterStop) => {
  if (startAfterStop) return pm2.act(project, 'start');
  return pm2.act(project, project.deploy.reload);
};

// คืนสถานะสุดท้าย — job.status ยังเป็น 'running' ตลอดจน rollback เสร็จ (หน้าเว็บจะได้ไม่เห็นผลก่อนจบจริง)
const execute = async (job, project, opts) => {
  let stoppedForInstall = false;
  let installed = [];
  let pulled = false;
  try {
    await step(job, 'ตรวจความพร้อม', async () => {
      const st = await git.status(project);
      if (st.branch !== project.branch) throw new Error(`repo อยู่ branch ${st.branch} แต่ตั้งไว้ ${project.branch}`);
      if (st.dirty) {
        const restore = st.files.filter((f) => !f.untracked && project.deploy.restorePaths.some((rp) => f.file === rp || f.file.startsWith(rp.replace(/\/?$/, '/'))));
        const others = st.files.filter((f) => !f.untracked && !restore.includes(f));
        if (others.length) throw new Error(`มีไฟล์แก้ไขค้างบนเครื่อง: ${others.slice(0, 10).map((f) => f.file).join(', ')}`);
        await git.git(project, ['checkout', '--', ...restore.map((f) => f.file)]);
      }
      if (!opts.force && sched.inFreeze(project.deploy.freeze, new Date())) throw new Error('อยู่ในช่วงห้าม deploy (freeze) — ใช้ Force deploy ถ้าจำเป็น');
      if (!opts.force && project.ports.length) {
        const [listeners, procs] = await Promise.all([ports.listListeners(), pm2.list()]);
        const { rows } = ports.analyze(config.loadProjects().projects, listeners, procs, pm2.daemonPid());
        const bad = rows.filter((r) => r.state === 'conflict' && r.projects.includes(project.id));
        if (bad.length) throw new Error(`พอร์ตมีปัญหา: ${bad.map((r) => `${r.port} ${r.note}`).join(', ')}`);
      }
      return `branch ${st.branch} พร้อม`;
    });

    const prev = await git.head(project);
    job.from = prev && prev.hash;

    const fetched = await step(job, 'git fetch', async () => {
      await git.fetch(project);
      const remote = await git.remoteHead(project);
      if (!remote) throw new Error(`ไม่พบ ${project.remote}/${project.branch}`);
      job.fetched = remote;
      return remote;
    });

    if (fetched === job.from && !opts.redeploy) {
      job.to = job.from;
      job.steps.push({ name: 'ไม่มีโค้ดใหม่', status: 'ok', ms: 0, output: 'เครื่องนี้เป็นเวอร์ชันล่าสุดแล้ว' });
      return 'up_to_date';
    }

    if (fetched !== job.from) {
      await step(job, 'git pull --ff-only', async () => (await git.pull(project)).output);
      pulled = true;
    }
    const cur = await git.head(project);
    job.to = cur && cur.hash;
    const changed = job.from && job.to !== job.from ? await git.changedFiles(project, job.from, job.to) : [];

    const needInstall = installsNeeded(project, changed, opts.redeploy && opts.force);
    if (needInstall.length) {
      if (IS_WIN) {
        // Windows ล็อกไฟล์ที่ node กำลังใช้ → npm ci ลบ node_modules ไม่ได้ ต้องหยุด app ก่อน (downtime ช่วงติดตั้ง)
        await step(job, 'หยุด app ก่อนติดตั้ง dependency', async () => { await pm2.act(project, 'stop'); stoppedForInstall = true; return 'หยุดแล้ว'; });
      }
      await step(job, 'ติดตั้ง dependency', (s) => runCommands(project, needInstall, s));
      installed = needInstall;
    }
    if (project.deploy.build.length) await step(job, 'build', (s) => runCommands(project, project.deploy.build, s));
    if (project.deploy.test.length) await step(job, 'test', (s) => runCommands(project, project.deploy.test, s));

    await step(job, stoppedForInstall ? 'pm2 start' : `pm2 ${project.deploy.reload}`, async () => {
      const apps = await restartApps(project, stoppedForInstall);
      stoppedForInstall = false;
      return apps.map((a) => `${a.name}: ${a.status} (${a.online}/${a.instances})`).join('\n');
    });
    await step(job, 'ตรวจ health', (s) => waitHealthy(project, s));
    return 'success';
  } catch (err) {
    job.error = err.message;
    const canRollback = project.deploy.rollback && job.from && (pulled || stoppedForInstall);
    if (!canRollback) {
      if (stoppedForInstall) await pm2.act(project, 'start').catch((e) => log('error', 'restart_after_fail', { project: project.id, error: e.message }));
      return 'failed';
    }
    try {
      await step(job, `rollback → ${job.from.slice(0, 7)}`, async () => {
        if (job.to && job.to !== job.from) await git.git(project, ['reset', '--hard', job.from]);
        return 'คืนโค้ดแล้ว';
      });
      if (installed.length) {
        if (IS_WIN && !stoppedForInstall) { await pm2.act(project, 'stop'); stoppedForInstall = true; }
        await step(job, 'rollback: ติดตั้ง dependency เดิม', (s) => runCommands(project, installed, s));
      }
      if (project.deploy.build.length) await step(job, 'rollback: build', (s) => runCommands(project, project.deploy.build, s));
      await step(job, 'rollback: pm2', async () => {
        const apps = await restartApps(project, stoppedForInstall);
        return apps.map((a) => `${a.name}: ${a.status}`).join('\n');
      });
      await step(job, 'rollback: ตรวจ health', (s) => waitHealthy(project, s));
      return 'rolled_back';
    } catch (e) {
      job.error = `${job.error} | rollback: ${e.message}`;
      return 'rollback_failed';
    }
  }
};

const STATUS_TEXT = {
  success: '✅ deploy สำเร็จ', up_to_date: 'ℹ️ ไม่มีโค้ดใหม่', failed: '❌ deploy ล้มเหลว',
  rolled_back: '⚠️ deploy ล้มเหลว — rollback กลับเวอร์ชันเดิมแล้ว', rollback_failed: '🚨 deploy ล้มเหลว และ rollback ไม่สำเร็จ — ต้องเข้าไปดูด่วน',
};

/** เริ่ม deploy (ทำงานเบื้องหลัง) — คืน job ทันที */
const start = (projectId, { trigger = 'manual', user = null, force = false, redeploy = false } = {}) => {
  const project = config.getProject(projectId);
  if (!project) throw Object.assign(new Error('ไม่พบ project'), { status: 404 });
  if (running.has(projectId)) throw Object.assign(new Error('project นี้กำลัง deploy อยู่'), { status: 409, job: running.get(projectId).id });
  const job = {
    id: crypto.randomBytes(8).toString('hex'), project: projectId, trigger, user, force, status: 'running',
    startedAt: new Date().toISOString(), finishedAt: null, from: null, to: null, error: null, steps: [],
  };
  jobs.set(job.id, job);
  running.set(projectId, job);
  if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  log('info', 'deploy_start', { project: projectId, job: job.id, trigger, user, force });

  execute(job, project, { force, redeploy }).catch((e) => { job.error = e.message; return 'failed'; }).then(async (final) => {
    job.status = final;
    job.finishedAt = new Date().toISOString();
    running.delete(projectId);
    const ps = projState(projectId);
    ps.lastDeploy = { id: job.id, status: job.status, at: job.finishedAt, to: job.to };
    if (job.status !== 'up_to_date') ps.notifiedRemote = null;
    if (job.status === 'success' || job.status === 'up_to_date') {
      ps.behind = 0;
      ps.failedRemote = null;
    } else if (job.fetched) {
      // โค้ดชุดนี้ deploy ไม่ผ่าน → auto deploy จะไม่ลองซ้ำจนกว่าจะมี commit ใหม่ (กันวน deploy-rollback ทุกนาที)
      ps.failedRemote = job.fetched;
    }
    saveState();
    record(job);
    log(job.status === 'success' || job.status === 'up_to_date' ? 'info' : 'error', 'deploy_end', { project: projectId, job: job.id, status: job.status, error: job.error });
    if (job.status !== 'up_to_date' || trigger === 'manual') {
      const agent = config.loadAgentConfig();
      await notify(`${STATUS_TEXT[job.status] || job.status}\n${project.name} @ ${agent.name}\n${(job.from || '').slice(0, 7)} → ${(job.to || '').slice(0, 7)}\nโดย ${user || trigger} เวลา ${hhmm()}${job.error ? `\n${job.error.slice(0, 500)}` : ''}`);
    }
  });
  return job;
};

/** ตรวจ remote เป็นรอบ ๆ แล้วทำตามโหมดของแต่ละ project */
let ticking = false;
const tick = async (now = new Date()) => {
  if (ticking) return;
  ticking = true;
  try {
    const agent = config.loadAgentConfig();
    for (const project of config.loadProjects().projects) {
      const ps = projState(project.id);
      const dueFetch = !ps.lastFetch || now - new Date(ps.lastFetch) >= agent.fetchIntervalMin * 60 * 1000;
      if (dueFetch && !running.has(project.id)) {
        try {
          await git.fetch(project);
          ps.remoteHead = await git.remoteHead(project);
          ps.behind = await git.behindCount(project);
          ps.fetchError = null;
        } catch (e) {
          ps.fetchError = e.message;
        }
        ps.lastFetch = now.toISOString();
      }
      if (!ps.behind || running.has(project.id) || project.deploy.mode === 'manual') continue;
      if (project.deploy.mode !== 'notify' && ps.failedRemote && ps.failedRemote === ps.remoteHead) continue;
      const d = project.deploy;
      if (d.mode === 'notify') {
        if (ps.notifiedRemote !== ps.remoteHead) {
          ps.notifiedRemote = ps.remoteHead;
          await notify(`🔔 ${project.name} @ ${agent.name} มีโค้ดใหม่ ${ps.behind} commit รอ deploy (กดใน Center_HUB)`);
        }
      } else if (d.mode === 'immediate') {
        if (!sched.inFreeze(d.freeze, now)) start(project.id, { trigger: 'auto' });
      } else if (d.mode === 'schedule') {
        const slot = sched.dueSlot(d, now, ps.lastSlot, agent.scheduleWindowMin);
        if (slot && !sched.inFreeze(d.freeze, now)) {
          ps.lastSlot = slot;
          start(project.id, { trigger: 'schedule' });
        }
      }
    }
    saveState();
  } catch (e) {
    log('error', 'scheduler_tick_failed', { error: e.message });
  } finally {
    ticking = false;
  }
};

let timer = null;
const startScheduler = () => {
  if (timer) return;
  timer = setInterval(() => { tick(); }, 60 * 1000);
  timer.unref();
  setTimeout(() => { tick(); }, 5000).unref();
};
const stopScheduler = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = {
  start, tick, startScheduler, stopScheduler, installsNeeded,
  getJob: (id) => jobs.get(id) || history.find((h) => h.id === id) || null,
  runningJob: (projectId) => running.get(projectId) || null,
  history: (projectId, limit = 30) => history.filter((h) => !projectId || h.project === projectId).slice(0, Math.min(200, Number(limit) || 30)),
  projectState: (id) => ({ ...projState(id) }),
  stateOf: projState,
};
