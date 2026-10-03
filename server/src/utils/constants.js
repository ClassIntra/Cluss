// 通用常量与工具

var crypto = require('crypto');

// 时序安全的字符串比较（防时序侧信道），用于共享密钥校验
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  var bufA = Buffer.from(a);
  var bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str || '{}');
  } catch (e) {
    return fallback === undefined ? {} : fallback;
  }
}

// 生成幂等键：同一逻辑事件在重试/重复下发时保持相同。
// 用 sha256 而非 sha1 —— 幂等键虽不用于加密，但它决定"两笔账算不算同一笔"，
// 已知存在碰撞的摘要算法不适合承担这个判断。
function makeIdemKey(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

// 随机 ID（会话等）
function randomId(prefix) {
  return (prefix || '') + crypto.randomBytes(12).toString('hex');
}

module.exports = {
  safeCompare: safeCompare,
  safeJsonParse: safeJsonParse,
  makeIdemKey: makeIdemKey,
  randomId: randomId
};