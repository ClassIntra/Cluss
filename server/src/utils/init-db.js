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

// 单调递增的版本号（assign_version / roster_version 等共用）。
// 版本号的语义只有一件事：让节点知道「中枢那版比我装的新」。
// 单独抽出来是因为升版本的地方不止一处（管理台改额度、节点上行名册），
// 各自写一遍 getMeta+1+setMeta 迟早会有一处漏掉 —— 漏了的表现是
// 「中枢改了，节点永远拉不到」，而且没有任何报错。
function bumpMeta(key) {
  var cur = parseInt(getMeta(key, '0'), 10) || 0;
  var next = cur + 1;
  setMeta(key, next);
  return next;
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
// 权限位按部署模式区分：
//   独立部署（standalone）—— 没有 ClassIntra 可引入班管，开发账号（ADMIN_USER_ID，
//   默认 999999）就是唯一的管理入口，is_admin=1。
//   联动部署（relay）—— 实际管理交给 ClassIntra 的班管（token 的 is_class_admin
//   映射，见 middleware/auth.js）；开发账号只是开发用，is_admin 强制归 0，
//   避免一个跑测试的账号在学校环境里握着全部管理权。
function bootstrapAdmin() {
  var a = config.admin;
  if (!a.password) {
    console.warn('[init-db] 未设置 ADMIN_PASSWORD，跳过管理员引导（管理台将无法登录）');
    return;
  }
  var wantAdmin = config.mode === config.MODES.RELAY ? 0 : 1;
  var existing = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(a.userId);
  if (existing) {
    // 已存在只确保权限位正确，不动密码（避免重启把管理员改过的密码还原）
    db.prepare('UPDATE users SET is_admin = ? WHERE user_id = ?').run(wantAdmin, a.userId);
    if (wantAdmin === 0) {
      console.log('[init-db] 联动模式：开发账号', a.userId, '不持有管理权（实际管理走 ClassIntra 班管）');
    }
    return;
  }

  var pwd = require('./password');
  var hash = pwd.hashPassword(a.password);
  db.prepare([
    'INSERT INTO users (user_id, net_name, real_name, password_hash, status, is_admin, info_json, source, created_at)',
    'VALUES (?, ?, ?, ?, \'active\', ?, \'{}\', \'local\', ?)'
  ].join('\n')).run(a.userId, a.netName, a.realName, hash, wantAdmin, time.nowUtc());
  console.log('[init-db] 已创建开发账号:', a.userId, '(' + a.realName + ')',
    wantAdmin ? '（独立部署，兼管理入口）' : '（联动模式，非管理员）');
}

function initDatabase() {
  var result = migrationRunner.runAll();
  console.log('[init-db] schema 版本 v' + result.currentVersion +
    (result.applied > 0 ? '（本次应用 ' + result.applied + ' 个迁移）' : '（已是最新）'));

  setMeta('instance_id', config.instanceId);

  // 清理"生成中"僵尸：进程若在生成途中被杀（崩溃 / 强退），那条占位消息的
  // streaming 会永远停在 1，前端会一直去轮询一个不会再动的会话。
  // 重启之后确定没有任何生成还在进行 —— 统一收敛，判定是确定的。
  //
  // 复用 conversation-core 的实现，而不是在这里写一句 UPDATE：
  //   「有正文的保留、没正文的删掉」这条规则单条收尾那边也在用，
  //   两处各写一遍迟早漂移，变成"手动停止留正文、重启却把正文删了"。
  try {
    var settled = require('../services/conversation-core').settleAllStreamingMessages();
    if (settled.total > 0) {
      console.log('[init-db] 收敛遗留的"生成中"消息 ' + settled.total +
        ' 条（保留 ' + settled.kept + ' 条有内容的，删除 ' + settled.dropped + ' 条空占位）');
    }
  } catch (e) {
    console.warn('[init-db] 清理遗留 streaming 失败:', e.message);
  }

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
  bumpMeta: bumpMeta,
  setMeta: setMeta
};