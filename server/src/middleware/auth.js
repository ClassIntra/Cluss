// 认证中间件
//
// 与 ClassIntra 的差异（有意为之）：
//   - 支持双密钥校验（Cluss 密钥 + 可选的 ClassIntra 密钥），实现联动免登
//   - Cluss 没有班管概念，管理员只有 is_admin 一个来源
//   - token 来自 ClassIntra 时，若本地无该用户则就地落库（联邦引入），
//     否则后续任何按 user_id 的查询都会落空

var jwtUtil = require('../utils/jwt');
var db = require('../utils/db');
var constants = require('../utils/constants');

// 从 cookie / Authorization 头 / query 中提取 token
function extractToken(req) {
  var token = req.cookies && req.cookies.token;
  if (!token && req.headers.authorization) {
    token = req.headers.authorization.replace(/^Bearer\s+/i, '');
  }
  if (!token && req.query && req.query.token) {
    token = req.query.token;
  }
  return token || '';
}

// 确保 token 中的用户在本地存在（联邦引入时补齐）
// 仅做「补建」，绝不覆盖已有账号的密码或权限
function ensureLocalUser(decoded, source) {
  if (!decoded || !decoded.user_id) return null;
  var row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(decoded.user_id));
  if (row) return row;

  if (source !== 'classintra') return null;

  // 从 ClassIntra 引进的账号：密码未知，存空串（该用户只能在 CI 侧改密码，
  // 或通过桥的委托认证登录），状态默认 active，权限一律非管理员
  try {
    var nowUtc = require('../utils/time').nowUtc();
    var uid = String(decoded.user_id);
    // CI 的 user_id 编码 YYCCNN：能解出班级与入学年份，落库时一并带上
    var ciClassNo = /^\d{6}$/.test(uid) ? uid.slice(2, 4) : '';
    var ciYear = /^\d{6}$/.test(uid) ? '20' + uid.slice(0, 2) : '';
    db.prepare([
      'INSERT INTO users (user_id, net_name, real_name, gender, password_hash, status, is_admin, info_json, source,',
      '  enrollment_year, class_no, created_at)',
      'VALUES (?, ?, ?, ?, \'\', \'active\', 0, \'{}\', \'classintra\', ?, ?, ?)'
    ].join('\n')).run(
      uid,
      String(decoded.net_name || decoded.real_name || decoded.user_id),
      String(decoded.real_name || decoded.net_name || decoded.user_id),
      String(decoded.gender || ''),
      ciYear, ciClassNo,
      nowUtc
    );
    console.log('[Auth] 已从 ClassIntra 引入账号:', decoded.user_id);
    return db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(decoded.user_id));
  } catch (e) {
    // 唯一约束冲突（同名/同网名被占用）：说明本地已有等价账号，交给调用方处理
    console.warn('[Auth] 引入 ClassIntra 账号失败:', e.message);
    return null;
  }
}

function requireAuth(req, res, next) {
  var token = extractToken(req);
  if (!token) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }

  var result = jwtUtil.verifyToken(token);
  if (!result.valid) {
    return res.status(401).json({ code: 401, message: '登录已过期' });
  }

  var decoded = result.data;
  var row = ensureLocalUser(decoded, result.source);
  if (!row) {
    return res.status(401).json({ code: 401, message: '账号不存在，请重新登录' });
  }

  if (row.status === 'disabled') {
    return res.status(403).json({ code: 403, message: '该账号已被禁用' });
  }

  req.user = {
    user_id: row.user_id,
    net_name: row.net_name,
    real_name: row.real_name,
    is_admin: row.is_admin === 1 ? 1 : 0,
    source: row.source || 'local'
  };
  req.tokenSource = result.source;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ code: 401, message: '未登录' });
  }
  if (req.user.is_admin === 1) return next();
  return res.status(403).json({ code: 403, message: '无权限访问' });
}

module.exports = {
  requireAuth: requireAuth,
  requireAdmin: requireAdmin,
  extractToken: extractToken
};