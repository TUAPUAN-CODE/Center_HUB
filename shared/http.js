'use strict';
// ตัวช่วย HTTP ฝั่งเซิร์ฟเวอร์ที่ใช้ร่วมกัน (ไม่มี dependency)
const MAX_BODY = 1024 * 1024; // 1 MB

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { reject(Object.assign(new Error('body_too_large'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const parseJson = (text) => {
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('JSON ไม่ถูกต้อง'), { status: 400 }); }
};

const sendJson = (res, status, data, headers = {}) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
};

/** ตัวจับคู่ route แบบ '/v1/projects/:id/pm2' → { id }; ':rest+' = ส่วนที่เหลือทั้งหมด */
const compile = (pattern) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\//g, '\\/').replace(/:([a-zA-Z]+)(\+?)/g, (_, k, plus) => { keys.push(k); return plus ? '(.+)' : '([^/]+)'; }) + '$');
  return (path) => {
    const m = re.exec(path);
    if (!m) return null;
    const params = {};
    try { keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { return null; }
    return params;
  };
};

const createRouter = () => {
  const routes = [];
  const add = (method, pattern, handler, meta = {}) => routes.push({ method, match: compile(pattern), handler, meta });
  const find = (method, path) => {
    for (const r of routes) {
      if (r.method !== method) continue;
      const params = r.match(path);
      if (params) return { ...r, params };
    }
    return null;
  };
  return { add, find };
};

module.exports = { readBody, parseJson, sendJson, createRouter };
