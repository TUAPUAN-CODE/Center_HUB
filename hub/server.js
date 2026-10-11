'use strict';
// Center_HUB — หน้าเว็บกลางสำหรับจัดการทุก project ทุกเครื่อง (สั่งงานผ่าน Agent ที่ลงลายเซ็นไว้)
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { loadEnv } = require('../shared/env');

loadEnv(path.join(__dirname, '.env'));

const { readBody, parseJson, sendJson, createRouter } = require('../shared/http');
const { log } = require('../shared/log');
const auth = require('./lib/auth');
const agents = require('./lib/agents');
const audit = require('./lib/audit');
const store = require('./lib/store');
const lbt = require('./lib/nginx-template');

const VERSION = require('./package.json').version;
const PORT = Number(process.env.CENTER_HUB_PORT) || 4900;
const HOST = process.env.CENTER_HUB_HOST || '0.0.0.0';
const TLS = process.env.CENTER_HUB_TLS_CERT && process.env.CENTER_HUB_TLS_KEY
  ? { cert: fs.readFileSync(process.env.CENTER_HUB_TLS_CERT), key: fs.readFileSync(process.env.CENTER_HUB_TLS_KEY) } : null;
const COOKIE = 'center_sid';
const PUBLIC_DIR = path.join(__dirname, 'public');

const router = createRouter();
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
const clientIp = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const sessionCookie = (sid, maxAge) => `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${TLS ? '; Secure' : ''}`;

const agentOr404 = (id) => {
  const a = agents.get(id);
  if (!a) throw fail('ไม่พบเครื่องนี้', 404);
  return a;
};

// ---------- auth ----------
router.add('POST', '/api/login', async ({ body, req, res }) => {
  try {
    const { sid, user } = auth.login(String(body.username || ''), String(body.password || ''), clientIp(req));
    res.setHeader('Set-Cookie', sessionCookie(sid, 12 * 3600));
    audit.write({ user: user.username, ip: clientIp(req), action: 'login', result: 'ok' });
    return { user };
  } catch (e) {
    audit.write({ user: String(body.username || '').slice(0, 40), ip: clientIp(req), action: 'login', result: e.status === 429 ? 'locked' : 'failed' });
    throw e;
  }
}, { public: true });

router.add('POST', '/api/logout', async ({ req, res }) => {
  auth.logout(cookies(req)[COOKIE]);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return {};
}, { role: 'viewer' });

// public: ยังไม่ login คืน null (หน้าเว็บจะแสดงหน้า login โดยไม่มี error 401 ใน console)
router.add('GET', '/api/me', async ({ req }) => {
  const session = auth.getSession(cookies(req)[COOKIE]);
  return session ? { username: session.username, role: session.role, version: VERSION } : null;
}, { public: true });

router.add('POST', '/api/me/password', async ({ session, body }) => {
  const u = auth.listUsers().find((x) => x.username === session.username);
  if (!u) throw fail('ไม่พบผู้ใช้', 404);
  try { auth.login(session.username, String(body.current || ''), 'self-check'); } catch { throw fail('รหัสผ่านเดิมไม่ถูกต้อง', 400); }
  auth.upsertUser({ username: session.username, password: String(body.password || '') });
  return { changed: true, note: 'เปลี่ยนรหัสแล้ว — login ใหม่' };
}, { role: 'viewer', audit: 'change_password' });

// ---------- ผู้ใช้ ----------
router.add('GET', '/api/users', async () => auth.listUsers(), { role: 'admin' });
router.add('POST', '/api/users', async ({ body }) => auth.upsertUser({ username: body.username, password: body.password || undefined, role: body.role, disabled: body.disabled }), { role: 'admin', audit: 'user_upsert' });
router.add('DELETE', '/api/users/:username', async ({ params, session }) => {
  if (params.username === session.username) throw fail('ลบตัวเองไม่ได้');
  auth.deleteUser(params.username);
  return {};
}, { role: 'admin', audit: 'user_delete' });

// ---------- เครื่อง (Agent) ----------
router.add('GET', '/api/agents', async () => agents.list().map(agents.publicAgent), { role: 'viewer' });
router.add('POST', '/api/agents', async ({ body }) => agents.upsert(body), { role: 'admin', audit: 'agent_upsert' });
router.add('DELETE', '/api/agents/:aid', async ({ params }) => { agents.remove(params.aid); return {}; }, { role: 'admin', audit: 'agent_delete' });

router.add('GET', '/api/overview', async () => {
  const list = agents.list();
  const results = await Promise.all(list.map(async (a) => {
    try { return { ...agents.publicAgent(a), online: true, data: await agents.call(a, 'GET', '/v1/overview', undefined, { timeoutMs: 6000 }) }; } catch (e) {
      return { ...agents.publicAgent(a), online: false, error: e.message };
    }
  }));
  return { agents: results, time: new Date().toISOString() };
}, { role: 'viewer' });

// ---------- ส่งต่อคำสั่งไปยัง Agent (กำหนดสิทธิ์ต่อเส้นทาง) ----------
const PROXY_RULES = [
  ['GET', /^\/v1\/projects\/[^/]+\/(git\/(status|log|branches)|deploys)$/, 'viewer'],
  ['GET', /^\/v1\/(jobs\/[0-9a-f]{16}|ports)$/, 'viewer'],
  ['GET', /^\/v1\/projects\/[^/]+\/(logs|git\/diff)$/, 'operator'],
  ['POST', /^\/v1\/projects\/[^/]+\/pm2$/, 'operator'],
  ['POST', /^\/v1\/projects\/[^/]+\/git\/(fetch|pull)$/, 'operator'],
  ['POST', /^\/v1\/projects\/[^/]+\/deploy$/, 'operator'],
  ['POST', /^\/v1\/projects\/[^/]+\/git\/(checkout|commit)$/, 'admin'],
  ['GET', /^\/v1\/config\/projects$/, 'admin'],
  ['PUT', /^\/v1\/config\/projects$/, 'admin'],
  ['POST', /^\/v1\/config\/projects\/validate$/, 'admin'],
  ['GET', /^\/v1\/nginx$/, 'admin'],
];
const LONG_ACTIONS = /\/(pm2|git\/(fetch|pull|checkout|commit))$/;

const proxy = async ({ req, session, params, query, body }) => {
  const agent = agentOr404(params.aid);
  const sub = `/v1/${params.rest}`;
  if (/(^|\/)\.{1,2}(\/|$)|[\\%?#]/.test(sub)) throw fail('path ไม่ถูกต้อง');
  const rule = PROXY_RULES.find(([m, re]) => m === req.method && re.test(sub));
  if (!rule) throw fail('ไม่อนุญาต', 404);
  let need = rule[2];
  if (sub.endsWith('/deploy') && (body.force || body.redeploy)) need = 'admin';
  if (!auth.atLeast(session.role, need)) throw fail(`ต้องมีสิทธิ์ ${need}`, 403);
  const qs = query.toString();
  const data = await agents.call(agent, req.method, `${sub}${qs ? `?${qs}` : ''}`, req.method === 'GET' ? undefined : body, {
    timeoutMs: LONG_ACTIONS.test(sub) ? 5 * 60 * 1000 : 15000, user: session.username,
  });
  return data;
};
for (const m of ['GET', 'POST', 'PUT']) router.add(m, '/api/a/:aid/v1/:rest+', proxy, { role: 'viewer', auditMutations: true });

// ---------- Load balancer ----------
const agentsById = () => new Map(agents.list().map((a) => [a.id, a]));
router.add('GET', '/api/lb', async () => store.read('lb', { agentId: null, sites: [] }), { role: 'viewer' });
router.add('PUT', '/api/lb', async ({ body }) => {
  const lb = lbt.normalize(body, agentsById());
  store.write('lb', lb);
  return lb;
}, { role: 'admin', audit: 'lb_save' });
router.add('POST', '/api/lb/preview', async ({ body }) => ({ config: lbt.render(lbt.normalize(body, agentsById())) }), { role: 'admin' });
router.add('POST', '/api/lb/apply', async ({ session }) => {
  const lb = lbt.normalize(store.read('lb', { sites: [] }), agentsById());
  if (!lb.agentId) throw fail('ยังไม่ได้เลือกเครื่องที่เป็น Load Balancer');
  const agent = agentOr404(lb.agentId);
  const overview = await agents.call(agent, 'GET', '/v1/overview', undefined, { timeoutMs: 15000 });
  const clashes = lbt.portClashes(lb, overview.projects);
  if (clashes.length) throw Object.assign(fail('พอร์ตของ LB ชนกับ project บนเครื่อง LB', 409), { details: clashes });
  return agents.call(agent, 'POST', '/v1/nginx/apply', { config: lbt.render(lb) }, { timeoutMs: 60000, user: session.username });
}, { role: 'admin', audit: 'lb_apply' });

router.add('GET', '/api/audit', async ({ query }) => audit.recent(query.get('limit'), query.get('q')), { role: 'admin' });

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const SECURITY_HEADERS = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
const staticCache = new Map();

const serveStatic = (req, res, pathname) => {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end('not found');
    return;
  }
  let entry = staticCache.get(full);
  const mtime = fs.statSync(full).mtimeMs;
  if (!entry || entry.mtime !== mtime) {
    const raw = fs.readFileSync(full);
    entry = { mtime, raw, gz: zlib.gzipSync(raw), etag: `"${mtime.toString(36)}-${raw.length.toString(36)}"` };
    staticCache.set(full, entry);
  }
  const headers = { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ETag: entry.etag, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS };
  if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); res.end(); return; }
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { ...headers, ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
  res.end(gzip ? entry.gz : entry.raw);
};

// ---------- HTTP ----------
const sameOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
};

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://hub');
  const ip = clientIp(req);
  if (url.pathname === '/health') { sendJson(res, 200, { ok: true, version: VERSION }); return; }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method_not_allowed' }); return; }
    serveStatic(req, res, url.pathname);
    return;
  }
  const route = router.find(req.method, url.pathname);
  if (!route) { sendJson(res, 404, { ok: false, error: 'ไม่พบ API' }); return; }
  let session = null;
  let body = {};
  try {
    // กัน CSRF: คำสั่งที่เปลี่ยนข้อมูลต้องมาจากหน้าเว็บของ Hub เอง
    if (req.method !== 'GET' && (req.headers['x-requested-with'] !== 'center-hub' || !sameOrigin(req))) throw fail('csrf', 403);
    if (!route.meta.public) {
      session = auth.getSession(cookies(req)[COOKIE]);
      if (!session) throw fail('กรุณา login', 401);
      if (!auth.atLeast(session.role, route.meta.role || 'admin')) throw fail(`ต้องมีสิทธิ์ ${route.meta.role}`, 403);
    }
    body = parseJson(await readBody(req));
    const data = await route.handler({ req, res, session, params: route.params, query: url.searchParams, body });
    const mutation = req.method !== 'GET' && (route.meta.audit || route.meta.auditMutations);
    if (mutation) audit.write({ user: session && session.username, ip, action: route.meta.audit || `${req.method} ${url.pathname.replace(/^\/api\/a\/[^/]+/, '')}`, agent: route.params.aid, target: url.pathname, input: summarizeBody(body), result: 'ok' });
    sendJson(res, 200, { ok: true, data }, SECURITY_HEADERS);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500 && status !== 502 && status !== 504) log('error', 'hub_error', { path: url.pathname, error: err.message });
    if (req.method !== 'GET' && session && status !== 401) audit.write({ user: session.username, ip, action: route.meta.audit || `${req.method} ${url.pathname.replace(/^\/api\/a\/[^/]+/, '')}`, agent: route.params.aid, target: url.pathname, input: summarizeBody(body), result: 'error', error: err.message });
    sendJson(res, status, { ok: false, error: err.message, details: err.details, job: err.job }, SECURITY_HEADERS);
  }
};

/** เก็บเฉพาะส่วนที่ไม่ลับของ body ลง audit */
const summarizeBody = (b) => {
  if (!b || typeof b !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (/pass|secret|token|config|projects/i.test(k)) { out[k] = '[omitted]'; continue; }
    out[k] = typeof v === 'string' ? v.slice(0, 200) : Array.isArray(v) ? `[${v.length}]` : v;
  }
  return out;
};

const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler);
server.listen(PORT, HOST, () => {
  log('info', 'hub_started', { host: HOST, port: PORT, tls: Boolean(TLS), version: VERSION, users: auth.listUsers().length, agents: agents.list().length });
  if (!auth.listUsers().length) log('warn', 'no_users', { hint: 'สร้าง admin คนแรก: node hub/scripts/user.js <ชื่อ> admin' });
  if (process.send) process.send('ready');
});

const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('message', (m) => { if (m === 'shutdown') shutdown(); });

module.exports = server;
