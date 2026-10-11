'use strict';
// ปิดค่าความลับก่อนส่งข้อความ log/output ออกไปนอกเครื่อง (รหัสผ่าน, token, connection string)
const PATTERNS = [
  [/(authorization\s*[=:]\s*)(?:(?:Bearer|Basic)\s+)?[^\s"',;]+/gi, '$1***'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[=:]\s*["']?)([^\s"',;]+)/gi, '$1***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***'],
  [/(\/\/[^/\s:@]+:)([^@\s/]+)(@)/g, '$1***$3'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '***jwt***'],
];
const mask = (text) => PATTERNS.reduce((s, [re, rep]) => s.replace(re, rep), String(text || ''));
module.exports = { mask };
