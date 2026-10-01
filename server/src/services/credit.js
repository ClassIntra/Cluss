// 额度服务：分配（权威）/ 消耗（本地扣减）/ 状态查询
//
// ---- 核心模型（决定跨班一致性）----
// 额度是「分配」而不是「共享账本」：
//     allocated_micro = 老师给这个账号分配了多少（由中继下发，权威值）
//     本地消耗        = 本班 cluss_usage_log 里该用户的开销合计
//     可用余额        = allocated_micro + 同步容错 - 本地消耗
//
// 为什么余额不落库、每次聚合算：余额可由分配与流水推导，存下来必然与流水漂移。
// 扣费只在本班发生、分配只由中继下发，两者天然不冲突，所以不需要分布式锁。
//
// ---- 同步容错 ----
// 「学生刚在别班充了值、本班还没拉到新分配」会误拒。为此允许一个小额透支容差
// （CLUSS_SYNC_TOLERANCE_YUAN），宁可短暂多放一点，也不误伤已付款的学生。

var db = require('../utils/db');
var time = require('../utils/time');
var config = require('../config');

var WEEK_DAYS = 7;

// 读取分配记录（不存在时返回零值，不自动建行）
function getAssignment(userId) {
  var row = db.prepare('SELECT * FROM cluss_credit WHERE user_id = ?').get(String(userId));
  if (row) return row;
  return { user_id: String(userId), allocated_micro: 0, weekly_quota_micro: 0, assigned_by: '', updated_at: null };
}

// 本班范围内的消耗合计（可按窗口天数限制）
function sumLocalUsage(userId, days) {
  var params = [String(userId)];
  var sql = 'SELECT SUM(cost_micro) AS used FROM cluss_usage_log WHERE user_id = ?';
  if (days) {
    sql += ' AND created_at >= ?';
    params.push(time.utcBeforeDays(days));
  }
  var row = db.prepare(sql).get(params[0], params[1]);
  return (row && row.used) || 0;
}

// 同步容错仅对「有分配额度」的用户生效：0 分配的人不该凭空获得可用量
function toleranceFor(allocatedMicro) {
  if (!(allocatedMicro > 0)) return 0;
  return config.relay.toleranceMicro || 0;
}

// 用户侧额度视图（前端展示 + 闸门判定共用）
function getState(userId) {
  var uid = String(userId);
  var asg = getAssignment(uid);
  var usedTotal = sumLocalUsage(uid, null);
  var usedWeek = sumLocalUsage(uid, WEEK_DAYS);
  var tolerance = toleranceFor(asg.allocated_micro);

  var availableMicro = asg.allocated_micro + tolerance - usedTotal;
  var weeklyQuota = Number(asg.weekly_quota_micro || 0);

  var state = {
    allocated_micro: asg.allocated_micro,
    used_micro: usedTotal,
    available_micro: availableMicro,
    tolerance_micro: tolerance,
    is_allocated: asg.allocated_micro > 0,
    weekly_quota_micro: weeklyQuota,
    weekly_used_micro: usedWeek,
    weekly_remaining_micro: weeklyQuota > 0 ? Math.max(0, weeklyQuota - usedWeek) : 0,
    weekly_unlimited: weeklyQuota <= 0,
    window_days: WEEK_DAYS,
    updated_at: time.toISO(asg.updated_at)
  };

  state.used_percent = asg.allocated_micro > 0
    ? Math.min(100, Math.round(usedTotal / asg.allocated_micro * 100))
    : 0;
  state.weekly_percent = weeklyQuota > 0
    ? Math.min(100, Math.round(usedWeek / weeklyQuota * 100))
    : 0;

  return state;
}

// 闸门判定：返回 null 表示放行，否则返回给用户看的中文提示
function checkGate(userId, model) {
  // 免费模型不受额度限制
  if (model && model.is_free) return null;

  var uid = String(userId);
  var asg = getAssignment(uid);

  // 1) 尚未分配额度：直接拦，并给出明确指引（最常见的「为什么用不了」）
  if (!(asg.allocated_micro > 0)) {
    return '你的账号还没有开通额度。请先联系管理员充值，充值后即可使用。';
  }

  var state = getState(uid);

  // 2) 余额闸门
  //    允许余额刚好为 0 时发起（末次请求可能扣成负数），但已经为负就拦
  if (state.available_micro <= 0) {
    return '你的余额已用完（剩余 ¥' + config.microToYuan(Math.max(0, state.available_micro)).toFixed(2) + '）。' +
      '请先联系管理员充值后继续使用。';
  }

  // 3) 周限额闸门（防滥用）
  if (state.weekly_quota_micro > 0 && state.weekly_used_micro >= state.weekly_quota_micro) {
    return '你本周的使用额度已用完（' + WEEK_DAYS + ' 天内上限 ¥' +
      config.microToYuan(state.weekly_quota_micro).toFixed(2) + '），请下周再试或联系管理员调整。';
  }

  return null;
}

// 记录一笔用量（本地即时扣减：余额由聚合推导，这里只落明细）
function recordUsage(p) {
  var stmt = db.prepare([
    'INSERT INTO cluss_usage_log (user_id, conversation_id, model_id, prompt_tokens, completion_tokens,',
    '  cache_hit_tokens, cache_miss_tokens, total_tokens, cost_micro, estimated, origin_instance, synced, created_at)',
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
  ].join('\n'));

  var info = stmt.run(
    String(p.user_id),
    String(p.conversation_id || ''),
    String(p.model_id || ''),
    Number(p.prompt_tokens || 0),
    Number(p.completion_tokens || 0),
    Number(p.cache_hit_tokens || 0),
    Number(p.cache_miss_tokens || 0),
    Number(p.total_tokens || 0),
    Number(p.cost_micro || 0),
    p.estimated ? 1 : 0,
    config.instanceId,
    time.nowUtc()
  );

  return info.lastInsertRowid;
}

// 由中继下发分配值（含流水幂等写入）
// p: { user_id, allocated_micro, weekly_quota_micro, assigned_by, idem_key, reason, kind, origin_instance }
function applyAssignment(p) {
  var uid = String(p.user_id);
  var allocated = Number(p.allocated_micro || 0);
  var weekly = Number(p.weekly_quota_micro || 0);

  var tx = db.transaction(function() {
    // 幂等流水：同一笔充值重复下发只入账一次
    if (p.idem_key) {
      var dup = db.prepare('SELECT id FROM cluss_credit_log WHERE idem_key = ?').get(String(p.idem_key));
      if (dup) return false;
    }

    var before = getAssignment(uid);
    db.prepare([
      'INSERT INTO cluss_credit (user_id, allocated_micro, weekly_quota_micro, updated_at, assigned_by)',
      'VALUES (?, ?, ?, ?, ?)',
      'ON CONFLICT(user_id) DO UPDATE SET allocated_micro = excluded.allocated_micro,',
      '  weekly_quota_micro = excluded.weekly_quota_micro, updated_at = excluded.updated_at,',
      '  assigned_by = excluded.assigned_by'
    ].join('\n')).run(uid, allocated, weekly, time.nowUtc(), String(p.assigned_by || ''));

    var delta = allocated - Number(before.allocated_micro || 0);
    if (delta !== 0) {
      db.prepare([
        'INSERT INTO cluss_credit_log (user_id, amount_micro, kind, reason, operator_id, origin_instance, idem_key, created_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ].join('\n')).run(
        uid, delta, String(p.kind || 'topup'), String(p.reason || ''),
        String(p.assigned_by || ''), String(p.origin_instance || config.instanceId),
        p.idem_key ? String(p.idem_key) : null, time.nowUtc()
      );
    }
    return true;
  });

  return tx();
}

// 取待上报的用量明细（供节点上报给中继）
function takeUnsyncedUsage(limit) {
  return db.prepare(
    'SELECT * FROM cluss_usage_log WHERE synced = 0 ORDER BY id ASC LIMIT ?'
  ).all(Number(limit || 200));
}

function markUsageSynced(ids) {
  if (!ids || !ids.length) return;
  var stmt = db.prepare('UPDATE cluss_usage_log SET synced = 1 WHERE id = ?');
  var tx = db.transaction(function() {
    for (var i = 0; i < ids.length; i++) stmt.run(ids[i]);
  });
  tx();
}

module.exports = {
  WEEK_DAYS: WEEK_DAYS,
  getAssignment: getAssignment,
  getState: getState,
  checkGate: checkGate,
  recordUsage: recordUsage,
  applyAssignment: applyAssignment,
  sumLocalUsage: sumLocalUsage,
  takeUnsyncedUsage: takeUnsyncedUsage,
  markUsageSynced: markUsageSynced
};