'use strict';
// ตารางเวลา auto deploy (เวลาเครื่อง) — ฟังก์ชันล้วน ทดสอบได้โดยไม่ต้องมี git/PM2
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** อยู่ในช่วงห้าม deploy หรือไม่ — รองรับช่วงข้ามเที่ยงคืน เช่น 22:00-06:00 (นับวันตามเวลาเริ่ม) */
const inFreeze = (freeze, now = new Date()) => {
  const cur = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  const yesterday = (day + 6) % 7;
  return (freeze || []).some((f) => {
    const from = toMin(f.from);
    const to = toMin(f.to);
    if (from <= to) return f.days.includes(day) && cur >= from && cur < to;
    return (f.days.includes(day) && cur >= from) || (f.days.includes(yesterday) && cur < to);
  });
};

/**
 * ถึงรอบ deploy ตามตารางหรือยัง — คืน slot key (เช่น "2026-10-11 03:00") ถ้าถึง, null ถ้ายัง
 * เผื่อช่วงเวลา windowMin นาที (เผื่อ Agent ปิดอยู่ตอนถึงเวลาพอดี) และไม่ซ้ำ slot ที่ทำไปแล้ว
 */
const dueSlot = (deploy, now = new Date(), lastSlot = null, windowMin = 60) => {
  if (deploy.mode !== 'schedule') return null;
  if (!deploy.days.includes(now.getDay())) return null;
  const cur = now.getHours() * 60 + now.getMinutes();
  const at = toMin(deploy.time);
  if (cur < at || cur >= at + windowMin) return null;
  const slot = `${dayKey(now)} ${deploy.time}`;
  return slot === lastSlot ? null : slot;
};

/** เวลา deploy ตามตารางครั้งถัดไป (ไว้แสดงบนหน้าจอ) */
const nextRun = (deploy, now = new Date()) => {
  if (deploy.mode !== 'schedule' || !deploy.days.length) return null;
  const at = toMin(deploy.time);
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, Math.floor(at / 60), at % 60);
    if (deploy.days.includes(d.getDay()) && d > now) return d.toISOString();
  }
  return null;
};

module.exports = { inFreeze, dueSlot, nextRun, toMin };
