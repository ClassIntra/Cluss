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

// 本地时间（服务器所在时区）的可读文本，用于给模型注入 [当前时间]。
// 只精确到分钟：注入到 system prompt 末尾，精度再高也只会让缓存前缀白失效一次。
function nowLocalText() {
  var d = new Date();
  var week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' 周' + week + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
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
  nowLocalText: nowLocalText,
  utcBeforeDays: utcBeforeDays,
  toISO: toISO
};