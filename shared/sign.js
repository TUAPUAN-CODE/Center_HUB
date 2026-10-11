'use strict';
// ลายเซ็นคำขอ Hub → Agent (HMAC-SHA256) — Agent รับเฉพาะคำขอที่ลงลายเซ็นด้วยความลับเดียวกัน, เวลาไม่เกิน ±60 วินาที, ใช้ซ้ำไม่ได้
const crypto = require('crypto');

const MAX_SKEW_MS = 60 * 1000;

const sha256 = (data) => crypto.createHash('sha256').update(data || '').digest('hex');
const payloadOf = (method, path, ts, body) => `${String(method).toUpperCase()}\n${path}\n${ts}\n${sha256(body)}`;

/** headers ที่ต้องแนบไปกับคำขอ */
const signRequest = (secret, method, path, body = '') => {
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', secret).update(payloadOf(method, path, ts, body)).digest('hex');
  return { 'x-center-ts': ts, 'x-center-sig': sig };
};

/** ตัวตรวจ: เก็บลายเซ็นที่เคยเห็นไว้ช่วงเวลาหนึ่งกันการส่งซ้ำ */
const createVerifier = (secret) => {
  if (!secret || String(secret).length < 32) throw new Error('ความลับของ Agent ต้องยาวอย่างน้อย 32 ตัวอักษร');
  const seen = new Map();
  const sweep = () => { const now = Date.now(); for (const [k, exp] of seen) if (exp < now) seen.delete(k); };
  setInterval(sweep, 30 * 1000).unref();
  return (method, path, headers, body = '') => {
    const ts = Number(headers['x-center-ts']);
    const sig = String(headers['x-center-sig'] || '');
    if (!ts || !/^[0-9a-f]{64}$/.test(sig)) return 'missing_signature';
    if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return 'clock_skew';
    const expected = crypto.createHmac('sha256', secret).update(payloadOf(method, path, String(ts), body)).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return 'bad_signature';
    if (seen.has(sig)) return 'replay';
    seen.set(sig, Date.now() + 2 * MAX_SKEW_MS);
    return null;
  };
};

module.exports = { signRequest, createVerifier, sha256 };
