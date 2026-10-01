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
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

// 3) 认证接口限流（防脚本批量注册与撞库）
app.use('/api/auth/login', rateLimit({ max: 60, windowMs: 60000, message: '登录请求过于频繁，请稍后再试' }));
app.use('/api/auth/register', rateLimit({ max: 30, windowMs: 60000, message: '注册请求过于频繁，请稍后再试' }));
app.use('/api/auth', rateLimit({ max: 300, windowMs: 60000, message: '请求过于频繁，请稍后再试' }));

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
app.use('/api/wrong-book', require('./routes/wrong-book'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/sync', require('./routes/sync'));

// 健康检查：让学生端排障页/运维能一眼看出实例身份与模式
app.get('/api/health', function(req, res) {
  var sync = require('./services/sync');
  res.json({
    code: 200,
    message: 'ok',
    data: {
      service: 'cluss',
      mode: config.mode,
      instance_id: config.instanceId,
      time: new Date().toISOString(),
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