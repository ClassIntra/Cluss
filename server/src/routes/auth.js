// 认证路由：开放注册 + 登录 + 令牌刷新
//
// 与 ClassIntra 的关键差异：
//   - 注册**没有预注册名单校验**，任何合法账号都能注册并立即使用
//   - user_id 自动分配，取 800001+ 保留段，永不与 ClassIntra 的 YYCCNN 冲突
//   - 登录支持「本地校验 → ClassIntra 委托校验」两段式（联动部署时账号互通）

var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var jwtUtil = require('../utils/jwt');
var pwdUtil = require('../utils/password');
var time = require('../utils/time');
var auth = require('../middleware/auth');
var ciBridge = require('../services/ci-bridge');
var userIdService = require('../services/user-id');

function buildUserInfo(row) {
  return {
    user_id: row.user_id,
    net_name: row.net_name,
    real_name: row.real_name,
    gender: row.gender || '',
    status: row.status,
    is_admin: row.is_admin === 1,
    source: row.source || 'local',
    enrollment_year: row.enrollment_year || '',
    class_no: row.class_no || '',
    info: require('../utils/constants').safeJsonParse(row.info_json, {}),
    created_at: time.toISO(row.created_at),
    last_login: time.toISO(row.last_login)
  };
}

function buildTokenPayload(row) {
  return {
    user_id: row.user_id,
    net_name: row.net_name,
    real_name: row.real_name,
    gender: row.gender || '',
    is_admin: row.is_admin === 1 ? 1 : 0,
    class_no: row.class_no || '',
    enrollment_year: row.enrollment_year || ''
  };
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

// 校验注册输入；返回 { ok, message }
function validateRegisterInput(net_name, real_name, password, confirm_password) {
  if (!net_name || !real_name || !password || !confirm_password) {
    return { ok: false, message: '请填写所有必填字段' };
  }
  if (String(net_name).length > 24) return { ok: false, message: '用户名最多 24 个字符' };
  if (String(real_name).length > 24) return { ok: false, message: '姓名最多 24 个字符' };
  if (password !== confirm_password) return { ok: false, message: '两次输入的密码不一致' };
  var strength = pwdUtil.checkPasswordStrength(password);
  if (!strength.valid) return { ok: false, message: strength.message };
  return { ok: true };
}

// ============================================================
// POST /api/auth/register —— 开放注册（真实姓名 + 入学年份 + 班级）
// ============================================================
router.post('/register', function(req, res) {
  try {
    var net_name = String(req.body.net_name || '').trim();
    var real_name = String(req.body.real_name || '').trim();
    var password = req.body.password;
    var confirm_password = req.body.confirm_password;
    var enrollment_year = req.body.enrollment_year;
    var class_no = req.body.class_no;

    var v = validateRegisterInput(net_name, real_name, password, confirm_password);
    if (!v.ok) return res.json({ code: 400, message: v.message, data: null });

    // 学籍信息校验：入学年份与班级决定学号，必须合法
    var profile = userIdService.validateProfile(enrollment_year, class_no);
    if (!profile.ok) return res.json({ code: 400, message: profile.message, data: null });

    // 唯一性校验：users 表对 net_name / real_name 都有 UNIQUE 约束，
    // 提前检查是为了给出「哪个字段重复并已如何提示」的明确信息
    var dupNet = db.prepare('SELECT user_id FROM users WHERE net_name = ?').get(net_name);
    if (dupNet) return res.json({ code: 409, message: '该用户名已被使用', data: null });

    var dupReal = db.prepare('SELECT user_id FROM users WHERE real_name = ?').get(real_name);
    if (dupReal) {
      // 同名是校园场景的高频情况：给出可操作的建议，而不是让用户反复试
      return res.json({
        code: 409,
        message: '该姓名已被注册。若确为本人，请用学号登录；若是同名同学，请在姓名后加上班级（如「' +
          real_name + '(' + String(profile.classNo) + '班)」）',
        data: null
      });
    }

    var alloc = userIdService.allocateUserId(enrollment_year, class_no);
    if (!alloc) return res.json({ code: 500, message: '学号分配失败，请联系管理员', data: null });

    var hash = pwdUtil.hashPassword(password);
    db.prepare([
      'INSERT INTO users (user_id, net_name, real_name, password_hash, status, is_admin, info_json, source,',
      '  enrollment_year, class_no, created_at)',
      'VALUES (?, ?, ?, ?, \'active\', 0, \'{}\', \'local\', ?, ?, ?)'
    ].join('\n')).run(
      alloc.user_id, net_name, real_name, hash,
      profile.year, profile.classNo, time.nowUtc()
    );

    var row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(alloc.user_id);
    var token = jwtUtil.generateToken(buildTokenPayload(row));
    setAuthCookie(res, token);

    console.log('[Auth] 新用户注册: %s %s %s班 %s届', alloc.user_id, net_name, profile.classNo, profile.year);
    return res.json({
      code: 200,
      message: alloc.overflow
        ? '注册成功（本班学号已满，已分配备用学号）'
        : '注册成功',
      data: { user_info: buildUserInfo(row), token: token }
    });
  } catch (err) {
    console.error('[Auth] register error:', err);
    return res.json({ code: 500, message: '服务器内部错误', data: null });
  }
});

// ============================================================
// POST /api/auth/login —— 本地校验优先，ClassIntra 委托校验兜底
// ============================================================
router.post('/login', function(req, res) {
  try {
    var account = String(req.body.account || '').trim();
    var password = req.body.password;

    if (!account || !password) {
      return res.json({ code: 400, message: '请输入账号和密码', data: null });
    }

    // 1) 本地查找：账号 / 学号 / 网名 / 姓名都可能匹配
    var candidates = db.prepare(
      'SELECT * FROM users WHERE user_id = ? OR net_name = ? OR real_name = ?'
    ).all(account, account, account);

    // 排序：学号精确匹配优先 → 有本地密码的优先 → 建号顺序
    candidates.sort(function(a, b) {
      var aExact = a.user_id === account ? 0 : 1;
      var bExact = b.user_id === account ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      var aHasPwd = a.password_hash ? 0 : 1;
      var bHasPwd = b.password_hash ? 0 : 1;
      if (aHasPwd !== bHasPwd) return aHasPwd - bHasPwd;
      return (a.id || 0) - (b.id || 0);
    });

    var user = null;
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i].password_hash) continue;
      if (pwdUtil.verifyPassword(password, candidates[i].password_hash)) {
        user = candidates[i];
        break;
      }
    }

    if (user) {
      return finishLogin(user, res, false);
    }

    // 2) 本地未通过 → 若配置了 ClassIntra 联动，交给它校验
    if (!ciBridge.isEnabled()) {
      return res.json({ code: 401, message: '账号或密码错误', data: null });
    }

    ciBridge.verifyWithClassIntra(account, password).then(function(result) {
      if (!result.ok) {
        var msg = result.reason === 'network' ? '账号或密码错误（ClassIntra 联动暂不可用）' : '账号或密码错误';
        return res.json({ code: 401, message: msg, data: null });
      }

      var ciUser = result.user;
      var existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(ciUser.user_id));
      var passwordHash = ciUser.password_hash || '';

      try {
        if (existing) {
          // 已引入过：补上密码哈希（可能上次引入时为空），保持可离线登录
          if (passwordHash && existing.password_hash !== passwordHash) {
            db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').run(passwordHash, existing.user_id);
          }
          existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(existing.user_id);
        } else {
          var nowUtc = time.nowUtc();
          // 从 ClassIntra 引入时同步其班级信息（CI 的 user_id 编码 YYCCNN，可解出）
          var ciClassNo = String(ciUser.class_no || '').trim() ||
            (/^\d{6}$/.test(String(ciUser.user_id)) ? String(ciUser.user_id).slice(2, 4) : '');
          var ciYear = String(ciUser.enrollment_year || '').trim() ||
            (/^\d{6}$/.test(String(ciUser.user_id)) ? '20' + String(ciUser.user_id).slice(0, 2) : '');
          db.prepare([
            'INSERT INTO users (user_id, net_name, real_name, gender, password_hash, status, is_admin, info_json, source,',
            '  enrollment_year, class_no, created_at)',
            'VALUES (?, ?, ?, ?, ?, \'active\', 0, \'{}\', \'classintra\', ?, ?, ?)'
          ].join('\n')).run(
            String(ciUser.user_id),
            String(ciUser.net_name || ciUser.real_name || ciUser.user_id),
            String(ciUser.real_name || ciUser.net_name || ciUser.user_id),
            String(ciUser.gender || ''),
            passwordHash,
            ciYear, ciClassNo,
            nowUtc
          );
          existing = db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(ciUser.user_id));
          console.log('[Auth] 已引入 ClassIntra 账号:', existing.user_id);
        }
      } catch (e) {
        console.error('[Auth] ClassIntra 账号落库失败:', e.message);
        return res.json({ code: 500, message: '登录失败：账号写入异常，请联系管理员', data: null });
      }

      return finishLogin(existing, res, true);
    }).catch(function(err) {
      console.error('[Auth] CI 联动登录异常:', err.message);
      return res.json({ code: 500, message: '服务器内部错误', data: null });
    });
  } catch (err) {
    console.error('[Auth] login error:', err);
    return res.json({ code: 500, message: '服务器内部错误', data: null });
  }
});

// 登录收尾：更新登录时间、签发令牌、返回用户信息
function finishLogin(row, res, fromClassIntra) {
  db.prepare('UPDATE users SET last_login = ? WHERE user_id = ?').run(time.nowUtc(), row.user_id);
  row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(row.user_id);

  var token = jwtUtil.generateToken(buildTokenPayload(row));
  setAuthCookie(res, token);

  var info = buildUserInfo(row);
  if (fromClassIntra) info.from_classintra = true;
  return res.json({ code: 200, message: '登录成功', data: { user_info: info, token: token } });
}

// ============================================================
// POST /api/auth/refresh-token
// ============================================================
router.post('/refresh-token', function(req, res) {
  try {
    var token = auth.extractToken(req);
    if (!token) return res.json({ code: 401, message: '未登录', data: null });

    var result = jwtUtil.verifyToken(token);
    if (!result.valid) return res.json({ code: 401, message: '登录已过期，请重新登录', data: null });

    var row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(String(result.data.user_id));
    if (!row) return res.json({ code: 401, message: '用户不存在', data: null });
    if (row.status === 'disabled') return res.json({ code: 403, message: '该账号已被禁用', data: null });

    var newToken = jwtUtil.generateToken(buildTokenPayload(row));
    setAuthCookie(res, newToken);
    return res.json({
      code: 200,
      message: '令牌刷新成功',
      data: { token: newToken, user_info: buildUserInfo(row) }
    });
  } catch (err) {
    console.error('[Auth] refresh error:', err);
    return res.json({ code: 500, message: '服务器内部错误', data: null });
  }
});

// ============================================================
// GET /api/auth/check-status —— 前端心跳
// ============================================================
router.get('/check-status', auth.requireAuth, function(req, res) {
  try {
    var row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(req.user.user_id);
    if (!row) return res.json({ code: 401, message: '用户不存在', data: null });
    if (row.status === 'disabled') return res.json({ code: 403, message: '该账号已被禁用', data: null });

    return res.json({
      code: 200,
      message: 'ok',
      data: { user_info: buildUserInfo(row) }
    });
  } catch (err) {
    console.error('[Auth] check-status error:', err);
    return res.json({ code: 500, message: '服务器内部错误', data: null });
  }
});

// ============================================================
// POST /api/auth/logout
// ============================================================
router.post('/logout', function(req, res) {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax' });
  return res.json({ code: 200, message: '已退出登录', data: null });
});

// ============================================================
// POST /api/auth/change-password —— 本地账号可自助改密
// ============================================================
router.post('/change-password', auth.requireAuth, function(req, res) {
  try {
    var oldPassword = req.body.old_password;
    var newPassword = req.body.new_password;
    var confirm = req.body.confirm_password;

    if (!oldPassword || !newPassword) {
      return res.json({ code: 400, message: '请填写原密码和新密码', data: null });
    }
    if (newPassword !== confirm) {
      return res.json({ code: 400, message: '两次输入的新密码不一致', data: null });
    }
    var strength = pwdUtil.checkPasswordStrength(newPassword);
    if (!strength.valid) return res.json({ code: 400, message: strength.message, data: null });

    var row = db.prepare('SELECT * FROM users WHERE user_id = ?').get(req.user.user_id);
    if (!row) return res.json({ code: 404, message: '用户不存在', data: null });

    if (row.source === 'classintra') {
      return res.json({
        code: 400,
        message: '该账号由 ClassIntra 管理，请到 ClassIntra 修改密码',
        data: null
      });
    }

    if (!pwdUtil.verifyPassword(oldPassword, row.password_hash)) {
      return res.json({ code: 401, message: '原密码错误', data: null });
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?')
      .run(pwdUtil.hashPassword(newPassword), row.user_id);
    console.log('[Auth] 用户改密:', row.user_id);
    return res.json({ code: 200, message: '密码已修改', data: null });
  } catch (err) {
    console.error('[Auth] change-password error:', err);
    return res.json({ code: 500, message: '服务器内部错误', data: null });
  }
});

module.exports = router;
module.exports.buildUserInfo = buildUserInfo;