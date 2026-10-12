'use strict';
// โหลด/ตรวจ/บันทึกไฟล์ตั้งค่าของ Agent
//  - config/agent.json    : ค่าของเครื่อง (แก้ที่เครื่องเท่านั้น ไม่เปิดให้แก้ผ่าน Hub)
//  - config/projects.json : รายการ project (Admin แก้ผ่าน Hub ได้ — ตรวจทุกช่องก่อนบันทึก)
const fs = require('fs');
const path = require('path');

const CONFIG_DIR = process.env.CENTER_AGENT_CONFIG_DIR || path.join(__dirname, '..', 'config');
const AGENT_FILE = path.join(CONFIG_DIR, 'agent.json');
const PROJECTS_FILE = path.join(CONFIG_DIR, 'projects.json');

// พอร์ตที่ห้าม project ใช้ (ระบบ/ฐานข้อมูล/ตัว Center_HUB เอง)
const RESERVED_PORTS = new Map([
  [22, 'SSH'], [135, 'Windows RPC'], [139, 'NetBIOS'], [445, 'SMB'], [1433, 'SQL Server'],
  [3306, 'MySQL'], [3389, 'Remote Desktop'], [5432, 'PostgreSQL'], [5985, 'WinRM'], [6379, 'Redis'],
]);
const DEFAULT_COMMANDS = ['npm', 'node'];
const DEPLOY_MODES = ['manual', 'notify', 'schedule', 'immediate'];
const RELOAD_MODES = ['reload', 'restart'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const REF_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,120}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const APP_RE = /^[A-Za-z0-9._@-]{1,80}$/;

const readJson = (file, fallback) => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`อ่าน ${path.basename(file)} ไม่ได้: ${e.message}`);
  }
  // ไฟล์ว่าง (เช่น เปิด Notepad สร้างไฟล์แล้วปิดโดยไม่ Save) = ยังไม่ได้ตั้งค่า
  if (!text.replace(/^\uFEFF/, '').trim()) return fallback;
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) {
    throw new Error(`อ่าน ${path.basename(file)} ไม่ได้ (JSON ไม่ถูกต้อง): ${e.message}`);
  }
};

const writeJsonAtomic = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
};

const loadAgentConfig = () => {
  const cfg = readJson(AGENT_FILE, {});
  return {
    id: cfg.id || 'agent',
    name: cfg.name || cfg.id || 'agent',
    fetchIntervalMin: Math.max(1, Number(cfg.fetchIntervalMin) || 5),
    scheduleWindowMin: Math.max(5, Number(cfg.scheduleWindowMin) || 60),
    allowedCommands: [...new Set([...DEFAULT_COMMANDS, ...(Array.isArray(cfg.allowedCommands) ? cfg.allowedCommands : [])])],
    pm2Name: cfg.pm2Name || 'center-agent',
    nginx: cfg.nginx || null,
    reservedPorts: Array.isArray(cfg.reservedPorts) ? cfg.reservedPorts.map(Number) : [],
  };
};

const insideDir = (base, rel) => {
  const full = path.resolve(base, rel || '.');
  const r = path.relative(base, full);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)) ? full : null;
};

const checkCommands = (list, where, errors, agentCfg) => {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { errors.push(`${where} ต้องเป็น array`); return []; }
  return list.map((c, i) => {
    const step = typeof c === 'object' && c && !Array.isArray(c) ? c : { cmd: c };
    if (!Array.isArray(step.cmd) || !step.cmd.length || !step.cmd.every((a) => typeof a === 'string' && a.length < 500)) {
      errors.push(`${where}[${i}].cmd ต้องเป็น array ของข้อความ เช่น ["npm","run","build"]`);
    } else if (!agentCfg.allowedCommands.includes(step.cmd[0])) {
      errors.push(`${where}[${i}] ใช้คำสั่ง "${step.cmd[0]}" ไม่ได้ (อนุญาต: ${agentCfg.allowedCommands.join(', ')} — เพิ่มได้ที่ allowedCommands ใน agent.json บนเครื่อง)`);
    }
    if (step.cwd !== undefined && (typeof step.cwd !== 'string' || step.cwd.includes('..') || path.isAbsolute(step.cwd))) {
      errors.push(`${where}[${i}].cwd ต้องเป็น path ภายใน repo (ห้าม .. หรือ absolute)`);
    }
    return { cwd: step.cwd || '.', cmd: step.cmd, timeoutMin: Number(step.timeoutMin) || 15 };
  });
};

const checkDays = (days, where, errors) => {
  if (days === undefined) return [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(days) || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    errors.push(`${where} ต้องเป็นเลขวัน 0-6 (0 = อาทิตย์)`);
    return [];
  }
  return days;
};

/** ตรวจรายการ project — คืน { projects, errors, warnings } (ค่าที่คืนเติม default ครบแล้ว) */
const validateProjects = (input, agentCfg = loadAgentConfig()) => {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(input)) return { projects: [], errors: ['projects ต้องเป็น array'], warnings };
  const ids = new Set();
  const portOwners = new Map();
  const appOwners = new Map();
  const reserved = new Map(RESERVED_PORTS);
  agentCfg.reservedPorts.forEach((p) => reserved.set(p, 'สงวนไว้ใน agent.json'));

  const projects = input.map((p, idx) => {
    const where = `projects[${idx}]${p && p.id ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') { errors.push(`${where} ต้องเป็น object`); return null; }
    if (!ID_RE.test(String(p.id || ''))) errors.push(`${where}.id ต้องเป็น a-z 0-9 - (ไม่เกิน 41 ตัว)`);
    if (ids.has(p.id)) errors.push(`${where}.id ซ้ำ`);
    ids.add(p.id);

    if (typeof p.repoDir !== 'string' || !path.isAbsolute(p.repoDir)) errors.push(`${where}.repoDir ต้องเป็น path เต็ม เช่น I:\\\\test\\\\DelayHUB`);
    else if (!fs.existsSync(p.repoDir)) warnings.push(`${where}: ไม่พบโฟลเดอร์ ${p.repoDir}`);

    const branch = p.branch || 'main';
    if (!REF_RE.test(branch)) errors.push(`${where}.branch ไม่ถูกต้อง`);
    const remote = p.remote || 'origin';
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(remote)) errors.push(`${where}.remote ไม่ถูกต้อง`);

    const ecosystem = p.ecosystem || 'ecosystem.config.js';
    if (typeof ecosystem !== 'string' || ecosystem.includes('..') || path.isAbsolute(ecosystem)) errors.push(`${where}.ecosystem ต้องเป็น path ภายใน repo`);

    const apps = Array.isArray(p.apps) ? p.apps : [];
    if (!apps.length) errors.push(`${where}.apps ต้องระบุชื่อ app ใน PM2 อย่างน้อย 1 ตัว`);
    apps.forEach((a) => {
      if (!APP_RE.test(String(a))) errors.push(`${where}.apps มีชื่อไม่ถูกต้อง: ${a}`);
      if (a === agentCfg.pm2Name) errors.push(`${where}.apps ห้ามใส่ ${a} (ตัว Agent เอง)`);
      if (appOwners.has(a)) errors.push(`app "${a}" อยู่ทั้งใน ${appOwners.get(a)} และ ${p.id}`);
      appOwners.set(a, p.id);
    });
    const singleton = Array.isArray(p.singleton) ? p.singleton.filter((a) => apps.includes(a)) : [];

    const ports = Array.isArray(p.ports) ? p.ports : [];
    ports.forEach((port) => {
      if (!Number.isInteger(port) || port < 1 || port > 65535) { errors.push(`${where}.ports มีค่าไม่ถูกต้อง: ${port}`); return; }
      if (reserved.has(port)) errors.push(`${where}: พอร์ต ${port} สงวนไว้สำหรับ ${reserved.get(port)}`);
      if (portOwners.has(port)) errors.push(`พอร์ต ${port} ซ้ำกันระหว่าง ${portOwners.get(port)} และ ${p.id}`);
      portOwners.set(port, p.id);
    });

    const health = (Array.isArray(p.health) ? p.health : []).map((h, i) => {
      const item = typeof h === 'string' ? { url: h } : h || {};
      let ok = false;
      try { ok = ['http:', 'https:'].includes(new URL(item.url).protocol); } catch { ok = false; }
      if (!ok) errors.push(`${where}.health[${i}] ต้องเป็น URL http(s)`);
      return { url: item.url, expect: Number(item.expect) || 200 };
    });
    if (!health.length && ports.length) warnings.push(`${where}: ไม่มี health URL — deploy จะดูแค่สถานะ PM2`);

    const d = p.deploy || {};
    const mode = d.mode || 'manual';
    if (!DEPLOY_MODES.includes(mode)) errors.push(`${where}.deploy.mode ต้องเป็น ${DEPLOY_MODES.join(' | ')}`);
    const time = d.time || '03:00';
    if (!TIME_RE.test(time)) errors.push(`${where}.deploy.time ต้องเป็น HH:MM`);
    const freeze = (Array.isArray(d.freeze) ? d.freeze : []).map((f, i) => {
      if (!f || !TIME_RE.test(f.from || '') || !TIME_RE.test(f.to || '')) errors.push(`${where}.deploy.freeze[${i}] ต้องมี from/to เป็น HH:MM`);
      return { days: checkDays(f && f.days, `${where}.deploy.freeze[${i}].days`, errors), from: f && f.from, to: f && f.to };
    });
    const reload = d.reload || 'reload';
    if (!RELOAD_MODES.includes(reload)) errors.push(`${where}.deploy.reload ต้องเป็น reload | restart`);
    const restorePaths = Array.isArray(d.restorePaths) ? d.restorePaths : [];
    restorePaths.forEach((rp) => { if (typeof rp !== 'string' || rp.includes('..') || path.isAbsolute(rp) || rp.startsWith('-')) errors.push(`${where}.deploy.restorePaths มีค่าไม่ถูกต้อง: ${rp}`); });

    return {
      id: p.id,
      name: p.name || p.id,
      repoDir: p.repoDir,
      branch,
      remote,
      ecosystem,
      startCwd: typeof p.startCwd === 'string' && !p.startCwd.includes('..') ? p.startCwd : null,
      apps,
      singleton,
      ports,
      health,
      deploy: {
        mode,
        days: checkDays(d.days, `${where}.deploy.days`, errors),
        time,
        freeze,
        install: checkCommands(d.install, `${where}.deploy.install`, errors, agentCfg),
        build: checkCommands(d.build, `${where}.deploy.build`, errors, agentCfg),
        test: checkCommands(d.test, `${where}.deploy.test`, errors, agentCfg),
        restorePaths,
        reload,
        rollback: d.rollback !== false,
        healthTimeoutSec: Math.min(600, Math.max(10, Number(d.healthTimeoutSec) || 60)),
      },
    };
  }).filter(Boolean);
  return { projects, errors, warnings };
};

let cache = null;
const loadProjects = () => {
  if (cache) return cache;
  const raw = readJson(PROJECTS_FILE, []);
  const { projects, errors, warnings } = validateProjects(raw);
  cache = { raw, projects, errors, warnings };
  return cache;
};
const getProject = (id) => loadProjects().projects.find((p) => p.id === id) || null;

const saveProjects = (raw) => {
  const result = validateProjects(raw);
  if (result.errors.length) return result;
  if (fs.existsSync(PROJECTS_FILE)) fs.copyFileSync(PROJECTS_FILE, `${PROJECTS_FILE}.bak`);
  writeJsonAtomic(PROJECTS_FILE, raw);
  cache = null;
  return result;
};

module.exports = {
  CONFIG_DIR, RESERVED_PORTS, REF_RE, loadAgentConfig, loadProjects, getProject, saveProjects, validateProjects,
  insideDir, readJson, writeJsonAtomic, reload: () => { cache = null; },
};
