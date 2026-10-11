'use strict';
// ทดสอบทั้งระบบจริง: Hub → Agent → PM2 (daemon แยกใน PM2_HOME ชั่วคราว) + git remote ชั่วคราว
// ครอบคลุม: login/สิทธิ์/CSRF, start/stop, ตรวจพอร์ต, fetch, deploy สำเร็จ, deploy พัง → rollback, ไฟล์ค้าง, commit, audit
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PM2_BIN = path.join(ROOT, 'agent', 'node_modules', 'pm2', 'bin', 'pm2');
const hasPm2 = fs.existsSync(PM2_BIN);

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});
const waitFor = async (fn, ms = 20000, label = 'condition') => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}: ${last && last.message ? last.message : JSON.stringify(last)}`);
};

const client = (base) => {
  let cookie = '';
  const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const r = http.request(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'center-hub', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        const sc = res.headers['set-cookie'];
        if (sc) cookie = sc[0].split(';')[0];
        let json = null;
        try { json = JSON.parse(b); } catch { json = { raw: b }; }
        resolve({ status: res.statusCode, ...json });
      });
    });
    r.on('error', reject);
    r.end(raw || undefined);
  });
  return { req, ok: async (method, p, body) => { const r = await req(method, p, body); if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${r.error} ${JSON.stringify(r.details || '')}`); return r.data; } };
};

test('Hub + Agent + PM2 + git (end-to-end)', { skip: !hasPm2 && 'ต้อง npm install ใน agent/ ก่อน', timeout: 240000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'center-e2e-'));
  const [appPort, agentPort, hubPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const SECRET = 'e2e-secret-'.padEnd(48, 'z');
  const env = { ...process.env, PM2_HOME: path.join(tmp, 'pm2') };
  const procs = [];

  t.after(async () => {
    procs.forEach((p) => p.kill('SIGTERM'));
    try { execFileSync(process.execPath, [PM2_BIN, 'kill'], { env, stdio: 'ignore', timeout: 30000 }); } catch { /* ไม่สนใจ */ }
    if (!process.env.KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true }); else console.log('tmp kept:', tmp);
  });

  // ---- repo ต้นทาง + เครื่องที่ deploy ----
  const remote = path.join(tmp, 'remote.git');
  const dev = path.join(tmp, 'dev');
  const app = path.join(tmp, 'app');
  git(tmp, 'init', '--bare', '-b', 'main', remote);
  git(tmp, 'clone', remote, dev);
  for (const d of [dev]) { git(d, 'config', 'user.email', 'dev@example.com'); git(d, 'config', 'user.name', 'Dev'); git(d, 'checkout', '-b', 'main'); }
  fs.writeFileSync(path.join(dev, 'server.js'), `const http = require('http'); const fs = require('fs');
const v = fs.readFileSync(__dirname + '/VERSION', 'utf8').trim();
if (v === 'crash') { console.error('boom'); process.exit(1); }
http.createServer((q, s) => { s.end(JSON.stringify({ v, built: fs.existsSync(__dirname + '/built.txt') ? fs.readFileSync(__dirname + '/built.txt', 'utf8') : null })); })
  .listen(${appPort}, '127.0.0.1', () => { console.log('listening password=hunter2'); if (process.send) process.send('ready'); });\n`);
  fs.writeFileSync(path.join(dev, 'ecosystem.config.js'), `module.exports = { apps: [{ name: 'cht-app', script: 'server.js', exec_mode: 'fork', restart_delay: 300, wait_ready: true, listen_timeout: 5000 }] };\n`);
  fs.writeFileSync(path.join(dev, 'build.js'), "require('fs').writeFileSync(__dirname + '/built.txt', require('fs').readFileSync(__dirname + '/VERSION', 'utf8').trim());\n");
  fs.writeFileSync(path.join(dev, '.gitignore'), 'built.txt\n');
  fs.writeFileSync(path.join(dev, 'VERSION'), 'v1\n');
  fs.writeFileSync(path.join(dev, 'README.md'), 'demo\n');
  git(dev, 'add', '.');
  git(dev, 'commit', '-m', 'v1');
  git(dev, 'push', '-u', 'origin', 'main');
  git(tmp, 'clone', remote, app);
  git(app, 'config', 'user.email', 'server@example.com');
  git(app, 'config', 'user.name', 'Server');
  execFileSync(process.execPath, ['build.js'], { cwd: app });
  const pushVersion = (v) => { fs.writeFileSync(path.join(dev, 'VERSION'), `${v}\n`); git(dev, 'commit', '-am', v); git(dev, 'push'); return git(dev, 'rev-parse', 'HEAD'); };

  // ---- Agent ----
  const cfgDir = path.join(tmp, 'agent-config');
  fs.mkdirSync(cfgDir);
  fs.writeFileSync(path.join(cfgDir, 'agent.json'), JSON.stringify({ id: 'local', name: 'Local test' }));
  fs.writeFileSync(path.join(cfgDir, 'projects.json'), JSON.stringify([{
    id: 'demo', name: 'Demo', repoDir: app, branch: 'main', ecosystem: 'ecosystem.config.js', apps: ['cht-app'], ports: [appPort],
    health: [{ url: `http://127.0.0.1:${appPort}/` }],
    deploy: { mode: 'manual', build: [{ cmd: ['node', 'build.js'] }], healthTimeoutSec: 15 },
  }]));
  const agent = spawn(process.execPath, [path.join(ROOT, 'agent', 'server.js')], {
    env: { ...env, CENTER_AGENT_SECRET: SECRET, CENTER_AGENT_PORT: String(agentPort), CENTER_AGENT_HOST: '127.0.0.1', CENTER_AGENT_CONFIG_DIR: cfgDir, CENTER_AGENT_DATA_DIR: path.join(tmp, 'agent-data') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  procs.push(agent);
  let agentLog = '';
  agent.stdout.on('data', (c) => { agentLog += c; });
  agent.stderr.on('data', (c) => { agentLog += c; });
  await waitFor(async () => (await get(`http://127.0.0.1:${agentPort}/health`)).status === 200, 15000, 'agent');

  // คำขอที่ไม่มีลายเซ็นต้องถูกปฏิเสธ
  assert.equal((await get(`http://127.0.0.1:${agentPort}/v1/overview`)).status, 401);

  // ---- Hub ----
  const hubData = path.join(tmp, 'hub-data');
  execFileSync(process.execPath, [path.join(ROOT, 'hub', 'scripts', 'user.js'), 'admin1', 'admin'], { env: { ...env, CENTER_HUB_DATA_DIR: hubData, CENTER_HUB_NEW_PASSWORD: 'Admin12345x' } });
  execFileSync(process.execPath, [path.join(ROOT, 'hub', 'scripts', 'user.js'), 'view1', 'viewer'], { env: { ...env, CENTER_HUB_DATA_DIR: hubData, CENTER_HUB_NEW_PASSWORD: 'Viewer12345x' } });
  const hub = spawn(process.execPath, [path.join(ROOT, 'hub', 'server.js')], { env: { ...env, CENTER_HUB_PORT: String(hubPort), CENTER_HUB_HOST: '127.0.0.1', CENTER_HUB_DATA_DIR: hubData }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  procs.push(hub);
  await waitFor(async () => (await get(`http://127.0.0.1:${hubPort}/health`)).status === 200, 10000, 'hub');
  const base = `http://127.0.0.1:${hubPort}`;

  const index = await get(`${base}/`);
  assert.match(index.body, /Center_HUB/);

  const anon = client(base);
  assert.equal((await anon.req('GET', '/api/overview')).status, 401);
  assert.equal((await anon.req('POST', '/api/login', { username: 'admin1', password: 'nope' })).status, 401);

  const admin = client(base);
  await admin.ok('POST', '/api/login', { username: 'admin1', password: 'Admin12345x' });
  assert.equal((await admin.req('POST', '/api/agents', { id: 'local', url: `http://127.0.0.1:${agentPort}`, secret: 'short' })).status, 400);
  await admin.ok('POST', '/api/agents', { id: 'local', name: 'Local test', url: `http://127.0.0.1:${agentPort}`, secret: SECRET });
  const agents = await admin.ok('GET', '/api/agents');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].secret, undefined, 'ห้ามส่งความลับกลับไปหน้าเว็บ');

  let ov = await admin.ok('GET', '/api/overview');
  assert.equal(ov.agents[0].online, true);
  assert.equal(ov.agents[0].data.projects[0].apps[0].status, 'missing');

  // ---- สิทธิ์ / CSRF ----
  const viewer = client(base);
  await viewer.ok('POST', '/api/login', { username: 'view1', password: 'Viewer12345x' });
  assert.equal((await viewer.req('POST', '/api/a/local/v1/projects/demo/pm2', { action: 'start' })).status, 403);
  assert.equal((await viewer.req('GET', '/api/a/local/v1/projects/demo/logs')).status, 403);
  assert.equal((await viewer.req('GET', '/api/users')).status, 403);
  assert.ok(Array.isArray(await viewer.ok('GET', '/api/a/local/v1/projects/demo/git/log')));
  assert.equal((await admin.req('POST', '/api/a/local/v1/projects/demo/pm2', { action: 'start' }, { 'X-Requested-With': '' })).status, 403);
  assert.equal((await viewer.req('GET', '/api/a/local/v1/projects/demo%2F..%2F..%2Fconfig%2Fprojects')).status, 400);

  // ---- PM2 start ----
  const started = await admin.ok('POST', '/api/a/local/v1/projects/demo/pm2', { action: 'start' });
  assert.equal(started.apps[0].status, 'online');
  await waitFor(async () => JSON.parse((await get(`http://127.0.0.1:${appPort}/`)).body).v === 'v1', 10000, 'app v1');

  // ---- พอร์ต ----
  const portRes = await admin.ok('GET', '/api/a/local/v1/ports');
  const row = portRes.rows.find((r) => r.port === appPort);
  assert.equal(row.state, 'ok', JSON.stringify(row));

  // ---- logs ถูกปิดความลับ ----
  const logs = await waitFor(async () => { const l = await admin.ok('GET', '/api/a/local/v1/projects/demo/logs?app=cht-app'); return l.lines.join('\n').includes('listening') ? l : null; }, 10000, 'log');
  assert.doesNotMatch(logs.lines.join('\n'), /hunter2/);

  // ---- deploy สำเร็จ ----
  const v2 = pushVersion('v2');
  const fetched = await admin.ok('POST', '/api/a/local/v1/projects/demo/git/fetch');
  assert.equal(fetched.behind, 1);
  const runDeploy = async (body = {}) => {
    const { job } = await admin.ok('POST', '/api/a/local/v1/projects/demo/deploy', body);
    return waitFor(async () => { const j = await admin.ok('GET', `/api/a/local/v1/jobs/${job}`); return j.status !== 'running' ? j : null; }, 90000, 'deploy');
  };
  let job = await runDeploy();
  assert.equal(job.status, 'success', JSON.stringify(job, null, 1));
  assert.equal(job.to, v2);
  let body = JSON.parse((await get(`http://127.0.0.1:${appPort}/`)).body);
  assert.deepEqual(body, { v: 'v2', built: 'v2' });

  // ไม่มีโค้ดใหม่ → up_to_date
  job = await runDeploy();
  assert.equal(job.status, 'up_to_date');

  // ---- deploy โค้ดพัง → rollback ----
  pushVersion('crash');
  job = await runDeploy();
  assert.equal(job.status, 'rolled_back', JSON.stringify(job, null, 1));
  assert.equal(git(app, 'rev-parse', 'HEAD'), v2);
  body = await waitFor(async () => { const b = JSON.parse((await get(`http://127.0.0.1:${appPort}/`)).body); return b.v === 'v2' ? b : null; }, 15000, 'v2 after rollback');
  assert.equal(body.built, 'v2');

  // ---- ไฟล์แก้ค้าง → ไม่ deploy ----
  git(dev, 'revert', '--no-edit', 'HEAD');
  git(dev, 'push');
  fs.appendFileSync(path.join(app, 'README.md'), 'hotfix on server\n');
  job = await runDeploy();
  assert.equal(job.status, 'failed');
  assert.match(job.error, /README\.md/);
  assert.equal(git(app, 'rev-parse', 'HEAD'), v2);

  // ---- commit ผ่าน Hub (เฉพาะไฟล์ที่เลือก, ห้าม .env) ----
  fs.writeFileSync(path.join(app, '.env'), 'DB_PASSWORD=x\n');
  const st = await admin.ok('GET', '/api/a/local/v1/projects/demo/git/status');
  assert.ok(st.files.some((f) => f.file === 'README.md'));
  assert.equal((await admin.req('POST', '/api/a/local/v1/projects/demo/git/commit', { message: 'x', files: ['.env'] })).status, 400);
  assert.equal((await viewer.req('POST', '/api/a/local/v1/projects/demo/git/commit', { message: 'x', files: ['README.md'] })).status, 403);
  const committed = await admin.ok('POST', '/api/a/local/v1/projects/demo/git/commit', { message: 'docs: บันทึกจากเครื่อง server', files: ['README.md'], push: false });
  assert.match(committed.head.subject, /บันทึกจากเครื่อง server/);
  assert.match(git(app, 'log', '-1', '--format=%B'), /Committed-via: Center_HUB \(admin1\)/);
  fs.unlinkSync(path.join(app, '.env'));

  const branches = await admin.ok('GET', '/api/a/local/v1/projects/demo/git/branches');
  assert.ok(branches.some((b) => b.name === 'main' && b.current));
  const history = await admin.ok('GET', '/api/a/local/v1/projects/demo/deploys');
  assert.deepEqual(history.map((h) => h.status).slice(0, 4), ['failed', 'rolled_back', 'up_to_date', 'success']);

  // ---- ตั้งค่า project ผ่าน Hub: ค่าผิดต้องไม่ถูกบันทึก ----
  const cfg = await admin.ok('GET', '/api/a/local/v1/config/projects');
  const badCfg = await admin.req('PUT', '/api/a/local/v1/config/projects', { projects: [...cfg.projects, { ...cfg.projects[0], id: 'demo2', apps: ['x'], ports: [appPort] }] });
  assert.equal(badCfg.status, 422);
  assert.ok(badCfg.details.some((d) => /ซ้ำ/.test(d)));
  assert.equal((await viewer.req('GET', '/api/a/local/v1/config/projects')).status, 403);

  // ---- stop ----
  const stopped = await admin.ok('POST', '/api/a/local/v1/projects/demo/pm2', { action: 'stop' });
  assert.equal(stopped.apps[0].status, 'stopped');
  ov = await admin.ok('GET', '/api/overview');
  assert.equal(ov.agents[0].data.projects[0].deploy.last.status, 'failed');

  // ---- audit ----
  const audit = await admin.ok('GET', '/api/audit?limit=100');
  assert.ok(audit.some((e) => e.user === 'admin1' && /deploy/.test(e.action)));
  assert.ok(audit.some((e) => e.action === 'login' && e.result === 'failed'));
  assert.ok(!JSON.stringify(audit).includes(SECRET), 'audit ห้ามมีความลับ');
  assert.doesNotMatch(agentLog, /hunter2|e2e-secret/);
});
