// Cluss Cloud 公共服务（多租户，024_cloud_orgs）
//
// 定位：**公共服务，不是单独的管理台**。任何部署 Cluss 的人在网页上
// 注册学校 → 拿到「学校编号 + 管理员编号 + 接入密钥」→ 填到部署设备的
// .env → 节点接入；学校管理员在本服务的「我的学校」接口上看自己班的
// 节点、额度与用量。平台运营者（relay 本机 is_admin）继续用 /api/admin/*，
// 两者数据边界互不重叠。
//
// 挂载点：/api/org（/api/cloud 已被云盘占用）。
//
// 隔离红线（设计文档 §7.1）：/my/* 的每一条查询都强制带 org_id 过滤；
// 节点同步走 /api/sync/* 的 X-Cluss-Org + 校级密钥（见 routes/sync.js）。
//
// 注册即建号：org id（不可枚举 base32）+ 管理员账号 + 校级接入密钥。
// 密钥只在注册响应里明文出现一次（库中只存 sha256），丢了只能重置。

var crypto = require('crypto');
var express = require('express');
var router = express.Router();
var db = require('../utils/db');
var time = require('../utils/time');
var config = require('../config');
var auth = require('../middleware/auth');
var credit = require('../services/credit');
var initDb = require('../utils/init-db');
var constants = require('../utils/constants');
var modelConfig = require('../services/model-config');

// 去掉易混淆字符的 base32 字母表（0/O/1/I/L 不用）
var B32_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function randomCode(len) {
  var bytes = crypto.randomBytes(len);
  var out = '';
  for (var i = 0; i < len; i++) out += B32_ALPHABET[bytes[i] % B32_ALPHABET.length];
  return out;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function bumpAssignVersion() {
  var next = (parseInt(initDb.getMeta('assign_version', '0'), 10) || 0) + 1;
  initDb.setMeta('assign_version', next);
  return next;
}

// Cloud 服务只在 relay 模式提供（node/standalone 上 404）
function requireRelayMode(req, res, next) {
  if (config.mode !== config.MODES.RELAY) {
    return res.status(404).json({ code: 404, message: '本实例未开启 Cloud 公共服务' });
  }
  next();
}

router.use(requireRelayMode);

// ---- 注册限流：同一 IP 每小时最多 5 次建校（防灌水；够真人用）----
var registerHits = {}; // ip -> [timestamps]
function registerRateLimited(ip) {
  var now = Date.now();
  var arr = (registerHits[ip] || []).filter(function(t) { return now - t < 3600 * 1000; });
  if (arr.length >= 5) { registerHits[ip] = arr; return true; }
  arr.push(now);
  registerHits[ip] = arr;
  return false;
}

// ============================================================
// POST /api/org/register —— 注册学校（公共服务入口）
// body: { school_name, region?, admin_net_name, admin_real_name, admin_password }
// ============================================================
router.post('/register', function(req, res) {
  if (registerRateLimited(req.ip || 'unknown')) {
    return res.status(429).json({ code: 429, message: '注册太频繁，请一小时后再试' });
  }

  var b = req.body || {};
  var schoolName = String(b.school_name || '').trim().slice(0, 40);
  var region = String(b.region || '').trim().slice(0, 40);
  var netName = String(b.admin_net_name || '').trim().slice(0, 20);
  // 真实姓名**刻意不收**（PII 做减法，设计文档 §4.1）：库字段非空，用用户名兜底
  var realName = String(b.admin_real_name || '').trim().slice(0, 20) || netName;
  var password = String(b.admin_password || '');

  if (schoolName.length < 2) return res.status(400).json({ code: 400, message: '请填写学校名称（至少 2 个字）' });
  if (!netName) return res.status(400).json({ code: 400, message: '请填写管理员用户名' });
  if (password.length < 8) return res.status(400).json({ code: 400, message: '管理员密码至少 8 位' });

  var dupOrg = db.prepare('SELECT id FROM cluss_orgs WHERE name = ?').get(schoolName);
  if (dupOrg) return res.status(409).json({ code: 409, message: '该学校名称已注册过，请直接用管理员编号登录，或换一个名称' });
  var dupNet = db.prepare('SELECT user_id FROM users WHERE net_name = ?').get(netName);
  if (dupNet) return res.status(409).json({ code: 409, message: '该用户名已被使用，请换一个' });

  var pwdUtil = require('../utils/password');
  var strength = pwdUtil.checkPasswordStrength(password);
  if (strength.ok === false) {
    return res.status(400).json({ code: 400, message: strength.message || '密码强度不足' });
  }

  // 学校编号：6 位去混淆字符（约 7 亿组合）。id 只用于定位学校，本身不是
  // 凭证 —— 准入靠 24 位接入密钥（约 118 bit），所以 id 短一点方便填写
  var orgId = randomCode(6);
  while (db.prepare('SELECT id FROM cluss_orgs WHERE id = ?').get(orgId)) orgId = randomCode(10);

  // 管理员编号：5 位短号（9 + 4 位数字）。学号是 6 位，串长不同天然不冲突；
  // 登录用用户名或编号都行，编号只是「忘了用户名时的备用凭据」
  var adminId = '';
  for (var tries = 0; tries < 20; tries++) {
    var cand = '9' + String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(cand)) { adminId = cand; break; }
  }
  if (!adminId) return res.status(500).json({ code: 500, message: '编号分配失败，请重试' });

  var orgSecret = randomCode(24);
  var now = time.nowUtc();

  var tx = db.transaction(function() {
    db.prepare([
      'INSERT INTO cluss_orgs (id, name, region, status, secret_hash, created_by, created_at)',
      "VALUES (?, ?, ?, 'active', ?, '', ?)"
    ].join('\n')).run(orgId, schoolName, region, sha256(orgSecret), now);

    db.prepare([
      'INSERT INTO users (user_id, net_name, real_name, password_hash, status, is_admin,',
      "  info_json, source, org_id, is_org_admin, created_at)",
      "VALUES (?, ?, ?, ?, 'active', 0, '{}', 'local', ?, 1, ?)"
    ].join('\n')).run(adminId, netName, realName, pwdUtil.hashPassword(password), orgId, now);
  });
  tx();

  console.log('[Cloud] 新学校注册: %s（%s），管理员 %s', orgId, schoolName, adminId);

  var baseUrl = config.publicBaseUrl ||
    (req.protocol + '://' + (req.get('host') || 'cloud.example'));
  res.json({
    code: 200,
    message: '注册成功',
    data: {
      org_id: orgId,
      org_name: schoolName,
      admin_user_id: adminId,
      // 接入密钥只在这次响应里明文出现，务必当场保存
      org_secret: orgSecret,
      relay_url: baseUrl,
      // 部署设备（班级节点）的 .env 模板：整块复制即可
      env_template: [
        'CLUSS_MODE=node',
        'CLUSS_INSTANCE_ID=class-01',
        'CLUSS_RELAY_URL=' + baseUrl,
        'CLUSS_ORG_ID=' + orgId,
        'CLUSS_SHARED_SECRET=' + orgSecret
      ].join('\n')
    }
  });
});

// ============================================================
// POST /api/org/join —— 节点显式接入（首启向导用）
// 心跳头也会自动注册（routes/sync.js），本接口给部署向导一个
// 「粘贴后先验证」的入口，把配置错误挡在启动阶段。
// body: { org_id, secret, instance_id, label?, node_version? }
// ============================================================
router.post('/join', function(req, res) {
  var b = req.body || {};
  var orgId = String(b.org_id || '').trim();
  var secret = String(b.secret || '');
  var instanceId = String(b.instance_id || '').trim().slice(0, 60);

  if (!orgId || !secret || !instanceId) {
    return res.status(400).json({ code: 400, message: '缺少学校编号、接入密钥或实例标识' });
  }

  var org = db.prepare('SELECT * FROM cluss_orgs WHERE id = ?').get(orgId);
  if (!org) return res.status(403).json({ code: 403, message: '学校编号不存在' });
  if (org.status !== 'active') return res.status(403).json({ code: 403, message: '该学校已被停用' });
  if (!org.secret_hash || !constants.safeCompare(sha256(secret), org.secret_hash)) {
    return res.status(403).json({ code: 403, message: '接入密钥校验失败' });
  }

  var now = time.nowUtc();
  var existing = db.prepare(
    'SELECT instance_id, status FROM cluss_nodes WHERE instance_id = ? AND org_id = ?'
  ).get(instanceId, orgId);

  if (existing && existing.status === 'revoked') {
    return res.status(403).json({ code: 403, message: '该节点已被吊销，请联系平台运营者恢复' });
  }
  if (!existing) {
    db.prepare([
      'INSERT INTO cluss_nodes (instance_id, org_id, status, first_seen_at, last_seen_at, node_version)',
      "VALUES (?, ?, 'active', ?, ?, ?)"
    ].join('\n')).run(instanceId, orgId, now, now, String(b.node_version || ''));
    console.log('[Cloud] 节点显式接入: %s（学校 %s）', instanceId, orgId);
  } else {
    db.prepare('UPDATE cluss_nodes SET last_seen_at = ?, node_version = ? WHERE instance_id = ? AND org_id = ?')
      .run(now, String(b.node_version || ''), instanceId, orgId);
  }

  res.json({
    code: 200,
    message: '接入成功',
    data: {
      org_id: orgId,
      org_name: org.name,
      instance_id: instanceId
    }
  });
});

// ---- 学校管理员鉴权：登录用户 + is_org_admin + 学校仍启用 ----
function requireOrgAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });

  var row = db.prepare('SELECT org_id, is_org_admin FROM users WHERE user_id = ?').get(req.user.user_id);
  if (!row || row.is_org_admin !== 1 || !row.org_id) {
    return res.status(403).json({ code: 403, message: '本区域仅限学校管理员' });
  }
  var org = db.prepare('SELECT * FROM cluss_orgs WHERE id = ?').get(row.org_id);
  if (!org || org.status !== 'active') {
    return res.status(403).json({ code: 403, message: '该学校已被停用' });
  }
  req.org = org;
  next();
}

router.get('/my/whoami', auth.requireAuth, requireOrgAdmin, function(req, res) {
  res.json({
    code: 200, message: 'ok',
    data: {
      org: { id: req.org.id, name: req.org.name, region: req.org.region },
      admin: { user_id: req.user.user_id, net_name: req.user.net_name, real_name: req.user.real_name }
    }
  });
});

// ============================================================
// GET /api/org/my/overview —— 学校视角：节点 + 汇总
// ============================================================
var NODE_ONLINE_WINDOW_SEC = 600;

router.get('/my/overview', auth.requireAuth, requireOrgAdmin, function(req, res) {
  var orgId = req.org.id;
  var onlineCutoff = time.fmtUtc(new Date(Date.now() - NODE_ONLINE_WINDOW_SEC * 1000));
  var nowLocal = new Date();
  var monthStartUtc = time.fmtUtc(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1));

  var nodeRows = db.prepare('SELECT * FROM cluss_nodes WHERE org_id = ? ORDER BY last_seen_at DESC').all(orgId);
  var usageStmt = db.prepare([
    'SELECT COUNT(*) AS calls,',
    '  IFNULL(SUM(cost_micro), 0) AS cost_micro,',
    '  IFNULL(SUM(CASE WHEN created_at >= ? THEN cost_micro ELSE 0 END), 0) AS month_cost_micro,',
    '  MAX(created_at) AS last_at',
    'FROM cluss_usage_log WHERE origin_instance = ? AND org_id = ?'
  ].join('\n'));

  var nodes = nodeRows.map(function(r) {
    var u = usageStmt.get(monthStartUtc, r.instance_id, orgId);
    return {
      instance_id: r.instance_id,
      label: r.label,
      status: r.status,
      online: !!r.last_seen_at && r.last_seen_at >= onlineCutoff,
      last_seen_at: r.last_seen_at ? time.toISO(r.last_seen_at) : null,
      last_report_at: r.last_report_at ? time.toISO(r.last_report_at) : null,
      node_version: r.node_version,
      last_assign_version: r.last_assign_version,
      last_model_version: r.last_model_version,
      calls: u.calls,
      cost_micro: u.cost_micro,
      month_cost_micro: u.month_cost_micro,
      last_usage_at: u.last_at ? time.toISO(u.last_at) : null
    };
  });

  var totals = db.prepare([
    'SELECT',
    '  (SELECT COUNT(*) FROM cluss_credit WHERE org_id = ? AND allocated_micro > 0) AS students,',
    '  (SELECT IFNULL(SUM(allocated_micro), 0) FROM cluss_credit WHERE org_id = ?) AS allocated_micro,',
    '  (SELECT IFNULL(SUM(cost_micro), 0) FROM cluss_usage_log WHERE org_id = ?) AS used_micro,',
    '  (SELECT COUNT(*) FROM cluss_usage_log WHERE org_id = ?) AS calls,',
    '  (SELECT IFNULL(SUM(cost_micro), 0) FROM cluss_usage_log WHERE org_id = ? AND created_at >= ?) AS month_cost_micro'
  ].join('\n')).get(orgId, orgId, orgId, orgId, orgId, monthStartUtc);

  res.json({
    code: 200, message: 'ok',
    data: {
      org: { id: req.org.id, name: req.org.name, region: req.org.region },
      assign_version: parseInt(initDb.getMeta('assign_version', '0'), 10) || 0,
      model_config_version: modelConfig.currentModelVersion(),
      online_window_sec: NODE_ONLINE_WINDOW_SEC,
      nodes: nodes,
      totals: {
        students: totals.students,
        allocated_micro: totals.allocated_micro,
        used_micro: totals.used_micro,
        calls: totals.calls,
        month_cost_micro: totals.month_cost_micro
      }
    }
  });
});

// ============================================================
// GET /api/org/my/students —— 本校额度台账（分配 − 上报消耗 = 余额推算）
// 注意：本校学生账号在各自班级节点上，中继只见学号（设计文档 §6.1 数据边界）
// ============================================================
router.get('/my/students', auth.requireAuth, requireOrgAdmin, function(req, res) {
  var orgId = req.org.id;
  var keyword = String(req.query.keyword || '').trim();
  var limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);

  // 占位符顺序与 SQL 文本一致：子查询 org_id → （关键字）→ WHERE org_id → LIMIT
  var params = [orgId];
  var where = 'WHERE c.org_id = ?';
  if (keyword) {
    where += ' AND c.user_id LIKE ?';
    params.push('%' + keyword + '%');
  }
  params.push(orgId);
  params.push(limit);

  var stmt = db.prepare([
    'SELECT c.user_id, c.allocated_micro, c.weekly_quota_micro, c.updated_at,',
    '  IFNULL(s.used_micro, 0) AS used_micro,',
    '  IFNULL(s.calls, 0) AS calls,',
    '  s.last_at',
    'FROM cluss_credit c',
    'LEFT JOIN (',
    '  SELECT user_id, SUM(cost_micro) AS used_micro, COUNT(*) AS calls, MAX(created_at) AS last_at',
    '  FROM cluss_usage_log WHERE org_id = ? GROUP BY user_id',
    ') s ON s.user_id = c.user_id',
    where,
    'ORDER BY c.updated_at DESC LIMIT ?'
  ].join('\n'));
  // better-sqlite3 不接受参数数组，用 apply 展开（与 admin.js 同款写法）
  var rows = stmt.all.apply(stmt, params);

  res.json({
    code: 200, message: 'ok',
    data: {
      students: rows.map(function(r) {
        return {
          user_id: r.user_id,
          allocated_micro: r.allocated_micro,
          weekly_quota_micro: r.weekly_quota_micro,
          used_micro: r.used_micro,
          calls: r.calls,
          balance_micro: r.allocated_micro - r.used_micro,
          last_usage_at: r.last_at ? time.toISO(r.last_at) : null,
          updated_at: time.toISO(r.updated_at)
        };
      })
    }
  });
});

// ============================================================
// POST /api/org/my/topup —— 给本校学生充值（影响半径仅本校）
// body: { user_id, amount_yuan, weekly_quota_yuan?, reason? }
// 学生账号在本班节点上，中继可能还没见过这个学号 —— 允许先分配，
// 节点拉取时只落地本地已存在的账号（services/sync.js 既有约定）
// ============================================================
var MAX_ASSIGN_YUAN = 10000;

router.post('/my/topup', auth.requireAuth, requireOrgAdmin, function(req, res) {
  var b = req.body || {};
  var userId = String(b.user_id || '').trim();
  var amountYuan = Number(b.amount_yuan);
  var weeklyYuan = b.weekly_quota_yuan === undefined || b.weekly_quota_yuan === '' ? null : Number(b.weekly_quota_yuan);

  if (!userId) return res.status(400).json({ code: 400, message: '请填写学号' });
  if (!isFinite(amountYuan) || amountYuan < 0) return res.status(400).json({ code: 400, message: '金额必须是不小于 0 的数字' });
  if (amountYuan > MAX_ASSIGN_YUAN) return res.status(400).json({ code: 400, message: '单次不能超过 ' + MAX_ASSIGN_YUAN + ' 元' });
  if (weeklyYuan !== null && (!isFinite(weeklyYuan) || weeklyYuan < 0 || weeklyYuan > MAX_ASSIGN_YUAN)) {
    return res.status(400).json({ code: 400, message: '周限额不合法' });
  }

  // 目标学生必须真的属于本校：已有分配的学校字段是唯一权威
  var existing = db.prepare('SELECT org_id FROM cluss_credit WHERE user_id = ?').get(userId);
  if (existing && existing.org_id !== req.org.id) {
    return res.status(403).json({ code: 403, message: '该学号属于另一所学校，无权操作' });
  }

  var idemKey = constants.makeIdemKey(['cloud-topup', req.org.id, userId, String(Date.now()), config.instanceId]);
  credit.applyAssignment({
    user_id: userId,
    allocated_micro: config.yuanToMicro(amountYuan),
    weekly_quota_micro: weeklyYuan === null ? 0 : config.yuanToMicro(weeklyYuan),
    assigned_by: req.user.user_id,
    origin_instance: config.instanceId,
    org_id: req.org.id,
    kind: 'topup',
    reason: String(b.reason || 'Cloud 充值'),
    idem_key: idemKey
  });

  var version = bumpAssignVersion();
  console.log('[Cloud] 充值: 学校 %s 给 %s 充 %s 元，操作人 %s',
    req.org.id, userId, amountYuan, req.user.user_id);
  res.json({
    code: 200,
    message: '已充值，各班节点将在 1 分钟内同步到',
    data: { assign_version: version }
  });
});

// ============================================================
// GET /api/org/my/logs —— 本校额度流水（对账凭据）
// 流水表没有 org_id（024 未加列），经 cluss_credit 归属推导 —— 学号归属稳定
// ============================================================
router.get('/my/logs', auth.requireAuth, requireOrgAdmin, function(req, res) {
  var orgId = req.org.id;
  var limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  var rows = db.prepare([
    'SELECT l.id, l.user_id, l.amount_micro, l.kind, l.reason, l.operator_id,',
    '  l.origin_instance, l.created_at',
    'FROM cluss_credit_log l',
    'INNER JOIN cluss_credit c ON c.user_id = l.user_id',
    'WHERE c.org_id = ?',
    'ORDER BY l.id DESC LIMIT ?'
  ].join('\n')).all(orgId, limit);

  res.json({
    code: 200, message: 'ok',
    data: {
      logs: rows.map(function(r) {
        return {
          id: r.id,
          user_id: r.user_id,
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

// ---- 节点管理（本校范围）：备注 / 吊销 / 恢复 ----
function findMyNodeOr404(req, res) {
  var instanceId = String(req.params.instanceId || '').trim();
  var row = instanceId
    ? db.prepare('SELECT * FROM cluss_nodes WHERE instance_id = ? AND org_id = ?').get(instanceId, req.org.id)
    : null;
  if (!row) {
    res.status(404).json({ code: 404, message: '节点不存在或不属于本校' });
    return null;
  }
  return row;
}

router.put('/my/nodes/:instanceId', auth.requireAuth, requireOrgAdmin, function(req, res) {
  var row = findMyNodeOr404(req, res);
  if (!row) return;
  var label = String((req.body && req.body.label) || '').trim().slice(0, 60);
  db.prepare('UPDATE cluss_nodes SET label = ? WHERE instance_id = ? AND org_id = ?')
    .run(label, row.instance_id, req.org.id);
  res.json({ code: 200, message: '已保存', data: { instance_id: row.instance_id, label: label } });
});

router.post('/my/nodes/:instanceId/revoke', auth.requireAuth, requireOrgAdmin, function(req, res) {
  var row = findMyNodeOr404(req, res);
  if (!row) return;
  db.prepare("UPDATE cluss_nodes SET status = 'revoked', revoked_at = ? WHERE instance_id = ? AND org_id = ?")
    .run(time.nowUtc(), row.instance_id, req.org.id);
  console.log('[Cloud] 节点吊销: %s（学校 %s）by %s', row.instance_id, req.org.id, req.user.user_id);
  res.json({ code: 200, message: '已吊销，该节点的同步请求将被拒绝', data: { instance_id: row.instance_id } });
});

router.post('/my/nodes/:instanceId/restore', auth.requireAuth, requireOrgAdmin, function(req, res) {
  var row = findMyNodeOr404(req, res);
  if (!row) return;
  db.prepare("UPDATE cluss_nodes SET status = 'active', revoked_at = '' WHERE instance_id = ? AND org_id = ?")
    .run(row.instance_id, req.org.id);
  res.json({ code: 200, message: '已恢复', data: { instance_id: row.instance_id } });
});

module.exports = router;
