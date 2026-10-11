'use strict';
// รายชื่อ Agent (แต่ละเครื่อง) และตัวเรียก Agent แบบลงลายเซ็น — ความลับของ Agent ไม่ถูกส่งกลับไปที่หน้าเว็บ
const http = require('http');
const https = require('https');
const store = require('./store');
const { signRequest } = require('../../shared/sign');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const list = () => store.read('agents', []);
const get = (id) => list().find((a) => a.id === id) || null;
const publicAgent = (a) => ({ id: a.id, name: a.name, url: a.url, host: a.host || new URL(a.url).hostname });

const upsert = ({ id, name, url, secret, host }) => {
  if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('id ต้องเป็น a-z 0-9 - (ไม่เกิน 31 ตัว)'), { status: 400 });
  let u;
  try { u = new URL(url); } catch { throw Object.assign(new Error('url ไม่ถูกต้อง เช่น http://172.48.0.116:4910'), { status: 400 }); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('url ต้องเป็น http(s)'), { status: 400 });
  const all = list();
  const cur = all.find((a) => a.id === id);
  if (!cur && (!secret || String(secret).length < 32)) throw Object.assign(new Error('ต้องใส่ความลับ (ยาว ≥ 32 ตัว) ให้ตรงกับ CENTER_AGENT_SECRET ของเครื่องนั้น'), { status: 400 });
  if (secret && String(secret).length < 32) throw Object.assign(new Error('ความลับต้องยาว ≥ 32 ตัว'), { status: 400 });
  if (host && !/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw Object.assign(new Error('host ไม่ถูกต้อง'), { status: 400 });
  const next = { id, name: name || id, url: u.origin, host: host || u.hostname, secret: secret || cur.secret };
  store.write('agents', cur ? all.map((a) => (a.id === id ? next : a)) : [...all, next]);
  return publicAgent(next);
};

const remove = (id) => store.write('agents', list().filter((a) => a.id !== id));

/** เรียก Agent — คืน data หรือ throw (status ตาม Agent; 502 ถ้าติดต่อไม่ได้) */
const call = (agent, method, path, body, { timeoutMs = 8000, user } = {}) => new Promise((resolve, reject) => {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const target = new URL(path, agent.url);
  const signedPath = target.pathname + target.search;
  const headers = { ...signRequest(agent.secret, method, signedPath, raw), Accept: 'application/json' };
  if (raw) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(raw); }
  if (user) headers['X-Center-User'] = user;
  const lib = target.protocol === 'https:' ? https : http;
  const req = lib.request(target, { method, headers, timeout: timeoutMs }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      let json;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = { error: `Agent ตอบไม่ใช่ JSON (${res.statusCode})` }; }
      if (res.statusCode >= 200 && res.statusCode < 300 && json.ok) resolve(json.data);
      else reject(Object.assign(new Error(json.error || `Agent ตอบ ${res.statusCode}`), { status: res.statusCode, details: json.details, job: json.job }));
    });
  });
  req.on('timeout', () => req.destroy(Object.assign(new Error(`Agent ${agent.name} ไม่ตอบภายใน ${timeoutMs / 1000} วินาที`), { status: 504 })));
  req.on('error', (e) => reject(Object.assign(new Error(e.status ? e.message : `ติดต่อ Agent ${agent.name} ไม่ได้: ${e.message}`), { status: e.status || 502 })));
  req.end(raw || undefined);
});

module.exports = { list, get, upsert, remove, call, publicAgent };
