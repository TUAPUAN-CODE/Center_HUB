'use strict';
// แจ้งเตือนผ่าน LINE Messaging API (ไม่บังคับ — ตั้ง LINE_CHANNEL_ACCESS_TOKEN และ LINE_NOTIFY_TO ใน agent/.env)
const https = require('https');
const { log } = require('../../shared/log');

const notify = (text) => new Promise((resolve) => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_NOTIFY_TO;
  if (!token || !to) { resolve(false); return; }
  const body = JSON.stringify({ to, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] });
  const req = https.request('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    timeout: 10000,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` },
  }, (res) => {
    res.resume();
    if (res.statusCode !== 200) log('warn', 'line_notify_failed', { status: res.statusCode });
    resolve(res.statusCode === 200);
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => { log('warn', 'line_notify_failed', { error: e.message }); resolve(false); });
  req.end(body);
});

module.exports = { notify };
