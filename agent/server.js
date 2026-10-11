'use strict';
// Center_HUB Agent — รันบนทุกเครื่องที่มี project (PM2 ตัวเดียวกับ project) รับคำสั่งที่ลงลายเซ็นจาก Hub เท่านั้น
const path = require('path');
const http = require('http');
const { loadEnv } = require('../shared/env');

loadEnv(path.join(__dirname, '.env'));

const { createVerifier } = require('../shared/sign');
const { readBody, parseJson, sendJson, createRouter } = require('../shared/http');
const { log } = require('../shared/log');
const config = require('./lib/config');
const pm2 = require('./lib/pm2');
const git = require('./lib/git');
const ports = require('./lib/ports');
const health = require('./lib/health');
const logs = require('./lib/logs');
const deploy = require('./lib/deploy');
const nginx = require('./lib/nginx');
const sched = require('./lib/scheduler');

const VERSION = require('./package.json').version;
const PORT = Number(process.env.CENTER_AGENT_PORT) || 4910;
const HOST = process.env.CENTER_AGENT_HOST || '0.0.0.0';
const ALLOW_IPS = (process.env.CENTER_AGENT_ALLOW_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);

if (!process.env.CENTER_AGENT_SECRET) {
  log('error', 'agent_secret_missing', { hint: 'ใส่ CENTER_AGENT_SECRET (ยาว ≥ 32 ตัว) ใน agent/.env — ค่าเดียวกับที่ลงทะเบียนใน Hub' });
  process.exit(1);
}
const verify = createVerifier(process.env.CENTER_AGENT_SECRET);
const router = createRouter();

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const projectOr404 = (id) => {
  const p = config.getProject(id);
  if (!p) throw fail('ไม่พบ project', 404);
  return p;
};
const actor = (req) => String(req.headers['x-center-user'] || '').slice(0, 60) || null;

// ---------- ภาพรวม ----------
const projectOverview = async (project, all) => {
  const [st, head] = await Promise.all([git.status(project).catch((e) => ({ error: e.message })), git.head(project).catch(() => null)]);
  const checks = await health.checkAll(project.health);
  const ps = deploy.projectState(project.id);
  const job = deploy.runningJob(project.id);
  return {
    id: project.id,
    name: project.name,
    branch: project.branch,
    apps: pm2.summarize(all, project.apps),
    ports: project.ports,
    health: checks,
    git: { ...st, head, behindRemote: ps.behind ?? null, lastFetch: ps.lastFetch || null, fetchError: ps.fetchError || null },
    deploy: {
      mode: project.deploy.mode, days: project.deploy.days, time: project.deploy.time, freeze: project.deploy.freeze,
      frozenNow: sched.inFreeze(project.deploy.freeze), nextRun: sched.nextRun(project.deploy),
      autoPaused: Boolean(ps.failedRemote && ps.failedRemote === ps.remoteHead),
      last: ps.lastDeploy || null, running: job ? { id: job.id, status: job.status, step: (job.steps[job.steps.length - 1] || {}).name } : null,
    },
  };
};

router.add('GET', '/v1/overview', async () => {
  const agent = config.loadAgentConfig();
  const { projects, errors, warnings } = config.loadProjects();
  const all = await pm2.list();
  const [items, listeners] = await Promise.all([
    Promise.all(projects.map((p) => projectOverview(p, all))),
    ports.listListeners().catch(() => []),
  ]);
  const portInfo = ports.analyze(projects, listeners, all, pm2.daemonPid(), config.RESERVED_PORTS);
  const known = new Set(projects.flatMap((p) => p.apps));
  return {
    agent: { id: agent.id, name: agent.name, version: VERSION, platform: process.platform, node: process.version, time: new Date().toISOString(), lb: Boolean(agent.nginx) },
    projects: items,
    unmanaged: pm2.summarize(all, [...new Set(all.map((p) => p.name))].filter((n) => !known.has(n))),
    ports: { conflicts: portInfo.conflicts, undeclared: portInfo.undeclared.length },
    configErrors: errors,
    configWarnings: warnings,
  };
});

// ---------- PM2 ----------
router.add('POST', '/v1/projects/:id/pm2', async ({ params, body }) => {
  const project = projectOr404(params.id);
  if (deploy.runningJob(project.id)) throw fail('กำลัง deploy อยู่ — รอให้เสร็จก่อน', 409);
  const apps = await pm2.act(project, body.action, body.app || null);
  return { apps };
});

router.add('GET', '/v1/projects/:id/logs', async ({ params, query }) => {
  const project = projectOr404(params.id);
  const app = query.get('app') || project.apps[0];
  if (!project.apps.includes(app)) throw fail('app ไม่อยู่ใน project นี้');
  const [info] = pm2.summarize(await pm2.list(), [app]);
  const kind = query.get('kind') === 'err' ? 'err' : 'out';
  return { app, kind, ...logs.tail(kind === 'err' ? info.errLog : info.outLog, query.get('lines')) };
});

// ---------- Git ----------
router.add('GET', '/v1/projects/:id/git/status', async ({ params }) => {
  const project = projectOr404(params.id);
  const [st, head] = await Promise.all([git.status(project), git.head(project)]);
  return { ...st, head, behindRemote: await git.behindCount(project) };
});
router.add('GET', '/v1/projects/:id/git/log', async ({ params, query }) => git.log(projectOr404(params.id), { ref: query.get('ref') || undefined, limit: query.get('limit') }));
router.add('GET', '/v1/projects/:id/git/branches', async ({ params }) => git.branches(projectOr404(params.id)));
router.add('GET', '/v1/projects/:id/git/diff', async ({ params, query }) => git.diff(projectOr404(params.id), { file: query.get('file') ?? undefined }));
router.add('POST', '/v1/projects/:id/git/fetch', async ({ params }) => {
  const project = projectOr404(params.id);
  await git.fetch(project);
  const ps = deploy.stateOf(project.id);
  ps.behind = await git.behindCount(project);
  ps.remoteHead = await git.remoteHead(project);
  ps.lastFetch = new Date().toISOString();
  return { behind: ps.behind, remoteHead: ps.remoteHead };
});
router.add('POST', '/v1/projects/:id/git/pull', async ({ params }) => {
  const project = projectOr404(params.id);
  if (deploy.runningJob(project.id)) throw fail('กำลัง deploy อยู่', 409);
  const out = await git.pull(project);
  deploy.stateOf(project.id).behind = 0;
  return { ...out, note: 'pull อย่างเดียวยังไม่ reload app — กด Deploy หรือ Reload เพื่อให้โค้ดใหม่ทำงาน' };
});
router.add('POST', '/v1/projects/:id/git/checkout', async ({ params, body }) => {
  const project = projectOr404(params.id);
  if (deploy.runningJob(project.id)) throw fail('กำลัง deploy อยู่', 409);
  return git.checkout(project, body.ref);
});
router.add('POST', '/v1/projects/:id/git/commit', async ({ params, body, req }) => git.commit(projectOr404(params.id), { ...body, author: actor(req) }));

// ---------- Deploy ----------
router.add('POST', '/v1/projects/:id/deploy', async ({ params, body, req }) => {
  const job = deploy.start(params.id, { trigger: 'manual', user: actor(req), force: Boolean(body.force), redeploy: Boolean(body.redeploy) });
  return { job: job.id };
});
router.add('GET', '/v1/projects/:id/deploys', async ({ params, query }) => { projectOr404(params.id); return deploy.history(params.id, query.get('limit')); });
router.add('GET', '/v1/jobs/:job', async ({ params }) => {
  const job = deploy.getJob(params.job);
  if (!job) throw fail('ไม่พบ job', 404);
  return job;
});

// ---------- พอร์ต ----------
router.add('GET', '/v1/ports', async () => {
  const { projects } = config.loadProjects();
  const [listeners, all] = await Promise.all([ports.listListeners(), pm2.list()]);
  return { ...ports.analyze(projects, listeners, all, pm2.daemonPid(), config.RESERVED_PORTS), listeners };
});

// ---------- ตั้งค่า ----------
router.add('GET', '/v1/config/projects', async () => {
  config.reload();
  const { raw, errors, warnings } = config.loadProjects();
  const agent = config.loadAgentConfig();
  return { projects: raw, errors, warnings, allowedCommands: agent.allowedCommands, reservedPorts: [...config.RESERVED_PORTS.keys(), ...agent.reservedPorts] };
});
router.add('POST', '/v1/config/projects/validate', async ({ body }) => config.validateProjects(body.projects));
router.add('PUT', '/v1/config/projects', async ({ body }) => {
  const result = config.saveProjects(body.projects);
  if (result.errors.length) throw Object.assign(fail('ตั้งค่าไม่ผ่านการตรวจ', 422), { details: result.errors });
  return { saved: true, warnings: result.warnings };
});

// ---------- Load balancer ----------
router.add('GET', '/v1/nginx', async () => nginx.status(config.loadAgentConfig()));
router.add('POST', '/v1/nginx/apply', async ({ body }) => nginx.apply(config.loadAgentConfig(), body.config));

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://agent');
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (req.method === 'GET' && url.pathname === '/health') { sendJson(res, 200, { ok: true, version: VERSION }); return; }
  if (ALLOW_IPS.length && !ALLOW_IPS.includes(ip)) { sendJson(res, 403, { error: 'ip_not_allowed' }); return; }
  try {
    const raw = await readBody(req);
    const why = verify(req.method, req.url, req.headers, raw);
    if (why) { log('warn', 'agent_unauthorized', { ip, reason: why, path: url.pathname }); sendJson(res, 401, { error: why }); return; }
    const route = router.find(req.method, url.pathname);
    if (!route) { sendJson(res, 404, { error: 'not_found' }); return; }
    const body = parseJson(raw);
    const data = await route.handler({ req, params: route.params, query: url.searchParams, body });
    if (req.method !== 'GET') log('info', 'agent_action', { ip, user: actor(req), method: req.method, path: url.pathname });
    sendJson(res, 200, { ok: true, data });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) log('error', 'agent_error', { path: url.pathname, error: err.message });
    sendJson(res, status, { ok: false, error: err.message, details: err.details, job: err.job });
  }
});

server.listen(PORT, HOST, () => {
  log('info', 'agent_started', { host: HOST, port: PORT, version: VERSION });
  deploy.startScheduler();
  if (process.send) process.send('ready');
});

const shutdown = () => {
  deploy.stopScheduler();
  server.close(() => { pm2.disconnect(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (m) => { if (m === 'shutdown') shutdown(); });
process.on('unhandledRejection', (e) => log('error', 'unhandled_rejection', { error: String(e && e.message) }));

module.exports = server;
