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

// ---- 积分：只是「元」的展示层 ----
//
// 为什么不直接给学生看「元」：学生端一旦出现 ¥，提问前就会开始算「这值不值」，
// 而学习恰恰需要低心理门槛地提问。¥0.0037 这种小数对中学生也不构成任何直觉。
// 积分是整数、没有货币符号，学生理解成「我还有多少可用次数」而不是「我在花钱」。
//
// 底层结算**完全不变**：分配、扣费、对账仍然全部走微元整数运算，
// 积分只在「给学生看的接口」上换算一次。管理员那边看到的依旧是元。
//
// 默认 1 元 = 100 积分（即 1 积分 = 1 分钱）：
//   - 积分数量级够大：20 元 = 2000 积分，学生有"够用"的感觉
//   - 换算比例简单：管理员心算无负担
// 这个比例可配，但注意改动会让学生看到的积分总额整体变化，
// 建议只在学期初调整，中途改会让学生觉得"积分莫名其妙变了"。
var pointsPerYuan = num(process.env.CLUSS_POINTS_PER_YUAN, 100);
if (!(pointsPerYuan > 0)) pointsPerYuan = 100;

function microToPoints(micro) {
  return Math.round(Number(micro) * pointsPerYuan / 1000000);
}

// 精确到「分」的积分换算（保留两位小数，去不了尾零交给数字序列化）。
//
// 为什么必须有它：单轮对话的真实消耗常在 0.3 ~ 1.4 积分之间，
// 若明细按整数取整，1.44 变 1、0.35 变 0 —— 学生把明细加起来
// 和汇总一对（14.4 的账对出 10），「计数不准」的印象就来了。
// 整数口径保留在钱包大数字与闸门文案上；明细与汇总用本函数。
function microToPointsExact(micro) {
  return Math.round(Number(micro || 0) * pointsPerYuan / 1e4) / 100;
}

function yuanToPoints(yuan) {
  return Math.round(Number(yuan) * pointsPerYuan);
}

var mode = readMode();

module.exports = {
  MODES: MODES,
  mode: mode,
  port: num(process.env.PORT, 9003),
  instanceId: String(process.env.CLUSS_INSTANCE_ID || 'cluss-local').trim(),

  // 版本号唯一来源：本 package.json 的 version 字段。
  // 发版只改这里（+ client/package.json 同步），/api/health 与前端"关于"都读它。
  version: require('../../package.json').version,

  // 生产标记：NODE_ENV=production 时切紧凑日志等行为
  isProd: process.env.NODE_ENV === 'production',

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
    jwtSecret: String(process.env.CI_JWT_SECRET || '').trim(),
    // CI 的 RS256 **公钥**（PEM，换行用 \n 或直接贴多行）。
    //
    // 为什么要有这个：jwtSecret 是**对称共享密钥**，持有它的一方都能自签
    // 任意 payload —— 于是任何持有者都能伪造出 is_admin 的 token 改写本地
    // 账号的管理标志（见 middleware/auth.js 的 syncCiAdminFlag 说明）。
    // 改成非对称签名后，Cluss 只拿公钥：能验真，**但造不出假**。
    //
    // 两者可以并存：配了公钥就优先用公钥验，同时保留共享密钥兜底，
    // 这样 CI 可以分步切换（先在 Cluss 配公钥、再让 CI 改用私钥签名），
    // 切换期间联登不会中断。全部留空则联动关闭。
    jwtPublicKey: String(process.env.CI_JWT_PUBLIC_KEY || '').trim().replace(/\\n/g, '\n')
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

  points: {
    perYuan: pointsPerYuan
  },

  yuanToMicro: yuanToMicro,
  microToYuan: microToYuan,
  microToPoints: microToPoints,
  microToPointsExact: microToPointsExact,
  yuanToPoints: yuanToPoints
};