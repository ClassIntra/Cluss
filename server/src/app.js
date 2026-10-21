// Cluss 服务端入口
//
// 三种模式共用这一份代码：
//   standalone —— 独立部署，账号与额度全本地
//   node       —— 班级节点，从 relay 拉额度、本地扣费、上报用量
//   relay      —— 中继权威节点，持有权威账本与管理台

require('dotenv').config();

var express = require('express');
var path = require('path');
var fs = require('fs');
var cookieParser = require('cookie-parser');
var compression = require('compression');
var morgan = require('morgan');
var config = require('./config');
var rateLimit = require('./middleware/rate-limit').createRateLimiter;
var initDb = require('./utils/init-db');

// 1) 初始化数据库（迁移 + 种子）
initDb.initDatabase();

var app = express();

// 2) 通用中间件
app.disable('x-powered-by');
app.use(compression({ level: 6, threshold: 1024 }));
// 生产用 tiny 一行式，开发用 dev 彩色格式
//
// ⚠️ 两种格式都会打出 `:url`，而 ClassIntra 免登链路是把 JWT 拼在查询串上
//    传进来的（`GET /?token=<JWT>`）。前端收到后会用 history.replaceState 立刻
//    从地址栏抹掉，但**服务端的访问日志已经先记下了完整 URL** —— 一个可用的
//    会话令牌就这样明文落在 pm2 日志里，谁拿到日志文件（备份/同步盘/随手外发）
//    谁就拿到了该用户的会话。本仓库的 verify-no-secrets.cjs 就是在日志里扫出
//    过这种带签名的完整 JWT 才发现这个缺口的。
//
//    这里直接重定义 morgan 内置的 url token，把 token 参数换成固定占位串：
//    保留「这个请求免登进来的」这一事实，抹掉令牌本身。
morgan.token('url', function (req) {
  var u = String(req.originalUrl || req.url || '');
  return u.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');
});
app.use(morgan(config.isProd ? 'tiny' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

// 3) 认证接口限流（防脚本批量注册与撞库）
app.use('/api/auth/login', rateLimit({ max: 60, windowMs: 60000, message: '登录请求过于频繁，请稍后再试' }));
app.use('/api/auth/register', rateLimit({ max: 30, windowMs: 60000, message: '注册请求过于频繁，请稍后再试' }));
app.use('/api/auth', rateLimit({ max: 300, windowMs: 60000, message: '请求过于频繁，请稍后再试' }));

// 3.5) **产生上游开销的生成端点**限流
//
// ⚠️ 这条以前是缺失的，而它是「积分被批量洗空」的另一半路径：
//   auth 那几条限流只覆盖登录注册，而下面这 7 个端点每一个都会真的
//   调上游、真的产生 API 费用 —— /api/chat/stream、study 的solve/grade、
//   writing 的 generate/grade/outline、notes 的 assist。
//   原来唯一的屏障是 turn-runner 的会话级互斥锁，而它按 conversation_id 加锁：
//   换几个会话 ID 就绕过去了。
//
// 为什么按 user_id 而不是 IP：Cluss 部署在班级局域网，全班共用一个出口 IP。
// 按 IP 限流的话，一��学生狂刷就把其他人一起挡了 —— 这是误伤，不能接受。
//
// 为什么挂在 requireAuth **之后**：keyFn 读的是 req.user，鉴权必须先跑完。
// 挂早了 req.user 为空，所有人会挤到同一个兜底 key 上，反而比不限更糟。
//
// 阈值 12次/分钟：一次正常的解题往返是 1 次请求；学生连续追问、
// 或反复用「重新生成」在 12 次以内，这个量级不挡正常使用，
// 但足以让脚本式的批量消耗慢到失去意义（真要刷就得到等很久）。
var genRateLimit = rateLimit({
  max: 12,
  windowMs: 60000,
  message: '提问有点频繁，慢一点让思路跟上来（每分钟最多 12 次）',
  keyFn: function(req) {
    return (req.user && req.user.user_id) || ('ip:' + (req.ip || 'unknown'));
  }
});
app.use(/^\/api\/(chat\/stream|study\/(solve|grade)\/stream|writing\/(generate|grade|outline)\/stream|notes\/assist)$/,
  require('./middleware/auth').requireAuth,
  genRateLimit);

// CORS：留空则仅同源（学生浏览器直连本机，不需要跨域）
if (config.corsOrigins.length) {
  app.use(function(req, res, next) {
    var origin = req.headers.origin;
    if (origin && config.corsOrigins.indexOf(origin) !== -1) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// 4) API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/chat'));
app.use('/api/study', require('./routes/study'));
app.use('/api/cloud', require('./routes/cloud'));
app.use('/api/usage', require('./routes/usage'));
app.use('/api/writing', require('./routes/writing'));
app.use('/api/notes', require('./routes/notes'));
app.use('/api/memories', require('./routes/memories'));
app.use('/api/affinity', require('./routes/affinity'));
app.use('/api/private', require('./routes/private'));
app.use('/api/campus-context', require('./routes/campus-context'));
app.use('/api/wrong-book', require('./routes/wrong-book'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/sync', require('./routes/sync'));

// 健康检查：让学生端排障页/运维能一眼看出实例身份、模式与版本。
// 故意不鉴权、不暴露任何账号/路径信息——监控探针只需要这些字段。
app.get('/api/health', function(req, res) {
  var sync = require('./services/sync');
  res.json({
    code: 200,
    message: 'ok',
    data: {
      service: 'cluss',
      version: config.version,
      mode: config.mode,
      instance_id: config.instanceId,
      time: new Date().toISOString(),
      uptime_sec: Math.floor(process.uptime()),
      sync: sync.getStatus(),
      ci_bridge_enabled: require('./services/ci-bridge').isEnabled()
    }
  });
});

// 5) 前端静态资源（构建产物存在时才挂载）
var clientDist = path.join(__dirname, '../../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, {
    maxAge: '0',
    immutable: false,
    setHeaders: function(res) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }));

  // SPA 兜底：非 /api 前缀的 GET 一律回 index.html
  app.get(/^(?!\/api).*/, function(req, res) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(clientDist, 'index.html'));
  });
} else {
  console.warn('[app] 未找到前端构建产物（client/dist），当前仅提供 API 服务');
  console.warn('[app] 构建命令：cd client && npm install && npm run build');
}

// 6) 兜底错误处理：绝不把内部错误详情抛给用户
app.use(function(err, req, res, next) {
  console.error('[app] 未捕获错误:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ code: 500, message: '服务器内部错误' });
});

// 7) 启动
var server = app.listen(config.port, function() {
  console.log('');
  console.log('  Cluss 已启动');
  console.log('  ├─ 版本     : v' + config.version);
  console.log('  ├─ 模式     : ' + config.mode);
  console.log('  ├─ 实例标识 : ' + config.instanceId);
  console.log('  ├─ 监听端口 : ' + config.port);
  console.log('  ├─ 数据库   : ' + config.dbPath);
  console.log('  ├─ 中继     : ' + (config.relay.url || '（未配置）'));
  console.log('  └─ CI 联动  : ' + (config.ci.bridgeUrl || '（未配置）'));
  console.log('');

  // 节点模式启动同步
  require('./services/sync').start();
});

// 优雅退出：先关 HTTP 再退出，避免正在写的请求被截断
function shutdown(signal) {
  console.log('[app] 收到 ' + signal + '，正在关闭...');
  require('./services/sync').stop();
  server.close(function() {
    process.exit(0);
  });
  setTimeout(function() { process.exit(0); }, 5000).unref();
}

process.on('SIGTERM', function() { shutdown('SIGTERM'); });
process.on('SIGINT', function() { shutdown('SIGINT'); });