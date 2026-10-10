// 限流中间件：内存计数，按 IP + 路径维度统计
//
// 为什么不引第三方库：Cluss 部署在班级局域网，没有分布式限流需求，
// 一个 Map 足够；引入依赖反而增加低端设备上的安装负担。
// 目的是防「脚本批量注册 / 撞库 / 批量烧额度」，不是精确配额。

var DEFAULT_MAX_ENTRIES = 50000;

function createRateLimiter(options) {
  var opts = options || {};
  var max = opts.max || 60;
  var windowMs = opts.windowMs || 60000;
  var message = opts.message || '请求过于频繁，请稍后再试';

  // keyFn：决定按什么维度计数。默认按 IP。
  //
  // 限「会产生上游开销的生成端点」时必须按 user_id —— 那是全班共用一个出口 IP
  // 的局域网，40 个学生共用一个 key，一有人狂刷就把其他人一起挡了。
  //
  // ⚠️ 用 keyFn 时调用方必须保证鉴权已完成（本项目里就是先 requireAuth 再限流），
  //    否则 req.user 为空，会全部落到同一个兜底 key 上，反而比按 IP 更糟。
  var keyFn = opts.keyFn || null;
  var maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;

  var hits = new Map();

  // 定期清理过期记录，防止 Map 无限增长
  var timer = setInterval(function() {
    var now = Date.now();
    hits.forEach(function(item, key) {
      if (now - item.start > windowMs) hits.delete(key);
    });
  }, windowMs);
  if (timer.unref) timer.unref();

  return function(req, res, next) {
    var ip = req.ip || req.connection.remoteAddress || 'unknown';
    var scope = keyFn ? keyFn(req) : ip;
    var key = scope + ':' + (req.baseUrl || '') + (req.path || '');
    var now = Date.now();
    var item = hits.get(key);

    if (!item || now - item.start > windowMs) {
      // 硬上限：两次清理之间可以写入任意多条（IP 轮换 / 多机协同），
      // 不设上限的话一个脚本就能把堆撑爆 —— 这本身就是一种拒绝服务。
      // 超限时整体清空并拒绝：宁可让所有人等一个窗口，
      // 也不让攻击者用内存把我们拖垮。
      if (hits.size >= maxEntries) {
        hits.clear();
        return res.status(429).json({ code: 429, message: message });
      }
      hits.set(key, { start: now, count: 1 });
      return next();
    }

    item.count++;
    if (item.count > max) {
      return res.status(429).json({ code: 429, message: message });
    }
    next();
  };
}

module.exports = {
  createRateLimiter: createRateLimiter,
  DEFAULT_MAX_ENTRIES: DEFAULT_MAX_ENTRIES
};