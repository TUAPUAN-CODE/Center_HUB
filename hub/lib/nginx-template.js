'use strict';
// สร้าง config nginx (Load Balancer) จากการตั้งค่าใน Hub — ไม่ต้องแก้ไฟล์ทีละ project
// ไฟล์ที่ได้ใช้ include ในบล็อก http {} ของ nginx.conf บนเครื่อง LB
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const SERVER_NAME_RE = /^[A-Za-z0-9.*_-]{1,253}$/;

const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
const port = (v, where) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw fail(`${where} ต้องเป็นพอร์ต 1-65535`);
  return n;
};

/**
 * ตรวจและเติมค่าเริ่มต้น
 * lb = { agentId, sites: [{ name, listen, serverName?, sticky: 'ip_hash'|'none', maxBodyMb?, upstreams: [{ agentId, host?, port, weight?, backup?, down? }] }] }
 */
const normalize = (lb, agentsById) => {
  if (!lb || typeof lb !== 'object') throw fail('ข้อมูล LB ไม่ถูกต้อง');
  const sites = Array.isArray(lb.sites) ? lb.sites : [];
  const names = new Set();
  const listens = new Map();
  const out = sites.map((s, i) => {
    const where = `sites[${i}]`;
    if (!NAME_RE.test(String(s.name || ''))) throw fail(`${where}.name ต้องเป็น a-z 0-9 -`);
    if (names.has(s.name)) throw fail(`ชื่อ ${s.name} ซ้ำ`);
    names.add(s.name);
    const listen = port(s.listen, `${where}.listen`);
    const serverName = s.serverName ? String(s.serverName) : '';
    if (serverName && !serverName.split(/\s+/).every((n) => SERVER_NAME_RE.test(n))) throw fail(`${where}.serverName ไม่ถูกต้อง`);
    const key = `${listen}|${serverName}`;
    if (listens.has(key)) throw fail(`พอร์ต ${listen} ซ้ำกันระหว่าง ${listens.get(key)} และ ${s.name}`);
    listens.set(key, s.name);
    const ups = (Array.isArray(s.upstreams) ? s.upstreams : []).map((u, j) => {
      const a = u.agentId ? agentsById.get(u.agentId) : null;
      if (u.agentId && !a) throw fail(`${where}.upstreams[${j}] ไม่พบเครื่อง ${u.agentId}`);
      const host = String(u.host || (a && a.host) || '');
      if (!HOST_RE.test(host)) throw fail(`${where}.upstreams[${j}].host ไม่ถูกต้อง`);
      const weight = u.weight === undefined || u.weight === '' ? 1 : Number(u.weight);
      if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw fail(`${where}.upstreams[${j}].weight ต้องเป็น 1-100`);
      return { agentId: u.agentId || null, host, port: port(u.port, `${where}.upstreams[${j}].port`), weight, backup: Boolean(u.backup), down: Boolean(u.down) };
    });
    if (!ups.some((u) => !u.down && !u.backup)) throw fail(`${s.name}: ต้องมีเครื่องหลัก (ไม่ใช่ backup/down) อย่างน้อย 1 เครื่อง`);
    const sticky = s.sticky === 'none' ? 'none' : 'ip_hash';
    if (sticky === 'ip_hash' && ups.some((u) => u.backup)) throw fail(`${s.name}: nginx ไม่รองรับ backup ร่วมกับ ip_hash — ใช้ down แทน หรือปิด sticky`);
    const maxBodyMb = Math.min(1024, Math.max(1, Number(s.maxBodyMb) || 50));
    return { name: s.name, listen, serverName, sticky, maxBodyMb, upstreams: ups };
  });
  return { agentId: lb.agentId || null, sites: out };
};

const render = (lb) => {
  const lines = [
    '# Managed by Center_HUB — ไฟล์นี้ถูกสร้างอัตโนมัติ แก้ใน Center_HUB เท่านั้น (แก้มือจะถูกทับ)',
    `# generated ${new Date().toISOString()}`,
    '',
    'map $http_upgrade $center_connection_upgrade {',
    '    default upgrade;',
    "    ''      close;",
    '}',
    '',
  ];
  for (const s of lb.sites) {
    const up = `center_${s.name.replace(/-/g, '_')}`;
    lines.push(`# ---- ${s.name} ----`, `upstream ${up} {`);
    if (s.sticky === 'ip_hash') lines.push('    ip_hash;  # Socket.IO / session ต้องอยู่เครื่องเดิม');
    for (const u of s.upstreams) {
      const flags = [u.weight !== 1 ? `weight=${u.weight}` : '', 'max_fails=3 fail_timeout=10s', u.backup ? 'backup' : '', u.down ? 'down' : ''].filter(Boolean).join(' ');
      lines.push(`    server ${u.host}:${u.port} ${flags};${u.agentId ? `  # ${u.agentId}` : ''}`);
    }
    lines.push('    keepalive 32;', '}', '', 'server {', `    listen ${s.listen};`);
    if (s.serverName) lines.push(`    server_name ${s.serverName};`);
    lines.push(
      `    client_max_body_size ${s.maxBodyMb}m;`,
      '    location / {',
      `        proxy_pass http://${up};`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Upgrade $http_upgrade;',
      '        proxy_set_header Connection $center_connection_upgrade;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      '        proxy_read_timeout 3600s;',
      '        proxy_next_upstream error timeout http_502 http_503 http_504;',
      '    }',
      '}',
      '',
    );
  }
  return lines.join('\n');
};

/** พอร์ตที่ LB จะฟัง ห้ามชนกับพอร์ตของ project บนเครื่อง LB เอง */
const portClashes = (lb, lbProjects) => {
  const used = new Map();
  for (const p of lbProjects || []) for (const pt of p.ports || []) used.set(pt, p.id);
  return lb.sites.filter((s) => used.has(s.listen)).map((s) => `พอร์ต ${s.listen} ของ ${s.name} ชนกับ project ${used.get(s.listen)} บนเครื่อง LB`);
};

module.exports = { normalize, render, portClashes };
