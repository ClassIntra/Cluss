// 「参考来源」：把服务端给的来源清单裁成回答里真正引用到的那些。
//
// 为什么要裁：
//   1. 一轮里最多检索两次（合起来可能有 10 条），全列出来会把答案压得很长；
//      学生关心的是"这几句话出自哪"，不是"搜索引擎返回了什么"。
//   2. **只列正文里真的引用到的 [n]**。一个都没引用就一条都不列 ——
//      曾试过"没引用就退回前 5 条"，结果答案写着"没查到相关结果"，
//      下面却赫然列着两条不相干的页面，等于伪造依据。
//   3. 同一 URL 在两轮检索里都出现时只留编号最小的那条（重复列没有信息量）。
//
// 注意：这里**不做任何网络请求**，也不猜标题 —— 只搬运服务端已经核实过的字段。

// 发布时间的原始值五花八门（Tavily 给 RFC 822 的 "Thu, 15 Oct 2026 03:34:00 GMT"，
// 博查给 "2026-10-15"）。原样贴给学生看等于没给 —— 他读不出这是哪一天。
// 统一收敛成 YYYY-MM-DD；认不出来的一律返回空（宁可不显示，也不显示乱码）。
export function formatPublished(v) {
  var s = String(v || '').trim();
  if (!s) return '';

  var iso = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) {
    return iso[1] + '-' + pad2(iso[2]) + '-' + pad2(iso[3]);
  }

  var d = new Date(s.replace(/\s+/g, ' '));
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function pad2(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}

export function pickSources(list, text) {
  var arr = Array.isArray(list) ? list : [];
  if (!arr.length) return [];

  var cited = {};
  var hits = String(text || '').match(/\[(\d{1,3})\]/g) || [];
  for (var i = 0; i < hits.length; i++) {
    var n = parseInt(hits[i].slice(1, -1), 10);
    if (n > 0) cited[n] = 1;
  }
  if (!Object.keys(cited).length) return [];

  var seen = {};
  var out = [];
  for (var j = 0; j < arr.length; j++) {
    var s = arr[j] || {};
    if (!s.url || !cited[s.n]) continue;
    if (seen[s.url]) continue;
    seen[s.url] = 1;
    out.push({
      n: s.n,
      title: String(s.title || s.host || s.url),
      url: String(s.url),
      host: String(s.host || ''),
      // 摘要（服务端检索时已洗掉导航/版权噪声）。
      // 教室设备普遍出不了外网，链接点开只会白屏或撞上 MDM 过滤页；
      // 这段摘要才是学生真正能核验的"依据"。
      snippet: String(s.snippet || ''),
      published: formatPublished(s.published)
    });
  }
  return out;
}
