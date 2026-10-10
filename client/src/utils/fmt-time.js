// 时间显示统一出口：UTC ISO → 服务器/浏览器本地时间文本
//
// 为什么必须存在：库里所有时间都是 UTC（见 server/utils/time.js 约定），
// 此前各页面直接 slice ISO 字符串，北京部署下所有时间戳整体偏移 8 小时
// （晚上 9 点的提问显示成下午 1 点）。图表的日分组已改为本地日期，
// 这里的文本显示必须与它一致 —— 各页各写一份迟早又会漂回去。
//
// 解析失败时退回字符串裁切：宁可显示 UTC 原文，也不显示 Invalid Date。

export function fmtLocal(iso, opts) {
  var withSeconds = !!(opts && opts.seconds);
  var short = !!(opts && opts.short);   // 'MM-DD HH:mm'（区间较近的列表用）

  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);

  function pad(n) { return n < 10 ? '0' + n : String(n); }
  var date = short
    ? (d.getMonth() + 1) + '-' + pad(d.getDate())
    : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  var time = pad(d.getHours()) + ':' + pad(d.getMinutes()) +
    (withSeconds ? ':' + pad(d.getSeconds()) : '');
  return date + ' ' + time;
}
