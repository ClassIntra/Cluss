// 数据库初始化：迁移 + 种子数据
//
// 启动顺序固定为：迁移 → 种子。迁移保证表结构就绪，种子保证「开箱可用」：
//   - 写入 instance_id 元信息（节点/中继身份，对账时要用）
//   - 首次启动写入默认 AI 模型（之后由管理台维护，不再覆盖）
//   - relay 模式下引导管理员账号（已存在则不动，避免重启把密码改回去）

var db = require('./db');
var migrationRunner = require('./migration-runner');
var config = require('../config');
var time = require('./time');

// ---- cluss_meta 读写 ----
function getMeta(key, fallback) {
  try {
    var row = db.prepare('SELECT value FROM cluss_meta WHERE key = ?').get(key);
    return row ? row.value : (fallback === undefined ? null : fallback);
  } catch (e) {
    return fallback === undefined ? null : fallback;
  }
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO cluss_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value === null || value === undefined ? '' : value));
}

// 首次启动写默认模型；表里已有任何模型就不再插入
function seedDefaultModel() {
  var count = db.prepare('SELECT COUNT(*) AS c FROM ai_models').get();
  if (count && count.c > 0) return;

  var s = config.aiSeed;
  db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style, supports_stream,',
    '  price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order)',
    'VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 1, 1, 0)'
  ].join('\n')).run(
    s.modelId, s.label, s.apiUrl, s.apiKey, s.modelId, 'openai',
    s.priceIn, s.priceOut, s.priceCacheHit
  );
  console.log('[init-db] 已写入默认模型:', s.modelId, s.apiUrl ? '' : '(API 地址为空，需在管理台补配)');
}

// 管理员引导：只要配置了 ADMIN_PASSWORD 且账号不存在就创建，绝不覆盖已有密码
//
// 为什么所有模式都做（不限于 relay）：
//   独立部署下学生无法在别处充值，管理员本就是同一套自建流程；
//   relay 模式则是权威账本所在处，更需要稳定的管理入口。
//   两处都用同一段逻辑，避免「独立部署没有管理台」这种不一致。
function bootstrapAdmin() {
  var a = config.admin;
  if (!a.password) {
    console.warn('[init-db] 未设置 ADMIN_PASSWORD，跳过管理员引导（管理台将无法登录）');
    return;
  }
  var existing = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(a.userId);
  if (existing) {
    // 已存在只确保权限位正确，不动密码（避免重启把管理员改过的密码还原）
    if (config.mode === config.MODES.RELAY) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE user_id = ?').run(a.userId);
    }
    return;
  }

  var pwd = require('./password');
  var hash = pwd.hashPassword(a.password);
  db.prepare([
    'INSERT INTO users (user_id, net_name, real_name, password_hash, status, is_admin, info_json, source, created_at)',
    'VALUES (?, ?, ?, ?, \'active\', 1, \'{}\', \'local\', ?)'
  ].join('\n')).run(a.userId, a.netName, a.realName, hash, time.nowUtc());
  console.log('[init-db] 已创建管理员账号:', a.userId, '(' + a.realName + ')');
}

function initDatabase() {
  var result = migrationRunner.runAll();
  console.log('[init-db] schema 版本 v' + result.currentVersion +
    (result.applied > 0 ? '（本次应用 ' + result.applied + ' 个迁移）' : '（已是最新）'));

  setMeta('instance_id', config.instanceId);

  seedDefaultModel();
  bootstrapAdmin();

  // 云盘目录（shared / thumbs）提前建好，避免首次上传时才开始建
  try {
    require('../services/cloud-store').ensureDirs();
  } catch (e) {
    console.warn('[init-db] 云盘目录初始化失败:', e.message);
  }
}

module.exports = {
  initDatabase: initDatabase,
  getMeta: getMeta,
  setMeta: setMeta
};