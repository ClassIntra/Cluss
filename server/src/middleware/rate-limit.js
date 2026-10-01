// 限流中间件：内存计数，按 IP + 路径维度统计
//
// 为什么不引第三方库：Cluss 部署在班级局域网，没有分布式限流需求，
// 一个 Map 足够；引入依赖反而增加低端设备上的安装负担。
// 目的是防「脚本批量注册 / 撞库」，不是精确配额。

function createRateLimiter(options) {
  var max = (options && options.max) || 60;
  var windowMs = (options && options.windowMs) || 60000;
  var message = (options && options.message) || '请求过于频繁，请稍后再试';

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
    var key = ip + ':' + (req.baseUrl || '') + (req.path || '');
    var now = Date.now();
    var item = hits.get(key);

    if (!item || now - item.start > windowMs) {
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

module.exports = { createRateLimiter: createRateLimiter };