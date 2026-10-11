'use strict';
// คำสั่ง git สำหรับ project — ทุก argument ผ่านการตรวจ และส่งแบบไม่ผ่าน shell
const path = require('path');
const { run } = require('./exec');
const { REF_RE } = require('./config');

const SEP = '\x1f';
// ไฟล์ที่ห้าม commit/ดู diff ผ่าน Hub
const DENY_RE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|pfx|p12)|.*\.log|node_modules|dist|logs)([\\/]|$)/i;

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

const git = async (project, args, opts = {}) => {
  const r = await run('git', ['-c', 'core.quotepath=off', ...args], { cwd: project.repoDir, timeoutMs: opts.timeoutMs || 2 * 60 * 1000 });
  if (r.code !== 0 && !opts.allowFail) {
    throw fail(`git ${args[0]} ไม่สำเร็จ: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`, 409);
  }
  return r;
};

const checkRef = (ref) => { if (typeof ref !== 'string' || !REF_RE.test(ref)) throw fail('ชื่อ branch/ref ไม่ถูกต้อง'); return ref; };

const parseStatus = (text) => {
  const lines = text.split('\n').filter(Boolean);
  const head = lines[0] && lines[0].startsWith('## ') ? lines.shift().slice(3) : '';
  const m = /^(?:No commits yet on )?([^.\s]+(?:\.(?!\.)[^.\s]*)*)(?:\.\.\.(\S+))?(?: \[(.*)\])?/.exec(head) || [];
  const track = m[3] || '';
  const ahead = Number((/ahead (\d+)/.exec(track) || [])[1] || 0);
  const behind = Number((/behind (\d+)/.exec(track) || [])[1] || 0);
  const files = lines.map((l) => {
    const code = l.slice(0, 2);
    let file = l.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1);
    return { code, file, untracked: code === '??' };
  });
  return { branch: m[1] || head, upstream: m[2] || null, ahead, behind, files, dirty: files.some((f) => !f.untracked) };
};

const status = async (project) => parseStatus((await git(project, ['status', '--porcelain=v1', '-b'])).stdout);

const head = async (project) => {
  const r = await git(project, ['log', '-1', `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%cI`], { allowFail: true });
  if (r.code !== 0) return null;
  const [hash, short, subject, author, date] = r.stdout.trim().split(SEP);
  return { hash, short, subject, author, date };
};

/** จำนวน commit ที่ remote มีแต่เครื่องยังไม่มี (ต้อง fetch ก่อนถึงจะสด) */
const behindCount = async (project) => {
  const r = await git(project, ['rev-list', '--count', `HEAD..${project.remote}/${project.branch}`], { allowFail: true });
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : null;
};

const remoteHead = async (project) => {
  const r = await git(project, ['rev-parse', `${project.remote}/${project.branch}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
};

const fetch = (project) => git(project, ['fetch', '--prune', project.remote], { timeoutMs: 3 * 60 * 1000 });

/** timeline — คืน commit พร้อม parent (วาดกราฟได้) และ ref ที่ชี้อยู่ */
const log = async (project, { ref, limit = 50 } = {}) => {
  const n = Math.min(300, Math.max(1, Number(limit) || 50));
  const args = ['log', `-n${n}`, '--date-order', `--format=%H${SEP}%h${SEP}%P${SEP}%an${SEP}%cI${SEP}%D${SEP}%s`];
  if (ref === '--all') args.push('--all');
  else if (ref) args.push(checkRef(ref));
  const r = await git(project, args);
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, short, parents, author, date, refs, subject] = l.split(SEP);
    return { hash, short, parents: parents ? parents.split(' ') : [], author, date, refs: refs ? refs.split(', ') : [], subject };
  });
};

const branches = async (project) => {
  const r = await git(project, ['for-each-ref', `--format=%(refname)${SEP}%(refname:short)${SEP}%(objectname:short)${SEP}%(committerdate:iso-strict)${SEP}%(upstream:short)${SEP}%(HEAD)${SEP}%(subject)`, 'refs/heads', 'refs/remotes']);
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [full, name, short, date, upstream, current, subject] = l.split(SEP);
    return { full, name, remote: full.startsWith('refs/remotes/'), short, date, upstream: upstream || null, current: current === '*', subject };
  }).filter((b) => !b.full.endsWith('/HEAD')).map((b) => { delete b.full; return b; });
};

const diff = async (project, { file } = {}) => {
  if (file !== undefined) {
    if (typeof file !== 'string' || file.startsWith('-') || DENY_RE.test(file)) throw fail('ไฟล์นี้ดู diff ผ่าน Hub ไม่ได้');
    const r = await git(project, ['diff', 'HEAD', '--', file]);
    return { file, diff: r.stdout.slice(0, 200 * 1024) };
  }
  const r = await git(project, ['diff', 'HEAD', '--stat']);
  return { stat: r.stdout };
};

/** pull แบบ fast-forward เท่านั้น (ไม่สร้าง merge commit บนเครื่อง production) */
const pull = async (project) => {
  const st = await status(project);
  if (st.branch !== project.branch) throw fail(`ตอนนี้อยู่ branch ${st.branch} ไม่ใช่ ${project.branch} — สลับ branch ก่อน`, 409);
  if (st.dirty) throw fail('มีไฟล์แก้ไขค้างบนเครื่อง — commit หรือเก็บก่อน pull', 409);
  const r = await git(project, ['pull', '--ff-only', project.remote, project.branch], { timeoutMs: 3 * 60 * 1000 });
  return { output: (r.stdout + r.stderr).trim(), head: await head(project) };
};

const checkout = async (project, ref) => {
  checkRef(ref);
  const st = await status(project);
  if (st.dirty) throw fail('มีไฟล์แก้ไขค้าง — สลับ branch ไม่ได้', 409);
  const local = ref.startsWith(`${project.remote}/`) ? ref.slice(project.remote.length + 1) : ref;
  const r = await git(project, ['checkout', local]);
  return { output: (r.stdout + r.stderr).trim(), status: await status(project) };
};

/** commit เฉพาะไฟล์ที่เลือก (ห้าม add ทั้งหมด) แล้ว push ถ้าขอ */
const commit = async (project, { message, files, push, author }) => {
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) throw fail('ต้องใส่ข้อความ commit (ไม่เกิน 2000 ตัว)');
  if (!Array.isArray(files) || !files.length || files.length > 200) throw fail('เลือกไฟล์ที่จะ commit (1-200 ไฟล์)');
  const st = await status(project);
  const changed = new Set(st.files.map((f) => f.file));
  for (const f of files) {
    if (typeof f !== 'string' || !changed.has(f)) throw fail(`ไฟล์ ${f} ไม่มีการเปลี่ยนแปลง`);
    if (f.startsWith('-') || path.isAbsolute(f) || f.includes('..')) throw fail(`ชื่อไฟล์ไม่ถูกต้อง: ${f}`);
    if (DENY_RE.test(f)) throw fail(`ห้าม commit ไฟล์ ${f} ผ่าน Hub (.env, key, node_modules, dist, logs)`);
  }
  await git(project, ['add', '--', ...files]);
  const trailer = author ? `\n\nCommitted-via: Center_HUB (${String(author).replace(/[^\w.@-]/g, '')})` : '';
  const r = await git(project, ['commit', '-m', message.trim() + trailer, '--', ...files]);
  let pushed = null;
  if (push) {
    const p = await git(project, ['push', project.remote, `HEAD:${project.branch}`], { timeoutMs: 3 * 60 * 1000 });
    pushed = (p.stdout + p.stderr).trim();
  }
  return { output: (r.stdout + r.stderr).trim(), pushed, head: await head(project) };
};

const changedFiles = async (project, from, to) => {
  const r = await git(project, ['diff', '--name-only', from, to], { allowFail: true });
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : null;
};

module.exports = { git, status, parseStatus, head, behindCount, remoteHead, fetch, log, branches, diff, pull, checkout, commit, changedFiles, DENY_RE };
