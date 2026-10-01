// 时间工具
//
// 约定（与 ClassIntra 保持一致，便于两库对账时不产生时区歧义）：
//   - 数据库中时间一律存 UTC 的 'YYYY-MM-DD HH:MM:SS'（可被 SQLite 的 datetime() 直接比较）
//   - 对外 API 返回 ISO 8601 字符串

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

// 当前 UTC 时间，SQLite 可比较格式
function nowUtc() {
  return fmtUtc(new Date());
}

function fmtUtc(d) {
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' +
    pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

// N 天前的 UTC 时间点（用于滚动窗口查询）
function utcBeforeDays(days) {
  var ms = Number(days || 0) * 24 * 3600 * 1000;
  return fmtUtc(new Date(Date.now() - ms));
}

// 数据库时间 → ISO 8601（供前端解析；SQLite 存的是 UTC，需补 Z）
function toISO(v) {
  if (!v) return null;
  if (typeof v !== 'string') return v;
  if (v.indexOf('Z') !== -1 || v.indexOf('T') !== -1) return v;
  return v.replace(' ', 'T') + 'Z';
}

module.exports = {
  nowUtc: nowUtc,
  fmtUtc: fmtUtc,
  utcBeforeDays: utcBeforeDays,
  toISO: toISO
};