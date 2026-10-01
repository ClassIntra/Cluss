// 配置模块：集中读取环境变量，并做必要的启动校验
//
// 设计要点：
// 1. 三种运行模式（standalone / node / relay）共用同一份代码，靠 CLUSS_MODE 分流
// 2. JWT_SECRET 必须显式设置，缺失则拒绝启动（与 ClassIntra 同策略，避免默认密钥）
// 3. 金额一律以「微元」在内部流转（1 元 = 1e6 微元），全整数运算，避免浮点误差

var path = require('path');

// 模式枚举
var MODES = { STANDALONE: 'standalone', NODE: 'node', RELAY: 'relay' };

function readMode() {
  var raw = String(process.env.CLUSS_MODE || '').trim().toLowerCase();
  if (raw === MODES.NODE || raw === MODES.RELAY || raw === MODES.STANDALONE) return raw;
  return MODES.STANDALONE;
}

function requireEnv(name) {
  var v = String(process.env[name] || '').trim();
  if (!v) {
    console.error('FATAL: 环境变量 ' + name + ' 必须设置（见 server/.env.example）');
    process.exit(1);
  }
  return v;
}

function num(v, fallback) {
  var n = parseInt(v, 10);
  return isFinite(n) ? n : fallback;
}

// 元 → 微元（保留 6 位小数精度）
function yuanToMicro(yuan) {
  return Math.round(Number(yuan) * 1000000);
}

// 微元 → 元（展示用）
function microToYuan(micro) {
  return Math.round(Number(micro)) / 1000000;
}

var mode = readMode();

module.exports = {
  MODES: MODES,
  mode: mode,
  port: num(process.env.PORT, 9101),
  instanceId: String(process.env.CLUSS_INSTANCE_ID || 'cluss-local').trim(),

  jwt: {
    secret: requireEnv('JWT_SECRET'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  dbPath: path.resolve(process.env.DB_PATH || path.join(__dirname, '../../database/cluss.db')),

  // 资源目录：云盘文件与缩略图的物理存放根
  // 每实例独立（不做跨节点同步），所以默认放在项目自己的 Resources 下
  resourcesDir: path.resolve(process.env.RESOURCES_DIR || path.join(__dirname, '../../Resources')),

  // 管理员引导（仅 relay 模式生效：首次启动创建，不覆盖已有账号）
  admin: {
    userId: String(process.env.ADMIN_USER_ID || '999999').trim(),
    netName: String(process.env.ADMIN_NET_NAME || '管理员').trim(),
    realName: String(process.env.ADMIN_REAL_NAME || 'Cluss管理员').trim(),
    password: String(process.env.ADMIN_PASSWORD || '')
  },

  relay: {
    url: String(process.env.CLUSS_RELAY_URL || '').trim().replace(/\/+$/, ''),
    secret: String(process.env.CLUSS_SHARED_SECRET || '').trim(),
    syncIntervalSec: num(process.env.CLUSS_SYNC_INTERVAL, 60),
    reportIntervalSec: num(process.env.CLUSS_REPORT_INTERVAL, 300),
    toleranceMicro: yuanToMicro(process.env.CLUSS_SYNC_TOLERANCE_YUAN || 1)
  },

  // ClassIntra 联动（留空即关闭，独立部署完全不受影响）
  ci: {
    bridgeUrl: String(process.env.CI_BRIDGE_URL || '').trim().replace(/\/+$/, ''),
    secret: String(process.env.CI_BRIDGE_SECRET || '').trim(),
    jwtSecret: String(process.env.CI_JWT_SECRET || '').trim()
  },

  aiSeed: {
    modelId: String(process.env.AI_DEFAULT_MODEL_ID || 'deepseek-chat').trim(),
    apiUrl: String(process.env.AI_DEFAULT_API_URL || '').trim(),
    apiKey: String(process.env.AI_DEFAULT_API_KEY || '').trim(),
    label: String(process.env.AI_DEFAULT_LABEL || 'DeepSeek Chat').trim(),
    priceIn: num(process.env.AI_DEFAULT_PRICE_IN, 0),
    priceOut: num(process.env.AI_DEFAULT_PRICE_OUT, 0),
    priceCacheHit: num(process.env.AI_DEFAULT_PRICE_CACHE_HIT, 0)
  },

  publicBaseUrl: String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),

  corsOrigins: String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(function(s) { return s.trim(); })
    .filter(function(s) { return s !== ''; }),

  yuanToMicro: yuanToMicro,
  microToYuan: microToYuan
};