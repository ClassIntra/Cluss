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

  // 先编译再用展开传参：better-sqlite3 不接受参数数组（会被当具名参数对象）
  var stmt = db.prepare(sql);
  var rows = stmt.all.apply(stmt, params);

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

  var stmt2 = db.prepare(sql);
  var rows = stmt2.all.apply(stmt2, params);
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

// ============================================================
// 模型管理
//
// 设计原则：改完即时生效，不做缓存 —— 每次对话都重新 resolveModel，
// 所以改单价/换 Key 不需要重启服务，也不需要清缓存。
// ============================================================

// API Key 掩码：管理台要能看出「配了没配」，但不该把完整 Key 回传到浏览器
function maskKey(key) {
  var k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '••••';
  return k.slice(0, 4) + '••••' + k.slice(-4);
}

function serializeModelForAdmin(r) {
  return {
    id: r.id,
    label: r.label,
    api_url: r.api_url || '',
    api_key_masked: maskKey(r.api_key),
    has_api_key: !!r.api_key,
    model_name: r.model_name || '',
    api_style: r.api_style || 'openai',
    supports_stream: r.supports_stream !== 0 ? 1 : 0,
    supports_vision: r.supports_vision === 1 ? 1 : 0,
    vision_max_images: r.vision_max_images || 0,
    price_in: r.price_in || 0,
    price_out: r.price_out || 0,
    price_cache_hit: r.price_cache_hit || 0,
    is_free: r.is_free === 1 ? 1 : 0,
    enabled: r.enabled === 1 ? 1 : 0,
    is_default: r.is_default === 1 ? 1 : 0,
    sort_order: r.sort_order || 0,
    created_at: time.toISO(r.created_at)
  };
}

router.get('/models', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var rows = db.prepare('SELECT * FROM ai_models ORDER BY sort_order ASC, id ASC').all();
  var vision = require('../services/vision').getVisionConfig();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      models: rows.map(serializeModelForAdmin),
      default_model: (function() {
        var d = db.prepare('SELECT id FROM ai_models WHERE is_default = 1 LIMIT 1').get();
        return d ? d.id : '';
      })(),
      vision_relay_model_id: vision.relayModelId,
      // 单价提示：单位是「微元/千 token」，管理员更习惯「元/百万 token」，两者数值相同（×1000 再 ÷1e6）
      price_unit_note: '填入的数值单位是「元 / 百万 token」（如 2 表示 2 元/百万）'
    }
  });
});

// 价格换算：管理台填「元/百万 token」，库里存「微元/千 token」
// 两者数值恰好相同（1 元/1M = 1e6 微元 / 1000 千 = 1000 微元/千），
// 所以这里只需整数化，不做乘除 —— 这个巧合让输入与存储可以同值，少一个出错点
function parsePrice(v, label) {
  var n = Number(v);
  if (!isFinite(n) || n < 0) return { ok: false, message: label + '必须是不小于 0 的数字' };
  if (n > 100000) return { ok: false, message: label + '过大（上限 100000）' };
  return { ok: true, value: Math.round(n) };
}

function validateModelInput(body, isCreate) {
  var b = body || {};
  var out = {};

  if (isCreate) {
    var id = String(b.id || '').trim();
    if (!id) return { ok: false, message: '模型 ID 不能为空' };
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) {
      return { ok: false, message: '模型 ID 只能用字母、数字、点、下划线、短横线' };
    }
    out.id = id;
  }

  if (b.label !== undefined) out.label = String(b.label || '').trim().slice(0, 60) || 'unnamed';
  if (b.api_url !== undefined) out.api_url = String(b.api_url || '').trim().slice(0, 300);
  if (b.api_key !== undefined) out.api_key = String(b.api_key || '').trim().slice(0, 400);
  if (b.model_name !== undefined) out.model_name = String(b.model_name || '').trim().slice(0, 120);
  if (b.api_style !== undefined) out.api_style = b.api_style === 'deepseek' ? 'deepseek' : 'openai';

  if (b.supports_stream !== undefined) out.supports_stream = b.supports_stream ? 1 : 0;
  if (b.supports_vision !== undefined) out.supports_vision = b.supports_vision ? 1 : 0;
  if (b.vision_max_images !== undefined) {
    var vm = parseInt(b.vision_max_images, 10);
    out.vision_max_images = isFinite(vm) && vm > 0 ? Math.min(vm, 6) : 0;
  }
  if (b.is_free !== undefined) out.is_free = b.is_free ? 1 : 0;
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = parseInt(b.sort_order, 10) || 0;

  var fields = [
    ['price_in', '输入单价'],
    ['price_out', '输出单价'],
    ['price_cache_hit', '缓存命中单价']
  ];
  for (var i = 0; i < fields.length; i++) {
    var key = fields[i][0];
    if (b[key] !== undefined && b[key] !== '') {
      var p = parsePrice(b[key], fields[i][1]);
      if (!p.ok) return p;
      out[key] = p.value;
    }
  }

  return { ok: true, data: out };
}

router.post('/models', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var v = validateModelInput(req.body, true);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  var exists = db.prepare('SELECT id FROM ai_models WHERE id = ?').get(d.id);
  if (exists) return res.status(409).json({ code: 409, message: '该模型 ID 已存在' });

  db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style,',
    '  supports_thinking, supports_stream, supports_vision, vision_max_images,',
    '  price_in, price_out, price_cache_hit, is_free, enabled, is_default, sort_order, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ].join('\n')).run(
    d.id, d.label || d.id, d.api_url || '', d.api_key || '', d.model_name || d.id, d.api_style || 'openai',
    d.supports_stream === undefined ? 1 : d.supports_stream,
    d.supports_vision || 0, d.vision_max_images || 0,
    d.price_in || 0, d.price_out || 0, d.price_cache_hit || 0,
    d.is_free || 0, d.enabled === undefined ? 1 : d.enabled,
    d.sort_order || 0, time.nowUtc()
  );

  console.log('[Admin] 新增模型: %s by %s', d.id, req.user.user_id);
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(d.id);
  res.json({ code: 200, message: '已添加', data: serializeModelForAdmin(row) });
});

router.put('/models/:id', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });

  var v = validateModelInput(req.body, false);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  // api_key 留空表示「不修改」：否则管理员只改单价时会把 Key 清掉
  if (d.api_key !== undefined && !d.api_key) delete d.api_key;

  var keys = Object.keys(d);
  if (!keys.length) return res.status(400).json({ code: 400, message: '没有要修改的内容' });

  var sets = [];
  var params = [];
  for (var i = 0; i < keys.length; i++) {
    sets.push(keys[i] + ' = ?');
    params.push(d[keys[i]]);
  }
  params.push(id);

  var stmt = db.prepare('UPDATE ai_models SET ' + sets.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, params);

  console.log('[Admin] 更新模型: %s by %s', id, req.user.user_id);
  res.json({
    code: 200,
    message: '已更新',
    data: serializeModelForAdmin(db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id))
  });
});

// 删除：若已被会话引用则改为软禁用
// 硬删会让历史会话的 model_id 指向不存在的模型，管理台的用量统计就 JOIN 不出名字了
router.delete('/models/:id', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });

  var total = db.prepare('SELECT COUNT(*) AS c FROM ai_models').get().c;
  if (total <= 1) {
    return res.status(400).json({ code: 400, message: '至少要保留一个模型' });
  }

  var used = db.prepare(
    'SELECT COUNT(*) AS c FROM ai_conversations WHERE model_id = ?'
  ).get(id).c;

  if (used > 0) {
    db.prepare('UPDATE ai_models SET enabled = 0, is_default = 0 WHERE id = ?').run(id);
    console.log('[Admin] 模型已被 %d 个会话引用，改为禁用: %s', used, id);
    return res.json({
      code: 200,
      message: '该模型已被 ' + used + ' 个会话使用，已改为「禁用」而非删除（保留历史记录可追溯）',
      data: { soft_disabled: true }
    });
  }

  db.prepare('DELETE FROM ai_models WHERE id = ?').run(id);
  console.log('[Admin] 删除模型: %s by %s', id, req.user.user_id);
  res.json({ code: 200, message: '已删除', data: { soft_disabled: false } });
});

router.post('/models/:id/set-default', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });
  if (row.enabled !== 1) return res.status(400).json({ code: 400, message: '禁用的模型不能设为默认' });

  var tx = db.transaction(function() {
    db.prepare('UPDATE ai_models SET is_default = 0').run();
    db.prepare('UPDATE ai_models SET is_default = 1 WHERE id = ?').run(id);
  });
  tx();

  console.log('[Admin] 默认模型改为: %s by %s', id, req.user.user_id);
  res.json({ code: 200, message: '已设为默认模型', data: { default_model: id } });
});

// 连通性测试：发一条最小请求，验证地址与 Key 是否可用
router.post('/models/:id/test', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var id = String(req.params.id || '');
  var ai = require('../services/ai');
  var mc = ai.resolveModel(id);
  if (!mc) return res.status(404).json({ code: 404, message: '模型不存在' });
  if (!mc.ready) {
    return res.status(400).json({ code: 400, message: '模型未配置完成：' + mc.unavailableReason });
  }

  var started = Date.now();
  ai.chatOnce(mc, [
    { role: 'system', content: '你是连通性测试助手。' },
    { role: 'user', content: '请只回复两个字：正常' }
  ], { timeout: 30000, temperature: 0 }).then(function(data) {
    var text = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    res.json({
      code: 200,
      message: '连通正常',
      data: {
        ok: true,
        reply: String(text || '').slice(0, 100),
        elapsed_ms: Date.now() - started,
        usage: data && data.usage ? {
          prompt_tokens: data.usage.prompt_tokens || 0,
          completion_tokens: data.usage.completion_tokens || 0
        } : null
      }
    });
  }).catch(function(err) {
    res.json({
      code: 200,
      message: '测试失败',
      data: {
        ok: false,
        error: err.message || '调用失败',
        detail: err.detail || '',
        elapsed_ms: Date.now() - started
      }
    });
  });
});

// ============================================================
// 视觉配置
// ============================================================
router.get('/vision', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var vision = require('../services/vision');
  var cfg = vision.getVisionConfig();
  var rows = db.prepare('SELECT id, label, supports_vision, enabled, api_key, api_url FROM ai_models ORDER BY sort_order ASC').all();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      enabled: cfg.enabled,
      relay_model_id: cfg.relayModelId,
      max_images: cfg.maxImages,
      image_max_edge: cfg.imageMaxEdge,
      image_quality: cfg.imageQuality,
      shrink_enabled: cfg.shrinkEnabled,
      sharp_available: vision.sharpAvailable,
      // 只有自身支持视觉且可用的模型才能当转述模型
      relay_candidates: rows.filter(function(r) {
        return r.supports_vision === 1 && r.enabled === 1 && r.api_key && r.api_url;
      }).map(function(r) {
        return { id: r.id, label: r.label };
      })
    }
  });
});

router.put('/vision', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var vision = require('../services/vision');
  var b = req.body || {};
  var patch = {};

  if (b.enabled !== undefined) patch.vision_enabled = b.enabled ? '1' : '0';
  if (b.shrink_enabled !== undefined) patch.image_shrink_enabled = b.shrink_enabled ? '1' : '0';

  if (b.relay_model_id !== undefined) {
    var relayId = String(b.relay_model_id || '').trim();
    if (relayId) {
      // 转述模型必须自己支持视觉，否则转述本身就无法工作
      var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(relayId);
      if (!row) return res.status(404).json({ code: 404, message: '转述模型不存在' });
      if (row.supports_vision !== 1) {
        return res.status(400).json({ code: 400, message: '转述模型必须自身支持视觉，请先在该模型上勾选「支持视觉」' });
      }
    }
    patch.vision_relay_model_id = relayId;
  }

  if (b.max_images !== undefined) {
    var n = parseInt(b.max_images, 10);
    if (!isFinite(n) || n < 1) return res.status(400).json({ code: 400, message: '最多图片数必须大于 0' });
    patch.vision_max_images = String(Math.min(n, 6));
  }
  if (b.image_max_edge !== undefined) {
    var e = parseInt(b.image_max_edge, 10);
    if (!isFinite(e) || e < 200) return res.status(400).json({ code: 400, message: '长边上限至少 200' });
    patch.image_max_edge = String(Math.min(e, 4096));
  }
  if (b.image_quality !== undefined) {
    var q = parseInt(b.image_quality, 10);
    if (!isFinite(q) || q < 1) return res.status(400).json({ code: 400, message: '压缩质量必须在 1~100' });
    patch.image_quality = String(Math.min(q, 100));
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ code: 400, message: '没有要修改的配置' });
  }

  var stmt = db.prepare(
    'INSERT INTO cluss_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  var tx = db.transaction(function() {
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i++) stmt.run(keys[i], patch[keys[i]]);
  });
  tx();

  console.log('[Admin] 视觉配置更新 by %s: %j', req.user.user_id, patch);
  var cfg = vision.getVisionConfig();
  res.json({
    code: 200,
    message: '已保存',
    data: {
      enabled: cfg.enabled,
      relay_model_id: cfg.relayModelId,
      max_images: cfg.maxImages,
      image_max_edge: cfg.imageMaxEdge,
      image_quality: cfg.imageQuality,
      shrink_enabled: cfg.shrinkEnabled
    }
  });
});

// 单图转述测试：验证转述链路是否通（排障用，学生看不到）
router.post('/vision/test', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var vision = require('../services/vision');
  var cfg = vision.getVisionConfig();

  if (!cfg.relayModelId) {
    return res.status(400).json({ code: 400, message: '尚未配置转述模型' });
  }
  var hash = String(req.body.hash || '').trim();
  if (!hash) return res.status(400).json({ code: 400, message: '请提供要测试的图片 hash' });

  var relay = require('../services/ai').resolveModel(cfg.relayModelId);
  if (!relay || !relay.ready) {
    return res.status(400).json({ code: 400, message: '转述模型不可用（未启用或缺 API Key）' });
  }

  var loaded = vision.loadImageItems(req.user.user_id, [hash], {});
  if (loaded.error) return res.status(400).json({ code: 400, message: loaded.error });

  var started = Date.now();
  vision.shrinkAll(loaded.items, null).then(function(items) {
    return vision.describeImages(relay, items, null);
  }).then(function(r) {
    res.json({
      code: 200,
      message: '转述完成',
      data: {
        ok: true,
        model: cfg.relayModelId,
        elapsed_ms: Date.now() - started,
        text: r.text,
        failed: r.failed.length
      }
    });
  }).catch(function(err) {
    res.status(500).json({ code: 500, message: '转述失败：' + (err.message || '未知错误') });
  });
});

// ============================================================
// 全站用量统计
// ============================================================
router.get('/usage/summary', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var stats = require('../services/usage-stats');
  var win = stats.resolveWindow(req.query);
  var groupBy = String(req.query.group_by || 'user');
  if (['user', 'model', 'day', 'source', 'instance'].indexOf(groupBy) < 0) groupBy = 'user';

  var data = stats.summary({
    userId: String(req.query.user_id || ''),
    classNo: String(req.query.class_no || ''),
    from: win.from,
    to: win.to,
    days: win.days,
    groupBy: groupBy
  });

  res.json({ code: 200, message: 'ok', data: data });
});

router.get('/usage/records', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var stats = require('../services/usage-stats');
  var win = stats.resolveWindow(req.query);

  var data = stats.records({
    userId: String(req.query.user_id || ''),
    from: win.from,
    to: win.to,
    modelId: String(req.query.model_id || ''),
    source: String(req.query.source || ''),
    page: req.query.page,
    limit: req.query.limit
  });

  data.window = { from: win.from, to: win.to, days: win.days };
  res.json({ code: 200, message: 'ok', data: data });
});

router.get('/usage/export.csv', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var stats = require('../services/usage-stats');
  var win = stats.resolveWindow(req.query);

  var data = stats.records({
    userId: String(req.query.user_id || ''),
    from: win.from,
    to: win.to,
    modelId: String(req.query.model_id || ''),
    source: String(req.query.source || ''),
    page: 1,
    limit: 200
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cluss-usage-all.csv"');
  res.send(stats.recordsToCsv(data.items));
});

module.exports = router;
module.exports.bumpAssignVersion = bumpAssignVersion;