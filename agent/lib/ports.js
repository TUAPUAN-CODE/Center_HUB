'use strict';
// ตรวจพอร์ตที่เปิดฟังอยู่บนเครื่อง แล้วเทียบกับพอร์ตที่ project ประกาศไว้ → หาพอร์ตทับ/ถูกโปรแกรมอื่นยึด/ไม่ได้เปิด
const { run, IS_WIN } = require('./exec');

/** netstat -ano (Windows) → [{ port, address, pid }] */
const parseNetstat = (text) => {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols.length < 5 || cols[3] !== 'LISTENING') continue;
    const local = cols[1];
    const i = local.lastIndexOf(':');
    out.push({ address: local.slice(0, i), port: Number(local.slice(i + 1)), pid: Number(cols[4]) || null });
  }
  return out;
};

/** ss -ltnpH (Linux) → [{ port, address, pid, process }] */
const parseSs = (text) => {
  const out = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] !== 'LISTEN') continue;
    const local = cols[3];
    const i = local.lastIndexOf(':');
    const pm = /"([^"]+)",pid=(\d+)/.exec(line);
    out.push({ address: local.slice(0, i), port: Number(local.slice(i + 1)), pid: pm ? Number(pm[2]) : null, process: pm ? pm[1] : null });
  }
  return out;
};

/** tasklist /FO CSV /NH → Map(pid → ชื่อโปรแกรม) */
const parseTasklist = (text) => {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (m) map.set(Number(m[2]), m[1]);
  }
  return map;
};

/** รวมแถวซ้ำ (IPv4/IPv6 พอร์ตเดียวกัน pid เดียวกัน) */
const dedupe = (rows) => {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.port}:${r.pid}`;
    const cur = map.get(key);
    if (cur) { if (!cur.addresses.includes(r.address)) cur.addresses.push(r.address); } else map.set(key, { port: r.port, pid: r.pid, process: r.process || null, addresses: [r.address] });
  }
  return [...map.values()].sort((a, b) => a.port - b.port);
};

const listListeners = async () => {
  if (IS_WIN) {
    // netstat -ano ให้ทั้ง IPv4 และ IPv6 (แถว TCP ทั้งคู่)
    const [ns, tl] = await Promise.all([run('netstat', ['-ano'], { timeoutMs: 20000 }), run('tasklist', ['/FO', 'CSV', '/NH'], { timeoutMs: 20000 })]);
    const names = parseTasklist(tl.stdout);
    return dedupe(parseNetstat(ns.stdout).map((r) => ({ ...r, process: names.get(r.pid) || null })));
  }
  try {
    const r = await run('ss', ['-ltnpH'], { timeoutMs: 20000 });
    return dedupe(parseSs(r.stdout));
  } catch {
    return dedupe(readProcNet()); // เครื่อง Linux ที่ไม่มี ss
  }
};

/** /proc/net/tcp(6) → แถวที่ LISTEN (state 0A) แล้วหา pid จาก inode ของ socket */
const parseProcNet = (text, v6) => text.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c[3] === '0A').map((c) => {
  const [hexAddr, hexPort] = c[1].split(':');
  const address = v6 ? (/^0+$/.test(hexAddr) ? '[::]' : `[${hexAddr}]`) : hexAddr.match(/../g).reverse().map((x) => parseInt(x, 16)).join('.');
  return { address, port: parseInt(hexPort, 16), inode: c[9] };
});

const readProcNet = () => {
  const fs = require('fs');
  const rows = [];
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    try { rows.push(...parseProcNet(fs.readFileSync(file, 'utf8'), v6)); } catch { /* ไม่มีไฟล์ */ }
  }
  const owner = new Map();
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { const m = /^socket:\[(\d+)\]$/.exec(fs.readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m) owner.set(m[1], Number(pid)); } catch { /* ปิดไปแล้ว */ }
    }
  }
  const comm = (pid) => { try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; } };
  return rows.map((r) => { const pid = owner.get(r.inode) || null; return { address: r.address, port: r.port, pid, process: pid ? comm(pid) : null }; });
};

/**
 * เทียบพอร์ตที่ประกาศกับที่เปิดจริง
 * @param projects   project ที่ผ่าน validate แล้ว
 * @param listeners  จาก listListeners()
 * @param procs      จาก pm2.list()
 * @param daemonPid  pid ของ PM2 daemon (ถือพอร์ตแทน app ใน cluster mode)
 */
const analyze = (projects, listeners, procs, daemonPid, reserved = new Map()) => {
  const pidOwner = new Map(); // pid → { project, app }
  for (const pr of projects) {
    for (const p of procs) if (pr.apps.includes(p.name) && p.pid) pidOwner.set(p.pid, { project: pr.id, app: p.name });
  }
  const pm2Pids = new Map(procs.filter((p) => p.pid).map((p) => [p.pid, p.name]));
  const byPort = new Map();
  for (const l of listeners) { if (!byPort.has(l.port)) byPort.set(l.port, []); byPort.get(l.port).push(l); }

  const declared = new Map();
  for (const pr of projects) for (const port of pr.ports) { if (!declared.has(port)) declared.set(port, []); declared.get(port).push(pr.id); }

  const rows = [];
  for (const [port, owners] of [...declared].sort((a, b) => a[0] - b[0])) {
    const ls = byPort.get(port) || [];
    const project = projects.find((p) => p.id === owners[0]);
    const appsOnline = procs.some((p) => project.apps.includes(p.name) && p.status === 'online');
    const clusterOnline = procs.some((p) => project.apps.includes(p.name) && p.status === 'online' && p.mode === 'cluster');
    const holders = ls.map((l) => {
      const own = pidOwner.get(l.pid);
      if (own) return { pid: l.pid, process: l.process, owner: own.project, app: own.app };
      if (daemonPid && l.pid === daemonPid) return { pid: l.pid, process: 'PM2 daemon (cluster)', owner: clusterOnline ? project.id : 'pm2-cluster' };
      if (pm2Pids.has(l.pid)) return { pid: l.pid, process: l.process, owner: 'pm2-other', app: pm2Pids.get(l.pid) };
      return { pid: l.pid, process: l.process, owner: 'external' };
    });

    let state = 'ok';
    let note = '';
    if (owners.length > 1) { state = 'conflict'; note = `ประกาศซ้ำใน ${owners.join(', ')}`; } else if (reserved.has(port)) {
      state = 'conflict'; note = `สงวนไว้สำหรับ ${reserved.get(port)}`;
    } else if (holders.some((h) => h.owner !== project.id)) {
      const other = holders.find((h) => h.owner !== project.id);
      state = 'conflict';
      note = other.owner === 'external' ? `ถูก ${other.process || 'โปรแกรมอื่น'} (pid ${other.pid}) ใช้อยู่` : `ถูก ${other.app || other.process} (pid ${other.pid}) ใช้อยู่`;
    } else if (!holders.length) {
      state = appsOnline ? 'not-listening' : 'free';
      note = appsOnline ? 'app online แต่ไม่ได้เปิดพอร์ตนี้' : 'ยังไม่มีโปรแกรมใช้';
    }
    rows.push({ port, projects: owners, state, note, holders });
  }

  // พอร์ตที่ PM2 app เปิดแต่ไม่ได้ประกาศใน projects.json (ช่วยหาค่าที่ลืมใส่)
  const undeclared = listeners.filter((l) => !declared.has(l.port) && (pm2Pids.has(l.pid) || (daemonPid && l.pid === daemonPid)))
    .map((l) => ({ port: l.port, pid: l.pid, process: l.process, app: pm2Pids.get(l.pid) || 'PM2 daemon (cluster)', project: (pidOwner.get(l.pid) || {}).project || null }));

  return { rows, undeclared, conflicts: rows.filter((r) => r.state === 'conflict').length };
};

module.exports = { parseNetstat, parseSs, parseProcNet, parseTasklist, dedupe, listListeners, analyze };
