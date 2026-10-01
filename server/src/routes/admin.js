// 管理端路由（仅中继权威节点使用）
//
// 使用场景：学生线下转账 → 老师在中继管理台给账号开通额度 → 下发到各班级节点
//
// 关键约定：
//   1. 所有充值/调整都写 cluss_credit_log（只增不改），operator_id 记录操作人，可追溯
//   2. 变更后 bump 分配版本号，班级节点靠版本号判断是否需要拉取
//   3. 批量操作包在一个事务里，要么全成要么全不成

var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var auth = require('../middleware/auth');
var credit = require('../services/credit');
var config = require('../config');
var constants = require('../utils/constants');
var initDb = require('../utils/init-db');

var MAX_ASSIGN_YUAN = 10000;   // 单次分配上限，防止误输多个零
var MAX_WEEKLY_YUAN = 10000;

// 分配版本号：每次下发变更自增，节点据此判断是否要重新拉取
function bumpAssignVersion() {
  var cur = parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
  var next = cur + 1;
  initDb.setMeta('assign_version', next);
  return next;
}

function currentAssignVersion() {
  return parseInt(initDb.getMeta('assign_version', '0'), 10) || 0;
}

// 校验金额输入（元 → 微元）
function parseYuan(value, label) {
  var n = Number(value);
  if (!isFinite(n) || n < 0) {
    return { ok: false, message: label + '必须是不小于 0 的数字' };
  }
  if (n > MAX_ASSIGN_YUAN) {
    return { ok: false, message: label + '不能超过 ' + MAX_ASSIGN_YUAN + ' 元' };
  }
  return { ok: true, micro: config.yuanToMicro(n) };
}

// ============================================================
// GET /admin/users —— 用户列表（含额度、消耗、本班聚合）
// ============================================================
router.get('/users', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var keyword = String(req.query.keyword || '').trim();
  var onlyAllocated = String(req.query.filter || '') === 'allocated';
  var limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);

  var params = [];
  var where = [];
  if (keyword) {
    where.push('(u.user_id LIKE ? OR u.net_name LIKE ? OR u.real_name LIKE ?)');
    params.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  if (onlyAllocated) {
    where.push('IFNULL(c.allocated_micro, 0) > 0');
  }

  var sql = [
    'SELECT u.user_id, u.net_name, u.real_name, u.status, u.source, u.created_at, u.last_login,',
    '       IFNULL(c.allocated_micro, 0) AS allocated_micro,',
    '       IFNULL(c.weekly_quota_micro, 0) AS weekly_quota_micro,',
    '       IFNULL(s.used_micro, 0) AS used_micro,',
    '       IFNULL(s.calls, 0) AS calls,',
    '       s.last_at',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'LEFT JOIN (',
    '  SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls, MAX(created_at) AS last_at',
    '  FROM cluss_usage_log GROUP BY user_id',
    ') s ON s.user_id = u.user_id'
  ].join('\n');
  if (where.length) sql += '\nWHERE ' + where.join(' AND ');
  sql += '\nORDER BY allocated_micro DESC, used_micro DESC LIMIT ?';
  params.push(limit);

  var rows = db.prepare(sql).all.apply(db.prepare(sql), params);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      assign_version: currentAssignVersion(),
      users: rows.map(function(r) {
        return {
          user_id: r.user_id,
          net_name: r.net_name,
          real_name: r.real_name,
          status: r.status,
          source: r.source || 'local',
          allocated_yuan: config.microToYuan(r.allocated_micro).toFixed(2),
          allocated_micro: r.allocated_micro,
          used_yuan: config.microToYuan(r.used_micro).toFixed(2),
          used_micro: r.used_micro,
          // 注意：这里显示的是「本节点已记录的消耗」，跨班消耗要到节点上报后才齐全
          remaining_yuan: config.microToYuan(r.allocated_micro - r.used_micro).toFixed(2),
          weekly_quota_yuan: config.microToYuan(r.weekly_quota_micro).toFixed(2),
          calls: r.calls,
          last_at: time.toISO(r.last_at),
          created_at: time.toISO(r.created_at)
        };
      })
    }
  });
});

// ============================================================
// PUT /admin/users/:userId/quota —— 单个用户分配/调整额度
// body: { quota_yuan, weekly_yuan, reason }
// ============================================================
router.put('/users/:userId/quota', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var userId = String(req.params.userId || '').trim();
  var user = db.prepare('SELECT user_id, net_name, real_name FROM users WHERE user_id = ?').get(userId);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在：' + userId });

  var parsed = parseYuan(req.body.quota_yuan, '额度');
  if (!parsed.ok) return res.status(400).json({ code: 400, message: parsed.message });

  var weeklyMicro = 0;
  if (req.body.weekly_yuan !== undefined && req.body.weekly_yuan !== '' && req.body.weekly_yuan !== null) {
    var w = parseYuan(req.body.weekly_yuan, '周限额');
    if (!w.ok) return res.status(400).json({ code: 400, message: w.message });
    if (w.micro > MAX_WEEKLY_YUAN * 1000000) return res.status(400).json({ code: 400, message: '周限额过大' });
    weeklyMicro = w.micro;
  }

  var before = credit.getAssignment(userId);
  var idemKey = constants.makeIdemKey([
    'topup', userId, String(parsed.micro), String(weeklyMicro), String(Date.now()), config.instanceId
  ]);

  credit.applyAssignment({
    user_id: userId,
    allocated_micro: parsed.micro,
    weekly_quota_micro: weeklyMicro,
    assigned_by: req.user.user_id,
    idem_key: idemKey,
    kind: parsed.micro >= Number(before.allocated_micro || 0) ? 'topup' : 'adjust',
    reason: String(req.body.reason || ''),
    origin_instance: config.instanceId
  });

  var version = bumpAssignVersion();
  console.log('[Admin] 额度已设置: %s (%s) → %s 元 / 周限额 %s 元，操作人 %s',
    userId, user.real_name, config.microToYuan(parsed.micro), config.microToYuan(weeklyMicro), req.user.user_id);

  res.json({
    code: 200,
    message: '已更新',
    data: { user_id: userId, allocated_yuan: config.microToYuan(parsed.micro).toFixed(2), assign_version: version }
  });
});

// ============================================================
// POST /admin/users/quota/batch —— 批量分配（充值时最常见）
// body: { items: [{ user_id, quota_yuan, weekly_yuan? }], reason? }
// ============================================================
router.post('/users/quota/batch', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ code: 400, message: '没有要处理的用户' });
  if (items.length > 200) return res.status(400).json({ code: 400, message: '单次最多处理 200 个用户' });

  var results = [];
  var failed = [];

  var tx = db.transaction(function() {
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var userId = String(it.user_id || '').trim();
      var parsed = parseYuan(it.quota_yuan, '额度');

      if (!userId) { failed.push({ user_id: userId, message: '用户ID为空' }); continue; }
      if (!parsed.ok) { failed.push({ user_id: userId, message: parsed.message }); continue; }

      var user = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
      if (!user) { failed.push({ user_id: userId, message: '用户不存在' }); continue; }

      var weeklyMicro = 0;
      if (it.weekly_yuan !== undefined && it.weekly_yuan !== '' && it.weekly_yuan !== null) {
        var w = parseYuan(it.weekly_yuan, '周限额');
        if (!w.ok) { failed.push({ user_id: userId, message: w.message }); continue; }
        weeklyMicro = w.micro;
      }

      var idemKey = constants.makeIdemKey([
        'batch', userId, String(parsed.micro), String(weeklyMicro), String(Date.now()), config.instanceId, String(i)
      ]);

      credit.applyAssignment({
        user_id: userId,
        allocated_micro: parsed.micro,
        weekly_quota_micro: weeklyMicro,
        assigned_by: req.user.user_id,
        idem_key: idemKey,
        kind: 'topup',
        reason: String(req.body.reason || '批量充值'),
        origin_instance: config.instanceId
      });

      results.push({ user_id: userId, allocated_yuan: config.microToYuan(parsed.micro).toFixed(2) });
    }
  });

  try {
    tx();
  } catch (err) {
    console.error('[Admin] 批量分配失败:', err.message);
    return res.status(500).json({ code: 500, message: '批量操作失败，已回滚：' + err.message });
  }

  var version = results.length ? bumpAssignVersion() : currentAssignVersion();
  console.log('[Admin] 批量分配完成: 成功 %d 个，失败 %d 个，操作人 %s', results.length, failed.length, req.user.user_id);

  res.json({
    code: 200,
    message: '成功 ' + results.length + ' 个' + (failed.length ? '，失败 ' + failed.length + ' 个' : ''),
    data: { succeeded: results, failed: failed, assign_version: version }
  });
});

// ============================================================
// DELETE /admin/users/:userId/quota —— 收回额度（清零）
// ============================================================
router.delete('/users/:userId/quota', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var userId = String(req.params.userId || '').trim();
  var user = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });

  var idemKey = constants.makeIdemKey(['revoke', userId, String(Date.now()), config.instanceId]);
  credit.applyAssignment({
    user_id: userId,
    allocated_micro: 0,
    weekly_quota_micro: 0,
    assigned_by: req.user.user_id,
    idem_key: idemKey,
    kind: 'revoke',
    reason: String(req.body && req.body.reason || '管理员收回额度'),
    origin_instance: config.instanceId
  });

  var version = bumpAssignVersion();
  console.log('[Admin] 额度已收回: %s，操作人 %s', userId, req.user.user_id);
  res.json({ code: 200, message: '已收回额度', data: { assign_version: version } });
});

// ============================================================
// GET /admin/logs —— 额度流水（对账凭据）
// ============================================================
router.get('/logs', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  var userId = String(req.query.user_id || '').trim();

  var sql = [
    'SELECT l.*, u.net_name, u.real_name',
    'FROM cluss_credit_log l',
    'LEFT JOIN users u ON u.user_id = l.user_id'
  ].join('\n');
  var params = [];
  if (userId) {
    sql += '\nWHERE l.user_id = ?';
    params.push(userId);
  }
  sql += '\nORDER BY l.id DESC LIMIT ?';
  params.push(limit);

  var rows = db.prepare(sql).all.apply(db.prepare(sql), params);
  res.json({
    code: 200,
    message: 'ok',
    data: {
      logs: rows.map(function(r) {
        return {
          id: r.id,
          user_id: r.user_id,
          net_name: r.net_name,
          real_name: r.real_name,
          amount_yuan: config.microToYuan(r.amount_micro).toFixed(2),
          amount_micro: r.amount_micro,
          kind: r.kind,
          reason: r.reason,
          operator_id: r.operator_id,
          origin_instance: r.origin_instance,
          created_at: time.toISO(r.created_at)
        };
      })
    }
  });
});

// ============================================================
// GET /admin/nodes —— 已接入的班级节点（按上报数据聚合）
// ============================================================
router.get('/nodes', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var rows = db.prepare([
    'SELECT origin_instance, COUNT(*) AS calls, SUM(cost_micro) AS cost_micro, MAX(created_at) AS last_at',
    'FROM cluss_usage_log WHERE origin_instance != \'\' GROUP BY origin_instance ORDER BY cost_micro DESC'
  ].join('\n')).all();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      instance_id: config.instanceId,
      mode: config.mode,
      nodes: rows.map(function(r) {
        return {
          instance_id: r.origin_instance,
          calls: r.calls,
          cost_yuan: config.microToYuan(r.cost_micro).toFixed(2),
          last_at: time.toISO(r.last_at)
        };
      })
    }
  });
});

// ============================================================
// GET /admin/dashboard —— 总览（管理台首页）
// ============================================================
router.get('/dashboard', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var totals = db.prepare([
    'SELECT',
    '  (SELECT COUNT(*) FROM users WHERE is_admin = 0) AS user_count,',
    '  (SELECT COUNT(*) FROM users WHERE CAST(user_id AS INTEGER) >= 800001 AND CAST(user_id AS INTEGER) <= 999998) AS overflow_count,',
    '  (SELECT IFNULL(SUM(allocated_micro), 0) FROM cluss_credit) AS allocated_micro,',
    '  (SELECT IFNULL(SUM(cost_micro), 0) FROM cluss_usage_log) AS used_micro,',
    '  (SELECT COUNT(*) FROM cluss_usage_log) AS calls'
  ].join('\n')).get();

  // 按班级聚合（class_no 为空的归到「未填班级」）
  var byClass = db.prepare([
    'SELECT IFNULL(NULLIF(u.class_no, \'\'), \'--\') AS class_no,',
    '       COUNT(DISTINCT u.user_id) AS students,',
    '       IFNULL(SUM(c.allocated_micro), 0) AS allocated_micro',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'WHERE u.is_admin = 0',
    'GROUP BY class_no',
    'ORDER BY class_no ASC'
  ].join('\n')).all();

  // 消耗排行（用于发现异常用量）
  var topUsers = db.prepare([
    'SELECT s.user_id, u.net_name, u.real_name, s.used_micro, s.calls,',
    '       IFNULL(c.allocated_micro, 0) AS allocated_micro',
    'FROM (SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls',
    '      FROM cluss_usage_log GROUP BY user_id) s',
    'LEFT JOIN users u ON u.user_id = s.user_id',
    'LEFT JOIN cluss_credit c ON c.user_id = s.user_id',
    'ORDER BY s.used_micro DESC LIMIT 10'
  ].join('\n')).all();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      instance_id: config.instanceId,
      mode: config.mode,
      assign_version: currentAssignVersion(),
      totals: {
        users: totals.user_count,
        overflow_users: totals.overflow_count,
        allocated_yuan: config.microToYuan(totals.allocated_micro).toFixed(2),
        used_yuan: config.microToYuan(totals.used_micro).toFixed(2),
        remaining_yuan: config.microToYuan(Math.max(0, totals.allocated_micro - totals.used_micro)).toFixed(2),
        calls: totals.calls
      },
      by_class: byClass.map(function(r) {
        return {
          class_no: r.class_no,
          students: r.students,
          allocated_yuan: config.microToYuan(r.allocated_micro).toFixed(2)
        };
      }),
      top_users: topUsers.map(function(r) {
        return {
          user_id: r.user_id,
          name: r.real_name || r.net_name || r.user_id,
          used_yuan: config.microToYuan(r.used_micro).toFixed(2),
          allocated_yuan: config.microToYuan(r.allocated_micro).toFixed(2),
          calls: r.calls
        };
      })
    }
  });
});

// ============================================================
// GET /admin/snapshot —— 导出台账（CSV，便于线下对账）
// ============================================================
router.get('/snapshot', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var rows = db.prepare([
    'SELECT u.user_id, u.net_name, u.real_name,',
    '       IFNULL(c.allocated_micro, 0) AS allocated,',
    '       IFNULL(s.used_micro, 0) AS used',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'LEFT JOIN (SELECT user_id, SUM(cost_micro) AS used_micro FROM cluss_usage_log GROUP BY user_id) s ON s.user_id = u.user_id',
    'WHERE IFNULL(c.allocated_micro, 0) > 0 OR IFNULL(s.used_micro, 0) > 0',
    'ORDER BY allocated DESC'
  ].join('\n')).all();

  var lines = ['用户ID,用户名,姓名,已分配(元),已消耗(元),余额(元)'];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    lines.push([
      r.user_id,
      String(r.net_name || '').replace(/,/g, '，'),
      String(r.real_name || '').replace(/,/g, '，'),
      config.microToYuan(r.allocated).toFixed(2),
      config.microToYuan(r.used).toFixed(2),
      config.microToYuan(r.allocated - r.used).toFixed(2)
    ].join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cluss-snapshot.csv"');
  res.send('\ufeff' + lines.join('\n'));   // BOM 让 Excel 正确识别 UTF-8
});

module.exports = router;
module.exports.bumpAssignVersion = bumpAssignVersion;