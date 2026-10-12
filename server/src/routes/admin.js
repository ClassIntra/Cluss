// 管理端路由（仅中继权威节点使用）
//
// 使用场景：学生线下转账 → 管理员在中继管理台给账号开通额度 → 下发到各班级节点
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
var classRoster = require('../services/class-roster');
// node 模式下的出站同步（申请账号绑定确认码要走它）
var syncService = require('../services/sync');
// 模型配置下发（v1）：管理台每改一次模型/源/视觉/峰谷就 bump 版本号，
// 各班级节点靠 /sync/version 轮询到新版本后整表替换本地配置
var modelConfig = require('../services/model-config');
// 必须在**模块级**引入：parsePeakWindowsInput 是顶层函数，它要用 pricing.parseHm。
// 原先只在各路由处理函数内部 `var pricing = require(...)`，那些是函数作用域的局部量，
// 顶层函数里根本看不到 —— 结果任何一次「保存峰谷配置」都会 ReferenceError → 500。
var pricing = require('../services/pricing');

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

// node 模式下的模型/源/视觉/峰谷写入闸门（设计文档 §5.3 的演进）：
//
// 原设计是「node 模式一律只读」——那时配置只能在中枢改。2026-10-12 起
// 改成：**持有云端管理员席位的那个班**可以在本机改，改完由本节点上行推给
// 云端，云端再下发给同校所有班。这样「一校一个管理员」的设定才不会变成
// 「只有坐云端网页的人能配」——管理员在教室电脑前就能配。
//
// 非席位班仍然只读：它们改了不会同步到全校，只会造成「某班的模型悄悄
// 不一样」这类难排查问题（而且下一次下发就被覆盖，白改）。
//
// 写入权以云端告知的 is_seat_admin 为准，本机不自己认定。
function requireCanEditModelConfig(req, res, next) {
  if (config.mode !== config.MODES.NODE) return next();
  if (!syncService.isEnabled()) {
    return res.status(403).json({ code: 403, message: '本机未接入中继，无法修改全校配置' });
  }
  var st = syncService.getStatus();
  if (!st.is_seat_admin) {
    var where = st.seat_instance ? ('本校管理员席位在 ' + st.seat_instance + ' 班，本班只能查看') : '本校还没有认领管理员席位';
    return res.status(403).json({ code: 403, message: where + '。请到管理员班操作，或在云端完成账号绑定。' });
  }
  // 记下是谁改的：上行时云端要校验这个学号与席位一致
  syncService.rememberSeatUser(req.user.user_id);
  next();
}

// 模型/源/视觉/峰谷改完之后统一走这里：升版本 + 标脏待上行。
// 分散在 9 处重复写「bumpModelVersion + markPolicyDirty」迟早会漏一处，
// 漏了的表现就是「那个设置改了但同步不到全校」，很难查。
function bumpModelAndQueue(req) {
  syncService.rememberSeatUser(req.user.user_id);
  syncService.markPolicyDirty();
  var v = modelConfig.bumpModelVersion();
  // 立刻推一次，不等下个轮询周期 —— 班管改完希望马上看到「已同步全校」。
  // 推失败不阻塞本次写操作（学生要用），队列留在内存下轮重试。
  if (syncService.isEnabled()) {
    syncService.pushPending(req.user.user_id).catch(function() {});
  }
  return v;
}

// 额度改完之后走这里：升本机版本 + 入待推队列（席位班会同步全校）。
//
// 这修的是一个静默丢数据的 bug：额度路由一直**不受** requireCanEditModelConfig
// 拦截，所以 node 模式下老师改了额度确实写进了本机 —— 但没人推给云端，
// 下一次轮询 `assign_version` 被云端版本覆盖回去，改动就凭空消失了，
// 老师那边看着「加过了」，学生那边额度纹丝不动。
function bumpAssignAndQueue(req, userId, allocatedMicro, weeklyMicro, reason) {
  syncService.rememberSeatUser(req.user.user_id);
  var v = bumpAssignVersion();
  if (!syncService.isEnabled()) return v;
  syncService.queueAllocation(userId, allocatedMicro, weeklyMicro, reason, req.user.user_id);
  syncService.pushPending(req.user.user_id).catch(function() {});
  return v;
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
// GET /admin/users —— 账号列表（含额度、消耗）
//
// ⚠️ 这里**不排除管理员**，是有代价换来的（2026-10-09 实测故障）：
//   联动部署下班管（ClassIntra 的 is_class_admin）本人就是管理员，**同时也是
//   要用 Cluss 的学生**。原先按 is_admin=0 过滤，把他从表里滤掉，后果是
//   两件事同时坏掉：
//     · 他看不到自己那一行的已分配 / 已消耗 / 余额；
//     · 充值按钮是挂在每行操作列上的 —— 他在列表里找不到自己，
//       于是**自己给自己充不了钱**（接口本来是放行的，纯列表过滤挡住的）。
//   实测班管是全站第一消耗者（占 76%），滤掉他等于把主要成本从台账上抹掉。
//
// 「学生数」指标仍然只数学生（见 /admin/dashboard）：那是**人数**口径，
// 与额度 / 用量不是同一回事，不该被这里的口径带偏。
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

  // class_no 必须在这里取出来：前端要渲染班级列、并按班级下拉过滤。
  // 以前漏了它，班级列恒为「--」，选中任一班级后列表直接空掉。
  var sql = [
    'SELECT u.user_id, u.net_name, u.real_name, u.status, u.source, u.class_no, u.is_admin,',
    '       u.created_at, u.last_login,',
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
          class_no: r.class_no || '',
          // 前端据此标注管理员行（班管本人也在表里，见上方口径说明）
          is_admin: r.is_admin === 1 ? 1 : 0,
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
// 额度写入闸门（node 模式）
// ============================================================
// 和模型配置同一套逻辑：**持有云端管理员席位的班**改的额度会同步全校，
// 非席位班改了只在本机生效、下一次云端下发就被覆盖 —— 那等于让管理员
// 以为改成功了其实没有。所以非席位班直接拒，并把席位在哪个班说清楚。
//
// 注意：这条闸门以前**根本不存在**。额度路由从来不受 requireCanEditModelConfig
// 管，所以任何班改了都「成功」了，但改动只留在本机——就是那个静默丢数据的 bug。
function requireCanEditQuota(req, res, next) {
  if (config.mode !== config.MODES.NODE) return next();
  if (!syncService.isEnabled()) {
    return res.status(403).json({ code: 403, message: '本机未接入中继，无法修改全校额度' });
  }
  var st = syncService.getStatus();
  if (!st.is_seat_admin) {
    var where = st.seat_instance ? ('本校管理员席位在 ' + st.seat_instance + ' 班，本班只能查看') : '本校还没有认领管理员席位';
    return res.status(403).json({ code: 403, message: where + '。请到管理员班操作，或在云端完成账号绑定。' });
  }
  syncService.rememberSeatUser(req.user.user_id);
  next();
}

// ============================================================
// PUT /admin/users/:userId/quota —— 追加充值（叠加式）
// body: { quota_yuan, weekly_yuan?, reason? }
//
// quota_yuan 是「本次追加金额」而不是「设定总额」：新额度 = 现有额度 + 追加金额。
// 这样多次充值只需反复输入本次金额，不必每次重算/重填总额（M04 充值体验改造）。
// weekly_yuan 选填：不填则保留原周限额，避免重复填写基础信息。
// 需要下调/纠错时走 DELETE /users/:userId/quota（收回额度）。
// ============================================================
router.put('/users/:userId/quota', auth.requireAuth, auth.requireAdmin, requireCanEditQuota, function(req, res) {
  var userId = String(req.params.userId || '').trim();
  var user = db.prepare('SELECT user_id, net_name, real_name FROM users WHERE user_id = ?').get(userId);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在：' + userId });

  var parsed = parseYuan(req.body.quota_yuan, '追加金额');
  if (!parsed.ok) return res.status(400).json({ code: 400, message: parsed.message });
  if (parsed.micro <= 0) return res.status(400).json({ code: 400, message: '追加金额需大于 0' });

  var before = credit.getAssignment(userId);

  // 周限额仅在显式传入时更新；留空 = 沿用原值（叠加充值不该顺带把周限额清零）
  var weeklyMicro = Number(before.weekly_quota_micro || 0);
  if (req.body.weekly_yuan !== undefined && req.body.weekly_yuan !== '' && req.body.weekly_yuan !== null) {
    var w = parseYuan(req.body.weekly_yuan, '周限额');
    if (!w.ok) return res.status(400).json({ code: 400, message: w.message });
    if (w.micro > MAX_WEEKLY_YUAN * 1000000) return res.status(400).json({ code: 400, message: '周限额过大' });
    weeklyMicro = w.micro;
  }

  // 叠加：新额度 = 现有额度 + 本次追加
  var newAllocated = Number(before.allocated_micro || 0) + parsed.micro;
  if (config.microToYuan(newAllocated) > MAX_ASSIGN_YUAN) {
    return res.status(400).json({ code: 400, message: '累计额度不能超过 ' + MAX_ASSIGN_YUAN + ' 元' });
  }

  var idemKey = constants.makeIdemKey([
    'topup', userId, String(parsed.micro), String(weeklyMicro), String(Date.now()), config.instanceId
  ]);

  credit.applyAssignment({
    user_id: userId,
    allocated_micro: newAllocated,
    weekly_quota_micro: weeklyMicro,
    assigned_by: req.user.user_id,
    idem_key: idemKey,
    kind: 'topup',
    reason: String(req.body.reason || ''),
    origin_instance: config.instanceId
  });

  var version = bumpAssignAndQueue(req, userId, newAllocated, weeklyMicro,
    String(req.body.reason || '') || ('本机追加充值 ' + config.microToYuan(parsed.micro).toFixed(2) + ' 元'));
  console.log('[Admin] 追加充值: %s (%s) +%s → %s 元 / 周限额 %s 元，操作人 %s',
    userId, user.real_name, config.microToYuan(parsed.micro), config.microToYuan(newAllocated),
    config.microToYuan(weeklyMicro), req.user.user_id);

  res.json({
    code: 200,
    message: '已追加 ¥' + config.microToYuan(parsed.micro).toFixed(2),
    data: {
      user_id: userId,
      delta_yuan: config.microToYuan(parsed.micro).toFixed(2),
      allocated_yuan: config.microToYuan(newAllocated).toFixed(2),
      assign_version: version
    }
  });
});

// ============================================================
// POST /admin/users/quota/batch —— 批量追加充值（充值时最常见）
// body: { items: [{ user_id, quota_yuan, weekly_yuan? }], reason? }
//
// 与单用户一致：quota_yuan 是「本次追加金额」，逐人在各自现有额度上累加；
// weekly_yuan 不填则保留该用户原有周限额。
// ============================================================
router.post('/users/quota/batch', auth.requireAuth, auth.requireAdmin, requireCanEditQuota, function(req, res) {
  var items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ code: 400, message: '没有要处理的用户' });
  if (items.length > 200) return res.status(400).json({ code: 400, message: '单次最多处理 200 个用户' });

  var results = [];
  var failed = [];

  var tx = db.transaction(function() {
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var userId = String(it.user_id || '').trim();
      var parsed = parseYuan(it.quota_yuan, '追加金额');

      if (!userId) { failed.push({ user_id: userId, message: '用户ID为空' }); continue; }
      if (!parsed.ok) { failed.push({ user_id: userId, message: parsed.message }); continue; }
      if (parsed.micro <= 0) { failed.push({ user_id: userId, message: '追加金额需大于 0' }); continue; }

      var user = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(userId);
      if (!user) { failed.push({ user_id: userId, message: '用户不存在' }); continue; }

      var before = credit.getAssignment(userId);

      // 周限额：显式传入才更新，否则沿用原值
      var weeklyMicro = Number(before.weekly_quota_micro || 0);
      if (it.weekly_yuan !== undefined && it.weekly_yuan !== '' && it.weekly_yuan !== null) {
        var w = parseYuan(it.weekly_yuan, '周限额');
        if (!w.ok) { failed.push({ user_id: userId, message: w.message }); continue; }
        weeklyMicro = w.micro;
      }

      var newAllocated = Number(before.allocated_micro || 0) + parsed.micro;
      if (config.microToYuan(newAllocated) > MAX_ASSIGN_YUAN) {
        failed.push({ user_id: userId, message: '累计额度不能超过 ' + MAX_ASSIGN_YUAN + ' 元' });
        continue;
      }

      var idemKey = constants.makeIdemKey([
        'batch', userId, String(parsed.micro), String(weeklyMicro), String(Date.now()), config.instanceId, String(i)
      ]);

      credit.applyAssignment({
        user_id: userId,
        allocated_micro: newAllocated,
        weekly_quota_micro: weeklyMicro,
        assigned_by: req.user.user_id,
        idem_key: idemKey,
        kind: 'topup',
        reason: String(req.body.reason || '批量充值'),
        origin_instance: config.instanceId
      });

      results.push({
        user_id: userId,
        allocated_yuan: config.microToYuan(newAllocated).toFixed(2),
        allocated_micro: newAllocated,
        weekly_quota_micro: weeklyMicro
      });
    }
  });

  try {
    tx();
  } catch (err) {
    console.error('[Admin] 批量分配失败:', err.message);
    return res.status(500).json({ code: 500, message: '批量操作失败，已回滚：' + err.message });
  }

  var version = currentAssignVersion();
  if (results.length) {
    // 批量：逐个入待推队列（每人一条，云端按 idem_key 逐条去重）
    for (var qi = 0; qi < results.length; qi++) {
      syncService.rememberSeatUser(req.user.user_id);
      if (syncService.isEnabled()) {
        syncService.queueAllocation(results[qi].user_id, results[qi].allocated_micro,
          results[qi].weekly_quota_micro, '本机批量分配', req.user.user_id);
      }
    }
    version = bumpAssignVersion();
    if (syncService.isEnabled()) syncService.pushPending(req.user.user_id).catch(function() {});
  }
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
router.delete('/users/:userId/quota', auth.requireAuth, auth.requireAdmin, requireCanEditQuota, function(req, res) {
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

  var version = bumpAssignAndQueue(req, userId, 0, 0,
    String(req.body && req.body.reason || '管理员收回额度'));
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
// GET /admin/nodes —— 班级节点看板（多班管理主视图）
//
// 数据来源两路合并：
//   · cluss_nodes 注册表（023 迁移）—— 节点身份、心跳（last_seen_at）、
//     配置到达情况（last_assign_version / last_model_version）、状态；
//   · cluss_usage_log 按 origin_instance 聚合 —— 每班消耗（老版本节点
//     不发身份头、不进注册表，但只要报过用量就还能在这里看到一行）。
// 分配额 vs 上报消耗 = 各班余额推算，分钟级延迟（上报间隔 300s）。
// ============================================================
var NODE_ONLINE_WINDOW_SEC = 600; // 心跳新鲜度阈值：同步间隔 60s 的 10 倍宽限

router.get('/nodes', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var nowLocal = new Date();
  var monthStartUtc = time.fmtUtc(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1));
  var nowUtc = time.nowUtc();
  var onlineCutoff = time.fmtUtc(new Date(Date.now() - NODE_ONLINE_WINDOW_SEC * 1000));

  var usageRows = db.prepare([
    'SELECT origin_instance,',
    '  COUNT(*) AS calls,',
    '  SUM(cost_micro) AS cost_micro,',
    '  SUM(CASE WHEN created_at >= ? THEN cost_micro ELSE 0 END) AS month_cost_micro,',
    '  SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS month_calls,',
    '  MAX(created_at) AS last_at',
    'FROM cluss_usage_log',
    "WHERE origin_instance != ''",
    'GROUP BY origin_instance'
  ].join('\n')).all(monthStartUtc, monthStartUtc);

  var usageByInstance = {};
  for (var i = 0; i < usageRows.length; i++) usageByInstance[usageRows[i].origin_instance] = usageRows[i];

  var nodeRows = db.prepare('SELECT * FROM cluss_nodes ORDER BY last_seen_at DESC').all();
  var orgNames = {};
  var orgRows = db.prepare('SELECT id, name FROM cluss_orgs').all();
  for (var oi = 0; oi < orgRows.length; oi++) orgNames[orgRows[oi].id] = orgRows[oi].name;
  var seen = {};
  var nodes = [];

  for (var n = 0; n < nodeRows.length; n++) {
    var r = nodeRows[n];
    seen[r.instance_id] = true;
    var u = usageByInstance[r.instance_id] || {};
    nodes.push({
      instance_id: r.instance_id,
      org_id: r.org_id || '',
      org_name: orgNames[r.org_id] || '',
      label: r.label,
      status: r.status,
      revoked_at: r.revoked_at ? time.toISO(r.revoked_at) : null,
      online: !!r.last_seen_at && r.last_seen_at >= onlineCutoff,
      last_seen_at: r.last_seen_at ? time.toISO(r.last_seen_at) : null,
      last_report_at: r.last_report_at ? time.toISO(r.last_report_at) : null,
      first_seen_at: r.first_seen_at ? time.toISO(r.first_seen_at) : null,
      node_version: r.node_version,
      last_assign_version: r.last_assign_version,
      last_model_version: r.last_model_version,
      assign_version_current: currentAssignVersion(),
      model_version_current: modelConfig.currentModelVersion(),
      calls: u.calls || 0,
      cost_micro: u.cost_micro || 0,
      month_calls: u.month_calls || 0,
      month_cost_micro: u.month_cost_micro || 0,
      last_usage_at: u.last_at ? time.toISO(u.last_at) : null,
      registered: true
    });
  }

  // 只报过用量、还没进注册表的老节点（升级前存量）
  for (var k in usageByInstance) {
    if (seen[k]) continue;
    var uo = usageByInstance[k];
    nodes.push({
      instance_id: k,
      label: '',
      status: 'active',
      revoked_at: null,
      online: null,
      last_seen_at: null,
      last_report_at: uo.last_at ? time.toISO(uo.last_at) : null,
      first_seen_at: null,
      node_version: '',
      last_assign_version: 0,
      last_model_version: 0,
      assign_version_current: currentAssignVersion(),
      model_version_current: modelConfig.currentModelVersion(),
      calls: uo.calls || 0,
      cost_micro: uo.cost_micro || 0,
      month_calls: uo.month_calls || 0,
      month_cost_micro: uo.month_cost_micro || 0,
      last_usage_at: uo.last_at ? time.toISO(uo.last_at) : null,
      registered: false
    });
  }

  nodes.sort(function(a, b) { return b.cost_micro - a.cost_micro; });

  res.json({
    code: 200,
    message: 'ok',
    data: {
      instance_id: config.instanceId,
      mode: config.mode,
      now: nowUtc,
      online_window_sec: NODE_ONLINE_WINDOW_SEC,
      nodes: nodes
    }
  });
});

// ---- 节点管理：备注 / 吊销 / 恢复 ----
// 吊销的边界（v0/v1）：同步请求全部 403，看板里标灰。但凭证仍是全网共享
// 密钥，被吊销节点换个 instance_id 仍可混入 —— 硬隔离等 v2 节点专属密钥。

function findNodeOr404(req, res) {
  var instanceId = String(req.params.instanceId || '').trim();
  if (!instanceId) {
    res.status(400).json({ code: 400, message: '缺少 instance_id' });
    return null;
  }
  if (instanceId === config.instanceId) {
    res.status(400).json({ code: 400, message: '不能对中继本机做该操作' });
    return null;
  }
  var row = db.prepare('SELECT * FROM cluss_nodes WHERE instance_id = ?').get(instanceId);
  if (!row) {
    res.status(404).json({ code: 404, message: '节点不存在（该班还没接入过）' });
    return null;
  }
  return row;
}

// PUT /admin/nodes/:instanceId —— 备注（如「高一3班」）
router.put('/nodes/:instanceId', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var row = findNodeOr404(req, res);
  if (!row) return;

  var label = String((req.body && req.body.label) || '').trim().slice(0, 60);
  db.prepare('UPDATE cluss_nodes SET label = ? WHERE instance_id = ?').run(label, row.instance_id);
  res.json({ code: 200, message: '已保存', data: { instance_id: row.instance_id, label: label } });
});

// POST /admin/nodes/:instanceId/revoke —— 吊销（淘汰旧机、换电脑）
router.post('/nodes/:instanceId/revoke', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var row = findNodeOr404(req, res);
  if (!row) return;
  if (row.status === 'revoked') {
    return res.json({ code: 200, message: '该节点已是吊销状态', data: { instance_id: row.instance_id } });
  }

  db.prepare("UPDATE cluss_nodes SET status = 'revoked', revoked_at = ? WHERE instance_id = ?")
    .run(time.nowUtc(), row.instance_id);
  console.log('[Admin] 节点已吊销: %s by %s', row.instance_id, req.user.user_id);
  res.json({
    code: 200,
    message: '已吊销 ' + (row.label || row.instance_id) + '：该节点的同步请求将被拒绝',
    data: { instance_id: row.instance_id, status: 'revoked' }
  });
});

// POST /admin/nodes/:instanceId/restore —— 恢复（吊销错了 / 机器重新启用）
router.post('/nodes/:instanceId/restore', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var row = findNodeOr404(req, res);
  if (!row) return;

  db.prepare("UPDATE cluss_nodes SET status = 'active', revoked_at = '' WHERE instance_id = ?")
    .run(row.instance_id);
  console.log('[Admin] 节点已恢复: %s by %s', row.instance_id, req.user.user_id);
  res.json({ code: 200, message: '已恢复', data: { instance_id: row.instance_id, status: 'active' } });
});

// ============================================================
// POST /admin/cloud/bind-request —— Cluss-Cloud 账号绑定（班管本机发起）
// ============================================================
// 「班管」和「云端学校管理员」原本是两个账号、两套密码，交接时最容易乱。
// 绑定后管理员在云端的一切操作都落在「哪个班 + 哪个学号」上。
//
// 为什么必须从这台教室电脑发起：云端不存班级密码，网页上填学号等于
// 谁都能声称自己是任何人；只有本机能证明「此刻登录的是本班学号 X 且
// 他是班管」。所以这里把当前登录人的 user_id 一起送上去，云端回一个
// 一次性确认码，再由那位管理员用自己的密码在网页上确认。
router.post('/cloud/bind-request', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var adminUsername = String((req.body || {}).admin_username || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,30}$/.test(adminUsername)) {
    return res.status(400).json({ code: 400, message: '请填写 Cluss-Cloud 上的管理员用户名（3-30 位小写字母/数字/下划线）' });
  }
  if (!syncService.isEnabled()) {
    return res.status(400).json({ code: 400, message: '本机未接入中继（当前不是 node 模式），无法发起绑定' });
  }
  syncService.requestBindCode(adminUsername, req.user.user_id).then(function(data) {
    console.log('[Admin] 账号绑定确认码已生成（云端管理员 %s，本班学号 %s）by %s',
      data.admin_username, req.user.user_id, req.user.user_id);
    res.json({ code: 200, message: '确认码已生成', data: data });
  }).catch(function(err) {
    res.status(502).json({ code: 502, message: '生成失败：' + (err && err.message ? err.message : String(err)) });
  });
});

// ============================================================
// GET /admin/dashboard —— 总览（管理台首页）
// ============================================================
// 口径分两套，刻意不合并（2026-10-09 修正过一次真实的自相矛盾）：
//   · 人数（user_count / by_class.students）—— 只数**学生**，管理员不是「学生」；
//   · 钱与次数（allocated / used / calls / top_users）—— **含管理员**。
// 起因：原来金额汇总含管理员，而下面所有明细列表按 is_admin=0 过滤，
// 于是「已消耗 ¥1.20」把班管算进去了，「消耗 Top 10」第一名却只有 ¥0.09
// 且没有他本人（实测班管占全站消耗 76%，等于把主要成本从台账上抹掉）。
// 现在两边统一为「钱含管理员、人数不含」，并由前端标注管理员行。
router.get('/dashboard', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var totals = db.prepare([
    'SELECT',
    '  (SELECT COUNT(*) FROM users WHERE is_admin = 0) AS user_count,',
    '  (SELECT COUNT(*) FROM users WHERE IFNULL(is_admin, 0) = 1) AS admin_count,',
    '  (SELECT COUNT(*) FROM users WHERE CAST(user_id AS INTEGER) >= 800001 AND CAST(user_id AS INTEGER) <= 999998) AS overflow_count,',
    '  (SELECT IFNULL(SUM(allocated_micro), 0) FROM cluss_credit) AS allocated_micro,',
    '  (SELECT IFNULL(SUM(cost_micro), 0) FROM cluss_usage_log) AS used_micro,',
    '  (SELECT COUNT(*) FROM cluss_usage_log) AS calls'
  ].join('\n')).get();

  // 本月消耗（管理员预算视角）：按服务器本地日历月对齐（与峰谷同一面钟约定），
  // 转成 UTC 窗口查台账。预算是管理员的事，学生侧永远看不到这个字段。
  var nowLocal = new Date();
  var monthStartUtc = time.fmtUtc(new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1));
  var monthRow = db.prepare(
    'SELECT IFNULL(SUM(cost_micro), 0) AS cost_micro, COUNT(*) AS calls' +
    ' FROM cluss_usage_log WHERE created_at >= ?'
  ).get(monthStartUtc);
  var budgetYuan = Number(initDb.getMeta('budget_threshold_yuan', '0')) || 0;
  var monthCostYuan = config.microToYuan(monthRow.cost_micro);

  // 峰谷状态摘要（看板系统信息用；与 /admin/offpeak 同一数据源）
  var pricing = require('../services/pricing');
  var oc = pricing.getOffpeakConfig();
  var offpeakActive = pricing.isInOffpeakWindow(oc);
  var offpeakText = oc.enabled
    ? '峰 ' + oc.peaks.map(function(w) { return minutesToHm(w.startMin) + '–' + minutesToHm(w.endMin); }).join('、') +
      '，谷时 ' + (Math.round(oc.discountBp / 100) / 10) + ' 折'
    : '未启用（全天原价）';

  // 按班级聚合（class_no 为空的归到「未填班级」）
  //
  // 这里**数全部成员**（含管理员）：前端拿这份数据渲染「班级」下拉，并用
  // students 数当括号里的人数。若这里只数学生而下拉按它过滤，下拉会写
  // 「18 班（49 人）」而筛出来 50 行 —— 又是一处对不上的数字。
  // 「学生数」指标另算（totals.users / totals.admins），语义仍是学生。
  var byClass = db.prepare([
    'SELECT IFNULL(NULLIF(u.class_no, \'\'), \'--\') AS class_no,',
    '       COUNT(DISTINCT u.user_id) AS students,',
    '       IFNULL(SUM(c.allocated_micro), 0) AS allocated_micro',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'GROUP BY class_no',
    'ORDER BY class_no ASC'
  ].join('\n')).all();

  // 消耗排行（用于发现异常用量）。**含管理员** —— 联动部署下班管本人就是主要
  // 消耗者，滤掉他等于把最大的一笔成本藏起来；前端给管理员行加标记即可区分。
  var topUsers = db.prepare([
    'SELECT s.user_id, u.net_name, u.real_name, IFNULL(u.is_admin, 0) AS is_admin,',
    '       s.used_micro, s.calls,',
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
        // 中继/云端全量状态：node 模式下管理员要看的就是这些——
        // 我接的是哪所学校、连上了没、云端发的配置我装到第几版了。
        // 以前这些只喂给 /api/health，管理台一个字都看不到。
        relay: syncService.getStatus(),
        // 管理员充值填的是元，学生端看到的是积分。把换算率给到前端，
        // 好让充值框旁边实时显示"学生将看到 N 积分"—— 管理员不必自己心算。
        points_per_yuan: config.points.perYuan,
        assign_version: currentAssignVersion(),
        month: {
          cost_yuan: monthCostYuan.toFixed(2),
          cost_micro: monthRow.cost_micro,
          calls: monthRow.calls,
          threshold_yuan: budgetYuan,
          exceeded: budgetYuan > 0 && monthCostYuan >= budgetYuan
        },
        version: config.version,
        offpeak: {
          enabled: oc.enabled,
          active_now: offpeakActive,
          text: offpeakText
        },
        totals: {
        users: totals.user_count,
        admins: totals.admin_count,
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
          is_admin: r.is_admin === 1 ? 1 : 0,
          used_yuan: config.microToYuan(r.used_micro).toFixed(2),
          allocated_yuan: config.microToYuan(r.allocated_micro).toFixed(2),
          calls: r.calls
        };
      })
    }
  });
});

// ============================================================
// 预算阈值（管理员成本视角，纯管理侧，学生接口不含任何相关字段）
// threshold_yuan = 0 表示不启用提醒
// ============================================================
router.put('/budget', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var n = Number(req.body && req.body.threshold_yuan);
  if (!isFinite(n) || n < 0 || n > 100000) {
    return res.status(400).json({ code: 400, message: '预算阈值必须是不小于 0 的数字（0 = 关闭提醒）' });
  }
  initDb.setMeta('budget_threshold_yuan', String(Math.round(n * 100) / 100));
  console.log('[Admin] 预算阈值设为 %s 元 by %s', n, req.user.user_id);
  res.json({ code: 200, message: '已保存', data: { threshold_yuan: Math.round(n * 100) / 100 } });
});

// ============================================================
// 异常检出（成本安全的短板在管理员的可见性）
//   top7d   近 7 天消耗 Top 10
//   spikes  突增：最近 24 小时消耗 ≥ 0.5 元且 ≥ 前 7 天日均 3 倍的账号
// 用滚动窗口（24h / 7×24h）而不是日历日，避开时区与日期边界语义
//
// 口径含管理员，与 /admin/dashboard 的金额汇总保持一致（同 /admin/users 的理由：
// 班管本人就是主要消耗者，滤掉等于把最大的一笔成本藏起来）。
// ============================================================
router.get('/usage/anomalies', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var since24 = time.utcBeforeDays(1);
  var since7 = time.utcBeforeDays(8);
  var MIN_SPIKE_YUAN = 0.5;   // 低于这个量级的突增没有讨论意义
  var SPIKE_RATIO = 3;

  var topRows = db.prepare([
    'SELECT l.user_id, u.net_name, u.real_name, u.class_no, IFNULL(u.is_admin, 0) AS is_admin,',
    '       SUM(l.cost_micro) AS cost_micro, COUNT(*) AS calls',
    'FROM cluss_usage_log l LEFT JOIN users u ON u.user_id = l.user_id',
    'WHERE l.created_at >= ?',
    'GROUP BY l.user_id ORDER BY cost_micro DESC LIMIT 10'
  ].join('\n')).all(time.utcBeforeDays(7));

  var last24 = {};
  db.prepare([
    'SELECT user_id, SUM(cost_micro) AS cost_micro, COUNT(*) AS calls',
    'FROM cluss_usage_log WHERE created_at >= ? GROUP BY user_id'
  ].join('\n')).all(since24).forEach(function(r) { last24[r.user_id] = r; });

  var prev = {};
  db.prepare([
    'SELECT user_id, SUM(cost_micro) AS cost_micro',
    'FROM cluss_usage_log WHERE created_at >= ? AND created_at < ? GROUP BY user_id'
  ].join('\n')).all(since7, since24).forEach(function(r) { prev[r.user_id] = r.cost_micro; });

  var spikes = [];
  Object.keys(last24).forEach(function(uid) {
    var cur = Number(last24[uid].cost_micro || 0);
    var base = Number(prev[uid] || 0) / 7;   // 前 7 天日均
    if (cur >= MIN_SPIKE_YUAN * 1e6 && base > 0 && cur >= base * SPIKE_RATIO) {
      var u = db.prepare('SELECT net_name, real_name, class_no, is_admin FROM users WHERE user_id = ?').get(uid);
      spikes.push({
        user_id: uid,
        name: (u && (u.real_name || u.net_name)) || uid,
        class_no: (u && u.class_no) || '',
        is_admin: (u && u.is_admin === 1) ? 1 : 0,
        day_yuan: config.microToYuan(cur).toFixed(2),
        avg_yuan: config.microToYuan(Math.round(base)).toFixed(2),
        ratio: Math.round(cur / base * 10) / 10,
        calls: last24[uid].calls
      });
    }
  });
  spikes.sort(function(a, b) { return b.day_yuan - a.day_yuan; });

  res.json({
    code: 200,
    message: 'ok',
    data: {
      top7d: topRows.map(function(r) {
        return {
          user_id: r.user_id,
          name: (r.real_name || r.net_name) || r.user_id,
          class_no: r.class_no || '',
          is_admin: r.is_admin === 1 ? 1 : 0,
          cost_yuan: config.microToYuan(r.cost_micro).toFixed(2),
          calls: r.calls
        };
      }),
      spikes: spikes,
      rule: { min_day_yuan: MIN_SPIKE_YUAN, ratio: SPIKE_RATIO }
    }
  });
});

// ============================================================
// GET /admin/snapshot —— 导出台账（CSV，便于线下对账）
//
// 含管理员，并单列一列标记：对账表漏掉管理员就等于漏掉真实发生过的支出
// （班管本人就是主要消耗者）。is_admin=0 的过滤曾经让这张表与页面上的金额对不上。
// ============================================================
router.get('/snapshot', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var rows = db.prepare([
    'SELECT u.user_id, u.net_name, u.real_name, u.class_no, IFNULL(u.is_admin, 0) AS is_admin,',
    '       IFNULL(c.allocated_micro, 0) AS allocated,',
    '       IFNULL(s.used_micro, 0) AS used',
    'FROM users u',
    'LEFT JOIN cluss_credit c ON c.user_id = u.user_id',
    'LEFT JOIN (SELECT user_id, SUM(cost_micro) AS used_micro FROM cluss_usage_log GROUP BY user_id) s ON s.user_id = u.user_id',
    'WHERE (IFNULL(c.allocated_micro, 0) > 0 OR IFNULL(s.used_micro, 0) > 0)',
    'ORDER BY allocated DESC'
  ].join('\n')).all();

  var lines = ['用户ID,用户名,姓名,班级,是否管理员,已分配(元),已消耗(元),余额(元)'];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    lines.push([
      r.user_id,
      String(r.net_name || '').replace(/,/g, '，'),
      String(r.real_name || '').replace(/,/g, '，'),
      String(r.class_no || ''),
      r.is_admin === 1 ? '是' : '否',
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

function serializeModelForAdmin(r, sourcesMap) {
  var pricing = require('../services/pricing');
  var ai = require('../services/ai');
  var health = require('../utils/model-health');
  var multBp = r.price_multiplier_bp > 0 ? r.price_multiplier_bp : 10000;
  var freeActive = !(r.is_free === 1) && pricing.isModelFree(r);
  var h = health.getHealthRow(r.id);

  // 连接信息可能来自模型所挂的源（迁移 022）。管理台表格要展示"实际会用哪个
  // 地址 / 这把 Key 是从哪来的"，否则管理员会对着模型上那份空地址困惑。
  var map = sourcesMap || ai.loadSourcesMap();
  var sourceId = String(r.source_id || '');
  var src = sourceId ? (map[sourceId] || null) : null;
  var useSource = !!(src && src.enabled !== 0);
  var resolvedUrl = useSource ? (src.api_url || '') : (r.api_url || '');
  var resolvedKey = useSource ? (src.api_key || '') : (r.api_key || '');
  var resolvedStyle = (useSource && src.api_style) ? src.api_style : (r.api_style || 'openai');

  // 峰窗回传成 [{start,end}]，前端表单可直接 v-model；折扣回传「折」
  var offpeakWindows = [];
  if (r.offpeak_peak_windows) {
    try {
      var arr = JSON.parse(r.offpeak_peak_windows);
      if (Array.isArray(arr)) {
        offpeakWindows = arr.map(function(w) {
          return { start: String((w && w.start) || ''), end: String((w && w.end) || '') };
        });
      }
    } catch (e) { offpeakWindows = []; }
  }
  var offpeakBp = Number(r.offpeak_discount_bp || 0);

  return {
    id: r.id,
    label: r.label,
    api_url: resolvedUrl,
    api_key_masked: maskKey(resolvedKey),
    has_api_key: !!resolvedKey,
    // 连接信息是否继承自源：前端据此把地址/密钥输入框置灰并标注来源
    api_key_from_source: useSource ? 1 : 0,
    source_id: sourceId,
    source_label: useSource ? (src.label || src.id) : '',
    // 挂了源但源不存在/已停用：表格要给出警示（否则显示成"未配置地址"很误导）
    source_missing: !!(sourceId && !useSource),
    model_name: r.model_name || '',
    api_style: resolvedStyle,
    supports_stream: r.supports_stream !== 0 ? 1 : 0,
    supports_vision: r.supports_vision === 1 ? 1 : 0,
    vision_max_images: r.vision_max_images || 0,
    // 深度思考能力：管理员实测后勾选。必须实测 —— 同一上游里不同模型
    // 对 enable_thinking 的反应完全不同（实测 vision 模型有效、v4.1 无效），
    // 靠命名或文档猜会让学生开了开关却什么都看不到。
    supports_thinking: r.supports_thinking === 1 ? 1 : 0,
    price_in: r.price_in || 0,
    price_out: r.price_out || 0,
    price_cache_hit: r.price_cache_hit || 0,
    // 倍率回传小数（万分比 → ×1.0 口径），前端直接编辑
    price_multiplier: Math.round(multBp) / 10000,
    free_until: r.free_until ? time.toISO(r.free_until) : '',
    free_active: freeActive ? 1 : 0,
    is_free: r.is_free === 1 ? 1 : 0,
    enabled: r.enabled === 1 ? 1 : 0,
    is_default: r.is_default === 1 ? 1 : 0,
    // ---- 峰谷（迁移 022：逐模型声明，不再是全局一刀切）----
    has_offpeak: r.has_offpeak === 1 ? 1 : 0,
    offpeak_peak_windows: offpeakWindows,
    // 「折」口径回传（5000 万分比 → 5 折）；0 = 留空、回退全局默认
    offpeak_discount: offpeakBp > 0 ? Math.round(offpeakBp / 100) / 10 : 0,
    // 健康是运行时事实，不混进配置字段（enabled 是管理员意图，两者必须分开）：
    // 否则管理员看到"启用了但不能用"会以为是 Bug，而实际上是上游挂了。
    health_status: h.health_status || 'unknown',
    health_detail: h.health_detail || '',
    fail_count: h.fail_count || 0,
    health_checked_at: h.checked_at ? time.toISO(h.checked_at) : '',
    sort_order: r.sort_order || 0,
    created_at: time.toISO(r.created_at)
  };
}

function serializeSourceForAdmin(s) {
  var used = 0;
  try {
    used = db.prepare('SELECT COUNT(*) AS c FROM ai_models WHERE source_id = ?').get(s.id).c;
  } catch (e) { used = 0; }
  return {
    id: s.id,
    label: s.label || '',
    api_url: s.api_url || '',
    api_key_masked: maskKey(s.api_key),
    has_api_key: !!s.api_key,
    api_style: s.api_style || 'openai',
    enabled: s.enabled === 1 ? 1 : 0,
    sort_order: s.sort_order || 0,
    // 有几个模型挂在这个源上：删除前要提示影响面
    model_count: used
  };
}

router.get('/models', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var ai = require('../services/ai');
  var pricing = require('../services/pricing');
  var rows = db.prepare('SELECT * FROM ai_models ORDER BY sort_order ASC, id ASC').all();
  var sourcesMap = ai.loadSourcesMap();
  var vision = require('../services/vision').getVisionConfig();

  // 计费基准 = 默认模型的三档单价。管理台把它摆在面板说明里常驻可见：
  // 「其他模型按 基准 × 倍率 扣积分」这件事，看一眼就能对上号
  var baseRow = db.prepare(
    'SELECT id, label, price_in, price_out, price_cache_hit FROM ai_models WHERE is_default = 1 LIMIT 1'
  ).get();

  var globOffpeak = pricing.getOffpeakConfig();

  res.json({
    code: 200,
    message: 'ok',
    data: {
      // node 模式下模型由云端统一下发。持有管理员席位的班可以改（改动上行同步
      // 全校），非席位班只读 —— 前端据此禁用按钮并说明原因。
      read_only: config.mode === config.MODES.NODE && !(syncService.getStatus().is_seat_admin),
      read_only_reason: (function() {
        if (config.mode !== config.MODES.NODE) return '';
        var st = syncService.getStatus();
        if (st.is_seat_admin) return '';
        if (!st.seat_instance) {
          return '本机已接入 Cluss-Cloud，但本校还没有认领管理员席位。认领后本班班管就能在这里改配置，改动会同步到全校所有班。';
        }
        return '本校管理员席位在 ' + st.seat_instance + ' 班，本班只能查看。请到管理员班修改，或在云端解绑后由本班认领。';
      })(),
      writes_to_school: config.mode === config.MODES.NODE && !!syncService.getStatus().is_seat_admin,
      models: rows.map(function(r) { return serializeModelForAdmin(r, sourcesMap); }),
      // 模型源清单（源可选；模型可挂源共享地址/密钥，也可自带连接信息）
      sources: ai.listSources().map(serializeSourceForAdmin),
      default_model: (function() {
        var d = db.prepare('SELECT id FROM ai_models WHERE is_default = 1 LIMIT 1').get();
        return d ? d.id : '';
      })(),
      base_model: baseRow ? {
        id: baseRow.id,
        label: baseRow.label,
        price_in: baseRow.price_in || 0,
        price_out: baseRow.price_out || 0,
        price_cache_hit: baseRow.price_cache_hit || 0
      } : null,
      // 全局峰谷配置：如今是「新模型的默认值 / 模型未声明时的兜底」，
      // 模型表单用它预填，标签也据此说明"留空即用这份全局默认"
      offpeak_defaults: {
        enabled: globOffpeak.enabled ? 1 : 0,
        peak_windows: globOffpeak.peaks.map(function(w) {
          return { start: minutesToHm(w.startMin), end: minutesToHm(w.endMin) };
        }),
        discount: Math.round(globOffpeak.discountBp / 100) / 10
      },
      vision_relay_model_id: vision.relayModelId,
      // 库存口径提示：微元/千 token（2000 = 2 元/百万）；管理台表单已自动按「元/百万」换算
      price_unit_note: '库存单位「微元 / 千 token」（2000 = 2 元/百万）；管理台表单按「元 / 百万 token」输入并自动换算'
    }
  });
});

// 价格换算：库存单位是「微元 / 千 token」，管理台表单按「元 / 百万 token」
// 口径显示并负责 ×1000（1 元/百万 = 1000 微元/千），所以 API 层收到的是
// 已换算好的库存值，这里只需整数化与范围校验
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

  // 模型源（迁移 022）：source_id 非空表示连接信息来自该源（地址/密钥以源为准）。
  // 这里只校验格式，存在性在路由里查（要给出一条能看懂的错误）。
  if (b.source_id !== undefined) {
    var sid = String(b.source_id || '').trim();
    if (sid && !/^[A-Za-z0-9._-]{1,60}$/.test(sid)) {
      return { ok: false, message: '模型源 ID 只能用字母、数字、点、下划线、短横线' };
    }
    out.source_id = sid;
  }

  // ---- 峰谷（逐模型）----
  // has_offpeak = 0 明确表示"这个模型不参与峰谷"（与"没声明"不同，后者回退全局）
  if (b.has_offpeak !== undefined) out.has_offpeak = b.has_offpeak ? 1 : 0;
  if (b.offpeak_peak_windows !== undefined) {
    // 空数组 = 显式清空（回退全局默认峰窗）；非空才校验格式。
    // 区分这两种，否则管理员永远没法把模型改回"用全局默认"。
    if (Array.isArray(b.offpeak_peak_windows) && b.offpeak_peak_windows.length === 0) {
      out.offpeak_peak_windows = '';
    } else {
      var w = parsePeakWindowsInput(b.offpeak_peak_windows);
      if (w === null) {
        return { ok: false, message: '峰时段必须是 1~2 个不重叠的 HH:MM 窗口（留空则用全局默认）' };
      }
      // 只留 HH:MM，入库口径与全局配置一致（pricing.parsePeakWindows 直接吃）
      out.offpeak_peak_windows = JSON.stringify(w.map(function(x) {
        return { start: x.start, end: x.end };
      }));
    }
  }
  if (b.offpeak_discount !== undefined && b.offpeak_discount !== '' && b.offpeak_discount !== 0) {
    var zhe = Number(b.offpeak_discount);
    if (!isFinite(zhe) || zhe < 0.1 || zhe > 9.9) {
      return { ok: false, message: '谷时折扣必须在 0.1 ~ 9.9 折之间' };
    }
    out.offpeak_discount_bp = Math.round(zhe * 1000);
  } else if (b.offpeak_discount !== undefined) {
    // 显式传 0 / 空 → 清空，回退全局默认
    out.offpeak_discount_bp = 0;
  }

  if (b.supports_stream !== undefined) out.supports_stream = b.supports_stream ? 1 : 0;
  if (b.supports_vision !== undefined) out.supports_vision = b.supports_vision ? 1 : 0;
  if (b.supports_thinking !== undefined) out.supports_thinking = b.supports_thinking ? 1 : 0;
  if (b.vision_max_images !== undefined) {
    var vm = parseInt(b.vision_max_images, 10);
    out.vision_max_images = isFinite(vm) && vm > 0 ? Math.min(vm, 6) : 0;
  }
  if (b.is_free !== undefined) out.is_free = b.is_free ? 1 : 0;
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = parseInt(b.sort_order, 10) || 0;

  // 倍率：管理台填小数（0.01 ~ 100），库里存万分比
  if (b.price_multiplier !== undefined && b.price_multiplier !== '') {
    var mult = Number(b.price_multiplier);
    if (!isFinite(mult) || mult < 0.01 || mult > 100) {
      return { ok: false, message: '倍率必须在 0.01 ~ 100 之间' };
    }
    out.price_multiplier_bp = Math.round(mult * 10000);
  }

  // 限免截止：'' / null 表示清除；否则接受客户端转好的 UTC ISO 串。
  // 为什么让前端转时区：datetime-local 的值没有时区语义，浏览器按本地时区
  // 解析成 ISO 再上传，服务端不必猜「管理员脑中的时间」是哪个时区。
  if (b.free_until !== undefined) {
    var fu = String(b.free_until || '').trim();
    if (!fu) {
      out.free_until = '';
    } else {
      var d = new Date(fu);
      if (isNaN(d.getTime())) return { ok: false, message: '限免截止时间无法解析' };
      out.free_until = time.fmtUtc(d);
    }
  }

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

router.post('/models', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var v = validateModelInput(req.body, true);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  var exists = db.prepare('SELECT id FROM ai_models WHERE id = ?').get(d.id);
  if (exists) return res.status(409).json({ code: 409, message: '该模型 ID 已存在' });

  // 挂了源就必须真的存在，否则会得到一个"配好了却用不了"的模型
  if (d.source_id) {
    var src = db.prepare('SELECT id FROM ai_sources WHERE id = ?').get(d.source_id);
    if (!src) return res.status(400).json({ code: 400, message: '指定的模型源不存在，请先在下方「模型源」里创建' });
  }

  db.prepare([
    'INSERT INTO ai_models (id, label, api_url, api_key, model_name, api_style,',
    '  supports_thinking, supports_stream, supports_vision, vision_max_images,',
    '  price_in, price_out, price_cache_hit, price_multiplier_bp, free_until,',
    '  is_free, enabled, source_id, has_offpeak, offpeak_peak_windows, offpeak_discount_bp,',
    '  is_default, sort_order, created_at)',
    // 23 个 ?（含 4 个峰谷/源新列）→ is_default 字面 0 → 2 个 ?
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ].join('\n')).run(
    d.id, d.label || d.id, d.api_url || '', d.api_key || '', d.model_name || d.id, d.api_style || 'openai',
    d.supports_thinking || 0,
    d.supports_stream === undefined ? 1 : d.supports_stream,
    d.supports_vision || 0, d.vision_max_images || 0,
    d.price_in || 0, d.price_out || 0, d.price_cache_hit || 0,
    d.price_multiplier_bp || 10000, d.free_until || '',
    d.is_free || 0, d.enabled === undefined ? 1 : d.enabled,
    d.source_id || '', d.has_offpeak || 0, d.offpeak_peak_windows || '', d.offpeak_discount_bp || 0,
    d.sort_order || 0, time.nowUtc()
  );

  console.log('[Admin] 新增模型: %s by %s', d.id, req.user.user_id);
  var mv = bumpModelAndQueue(req);
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(d.id);
  res.json({ code: 200, message: '已添加，模型配置版本 ' + mv + '（各班节点将在 1 分钟内自动同步）', data: serializeModelForAdmin(row) });
});

router.put('/models/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });

  var v = validateModelInput(req.body, false);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  // api_key 留空表示「不修改」：否则管理员只改单价时会把 Key 清掉
  if (d.api_key !== undefined && !d.api_key) delete d.api_key;

  // 改挂的源必须存在（改回"不挂源"是 source_id = ''，不在校验范围）
  if (d.source_id) {
    var src = db.prepare('SELECT id FROM ai_sources WHERE id = ?').get(d.source_id);
    if (!src) return res.status(400).json({ code: 400, message: '指定的模型源不存在' });
  }

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
  var mv = bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: '已更新，模型配置版本 ' + mv + '（各班节点将在 1 分钟内自动同步）',
    data: serializeModelForAdmin(db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id))
  });
});

// 删除：若已被会话引用则改为软禁用
// 硬删会让历史会话的 model_id 指向不存在的模型，管理台的用量统计就 JOIN 不出名字了
router.delete('/models/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
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
    bumpModelAndQueue(req);
    console.log('[Admin] 模型已被 %d 个会话引用，改为禁用: %s', used, id);
    return res.json({
      code: 200,
      message: '该模型已被 ' + used + ' 个会话使用，已改为「禁用」而非删除（保留历史记录可追溯）',
      data: { soft_disabled: true }
    });
  }

  db.prepare('DELETE FROM ai_models WHERE id = ?').run(id);
  bumpModelAndQueue(req);
  console.log('[Admin] 删除模型: %s by %s', id, req.user.user_id);
  res.json({ code: 200, message: '已删除', data: { soft_disabled: false } });
});

router.post('/models/:id/set-default', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_models WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型不存在' });
  if (row.enabled !== 1) return res.status(400).json({ code: 400, message: '禁用的模型不能设为默认' });

  var tx = db.transaction(function() {
    db.prepare('UPDATE ai_models SET is_default = 0').run();
    // 默认模型是全站计费基准（×1.00）：换默认时必须把它的倍率归一，
    // 否则基准自己带着倍率，所有模型（含它自己）的账单会整体漂移
    db.prepare('UPDATE ai_models SET is_default = 1, price_multiplier_bp = 10000 WHERE id = ?').run(id);
  });
  tx();

  console.log('[Admin] 默认模型改为: %s（倍率已重置为 ×1.00）by %s', id, req.user.user_id);
  bumpModelAndQueue(req);
  res.json({ code: 200, message: '已设为默认模型（计费基准，倍率已重置为 ×1.00）', data: { default_model: id } });
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
// 模型源（迁移 022）
//
// 一个上游常常一次提供多个模型：地址与 Key 完全相同，只有上游模型名不同。
// 把连接信息沉到「源」上，模型只记 source_id —— 上游换域名/换 Key 只改一处。
// **源是可选的**：不挂源的模型继续用自己的 api_url / api_key（存量零迁移）。
// ============================================================

function validateSourceInput(body, isCreate) {
  var b = body || {};
  var out = {};

  if (isCreate) {
    var id = String(b.id || '').trim();
    if (!id) return { ok: false, message: '模型源 ID 不能为空' };
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(id)) {
      return { ok: false, message: '模型源 ID 只能用字母、数字、点、下划线、短横线' };
    }
    out.id = id;
  }

  if (b.label !== undefined) out.label = String(b.label || '').trim().slice(0, 60) || 'unnamed';
  if (b.api_url !== undefined) out.api_url = String(b.api_url || '').trim().slice(0, 300);
  if (b.api_key !== undefined) out.api_key = String(b.api_key || '').trim().slice(0, 400);
  if (b.api_style !== undefined) out.api_style = b.api_style === 'deepseek' ? 'deepseek' : 'openai';
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  if (b.sort_order !== undefined) out.sort_order = parseInt(b.sort_order, 10) || 0;

  return { ok: true, data: out };
}

router.get('/sources', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var rows = db.prepare('SELECT * FROM ai_sources ORDER BY sort_order ASC, id ASC').all();
  res.json({ code: 200, message: 'ok', data: { sources: rows.map(serializeSourceForAdmin) } });
});

router.post('/sources', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var v = validateSourceInput(req.body, true);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  var exists = db.prepare('SELECT id FROM ai_sources WHERE id = ?').get(d.id);
  if (exists) return res.status(409).json({ code: 409, message: '该模型源 ID 已存在' });

  db.prepare([
    'INSERT INTO ai_sources (id, label, api_url, api_key, api_style, enabled, sort_order, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ].join('\n')).run(
    d.id, d.label || d.id, d.api_url || '', d.api_key || '',
    d.api_style || 'openai', d.enabled === undefined ? 1 : d.enabled,
    d.sort_order || 0, time.nowUtc()
  );

  console.log('[Admin] 新增模型源: %s by %s', d.id, req.user.user_id);
  bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: '已添加',
    data: serializeSourceForAdmin(db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(d.id))
  });
});

router.put('/sources/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型源不存在' });

  var v = validateSourceInput(req.body, false);
  if (!v.ok) return res.status(400).json({ code: 400, message: v.message });

  var d = v.data;
  // 与模型同样的语义：Key 留空 = 不修改（只改地址/名字时不该把 Key 抹掉）
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
  var stmt = db.prepare('UPDATE ai_sources SET ' + sets.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, params);

  console.log('[Admin] 更新模型源: %s by %s', id, req.user.user_id);
  bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: '已更新',
    data: serializeSourceForAdmin(db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(id))
  });
});

// 删除源：仍被模型引用时先拦一次（避免一次误点把 N 个模型悄悄变成不可用）；
// 带 ?force=1 再确认，则把这些模型回退到「自带地址/密钥」后删除源。
router.delete('/sources/:id', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var id = String(req.params.id || '');
  var row = db.prepare('SELECT * FROM ai_sources WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ code: 404, message: '模型源不存在' });

  var used = db.prepare('SELECT COUNT(*) AS c FROM ai_models WHERE source_id = ?').get(id).c;
  var force = String(req.query.force || '') === '1';

  if (used > 0 && !force) {
    return res.status(409).json({
      code: 409,
      message: '还有 ' + used + ' 个模型挂在这个模型源上。删除后它们会回退到各自的地址/密钥（可能为空），确认删除请再点一次。',
      data: { model_count: used, need_confirm: true }
    });
  }

  var tx = db.transaction(function() {
    db.prepare("UPDATE ai_models SET source_id = '' WHERE source_id = ?").run(id);
    db.prepare('DELETE FROM ai_sources WHERE id = ?').run(id);
  });
  tx();

  console.log('[Admin] 删除模型源: %s（%d 个模型回退自带配置）by %s', id, used, req.user.user_id);
  bumpModelAndQueue(req);
  res.json({
    code: 200,
    message: used > 0 ? ('已删除，' + used + ' 个模型已回退到自带配置') : '已删除',
    data: { detached: used }
  });
});

// ============================================================
// 峰谷时段（积分策略，存 cluss_meta，改完即时生效）
//
// 配置的是**峰时段（忙时）**窗口（1~2 个，可跨午夜），谷时（峰外）按折扣计。
// 管理台以「折」为输入单位（谷时段按 5 折计费），库里存万分比。
// 判定用服务器本地时间 —— 峰谷面向的是"学生几点在用"这面墙上的钟。
//
// 注（迁移 022 起）：这份配置是**全局默认值**，逐模型可在模型表单里
// 声明"是否参与峰谷 / 自己的峰窗与折扣"；模型未声明时才回退到这里。
// ============================================================

var HM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// 把可能跨午夜的窗口展开成不跨午夜的区间列表（跨午夜 = [s,24:00) + [00:00,e)）
function expandWindow(s, e) {
  if (s < e) return [[s, e]];
  return [[s, 1440], [0, e]];
}

function windowsOverlap(a, b) {
  var A = expandWindow(a.startMin, a.endMin);
  var B = expandWindow(b.startMin, b.endMin);
  for (var i = 0; i < A.length; i++) {
    for (var j = 0; j < B.length; j++) {
      if (A[i][0] < B[j][1] && B[j][0] < A[i][1]) return true;
    }
  }
  return false;
}

// 校验并归一前端提交的峰窗口；不合法返回 null
function parsePeakWindowsInput(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null;
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var w = raw[i] || {};
    var s = String(w.start || '').trim();
    var e = String(w.end || '').trim();
    if (!HM_RE.test(s) || !HM_RE.test(e) || s === e) return null;
    out.push({ start: s, end: e, startMin: pricing.parseHm(s, -1), endMin: pricing.parseHm(e, -1) });
  }
  if (out.length === 2 && windowsOverlap(out[0], out[1])) return null;
  return out;
}

router.get('/offpeak', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var pricing = require('../services/pricing');
  var cfg = pricing.getOffpeakConfig();
  var activeNow = pricing.isInOffpeakWindow(cfg);

  res.json({
    code: 200,
    message: 'ok',
    data: {
      enabled: cfg.enabled,
      peak_windows: cfg.peaks.map(function(w) {
        return { start: minutesToHm(w.startMin), end: minutesToHm(w.endMin) };
      }),
      discount_bp: cfg.discountBp,
      // 「折」给管理台显示（5000 → 5）
      discount: Math.round(cfg.discountBp / 100) / 10,
      // active_now = 当前处于谷时（折扣生效中）；peak_now = 当前处于忙时
      active_now: activeNow,
      peak_now: cfg.enabled && !activeNow
    }
  });
});

router.put('/offpeak', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
  var pricing = require('../services/pricing');
  var b = req.body || {};

  var enabled = !!b.enabled;
  var windows = parsePeakWindowsInput(b.peak_windows);
  if (enabled && !windows) {
    return res.status(400).json({
      code: 400,
      message: '峰时段必须是 1~2 个不重叠的 HH:MM 窗口（如 09:00-12:00 与 14:00-18:00）'
    });
  }

  // 折扣：0.1 ~ 9.9 折；10 折等于没折，直接视为关闭更不容易误导
  var zhe = Number(b.discount);
  if (!isFinite(zhe) || zhe < 0.1 || zhe > 9.9) {
    return res.status(400).json({ code: 400, message: '折扣必须在 0.1 ~ 9.9 折之间' });
  }
  var discountBp = Math.round(zhe * 1000);

  var peaks = (windows || pricing.getOffpeakConfig().peaks).map(function(w) {
    return { start: w.start || minutesToHm(w.startMin), end: w.end || minutesToHm(w.endMin) };
  });

  pricing.setOffpeakConfig({ enabled: enabled, peaks: peaks, discountBp: discountBp });

  var cfg = pricing.getOffpeakConfig();
  console.log('[Admin] 峰谷配置更新 by %s: %j', req.user.user_id, {
    enabled: cfg.enabled,
    peaks: cfg.peaks.map(function(w) { return minutesToHm(w.startMin) + '-' + minutesToHm(w.endMin); }),
    discount: zhe
  });
  // 峰谷是节点本地计费口径的一部分（模型级峰窗留空时回退全局），必须随配置下发
  bumpModelAndQueue(req);

  var activeNow = pricing.isInOffpeakWindow(cfg);
  res.json({
    code: 200,
    message: '已保存',
    data: {
      enabled: cfg.enabled,
      peak_windows: cfg.peaks.map(function(w) {
        return { start: minutesToHm(w.startMin), end: minutesToHm(w.endMin) };
      }),
      discount_bp: cfg.discountBp,
      discount: Math.round(cfg.discountBp / 100) / 10,
      active_now: activeNow,
      peak_now: cfg.enabled && !activeNow
    }
  });
});

// 分钟数 → 'HH:MM'（峰谷配置入库是分钟数口径的展示反转）
function minutesToHm(min) {
  var m = Math.max(0, Math.min(1439, Math.round(Number(min) || 0)));
  var h = Math.floor(m / 60);
  var mm = m % 60;
  return (h < 10 ? '0' + h : String(h)) + ':' + (mm < 10 ? '0' + mm : String(mm));
}

// ============================================================
// 视觉配置
// ============================================================
router.get('/vision', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var vision = require('../services/vision');
  var ai = require('../services/ai');
  var cfg = vision.getVisionConfig();
  var rows = db.prepare('SELECT * FROM ai_models ORDER BY sort_order ASC').all();
  // 连接信息可能来自模型所挂的源（迁移 022），所以不能用行上的 api_url/api_key
  // 直接判断"配没配好" —— 挂了源的模型这两个字段本来就是空的，
  // 用旧判据会让它们从转述候选里被误删。
  var sourcesMap = ai.loadSourcesMap();

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
        if (r.supports_vision !== 1 || r.enabled !== 1) return false;
        var m = ai.rowToModel(r, sourcesMap[r.source_id] || null);
        return !!(m.apiUrl && m.apiKey);
      }).map(function(r) {
        return { id: r.id, label: r.label };
      })
    }
  });
});

router.put('/vision', auth.requireAuth, auth.requireAdmin, requireCanEditModelConfig, function(req, res) {
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
  // 视觉转述配置随模型配置一起下发（§5.2：relayModelId 不随行节点会引用到不存在的模型）
  bumpModelAndQueue(req);
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

// ============================================================
// 本班名册（ClassIntra 联动）
//
// Cluss 是「一班一节点」的应用：名册就是世界边界。
//   GET  /class-roster          现状（本班在册 / 非本班清单），零副作用
//   POST /class-roster/sync     拉名册并纳入本班 —— **幂等，只增不删**
//   POST /class-roster/prune    清理非本班账号 —— **破坏性**，必须显式 confirm
//
// 「本班」由**当前管理员的学号**解出（YYCCNN），不由前端传参决定：
// 班管只可能管自己那个班，参数传什么都不可能越到别的班。
// ============================================================
function adminClass(req) {
  return classRoster.classOfAdmin(String(req.user.user_id));
}

router.get('/class-roster', auth.requireAuth, auth.requireAdmin, function(req, res) {
  try {
    var c = adminClass(req);
    if (!c) {
      return res.json({ code: 400, message: '当前账号的学号不含班级信息（如开发账号），无法确定本班', data: null });
    }
    return res.json({ code: 200, message: 'ok', data: classRoster.status(c.yy, c.classNo) });
  } catch (err) {
    console.error('[Admin] class-roster status error:', err);
    return res.json({ code: 500, message: '服务器内部错误', data: null });
  }
});

router.post('/class-roster/sync', auth.requireAuth, auth.requireAdmin, function(req, res) {
  var c = adminClass(req);
  if (!c) {
    return res.json({ code: 400, message: '当前账号的学号不含班级信息，无法确定本班', data: null });
  }
  classRoster.syncClass(c.yy, c.classNo, { prune: false }).then(function(r) {
    console.log('[Admin] 名册同步: %s届%s班 新增 %d / 更新 %d / 失败 %d / 操作人 %s',
      c.yy, c.classNo, r.adopted.added, r.adopted.updated, r.adopted.failed.length, req.user.user_id);
    return res.json({ code: 200, message: '本班名册已同步', data: r });
  }).catch(function(err) {
    var st = err.response && err.response.status;
    var msg = (err.response && err.response.data && err.response.data.message) || err.message;
    if (st === 503 || st === 403 || /未配置|联动/.test(err.message)) {
      return res.json({ code: 503, message: 'ClassIntra 联动不可用：' + msg, data: null });
    }
    console.error('[Admin] 名册同步失败:', err.message);
    return res.json({ code: 500, message: '同步失败：' + msg, data: null });
  });
});

router.post('/class-roster/prune', auth.requireAuth, auth.requireAdmin, function(req, res) {
  if (req.body.confirm !== true) {
    return res.json({ code: 400, message: '缺少确认标记：清理会连同学生的会话、额度与流水一并删除，必须显式 confirm', data: null });
  }
  var c = adminClass(req);
  if (!c) {
    return res.json({ code: 400, message: '当前账号的学号不含班级信息，无法确定本班', data: null });
  }

  try {
    var doomed = classRoster.listForeign(c.yy, c.classNo);
    if (!doomed.length) {
      return res.json({ code: 200, message: '没有需要清理的非本班账号', data: { removed: { count: 0 }, list: [] } });
    }
    // 开发账号（999999 等）在 listForeign 里就被豁免了，这里再钉一道保险：
    // 删除名单里出现豁免 id 视为编程错误，直接拒绝而不是默默跳过
    var dev = String(config.admin.userId || '999999');
    if (doomed.some(function(r) { return String(r.user_id) === dev; })) {
      return res.json({ code: 500, message: '清理名单里包含受保护的账号，已中止', data: null });
    }

    var removed = classRoster.purgeUsers(doomed.map(function(r) { return r.user_id; }));
    console.log('[Admin] 清理非本班账号: %s届%s班，删除 %d 个（云盘文件 %d 份），操作人 %s',
      c.yy, c.classNo, removed.count, removed.files, req.user.user_id);

    return res.json({
      code: 200,
      message: '已清理 ' + removed.count + ' 个非本班账号',
      data: {
        removed: removed,
        list: doomed.map(function(r) {
          return { user_id: r.user_id, net_name: r.net_name, real_name: r.real_name };
        })
      }
    });
  } catch (err) {
    console.error('[Admin] 清理非本班账号失败:', err);
    return res.json({ code: 500, message: '清理失败：' + err.message, data: null });
  }
});

module.exports = router;
module.exports.bumpAssignVersion = bumpAssignVersion;