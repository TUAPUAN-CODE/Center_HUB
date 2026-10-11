'use strict';
/* Center_HUB — หน้าเว็บ (vanilla JS, ไม่มี library) — ข้อมูลทุกอย่างใส่ผ่าน textContent เท่านั้น */
(() => {
  const ROLES = ['viewer', 'operator', 'admin'];
  const STATUS_TEXT = { online: 'RUN', degraded: 'บางส่วน', stopped: 'DOWN', errored: 'ERROR', missing: 'ไม่มีใน PM2', launching: 'กำลังเริ่ม', stopping: 'กำลังหยุด', 'waiting restart': 'รอ restart' };
  const DEPLOY_MODE_TEXT = { manual: 'กดเอง', notify: 'แจ้งเตือนเมื่อมีโค้ดใหม่', schedule: 'ตามตาราง', immediate: 'ทันทีที่มีโค้ดใหม่' };
  const JOB_TEXT = { running: 'กำลังทำ', success: 'สำเร็จ', up_to_date: 'ไม่มีโค้ดใหม่', failed: 'ล้มเหลว', rolled_back: 'ล้มเหลว → rollback แล้ว', rollback_failed: 'rollback ไม่สำเร็จ' };
  const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

  let me = null;
  let timer = null;
  let lastOverview = null;

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const h = (tag, props, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  };
  /** แทนลูกของ element (ข้าม null/false และแตก array) */
  const fill = (el, ...children) => el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  const svg = (tag, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
  const can = (role) => me && ROLES.indexOf(me.role) >= ROLES.indexOf(role);
  const fmtMem = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / (1 << 20))} MB`);
  const fmtDur = (ms) => {
    if (!ms) return '-';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s} วิ`;
    if (s < 3600) return `${Math.floor(s / 60)} นาที`;
    if (s < 86400) return `${Math.floor(s / 3600)} ชม.`;
    return `${Math.floor(s / 86400)} วัน`;
  };
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { hour12: false }) : '-');
  const pill = (text, kind) => h('span', { class: `pill ${kind || ''}`, text });
  const statusKind = (s) => ({ online: 'ok', degraded: 'warn', errored: 'bad', stopped: 'bad', missing: 'muted', conflict: 'bad', 'not-listening': 'warn', free: 'muted', ok: 'ok' }[s] || 'muted');
  const jobKind = (s) => ({ success: 'ok', up_to_date: 'muted', running: 'info', failed: 'bad', rolled_back: 'warn', rollback_failed: 'bad' }[s] || 'muted');

  const toast = (msg, kind = 'ok', details) => {
    const t = h('div', { class: `toast ${kind}` }, h('div', { text: msg }), details && details.length ? h('ul', {}, details.slice(0, 12).map((d) => h('li', { text: d }))) : null);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 12000 : 5000);
  };

  const api = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'center-hub' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (res.status === 401 && url !== '/api/login') { showLogin(); }
    if (!json.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { details: json.details, status: res.status, job: json.job });
    return json.data;
  };
  const agentApi = (aid, method, sub, body) => api(method, `/api/a/${encodeURIComponent(aid)}/v1/${sub}`, body);

  /** ปุ่มที่กันกดซ้ำระหว่างรอ และแจ้งผล */
  const actionButton = (label, cls, fn, { confirmText, okText } = {}) => {
    const b = h('button', { class: `btn ${cls || ''}`, type: 'button', text: label });
    b.addEventListener('click', async () => {
      if (confirmText && !window.confirm(confirmText)) return;
      b.disabled = true;
      const old = b.textContent;
      b.textContent = `${old}…`;
      try {
        const r = await fn();
        if (okText !== false) toast(typeof okText === 'function' ? okText(r) : okText || `${old} สำเร็จ`);
      } catch (e) {
        toast(e.message, 'bad', e.details);
      } finally {
        b.disabled = false;
        b.textContent = old;
      }
    });
    return b;
  };

  const section = (title, ...children) => h('section', { class: 'card' }, h('h2', { text: title }), ...children);
  const table = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', { text: x })))), h('tbody', {}, rows)));
  const emptyRow = (cols, text) => h('tr', {}, h('td', { colspan: String(cols), class: 'muted center', text }));

  const setView = (...children) => {
    fill($('#view'), ...children);
  };
  const stopTimer = () => { if (timer) clearInterval(timer); timer = null; };
  const every = (ms, fn) => { stopTimer(); timer = setInterval(() => { if (!document.hidden) fn(); }, ms); };

  // ---------- login ----------
  const showLogin = () => {
    stopTimer();
    me = null;
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#login-form [name=username]').focus();
  };
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    $('#login-error').textContent = '';
    const btn = $('button', f);
    btn.disabled = true;
    try {
      await api('POST', '/api/login', { username: f.username.value.trim(), password: f.password.value });
      f.password.value = '';
      await boot();
    } catch (err) {
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  $('#logout').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } finally { showLogin(); } });

  // ---------- ภาพรวม ----------
  const appRow = (a) => h('tr', {},
    h('td', {}, h('span', { class: 'mono', text: a.name })),
    h('td', {}, pill(STATUS_TEXT[a.status] || a.status, statusKind(a.status))),
    h('td', { text: a.instances ? `${a.online}/${a.instances} ${a.mode || ''}` : '-' }),
    h('td', { text: a.instances ? `${Math.round(a.cpu)}%` : '-' }),
    h('td', { text: a.instances ? fmtMem(a.memory) : '-' }),
    h('td', { text: a.instances ? String(a.restarts) : '-' }),
    h('td', { text: a.status === 'online' ? fmtDur(a.uptime) : '-' }));

  const overallStatus = (p) => {
    const st = p.apps.map((a) => a.status);
    if (st.every((s) => s === 'online')) return ['RUN', 'ok'];
    if (st.some((s) => s === 'online' || s === 'degraded')) return ['บางส่วน', 'warn'];
    return ['DOWN', 'bad'];
  };

  const pm2Buttons = (aid, p, after) => {
    if (!can('operator')) return [];
    const act = (action, label, cls, confirmText) => actionButton(label, `small ${cls}`, async () => {
      await agentApi(aid, 'POST', `projects/${p.id}/pm2`, { action });
      if (after) after();
    }, { confirmText, okText: `${label} ${p.name} แล้ว` });
    return [
      act('start', 'Start', 'ok'),
      act('reload', 'Reload', ''),
      act('restart', 'Restart', '', `Restart ${p.name}? (ผู้ใช้จะหลุดชั่วครู่)`),
      act('stop', 'Stop', 'danger', `หยุด ${p.name} ทั้งหมด? ผู้ใช้จะใช้งานไม่ได้จนกว่าจะ Start`),
    ];
  };

  const deployText = (d) => {
    let s = DEPLOY_MODE_TEXT[d.mode] || d.mode;
    if (d.mode === 'schedule') s += ` (${d.days.map((x) => DAYS[x]).join(',')} ${d.time})`;
    return s;
  };

  const projectCard = (agent, p) => {
    const [text, kind] = overallStatus(p);
    const g = p.git || {};
    const gitLine = g.error ? pill('git error', 'bad') : h('span', { class: 'mono small' },
      `${g.branch || '?'} @ ${g.head ? g.head.short : '-'}`,
      g.dirty ? pill('มีไฟล์แก้ค้าง', 'warn') : null,
      g.behindRemote ? pill(`ตามหลัง ${g.behindRemote} commit`, 'info') : null,
      g.branch && g.branch !== p.branch ? pill(`ไม่ใช่ ${p.branch}`, 'warn') : null);
    const d = p.deploy;
    return h('article', { class: `project ${kind}` },
      h('div', { class: 'project-head' },
        h('div', {}, h('a', { class: 'project-name', href: `#/p/${agent.id}/${p.id}`, text: p.name }), h('div', { class: 'muted small mono', text: p.id })),
        pill(text, kind)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'apps' }, h('thead', {}, h('tr', {}, ['app', 'สถานะ', 'instance', 'CPU', 'RAM', 'restart', 'uptime'].map((x) => h('th', { text: x })))), h('tbody', {}, p.apps.map(appRow)))),
      h('div', { class: 'meta' },
        h('div', {}, h('span', { class: 'label', text: 'พอร์ต' }), p.ports.length ? p.ports.map((x) => pill(String(x), 'muted mono')) : h('span', { class: 'muted', text: '-' })),
        p.health.length ? h('div', {}, h('span', { class: 'label', text: 'health' }), p.health.map((c) => pill(c.ok ? `${c.status} ${c.ms}ms` : (c.status || c.error || 'fail'), c.ok ? 'ok' : 'bad'))) : null,
        h('div', {}, h('span', { class: 'label', text: 'git' }), gitLine),
        h('div', {}, h('span', { class: 'label', text: 'deploy' }), h('span', { text: deployText(d) }), d.frozenNow ? pill('ช่วงห้าม deploy', 'warn') : null,
          d.autoPaused ? pill('auto หยุด: โค้ดล่าสุด deploy ไม่ผ่าน รอ commit ใหม่', 'bad') : null,
          d.nextRun ? h('span', { class: 'muted small', text: ` ครั้งถัดไป ${fmtTime(d.nextRun)}` }) : null),
        d.running ? h('div', {}, h('span', { class: 'label', text: 'กำลัง deploy' }), pill(d.running.step || 'เริ่ม', 'info')) : d.last ? h('div', {}, h('span', { class: 'label', text: 'ล่าสุด' }), pill(JOB_TEXT[d.last.status] || d.last.status, jobKind(d.last.status)), h('span', { class: 'muted small', text: ` ${fmtTime(d.last.at)}` })) : null),
      h('div', { class: 'actions' }, pm2Buttons(agent.id, p, refreshOverview), h('a', { class: 'btn small ghost', href: `#/p/${agent.id}/${p.id}`, text: 'จัดการ →' })));
  };

  const renderOverview = (data) => {
    const all = data.agents.flatMap((a) => (a.data ? a.data.projects : []));
    const apps = all.flatMap((p) => p.apps);
    const conflicts = data.agents.reduce((n, a) => n + (a.data ? a.data.ports.conflicts : 0), 0);
    const behind = all.filter((p) => p.git && p.git.behindRemote).length;
    const stat = (label, value, kind) => h('div', { class: `stat ${kind || ''}` }, h('div', { class: 'stat-value', text: String(value) }), h('div', { class: 'stat-label', text: label }));
    const summary = h('div', { class: 'stats' },
      stat('เครื่องออนไลน์', `${data.agents.filter((a) => a.online).length}/${data.agents.length}`, data.agents.every((a) => a.online) ? 'ok' : 'bad'),
      stat('project', all.length),
      stat('app ที่รันอยู่', `${apps.filter((a) => a.status === 'online').length}/${apps.length}`, apps.every((a) => a.status === 'online') ? 'ok' : 'warn'),
      stat('พอร์ตชนกัน', conflicts, conflicts ? 'bad' : 'ok'),
      stat('มีโค้ดใหม่รอ deploy', behind, behind ? 'info' : ''));

    const blocks = data.agents.map((a) => {
      const head = h('div', { class: 'agent-head' },
        h('h2', {}, a.name, ' ', h('span', { class: 'muted small mono', text: a.host })),
        a.online ? pill('ออนไลน์', 'ok') : pill('ติดต่อไม่ได้', 'bad'),
        a.data && a.data.agent.lb ? pill('Load Balancer', 'info') : null,
        a.data ? h('span', { class: 'muted small', text: `agent v${a.data.agent.version} · ${a.data.agent.platform} · node ${a.data.agent.node}` }) : null);
      if (!a.online) return h('section', { class: 'agent' }, head, h('p', { class: 'error-text', text: a.error }));
      const d = a.data;
      return h('section', { class: 'agent' }, head,
        d.configErrors.length ? h('div', { class: 'banner bad' }, h('b', { text: 'projects.json มีข้อผิดพลาด: ' }), h('ul', {}, d.configErrors.map((e) => h('li', { text: e })))) : null,
        d.configWarnings.length ? h('div', { class: 'banner warn' }, h('ul', {}, d.configWarnings.map((e) => h('li', { text: e })))) : null,
        d.projects.length ? h('div', { class: 'grid' }, d.projects.map((p) => projectCard(a, p))) : h('p', { class: 'muted', text: 'ยังไม่มี project — เพิ่มที่ ตั้งค่า → Project ของเครื่องนี้' }),
        d.unmanaged.length ? h('details', { class: 'unmanaged' }, h('summary', { text: `app ใน PM2 ที่ยังไม่ได้ผูกกับ project (${d.unmanaged.length})` }),
          h('table', { class: 'apps' }, h('tbody', {}, d.unmanaged.map(appRow)))) : null);
    });
    setView(h('div', { class: 'page-head' }, h('h1', { text: 'ภาพรวม' }), h('span', { class: 'muted small', text: `อัปเดต ${fmtTime(data.time)} · รีเฟรชทุก 5 วินาที` })), summary,
      data.agents.length ? blocks : section('เริ่มต้น', h('p', { text: 'ยังไม่มีเครื่อง — ไปที่ ตั้งค่า → เครื่อง (Agent) เพื่อเพิ่มเครื่องแรก' })));
  };

  const refreshOverview = async () => {
    if (location.hash && !location.hash.startsWith('#/overview')) return;
    try { lastOverview = await api('GET', '/api/overview'); renderOverview(lastOverview); } catch (e) { if (e.status !== 401) toast(e.message, 'bad'); }
  };

  const pageOverview = async () => {
    if (lastOverview) renderOverview(lastOverview); else setView(h('p', { class: 'muted', text: 'กำลังโหลด…' }));
    await refreshOverview();
    every(5000, refreshOverview);
  };

  // ---------- หน้า project ----------
  const gitGraph = (commits) => {
    const COLORS = ['#2563eb', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#dc2626'];
    const W = 14;
    const H = 30;
    let lanes = [];
    return commits.map((c) => {
      let idx = lanes.indexOf(c.hash);
      const tip = idx === -1;
      if (tip) { idx = lanes.indexOf(null); if (idx === -1) idx = lanes.length; lanes[idx] = c.hash; }
      const before = lanes.slice();
      const merging = before.map((x, i) => (x === c.hash && i !== idx ? i : -1)).filter((i) => i >= 0);
      const after = before.slice();
      merging.forEach((i) => { after[i] = null; });
      after[idx] = c.parents[0] || null;
      const parentLanes = c.parents.length ? [idx] : [];
      c.parents.slice(1).forEach((p) => {
        let j = after.indexOf(p);
        if (j === -1) { j = after.indexOf(null); if (j === -1) j = after.length; after[j] = p; }
        parentLanes.push(j);
      });
      while (after.length && after[after.length - 1] === null) after.pop();
      lanes = after;
      const width = Math.max(before.length, after.length, idx + 1) * W + 4;
      const x = (i) => i * W + W / 2 + 2;
      const g = svg('svg', { width: String(width), height: String(H), class: 'graph' });
      const line = (x1, y1, x2, y2, color) => g.append(svg('line', { x1, y1, x2, y2, stroke: color, 'stroke-width': '2' }));
      before.forEach((hash, i) => {
        if (hash === null) return;
        if (i === idx) { if (!tip) line(x(i), 0, x(idx), H / 2, COLORS[i % COLORS.length]); } else if (merging.includes(i)) line(x(i), 0, x(idx), H / 2, COLORS[i % COLORS.length]);
        else line(x(i), 0, x(i), H, COLORS[i % COLORS.length]);
      });
      parentLanes.forEach((j) => line(x(idx), H / 2, x(j), H, COLORS[j % COLORS.length]));
      g.append(svg('circle', { cx: x(idx), cy: H / 2, r: '4.5', fill: COLORS[idx % COLORS.length], stroke: '#fff', 'stroke-width': '1.5' }));
      return g;
    });
  };

  const pageProject = async (aid, pid, tab = 'overview') => {
    setView(h('p', { class: 'muted', text: 'กำลังโหลด…' }));
    const body = h('div', {});
    const headBox = h('div', {});
    const tabs = [['overview', 'สถานะ'], ['logs', 'Logs'], ['git', 'Git'], ['deploy', 'Deploy']];
    const tabBar = h('div', { class: 'tabs' }, tabs.map(([id, label]) => h('a', { href: `#/p/${aid}/${pid}/${id}`, class: id === tab ? 'active' : '', text: label })));
    setView(h('div', { class: 'page-head' }, h('a', { href: '#/overview', class: 'btn ghost small', text: '← ภาพรวม' })), headBox, tabBar, body);

    const loadHead = async () => {
      const ov = await api('GET', '/api/overview');
      const a = ov.agents.find((x) => x.id === aid);
      if (!a) throw new Error('ไม่พบเครื่อง');
      if (!a.online) throw new Error(`ติดต่อเครื่อง ${a.name} ไม่ได้: ${a.error}`);
      const p = a.data.projects.find((x) => x.id === pid);
      if (!p) throw new Error('ไม่พบ project');
      return { a, p };
    };

    let ctx;
    try { ctx = await loadHead(); } catch (e) { fill(body, h('p', { class: 'error-text', text: e.message })); return; }
    const renderHead = ({ a, p }) => {
      const [text, kind] = overallStatus(p);
      fill(headBox, h('div', { class: 'project-title' }, h('h1', { text: p.name }), pill(text, kind), h('span', { class: 'muted', text: `บน ${a.name} (${a.host})` })));
    };
    renderHead(ctx);

    if (tab === 'overview') {
      const draw = (c) => {
        renderHead(c);
        fill(body, h('div', { class: 'grid one' }, projectCard(c.a, c.p)));
      };
      draw(ctx);
      every(5000, async () => { try { draw(await loadHead()); } catch { /* แสดงค่าล่าสุดต่อ */ } });
      return;
    }
    stopTimer();

    if (tab === 'logs') {
      if (!can('operator')) { fill(body, h('p', { class: 'muted', text: 'ต้องมีสิทธิ์ operator ขึ้นไปจึงดู log ได้' })); return; }
      const appSel = h('select', {}, ctx.p.apps.map((x) => h('option', { value: x.name, text: x.name })));
      const kindSel = h('select', {}, h('option', { value: 'out', text: 'stdout' }), h('option', { value: 'err', text: 'stderr (error)' }));
      const linesSel = h('select', {}, [100, 200, 500, 1000].map((n) => h('option', { value: String(n), text: `${n} บรรทัด`, selected: n === 200 })));
      const follow = h('input', { type: 'checkbox', checked: true });
      const pre = h('pre', { class: 'log' });
      const info = h('div', { class: 'muted small' });
      const load = async () => {
        try {
          const r = await agentApi(aid, 'GET', `projects/${pid}/logs?app=${encodeURIComponent(appSel.value)}&kind=${kindSel.value}&lines=${linesSel.value}`);
          const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
          pre.textContent = r.lines.join('\n') || (r.error || '(ว่าง)');
          info.textContent = r.file ? `${r.file} · ${r.size ? fmtMem(r.size) : ''}` : '';
          if (atBottom) pre.scrollTop = pre.scrollHeight;
        } catch (e) { pre.textContent = e.message; }
      };
      [appSel, kindSel, linesSel].forEach((s) => s.addEventListener('change', () => { pre.scrollTop = pre.scrollHeight; load(); }));
      fill(body, h('div', { class: 'toolbar' }, appSel, kindSel, linesSel, h('label', { class: 'check' }, follow, 'อัปเดตอัตโนมัติ'), h('button', { class: 'btn small', type: 'button', text: 'รีเฟรช', onclick: load })), info, pre);
      await load();
      pre.scrollTop = pre.scrollHeight;
      every(3000, () => { if (follow.checked) load(); });
      return;
    }

    if (tab === 'git') {
      const statusBox = h('div', {});
      const branchBox = h('div', {});
      const logBox = h('div', {});
      const refSel = h('select', {}, h('option', { value: '--all', text: 'ทุก branch' }), h('option', { value: '', text: 'branch ปัจจุบัน' }));
      const diffPre = h('pre', { class: 'log diff hidden' });

      const loadStatus = async () => {
        const st = await agentApi(aid, 'GET', `projects/${pid}/git/status`);
        const tracked = st.files;
        const checks = new Map();
        const msg = h('input', { placeholder: 'ข้อความ commit เช่น fix: แก้การคำนวณ delay', class: 'grow' });
        const push = h('input', { type: 'checkbox', checked: true });
        const rows = tracked.map((f) => {
          const cb = h('input', { type: 'checkbox' });
          checks.set(f.file, cb);
          return h('tr', {},
            can('admin') ? h('td', {}, cb) : null,
            h('td', { class: 'mono', text: f.code }),
            h('td', { class: 'mono' }, can('operator') ? h('a', { href: '#', text: f.file, onclick: async (e) => {
              e.preventDefault();
              try { const d = await agentApi(aid, 'GET', `projects/${pid}/git/diff?file=${encodeURIComponent(f.file)}`); diffPre.textContent = d.diff || '(ไม่มี diff — ไฟล์ใหม่ที่ยังไม่ track)'; diffPre.classList.remove('hidden'); } catch (er) { toast(er.message, 'bad'); }
            } }) : f.file));
        });
        fill(statusBox, section('สถานะ',
          h('div', { class: 'meta' },
            h('div', {}, h('span', { class: 'label', text: 'branch' }), h('span', { class: 'mono', text: st.branch }), st.upstream ? h('span', { class: 'muted mono', text: ` → ${st.upstream}` }) : null),
            h('div', {}, h('span', { class: 'label', text: 'HEAD' }), h('span', { class: 'mono', text: st.head ? `${st.head.short} ${st.head.subject}` : '-' }), st.head ? h('span', { class: 'muted small', text: ` · ${st.head.author} · ${fmtTime(st.head.date)}` }) : null),
            h('div', {}, h('span', { class: 'label', text: 'remote' }), st.behindRemote ? pill(`มีใหม่ ${st.behindRemote} commit`, 'info') : pill('ล่าสุดแล้ว (ตามที่ fetch ไว้)', 'ok'), st.ahead ? pill(`ยังไม่ push ${st.ahead} commit`, 'warn') : null)),
          can('operator') ? h('div', { class: 'actions' },
            actionButton('Fetch', 'small', async () => { await agentApi(aid, 'POST', `projects/${pid}/git/fetch`); await refreshAll(); }, { okText: 'fetch แล้ว' }),
            actionButton('Pull (ff-only)', 'small', async () => { const r = await agentApi(aid, 'POST', `projects/${pid}/git/pull`); await refreshAll(); return r; }, { okText: (r) => r.note, confirmText: 'Pull โค้ดใหม่ลงเครื่อง? (ยังไม่ reload app — ใช้ Deploy ถ้าต้องการ build + reload ให้ครบ)' })) : null,
          h('h3', { text: `ไฟล์ที่เปลี่ยน (${tracked.length})` }),
          tracked.length ? table([can('admin') ? '' : null, 'สถานะ', 'ไฟล์'].filter((x) => x !== null), rows) : h('p', { class: 'muted', text: 'ไม่มีไฟล์ค้าง' }),
          diffPre,
          can('admin') && tracked.length ? h('div', { class: 'toolbar' }, msg, h('label', { class: 'check' }, push, 'push ขึ้น remote'),
            actionButton('Commit', 'primary small', async () => {
              const files = [...checks].filter(([, cb]) => cb.checked).map(([f]) => f);
              const r = await agentApi(aid, 'POST', `projects/${pid}/git/commit`, { message: msg.value, files, push: push.checked });
              await refreshAll();
              return r;
            }, { okText: (r) => `commit ${r.head ? r.head.short : ''} แล้ว${r.pushed !== null ? ' + push' : ''}` })) : null));
      };
      const loadBranches = async () => {
        const list = await agentApi(aid, 'GET', `projects/${pid}/git/branches`);
        const current = (list.find((b) => b.current) || {}).name;
        // remote ที่ชี้ branch ปัจจุบัน (เช่น origin/main ตอนอยู่ main) ไม่ต้องมีปุ่ม checkout
        const isCurrent = (b) => b.current || (b.remote && current && b.name.endsWith(`/${current}`));
        const opts = list.map((b) => h('option', { value: b.name, text: b.name }));
        fill(refSel, h('option', { value: '--all', text: 'ทุก branch' }), h('option', { value: '', text: 'branch ปัจจุบัน' }), ...opts);
        fill(branchBox, section('Branch', table(['ชื่อ', 'commit', 'วันที่', 'ข้อความ', ''], list.map((b) => h('tr', { class: b.current ? 'current' : '' },
          h('td', { class: 'mono' }, b.name, b.current ? pill('ปัจจุบัน', 'ok') : null, b.remote ? pill('remote', 'muted') : null),
          h('td', { class: 'mono', text: b.short }),
          h('td', { class: 'small', text: fmtTime(b.date) }),
          h('td', { class: 'small', text: b.subject }),
          h('td', {}, can('admin') && !isCurrent(b) ? actionButton('Checkout', 'small', async () => { await agentApi(aid, 'POST', `projects/${pid}/git/checkout`, { ref: b.name }); await refreshAll(); },
            { confirmText: `สลับเครื่องนี้ไปใช้ ${b.name}? (ต้อง Deploy/Reload เพื่อให้ app ใช้โค้ดใหม่ และ auto deploy จะไม่ทำงานจนกว่าจะกลับมา branch ที่ตั้งไว้)`, okText: `สลับเป็น ${b.name} แล้ว` }) : null))))));
      };
      const loadLog = async () => {
        const ref = refSel.value;
        const commits = await agentApi(aid, 'GET', `projects/${pid}/git/log?limit=80${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`);
        const graphs = gitGraph(commits);
        fill(logBox, section('Timeline', h('div', { class: 'toolbar' }, refSel),
          h('div', { class: 'timeline' }, commits.map((c, i) => h('div', { class: 'commit' }, graphs[i],
            h('span', { class: 'mono hash', text: c.short }),
            h('span', { class: 'subject' }, c.refs.filter(Boolean).map((r) => pill(r.replace('HEAD -> ', 'HEAD → '), r.includes('HEAD') ? 'ok' : r.includes('/') ? 'muted' : 'info')), ' ', c.subject),
            h('span', { class: 'muted small', text: `${c.author} · ${fmtTime(c.date)}` }))))));
      };
      const refreshAll = () => Promise.all([loadStatus(), loadBranches(), loadLog()]).catch((e) => toast(e.message, 'bad'));
      refSel.addEventListener('change', () => loadLog().catch((e) => toast(e.message, 'bad')));
      fill(body, statusBox, logBox, branchBox);
      await refreshAll();
      return;
    }

    if (tab === 'deploy') {
      const d = ctx.p.deploy;
      const jobBox = h('div', {});
      const histBox = h('div', {});
      const stepList = (steps) => h('ol', { class: 'steps' }, steps.map((s) => h('li', { class: s.status },
        h('div', { class: 'step-head' }, pill(s.status === 'ok' ? '✓' : s.status === 'failed' ? '✗' : '…', s.status === 'ok' ? 'ok' : s.status === 'failed' ? 'bad' : 'info'), h('b', { text: s.name }), h('span', { class: 'muted small', text: s.ms ? ` ${(s.ms / 1000).toFixed(1)} วิ` : '' })),
        s.output ? h('details', { open: s.status !== 'ok' }, h('summary', { text: 'output' }), h('pre', { class: 'log small', text: s.output })) : null)));
      let watching = null;
      const watchJob = async (id) => {
        watching = id;
        const tick = async () => {
          if (watching !== id) return;
          try {
            const j = await agentApi(aid, 'GET', `jobs/${id}`);
            fill(jobBox, section(`Deploy ${id}`, h('div', { class: 'meta' },
              h('div', {}, h('span', { class: 'label', text: 'สถานะ' }), pill(JOB_TEXT[j.status] || j.status, jobKind(j.status))),
              h('div', {}, h('span', { class: 'label', text: 'commit' }), h('span', { class: 'mono', text: `${(j.from || '').slice(0, 7)} → ${(j.to || '…').slice(0, 7)}` })),
              j.error ? h('div', { class: 'error-text', text: j.error }) : null), stepList(j.steps)));
            if (j.status === 'running') setTimeout(tick, 1500); else loadHist();
          } catch (e) { toast(e.message, 'bad'); }
        };
        tick();
      };
      const loadHist = async () => {
        const list = await agentApi(aid, 'GET', `projects/${pid}/deploys?limit=30`);
        fill(histBox, section('ประวัติ deploy', table(['เริ่ม', 'สั่งโดย', 'commit', 'สถานะ', 'ใช้เวลา', ''], list.length ? list.map((j) => h('tr', {},
          h('td', { class: 'small', text: fmtTime(j.startedAt) }),
          h('td', { text: `${j.user || j.trigger}${j.force ? ' (force)' : ''}` }),
          h('td', { class: 'mono', text: `${(j.from || '').slice(0, 7)} → ${(j.to || '').slice(0, 7)}` }),
          h('td', {}, pill(JOB_TEXT[j.status] || j.status, jobKind(j.status)), j.error ? h('div', { class: 'small error-text', text: j.error.slice(0, 160) }) : null),
          h('td', { text: j.finishedAt ? fmtDur(new Date(j.finishedAt) - new Date(j.startedAt)) : '-' }),
          h('td', {}, h('button', { class: 'btn small ghost', type: 'button', text: 'ดูขั้นตอน', onclick: () => watchJob(j.id) })))) : [emptyRow(6, 'ยังไม่เคย deploy')])));
      };
      const start = (opts, label, confirmText) => actionButton(label, opts.force ? 'danger small' : 'primary small', async () => {
        try {
          const r = await agentApi(aid, 'POST', `projects/${pid}/deploy`, opts);
          watchJob(r.job);
        } catch (e) { if (e.job) watchJob(e.job); throw e; }
      }, { confirmText, okText: 'เริ่ม deploy แล้ว' });
      fill(body, section('ตั้งค่า deploy ของ project นี้',
        h('div', { class: 'meta' },
          h('div', {}, h('span', { class: 'label', text: 'โหมด' }), h('span', { text: deployText(d) })),
          h('div', {}, h('span', { class: 'label', text: 'ครั้งถัดไป' }), h('span', { text: d.nextRun ? fmtTime(d.nextRun) : '-' })),
          h('div', {}, h('span', { class: 'label', text: 'ห้าม deploy' }), d.freeze.length ? d.freeze.map((f) => pill(`${f.days.map((x) => DAYS[x]).join(',')} ${f.from}-${f.to}`, 'warn')) : h('span', { class: 'muted', text: 'ไม่มี' }), d.frozenNow ? pill('ตอนนี้อยู่ในช่วงห้าม', 'bad') : null)),
        h('p', { class: 'muted small', text: 'ขั้นตอน: ตรวจไฟล์ค้าง/พอร์ต → git fetch → pull --ff-only → npm ci (เมื่อ lockfile เปลี่ยน) → build → test → pm2 reload → ตรวจ health 3 รอบ → ถ้าพังจะ rollback กลับ commit เดิมอัตโนมัติ (แก้ค่าที่ ตั้งค่า → Project)' }),
        can('operator') ? h('div', { class: 'actions' },
          start({}, 'Deploy (pull + build + reload)', `Deploy ${ctx.p.name} บน ${ctx.a.name} ตอนนี้?`),
          can('admin') ? start({ force: true }, 'Force deploy (ข้ามช่วงห้าม/เช็กพอร์ต)', 'Force deploy จะข้ามช่วงห้าม deploy และการเช็กพอร์ต — ยืนยัน?') : null,
          can('admin') ? start({ force: true, redeploy: true }, 'Rebuild + reload (แม้ไม่มีโค้ดใหม่)', 'build ใหม่และ reload ทั้งที่ไม่มีโค้ดใหม่? (ติดตั้ง dependency ใหม่ทั้งหมดด้วย)') : null) : null),
      jobBox, histBox);
      if (d.running) watchJob(d.running.id);
      await loadHist();
    }
  };

  // ---------- พอร์ต ----------
  const pagePorts = async () => {
    stopTimer();
    setView(h('p', { class: 'muted', text: 'กำลังตรวจพอร์ตทุกเครื่อง…' }));
    const list = await api('GET', '/api/agents');
    const blocks = await Promise.all(list.map(async (a) => {
      try {
        const r = await agentApi(a.id, 'GET', 'ports');
        return section(`${a.name} (${a.host})`,
          table(['พอร์ต', 'project', 'สถานะ', 'รายละเอียด', 'ผู้ใช้พอร์ตจริง'], r.rows.length ? r.rows.map((x) => h('tr', {},
            h('td', { class: 'mono', text: String(x.port) }),
            h('td', { text: x.projects.join(', ') }),
            h('td', {}, pill({ ok: 'ใช้งานปกติ', conflict: 'ชนกัน', 'not-listening': 'ไม่ได้เปิด', free: 'ว่าง' }[x.state] || x.state, statusKind(x.state))),
            h('td', { class: 'small', text: x.note }),
            h('td', { class: 'small mono', text: x.holders.map((o) => `${o.app || o.process || '?'} (pid ${o.pid})`).join(', ') || '-' }))) : [emptyRow(5, 'ยังไม่มี project ที่ประกาศพอร์ต')]),
          r.undeclared.length ? h('div', { class: 'banner warn' }, h('b', { text: 'พอร์ตที่ app ใน PM2 เปิดอยู่แต่ไม่ได้ประกาศใน projects.json: ' }), r.undeclared.map((u) => pill(`${u.port} ← ${u.app}`, 'warn mono'))) : null,
          h('details', {}, h('summary', { text: `พอร์ตที่เปิดฟังทั้งหมดบนเครื่อง (${r.listeners.length})` }),
            table(['พอร์ต', 'pid', 'โปรแกรม', 'address'], r.listeners.map((l) => h('tr', {}, h('td', { class: 'mono', text: String(l.port) }), h('td', { class: 'mono', text: String(l.pid || '-') }), h('td', { text: l.process || '-' }), h('td', { class: 'mono small', text: l.addresses.join(' ') }))))));
      } catch (e) {
        return section(`${a.name} (${a.host})`, h('p', { class: 'error-text', text: e.message }));
      }
    }));
    setView(h('div', { class: 'page-head' }, h('h1', { text: 'ตรวจพอร์ต' }), h('button', { class: 'btn small', type: 'button', text: 'ตรวจใหม่', onclick: pagePorts })),
      h('p', { class: 'muted small', text: 'เทียบพอร์ตที่ประกาศใน projects.json กับพอร์ตที่เปิดจริง (netstat) — แจ้งเมื่อประกาศซ้ำ, ถูกโปรแกรมอื่นยึด, ชนพอร์ตสงวน (SQL 1433, Redis 6379, RDP 3389 …) หรือ app online แต่ไม่ได้เปิดพอร์ต' }),
      list.length ? blocks : h('p', { class: 'muted', text: 'ยังไม่มีเครื่อง' }));
  };

  // ---------- Load balancer ----------
  const pageLb = async () => {
    stopTimer();
    const [lb, list, ov] = await Promise.all([api('GET', '/api/lb'), api('GET', '/api/agents'), api('GET', '/api/overview')]);
    const state = JSON.parse(JSON.stringify(lb));
    const edit = can('admin');
    const preview = h('pre', { class: 'log hidden' });
    const sitesBox = h('div', {});
    const statusBox = h('div', {});

    const projectsOn = new Map(); // project id → [{agentId, ports}]
    ov.agents.forEach((a) => (a.data ? a.data.projects : []).forEach((p) => {
      if (!projectsOn.has(p.id)) projectsOn.set(p.id, { name: p.name, on: [] });
      projectsOn.get(p.id).on.push({ agentId: a.id, ports: p.ports });
    }));

    const input = (obj, key, attrs = {}) => {
      const el = h('input', { value: obj[key] === undefined ? '' : String(obj[key]), disabled: !edit, ...attrs });
      el.addEventListener('input', () => { obj[key] = attrs.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value; });
      return el;
    };
    const checkbox = (obj, key) => { const el = h('input', { type: 'checkbox', checked: Boolean(obj[key]), disabled: !edit }); el.addEventListener('change', () => { obj[key] = el.checked; }); return el; };

    const drawSites = () => {
      fill(sitesBox, ...state.sites.map((s, si) => {
        const sticky = h('select', { disabled: !edit }, h('option', { value: 'ip_hash', text: 'ip_hash (ติดเครื่องเดิม — ใช้กับ Socket.IO)', selected: s.sticky !== 'none' }), h('option', { value: 'none', text: 'สลับเครื่อง (round robin)', selected: s.sticky === 'none' }));
        sticky.addEventListener('change', () => { s.sticky = sticky.value; });
        return h('div', { class: 'card site' },
          h('div', { class: 'form-row' },
            h('label', {}, 'ชื่อ', input(s, 'name', { placeholder: 'delayhub' })),
            h('label', {}, 'LB ฟังที่พอร์ต', input(s, 'listen', { type: 'number', min: '1', max: '65535' })),
            h('label', {}, 'server_name (ไม่บังคับ)', input(s, 'serverName', { placeholder: 'delayhub.local' })),
            h('label', {}, 'การกระจาย', sticky),
            edit ? h('button', { class: 'btn danger small', type: 'button', text: 'ลบ site', onclick: () => { state.sites.splice(si, 1); drawSites(); } }) : null),
          table(['เครื่อง', 'host', 'พอร์ต', 'น้ำหนัก', 'backup', 'ปิดชั่วคราว (drain)', ''], s.upstreams.map((u, ui) => {
            const agentSel = h('select', { disabled: !edit }, h('option', { value: '', text: '(กรอก host เอง)' }), list.map((a) => h('option', { value: a.id, text: a.name, selected: a.id === u.agentId })));
            agentSel.addEventListener('change', () => { u.agentId = agentSel.value || null; });
            return h('tr', {}, h('td', {}, agentSel), h('td', {}, input(u, 'host', { placeholder: 'ใช้ host ของเครื่อง' })), h('td', {}, input(u, 'port', { type: 'number' })), h('td', {}, input(u, 'weight', { type: 'number', min: '1', max: '100' })),
              h('td', {}, checkbox(u, 'backup')), h('td', {}, checkbox(u, 'down')),
              h('td', {}, edit ? h('button', { class: 'btn ghost small', type: 'button', text: 'ลบ', onclick: () => { s.upstreams.splice(ui, 1); drawSites(); } }) : null));
          })),
          edit ? h('button', { class: 'btn ghost small', type: 'button', text: '+ เพิ่มเครื่องปลายทาง', onclick: () => { s.upstreams.push({ agentId: list[0] ? list[0].id : null, port: s.upstreams[0] ? s.upstreams[0].port : 80, weight: 1 }); drawSites(); } }) : null);
      }));
    };

    const lbSel = h('select', { disabled: !edit }, h('option', { value: '', text: '(ยังไม่เลือก)' }), list.map((a) => h('option', { value: a.id, text: `${a.name} (${a.host})`, selected: a.id === state.agentId })));
    lbSel.addEventListener('change', () => { state.agentId = lbSel.value || null; loadStatus(); });
    const fromProject = h('select', {}, h('option', { value: '', text: 'เลือก project…' }), [...projectsOn].map(([id, v]) => h('option', { value: id, text: `${v.name} (${v.on.length} เครื่อง)` })));
    const addFromProject = () => {
      const v = projectsOn.get(fromProject.value);
      if (!v) return;
      const port = (v.on.find((o) => o.ports.length) || { ports: [80] }).ports[0];
      state.sites.push({ name: fromProject.value, listen: port, sticky: 'ip_hash', upstreams: v.on.map((o) => ({ agentId: o.agentId, port: o.ports[0] || port, weight: 1 })) });
      drawSites();
    };

    const loadStatus = async () => {
      if (!state.agentId || !can('admin')) { fill(statusBox); return; }
      try {
        const s = await agentApi(state.agentId, 'GET', 'nginx');
        fill(statusBox, h('div', { class: `banner ${s.testOk ? 'ok' : 'bad'}` }, h('b', { text: `nginx บนเครื่อง LB: ${s.testOk ? 'config ผ่าน' : 'config มีปัญหา'}` }), h('div', { class: 'mono small', text: `${s.confFile}` }),
          h('details', {}, h('summary', { text: 'ไฟล์ปัจจุบัน / ผล nginx -t' }), h('pre', { class: 'log small', text: `${s.test}\n\n${s.current || '(ยังไม่มีไฟล์)'}` }))));
      } catch (e) { fill(statusBox, h('div', { class: 'banner warn', text: e.message })); }
    };

    drawSites();
    setView(h('div', { class: 'page-head' }, h('h1', { text: 'Load Balancer (nginx)' })),
      h('p', { class: 'muted small', text: 'ตั้งค่าครั้งเดียวที่นี่ Hub จะสร้าง config nginx ให้ทุก project แล้วส่งไปติดตั้งที่เครื่อง LB (nginx -t ก่อน reload; ไม่ผ่านจะคืนไฟล์เดิม) — ใช้ ip_hash กับระบบที่มี Socket.IO/session เช่น DelayHUB; ติ๊ก "ปิดชั่วคราว" เพื่อถอดเครื่องออกก่อน deploy/ซ่อม' }),
      section('เครื่องที่เป็น Load Balancer', h('div', { class: 'toolbar' }, lbSel), statusBox),
      section('Site', edit ? h('div', { class: 'toolbar' }, fromProject, h('button', { class: 'btn small', type: 'button', text: 'สร้างจาก project', onclick: addFromProject }),
        h('button', { class: 'btn ghost small', type: 'button', text: '+ site เปล่า', onclick: () => { state.sites.push({ name: '', listen: 8080, sticky: 'ip_hash', upstreams: [] }); drawSites(); } })) : null, sitesBox),
      edit ? h('div', { class: 'actions sticky-actions' },
        actionButton('บันทึก', 'primary', async () => { const r = await api('PUT', '/api/lb', state); Object.assign(state, r); drawSites(); }, { okText: 'บันทึกแล้ว (ยังไม่ติดตั้ง)' }),
        actionButton('ดูตัวอย่าง config', '', async () => { const r = await api('POST', '/api/lb/preview', state); preview.textContent = r.config; preview.classList.remove('hidden'); }, { okText: false }),
        actionButton('บันทึก + ติดตั้งที่เครื่อง LB', 'danger', async () => { await api('PUT', '/api/lb', state); const r = await api('POST', '/api/lb/apply'); await loadStatus(); return r; }, { confirmText: 'ติดตั้ง config ใหม่และ reload nginx บนเครื่อง LB?', okText: 'ติดตั้งและ reload nginx แล้ว' })) : null,
      preview);
    loadStatus();
  };

  // ---------- ตั้งค่า ----------
  const PROJECT_TEMPLATE = {
    id: 'delayhub', name: 'DelayHUB', repoDir: 'I:\\test\\DelayHUB', branch: 'main', remote: 'origin', ecosystem: 'backend/ecosystem.config.js',
    apps: ['PFCMv2-backend', 'PFCMv2-frontend'], singleton: [], ports: [3000, 80],
    health: [{ url: 'http://127.0.0.1:3000/health' }, { url: 'http://127.0.0.1:80/' }],
    deploy: {
      mode: 'schedule', days: [0], time: '03:00', freeze: [{ days: [1, 2, 3, 4, 5, 6], from: '07:00', to: '20:00' }],
      install: [{ cwd: 'backend', cmd: ['npm', 'ci', '--omit=dev'] }, { cwd: 'frontend', cmd: ['npm', 'ci'] }],
      build: [{ cwd: 'frontend', cmd: ['npm', 'run', 'build'] }], test: [], restorePaths: [], reload: 'reload', rollback: true, healthTimeoutSec: 90,
    },
  };

  const pageSettings = async () => {
    stopTimer();
    const parts = [h('div', { class: 'page-head' }, h('h1', { text: 'ตั้งค่า' }))];

    // เปลี่ยนรหัสตัวเอง
    const cur = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'รหัสเดิม' });
    const nw = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'รหัสใหม่ (≥10 ตัว ตัวอักษร+ตัวเลข)' });
    parts.push(section('รหัสผ่านของฉัน', h('div', { class: 'toolbar' }, cur, nw, actionButton('เปลี่ยนรหัส', 'small', async () => { const r = await api('POST', '/api/me/password', { current: cur.value, password: nw.value }); showLogin(); return r; }, { okText: (r) => r.note }))));

    if (!can('admin')) { setView(...parts, h('p', { class: 'muted', text: 'ส่วนอื่นของหน้านี้สำหรับ admin เท่านั้น' })); return; }
    const [agentList, users] = await Promise.all([api('GET', '/api/agents'), api('GET', '/api/users')]);

    // เครื่อง
    const af = { id: '', name: '', url: '', host: '', secret: '' };
    const field = (obj, key, attrs) => { const el = h('input', { ...attrs }); el.addEventListener('input', () => { obj[key] = el.value; }); return el; };
    parts.push(section('เครื่อง (Agent)',
      table(['id', 'ชื่อ', 'URL ของ Agent', 'host (ใช้ใน LB)', ''], agentList.length ? agentList.map((a) => h('tr', {},
        h('td', { class: 'mono', text: a.id }), h('td', { text: a.name }), h('td', { class: 'mono', text: a.url }), h('td', { class: 'mono', text: a.host }),
        h('td', {}, actionButton('ลบ', 'ghost small', async () => { await api('DELETE', `/api/agents/${encodeURIComponent(a.id)}`); pageSettings(); }, { confirmText: `ลบเครื่อง ${a.name} ออกจาก Hub? (ไม่กระทบ app บนเครื่อง)` })))) : [emptyRow(5, 'ยังไม่มีเครื่อง')]),
      h('h3', { text: 'เพิ่ม/แก้เครื่อง' }),
      h('div', { class: 'form-row' },
        h('label', {}, 'id', field(af, 'id', { placeholder: 'srv116' })),
        h('label', {}, 'ชื่อ', field(af, 'name', { placeholder: 'App Server 116' })),
        h('label', {}, 'URL', field(af, 'url', { placeholder: 'http://172.48.0.116:4910' })),
        h('label', {}, 'host (ไม่บังคับ)', field(af, 'host', { placeholder: '172.48.0.116' })),
        h('label', {}, 'ความลับ (CENTER_AGENT_SECRET)', field(af, 'secret', { type: 'password', autocomplete: 'off', placeholder: 'เว้นว่าง = ใช้ค่าเดิม' }))),
      actionButton('บันทึกเครื่อง', 'primary small', async () => { await api('POST', '/api/agents', af); pageSettings(); }, { okText: 'บันทึกเครื่องแล้ว' })));

    // project ของแต่ละเครื่อง
    const agentSel = h('select', {}, agentList.map((a) => h('option', { value: a.id, text: `${a.name} (${a.id})` })));
    const editor = h('textarea', { class: 'code', spellcheck: false, rows: '24' });
    const msgBox = h('div', {});
    const hint = h('div', { class: 'muted small' });
    const showResult = (r, ok) => {
      fill(msgBox, 
        r.errors && r.errors.length ? h('div', { class: 'banner bad' }, h('b', { text: 'ข้อผิดพลาด' }), h('ul', {}, r.errors.map((e) => h('li', { text: e })))) : null,
        r.warnings && r.warnings.length ? h('div', { class: 'banner warn' }, h('ul', {}, r.warnings.map((e) => h('li', { text: e })))) : null,
        ok && (!r.errors || !r.errors.length) ? h('div', { class: 'banner ok', text: ok }) : null);
    };
    const loadProjects = async () => {
      if (!agentSel.value) return;
      try {
        const r = await agentApi(agentSel.value, 'GET', 'config/projects');
        editor.value = JSON.stringify(r.projects, null, 2);
        hint.textContent = `คำสั่งที่อนุญาตใน install/build/test: ${r.allowedCommands.join(', ')} · พอร์ตสงวน: ${r.reservedPorts.join(', ')}`;
        showResult(r);
      } catch (e) { editor.value = ''; showResult({ errors: [e.message] }); }
    };
    const parseEditor = () => { try { return JSON.parse(editor.value || '[]'); } catch (e) { throw new Error(`JSON ไม่ถูกต้อง: ${e.message}`); } };
    agentSel.addEventListener('change', loadProjects);
    parts.push(section('Project ของแต่ละเครื่อง (projects.json)',
      h('p', { class: 'muted small', text: 'แต่ละ project: id, repoDir (path บนเครื่องนั้น), branch, ecosystem (path ในrepo), apps (ชื่อใน PM2), ports, health, deploy.mode = manual | notify | schedule | immediate, days (0=อาทิตย์), time, freeze (ช่วงห้าม deploy), install/build/test, reload = reload | restart, singleton (app ที่ต้องมีตัวเดียว เช่น RFID ใช้ restart แทน reload)' }),
      h('div', { class: 'toolbar' }, agentSel, h('button', { class: 'btn small ghost', type: 'button', text: 'โหลดใหม่', onclick: loadProjects }),
        h('button', { class: 'btn small ghost', type: 'button', text: '+ ใส่ตัวอย่าง project', onclick: () => { try { const list = parseEditor(); list.push(PROJECT_TEMPLATE); editor.value = JSON.stringify(list, null, 2); } catch (e) { toast(e.message, 'bad'); } } })),
      hint, editor, msgBox,
      h('div', { class: 'actions' },
        actionButton('ตรวจสอบ', 'small', async () => { const r = await agentApi(agentSel.value, 'POST', 'config/projects/validate', { projects: parseEditor() }); showResult(r, 'ผ่านการตรวจ'); }, { okText: false }),
        actionButton('บันทึกลงเครื่อง', 'primary small', async () => {
          try { const r = await agentApi(agentSel.value, 'PUT', 'config/projects', { projects: parseEditor() }); showResult(r, 'บันทึกแล้ว (มีไฟล์สำรอง projects.json.bak)'); } catch (e) { showResult({ errors: e.details || [e.message] }); throw e; }
        }, { okText: 'บันทึก projects.json แล้ว' }))));

    // ผู้ใช้
    const uf = { username: '', password: '', role: 'viewer' };
    const roleSel = h('select', {}, ROLES.map((r) => h('option', { value: r, text: r })));
    roleSel.addEventListener('change', () => { uf.role = roleSel.value; });
    parts.push(section('ผู้ใช้',
      table(['ชื่อ', 'สิทธิ์', 'สถานะ', 'สร้างเมื่อ', ''], users.map((u) => h('tr', {},
        h('td', { text: u.username }), h('td', {}, pill(u.role, u.role === 'admin' ? 'bad' : u.role === 'operator' ? 'warn' : 'muted')),
        h('td', {}, u.disabled ? pill('ปิดใช้งาน', 'muted') : pill('ใช้งาน', 'ok')), h('td', { class: 'small', text: fmtTime(u.createdAt) }),
        h('td', {}, u.username === me.username ? null : [
          actionButton(u.disabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน', 'ghost small', async () => { await api('POST', '/api/users', { username: u.username, disabled: !u.disabled }); pageSettings(); }),
          actionButton('ลบ', 'ghost small', async () => { await api('DELETE', `/api/users/${encodeURIComponent(u.username)}`); pageSettings(); }, { confirmText: `ลบผู้ใช้ ${u.username}?` })])))),
      h('h3', { text: 'เพิ่มผู้ใช้ / เปลี่ยนสิทธิ์ / รีเซ็ตรหัส' }),
      h('div', { class: 'form-row' },
        h('label', {}, 'ชื่อผู้ใช้', field(uf, 'username', { autocomplete: 'off' })),
        h('label', {}, 'รหัสผ่าน (เว้นว่าง = ไม่เปลี่ยน)', field(uf, 'password', { type: 'password', autocomplete: 'new-password' })),
        h('label', {}, 'สิทธิ์', roleSel)),
      h('p', { class: 'muted small', text: 'viewer = ดูอย่างเดียว · operator = start/stop/reload, pull, deploy ปกติ, ดู log · admin = ทุกอย่าง รวม commit/checkout, force deploy, Load Balancer, ตั้งค่า, ผู้ใช้' }),
      actionButton('บันทึกผู้ใช้', 'primary small', async () => { await api('POST', '/api/users', uf); pageSettings(); }, { okText: 'บันทึกผู้ใช้แล้ว' })));

    setView(...parts);
    if (agentList.length) loadProjects();
  };

  // ---------- audit ----------
  const pageAudit = async () => {
    stopTimer();
    const q = h('input', { placeholder: 'ค้นหา (ชื่อผู้ใช้, project, action…)', class: 'grow' });
    const box = h('div', {});
    const load = async () => {
      const list = await api('GET', `/api/audit?limit=300&q=${encodeURIComponent(q.value)}`);
      fill(box, table(['เวลา', 'ผู้ใช้', 'IP', 'เครื่อง', 'การกระทำ', 'ข้อมูล', 'ผล'], list.length ? list.map((e) => h('tr', {},
        h('td', { class: 'small', text: fmtTime(e.ts) }), h('td', { text: e.user || '-' }), h('td', { class: 'mono small', text: e.ip || '' }), h('td', { text: e.agent || '' }),
        h('td', { class: 'mono small', text: e.action }), h('td', { class: 'mono small', text: e.input ? JSON.stringify(e.input) : '' }),
        h('td', {}, pill(e.result, e.result === 'ok' ? 'ok' : 'bad'), e.error ? h('div', { class: 'small error-text', text: e.error }) : null))) : [emptyRow(7, 'ไม่มีรายการ')]));
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
    setView(h('div', { class: 'page-head' }, h('h1', { text: 'ประวัติการสั่งงาน' })), h('div', { class: 'toolbar' }, q, h('button', { class: 'btn small', type: 'button', text: 'ค้นหา', onclick: load })), box);
    await load();
  };

  // ---------- router ----------
  const route = async () => {
    if (!me) return;
    const parts = (location.hash || '#/overview').slice(2).split('/');
    const page = parts[0] || 'overview';
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page || (page === 'p' && a.dataset.page === 'overview')));
    try {
      if (page === 'p') await pageProject(decodeURIComponent(parts[1] || ''), decodeURIComponent(parts[2] || ''), parts[3] || 'overview');
      else if (page === 'ports') await pagePorts();
      else if (page === 'lb') await pageLb();
      else if (page === 'settings') await pageSettings();
      else if (page === 'audit' && can('admin')) await pageAudit();
      else await pageOverview();
    } catch (e) {
      if (e.status !== 401) setView(h('p', { class: 'error-text', text: e.message }));
    }
  };
  window.addEventListener('hashchange', route);

  const boot = async () => {
    try { me = await api('GET', '/api/me'); } catch { me = null; }
    if (!me) { showLogin(); return; }
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#me-name').textContent = me.username;
    $('#me-role').textContent = me.role;
    document.querySelectorAll('[data-role]').forEach((el) => el.classList.toggle('hidden', !can(el.dataset.role)));
    route();
  };
  boot();
})();
