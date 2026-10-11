'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'center-unit-'));
process.env.CENTER_HUB_DATA_DIR = path.join(tmp, 'hub');
process.env.CENTER_AGENT_CONFIG_DIR = path.join(tmp, 'agentcfg');
process.env.CENTER_AGENT_DATA_DIR = path.join(tmp, 'agentdata');

const { signRequest, createVerifier } = require('../shared/sign');
const ports = require('../agent/lib/ports');
const sched = require('../agent/lib/scheduler');
const config = require('../agent/lib/config');
const { mask } = require('../agent/lib/mask');
const { parseStatus, DENY_RE } = require('../agent/lib/git');
const lbt = require('../hub/lib/nginx-template');
const auth = require('../hub/lib/auth');

const SECRET = 'x'.repeat(40);

test('ลายเซ็น: ถูกต้องผ่าน, แก้ body/path ไม่ผ่าน, ส่งซ้ำไม่ผ่าน, ความลับสั้นไม่ยอม', () => {
  const verify = createVerifier(SECRET);
  const h = signRequest(SECRET, 'POST', '/v1/projects/a/pm2', '{"action":"stop"}');
  assert.equal(verify('POST', '/v1/projects/a/pm2', h, '{"action":"start"}'), 'bad_signature');
  assert.equal(verify('POST', '/v1/projects/b/pm2', h, '{"action":"stop"}'), 'bad_signature');
  assert.equal(verify('POST', '/v1/projects/a/pm2', h, '{"action":"stop"}'), null);
  assert.equal(verify('POST', '/v1/projects/a/pm2', h, '{"action":"stop"}'), 'replay');
  assert.equal(verify('GET', '/x', {}, ''), 'missing_signature');
  const old = { ...signRequest(SECRET, 'GET', '/x'), 'x-center-ts': String(Date.now() - 120000) };
  assert.equal(verify('GET', '/x', old, ''), 'clock_skew');
  assert.equal(createVerifier('y'.repeat(40))('GET', '/v1/overview', signRequest(SECRET, 'GET', '/v1/overview'), ''), 'bad_signature');
  assert.throws(() => createVerifier('short'));
});

test('พอร์ต: แยก netstat/ss/tasklist และหาพอร์ตชน', () => {
  const ns = [
    '  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       4120',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       555',
    '  TCP    0.0.0.0:4101           0.0.0.0:0              LISTENING       999',
    '  TCP    [::]:80                [::]:0                 LISTENING       4120',
    '  TCP    10.0.0.1:52000         10.0.0.2:443           ESTABLISHED     77',
  ].join('\r\n');
  const names = ports.parseTasklist('"node.exe","4120","Console","1","50,000 K"\r\n"java.exe","555","Console","1","9,000 K"');
  const listeners = ports.dedupe(ports.parseNetstat(ns).map((r) => ({ ...r, process: names.get(r.pid) || null })));
  assert.equal(listeners.length, 3);
  assert.deepEqual(listeners[0].addresses, ['0.0.0.0', '[::]']);
  assert.equal(listeners[1].process, 'java.exe');

  const ss = ports.parseSs('LISTEN 0 511 0.0.0.0:4101 0.0.0.0:* users:(("node",pid=123,fd=20))');
  assert.deepEqual(ss[0], { address: '0.0.0.0', port: 4101, pid: 123, process: 'node' });

  const projects = [
    { id: 'web', apps: ['web'], ports: [80] },
    { id: 'api', apps: ['api'], ports: [3000] },
    { id: 'chem', apps: ['chem'], ports: [4101] },
    { id: 'idle', apps: ['idle'], ports: [5000] },
  ];
  const procs = [
    { name: 'web', pid: 4120, status: 'online', mode: 'fork' },
    { name: 'api', pid: 600, status: 'online', mode: 'fork' },
    { name: 'chem', pid: 1001, status: 'online', mode: 'cluster' },
    { name: 'idle', pid: null, status: 'stopped', mode: 'fork' },
  ];
  const r = ports.analyze(projects, listeners, procs, 999);
  const by = Object.fromEntries(r.rows.map((x) => [x.port, x]));
  assert.equal(by[80].state, 'ok');
  assert.equal(by[3000].state, 'conflict'); // java ยึดพอร์ตของ api
  assert.match(by[3000].note, /java\.exe/);
  assert.equal(by[4101].state, 'ok'); // daemon ถือแทน cluster
  assert.equal(by[5000].state, 'free');
  assert.equal(r.conflicts, 1);
});

test('ตารางเวลา: due ครั้งเดียวต่อ slot, freeze ข้ามเที่ยงคืน, nextRun', () => {
  const d = { mode: 'schedule', days: [0], time: '03:00' };
  const sun0305 = new Date(2026, 9, 11, 3, 5); // อาทิตย์
  assert.equal(sched.dueSlot(d, sun0305, null), '2026-10-11 03:00');
  assert.equal(sched.dueSlot(d, sun0305, '2026-10-11 03:00'), null);
  assert.equal(sched.dueSlot(d, new Date(2026, 9, 11, 2, 59), null), null);
  assert.equal(sched.dueSlot(d, new Date(2026, 9, 11, 4, 1), null), null); // เลยหน้าต่าง 60 นาที
  assert.equal(sched.dueSlot(d, new Date(2026, 9, 12, 3, 5), null), null); // จันทร์
  assert.equal(sched.dueSlot({ ...d, mode: 'manual' }, sun0305, null), null);

  const freeze = [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }, { days: [6], from: '22:00', to: '06:00' }];
  assert.equal(sched.inFreeze(freeze, new Date(2026, 9, 12, 9, 0)), true); // จันทร์ 09:00
  assert.equal(sched.inFreeze(freeze, new Date(2026, 9, 12, 17, 0)), false);
  assert.equal(sched.inFreeze(freeze, new Date(2026, 9, 10, 23, 0)), true); // เสาร์ 23:00
  assert.equal(sched.inFreeze(freeze, new Date(2026, 9, 11, 5, 59)), true); // อาทิตย์ 05:59 (ต่อจากเสาร์)
  assert.equal(sched.inFreeze(freeze, new Date(2026, 9, 11, 6, 0)), false);

  const next = new Date(sched.nextRun(d, new Date(2026, 9, 11, 3, 5)));
  assert.equal(next.getDay(), 0);
  assert.equal(next.getDate(), 18);
});

test('ตรวจ projects.json: id/พอร์ตซ้ำ, พอร์ตสงวน, คำสั่งนอก allowlist, path หลุด repo', () => {
  const base = { id: 'a', repoDir: tmp, apps: ['a1'], ports: [80], deploy: { build: [{ cwd: 'frontend', cmd: ['npm', 'run', 'build'] }] } };
  const ok = config.validateProjects([base]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.projects[0].deploy.mode, 'manual');
  assert.equal(ok.projects[0].branch, 'main');

  const bad = config.validateProjects([
    base,
    { ...base, apps: ['a2'] },
    { id: 'b', repoDir: tmp, apps: ['a1', 'center-agent'], ports: [1433, 80], ecosystem: '../x.js', deploy: { mode: 'weekly', time: '25:00', install: [{ cmd: ['powershell', '-c', 'x'] }], build: [{ cwd: '../..', cmd: ['npm'] }] } },
    { id: 'Bad Id', repoDir: 'relative', apps: [] },
  ]);
  const text = bad.errors.join('\n');
  assert.match(text, /id ซ้ำ/);
  assert.match(text, /พอร์ต 80 ซ้ำ/);
  assert.match(text, /1433 สงวนไว้สำหรับ SQL Server/);
  assert.match(text, /app "a1" อยู่ทั้งใน/);
  assert.match(text, /center-agent/);
  assert.match(text, /ecosystem ต้องเป็น path ภายใน repo/);
  assert.match(text, /deploy\.mode/);
  assert.match(text, /deploy\.time/);
  assert.match(text, /powershell/);
  assert.match(text, /cwd ต้องเป็น path ภายใน repo/);
  assert.match(text, /repoDir ต้องเป็น path เต็ม/);
  assert.match(text, /apps ต้องระบุ/);
});

test('ปิดความลับใน log และกันไฟล์อันตรายใน git', () => {
  const out = mask('DB_PASSWORD=Sup3rS3cret token: abc.def Authorization: Bearer eyJabc mssql://sa:pa55@10.0.0.1/db');
  assert.doesNotMatch(out, /Sup3rS3cret|pa55|eyJabc/);
  for (const f of ['.env', 'backend/.env', 'backend/.env.production', 'certs/server.key', 'frontend/dist/index.html', 'node_modules/x/y.js', 'backend/logs/a.txt', 'app.log']) assert.ok(DENY_RE.test(f), f);
  for (const f of ['src/component/Log/LogPage.jsx', 'backend/server.js', 'README.md', '.envrc.md']) assert.ok(!DENY_RE.test(f), f);
  const st = parseStatus('## main...origin/main [behind 3]\n M backend/server.js\n?? new.txt\n');
  assert.equal(st.behind, 3);
  assert.equal(st.dirty, true);
  assert.equal(parseStatus('## main\n?? only-untracked.txt\n').dirty, false);
});

test('nginx template: สร้าง upstream + ตรวจค่าผิด', () => {
  const agents = new Map([['srv116', { id: 'srv116', host: '172.48.0.116' }], ['srv117', { id: 'srv117', host: '172.48.0.117' }]]);
  const lb = lbt.normalize({ agentId: 'srv116', sites: [{ name: 'delayhub', listen: 8080, upstreams: [{ agentId: 'srv116', port: 80 }, { agentId: 'srv117', port: 80, down: true }] }] }, agents);
  const conf = lbt.render(lb);
  assert.ok(conf.startsWith('# Managed by Center_HUB'));
  assert.match(conf, /upstream center_delayhub \{\n {4}ip_hash;/);
  assert.match(conf, /server 172\.48\.0\.116:80 max_fails=3 fail_timeout=10s;/);
  assert.match(conf, /server 172\.48\.0\.117:80 max_fails=3 fail_timeout=10s down;/);
  assert.match(conf, /listen 8080;/);
  assert.match(conf, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.deepEqual(lbt.portClashes(lb, [{ id: 'x', ports: [8080] }]), ['พอร์ต 8080 ของ delayhub ชนกับ project x บนเครื่อง LB']);

  const bad = (sites, re) => assert.throws(() => lbt.normalize({ sites }, agents), re);
  bad([{ name: 'a', listen: 80, upstreams: [{ host: 'x;evil', port: 80 }] }], /host/);
  bad([{ name: 'a', listen: 80, upstreams: [{ agentId: 'srv116', port: 80, down: true }] }], /เครื่องหลัก/);
  bad([{ name: 'a', listen: 80, upstreams: [{ agentId: 'srv116', port: 80 }, { agentId: 'srv117', port: 80, backup: true }] }], /backup/);
  bad([{ name: 'a', listen: 80, upstreams: [{ agentId: 'srv116', port: 80 }] }, { name: 'b', listen: 80, upstreams: [{ agentId: 'srv116', port: 81 }] }], /ซ้ำ/);
  bad([{ name: 'a', listen: 80, serverName: 'x; return 200', upstreams: [{ agentId: 'srv116', port: 80 }] }], /serverName/);
});

test('ผู้ใช้ Hub: รหัสผ่าน scrypt, ล็อกหลังผิด 5 ครั้ง, ต้องเหลือ admin', () => {
  assert.throws(() => auth.upsertUser({ username: 'viewer1', password: 'abcdefghij1', role: 'viewer' }), /admin/);
  auth.upsertUser({ username: 'boss', password: 'Center12345', role: 'admin' });
  const raw = JSON.parse(fs.readFileSync(path.join(process.env.CENTER_HUB_DATA_DIR, 'users.json'), 'utf8'));
  assert.ok(raw[0].hash && raw[0].salt && !JSON.stringify(raw).includes('Center12345'));
  assert.throws(() => auth.upsertUser({ username: 'weak', password: 'short', role: 'viewer' }), /10 ตัว/);

  const { sid } = auth.login('boss', 'Center12345', '1.1.1.1');
  assert.equal(auth.getSession(sid).role, 'admin');
  auth.logout(sid);
  assert.equal(auth.getSession(sid), null);

  for (let i = 0; i < 5; i += 1) assert.throws(() => auth.login('boss', 'wrong', '2.2.2.2'), (e) => e.status === 401);
  assert.throws(() => auth.login('boss', 'Center12345', '3.3.3.3'), (e) => e.status === 429);
  assert.throws(() => auth.deleteUser('boss'), /admin/);
  assert.ok(auth.atLeast('admin', 'operator') && !auth.atLeast('viewer', 'operator'));
});
